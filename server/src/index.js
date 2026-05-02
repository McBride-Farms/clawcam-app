import express from "express";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { buildRouter, requireAuth } from "./api.js";
import { sseHandler } from "./sse.js";
import { pruneOldEvents, reapStaleEvents } from "./ingest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use((req, _res, next) => {
  const t = Date.now();
  const done = () => console.log(`${req.method} ${redactUrl(req.url)} -> ${Date.now() - t}ms`);
  req.on("end", done);
  next();
});

app.get("/api/stream", requireAuth, sseHandler);
app.use(buildRouter());
app.use(
  express.static(publicDir, {
    fallthrough: true,
    index: "index.html",
    setHeaders: (res, p) => {
      if (p.endsWith(".html") || p.endsWith(".js") || p.endsWith(".css")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  })
);
app.get("*", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(publicDir, "index.html"));
});

const tlsCreds = config.tlsCertDir && (() => {
  try {
    return {
      key: fs.readFileSync(path.join(config.tlsCertDir, "key.pem")),
      cert: fs.readFileSync(path.join(config.tlsCertDir, "fullchain.pem")),
    };
  } catch (err) {
    console.error(`[tls] cert dir ${config.tlsCertDir} unreadable, falling back to HTTP: ${err.message}`);
    return null;
  }
})();

if (tlsCreds) {
  https.createServer(tlsCreds, app).listen(config.tlsPort, config.host, () => {
    console.log(`clawcam-app HTTPS on ${config.host}:${config.tlsPort}`);
  });
  const redirect = express();
  redirect.use((req, res) => {
    const host = (req.headers.host || "").split(":")[0] || "localhost";
    res.redirect(301, `https://${host}${req.url}`);
  });
  http.createServer(redirect).listen(config.port, config.host, () => {
    console.log(`clawcam-app HTTP→HTTPS redirect on ${config.host}:${config.port}`);
  });
} else {
  app.listen(config.port, config.host, () => {
    console.log(`clawcam-app HTTP on ${config.host}:${config.port}`);
  });
}
console.log(`data dir: ${config.dataDir}`);
console.log(`retention: ${config.retentionDays}d`);
console.log(`auth token: ${config.token ? "configured" : "DISABLED (open)"}`);

setInterval(() => {
  try {
    const n = pruneOldEvents();
    if (n) console.log(`pruned ${n} old events`);
  } catch (e) {
    console.error("prune error", e);
  }
}, 3600 * 1000).unref();

setInterval(() => {
  try {
    const n = reapStaleEvents(300);
    if (n) console.log(`reaped ${n} stale active events`);
  } catch (e) {
    console.error("reap error", e);
  }
}, 60 * 1000).unref();

function redactUrl(url) {
  return url.replace(/([?&]token=)[^&]+/i, "$1[redacted]");
}
