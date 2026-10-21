// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

// Cloudflare Workers (wrangler/workerd) import .wasm files as compiled modules.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
