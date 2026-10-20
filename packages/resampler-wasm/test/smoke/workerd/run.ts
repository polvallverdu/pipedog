// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

// Bundles worker.ts with the "workerd" condition and serves it with workerd
// (fetched by `npx`, no global install), then calls it once.
//   bun test/smoke/workerd/run.ts

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), "resampler-workerd-"));
const port = 20000 + Math.floor(Math.random() * 20000);

try {
  const build = await Bun.build({
    entrypoints: [join(here, "worker.ts")],
    target: "browser",
    format: "esm",
    conditions: ["workerd"],
    external: ["*.wasm"],
  });
  if (!build.success) throw new AggregateError(build.logs, "bundle failed");
  let code = await (build.outputs[0] as Blob).text();
  // Like wrangler, give the .wasm module a flat name next to the worker.
  // The "workerd" condition must have picked src/workerd.ts: a static .wasm import, no fs fallback.
  const wasmImport = /from\s*"\.\.\/wasm\/resampler\.wasm"/;
  if (!wasmImport.test(code) || code.includes("node:fs"))
    throw new Error("bundle did not use the workerd entry");
  code = code.replace(wasmImport, 'from "./resampler.wasm"');
  writeFileSync(join(out, "worker.js"), code);
  copyFileSync(join(here, "../../../wasm/resampler.wasm"), join(out, "resampler.wasm"));
  writeFileSync(
    join(out, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = .worker)],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);
const worker :Workerd.Worker = (
  modules = [
    (name = "worker.js", esModule = embed "worker.js"),
    (name = "resampler.wasm", wasm = embed "resampler.wasm"),
  ],
  compatibilityDate = "2025-01-01",
);
`,
  );

  const proc = Bun.spawn(["npx", "--yes", "workerd", "serve", join(out, "config.capnp")], {
    stdout: "inherit",
    stderr: "inherit",
  });
  try {
    let body: { ok: boolean } | null = null;
    for (let i = 0; i < 100 && !body; i++) {
      try {
        body = await (await fetch(`http://127.0.0.1:${port}/`)).json();
      } catch {
        await Bun.sleep(200);
      }
    }
    if (!body) throw new Error("workerd did not answer");
    console.log("workerd:", JSON.stringify(body));
    if (!body.ok) process.exitCode = 1;
  } finally {
    proc.kill();
    await proc.exited;
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
