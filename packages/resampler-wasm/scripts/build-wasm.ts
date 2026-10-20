// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause

// Builds wasm/resampler.wasm (the committed artifact):
//   1. cargo build --release --target wasm32-unknown-unknown   (opt-level "z", LTO, panic=abort)
//   2. wasm-opt -Oz (binaryen; from PATH, else `npx -p binaryen`) unless --no-opt
//
// Needs: rustup target add wasm32-unknown-unknown

import { copyFileSync, statSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const built = `${root}rust/target/wasm32-unknown-unknown/release/pipecat_resampler_wasm.wasm`;
const out = `${root}wasm/resampler.wasm`;

function run(cmd: string[]): boolean {
  const res = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  return res.exitCode === 0;
}

if (
  !run([
    "cargo",
    "build",
    "--manifest-path",
    "rust/Cargo.toml",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
  ])
) {
  process.exit(1);
}
const rawSize = statSync(built).size;

// Only the features rustc already emits for wasm32-unknown-unknown.
const opt = [
  "-Oz",
  "--enable-bulk-memory",
  "--enable-nontrapping-float-to-int",
  "--enable-sign-ext",
  "--enable-mutable-globals",
  "--enable-multivalue",
  "--enable-reference-types",
  built,
  "-o",
  out,
];
let optimized = false;
if (!process.argv.includes("--no-opt")) {
  optimized =
    (Bun.which("wasm-opt") !== null && run(["wasm-opt", ...opt])) ||
    run(["npx", "--yes", "-p", "binaryen@132.0.0", "wasm-opt", ...opt]);
  if (!optimized) console.warn("wasm-opt unavailable; copying the unoptimized build");
}
if (!optimized) copyFileSync(built, out);

console.log(
  `wasm/resampler.wasm: ${statSync(out).size} bytes (cargo: ${rawSize}${optimized ? ", after wasm-opt -Oz" : ""})`,
);
