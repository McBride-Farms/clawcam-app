import {
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";
import type {
  ClawcamConfig,
  Device,
  Stream,
  TelemetryFrame,
} from "@shared/types";
import {
  attachLiveStream,
  type HlsLevel,
  type LiveStreamHandle,
} from "~/lib/livestream";
import { api } from "~/lib/api";
import { esc, fmtTime, num } from "~/lib/format";
import QualityPicker from "./QualityPicker";
import PtzControls from "./PtzControls";

// One camera tile. Owns the video element, the player handle, the
// snapshot fallback, the telemetry SVG overlay, the quality picker, and
// (optionally) the PTZ joystick + d-pad. The parent (LiveGrid) tells us
// which `stream` to attach to via reactive props; everything else is
// self-contained.

const BOX_TEXT_X = 4;
const BOX_TEXT_Y = 14;

function boxMarkup(p: TelemetryFrame["predictions"][number]): string {
  const left = num(p.left);
  const top = num(p.top);
  const right = num(p.right);
  const bottom = num(p.bottom);
  const w = Math.max(0, right - left);
  const h = Math.max(0, bottom - top);
  const score = num(p.score);
  const label = `${p.class ?? ""} ${(score * 100).toFixed(0)}%`;
  return `<g><rect x="${left}" y="${top}" width="${w}" height="${h}"/><text x="${left + BOX_TEXT_X}" y="${top + BOX_TEXT_Y}">${esc(label)}</text></g>`;
}

export interface LiveTileProps {
  device: Device;
  /** Reactive stream state. `null`/`undefined` ⇒ offline placeholder. */
  stream: Stream | null | undefined;
  cfg: ClawcamConfig | null;
  /** True ⇒ apply the `.focus` class (one-tile-at-a-time blow-up). */
  focused: boolean;
  /** Toggle focus on this tile. Parent enforces single-focus semantics. */
  onToggleFocus: () => void;
  /**
   * Imperative handle: parent calls this from the SSE telemetry router so
   * we apply our own HLS-latency delay before painting. Returned getter
   * lets us wire it during onMount.
   */
  registerPainter: (paint: (t: TelemetryFrame) => void) => void;
}

// localStorage value for `clawcam.quality.<name>`. We parse on attach.
type SavedQuality =
  | { kind: "auto" }
  | { kind: "height"; height: number }
  | null;

function readSavedQuality(name: string): SavedQuality {
  try {
    const raw = localStorage.getItem(`clawcam.quality.${name}`);
    if (raw === "auto") return { kind: "auto" };
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) return { kind: "height", height: n };
    }
  } catch {}
  return null;
}

function writeSavedQuality(name: string, value: "auto" | number): void {
  try {
    localStorage.setItem(
      `clawcam.quality.${name}`,
      value === "auto" ? "auto" : String(value),
    );
  } catch {}
}

const LiveTile: Component<LiveTileProps> = (props) => {
  // Derived camera "name" — uses display name when set, else host.
  const cameraName = () => props.device.name || props.device.host;

  // ── Refs ──────────────────────────────────────────────────────────────
  let videoEl!: HTMLVideoElement;
  let snapEl!: HTMLImageElement;
  let phEl!: HTMLDivElement;
  let overlayEl!: SVGSVGElement;

  // ── State signals ─────────────────────────────────────────────────────
  // Status dot + age strings (mirror the legacy DOM mutations).
  const [statusDot, setStatusDot] = createSignal<"live" | "dead" | "reconnecting">("dead");
  const [ageText, setAgeText] = createSignal<string>("—");

  // Quality picker state.
  const [levels, setLevels] = createSignal<HlsLevel[]>([]);
  const [currentHeight, setCurrentHeight] = createSignal<number | null>(null);
  const [isAuto, setIsAuto] = createSignal<boolean>(true);
  const [isOverride, setIsOverride] = createSignal<boolean>(false);
  const [transport, setTransport] = createSignal<"webrtc" | "hls" | null>(null);
  const [pickerVisible, setPickerVisible] = createSignal<boolean>(false);

  // Stream attach state. `live` mirrors the legacy `entry.live` flag.
  const [live, setLive] = createSignal<boolean>(false);
  // Snapshot fallback shown when not live.
  const [snapshotSrc, setSnapshotSrc] = createSignal<string | null>(null);
  const [phText, setPhText] = createSignal<string>("offline");

  // ── Player handle ────────────────────────────────────────────────────
  // Captured outside of any signal so cleanup can reach it.
  let player: LiveStreamHandle | null = null;

  // Saved quality choice (read once per attach; reapplied on every
  // fresh attach to mirror the legacy "across reconnects" behaviour).
  let savedQuality: SavedQuality = null;

  // ── Telemetry overlay painter ────────────────────────────────────────
  // Each new telemetry frame cancels the prior pending paint via the
  // tile-scoped timer; after painting, a 1.5s clear timer wipes the
  // overlay if no fresh frame arrives.
  let overlayDelayTimer: ReturnType<typeof setTimeout> | null = null;
  let overlayClearTimer: ReturnType<typeof setTimeout> | null = null;

  const paintOverlayNow = (t: TelemetryFrame) => {
    if (!overlayEl) return;
    const W = num(t.width);
    const H = num(t.height);
    if (!W || !H) return;
    overlayEl.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const preds = t.predictions || [];
    overlayEl.innerHTML = preds.map((p) => boxMarkup(p)).join("");
    if (overlayClearTimer) clearTimeout(overlayClearTimer);
    overlayClearTimer = setTimeout(() => {
      if (overlayEl) overlayEl.innerHTML = "";
    }, 1500);
  };

  const handleTelemetry = (t: TelemetryFrame) => {
    if (!t.host || !t.width || !t.height) return;
    // Delay by the live-edge HLS latency so bboxes land with the frame.
    const latency = player?.getLatencySecs() ?? null;
    const delayMs =
      latency != null && latency > 0.2
        ? Math.min(5000, Math.round(latency * 1000))
        : 1400;
    if (overlayDelayTimer) clearTimeout(overlayDelayTimer);
    overlayDelayTimer = setTimeout(() => paintOverlayNow(t), delayMs);
  };

  // Expose the painter to the parent — called once during component
  // construction so LiveGrid can route SSE telemetry frames here.
  props.registerPainter(handleTelemetry);

  // ── Snapshot fallback (called when stream is not ready) ──────────────
  const loadLastSnapshot = async () => {
    try {
      const { events } = await api.events({
        host: props.device.host,
        limit: 1,
      });
      const withImage = events.find((e) => e.image_file);
      if (withImage) {
        setSnapshotSrc(`/media/${encodeURIComponent(withImage.image_file!)}`);
        setAgeText(`last ${fmtTime(withImage.started_epoch)}`);
        return;
      }
    } catch {}
    setSnapshotSrc(null);
    setPhText("offline · no snapshot");
    setAgeText("offline");
  };

  // ── Attach / detach in response to stream state changes ──────────────
  const detachPlayer = () => {
    if (player) {
      try { player.destroy(); } catch {}
      player = null;
    }
    setLive(false);
    setPickerVisible(false);
    setLevels([]);
    setCurrentHeight(null);
    setTransport(null);
    setIsAuto(true);
    setIsOverride(false);
  };

  const attachPlayer = () => {
    if (live()) return; // already attached
    if (!props.cfg) return;
    const name = cameraName();
    setLive(true);
    setStatusDot("reconnecting");

    const masterUrl = `/api/streams/${encodeURIComponent(name)}/master.m3u8`;
    const hlsFallbackUrl = `${props.cfg.hls_base}/${encodeURIComponent(name)}/index.m3u8`;
    const whepUrl = props.cfg.webrtc_base
      ? `${props.cfg.webrtc_base}/${encodeURIComponent(name)}/whep`
      : null;

    savedQuality = readSavedQuality(name);

    player = attachLiveStream(
      videoEl,
      { hlsUrl: masterUrl, hlsFallbackUrl, whepUrl },
      // onPlay
      () => {
        setStatusDot("live");
        setAgeText(transport() === "webrtc" ? "live · rtc" : "live");
      },
      // onFail
      () => {
        setStatusDot("reconnecting");
        setAgeText("reconnecting…");
      },
      // onTransport
      (t) => {
        setTransport(t);
        setPickerVisible(true);
        if (t === "webrtc") {
          // WebRTC has no variant ladder.
          setLevels([]);
          setCurrentHeight(null);
          setIsAuto(false);
          setIsOverride(false);
        }
      },
      {
        onLevels: (lvls) => {
          setLevels(lvls);
          // Apply the saved override now that we know what's available.
          if (!player) return;
          const sq = savedQuality;
          if (sq?.kind === "auto") {
            player.setLevel(-1);
          } else if (sq?.kind === "height") {
            const match = lvls.find((l) => l.height === sq.height);
            if (match) player.setLevel(match.index);
          }
        },
        onLevelChange: ({ height, isAuto: auto, isOverride: override }) => {
          if (transport() === "webrtc") return;
          setCurrentHeight(height);
          setIsAuto(auto);
          setIsOverride(override);
        },
      },
    );
  };

  // React to `stream.ready` flips. Note that `props.stream` may be
  // replaced wholesale (different Stream object) when the poll refreshes
  // — we only care about the `ready` boolean for attach/detach decisions.
  createEffect(() => {
    const s = props.stream;
    if (s?.ready) {
      attachPlayer();
    } else {
      detachPlayer();
      setStatusDot("dead");
      setAgeText("offline");
      void loadLastSnapshot();
    }
  });

  // Tile-level cleanup. Runs when the tile is unmounted (parent navigates
  // away or device list changes).
  onCleanup(() => {
    detachPlayer();
    if (overlayDelayTimer) clearTimeout(overlayDelayTimer);
    if (overlayClearTimer) clearTimeout(overlayClearTimer);
  });

  // ── Click handler: toggle focus, ignoring controls ───────────────────
  const onTileClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest("[data-stop-focus]")) return;
    props.onToggleFocus();
  };

  // ── Quality picker callback ──────────────────────────────────────────
  const onPickQuality = (value: number | "auto") => {
    const name = cameraName();
    writeSavedQuality(name, value);
    savedQuality =
      value === "auto" ? { kind: "auto" } : { kind: "height", height: value };
    if (!player) return;
    if (value === "auto") {
      player.setLevel(-1);
    } else {
      player.setLevelByHeight(value);
    }
  };

  // ── Status classes for the dot + age ─────────────────────────────────
  const dotClass = () => {
    const s = statusDot();
    if (s === "live") return "dot";
    if (s === "reconnecting") return "dot reconnecting";
    return "dot dead";
  };
  const ageClass = () =>
    statusDot() === "reconnecting" ? "age reconnecting" : "age";

  return (
    <div
      class={`live-tile${props.focused ? " focus" : ""}`}
      data-host={props.device.host}
      data-name={cameraName()}
      onClick={onTileClick}
    >
      <video
        ref={videoEl}
        muted
        autoplay
        playsinline
        hidden={!live()}
      />
      <img
        ref={snapEl}
        class="snapshot"
        alt="last snapshot"
        src={snapshotSrc() ?? ""}
        hidden={live() || !snapshotSrc()}
      />
      <div
        ref={phEl}
        class="ph"
        hidden={live() || !!snapshotSrc()}
      >
        {phText()}
      </div>
      <svg
        ref={overlayEl}
        class="overlay"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      />
      <div class="label">
        <span class={dotClass()} />
        <span>{cameraName()}</span>
      </div>
      <QualityPicker
        levels={levels}
        currentHeight={currentHeight}
        isAuto={isAuto}
        isOverride={isOverride}
        transport={transport}
        visible={pickerVisible}
        onPick={onPickQuality}
      />
      <div class={ageClass()}>{ageText()}</div>
      <Show when={props.device.has_ptz}>
        <PtzControls host={props.device.host} />
      </Show>
    </div>
  );
};

export default LiveTile;
