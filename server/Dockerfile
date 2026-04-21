FROM node:22-slim

# isc-dhcp-client so the container can request its own LAN lease with
# --hostname at startup. Once inside a macvlan network with null IPAM,
# the container has no IP until dhclient runs and pfSense answers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends isc-dhcp-client iproute2 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Listen on :80 inside the container; each container has its own IP so
# the host's privileged-port restriction doesn't matter — we run as root.
ENV CLAWCAM_APP_HOST=0.0.0.0
ENV CLAWCAM_APP_PORT=80
ENV CLAWCAM_APP_DATA_DIR=/app/data
EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/index.js"]
