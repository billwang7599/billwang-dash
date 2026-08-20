import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  environments: {
    // Scoped to the client environment specifically — the Cloudflare plugin
    // builds the Worker as a separate environment with its own entry, and a
    // top-level `build.rollupOptions.input` would clobber it.
    client: {
      build: {
        rollupOptions: {
          // Two documents: a public landing page and the SPA shell. The Worker
          // decides which one a request gets — see worker/index.ts.
          input: {
            landing: resolve(import.meta.dirname, "index.html"),
            app: resolve(import.meta.dirname, "app/index.html"),
          },
        },
      },
    },
  },
});
