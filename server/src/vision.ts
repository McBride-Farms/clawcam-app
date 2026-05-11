// Vision pipeline. Posts an event's snapshot to the configured vision model
// (Qwen3.5 vision on grunt-node2 by default) and gets back a structured
// observation that the UI displays as the per-event "AI description".
//
// Ported from openclaw's hooks/transforms/clawcam_fanout.js. The previous
// architecture had openclaw call this and ride the result along to clawcam-app
// via a fan-out webhook; we now call it directly from clawcam-app's ingest so
// captions land even when openclaw is offline.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const VISION_URL =
  process.env.CLAWCAM_APP_VISION_URL ||
  "http://grunt-node2.mcbridefarm.com:8080/v1/chat/completions";
// Default 20s — Qwen3.5-2B-vision on grunt-node2 CPU encodes a 360px frame
// in ~4–10s depending on load, occasionally up to ~15s on cold cache. The
// previous default of 8s was timing out enough real events to make the
// caption look broken. Override via CLAWCAM_APP_VISION_TIMEOUT_MS for
// faster GPUs or higher patience.
const VISION_TIMEOUT_MS = Number(process.env.CLAWCAM_APP_VISION_TIMEOUT_MS) || 20000;
const VISION_DISABLED = process.env.CLAWCAM_APP_VISION_DISABLE === "1";

// We ask the model for structured JSON (instead of free text) so downstream
// consumers (UI, Android notifications, agent wakers) can route by field
// rather than parse prose. Works on any vision model; smaller models fill
// fields sparsely, stronger models fill them well.
const VISION_SCHEMA = {
  type: "object",
  properties: {
    caption: { type: "string", minLength: 30, maxLength: 280 },
    interest_level: { type: "integer", minimum: 0, maximum: 3 },
    suggested_action: { type: "string", enum: ["none", "investigate", "alert"] },
  },
  required: ["caption", "interest_level", "suggested_action"],
  additionalProperties: false,
} as const;

const VISION_PROMPT_TEXT =
  "Describe what you see in this wildlife/security camera frame. Respond with a JSON object using this schema:\n" +
  "- caption: one concrete sentence (about 15-30 words) describing what is visible — animals, people, vehicles, " +
  "and the lighting condition (whether it looks like full daylight, dusk, night, or infrared). Do not return a " +
  "single word; write a full sentence.\n" +
  "- interest_level: integer 0..3. 0 means routine (empty scene, foliage moving in wind, normal weather). " +
  "1 means expected presence (the owner, familiar pets, normal daytime activity). 2 means unusual or worth a " +
  "second look (unfamiliar wildlife, partially obscured figure, human after hours). 3 means clear concern " +
  "(intruder, distressed animal, fire, vehicle in a restricted area).\n" +
  "- suggested_action: \"none\" if routine, \"investigate\" if a closer pan/zoom would clarify what's there, " +
  "\"alert\" if the user should see this immediately.";

export interface VisionObservation {
  caption: string;
  interest_level: number | null;
  suggested_action: string | null;
}

// Resize the saved JPEG down to 360px (longest side) so the model's vision
// encoder runs in ~4 s instead of ~13 s for full-res 1080p. Returns the
// temp-file path on success, null if ffmpeg isn't available or failed.
function resizeForVision(srcPath: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const tmp = path.join(
      os.tmpdir(),
      `clawcam-vision-${Date.now()}-${process.pid}.jpg`,
    );
    execFile(
      "ffmpeg",
      [
        "-y", "-loglevel", "error",
        "-i", srcPath,
        "-vf", "scale=360:360:force_original_aspect_ratio=decrease",
        "-q:v", "5",
        tmp,
      ],
      { timeout: 4000 },
      (err) => {
        if (err) {
          try { fs.unlinkSync(tmp); } catch {}
          resolve(null);
        } else {
          resolve(tmp);
        }
      },
    );
  });
}

interface VllmChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface ParsedObservation {
  caption?: unknown;
  interest_level?: unknown;
  suggested_action?: unknown;
}

// Run the vision call against an on-disk JPEG. Returns the parsed observation
// or null on any failure — callers should treat null as "no caption" and
// leave the existing event row untouched.
export async function qwenVisionObservation(
  imagePath: string,
  hostHint: string | null,
  systemPrompt: string | null,
): Promise<VisionObservation | null> {
  if (VISION_DISABLED || !imagePath) return null;
  const resized = await resizeForVision(imagePath);
  const useFile = resized ?? imagePath; // fall back to full-res if ffmpeg missing
  let b64: string;
  try {
    b64 = fs.readFileSync(useFile, { encoding: "base64" });
  } catch {
    if (resized) try { fs.unlinkSync(resized); } catch {}
    return null;
  }

  const messages: Array<unknown> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text:
          VISION_PROMPT_TEXT + (hostHint ? ` Camera host: ${hostHint}.` : ""),
      },
      {
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${b64}` },
      },
    ],
  });

  const body = JSON.stringify({
    model: "qwen",
    max_tokens: 240,
    temperature: 0.2,
    // Qwen3-family thinking-mode would burn the token budget on internal
    // reasoning; harmless on non-Qwen3 models (unknown kwargs ignored).
    chat_template_kwargs: { enable_thinking: false },
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "vision_observation",
        strict: true,
        schema: VISION_SCHEMA,
      },
    },
    messages,
  });

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), VISION_TIMEOUT_MS);
    const resp = await fetch(VISION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const j = (await resp.json()) as VllmChatResponse;
    const text = (j.choices?.[0]?.message?.content || "").trim();
    if (!text) return null;
    let parsed: ParsedObservation;
    try {
      parsed = JSON.parse(text) as ParsedObservation;
    } catch {
      return null;
    }
    const caption =
      typeof parsed.caption === "string"
        ? parsed.caption.replace(/\s+/g, " ").trim().slice(0, 280)
        : "";
    if (!caption) return null;
    const interestLevel = Number.isInteger(parsed.interest_level)
      ? Math.max(0, Math.min(3, parsed.interest_level as number))
      : null;
    const suggestedAction =
      typeof parsed.suggested_action === "string" &&
      ["none", "investigate", "alert"].includes(parsed.suggested_action)
        ? parsed.suggested_action
        : null;
    return {
      caption,
      interest_level: interestLevel,
      suggested_action: suggestedAction,
    };
  } catch {
    return null;
  } finally {
    if (resized) try { fs.unlinkSync(resized); } catch {}
  }
}
