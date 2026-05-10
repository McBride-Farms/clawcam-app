import type { Request, Response } from "express";

interface Client {
  res: Response;
}

const clients: Set<Client> = new Set();

export function sseHandler(req: Request, res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 5000\n\n`);
  const client: Client = { res };
  clients.add(client);
  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch {}
  }, 15000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

export function broadcast(eventName: string, data: unknown): void {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  const frame = `event: ${eventName}\ndata: ${payload}\n\n`;
  for (const c of clients) {
    try { c.res.write(frame); } catch {}
  }
}

// Expose globally so api.ts can publish telemetry without a circular import
// (api uses sse via this single global at handler-time, not at import-time).
declare global {
  // eslint-disable-next-line no-var
  var __clawcamAppSse: { broadcast: typeof broadcast } | undefined;
}
globalThis.__clawcamAppSse = { broadcast };
