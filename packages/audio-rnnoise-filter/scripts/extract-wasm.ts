// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

// Regenerates wasm/rnnoise.wasm (the committed artifact) from the pinned
// devDependency @jitsi/rnnoise-wasm: its `dist/rnnoise-sync.js` (RNNoise 0.2,
// built with Emscripten) holds the module as a base64 data URI. The module has
// no Emscripten glue dependency; src/engine.ts supplies its two imports.
//
//   bun scripts/extract-wasm.ts [--check]    (--check only compares, for CI)

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const source = import.meta.resolve("@jitsi/rnnoise-wasm/dist/rnnoise-sync.js");
const js = readFileSync(new URL(source), "utf8");
const match = /data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/.exec(js);
if (!match) throw new Error("no embedded wasm found in rnnoise-sync.js");
const bytes = Buffer.from(match[1] as string, "base64");
const sha = createHash("sha256").update(bytes).digest("hex");
const out = `${root}wasm/rnnoise.wasm`;

if (process.argv.includes("--check")) {
  const current = createHash("sha256").update(readFileSync(out)).digest("hex");
  if (current !== sha) throw new Error(`wasm/rnnoise.wasm (${current}) differs from ${sha}`);
  console.log(`wasm/rnnoise.wasm matches @jitsi/rnnoise-wasm (${sha})`);
} else {
  writeFileSync(out, bytes);
  console.log(`wrote wasm/rnnoise.wasm: ${bytes.length} bytes, sha256 ${sha}`);
}
