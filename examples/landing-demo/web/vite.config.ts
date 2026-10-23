// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The demo page: SvelteKit, prerendered to static files in build/, which the demo's Worker serves
// as Workers Static Assets (see ../wrangler.jsonc). `vite dev` proxies the API to `wrangler dev`
// on port 8787, for working on the page with hot reload (http://localhost:5173 is in
// ALLOWED_ORIGINS for that).

import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit({ adapter: adapter({ pages: "build", assets: "build", strict: true }) })],
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true, changeOrigin: false } },
  },
});
