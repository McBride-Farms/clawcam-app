import { createSignal, onCleanup, onMount, type Component } from "solid-js";
import { subscribeSse } from "~/lib/sse";

// Connection state for the SSE stream that powers events + telemetry.
//
//   "connecting" — first connection in flight (also the initial state).
//   "live"       — onopen fired and we haven't seen an error since.
//   "reconnecting" — onerror fired; EventSource is auto-retrying.
//   "lost"       — escalated after >15s without an open. Server is likely
//                  unreachable; user should refresh or check the backend.
export type LiveState = "connecting" | "live" | "reconnecting" | "lost";

const LiveStatus: Component = () => {
  const [state, setState] = createSignal<LiveState>("connecting");

  let lostTimer: ReturnType<typeof setTimeout> | null = null;
  const armLostTimer = () => {
    if (lostTimer) clearTimeout(lostTimer);
    lostTimer = setTimeout(() => setState("lost"), 15_000);
  };
  const disarmLostTimer = () => {
    if (lostTimer) clearTimeout(lostTimer);
    lostTimer = null;
  };

  onMount(() => {
    const unsub = subscribeSse({
      onOpen: () => {
        disarmLostTimer();
        setState("live");
      },
      onError: () => {
        if (state() !== "lost") setState("reconnecting");
        armLostTimer();
      },
    });
    onCleanup(() => {
      unsub();
      disarmLostTimer();
    });
  });

  // CSS classes mirror the existing app.js — `.live.on` for live,
  // `.live.off` for reconnecting (yellow), `.live.lost` for hard failure
  // (red). Plain `.live` is the connecting state (grey).
  const dotClass = () => {
    const s = state();
    if (s === "live") return "live on";
    if (s === "reconnecting" || s === "connecting") return "live off";
    return "live lost";
  };
  const text = () => {
    const s = state();
    if (s === "live") return "live";
    if (s === "connecting") return "connecting…";
    if (s === "reconnecting") return "reconnecting…";
    return "disconnected";
  };

  return (
    <div class="status">
      <span class={dotClass()} />
      <span>{text()}</span>
    </div>
  );
};

export default LiveStatus;
