import { defineConfig } from "astro/config";
import solid from "@astrojs/solid-js";
import { fileURLToPath } from "node:url";

// Static output: each page renders to HTML at build time. Solid components
// inside the pages hydrate on the client; the dynamic state (event list,
// live tiles) comes from the existing Express APIs at /api/*. Express
// serves the resulting `dist/` directory from src/index.ts.
export default defineConfig({
  output: "static",
  integrations: [solid()],
  // Match the URLs Express will serve (root). No trailing slashes — keeps
  // /events and /events/:id distinct, and matches the existing API shape.
  trailingSlash: "never",
  build: {
    format: "file",
  },
  vite: {
    resolve: {
      alias: {
        // Vite alias mirroring the tsconfig `paths` so runtime imports
        // resolve the same way the typechecker does.
        "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
        "~": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      // During `astro dev`, proxy /api/*, /hooks/*, /telemetry/*, /media/*,
      // and the SSE /stream endpoint to the live Express server at :8080.
      // This lets us run the frontend dev server with HMR while still
      // talking to the real backend.
      proxy: {
        "/api": {
          target: "http://localhost:8080",
          changeOrigin: true,
          // /api/stream is SSE — disable proxy buffering so events flow.
          ws: false,
        },
        "/hooks": "http://localhost:8080",
        "/telemetry": "http://localhost:8080",
        "/media": "http://localhost:8080",
      },
    },
  },
});
