// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The ONNX benchmark, run by tools/bench.ts on every runtime through the
// compat harness (so workerd gets the "workerd" export condition). Returns
// one row per backend the runtime has.

import { defaultSileroModelUrl, SileroOnnxModel } from "@pipedog/audio-silero";
import {
  createLocalSmartTurnAnalyzerV3,
  defaultSmartTurnModelUrl,
  onnxSmartTurnSessionFactory,
} from "@pipedog/audio-smart-turn";
import { computeWhisperLogMelFeatures } from "@pipedog/core/audio/turn/smart_turn/_whisper_features";
import { createNativeBackend, createWebBackend, type OnnxBackend } from "@pipedog/onnx";

const SILERO_WARMUP = 50;
const SILERO_BATCHES = 10;
const SILERO_PER_BATCH = 200;
const TURN_WARMUP = 2;
const TURN_BATCHES = 5;
const TURN_PER_BATCH = 3;

export interface BenchRow {
  runtime: string;
  backend: string;
  /** Silero: ms per 512-sample (32 ms) chunk at 16 kHz. */
  sileroMs: number;
  /** Smart Turn: ms per model inference (8 s of features in). */
  turnMs: number;
  /** Smart Turn: ms per prediction (features + inference), 8 s at 16 kHz. */
  turnPredictMs: number;
}

const isWorkerd = globalThis.navigator?.userAgent === "Cloudflare-Workers";

function runtimeName(): string {
  const g = globalThis as any;
  if (isWorkerd) return "workerd";
  if (g.Bun) return `bun ${g.Bun.version}`;
  if (g.Deno) return `deno ${g.Deno.version.deno}`;
  return `node ${g.process.version.slice(1)}`;
}

async function models(): Promise<{ silero?: Uint8Array; turn?: Uint8Array }> {
  if (!isWorkerd) return {};
  const silero = (await import("../../packages/audio-silero/data/silero_vad.onnx")) as {
    default: ArrayBuffer;
  };
  const turn = (await import("../../packages/audio-smart-turn/data/smart-turn-v3.2-cpu.onnx")) as {
    default: ArrayBuffer;
  };
  return { silero: new Uint8Array(silero.default), turn: new Uint8Array(turn.default) };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1] as number;
}

/**
 * The clock. workerd only advances it across I/O (a Spectre mitigation), so
 * there a zero-delay timer is awaited first.
 */
async function now(): Promise<number> {
  if (isWorkerd) await new Promise((resolve) => setTimeout(resolve, 0));
  return performance.now();
}

/** Median over batches of the mean ms per call (batches amortize the workerd clock tick). */
async function measure(
  fn: () => Promise<unknown>,
  warmup: number,
  batches: number,
  perBatch: number,
): Promise<number> {
  for (let i = 0; i < warmup; i++) await fn();
  const means: number[] = [];
  for (let b = 0; b < batches; b++) {
    const t0 = await now();
    for (let i = 0; i < perBatch; i++) await fn();
    means.push(((await now()) - t0) / perBatch);
  }
  return median(means);
}

/** Deterministic pseudo-random audio in [-amp, amp]. */
function noise(n: number, amp: number, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    out[i] = (s / 0x7fffffff) * 2 * amp - amp;
  }
  return out;
}

async function benchBackend(
  name: string,
  backend: OnnxBackend,
  m: { silero?: Uint8Array; turn?: Uint8Array },
): Promise<BenchRow> {
  // Silero, through the ported model wrapper (context + state handling included).
  const silero = new SileroOnnxModel(m.silero ?? defaultSileroModelUrl(), {
    backend,
  });
  const chunk = noise(512, 0.1);
  const sileroMs = await measure(
    () => silero.call(chunk, 16000),
    SILERO_WARMUP,
    SILERO_BATCHES,
    SILERO_PER_BATCH,
  );
  await silero.dispose();

  // Smart Turn: the bare model call, and the analyzer's whole prediction.
  const turnModel = m.turn ?? defaultSmartTurnModelUrl();
  const session = await onnxSmartTurnSessionFactory({ model: turnModel, backend })("", {
    executionMode: "sequential",
    interOpNumThreads: 1,
    intraOpNumThreads: 1,
    graphOptimizationLevel: "all",
  });
  const audio = noise(16000 * 8, 0.3, 7);
  const features = computeWhisperLogMelFeatures(audio, { doNormalize: true });
  const feeds = { input_features: { data: features, dims: [1, 80, 800] } };
  const turnMs = await measure(() => session.run(feeds), TURN_WARMUP, TURN_BATCHES, TURN_PER_BATCH);

  const analyzer = createLocalSmartTurnAnalyzerV3({ model: turnModel, backend }) as unknown as {
    _predictEndpoint(a: Float32Array): Promise<unknown>;
  };
  const turnPredictMs = await measure(
    () => analyzer._predictEndpoint(audio),
    TURN_WARMUP,
    TURN_BATCHES,
    TURN_PER_BATCH,
  );

  return {
    runtime: runtimeName(),
    backend: name,
    sileroMs,
    turnMs,
    turnPredictMs,
  };
}

export default async function bench(): Promise<BenchRow[]> {
  const m = await models();
  const rows: BenchRow[] = [];
  if (!isWorkerd) rows.push(await benchBackend("onnxruntime-node", await createNativeBackend(), m));
  rows.push(
    await benchBackend(
      isWorkerd ? "onnxruntime-web (workerd)" : "onnxruntime-web",
      await createWebBackend(),
      m,
    ),
  );
  return rows;
}
