import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const candidateEnvFiles = [
  process.env.CLAWCAM_APP_ENV_FILE,
  path.join(process.cwd(), ".env"),
  "/etc/clawcam-app.env",
].filter(Boolean);

for (const envFile of candidateEnvFiles) {
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
    break;
  }
}

// Prefer CLAWCAM_APP_*; fall back to the legacy CLAWHUB_* names so existing
// deployments keep working until operators migrate their env files.
const env = (k, legacy) =>
  process.env[k] ?? (legacy ? process.env[legacy] : undefined);

const dataDir =
  env("CLAWCAM_APP_DATA_DIR", "CLAWHUB_DATA_DIR") ||
  path.join(os.homedir(), "clawcam-app", "data");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, "media"), { recursive: true });

export const config = {
  host: env("CLAWCAM_APP_HOST", "CLAWHUB_HOST") || "0.0.0.0",
  port: parseInt(env("CLAWCAM_APP_PORT", "CLAWHUB_PORT") || "8080", 10),
  token: env("CLAWCAM_APP_TOKEN", "CLAWHUB_TOKEN") || "",
  dataDir,
  mediaDir: path.join(dataDir, "media"),
  dbPath: path.join(dataDir, "clawcam-app.db"),
  retentionDays: parseInt(
    env("CLAWCAM_APP_RETENTION_DAYS", "CLAWHUB_RETENTION_DAYS") || "14", 10),
  maxPayloadMb: parseInt(
    env("CLAWCAM_APP_MAX_PAYLOAD_MB", "CLAWHUB_MAX_PAYLOAD_MB") || "64", 10),
  mediamtxApi:
    env("CLAWCAM_APP_MEDIAMTX_API", "CLAWHUB_MEDIAMTX_API") ||
    "http://127.0.0.1:9997",
  hlsBase: env("CLAWCAM_APP_HLS_BASE", "CLAWHUB_HLS_BASE") || "",
  webrtcBase: env("CLAWCAM_APP_WEBRTC_BASE", "CLAWHUB_WEBRTC_BASE") || "",
  rtspBase: env("CLAWCAM_APP_RTSP_BASE", "CLAWHUB_RTSP_BASE") || "",
};
