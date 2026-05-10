import express, { type Request, type Response } from "express";
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

// Web bundle: prefer the new Astro+Solid build at server/web/dist; fall
// back to the legacy server/public/ if the new bundle hasn't been built
// yet (e.g. a partial rebuild). Once migration lands, the fallback can
// be removed and server/public/ deleted.
const webDir = (() => {
  const astroDist = path.resolve(__dirname, "..", "web", "dist");
  if (fs.existsSync(path.join(astroDist, "index.html"))) return astroDist;
  return path.resolve(__dirname, "..", "public");
})();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use((req, _res, next) => {
  const t = Date.now();
  const done = (): void => {
    console.log(`${req.method} ${redactUrl(req.url)} -> ${Date.now() - t}ms`);
  };
  req.on("end", done);
  next();
});

app.get("/api/stream", requireAuth, sseHandler);
app.use(buildRouter());

app.get("/", (_req, res) => res.redirect("/live"));

app.use(
  express.static(webDir, {
    fallthrough: true,
    index: "index.html",
    setHeaders: (res, p) => {
      if (p.endsWith(".html") || p.endsWith(".js") || p.endsWith(".css")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

// Astro file-based routing produces /events.html, /devices.html, etc.
// When the browser navigates to /events the URL has no extension; map it
// to the matching .html so static files line up with Astro's routes.
app.get(/^\/[a-z][a-z0-9_-]*$/, (req: Request, res: Response, next) => {
  const file = path.join(webDir, `${req.path.slice(1)}.html`);
  fs.access(file, fs.constants.R_OK, (err) => {
    if (err) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(file);
  });
});

app.get("*", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(webDir, "index.html"));
});

const tlsCreds = config.tlsCertDir
  ? (() => {
      try {
        return {
          key: fs.readFileSync(path.join(config.tlsCertDir, "key.pem")),
          cert: fs.readFileSync(path.join(config.tlsCertDir, "fullchain.pem")),
        };
      } catch (err) {
        console.error(
          `[tls] cert dir ${config.tlsCertDir} unreadable, falling back to HTTP: ${
            (err as Error).message
          }`,
        );
        return null;
      }
    })()
  : null;

if (tlsCreds) {
  https.createServer(tlsCreds, app).listen(config.tlsPort, config.host, () => {
    console.log(`clawcam-app HTTPS on ${config.host}:${config.tlsPort}`);
  });
  const redirect = express();
  redirect.use((req, res) => {
    const host = ((req.headers.host as string | undefined) || "").split(":")[0] || "localhost";
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
console.log(`web bundle: ${webDir}`);
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

function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]+/i, "$1[redacted]");
}
