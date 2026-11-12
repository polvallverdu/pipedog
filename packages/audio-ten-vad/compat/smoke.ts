// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: runs TenVADAnalyzer on a fake TEN VAD
// module (pipedog ships none of TEN's files, so the real one can't be loaded
// here), and loads a precompiled WebAssembly module through
// loadTenVadModule's instantiateWasm path.

import { loadTenVadModule, TenVADAnalyzer } from "@pipedog/audio-ten-vad";
import { VADState } from "@pipedog/core/audio/vad/vad_analyzer";
import { FakeTenVADModule, tone } from "../test/fake_ten_vad.ts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`audio-ten-vad smoke: ${message}`);
}

// The smallest valid WebAssembly module.
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

async function precompiledModule(): Promise<WebAssembly.Module | undefined> {
  // workerd refuses to compile bytes at runtime: there the instantiateWasm
  // path is what the user exercises with an imported .wasm module.
  if (globalThis.navigator?.userAgent === "Cloudflare-Workers") return undefined;
  return await WebAssembly.compile(EMPTY_WASM);
}

export default async function smoke(): Promise<void> {
  const fake = new FakeTenVADModule({ growOnProcess: true });
  const wasmModule = await precompiledModule();
  const module = loadTenVadModule({
    wasmModule,
    factory: async (overrides) => {
      const instantiate = overrides?.instantiateWasm as
        | ((imports: object, cb: (i: WebAssembly.Instance) => void) => unknown)
        | undefined;
      if (instantiate) {
        const instance = await new Promise<WebAssembly.Instance>((r) => instantiate({}, r));
        check(instance instanceof WebAssembly.Instance, "instantiateWasm");
      }
      return fake;
    },
  });

  for (const hopSize of [256, 160] as const) {
    const vad = new TenVADAnalyzer({ module, hopSize, sampleRate: 16000 });
    vad.setSampleRate(16000);
    await vad.ready();

    const silence = await vad.voiceConfidence(new Uint8Array(hopSize * 2));
    check(silence < 0.1, `silence confidence ${silence}`);

    let state: VADState = VADState.QUIET;
    for (let f = 0; f < 50; f++) state = await vad.analyzeAudio(tone(320, 8000, f * 320));
    check(state === VADState.SPEAKING, `state ${state} after a loud tone`);
    await vad.cleanup();
  }
}
