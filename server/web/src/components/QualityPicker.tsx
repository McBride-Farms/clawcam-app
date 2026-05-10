import {
  For,
  Show,
  createSignal,
  type Accessor,
  type Component,
} from "solid-js";
import type { HlsLevel } from "~/lib/livestream";

// Per-tile quality picker. Receives the current set of HLS variants and
// the active level info; emits picks back to the parent (which persists
// them in localStorage and calls hls.setLevel*).
//
// The "close on outside click" listener is owned globally by LiveGrid so
// reattaches don't pile up listeners — we just expose `open()`/`hidden`
// state via DOM attributes (the legacy code closes via the `hidden`
// attribute on `.quality-menu`, so we do the same here).

export interface QualityPickerProps {
  /** Available HLS variants. Empty array hides the menu items. */
  levels: Accessor<HlsLevel[]>;
  /** Currently active rendition height. `null` before MANIFEST_PARSED. */
  currentHeight: Accessor<number | null>;
  /** Whether the user has manually pinned a level (vs auto/ABR). */
  isOverride: Accessor<boolean>;
  /** Whether HLS.js is currently in auto-ABR mode. */
  isAuto: Accessor<boolean>;
  /** "webrtc" disables the picker but keeps the button visible as "RTC". */
  transport: Accessor<"webrtc" | "hls" | null>;
  /** True when the stream is up; false hides the whole picker. */
  visible: Accessor<boolean>;
  /** User picked a height; "auto" returns control to HLS.js ABR. */
  onPick: (value: number | "auto") => void;
}

const QualityPicker: Component<QualityPickerProps> = (props) => {
  const [open, setOpen] = createSignal(false);

  // Label shown on the closed button. Mirrors the legacy logic:
  //   WebRTC          → "RTC" (button disabled)
  //   Auto (ABR)      → "Auto · 720p"
  //   Manual override → "720p"
  const buttonLabel = () => {
    if (props.transport() === "webrtc") return "RTC";
    const h = props.currentHeight();
    if (h == null) return "—";
    if (props.isAuto() && !props.isOverride()) return `Auto · ${h}p`;
    return `${h}p`;
  };

  const disabled = () => props.transport() === "webrtc";

  // Sort top-down by height for an intuitive list (1080, 720, ...).
  const sortedLevels = () =>
    [...props.levels()].sort((a, b) => (b.height || 0) - (a.height || 0));

  const isCurrentAuto = () => !props.isOverride();
  const isCurrentHeight = (h: number) =>
    props.isOverride() && props.currentHeight() === h;

  return (
    <Show when={props.visible()}>
      <div
        class="quality"
        data-stop-focus
        // The global outside-click handler in LiveGrid closes any
        // `.quality-menu:not([hidden])` — we don't need a per-component
        // listener here, but we still hide-on-pick locally.
      >
        <button
          class="quality-btn"
          type="button"
          aria-haspopup="true"
          aria-expanded={open() ? "true" : "false"}
          disabled={disabled()}
          onClick={(e) => {
            e.stopPropagation();
            if (disabled()) return;
            setOpen(!open());
          }}
        >
          {buttonLabel()}
        </button>
        <div
          class="quality-menu"
          role="menu"
          hidden={!open()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            class={`quality-item${isCurrentAuto() ? " current" : ""}`}
            onClick={() => {
              setOpen(false);
              props.onPick("auto");
            }}
          >
            Auto
          </button>
          <For each={sortedLevels()}>
            {(lvl) => (
              <button
                type="button"
                class={`quality-item${
                  isCurrentHeight(lvl.height) ? " current" : ""
                }`}
                onClick={() => {
                  setOpen(false);
                  props.onPick(lvl.height);
                }}
              >
                {lvl.height}p
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
};

export default QualityPicker;
