// Subscribe to the server's SSE feed. The browser-native EventSource has
// no auto-reconnect with backoff and no Bearer-token support, so we wrap
// it: pass the token via cookie (already set by setAuthToken) and let the
// browser retry per the server's `retry:` directive.

import type { EventRow, TelemetryFrame } from "@shared/types";

export type ClawcamSseHandlers = {
  onEvent?: (e: EventRow & { phase?: string }) => void;
  onTelemetry?: (t: TelemetryFrame) => void;
  onOpen?: () => void;
  onError?: () => void;
};

export function subscribeSse(handlers: ClawcamSseHandlers): () => void {
  // Same-origin so the cookie token rides along; no need to append ?token.
  const es = new EventSource("/api/stream");
  if (handlers.onOpen) es.addEventListener("open", () => handlers.onOpen?.());
  if (handlers.onError) es.addEventListener("error", () => handlers.onError?.());
  es.addEventListener("event", (ev) => {
    if (!handlers.onEvent) return;
    try {
      const data = JSON.parse((ev as MessageEvent<string>).data) as
        & EventRow
        & { phase?: string };
      handlers.onEvent(data);
    } catch {
      // Bad payload — drop it; don't kill the subscription.
    }
  });
  es.addEventListener("telemetry", (ev) => {
    if (!handlers.onTelemetry) return;
    try {
      const data = JSON.parse(
        (ev as MessageEvent<string>).data,
      ) as TelemetryFrame;
      handlers.onTelemetry(data);
    } catch {}
  });
  return () => es.close();
}
