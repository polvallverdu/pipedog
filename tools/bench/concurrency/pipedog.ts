// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The pipedog side of the concurrency benchmark (tools/bench/concurrency.ts).
// The same calls are in pipecat_concurrency.py, written the same way against
// upstream Pipecat. Runs on Bun, Node and Deno, in one thread or spread over
// worker threads (Bun and Deno `Worker`, Node `worker_threads`): the bundle
// loads itself as the worker module.
//
// A call is a voice bot without the network:
// - input audio: a speech recording (6.4 s) and 1.6 s of silence, looped, in
//   20 ms `InputAudioRawFrame`s at 16 kHz queued on a timer, as a transport does
// - a fake STT that emits a `TranscriptionFrame` at the end of each loop (every 8 s)
// - a fake LLM that answers 350 ms later with six `LLMTextFrame`s, 25 ms apart
// - a fake TTS that starts 150 ms after the response and streams 2 s of
//   24 kHz `TTSAudioRawFrame`s in real time (20 ms each)
// - pass-through processors where the context aggregators would be
// - "local" profile: Silero VAD (`VADProcessor`) on every chunk, and Smart Turn
//   v3 at each end of speech, both on onnxruntime-node
//
// Latency is from the time a frame was due (its slot on the 20 ms clock) to
// its arrival at the sink, so time a frame waited for a busy event loop counts.
// Smart Turn sits after the sink: a call's own wait for its turn decision is
// the same at any concurrency; what is measured is how much it delays the
// other calls.

import { createTask, sleep, type Task } from "@pipedog/asyncio";
import {
  type Frame,
  InputAudioRawFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { VADProcessor } from "@pipedog/core/processors/audio/vad_processor";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "@pipedog/core/processors/frame_processor";
import { logger } from "@pipedog/core/utils/logger";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import {
  SmartTurnWorkerPool,
  serveSmartTurn,
} from "@pipedog/example-worker-threads/smart_turn_pool";
import { coreCount, parentThread, spawnThread } from "@pipedog/example-worker-threads/threads";

export interface ConcurrencyArgs {
  profile: "io" | "local";
  /**
   * "single": every call on this thread; "workers": calls spread over one
   * worker thread per core; "pool": every call on this thread, Smart Turn on
   * a pool of worker threads (example `SmartTurnWorkerPool`).
   */
  mode: "single" | "workers" | "pool";
  calls: number;
  /** Worker threads in "workers" mode (default: one per core, at most one per call). */
  workers?: number;
  warmupS: number;
  durationS: number;
  /** A 16 kHz mono 16-bit WAV with speech. */
  wav: string;
}

export interface ThreadResult {
  calls: number;
  /** ms from each input frame's slot to the sink, for frames due in the window. */
  latency: number[];
  /** ms each TTS frame reached the sink after its slot. */
  ttsLate: number[];
  /** ms a 10 ms timer fired late, sampled through the window. */
  lag: number[];
  inputFrames: number;
  ttsFrames: number;
  transcriptions: number;
  vadStops: number;
  turnPredictions: number;
  errors: string[];
}

const SAMPLE_RATE = 16000;
const CHUNK_MS = 20;
const CHUNK_BYTES = (SAMPLE_RATE * CHUNK_MS * 2) / 1000; // 640
const SILENCE_S = 1.6;
const TTS_RATE = 24000;
const TTS_CHUNK = new Uint8Array((TTS_RATE * CHUNK_MS * 2) / 1000); // 960 bytes of silence
const TTS_SECONDS = 2;
const LLM_DELAY_S = 0.35;
const LLM_TOKENS = 6;
const LLM_TOKEN_S = 0.025;
const TTS_DELAY_S = 0.15;
const LAG_PROBE_MS = 10;

logger.setLevel("WARNING");

const g = globalThis as any;
const now = () => performance.now();
const DEBUG = Boolean(g.Deno ? g.Deno.env.get("BENCH_DEBUG") : g.process?.env?.BENCH_DEBUG);
const debug = (msg: string) => {
  if (DEBUG) console.error(`[${(now() / 1000).toFixed(2)} s] ${msg}`);
};

export function runtimeName(): string {
  if (g.Bun) return `bun ${g.Bun.version}`;
  if (g.Deno) return `deno ${g.Deno.version.deno}`;
  return `node ${g.process.version.slice(1)}`;
}

// ---------------------------------------------------------------------------
// Audio

async function readFile(path: string): Promise<Uint8Array> {
  const fs = await import("node:fs/promises");
  return new Uint8Array(await fs.readFile(path));
}

/** The WAV's PCM data plus the silence, as whole 20 ms chunks. */
async function loadCycle(path: string): Promise<Uint8Array[]> {
  const wav = await readFile(path);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let at = 12;
  let pcm: Uint8Array | null = null;
  while (at + 8 <= wav.length) {
    const id = String.fromCharCode(...wav.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    if (id === "fmt ") {
      const channels = view.getUint16(at + 10, true);
      const rate = view.getUint32(at + 12, true);
      if (channels !== 1 || rate !== SAMPLE_RATE) throw new Error(`${path}: not 16 kHz mono`);
    }
    if (id === "data") pcm = wav.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  if (!pcm) throw new Error(`${path}: no data chunk`);
  const silence = Math.round(SILENCE_S * SAMPLE_RATE * 2);
  const total = Math.ceil((pcm.length + silence) / CHUNK_BYTES) * CHUNK_BYTES;
  const cycle = new Uint8Array(total);
  cycle.set(pcm);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < total; i += CHUNK_BYTES) chunks.push(cycle.slice(i, i + CHUNK_BYTES));
  return chunks;
}

// ---------------------------------------------------------------------------
// The bot

/** An input frame that knows when it was due. */
class TimedAudioFrame extends InputAudioRawFrame {
  dueAt = 0;
}

class TimedTTSFrame extends TTSAudioRawFrame {
  dueAt = 0;
}

class PassThrough extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);
  }
}

/** Emits a transcription after each loop of the input audio. */
class FakeSTT extends FrameProcessor {
  #chunks = 0;
  constructor(
    private cycleChunks: number,
    private stats: ThreadResult,
    options: FrameProcessorOptions = {},
  ) {
    super(options);
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);
    if (frame instanceof InputAudioRawFrame && ++this.#chunks % this.cycleChunks === 0) {
      this.stats.transcriptions++;
      await this.pushFrame(
        new TranscriptionFrame({
          text: "What's the capital of France?",
          userId: "user",
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
}

/** Answers each transcription after a delay, streaming a few tokens. */
class FakeLLM extends FrameProcessor {
  #task: Task<void> | null = null;

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof TranscriptionFrame) {
      this.#task = this.createTask(() => this.respond(), "respond");
      return;
    }
    await this.pushFrame(frame, direction);
  }

  private async respond(): Promise<void> {
    await sleep(LLM_DELAY_S);
    await this.pushFrame(new LLMFullResponseStartFrame());
    for (let i = 0; i < LLM_TOKENS; i++) {
      await this.pushFrame(new LLMTextFrame({ text: `token ${i} ` }));
      await sleep(LLM_TOKEN_S);
    }
    await this.pushFrame(new LLMFullResponseEndFrame());
  }

  override async cleanup(): Promise<void> {
    if (this.#task) await this.cancelTask(this.#task);
    await super.cleanup();
  }
}

/** Speaks each response: real-time-paced audio after a delay. */
class FakeTTS extends FrameProcessor {
  #task: Task<void> | null = null;

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);
    if (frame instanceof LLMFullResponseEndFrame) {
      this.#task = this.createTask(() => this.speak(), "speak");
    }
  }

  private async speak(): Promise<void> {
    await sleep(TTS_DELAY_S);
    await this.pushFrame(new TTSStartedFrame());
    const start = now();
    for (let i = 0; i < (TTS_SECONDS * 1000) / CHUNK_MS; i++) {
      const due = start + i * CHUNK_MS;
      const wait = due - now();
      if (wait > 0) await sleep(wait / 1000);
      const frame = new TimedTTSFrame({
        audio: TTS_CHUNK,
        sampleRate: TTS_RATE,
        numChannels: 1,
      });
      // A timer can fire a little early; a frame sent early is on time.
      frame.dueAt = Math.min(due, now());
      await this.pushFrame(frame);
    }
    await this.pushFrame(new TTSStoppedFrame());
  }

  override async cleanup(): Promise<void> {
    if (this.#task) await this.cancelTask(this.#task);
    await super.cleanup();
  }
}

class Sink extends FrameProcessor {
  constructor(
    private window: { start: number; end: number },
    private stats: ThreadResult,
    options: FrameProcessorOptions = {},
  ) {
    super(options);
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof TimedAudioFrame) {
      if (frame.dueAt >= this.window.start && frame.dueAt < this.window.end) {
        this.stats.latency.push(now() - frame.dueAt);
        this.stats.inputFrames++;
      }
    } else if (frame instanceof TimedTTSFrame) {
      if (frame.dueAt >= this.window.start && frame.dueAt < this.window.end) {
        this.stats.ttsLate.push(now() - frame.dueAt);
        this.stats.ttsFrames++;
      }
    }
    await this.pushFrame(frame, direction);
  }
}

/** Runs Smart Turn at each end of speech, as Pipecat's turn analyzer stop strategy does. */
class SmartTurn extends FrameProcessor {
  #speaking = false;
  constructor(
    private analyzer: any,
    private stats: ThreadResult,
    options: FrameProcessorOptions = {},
  ) {
    super(options);
    analyzer.setSampleRate(SAMPLE_RATE);
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);
    if (direction !== FrameDirection.DOWNSTREAM) return;
    if (frame instanceof VADUserStartedSpeakingFrame) {
      this.#speaking = true;
    } else if (frame instanceof VADUserStoppedSpeakingFrame) {
      this.#speaking = false;
      this.stats.vadStops++;
      await this.analyzer.analyzeEndOfTurn();
      this.stats.turnPredictions++;
    } else if (frame instanceof InputAudioRawFrame) {
      this.analyzer.appendAudio(frame.audio, this.#speaking);
    }
  }

  override async cleanup(): Promise<void> {
    await this.analyzer.cleanup();
    await super.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Calls in this thread

/**
 * Starts `calls` calls in this thread; `ready` resolves once their pipelines
 * have started, and `go()` sends audio for warmup + duration seconds.
 */
export async function prepareCalls(
  args: ConcurrencyArgs,
  calls: number[],
  pool: SmartTurnWorkerPool | null,
) {
  const stats: ThreadResult = {
    calls: calls.length,
    latency: [],
    ttsLate: [],
    lag: [],
    inputFrames: 0,
    ttsFrames: 0,
    transcriptions: 0,
    vadStops: 0,
    turnPredictions: 0,
    errors: [],
  };
  const cycle = await loadCycle(args.wav);
  const window = { start: Number.POSITIVE_INFINITY, end: Number.POSITIVE_INFINITY };

  let silero: typeof import("@pipedog/audio-silero") | null = null;
  let smartTurn: typeof import("@pipedog/audio-smart-turn") | null = null;
  if (args.profile === "local") {
    silero = await import("@pipedog/audio-silero");
    smartTurn = await import("@pipedog/audio-smart-turn");
  }

  const sessions = await Promise.all(
    calls.map(async () => {
      const processors: FrameProcessor[] = [];
      if (silero) {
        const vad = new silero.SileroVADAnalyzer();
        await vad.ready();
        processors.push(new VADProcessor({ vadAnalyzer: vad }));
      }
      processors.push(
        new FakeSTT(cycle.length, stats),
        new PassThrough(),
        new PassThrough(),
        new FakeLLM(),
        new FakeTTS(),
        new PassThrough(),
        new Sink(window, stats),
      );
      if (smartTurn) {
        const analyzer = pool ? pool.analyzer() : smartTurn.createLocalSmartTurnAnalyzerV3();
        processors.push(new SmartTurn(analyzer, stats));
      }
      const worker = new PipelineWorker(new Pipeline(processors), {
        cancelOnIdleTimeout: false,
      });
      const runner = new WorkerRunner({ handleSigint: false });
      await runner.addWorkers(worker);
      const started = new Promise<void>((resolve) => {
        worker.eventHandler("on_pipeline_started", async () => resolve());
      });
      worker.eventHandler("on_pipeline_error", async (_w: unknown, frame: { error: string }) => {
        stats.errors.push(String(frame.error));
      });
      const running = runner.run();
      await started;
      return { worker, running };
    }),
  );

  async function go(): Promise<ThreadResult> {
    const t0 = now();
    window.start = t0 + args.warmupS * 1000;
    window.end = window.start + args.durationS * 1000;
    // Spread the calls: each starts at its own time in the first second and at
    // its own point of the recording, so their turns don't line up.
    const feeders = sessions.map(({ worker }, i) => {
      const c = calls[i] as number;
      const offset = ((c * 0.618034) % 1) * 1000;
      const phase = Math.floor(((c * 0.381966) % 1) * cycle.length);
      return createTask(async () => {
        for (let k = 0; ; k++) {
          const due = t0 + offset + k * CHUNK_MS;
          if (due >= window.end) return;
          const wait = due - now();
          if (wait > 0) await sleep(wait / 1000);
          const frame = new TimedAudioFrame({
            audio: cycle[(phase + k) % cycle.length] as Uint8Array,
            sampleRate: SAMPLE_RATE,
            numChannels: 1,
          });
          frame.dueAt = Math.min(due, now());
          await worker.queueFrame(frame);
        }
      });
    });
    const probe = createTask(async () => {
      let last = now();
      while (last < window.end) {
        await sleep(LAG_PROBE_MS / 1000);
        const t = now();
        if (t >= window.start && t < window.end) stats.lag.push(t - last - LAG_PROBE_MS);
        last = t;
      }
    });
    await Promise.all([...feeders, probe]);
    debug("audio done");
    // Let the last frames reach the sink.
    await sleep(0.2);
    await Promise.all(
      sessions.map(async ({ worker, running }) => {
        await worker.cancel();
        await Promise.race([running, sleep(5)]);
      }),
    );
    debug("calls ended");
    return stats;
  }

  debug(`${calls.length} calls started`);
  return { go };
}

// ---------------------------------------------------------------------------
// Worker threads

function cpuMs(): number {
  const u = g.process.cpuUsage();
  return (u.user + u.system) / 1000;
}

/** A worker thread running this same bundle (see `main`). */
const spawnSelf = () => spawnThread(import.meta.url);

/** Runs the calls in this thread, or spreads them over worker threads, and merges what they measured. */
export async function concurrency(args: ConcurrencyArgs) {
  const ids = Array.from({ length: args.calls }, (_, i) => i);
  let threads: number;
  let results: ThreadResult[];
  let cpu = { ms: 0, wallMs: 0 };

  const measureCpu = () => {
    // The window, from the main thread: all threads' CPU time over its wall time.
    let c0 = 0;
    let w0 = 0;
    setTimeout(() => {
      c0 = cpuMs();
      w0 = now();
    }, args.warmupS * 1000);
    setTimeout(
      () => {
        cpu = { ms: cpuMs() - c0, wallMs: now() - w0 };
      },
      (args.warmupS + args.durationS) * 1000,
    );
  };

  if (args.mode === "single" || args.mode === "pool") {
    threads = 1;
    let pool: SmartTurnWorkerPool | null = null;
    if (args.mode === "pool") {
      // Every core but the one running the calls.
      pool = new SmartTurnWorkerPool({
        size: Math.max(1, coreCount() - 1),
        spawn: async () => {
          const port = await spawnSelf();
          port.postMessage({ type: "serve-smart-turn" });
          return port;
        },
      });
    }
    const { go } = await prepareCalls(args, ids, pool);
    measureCpu();
    results = [await go()];
    await pool?.close();
  } else {
    threads = Math.min(args.workers ?? coreCount(), args.calls);
    const shares = Array.from({ length: threads }, (_, w) => ids.filter((i) => i % threads === w));
    const ports = await Promise.all(shares.map(() => spawnSelf()));
    const ready: Promise<void>[] = [];
    const done: Promise<ThreadResult>[] = [];
    ports.forEach((port, w) => {
      let onReady!: () => void;
      let onDone!: (r: ThreadResult) => void;
      const failed: Array<(e: Error) => void> = [];
      ready.push(
        new Promise<void>((resolve, reject) => {
          onReady = resolve;
          failed.push(reject);
        }),
      );
      done.push(
        new Promise<ThreadResult>((resolve, reject) => {
          onDone = resolve;
          failed.push(reject);
        }),
      );
      const fail = (e: Error) => {
        for (const f of failed) f(e);
      };
      port.addListener((msg) => {
        if (msg.type === "ready") onReady();
        else if (msg.type === "result") onDone(msg.result);
        else if (msg.type === "error") fail(new Error(`worker ${w}: ${msg.error}`));
      });
      port.onError((e) => fail(new Error(`worker ${w}: ${e.stack ?? e.message}`)));
      port.postMessage({ type: "prepare", args, calls: shares[w] });
    });
    // Rejections surface through `ready`, or through `done` once ready.
    for (const d of done) d.catch(() => {});
    await Promise.all(ready);
    measureCpu();
    for (const port of ports) port.postMessage({ type: "go" });
    results = await Promise.all(done);
    await Promise.all(ports.map((port) => port.terminate()));
  }

  const merged = {
    latency: results.flatMap((r) => r.latency),
    ttsLate: results.flatMap((r) => r.ttsLate),
    lag: results.flatMap((r) => r.lag),
  };
  const sum = (k: keyof ThreadResult) => results.reduce((a, r) => a + (r[k] as number), 0);
  return {
    runtime: runtimeName(),
    profile: args.profile,
    mode: args.mode,
    calls: args.calls,
    threads,
    latency: summary(merged.latency),
    ttsLate: summary(merged.ttsLate),
    lag: summary(merged.lag),
    expectedInputFrames: Math.round((args.calls * args.durationS * 1000) / CHUNK_MS),
    inputFrames: sum("inputFrames"),
    ttsFrames: sum("ttsFrames"),
    transcriptions: sum("transcriptions"),
    vadStops: sum("vadStops"),
    turnPredictions: sum("turnPredictions"),
    cpuPct: cpu.wallMs ? (cpu.ms / cpu.wallMs) * 100 : null,
    errors: results.flatMap((r) => r.errors).slice(0, 5),
  };
}

function summary(xs: number[]) {
  const s = Float64Array.from(xs).sort();
  const q = (p: number) =>
    s.length ? (s[Math.min(s.length - 1, Math.floor(p * s.length))] as number) : null;
  return {
    n: s.length,
    p50: q(0.5),
    p99: q(0.99),
    p999: q(0.999),
    max: s.length ? s[s.length - 1] : null,
  };
}

/** The bundle's entry: a benchmark worker serves its parent; otherwise run and print the result. */
export async function main(mark: string): Promise<void> {
  const port = await parentThread();
  if (port) {
    let go: (() => Promise<ThreadResult>) | null = null;
    port.addListener(async (msg) => {
      try {
        if (msg.type === "serve-smart-turn") {
          serveSmartTurn(port);
        } else if (msg.type === "prepare") {
          go = (await prepareCalls(msg.args, msg.calls, null)).go;
          port.postMessage({ type: "ready" });
        } else if (msg.type === "go") {
          port.postMessage({ type: "result", result: await go!() });
        }
      } catch (e) {
        port.postMessage({
          type: "error",
          error: e instanceof Error ? (e.stack ?? e.message) : String(e),
        });
      }
    });
    return;
  }
  const raw = g.Deno ? g.Deno.env.get("PIPEDOG_BENCH_ARGS") : g.process.env.PIPEDOG_BENCH_ARGS;
  const result = await concurrency(JSON.parse(raw));
  console.log(mark + JSON.stringify(result));
  g.Deno ? g.Deno.exit(0) : g.process.exit(0);
}
