import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { buildRouter } from "./api.js";
import { sseHandler } from "./sse.js";
import { pruneOldEvents } from "./ingest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use((req, _res, next) => {
  const t = Date.now();
  const done = () => console.log(`${req.method} ${req.url} -> ${Date.now() - t}ms`);
  req.on("end", done);
  next();
});

app.get("/api/stream", sseHandler);
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

app.listen(config.port, config.host, () => {
  console.log(`clawcam-app listening on http://${config.host}:${config.port}`);
  console.log(`data dir: ${config.dataDir}`);
  console.log(`retention: ${config.retentionDays}d`);
  console.log(`auth token: ${config.token ? "configured" : "DISABLED (open)"}`);
});

setInterval(() => {
  try {
    const n = pruneOldEvents();
    if (n) console.log(`pruned ${n} old events`);
  } catch (e) {
    console.error("prune error", e);
  }
}, 3600 * 1000).unref();
