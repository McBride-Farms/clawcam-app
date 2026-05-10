# Multi-stage build:
#   1. astro-build  — builds server/web/ (Astro+Solid+TypeScript) into web/dist/
#   2. server-build — compiles server/src/*.ts (TypeScript) into dist/
#   3. runtime      — installs only prod deps + the build artifacts above
#
# isc-dhcp-client is needed in the runtime image so the container can
# request its own LAN lease with --hostname at startup. With macvlan +
# null IPAM the container has no IP until dhclient runs and pfSense
# answers, so without these tools the entrypoint would deadlock.

# ---- Stage 1: build the Astro+Solid frontend ----
FROM node:22-slim AS astro-build
WORKDIR /web
COPY web/package*.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
COPY shared/ /shared/
RUN npm run build

# ---- Stage 2: compile the TypeScript Express server ----
FROM node:22-slim AS server-build
WORKDIR /server
COPY package*.json tsconfig.json ./
COPY src/ ./src/
COPY shared/ ./shared/
RUN npm install --no-audit --no-fund
RUN npm run build

# ---- Stage 3: runtime ----
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends isc-dhcp-client iproute2 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Prod deps only — devDeps (typescript, @types/*) aren't needed at runtime.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Compiled server (server-build stage) and built frontend (astro-build).
COPY --from=server-build /server/dist ./dist
COPY --from=astro-build  /web/dist ./web/dist

COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Listen on :80 inside the container; each container has its own IP so
# the host's privileged-port restriction doesn't matter — we run as root.
ENV CLAWCAM_APP_HOST=0.0.0.0
ENV CLAWCAM_APP_PORT=80
ENV CLAWCAM_APP_DATA_DIR=/app/data
EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
