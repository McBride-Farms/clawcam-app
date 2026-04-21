#!/usr/bin/env bash
set -euo pipefail

REMOTE=${REMOTE:?set REMOTE=user@host}
REMOTE_DIR=${REMOTE_DIR:-/home/grunt/clawcam-app}
TOKEN=${CLAWCAM_APP_TOKEN:-}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> rsync server → ${REMOTE}:${REMOTE_DIR}"
ssh "$REMOTE" "mkdir -p ${REMOTE_DIR}/server ${REMOTE_DIR}/data/media ~/.config/systemd/user"
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .env \
  "${SCRIPT_DIR}/" "${REMOTE}:${REMOTE_DIR}/server/"

echo "==> writing ${REMOTE_DIR}/server/.env"
ssh "$REMOTE" "cat > ${REMOTE_DIR}/server/.env && chmod 600 ${REMOTE_DIR}/server/.env" <<EOF
CLAWCAM_APP_DATA_DIR=${REMOTE_DIR}/data
${TOKEN:+CLAWCAM_APP_TOKEN=$TOKEN}
EOF

echo "==> installing npm deps"
ssh "$REMOTE" "bash -lc 'cd ${REMOTE_DIR}/server && . \$HOME/.nvm/nvm.sh && nvm use 22 && npm install --omit=dev'"

echo "==> installing user systemd unit"
ssh "$REMOTE" "install -m 0644 ${REMOTE_DIR}/server/systemd/clawcam-app.service ~/.config/systemd/user/clawcam-app.service && systemctl --user daemon-reload && systemctl --user enable --now clawcam-app"

echo "==> enabling lingering so service runs after logout (best-effort; requires sudo)"
ssh "$REMOTE" "loginctl enable-linger grunt 2>/dev/null || echo 'lingering not enabled — run sudo loginctl enable-linger grunt later'"

sleep 1
echo "==> checking status"
ssh "$REMOTE" "systemctl --user is-active clawcam-app && curl -fsS http://127.0.0.1:8080/api/health && echo"
echo "clawcam deployed. Open http://${REMOTE#*@}:8080/"
