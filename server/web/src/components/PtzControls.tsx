import { onCleanup, type Component } from "solid-js";
import type { PtzRequest } from "@shared/types";
import { sendPtz } from "~/lib/ptz";

// Pan / Tilt / Zoom controls — joystick (desktop+touch) + d-pad (touch
// fallback) + zoom buttons. Ported from server/public/app.js
// `wireTilePtz` + `wireTileJoystick` (lines 123-295).
//
// Press-and-hold model: while a button is down (or joystick is off-center)
// we issue a short burst (400ms) and re-issue it every 250ms so the motor
// stays running. On release we fire an explicit stop. If the stop is lost
// in transit, the camera's own BURST_MS auto-stop kicks in.
//
// Pan is *inverted* (joystick-right ⇒ pan=-1) — see line 223 of the
// original. Camera mount is mirrored relative to the operator's view.

const BURST_MS = 400;
const REISSUE_MS = 250;
const DEADZONE = 0.18;

type DpadAction =
  | "up"
  | "down"
  | "left"
  | "right"
  | "zoom-in"
  | "zoom-out";

function bodyFor(action: DpadAction): PtzRequest {
  switch (action) {
    case "up":       return { tilt: +1, duration_ms: BURST_MS };
    case "down":     return { tilt: -1, duration_ms: BURST_MS };
    case "left":     return { pan: +1,  duration_ms: BURST_MS };
    case "right":    return { pan: -1,  duration_ms: BURST_MS };
    case "zoom-in":  return { zoom: +1, duration_ms: BURST_MS };
    case "zoom-out": return { zoom: -1, duration_ms: BURST_MS };
  }
}

export interface PtzControlsProps {
  host: string;
}

const PtzControls: Component<PtzControlsProps> = (props) => {
  // Track per-button reissue timers so we can clean them all up on
  // component teardown (camera offline / focus toggle / page nav).
  const activeTimers = new Set<ReturnType<typeof setInterval>>();

  onCleanup(() => {
    for (const t of activeTimers) clearInterval(t);
    activeTimers.clear();
  });

  // Wire a single d-pad button: pointer-down starts the burst+reissue
  // loop; pointer-up/cancel/leave stops and fires the explicit stop.
  const wireButton = (btn: HTMLButtonElement, action: DpadAction) => {
    const body = bodyFor(action);
    let activePointer: number | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = (e: PointerEvent) => {
      if (activePointer !== null) return;
      e.preventDefault();
      e.stopPropagation();
      activePointer = e.pointerId;
      try { btn.setPointerCapture(e.pointerId); } catch {}
      btn.classList.add("active");
      void sendPtz(props.host, body);
      timer = setInterval(() => void sendPtz(props.host, body), REISSUE_MS);
      activeTimers.add(timer);
    };
    const stop = (e: PointerEvent) => {
      if (activePointer === null) return;
      activePointer = null;
      if (timer) {
        clearInterval(timer);
        activeTimers.delete(timer);
        timer = null;
      }
      try { btn.releasePointerCapture(e.pointerId); } catch {}
      btn.classList.remove("active");
      void sendPtz(props.host, { stop: true });
    };

    btn.addEventListener("pointerdown", start);
    btn.addEventListener("pointerup", stop);
    btn.addEventListener("pointercancel", stop);
    btn.addEventListener("pointerleave", stop);
  };

  // `ref` callback factories below thread the action enum into the wiring
  // function. Solid invokes these once per element after mount.
  const refFor = (action: DpadAction) => (el: HTMLButtonElement) => {
    wireButton(el, action);
  };

  const refHome = (btn: HTMLButtonElement) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void sendPtz(props.host, { home: true });
    });
  };

  // ── Joystick ──────────────────────────────────────────────────────────
  const wireJoystick = (
    base: HTMLDivElement,
    thumb: HTMLDivElement,
  ) => {
    let pointerId: number | null = null;
    let lastDir = { pan: 0, tilt: 0 };
    let timer: ReturnType<typeof setInterval> | null = null;

    const setThumb = (dx: number, dy: number) => {
      thumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    };
    const resetThumb = () => {
      thumb.style.transform = "translate(-50%, -50%)";
    };
    const dirFromNormalized = (nx: number, ny: number) => ({
      // Pan inverted — see header comment.
      pan: Math.abs(nx) < DEADZONE ? 0 : (nx > 0 ? -1 : +1),
      // Screen-y grows down, but tilt=+1 is up.
      tilt: Math.abs(ny) < DEADZONE ? 0 : (ny > 0 ? -1 : +1),
    });
    const issueBurst = (dir: { pan: number; tilt: number }) => {
      if (dir.pan === 0 && dir.tilt === 0) return;
      void sendPtz(props.host, {
        pan: dir.pan,
        tilt: dir.tilt,
        duration_ms: BURST_MS,
      });
    };
    const stopReissue = () => {
      if (timer) {
        clearInterval(timer);
        activeTimers.delete(timer);
        timer = null;
      }
    };

    const onDown = (ev: PointerEvent) => {
      if (pointerId !== null) return;
      pointerId = ev.pointerId;
      try { base.setPointerCapture(pointerId); } catch {}
      ev.preventDefault();
      ev.stopPropagation();
      onMove(ev);
    };

    const onMove = (ev: PointerEvent) => {
      if (pointerId === null || ev.pointerId !== pointerId) return;
      const rect = base.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const radius = rect.width / 2;
      let dx = ev.clientX - cx;
      let dy = ev.clientY - cy;
      const dist = Math.hypot(dx, dy);
      const thumbMax = radius * 0.7;
      if (dist > thumbMax) {
        dx = (dx / dist) * thumbMax;
        dy = (dy / dist) * thumbMax;
      }
      setThumb(dx, dy);
      const nx = dx / thumbMax;
      const ny = dy / thumbMax;
      const dir = dirFromNormalized(nx, ny);

      if (dir.pan !== lastDir.pan || dir.tilt !== lastDir.tilt) {
        // Direction changed — fire immediately and reset reissue cadence.
        lastDir = dir;
        stopReissue();
        if (dir.pan === 0 && dir.tilt === 0) {
          void sendPtz(props.host, { stop: true });
        } else {
          issueBurst(dir);
          timer = setInterval(() => issueBurst(lastDir), REISSUE_MS);
          activeTimers.add(timer);
        }
      }
    };

    const onUp = (ev: PointerEvent) => {
      if (pointerId === null || ev.pointerId !== pointerId) return;
      try { base.releasePointerCapture(pointerId); } catch {}
      pointerId = null;
      resetThumb();
      stopReissue();
      if (lastDir.pan !== 0 || lastDir.tilt !== 0) {
        void sendPtz(props.host, { stop: true });
      }
      lastDir = { pan: 0, tilt: 0 };
    };

    base.addEventListener("pointerdown", onDown);
    base.addEventListener("pointermove", onMove);
    base.addEventListener("pointerup", onUp);
    base.addEventListener("pointercancel", onUp);
    base.addEventListener("pointerleave", onUp);
  };

  let joyBase!: HTMLDivElement;
  let joyThumb!: HTMLDivElement;

  // Refs are populated synchronously after the JSX builds — wire as soon
  // as both are present (joystick is the only multi-element interaction).
  const onBaseRef = (el: HTMLDivElement) => {
    joyBase = el;
    if (joyBase && joyThumb) wireJoystick(joyBase, joyThumb);
  };
  const onThumbRef = (el: HTMLDivElement) => {
    joyThumb = el;
    if (joyBase && joyThumb) wireJoystick(joyBase, joyThumb);
  };

  return (
    <div class="ptz" data-stop-focus title="Pan / Tilt / Zoom">
      <div class="ptz-joystick" aria-label="Pan/tilt joystick">
        <div class="ptz-joystick-base" ref={onBaseRef}>
          <div class="ptz-joystick-thumb" ref={onThumbRef} />
        </div>
        <button
          class="ptz-home ptz-joystick-home"
          data-ptz="home"
          title="Re-center"
          ref={refHome}
        >
          ⌂
        </button>
      </div>
      <div class="ptz-dpad">
        <button class="ptz-empty" tabIndex={-1}></button>
        <button data-ptz="up" title="Tilt up" ref={refFor("up")}>▲</button>
        <button class="ptz-empty" tabIndex={-1}></button>
        <button data-ptz="left" title="Pan left" ref={refFor("left")}>◀</button>
        <button class="ptz-home" data-ptz="home" title="Re-center" ref={refHome}>⌂</button>
        <button data-ptz="right" title="Pan right" ref={refFor("right")}>▶</button>
        <button class="ptz-empty" tabIndex={-1}></button>
        <button data-ptz="down" title="Tilt down" ref={refFor("down")}>▼</button>
        <button class="ptz-empty" tabIndex={-1}></button>
      </div>
      <div class="ptz-zoom">
        <button data-ptz="zoom-in" title="Zoom in" ref={refFor("zoom-in")}>+</button>
        <span class="ptz-z-label">zoom</span>
        <button data-ptz="zoom-out" title="Zoom out" ref={refFor("zoom-out")}>−</button>
      </div>
    </div>
  );
};

export default PtzControls;
