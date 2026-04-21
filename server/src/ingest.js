import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { db, stmts, upsertDevice } from "./db.js";
import { broadcast } from "./sse.js";

function decodeBase64ToFile(b64, dir, ext) {
  const buf = Buffer.from(b64, "base64");
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
  const full = path.join(dir, name);
  fs.writeFileSync(full, buf);
  return { name, bytes: buf.length };
}

function classesFromPredictions(preds) {
  if (!Array.isArray(preds)) return "";
  return [...new Set(preds.map((p) => p.class))].join(",");
}

function sanitizeForStore(payload) {
  const clone = { ...payload };
  delete clone.image;
  delete clone.clip;
  delete clone.pre_frames;
  return clone;
}

export function ingestEvent(payload) {
  const now = Math.floor(Date.now() / 1000);
  const host = payload.host || "unknown";
  const phase = payload.event_phase || "start";
  const eventId =
    payload.event_id ||
    (phase === "start"
      ? crypto.randomUUID()
      : `legacy-${host}-${payload.epoch || now}`);
  const epoch = payload.epoch || now;

  upsertDevice(host, now);

  const existing = stmts.getEvent.get(eventId);

  let imageFile = existing?.image_file || null;
  let clipFile = existing?.clip_file || null;

  if (payload.image && !imageFile) {
    const { name } = decodeBase64ToFile(payload.image, config.mediaDir, "jpg");
    imageFile = name;
  }
  if (payload.clip) {
    const { name } = decodeBase64ToFile(payload.clip, config.mediaDir, "mp4");
    clipFile = name;
  }

  const preFrames = [];
  if (Array.isArray(payload.pre_frames)) {
    for (const b64 of payload.pre_frames) {
      const { name } = decodeBase64ToFile(b64, config.mediaDir, "jpg");
      preFrames.push(name);
    }
  }

  const detail = payload.detail || "";
  const storedPayload = sanitizeForStore(payload);
  if (preFrames.length) storedPayload.pre_frame_files = preFrames;

  if (!existing) {
    stmts.insertEvent.run({
      event_id: eventId,
      host,
      started_epoch: epoch,
      classes: classesFromPredictions(payload.predictions),
      image_file: imageFile,
      now,
    });
    stmts.bumpDeviceEvents.run(host);
  }

  if (phase === "end") {
    stmts.updateEventEnd.run({
      event_id: eventId,
      ended_epoch: epoch,
      duration_secs: payload.event_duration_secs ?? null,
      clip_file: clipFile,
      now,
    });
  } else {
    stmts.updateEventTouch.run({
      event_id: eventId,
      now,
      duration_secs: payload.event_duration_secs ?? null,
    });
  }

  stmts.insertPhase.run({
    event_id: eventId,
    phase,
    detail,
    epoch,
    payload: JSON.stringify(storedPayload),
  });

  const evRow = stmts.getEvent.get(eventId);
  broadcast("event", {
    ...evRow,
    phase,
    detail,
    predictions: payload.predictions || [],
  });

  return { event_id: eventId, phase };
}

export function pruneOldEvents() {
  const cutoff = Math.floor(Date.now() / 1000) - config.retentionDays * 86400;
  const toDelete = db
    .prepare(`SELECT image_file, clip_file FROM events WHERE started_epoch < ?`)
    .all(cutoff);
  const extra = db
    .prepare(
      `SELECT payload FROM phases WHERE event_id IN (SELECT event_id FROM events WHERE started_epoch < ?)`
    )
    .all(cutoff);
  const res = stmts.deleteOldEvents.run(cutoff);
  for (const row of toDelete) {
    for (const f of [row.image_file, row.clip_file]) {
      if (!f) continue;
      try {
        fs.unlinkSync(path.join(config.mediaDir, f));
      } catch {}
    }
  }
  for (const row of extra) {
    try {
      const p = JSON.parse(row.payload);
      for (const f of p.pre_frame_files || []) {
        try {
          fs.unlinkSync(path.join(config.mediaDir, f));
        } catch {}
      }
    } catch {}
  }
  return res.changes;
}
