// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The pipedog side of the performance benchmark (tools/bench/perf.ts). The
// same scenarios are in pipecat_bench.py, written the same way against upstream
// Pipecat, so the numbers compare the frameworks and not the scripts. Runs on
// Bun, Node, Deno and workerd; the arguments come from the runner.

import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import {
  EndFrame,
  type Frame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMTextFrame,
  TextFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { logger } from "@pipedog/core/utils/logger";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { GoogleLLMService, GoogleLLMSettings } from "@pipedog/google/llm";
import { GeminiTTSService, GeminiTTSSettings } from "@pipedog/google/tts";

export interface PerfArgs {
  scenario: "startup" | "throughput" | "hop" | "llm" | "tts";
  /** Pass-through processors in the pipeline (offline scenarios). */
  processors?: number;
  /** Frames to push (throughput) or round trips (hop). */
  frames?: number;
  /** Requests per scenario (online). */
  requests?: number;
  apiKey?: string;
  llmModel?: string;
  ttsModel?: string;
  /** For debugging the benchmark itself; WARNING by default. */
  logLevel?: "DEBUG" | "INFO" | "WARNING";
}

// Both sides log at WARNING, so neither pays for its debug lines.
logger.setLevel("WARNING");

const isWorkerd = globalThis.navigator?.userAgent === "Cloudflare-Workers";

export function runtimeName(): string {
  const g = globalThis as any;
  if (isWorkerd) return "workerd";
  if (g.Bun) return `bun ${g.Bun.version}`;
  if (g.Deno) return `deno ${g.Deno.version.deno}`;
  return `node ${g.process.version.slice(1)}`;
}

/**
 * The clock. workerd only advances it across I/O (a Spectre mitigation), so
 * there a zero-delay timer is awaited first; the scenarios time batches, not
 * single frames, so the extra timer is small next to what is measured.
 */
async function now(): Promise<number> {
  if (isWorkerd) await new Promise((resolve) => setTimeout(resolve, 0));
  return performance.now();
}

function rss(): number | null {
  const g = globalThis as any;
  if (g.Deno) return g.Deno.memoryUsage().rss;
  if (g.process?.memoryUsage && !isWorkerd) return g.process.memoryUsage().rss;
  return null;
}

class PassThrough extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);
  }
}

/** Counts the frames of a type that reach the end of the pipeline, and wakes whoever waits. */
class Sink extends FrameProcessor {
  seen: Array<{ frame: Frame; at: number }> = [];
  private _waiter: { until: (f: Frame) => boolean; resolve: () => void } | null = null;

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    this.seen.push({ frame, at: performance.now() });
    if (this._waiter?.until(frame)) {
      const { resolve } = this._waiter;
      this._waiter = null;
      resolve();
    }
    await this.pushFrame(frame, direction);
  }

  /** Resolves when a frame satisfies `until`; rejects after `timeoutMs` (a failed request). */
  waitFor(until: (f: Frame) => boolean, timeoutMs = 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiter = null;
        reject(new Error(`no frame after ${timeoutMs} ms`));
      }, timeoutMs);
      this._waiter = {
        until,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
    });
  }
}

/** Runs `body` while `processors` run in a PipelineWorker, then ends the pipeline. */
async function withPipeline<T>(
  processors: FrameProcessor[],
  sink: Sink,
  body: (worker: PipelineWorker) => Promise<T>,
): Promise<T> {
  const worker = new PipelineWorker(new Pipeline([...processors, sink]), {
    cancelOnIdleTimeout: false,
  });
  const runner = new WorkerRunner({ handleSigint: false });
  await runner.addWorkers(worker);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  worker.eventHandler("on_pipeline_started", async () => started());
  const running = runner.run();
  await ready;
  try {
    return await body(worker);
  } finally {
    await worker.queueFrame(new EndFrame());
    await running;
  }
}

const passThroughs = (n: number) => Array.from({ length: n }, () => new PassThrough());

/** Builds, starts and ends a pipeline: what a bot does before its first frame. */
async function startup(args: PerfArgs) {
  const t0 = await now();
  const sink = new Sink();
  await withPipeline(passThroughs(args.processors ?? 10), sink, async () => {});
  return { pipelineMs: (await now()) - t0, rss: rss() };
}

/** Frames per second through N pass-through processors, all queued at once. */
async function throughput(args: PerfArgs) {
  const n = args.frames ?? 20_000;
  const sink = new Sink();
  return withPipeline(passThroughs(args.processors ?? 10), sink, async (worker) => {
    const run = async (count: number) => {
      sink.seen = [];
      let got = 0;
      const done = sink.waitFor((f) => f instanceof TextFrame && ++got === count);
      const t0 = await now();
      await worker.queueFrames(
        Array.from({ length: count }, (_, i) => new TextFrame({ text: `${i}` })),
      );
      await done;
      return (await now()) - t0;
    };
    await run(Math.min(2000, n)); // warm-up
    const ms = await run(n);
    return { frames: n, ms, framesPerSec: (n / ms) * 1000, rss: rss() };
  });
}

/** One frame at a time through N processors: the latency a single frame sees. */
async function hop(args: PerfArgs) {
  const n = args.frames ?? 2000;
  const batch = 100;
  const sink = new Sink();
  return withPipeline(passThroughs(args.processors ?? 10), sink, async (worker) => {
    const once = async () => {
      const done = sink.waitFor((f) => f instanceof TextFrame);
      await worker.queueFrame(new TextFrame({ text: "x" }));
      await done;
    };
    for (let i = 0; i < 200; i++) await once(); // warm-up
    const perFrameUs: number[] = [];
    for (let b = 0; b < n / batch; b++) {
      const t0 = await now();
      for (let i = 0; i < batch; i++) await once();
      perFrameUs.push((((await now()) - t0) / batch) * 1000);
      sink.seen = [];
    }
    return { roundTrips: n, perFrameUs };
  });
}

const PROMPT = "In one sentence, what is a voice agent?";
const TTS_TEXT = "Hello! Thanks for calling. How can I help you today?";

/**
 * Gemini LLM time to first token, through a pipeline and with the SDK alone
 * (same model, prompt and thinking setting), alternating which goes first.
 */
async function llm(args: PerfArgs) {
  const model = args.llmModel ?? "gemini-3.5-flash-lite";
  const apiKey = args.apiKey!;
  const service = new GoogleLLMService({
    apiKey,
    settings: new GoogleLLMSettings({ model }),
  });
  const sink = new Sink();
  const client = new GoogleGenAI({ apiKey });
  const rows: Array<{ via: string; ttfbMs: number; totalMs: number }> = [];

  const sdk = async () => {
    const t0 = performance.now();
    let first = 0;
    const stream = await client.models.generateContentStream({
      model,
      contents: [{ role: "user", parts: [{ text: PROMPT }] }],
      // What GoogleLLMService sends for this model when thinking isn't configured.
      config: { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } },
    });
    for await (const chunk of stream) {
      if (!first && chunk.text) first = performance.now();
    }
    rows.push({
      via: "sdk",
      ttfbMs: first ? first - t0 : Number.NaN,
      totalMs: performance.now() - t0,
    });
  };

  await withPipeline([service], sink, async (worker) => {
    const pipeline = async () => {
      sink.seen = [];
      const done = sink.waitFor((f) => f instanceof LLMFullResponseEndFrame);
      const context = new LLMContext({ messages: [{ role: "user", content: PROMPT }] });
      const t0 = performance.now();
      await worker.queueFrame(new LLMContextFrame({ context }));
      await done;
      const first = sink.seen.find((s) => s.frame instanceof LLMTextFrame);
      rows.push({
        via: "pipeline",
        ttfbMs: (first?.at ?? Number.NaN) - t0,
        totalMs: performance.now() - t0,
      });
    };
    for (let i = 0; i < (args.requests ?? 5); i++) {
      if (i % 2) {
        await sdk();
        await pipeline();
      } else {
        await pipeline();
        await sdk();
      }
    }
  });
  return { model, rows };
}

/** Gemini TTS time to first audio, through a pipeline and with the SDK alone. */
async function tts(args: PerfArgs) {
  const model = args.ttsModel ?? "gemini-3.8-flash-tts";
  const apiKey = args.apiKey!;
  const voice = "Kore";
  const service = new GeminiTTSService({
    apiKey,
    settings: new GeminiTTSSettings({ model, voice }),
  });
  const sink = new Sink();
  const client = new GoogleGenAI({ apiKey });
  const rows: Array<{ via: string; ttfbMs: number; totalMs: number }> = [];

  const sdk = async () => {
    const t0 = performance.now();
    let first = 0;
    const stream = await client.models.generateContentStream({
      model,
      contents: TTS_TEXT,
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          languageCode: "en-US",
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
        },
      },
    });
    for await (const chunk of stream) {
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      if (!first && parts.some((p) => p.inlineData?.data)) first = performance.now();
    }
    rows.push({
      via: "sdk",
      ttfbMs: first ? first - t0 : Number.NaN,
      totalMs: performance.now() - t0,
    });
  };

  await withPipeline([service], sink, async (worker) => {
    const pipeline = async () => {
      sink.seen = [];
      const done = sink.waitFor((f) => f instanceof TTSStoppedFrame);
      const t0 = performance.now();
      await worker.queueFrame(new TTSSpeakFrame({ text: TTS_TEXT }));
      await done;
      const first = sink.seen.find((s) => s.frame instanceof TTSAudioRawFrame);
      rows.push({
        via: "pipeline",
        ttfbMs: (first?.at ?? Number.NaN) - t0,
        totalMs: performance.now() - t0,
      });
    };
    for (let i = 0; i < (args.requests ?? 3); i++) {
      if (i % 2) {
        await sdk();
        await pipeline();
      } else {
        await pipeline();
        await sdk();
      }
    }
  });
  return { model, rows };
}

const SCENARIOS = { startup, throughput, hop, llm, tts };

export default async function perf(args: PerfArgs) {
  logger.setLevel(args.logLevel ?? "WARNING");
  const result = await SCENARIOS[args.scenario](args);
  return { runtime: runtimeName(), scenario: args.scenario, ...result };
}
