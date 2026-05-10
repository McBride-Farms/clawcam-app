import {
  For,
  Show,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import type {
  ClawcamConfig,
  Device,
  EventRow,
  Stream,
  TelemetryFrame,
} from "@shared/types";
import { api } from "~/lib/api";
import { subscribeSse } from "~/lib/sse";
import LiveTile from "./LiveTile";

// Top-level orchestrator for the Live page. Responsibilities:
//
//   • Initial parallel load of devices + streams + config.
//   • 5s poll of /api/streams so tiles reattach when a camera comes back.
//   • SSE subscription: telemetry routes to the matching tile via its
//     registered painter; events trigger a flash toast.
//   • Single-focus model: only one tile carries the `.focus` class at
//     a time. A "Toggle focus" button blows up the first tile.
//   • Global outside-click listener that closes any open quality menu.
//     Registered once per mount (and torn down on unmount).
//   • Flash toast (`.flash`) shown for 5s on each SSE event.

interface DeviceWithKey {
  device: Device;
  /** Map key into `streamMap` — the camera's display name. */
  name: string;
}

const LiveGrid: Component = () => {
  // Master device list, fetched once on mount.
  const [devices, setDevices] = createSignal<Device[]>([]);
  // Latest stream-by-name map. Refreshed every 5s by the poll loop.
  const [streamMap, setStreamMap] = createSignal<Map<string, Stream>>(new Map());
  // Loaded config (HLS / WebRTC bases). `null` until first fetch completes.
  const [cfg, setCfg] = createSignal<ClawcamConfig | null>(null);
  // Loading state — shown until the initial devices/streams call resolves.
  const [loading, setLoading] = createSignal<boolean>(true);
  // Index of the currently focused tile, or null if none.
  const [focusedIndex, setFocusedIndex] = createSignal<number | null>(null);
  // SSE event flash (mirrors legacy showFlash).
  const [flash, setFlash] = createSignal<{
    eventId: string;
    phase: string;
    host: string;
  } | null>(null);

  // Routed by tile name. Populated as each tile mounts via the
  // `registerPainter` prop. Cleared on unmount via the same callback.
  const painters = new Map<string, (t: TelemetryFrame) => void>();

  // ── Initial load ──────────────────────────────────────────────────────
  const loadInitial = async () => {
    try {
      const [devsRes, streamsRes, cfgRes] = await Promise.all([
        api.devices().catch(() => ({ devices: [] as Device[] })),
        api.streams().catch(() => ({ streams: [] as Stream[] })),
        api.config().catch((): ClawcamConfig => ({
          // Defensive fallback — same shape the legacy code synthesized.
          hls_base: `${location.origin.replace(/:\d+$/, "")}:8888`,
          hls_master_url_template: "",
          webrtc_base: "",
          rtsp_base: "",
          webhook_url: "",
        })),
      ]);
      setDevices(devsRes.devices);
      const map = new Map<string, Stream>();
      for (const s of streamsRes.streams) map.set(s.name, s);
      setStreamMap(map);
      setCfg(cfgRes);
    } finally {
      setLoading(false);
    }
  };

  // ── 5s poll of /api/streams ──────────────────────────────────────────
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const startPolling = () => {
    pollTimer = setInterval(async () => {
      try {
        const { streams } = await api.streams();
        const map = new Map<string, Stream>();
        for (const s of streams) map.set(s.name, s);
        setStreamMap(map);
      } catch {
        // Transient — try again next tick.
      }
    }, 5000);
  };
  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  // ── SSE subscription ─────────────────────────────────────────────────
  let unsubSse: (() => void) | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  const handleSseEvent = (ev: EventRow & { phase?: string }) => {
    // Replace any existing flash before showing a new one.
    if (flashTimer) clearTimeout(flashTimer);
    setFlash({
      eventId: ev.event_id,
      phase: ev.phase ?? "event",
      host: ev.host,
    });
    flashTimer = setTimeout(() => setFlash(null), 5000);
  };

  const handleSseTelemetry = (t: TelemetryFrame) => {
    if (!t.host) return;
    // Route by either `host` or `name` (mirrors the legacy dataset check).
    for (const d of devices()) {
      const name = d.name || d.host;
      if (t.host === d.host || t.host === name) {
        const paint = painters.get(name);
        if (paint) paint(t);
      }
    }
  };

  // ── Global "close all quality menus on outside click" listener ───────
  // The legacy code registered this once per process; we do the same per
  // mount and tear it down in onCleanup so reattaches don't pile up.
  const closeQualityMenusOnClick = () => {
    document
      .querySelectorAll(".live-tile .quality-menu:not([hidden])")
      .forEach((m) => {
        (m as HTMLElement).hidden = true;
        const btn = m.parentElement?.querySelector(".quality-btn");
        if (btn) btn.setAttribute("aria-expanded", "false");
      });
  };

  // ── Mount/unmount ────────────────────────────────────────────────────
  // Everything browser-only goes inside onMount so SSR (which runs the
  // component body + onCleanup once during prerender) doesn't trip over
  // `document` / `EventSource` / etc.
  onMount(() => {
    void loadInitial().then(() => startPolling());
    unsubSse = subscribeSse({
      onEvent: handleSseEvent,
      onTelemetry: handleSseTelemetry,
    });
    document.addEventListener("click", closeQualityMenusOnClick);
    onCleanup(() => {
      stopPolling();
      unsubSse?.();
      document.removeEventListener("click", closeQualityMenusOnClick);
      if (flashTimer) clearTimeout(flashTimer);
    });
  });

  // ── Derived: ordered tile list ───────────────────────────────────────
  const tileEntries = (): DeviceWithKey[] =>
    devices().map((d) => ({ device: d, name: d.name || d.host }));

  const onToggleFocus = (idx: number) => {
    setFocusedIndex((prev) => (prev === idx ? null : idx));
  };

  const onToggleFirstFocus = () => {
    if (devices().length === 0) return;
    setFocusedIndex((prev) => (prev === 0 ? null : 0));
  };

  const onFlashClick = () => {
    const f = flash();
    if (!f) return;
    setFlash(null);
    location.href = `/event?id=${encodeURIComponent(f.eventId)}`;
  };

  return (
    <>
      <div class="filters">
        <button
          id="live-fullscreen"
          type="button"
          onClick={onToggleFirstFocus}
        >
          Toggle focus
        </button>
      </div>
      <section class="live-view">
        <Show when={!loading()} fallback={<div class="empty-state">Loading…</div>}>
          <Show
            when={devices().length > 0}
            fallback={
              <div class="empty-state">
                No devices yet. Register a camera to watch it here.
              </div>
            }
          >
            <div class="live-grid" id="live-grid">
              <For each={tileEntries()}>
                {(entry, i) => (
                  <LiveTile
                    device={entry.device}
                    stream={streamMap().get(entry.name) ?? null}
                    cfg={cfg()}
                    focused={focusedIndex() === i()}
                    onToggleFocus={() => onToggleFocus(i())}
                    registerPainter={(paint) => {
                      painters.set(entry.name, paint);
                      onCleanup(() => {
                        // Only delete if it's still our painter — guards
                        // against a stale closure clobbering the new tile's
                        // registration if the device list shuffles.
                        if (painters.get(entry.name) === paint) {
                          painters.delete(entry.name);
                        }
                      });
                    }}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </section>
      <Show when={flash()}>
        <div class="flash" onClick={onFlashClick}>
          new {flash()!.phase} · {flash()!.host}
        </div>
      </Show>
    </>
  );
};

export default LiveGrid;
