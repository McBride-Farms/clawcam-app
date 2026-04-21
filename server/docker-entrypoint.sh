#!/bin/bash
set -e

# Claim a LAN lease via DHCP, advertising our container hostname so
# pfSense records MAC → hostname → IP and unbound publishes the DNS
# name automatically via kea2unbound.
#
# We run this at container start because, with macvlan + null IPAM,
# Docker attaches the interface but doesn't configure it. If dhclient
# can't get a lease in ~15s we fall through so the process manager at
# least sees the app start and keeps restarting rather than hanging.
iface=${LAN_IFACE:-eth0}
if ip link show "$iface" >/dev/null 2>&1; then
  ip link set "$iface" up
  # Docker's macvlan IPAM put a placeholder address on the interface. Flush
  # it so dhclient starts from a clean slate and the real pfSense-issued
  # lease is the only address configured.
  ip -4 addr flush dev "$iface"

  # ISC dhclient doesn't take a hostname CLI flag — option 12 goes in the
  # config file. Writing the container's hostname tells pfSense what to
  # record, so kea2unbound can resolve <hostname>.mcbridefarm.com.
  mkdir -p /etc/dhcp
  cat > /etc/dhcp/dhclient.conf <<EOF
send host-name "$(hostname)";
send dhcp-client-identifier = hardware;
EOF

  timeout 20 dhclient -v "$iface" || \
    echo "docker-entrypoint: dhclient failed, continuing without lease" >&2
fi

exec "$@"
