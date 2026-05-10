import express, { type Request, type Response, type NextFunction, type Router } from "express";
import path from "node:path";
import fs from "node:fs";
import { createConnection } from "node:net";
import { config } from "./config.js";
import { stmts } from "./db.js";
import { ingestEvent } from "./ingest.js";
import type { Device, EventPhase, EventRow } from "../shared/types.js";

const PTZ_PORT = 8091;
const HOST_RE = /^[0-9a-zA-Z.:-]+$/;

function probePtz(host: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (!done) { done = true; resolve(ok); }
    };
    const sock = createConnection({ host, port: PTZ_PORT }, () => {
      sock.destroy();
      finish(true);
    });
    sock.on("error", () => finish(false));
    sock.setTimeout(timeoutMs, () => { sock.destroy(); finish(false); });
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.token) return next();
  if (presentedToken(req) !== config.token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  return next();
}

function presentedToken(req: Request): string {
  const h = (req.headers.authorization as string | undefined) || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  const cookie = (req.headers.cookie as string | undefined) || "";
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

function requireHookAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.token) return next();
  const h = (req.headers.authorization as string | undefined) || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (tok !== config.token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  return next();
}

function registeredDevice(host: string): Device | null {
  if (!HOST_RE.test(host)) return null;
  const rows = stmts.listDevices.all() as Device[];
  return rows.find((d) => d.host === host || d.name === host) || null;
}

// mediamtx /v3/paths/list — only the fields we actually consume here.
interface MediamtxPath {
  name: string;
  ready?: boolean;
  readyTime?: string;
  tracks?: string[];
  bytesReceived?: number;
  source?: { type?: string } | null;
}
interface MediamtxPathsList {
  items?: MediamtxPath[];
}

export function buildRouter(): Router {
  const r = express.Router();

  r.get("/api/health", (_req, res) => {
    res.json({ ok: true, version: "0.1.0", time: Date.now() });
  });

  r.get("/api/config", (req, res) => {
    const host = req.headers.host?.split(":")[0] || "localhost";
    const defaultHls = `http://${host}:8888`;
    const defaultWrtc = `http://${host}:8889`;
    const defaultRtsp = `rtsp://${host}:8554`;
    // Absolute URL pattern for the ABR master playlist served by this
    // server. Clients substitute {name} with the camera path. When the
    // ladder has no live variants, the endpoint returns 503 — clients
    // are expected to fall back to `<hls_base>/<name>/index.m3u8`.
    const hlsMasterTemplate =
      `${req.protocol}://${req.headers.host}/api/streams/{name}/master.m3u8`;
    res.json({
      hls_base: config.hlsBase || defaultHls,
      hls_master_url_template: hlsMasterTemplate,
      webrtc_base: config.webrtcBase || defaultWrtc,
      rtsp_base: config.rtspBase || defaultRtsp,
      webhook_url:
        config.webhookUrl ||
        `${req.protocol}://${req.headers.host}/hooks/clawcam`,
    });
  });

  // ABR master playlist for a source path. Discovers live ladder variants
  // (`<source>_1080|720|480|360`) via mediamtx's API, extracts each variant's
  // STREAM-INF line + media URI from its single-rendition index.m3u8, and
  // composes them into one master playlist for HLS.js / ExoPlayer to switch
  // between. Returns 503 if no variants are live; the player should fall
  // back to the single-rendition `<source>/index.m3u8` in that case.
  r.get("/api/streams/:source/master.m3u8", async (req, res) => {
    const source = req.params.source;
    if (!HOST_RE.test(source)) return res.status(400).end();

    const ladderRungs = ["1080", "720", "480", "360"];
    const live = new Set<string>();
    try {
      const upstream = await fetch(`${config.mediamtxApi}/v3/paths/list`, {
        signal: AbortSignal.timeout(2000),
      });
      if (upstream.ok) {
        const data = (await upstream.json()) as MediamtxPathsList;
        for (const p of data.items || []) {
          if (p.ready) live.add(p.name);
        }
      }
    } catch {
      // mediamtx unreachable — fall through; we'll return 503 if no rungs.
    }

    const hlsBase =
      config.hlsBase ||
      `${req.protocol}://${req.headers.host?.split(":")[0] || "localhost"}`;

    const lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-INDEPENDENT-SEGMENTS"];
    for (const rung of ladderRungs) {
      const variantPath = `${source}_${rung}`;
      if (!live.has(variantPath)) continue;
      try {
        const indexUrl = `${hlsBase}/${variantPath}/index.m3u8`;
        const r2 = await fetch(indexUrl, { signal: AbortSignal.timeout(2000) });
        if (!r2.ok) continue;
        const text = await r2.text();
        // Each variant index.m3u8 from mediamtx looks like:
        //   #EXTM3U
        //   #EXT-X-VERSION:9
        //   #EXT-X-INDEPENDENT-SEGMENTS
        //
        //   #EXT-X-STREAM-INF:BANDWIDTH=...,RESOLUTION=...,CODECS=...
        //   video1_stream.m3u8
        const sm = text.match(/#EXT-X-STREAM-INF:[^\n]+\r?\n([^\r\n]+)/);
        if (!sm) continue;
        const streamInf = sm[0].split(/\r?\n/)[0];
        const uri = sm[1].trim();
        const absoluteUri = uri.startsWith("http")
          ? uri
          : `${hlsBase}/${variantPath}/${uri}`;
        lines.push("", streamInf, absoluteUri);
      } catch {
        // Variant fetch failed — skip this rung; others may still work.
      }
    }

    if (lines.length <= 3) {
      return res.status(503).json({ error: "no ABR variants available" });
    }

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(lines.join("\n") + "\n");
  });

  r.get("/api/streams", requireAuth, async (_req, res) => {
    try {
      const upstream = await fetch(`${config.mediamtxApi}/v3/paths/list`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: "mediamtx", status: upstream.status });
        return;
      }
      const data = (await upstream.json()) as MediamtxPathsList;
      const items = (data.items || []).map((p) => ({
        name: p.name,
        ready: !!p.ready,
        ready_since: p.readyTime ?? null,
        tracks: p.tracks || [],
        bytes_received: p.bytesReceived || 0,
        source_type: p.source?.type || null,
      }));
      res.json({ streams: items });
    } catch (e) {
      res.status(502).json({ error: String((e as Error).message || e) });
    }
  });

  r.get("/api/devices", requireAuth, async (_req, res) => {
    const devices = stmts.listDevices.all() as Device[];
    const probes = await Promise.all(devices.map((d) => probePtz(d.host)));
    devices.forEach((d, i) => { d.has_ptz = probes[i]; });
    res.json({ devices });
  });

  r.post("/api/devices", requireAuth, express.json(), (req, res) => {
    const { host, name } = (req.body ?? {}) as { host?: string; name?: string };
    if (!host || typeof host !== "string") {
      res.status(400).json({ error: "host required" });
      return;
    }
    if (!HOST_RE.test(host)) {
      res.status(400).json({ error: "bad host" });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    stmts.registerDevice.run({ host, name: name || null, now });
    res.json({ ok: true });
  });

  // Single-device fetch — used by the OpenClaw fanout transform to read the
  // per-camera system_prompt before issuing a vision call. Public read
  // (auth was already dropped repo-wide for /api/* in commit 794e366).
  r.get("/api/devices/:host", requireAuth, (req, res) => {
    const host = req.params.host;
    if (!HOST_RE.test(host)) {
      res.status(400).json({ error: "bad host" });
      return;
    }
    const dev = stmts.getDevice.get(host) as Device | undefined;
    if (!dev) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ device: dev });
  });

  // Edit a device's per-camera vision prompt. Accepts an empty string or null
  // to clear (which falls the transform back to the generic prompt).
  r.patch("/api/devices/:host", requireAuth, express.json(), (req, res) => {
    const host = req.params.host;
    if (!HOST_RE.test(host)) {
      res.status(400).json({ error: "bad host" });
      return;
    }
    const dev = stmts.getDevice.get(host) as Device | undefined;
    if (!dev) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const body = (req.body ?? {}) as { system_prompt?: unknown };
    if (Object.prototype.hasOwnProperty.call(body, "system_prompt")) {
      const raw = body.system_prompt;
      const value: string | null =
        typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 4000) : null;
      stmts.setDeviceSystemPrompt.run({ host, system_prompt: value });
    }
    res.json({ device: stmts.getDevice.get(host) });
  });

  r.get("/api/events", requireAuth, (req, res) => {
    const host = req.query.host ? String(req.query.host) : null;
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
    const offset = parseInt(String(req.query.offset ?? "0"), 10);
    const sinceHours = parseInt(String(req.query.since_hours ?? "168"), 10);
    const since = Math.floor(Date.now() / 1000) - sinceHours * 3600;
    const rows = stmts.listEvents.all({ host, limit, offset, since }) as EventRow[];
    res.json({ events: rows, limit, offset });
  });

  interface RawPhase { phase: string; detail: string | null; epoch: number; payload: string }

  r.get("/api/events/:id", requireAuth, (req, res) => {
    const ev = stmts.getEvent.get(req.params.id) as EventRow | undefined;
    if (!ev) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const rawPhases = stmts.phasesForEvent.all(ev.event_id) as RawPhase[];
    const phases: EventPhase[] = rawPhases.map((p) => ({
      phase: p.phase,
      detail: p.detail,
      epoch: p.epoch,
      payload: safeJson(p.payload),
    }));
    res.json({ event: ev, phases });
  });

  r.post("/api/devices/:host/ptz", requireAuth, express.json(), async (req, res) => {
    const host = req.params.host;
    const dev = registeredDevice(host);
    if (!dev) {
      res.status(404).json({ error: "device not registered" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const payload = {
      pan: Number(body.pan) || 0,
      tilt: Number(body.tilt) || 0,
      zoom: Number(body.zoom) || 0,
      home: !!body.home,
      stop: !!body.stop,
      duration_ms: Number.isFinite(Number(body.duration_ms))
        ? Number(body.duration_ms)
        : 300,
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
      res.status(502).json({ error: String((e as Error).message || e).slice(0, 400) });
    }
  });

  r.get("/media/:file", requireAuth, (req, res) => {
    const name = req.params.file;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      res.status(400).end();
      return;
    }
    const full = path.join(config.mediaDir, name);
    if (!fs.existsSync(full)) {
      res.status(404).end();
      return;
    }
    const ext = path.extname(name).toLowerCase();
    const type =
      ext === ".jpg" ? "image/jpeg" : ext === ".mp4" ? "video/mp4" : "application/octet-stream";
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "public, max-age=86400");
    fs.createReadStream(full).pipe(res);
  });

  r.post("/telemetry/clawcam", requireHookAuth, express.json({ limit: "512kb" }), (req, res) => {
    // Broadcast without persisting — telemetry is ephemeral.
    const broadcast = globalThis.__clawcamAppSse?.broadcast;
    if (broadcast) broadcast("telemetry", req.body ?? {});
    res.json({ ok: true });
  });

  r.post("/hooks/clawcam", requireHookAuth, express.json({ limit: `${config.maxPayloadMb}mb` }), (req, res) => {
    try {
      const result = ingestEvent(req.body);
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error("ingest error:", e);
      res.status(400).json({ error: String((e as Error).message || e) });
    }
  });

  return r;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
