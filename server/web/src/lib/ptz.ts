// Fire-and-forget PTZ command sender. The on-device VISCA server (clawcam
// ≥ 0.5.6) returns 200 immediately after queuing the initial byte, but even
// with a slow link we never want d-pad press/release to feel laggy — so we
// dispatch the POST without awaiting and swallow errors.
//
// Auth: the cookie set by setAuthToken in ~/lib/api rides along on the
// `credentials: "same-origin"` fetch, matching the rest of the app.

import type { PtzRequest } from "@shared/types";
import { getAuthToken } from "~/lib/api";

export async function sendPtz(host: string, body: PtzRequest): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    await fetch(`/api/devices/${encodeURIComponent(host)}/ptz`, {
      method: "POST",
      headers,
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
  } catch {
    // Swallow — see comment above; do not let a network blip break the UI.
  }
}
