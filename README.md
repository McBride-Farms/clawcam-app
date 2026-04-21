# clawcam-app

Companion server + web UI for [clawcam](https://github.com/grunt3714-lgtm/clawcam).

- Event ingest and archive (webhook compatible with clawcam)
- Live video via RTSP → HLS (MediaMTX relay), per-frame bounding-box overlays on clips
- PTZ / VISCA control proxy to motorized conference cameras

## Architecture

```
Raspberry Pi + clawcam
  ├─ webhook POST     ──▶  clawcam-app  :8080   (ingest, UI, API, SSE, PTZ proxy)
  └─ RTSP publish     ──▶  MediaMTX    :8554   (HLS :8888, WebRTC :8889)
                                  ▲
                                  │
                             browser
```

## Deploy

```sh
cd server
CLAWCAM_APP_TOKEN=$(openssl rand -hex 24) bash deploy.sh       # target: <user>@<host>
```

MediaMTX runs as a user systemd service on the same host. Install notes: see `deploy-mediamtx.md`.

## Point a Pi at clawcam-app

On the Pi, `/etc/clawcam.env`:

```
CLAWCAM_WEBHOOK=http://<host>:8080/hooks/clawcam
CLAWCAM_WEBHOOK_TOKEN=<your token>
CLAWCAM_CAMERA_SOURCE=libcamerasrc
CLAWCAM_STREAM_URL=rtsp://<host>:8554/<cam-name>
CLAWCAM_STREAM_WIDTH=1280
CLAWCAM_STREAM_HEIGHT=720
CLAWCAM_STREAM_FPS=20
```

Then `sudo systemctl restart clawcam`.

