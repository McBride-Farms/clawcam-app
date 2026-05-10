// Shared formatting helpers. `fmtTime` is the same helper that lives at
// the top of the legacy app.js (lines 13-22) — duplicated in EventsList
// and DevicesList already; this is the canonical version for LiveTile.

export function fmtTime(epoch: number | null | undefined): string {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  const now = Date.now();
  const diff = (now - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleString();
}

// Numeric coercion shared between telemetry painters. Mirrors the `num`
// helper in app.js — returns a finite number or the fallback.
export function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Tiny HTML escaper for SVG text content (label strings could in
// principle contain class names that need escaping, though in practice
// the on-device classifier emits clean ASCII).
export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}
