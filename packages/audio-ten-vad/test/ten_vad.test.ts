// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** TenVADAnalyzer and loadTenVadModule, against a fake TEN VAD module (no TEN code). */

import { describe, expect, test } from "bun:test";
import { VADParams, VADState } from "@pipedog/core/audio/vad/vad_analyzer";
import { loadTenVadModule, TenVADAnalyzer, type TenVADModule } from "../src/ten_vad.ts";
import { FakeTenVADModule, tone } from "./fake_ten_vad.ts";

const FRAME = 320; // 20 ms at 16 kHz, what transports deliver

function analyzer(module: TenVADModule | Promise<TenVADModule>, hopSize?: 160 | 256) {
  const vad = new TenVADAnalyzer({
    module,
    hopSize,
    sampleRate: 16000,
    params: new VADParams({ startSecs: 0.2, stopSecs: 0.2 }),
  });
  vad.setSampleRate(16000);
  return vad;
}

describe("TenVADAnalyzer", () => {
  test("only 16 kHz", () => {
    const vad = new TenVADAnalyzer({ module: new FakeTenVADModule() });
    expect(() => vad.setSampleRate(8000)).toThrow(/needs to be 16000 \(sample rate: 8000\)/);
    vad.setSampleRate(16000);
    expect(vad.sampleRate).toBe(16000);
    expect(() => new TenVADAnalyzer({ module: new FakeTenVADModule(), sampleRate: 48000 })).toThrow(
      /needs to be 16000/,
    );
  });

  test("numFramesRequired is the hop size", async () => {
    const module = new FakeTenVADModule();
    const a = analyzer(module);
    const b = analyzer(module, 160);
    expect(a.numFramesRequired()).toBe(256);
    expect(b.numFramesRequired()).toBe(160);
    await Promise.all([a.ready(), b.ready()]);
    expect(module.created.map(([, hop, threshold]) => [hop, threshold])).toEqual([
      [256, 0.5],
      [160, 0.5],
    ]);
  });

  test("passes the threshold to TEN", async () => {
    const module = new FakeTenVADModule();
    const vad = new TenVADAnalyzer({ module, threshold: 0.3 });
    await vad.ready();
    expect(module.created[0]?.[2]).toBe(0.3);
    expect(() => new TenVADAnalyzer({ module, threshold: 2 })).toThrow(/threshold/);
  });

  test("confidence: silence is low, a loud tone is high", async () => {
    const vad = analyzer(new FakeTenVADModule());
    // Before the module resolves, the first call waits for it.
    const first = vad.voiceConfidence(tone(256, 0));
    expect(await first).toBeLessThan(0.1);
    // Afterwards, it is synchronous.
    const loud = vad.voiceConfidence(tone(256, 8000));
    expect(typeof loud).toBe("number");
    expect(loud as number).toBeGreaterThan(0.9);
  });

  test("an odd byteOffset is copied, not misread", async () => {
    const vad = analyzer(new FakeTenVADModule());
    await vad.ready();
    const backing = new Uint8Array(513);
    backing.set(tone(256, 8000), 1);
    const odd = backing.subarray(1);
    expect(vad.voiceConfidence(odd) as number).toBeGreaterThan(0.9);
  });

  test("analyzeAudio goes SPEAKING then QUIET", async () => {
    const vad = analyzer(new FakeTenVADModule(), 160);
    let state: VADState = VADState.QUIET;
    let sawSpeaking = false;
    for (let f = 0; f < 50; f++) {
      state = await vad.analyzeAudio(tone(FRAME, 8000, f * FRAME));
      if (state === VADState.SPEAKING) sawSpeaking = true;
    }
    expect(sawSpeaking).toBe(true);
    expect(state).toBe(VADState.SPEAKING);
    for (let f = 0; f < 50; f++) state = await vad.analyzeAudio(tone(FRAME, 0));
    expect(state).toBe(VADState.QUIET);
  });

  test("reads the heap afresh when memory grows", async () => {
    // A tiny heap grows on the analyzer's allocation and on TEN's; then every
    // process call grows it again, replacing the views.
    const module = new FakeTenVADModule({ initialHeap: 64, growOnProcess: true });
    const vad = analyzer(module);
    await vad.ready();
    const growsAtReady = module.grows;
    expect(growsAtReady).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      expect(vad.voiceConfidence(tone(256, 8000)) as number).toBeGreaterThan(0.9);
      expect(vad.voiceConfidence(tone(256, 0)) as number).toBeLessThan(0.1);
    }
    expect(module.grows).toBe(growsAtReady + 6);
  });

  test("an error from ten_vad_process throws", async () => {
    const module = new FakeTenVADModule();
    const vad = analyzer(module);
    await vad.ready();
    module.failNextProcess = true;
    expect(() => vad.voiceConfidence(tone(256, 0))).toThrow(/ten_vad_process failed/);
    await expect(
      (async () => {
        module.failNextProcess = true;
        return vad.analyzeAudio(tone(256, 0));
      })(),
    ).rejects.toThrow(/ten_vad_process failed/);
  });

  test("a frame of the wrong size throws", async () => {
    const vad = analyzer(new FakeTenVADModule());
    await vad.ready();
    expect(() => vad.voiceConfidence(tone(100, 0))).toThrow(/frames of 256 samples/);
  });

  test("a failed create rejects ready() and frees its memory", async () => {
    const module = new FakeTenVADModule();
    module.failCreate = true;
    const vad = analyzer(module);
    await expect(vad.ready()).rejects.toThrow(/ten_vad_create failed/);
    await expect(Promise.resolve(vad.voiceConfidence(tone(256, 0)))).rejects.toThrow(
      /ten_vad_create failed/,
    );
    expect(module.freed).toEqual([module.allocated[0] as number]);
    await vad.cleanup();
    expect(module.destroyed).toEqual([]);
  });

  test("a module that fails to load rejects analyzeAudio", async () => {
    const vad = analyzer(Promise.reject(new Error("no wasm")));
    await expect(vad.ready()).rejects.toThrow("no wasm");
    await expect(vad.analyzeAudio(tone(512, 0))).rejects.toThrow("no wasm");
    await vad.cleanup();
  });

  test("cleanup destroys the instance and frees its memory, once", async () => {
    const module = new FakeTenVADModule();
    const vad = analyzer(module);
    await vad.ready();
    const block = module.allocated[0] as number;
    const [handlePtr] = module.created[0] as [number, number, number];
    await vad.cleanup();
    await vad.cleanup();
    expect(module.destroyed).toEqual([handlePtr]);
    expect(module.freed).toEqual([block]);
    expect(() => vad.voiceConfidence(tone(256, 0))).toThrow(/cleaned up/);
  });

  test("cleanup before the module arrives creates nothing", async () => {
    let resolve!: (m: TenVADModule) => void;
    const pending = new Promise<TenVADModule>((r) => {
      resolve = r;
    });
    const module = new FakeTenVADModule();
    const vad = analyzer(pending);
    const cleaned = vad.cleanup();
    resolve(module);
    await cleaned;
    expect(module.created).toEqual([]);
    expect(module.allocated).toEqual([]);
  });

  test("one module serves many analyzers", async () => {
    const module = new FakeTenVADModule();
    const a = analyzer(module);
    const b = analyzer(module);
    await Promise.all([a.ready(), b.ready()]);
    expect(a.voiceConfidence(tone(256, 8000)) as number).toBeGreaterThan(0.9);
    expect(b.voiceConfidence(tone(256, 0)) as number).toBeLessThan(0.1);
    await a.cleanup();
    expect(b.voiceConfidence(tone(256, 8000)) as number).toBeGreaterThan(0.9);
    await b.cleanup();
    expect(new Set(module.freed).size).toBe(2);
  });
});

// The smallest valid WebAssembly module: the header and nothing else.
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

describe("loadTenVadModule", () => {
  test("passes wasmBinary to the factory", async () => {
    const module = new FakeTenVADModule();
    let seen: Record<string, unknown> | undefined;
    const loaded = await loadTenVadModule({
      factory: async (overrides) => {
        seen = overrides;
        return module;
      },
      wasmBinary: EMPTY_WASM,
      moduleOverrides: { print: () => {} },
    });
    expect(loaded).toBe(module);
    expect(seen?.wasmBinary).toBe(EMPTY_WASM);
    expect(seen?.instantiateWasm).toBeUndefined();
    expect(typeof seen?.print).toBe("function");
  });

  test("instantiates a precompiled wasmModule through instantiateWasm", async () => {
    const wasmModule = await WebAssembly.compile(EMPTY_WASM);
    const module = new FakeTenVADModule();
    let received: [WebAssembly.Instance, WebAssembly.Module | undefined] | undefined;
    const loaded = await loadTenVadModule({
      wasmModule,
      factory: async (overrides) => {
        expect(overrides?.wasmBinary).toBeUndefined();
        const instantiate = overrides?.instantiateWasm as (
          imports: WebAssembly.Imports,
          cb: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void,
        ) => unknown;
        await new Promise<void>((done) => {
          expect(
            instantiate({}, (instance, mod) => {
              received = [instance, mod];
              done();
            }),
          ).toEqual({});
        });
        return module;
      },
    });
    expect(loaded).toBe(module);
    expect(received?.[0]).toBeInstanceOf(WebAssembly.Instance);
    expect(received?.[1]).toBe(wasmModule);
  });

  test("a failed instantiation rejects the load", async () => {
    // Imports the module needs but isn't given: instantiation fails.
    const needsImport = new Uint8Array([
      0x00,
      0x61,
      0x73,
      0x6d,
      0x01,
      0x00,
      0x00,
      0x00, // header
      0x01,
      0x04,
      0x01,
      0x60,
      0x00,
      0x00, // type section: () -> ()
      0x02,
      0x07,
      0x01,
      0x01,
      0x6d,
      0x01,
      0x66,
      0x00,
      0x00, // import "m" "f" func type 0
    ]);
    const wasmModule = await WebAssembly.compile(needsImport);
    await expect(
      loadTenVadModule({
        wasmModule,
        factory: (overrides) => {
          const instantiate = overrides?.instantiateWasm as (i: object, cb: () => void) => unknown;
          instantiate({}, () => {});
          return new Promise<TenVADModule>(() => {}); // Emscripten waits forever
        },
      }),
    ).rejects.toThrow();
  });

  test("passes neither when the factory finds the wasm itself", async () => {
    let seen: Record<string, unknown> | undefined;
    await loadTenVadModule({
      factory: async (overrides) => {
        seen = overrides;
        return new FakeTenVADModule();
      },
    });
    expect(seen).toEqual({});
  });

  test("rejects both wasmBinary and wasmModule", async () => {
    const wasmModule = await WebAssembly.compile(EMPTY_WASM);
    await expect(
      loadTenVadModule({
        factory: async () => new FakeTenVADModule(),
        wasmBinary: EMPTY_WASM,
        wasmModule,
      }),
    ).rejects.toThrow(/not both/);
  });
});
