import express from "express";
import path from "node:path";
import fs from "node:fs";
import { createConnection } from "node:net";
import { config } from "./config.js";
import { stmts } from "./db.js";
import { ingestEvent } from "./ingest.js";

const PTZ_PORT = 8091;
const HOST_RE = /^[0-9a-zA-Z.:-]+$/;

function probePtz(host, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    const sock = createConnection({ host, port: PTZ_PORT }, () => {
      sock.destroy();
      finish(true);
    });
    sock.on("error", () => finish(false));
    sock.setTimeout(timeoutMs, () => { sock.destroy(); finish(false); });
  });
}

export function requireAuth(req, res, next) {
  if (!config.token) return next();
  if (presentedToken(req) !== config.token) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return next();
}

function presentedToken(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  const cookie = req.headers.cookie || "";
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "clawcam_token") {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return "";
      }
    }
  }
  return typeof req.query?.token === "string" ? req.query.token : "";
}

function requireHookAuth(req, res, next) {
  if (!config.token) return next();
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (tok !== config.token) return res.status(401).json({ error: "unauthorized" });
  return next();
}

function registeredDevice(host) {
  if (!HOST_RE.test(host)) return null;
  return stmts.listDevices.all().find((d) => d.host === host || d.name === host) || null;
}

export function buildRouter() {
  const r = express.Router();

  r.get("/api/health", (_req, res) => {
    res.json({ ok: true, version: "0.1.0", time: Date.now() });
  });

  r.get("/api/config", (req, res) => {
    const host = req.headers.host?.split(":")[0] || "localhost";
    const defaultHls = `http://${host}:8888`;
    const defaultWrtc = `http://${host}:8889`;
    const defaultRtsp = `rtsp://${host}:8554`;
    res.json({
      hls_base: config.hlsBase || defaultHls,
      webrtc_base: config.webrtcBase || defaultWrtc,
      rtsp_base: config.rtspBase || defaultRtsp,
      webhook_url:
        config.webhookUrl ||
        `${req.protocol}://${req.headers.host}/hooks/clawcam`,
    });
  });

  r.get("/api/streams", requireAuth, async (_req, res) => {
    try {
      const upstream = await fetch(`${config.mediamtxApi}/v3/paths/list`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!upstream.ok) return res.status(upstream.status).json({ error: "mediamtx", status: upstream.status });
      const data = await upstream.json();
      const items = (data.items || []).map((p) => ({
        name: p.name,
        ready: !!p.ready,
        ready_since: p.readyTime,
        tracks: p.tracks || [],
        bytes_received: p.bytesReceived || 0,
        source_type: p.source?.type || null,
      }));
      res.json({ streams: items });
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  r.get("/api/devices", requireAuth, async (_req, res) => {
    const devices = stmts.listDevices.all();
    const probes = await Promise.all(devices.map((d) => probePtz(d.host)));
    devices.forEach((d, i) => { d.has_ptz = probes[i]; });
    res.json({ devices });
  });

  r.post("/api/devices", requireAuth, express.json(), (req, res) => {
    const { host, name } = req.body || {};
    if (!host || typeof host !== "string") return res.status(400).json({ error: "host required" });
    if (!HOST_RE.test(host)) return res.status(400).json({ error: "bad host" });
    const now = Math.floor(Date.now() / 1000);
    stmts.registerDevice.run({ host, name: name || null, now });
    res.json({ ok: true });
  });

  r.get("/api/events", requireAuth, (req, res) => {
    const host = req.query.host ? String(req.query.host) : null;
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const offset = parseInt(req.query.offset || "0", 10);
    const sinceHours = parseInt(req.query.since_hours || "168", 10);
    const since = Math.floor(Date.now() / 1000) - sinceHours * 3600;
    const rows = stmts.listEvents.all({ host, limit, offset, since });
    res.json({ events: rows, limit, offset });
  });

  r.get("/api/events/:id", requireAuth, (req, res) => {
    const ev = stmts.getEvent.get(req.params.id);
    if (!ev) return res.status(404).json({ error: "not_found" });
    const phases = stmts.phasesForEvent.all(ev.event_id).map((p) => ({
      phase: p.phase,
      detail: p.detail,
      epoch: p.epoch,
      payload: safeJson(p.payload),
    }));
    res.json({ event: ev, phases });
  });

  r.get("/api/devices/:host/latest.jpg", requireAuth, async (req, res) => {
    const host = req.params.host;
    const dev = registeredDevice(host);
    if (!dev) return res.status(404).json({ error: "device not registered" });
    const port = parseInt(req.query.port || "8090", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: "bad port" });
    }
    try {
      const upstream = await fetch(`http://${dev.host}:${port}/latest.jpg`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!upstream.ok) return res.status(upstream.status).end();
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  r.post("/api/devices/:host/ptz", requireAuth, express.json(), async (req, res) => {
    const host = req.params.host;
    const dev = registeredDevice(host);
    if (!dev) return res.status(404).json({ error: "device not registered" });

    const body = req.body || {};
    const payload = {
      pan: Number(body.pan) || 0,
      tilt: Number(body.tilt) || 0,
      zoom: Number(body.zoom) || 0,
      home: !!body.home,
      stop: !!body.stop,
      duration_ms: Number.isFinite(body.duration_ms) ? body.duration_ms : 300,
    };

    try {
      const upstream = await fetch(`http://${dev.host}:${PTZ_PORT}/ptz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
      res.send(text);
    } catch (e) {
      res.status(502).json({ error: String(e.message || e).slice(0, 400) });
    }
  });

  r.get("/media/:file", requireAuth, (req, res) => {
    const name = req.params.file;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return res.status(400).end();
    const full = path.join(config.mediaDir, name);
    if (!fs.existsSync(full)) return res.status(404).end();
    const ext = path.extname(name).toLowerCase();
    const type =
      ext === ".jpg" ? "image/jpeg" : ext === ".mp4" ? "video/mp4" : "application/octet-stream";
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "public, max-age=86400");
    fs.createReadStream(full).pipe(res);
  });

  r.post("/telemetry/clawcam", requireHookAuth, express.json({ limit: "512kb" }), (req, res) => {
    // Broadcast without persisting — telemetry is ephemeral.
    const { broadcast } = globalThis.__clawcamAppSse || {};
    if (broadcast) broadcast("telemetry", req.body || {});
    res.json({ ok: true });
  });

  r.post("/hooks/clawcam", requireHookAuth, express.json({ limit: `${config.maxPayloadMb}mb` }), (req, res) => {
    try {
      const result = ingestEvent(req.body || {});
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error("ingest error:", e);
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  return r;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
