// Typed fetch client for clawcam-app's REST API. Mirrors the routes in
// server/src/api.ts and uses the shared types so a server-side change
// shows up as a TS error here.

import type {
  ClawcamConfig,
  Device,
  EventDetail,
  EventRow,
  PtzRequest,
  Stream,
} from "@shared/types";

const TOKEN_KEY = "clawcam_token";

export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  document.cookie = `clawcam_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
}

export function getAuthToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw new ApiError(`${path}: ${res.status}`, res.status);
  }
  // Some endpoints return text/plain (e.g. master.m3u8) — caller passes
  // `Accept: text/plain` and we shouldn't try to JSON-parse the response.
  // We default to JSON since every typed endpoint returns JSON.
  return (await res.json()) as T;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export const api = {
  config: () => request<ClawcamConfig>("/api/config"),

  health: () =>
    request<{ ok: boolean; version: string; time: number }>("/api/health"),

  streams: () => request<{ streams: Stream[] }>("/api/streams"),

  devices: () => request<{ devices: Device[] }>("/api/devices"),

  device: (host: string) =>
    request<{ device: Device }>(`/api/devices/${encodeURIComponent(host)}`),

  registerDevice: (host: string, name: string | null) =>
    request<{ ok: true }>("/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, name }),
    }),

  setDeviceSystemPrompt: (host: string, system_prompt: string | null) =>
    request<{ device: Device }>(
      `/api/devices/${encodeURIComponent(host)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt }),
      },
    ),

  events: (params: {
    host?: string;
    limit?: number;
    offset?: number;
    sinceHours?: number;
  } = {}) => {
    const q = new URLSearchParams();
    if (params.host) q.set("host", params.host);
    if (params.limit != null) q.set("limit", String(params.limit));
    if (params.offset != null) q.set("offset", String(params.offset));
    if (params.sinceHours != null) q.set("since_hours", String(params.sinceHours));
    const qs = q.toString();
    return request<{ events: EventRow[]; limit: number; offset: number }>(
      `/api/events${qs ? "?" + qs : ""}`,
    );
  },

  event: (id: string) => request<EventDetail>(`/api/events/${encodeURIComponent(id)}`),

  ptz: (host: string, body: PtzRequest) =>
    request<{ ok: true } | { error: string }>(
      `/api/devices/${encodeURIComponent(host)}/ptz`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
};
