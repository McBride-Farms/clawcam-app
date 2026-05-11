import {
  For,
  Show,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { api } from "~/lib/api";
import type { EventDetail as EventDetailData, EventPhase } from "@shared/types";

// ----------------------------------------------------------------------------
// Narrow types for phase payloads.
//
// The wire shape (server/shared/types.ts) types `payload` as `unknown` because
// the Rust device sends slightly different bodies for "start", "update", and
// "end" phases. The legacy app.js just duck-typed everything; here we narrow
// once at the top of the component so the JSX below is fully typed.
// ----------------------------------------------------------------------------

interface Detection {
  class: string;
  class_id?: number;
  score: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Track {
  track_id: number;
  class: string;
  duration_secs: number;
  movement_px: number;
  is_stationary: boolean;
  bbox?: [number, number, number, number];
}

interface ClipPredictionSample {
  frame_index: number;
  t: number;
  boxes: Detection[];
}

interface StartPayload {
  predictions?: Detection[];
  pre_frame_files?: string[];
  tracks?: Track[];
}

interface EndPayload {
  clip_predictions?: ClipPredictionSample[];
  tracks?: Track[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asStartPayload(v: unknown): StartPayload | null {
  return isObject(v) ? (v as StartPayload) : null;
}
function asEndPayload(v: unknown): EndPayload | null {
  return isObject(v) ? (v as EndPayload) : null;
}

// ----------------------------------------------------------------------------
// Inline helpers (formerly fmtTime / cssToken / num / boxMarkup in app.js).
// boxMarkup is split into a Solid <Box> component so we don't have to set
// innerHTML on the SVG.
// ----------------------------------------------------------------------------

function cssToken(v: string | null | undefined): string {
  return String(v ?? "").replace(/[^A-Za-z0-9_-]/g, "");
}

function fmtTime(epoch: number | null | undefined): string {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleString();
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const Box: Component<{ p: Detection }> = (props) => {
  const left = () => num(props.p.left);
  const top = () => num(props.p.top);
  const w = () => Math.max(0, num(props.p.right) - left());
  const h = () => Math.max(0, num(props.p.bottom) - top());
  const label = () =>
    `${props.p.class ?? ""} ${(num(props.p.score) * 100).toFixed(0)}%`;
  return (
    <g>
      <rect x={left()} y={top()} width={w()} height={h()} />
      <text x={left() + 6} y={top() + 22}>
        {label()}
      </text>
    </g>
  );
};

// ----------------------------------------------------------------------------
// Main component.
// ----------------------------------------------------------------------------

const EventDetail: Component<{ id: string }> = (props) => {
  // Don't fetch during Astro's static-prerender pass — relative URL
  // fetch under Node throws. Gate the resource on a signal that's only
  // flipped after the component mounts in the browser. Solid skips the
  // fetcher whenever the source returns null/false/undefined.
  const [browserReady, setBrowserReady] = createSignal(false);
  onMount(() => setBrowserReady(true));
  const [data] = createResource(
    () => (browserReady() && props.id ? props.id : null),
    (id: string) => api.event(id),
  );

  return (
    <div id="detail-body">
      <Show
        when={!data.loading && data() && !data.error}
        fallback={
          <Show
            when={data.error}
            fallback={<div class="empty-state">Loading…</div>}
          >
            <div class="empty-state">
              Failed to load: {(data.error as Error)?.message ?? "unknown error"}
            </div>
          </Show>
        }
      >
        <Loaded data={data()!} />
      </Show>
    </div>
  );
};

const Loaded: Component<{ data: EventDetailData }> = (props) => {
  const event = () => props.data.event;
  const phases = () => props.data.phases;

  const startPayload = createMemo<StartPayload | null>(() => {
    const p = phases().find((ph) => ph.phase === "start");
    return p ? asStartPayload(p.payload) : null;
  });
  const endPayload = createMemo<EndPayload | null>(() => {
    const p = phases().find((ph) => ph.phase === "end");
    return p ? asEndPayload(p.payload) : null;
  });

  const heroPreds = createMemo<Detection[]>(
    () => startPayload()?.predictions ?? [],
  );
  const preFiles = createMemo<string[]>(
    () => startPayload()?.pre_frame_files ?? [],
  );
  const tracks = createMemo<Track[]>(
    () => endPayload()?.tracks ?? startPayload()?.tracks ?? [],
  );
  const clipPreds = createMemo<ClipPredictionSample[]>(() => {
    const arr = endPayload()?.clip_predictions ?? [];
    // Defensive sort by t — matches legacy behaviour.
    return [...arr].sort((a, b) => a.t - b.t);
  });

  const lvl = () => {
    const v = event().vision_interest_level;
    return Number.isInteger(v) ? (v as number) : null;
  };
  const action = () => {
    const a = event().vision_suggested_action;
    return a && a !== "none" ? a : null;
  };

  return (
    <>
      {/* Hero image with detection bbox overlay. */}
      <Show when={event().image_file}>
        <Hero
          src={`/media/${encodeURIComponent(event().image_file ?? "")}`}
          preds={heroPreds()}
        />
      </Show>

      {/* Vision banner — only when we have a caption. */}
      <Show when={event().vision_caption}>
        <div
          class="vision-banner"
          title="Generated by the configured vision model on grunt-node2. Treat detail (colors, species) as approximate."
        >
          <div class="vision-head">
            <span class="vision-label">Vision</span>
            <Show when={lvl() !== null}>
              <span
                class={`interest interest-${lvl()}`}
                title={`interest ${lvl()}/3`}
              >
                {lvl()}
              </span>
            </Show>
            <Show when={action()}>
              <span class={`action-pill action-${cssToken(action())}`}>
                {action()}
              </span>
            </Show>
          </div>
          <span class="vision-text">{event().vision_caption}</span>
        </div>
      </Show>

      <div class="meta-grid">
        <div class="k">Device</div>
        <div>{event().host}</div>
        <div class="k">Started</div>
        <div>{new Date(event().started_epoch * 1000).toLocaleString()}</div>
        <div class="k">Duration</div>
        <div>
          {event().duration_secs
            ? `${(event().duration_secs ?? 0).toFixed(1)}s`
            : "—"}
        </div>
        <div class="k">Status</div>
        <div>{event().status}</div>
        <div class="k">Event ID</div>
        <div>
          <code>{event().event_id}</code>
        </div>
      </div>

      <Show when={event().clip_file}>
        <h2>Clip</h2>
        <ClipPlayer
          src={`/media/${encodeURIComponent(event().clip_file ?? "")}`}
          samples={clipPreds()}
        />
      </Show>

      <Show when={preFiles().length > 0}>
        <h2>Pre-detection frames</h2>
        <div class="frame-strip">
          <For each={preFiles()}>
            {(f) => (
              <img src={`/media/${encodeURIComponent(f)}`} loading="lazy" />
            )}
          </For>
        </div>
      </Show>

      <Show when={tracks().length > 0}>
        <h2>Tracks</h2>
        <For each={tracks()}>
          {(t) => (
            <div class="track">
              <span class="cls">{t.class}</span>
              <span>id={t.track_id}</span>
              <span>dur={(t.duration_secs || 0).toFixed(1)}s</span>
              <span>motion={(t.movement_px || 0).toFixed(0)}px</span>
              <Show when={t.is_stationary}>
                <span>stationary</span>
              </Show>
            </div>
          )}
        </For>
      </Show>

      <h2>Phases</h2>
      <For each={phases()}>{(p) => <PhaseBlock phase={p} />}</For>
    </>
  );
};

// ---- Hero (still image + bbox overlay) -------------------------------------

const Hero: Component<{ src: string; preds: Detection[] }> = (props) => {
  let imgRef: HTMLImageElement | undefined;
  let svgRef: SVGSVGElement | undefined;

  const sizeOverlay = () => {
    if (!imgRef || !svgRef) return;
    const W = imgRef.naturalWidth || 1920;
    const H = imgRef.naturalHeight || 1080;
    svgRef.setAttribute("viewBox", `0 0 ${W} ${H}`);
  };

  onMount(() => {
    if (!imgRef) return;
    if (imgRef.complete) sizeOverlay();
    else imgRef.addEventListener("load", sizeOverlay, { once: true });
  });

  return (
    <div class="hero-wrap">
      <img ref={imgRef} class="hero" src={props.src} alt="event" />
      <svg
        ref={svgRef}
        class="hero-overlay"
        preserveAspectRatio="none"
      >
        <For each={props.preds}>{(p) => <Box p={p} />}</For>
      </svg>
    </div>
  );
};

// ---- ClipPlayer (video + bbox overlay synced to currentTime) ---------------

const ClipPlayer: Component<{
  src: string;
  samples: ClipPredictionSample[];
}> = (props) => {
  let vidRef: HTMLVideoElement | undefined;
  let svgRef: SVGSVGElement | undefined;

  // Currently-active sample's boxes. We render via Solid's <For> rather
  // than mutating innerHTML, but the picking logic (nearest sample within
  // a 0.6s window) matches the legacy implementation 1:1.
  const [boxes, setBoxes] = createSignal<Detection[]>([]);

  const drawAt = (t: number) => {
    if (!vidRef || !svgRef) return;
    const W = vidRef.videoWidth || 1920;
    const H = vidRef.videoHeight || 1080;
    svgRef.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const samples = props.samples;
    if (!samples.length) {
      setBoxes([]);
      return;
    }
    let best: ClipPredictionSample | null = null;
    let bestDiff = Infinity;
    for (const s of samples) {
      const d = Math.abs(s.t - t);
      if (d < bestDiff) {
        bestDiff = d;
        best = s;
      }
    }
    if (!best || bestDiff > 0.6) {
      setBoxes([]);
      return;
    }
    setBoxes(best.boxes ?? []);
  };

  const onTimeUpdate = () => {
    if (vidRef) drawAt(vidRef.currentTime);
  };
  const onSeeked = () => {
    if (vidRef) drawAt(vidRef.currentTime);
  };
  const onLoadedMeta = () => {
    if (vidRef) drawAt(vidRef.currentTime || 0);
  };

  onMount(() => {
    if (!vidRef) return;
    vidRef.addEventListener("timeupdate", onTimeUpdate);
    vidRef.addEventListener("seeked", onSeeked);
    vidRef.addEventListener("loadedmetadata", onLoadedMeta);
  });
  onCleanup(() => {
    if (!vidRef) return;
    vidRef.removeEventListener("timeupdate", onTimeUpdate);
    vidRef.removeEventListener("seeked", onSeeked);
    vidRef.removeEventListener("loadedmetadata", onLoadedMeta);
  });

  return (
    <div class="hero-wrap clip-wrap">
      <video
        ref={vidRef}
        controls
        playsinline
        preload="metadata"
        src={props.src}
      />
      <svg ref={svgRef} class="hero-overlay" preserveAspectRatio="none">
        <For each={boxes()}>{(p) => <Box p={p} />}</For>
      </svg>
    </div>
  );
};

// ---- Phases (raw JSON pretty-print) ----------------------------------------

const PhaseBlock: Component<{ phase: EventPhase }> = (props) => {
  const json = () => JSON.stringify(props.phase.payload, null, 2);
  return (
    <div class="phase">
      <div class="ph-title">
        {props.phase.phase}
        <Show when={props.phase.detail}>
          {" · "}
          {props.phase.detail}
        </Show>{" "}
        <span
          class="mute"
          style="color:var(--muted); font-weight:normal"
        >
          {fmtTime(props.phase.epoch)}
        </span>
      </div>
      <pre>{json()}</pre>
    </div>
  );
};

export default EventDetail;
