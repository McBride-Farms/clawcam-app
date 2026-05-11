import {
  For,
  Show,
  createResource,
  createSignal,
  onMount,
  type Component,
} from "solid-js";
import { api } from "~/lib/api";
import type { Device, EventRow } from "@shared/types";

// Filter dropdown options, mirroring the original index.html template.
// Default 168h (7d) matches the legacy app's `state.sinceHours`.
const SINCE_OPTIONS: Array<{ label: string; hours: number }> = [
  { label: "Last 24h", hours: 24 },
  { label: "Last 7d", hours: 168 },
  { label: "Last 30d", hours: 720 },
];

// CSS-token sanitizer: keeps the suggested_action / status string safe to
// stick into a class name. Original lived in app.js as `cssToken`.
function cssToken(v: string | null | undefined): string {
  return String(v ?? "").replace(/[^A-Za-z0-9_-]/g, "");
}

// Relative-time formatter. Mirrors `fmtTime` in the legacy app.js.
function fmtTime(epoch: number | null | undefined): string {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleString();
}

const EventsList: Component = () => {
  const [filterHost, setFilterHost] = createSignal<string>("");
  const [sinceHours, setSinceHours] = createSignal<number>(168);
  // Bumped by the Refresh button to force a re-fetch even when filters
  // haven't changed. createResource only re-runs when its source value
  // changes, so we fold the nonce into the source tuple.
  const [nonce, setNonce] = createSignal(0);

  // Astro prerenders the component server-side. fetch() with a relative
  // URL throws under Node, baking an error into the HTML. Both resources
  // gate on a signal that flips only on client mount so SSR sees the
  // resource as pending-with-no-source-yet and emits a clean Loading…
  // placeholder.
  const [browserReady, setBrowserReady] = createSignal(false);
  onMount(() => setBrowserReady(true));

  // Devices are loaded once for the host filter dropdown. Errors are
  // swallowed (we still want the page to render with "All devices").
  const [devicesData] = createResource<{ devices: Device[] }, boolean>(
    browserReady,
    () => api.devices().catch(() => ({ devices: [] as Device[] })),
  );

  const [eventsData, { refetch }] = createResource(
    () =>
      browserReady()
        ? { host: filterHost(), sinceHours: sinceHours(), nonce: nonce() }
        : null,
    async (src: { host: string; sinceHours: number; nonce: number }) => {
      // Solid skips the fetcher whenever the source returns null, so we
      // never see a null `src` here — the type is narrowed already.
      const res = await api.events({
        host: src.host || undefined,
        sinceHours: src.sinceHours,
        limit: 100,
      });
      return res.events;
    },
  );

  // createResource auto-refetches whenever its source signal changes
  // (host / sinceHours / nonce). Refresh button bumps `nonce` to force a
  // re-fetch even when the filters haven't moved.
  const onRefresh = () => {
    setNonce((n) => n + 1);
    void refetch();
  };

  return (
    <>
      <div class="filters">
        <select
          id="filter-host"
          value={filterHost()}
          onChange={(e) => setFilterHost(e.currentTarget.value)}
        >
          <option value="">All devices</option>
          <For each={devicesData()?.devices ?? []}>
            {(d) => (
              <option value={d.host}>{d.name || d.host}</option>
            )}
          </For>
        </select>
        <select
          id="filter-since"
          value={String(sinceHours())}
          onChange={(e) => setSinceHours(parseInt(e.currentTarget.value, 10))}
        >
          <For each={SINCE_OPTIONS}>
            {(opt) => <option value={String(opt.hours)}>{opt.label}</option>}
          </For>
        </select>
        <button id="refresh" type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      <div id="events-list" class="events">
        <Show
          when={!eventsData.loading && (eventsData()?.length ?? 0) > 0}
          fallback={
            <Show
              when={!eventsData.loading}
              fallback={<div class="empty-state">Loading…</div>}
            >
              <div class="empty-state">
                No events yet. Point a clawcam webhook at this server to see
                detections here.
              </div>
            </Show>
          }
        >
          <For each={eventsData() ?? []}>{(e) => <EventCard event={e} />}</For>
        </Show>
      </div>
    </>
  );
};

const EventCard: Component<{ event: EventRow }> = (props) => {
  // CSV "dog,person" -> ["dog", "person"]; falsy entries dropped.
  const classes = () =>
    (props.event.classes || "").split(",").filter(Boolean);
  // interest_level can be 0, so strict null/undefined check rather than
  // truthy. Original used Number.isInteger.
  const lvl = () => {
    const v = props.event.vision_interest_level;
    return Number.isInteger(v) ? (v as number) : null;
  };
  const action = () => {
    const a = props.event.vision_suggested_action;
    return a && a !== "none" ? a : null;
  };

  return (
    <a
      class="event"
      href={`/event?id=${encodeURIComponent(props.event.event_id)}`}
    >
      <Show
        when={props.event.image_file}
        fallback={<div class="thumb empty">(no image)</div>}
      >
        <img
          class="thumb"
          src={`/media/${encodeURIComponent(props.event.image_file ?? "")}`}
          alt="event"
          loading="lazy"
        />
      </Show>
      <div class="meta">
        <div class="row1">
          <span class="host" title={props.event.host}>
            {props.event.host}
          </span>
          <Show when={lvl() !== null}>
            <span
              class={`interest interest-${lvl()}`}
              title={`interest level ${lvl()}/3`}
            >
              {lvl()}
            </span>
          </Show>
          <Show when={action()}>
            <span class={`action-pill action-${cssToken(action())}`}>
              {action()}
            </span>
          </Show>
          <span class={`status-pill ${cssToken(props.event.status)}`}>
            {props.event.status}
          </span>
        </div>
        <div class="when">
          {fmtTime(props.event.started_epoch)}
          <Show when={props.event.duration_secs}>
            {" · "}
            {(props.event.duration_secs ?? 0).toFixed(1)}s
          </Show>
        </div>
        <div class="classes">
          <Show
            when={classes().length > 0}
            fallback={<span class="mute">—</span>}
          >
            <For each={classes()}>{(c) => <span class="tag">{c}</span>}</For>
          </Show>
        </div>
        <Show when={props.event.vision_caption}>
          <div class="vision">{props.event.vision_caption}</div>
        </Show>
      </div>
    </a>
  );
};

export default EventsList;
