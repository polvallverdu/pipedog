// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

// `with { type: "file" }` imports: Bun gives the path of the copied file.
declare module "*.onnx" {
  const path: string;
  export default path;
}
declare module "*.wasm" {
  const path: string;
  export default path;
}
declare module "*.mjs" {
  const path: string;
  export default path;
}
declare module "*.wav" {
  const path: string;
  export default path;
}
