// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/audio/ten-vad.mdx. Type-checked on every docs build. TEN VAD's own
// files are never imported here (pipedog ships none of them): the regions show those imports as
// comments, and the names are declared below with pipedog's TenVADModuleFactory type.

import { readFile } from "node:fs/promises";
import {
  loadTenVadModule,
  TenVADAnalyzer,
  type TenVADModule,
  type TenVADModuleFactory,
} from "@pipedog/audio-ten-vad";
import { VADParams } from "@pipedog/core/audio/vad/vad_analyzer";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import {
  LLMContextAggregatorPair,
  LLMUserAggregatorParams,
} from "@pipedog/core/processors/aggregators/llm_response_universal";

// Stand-ins for `import createVADModule from "./ten-vad/ten_vad.js"` and
// `import tenVadWasm from "./ten-vad/ten_vad.wasm"` in your app.
declare const createVADModule: TenVADModuleFactory;
declare const tenVadWasm: WebAssembly.Module;
declare const tenVad: Promise<TenVADModule>;

{
  // #region server
  // import createVADModule from "./ten-vad/ten_vad.js"; // TEN's lib/Web/ten_vad.js

  // Load TEN's module once and share it: each analyzer creates its own TEN VAD instance in it.
  const tenVad = loadTenVadModule({
    factory: createVADModule,
    wasmBinary: await readFile("./ten-vad/ten_vad.wasm"),
  });

  const vad = new TenVADAnalyzer({ module: tenVad, sampleRate: 16000 });
  // #endregion server
  void vad;
}

{
  // #region browser
  // import createVADModule from "/ten-vad/ten_vad.js";

  // TEN's glue fetches ten_vad.wasm from next to ten_vad.js (or pass `wasmBinary`).
  const vad = new TenVADAnalyzer({ module: loadTenVadModule({ factory: createVADModule }) });
  // #endregion browser
  void vad;
}

{
  // #region workers
  // import createVADModule from "./ten-vad/ten_vad.js";
  // import tenVadWasm from "./ten-vad/ten_vad.wasm"; // Wrangler gives a WebAssembly.Module

  const tenVad = loadTenVadModule({ factory: createVADModule, wasmModule: tenVadWasm });
  const vad = new TenVADAnalyzer({ module: tenVad });
  // #endregion workers
  void vad;
}

{
  // #region pipeline
  const context = new LLMContext();
  const vad = new TenVADAnalyzer({
    module: tenVad,
    hopSize: 160, // 10 ms frames (default: 256, 16 ms)
    // TEN's speech probability is the confidence: VADParams decides, as for Silero.
    params: new VADParams({ confidence: 0.7, startSecs: 0.2, stopSecs: 0.2 }),
  });
  const aggregators = new LLMContextAggregatorPair(context, {
    userParams: new LLMUserAggregatorParams({ vadAnalyzer: vad }),
  });
  // #endregion pipeline
  void aggregators;
}
