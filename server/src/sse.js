const clients = new Set();

export function sseHandler(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 5000\n\n`);
  const client = { res };
  clients.add(client);
  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch {}
  }, 15000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

export function broadcast(eventName, data) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  const frame = `event: ${eventName}\ndata: ${payload}\n\n`;
  for (const c of clients) {
    try { c.res.write(frame); } catch {}
  }
}

// Expose globally so api.js can publish without circular imports.
globalThis.__clawcamAppSse = { broadcast };
