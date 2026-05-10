// Shared types between the Express server and the Astro+Solid frontend.
// Kept in `server/shared/` (rather than per-side) so a wire-shape change
// shows up as a TS error in both places at once.

export interface Device {
  host: string;
  name: string | null;
  first_seen: number;
  last_seen: number;
  event_count: number;
  system_prompt: string | null;
  // Decorated by /api/devices via a TCP probe; absent on /api/devices/:host.
  has_ptz?: boolean;
}

export interface EventRow {
  event_id: string;
  host: string;
  started_epoch: number;
  ended_epoch: number | null;
  duration_secs: number | null;
  classes: string | null;
  status: "active" | "ended";
  image_file: string | null;
  clip_file: string | null;
  vision_caption: string | null;
  vision_interest_level: number | null;
  vision_suggested_action: string | null;
  updated_at: number;
}

export interface EventPhase {
  phase: string;
  detail: string | null;
  epoch: number;
  // Stored as JSON in sqlite; parsed before serving. `null` if the row's
  // payload didn't parse as JSON (defensive — should not happen).
  payload: unknown;
}

export interface EventDetail {
  event: EventRow;
  phases: EventPhase[];
}

export interface Stream {
  name: string;
  ready: boolean;
  ready_since: string | null;
  tracks: string[];
  bytes_received: number;
  source_type: string | null;
}

export interface ClawcamConfig {
  hls_base: string;
  hls_master_url_template: string;
  webrtc_base: string;
  rtsp_base: string;
  webhook_url: string;
}

// Server Sent Events broadcast over /stream.
export type SseEvent =
  | { type: "event"; data: EventRow & { phase?: string } }
  | { type: "telemetry"; data: TelemetryFrame }
  | { type: "ping"; data: { time: number } };

export interface TelemetryFrame {
  host: string;
  epoch_ms: number;
  width: number;
  height: number;
  predictions: Array<{
    class: string;
    class_id: number;
    score: number;
    left: number;
    top: number;
    right: number;
    bottom: number;
  }>;
  tracks: Array<{
    track_id: number;
    class: string;
    duration_secs: number;
    movement_px: number;
    is_stationary: boolean;
    bbox: [number, number, number, number];
  }>;
}

// Webhook payload that clawcam (the Pi binary) posts to /hooks/clawcam.
// The on-device Rust struct is in clawcam:src/webhook/mod.rs — keep
// these field names in sync.
export interface WebhookPayload {
  ts: string;
  epoch: number;
  type: string;
  detail: string;
  source: string;
  host: string;
  image: string; // base64 JPEG
  predictions: Array<{
    class: string;
    class_id: number;
    score: number;
    left: number;
    top: number;
    right: number;
    bottom: number;
  }>;
  event_id?: string;
  event_phase?: "start" | "update" | "end";
  tracks?: Array<{
    track_id: number;
    class: string;
    duration_secs: number;
    movement_px: number;
    is_stationary: boolean;
    bbox: [number, number, number, number];
  }>;
  event_duration_secs?: number;
  clip?: string; // base64 MP4 (end phase only)
  pre_frames?: string[]; // base64 JPEGs (start phase only)
  clip_predictions?: Array<{
    frame_index: number;
    t: number;
    boxes: Array<{
      class: string;
      class_id: number;
      score: number;
      left: number;
      top: number;
      right: number;
      bottom: number;
    }>;
  }>;
  // Decorations added by openclaw's clawcam_fanout.js transform before
  // forwarding to clawcam-app — vision-model output ridden along.
  vision_caption?: string;
  vision_interest_level?: number;
  vision_suggested_action?: string;
}

// PTZ request used by /api/devices/:host/ptz.
export interface PtzRequest {
  pan?: number;
  tilt?: number;
  zoom?: number;
  home?: boolean;
  stop?: boolean;
  duration_ms?: number;
}
