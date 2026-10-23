// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Smart Turn on worker threads.
 *
 * A Smart Turn prediction (Whisper features and the ONNX model) takes about
 * 100 ms of CPU. Run inline, as `LocalSmartTurnAnalyzerV3` does, it blocks
 * the event loop, and every call on that loop stalls while one call's turn is
 * decided. Pipecat runs it on a thread executor for the same reason.
 *
 * `SmartTurnWorkerPool` keeps the model in a few worker threads and hands each
 * prediction to the least busy one. `pool.analyzer()` is a drop-in
 * `LocalSmartTurnAnalyzerV3` (same buffering, same parameters) whose
 * prediction runs there: pass it to `TurnAnalyzerUserTurnStopStrategy` as
 * usual. One pool serves every call in the process.
 *
 * The worker side is `serveSmartTurn()`; `smart_turn_thread.ts` is a ready
 * module for it.
 */

import { defaultSmartTurnModelUrl, onnxSmartTurnSessionFactory } from "@pipedog/audio-smart-turn";
import type {
  BaseSmartTurnOptions,
  SmartTurnPrediction,
} from "@pipedog/core/audio/turn/smart_turn/base_smart_turn";
import { LocalSmartTurnAnalyzerV3 } from "@pipedog/core/audio/turn/smart_turn/local_smart_turn_v3";
import type { OnnxBackend, OnnxModelSource } from "@pipedog/onnx";
import { coreCount, type ThreadPort } from "./threads.ts";

const PREDICT = "smart-turn:predict";
const RESULT = "smart-turn:result";

interface PredictMessage {
  type: typeof PREDICT;
  id: number;
  audio: Float32Array;
  sampleRate: number;
}

interface ResultMessage {
  type: typeof RESULT;
  id: number;
  prediction?: SmartTurnPrediction;
  error?: string;
}

export interface SmartTurnWorkerPoolOptions {
  /** Starts one worker thread that calls `serveSmartTurn()` (e.g. `() => spawnThread(url)`). */
  spawn: () => ThreadPort | Promise<ThreadPort>;
  /** Worker threads (default: half the cores, at least one). */
  size?: number;
}

interface Slot {
  port: Promise<ThreadPort>;
  pending: number;
}

/** A few worker threads running Smart Turn predictions for every call in the process. */
export class SmartTurnWorkerPool {
  #slots: Slot[];
  #nextId = 0;
  #waiting = new Map<
    number,
    { resolve: (p: SmartTurnPrediction) => void; reject: (e: Error) => void; slot: Slot }
  >();

  constructor(options: SmartTurnWorkerPoolOptions) {
    const size = options.size ?? Math.max(1, Math.floor(coreCount() / 2));
    this.#slots = Array.from({ length: size }, () => {
      const slot: Slot = { port: Promise.resolve(options.spawn()), pending: 0 };
      slot.port.then((port) => {
        port.addListener((msg: ResultMessage) => {
          if (msg?.type !== RESULT) return;
          const waiter = this.#waiting.get(msg.id);
          if (!waiter) return;
          this.#waiting.delete(msg.id);
          waiter.slot.pending--;
          if (msg.prediction) waiter.resolve(msg.prediction);
          else waiter.reject(new Error(`Smart Turn worker: ${msg.error}`));
        });
        port.onError((error) => this.#failSlot(slot, error));
      });
      return slot;
    });
  }

  /** Predicts the end of turn for `audio` (float32 samples at `sampleRate`) on the least busy thread. */
  async predict(audio: Float32Array, sampleRate: number): Promise<SmartTurnPrediction> {
    const slot = this.#slots.reduce((a, b) => (b.pending < a.pending ? b : a));
    const id = this.#nextId++;
    slot.pending++;
    const result = new Promise<SmartTurnPrediction>((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject, slot });
    });
    const port = await slot.port;
    const message: PredictMessage = { type: PREDICT, id, audio, sampleRate };
    // The samples move to the worker; the caller doesn't use them again.
    port.postMessage(message, [audio.buffer as ArrayBuffer]);
    return result;
  }

  /** A `LocalSmartTurnAnalyzerV3` whose predictions run on this pool. */
  analyzer(options: BaseSmartTurnOptions = {}): LocalSmartTurnAnalyzerV3 {
    return new PooledSmartTurnAnalyzer(this, options);
  }

  /** Stops the worker threads; predictions still waiting are rejected. */
  async close(): Promise<void> {
    for (const slot of this.#slots) this.#failSlot(slot, new Error("pool closed"));
    await Promise.all(this.#slots.map(async (slot) => (await slot.port).terminate()));
  }

  #failSlot(slot: Slot, error: Error): void {
    for (const [id, waiter] of this.#waiting) {
      if (waiter.slot !== slot) continue;
      this.#waiting.delete(id);
      slot.pending--;
      waiter.reject(error);
    }
  }
}

class PooledSmartTurnAnalyzer extends LocalSmartTurnAnalyzerV3 {
  private pool: SmartTurnWorkerPool;

  constructor(pool: SmartTurnWorkerPool, options: BaseSmartTurnOptions) {
    // The session factory is never called: predictions run in the pool.
    super({
      ...options,
      createSession: () => Promise.reject(new Error("runs on SmartTurnWorkerPool")),
    });
    this.pool = pool;
  }

  protected override _predictEndpoint(audioArray: Float32Array): Promise<SmartTurnPrediction> {
    // A copy when the samples are a view on a larger buffer, so only they move.
    const audio =
      audioArray.byteOffset === 0 && audioArray.buffer.byteLength === audioArray.byteLength
        ? audioArray
        : audioArray.slice();
    return this.pool.predict(audio, this.sampleRate || 16000);
  }
}

/** The model side, in the worker thread: what `LocalSmartTurnAnalyzerV3` runs inline. */
class SmartTurnModel extends LocalSmartTurnAnalyzerV3 {
  predict(audio: Float32Array, sampleRate: number): Promise<SmartTurnPrediction> {
    this.setSampleRate(sampleRate);
    return this._predictEndpoint(audio);
  }
}

export interface ServeSmartTurnOptions {
  /** The Smart Turn model: bytes, a path or a URL (default: the one shipped with @pipedog/audio-smart-turn). */
  model?: OnnxModelSource;
  /** The ONNX backend (default: `createOnnxBackend()`, onnxruntime-node when installed). */
  backend?: OnnxBackend | Promise<OnnxBackend>;
}

/**
 * Answers a `SmartTurnWorkerPool`'s predictions on `port` (the worker's
 * `parentThread()`) with one model session.
 */
export function serveSmartTurn(port: ThreadPort, options: ServeSmartTurnOptions = {}): void {
  const model = new SmartTurnModel({
    createSession: onnxSmartTurnSessionFactory({
      model: options.model ?? defaultSmartTurnModelUrl(),
      backend: options.backend,
    }),
  });
  port.addListener(async (msg: PredictMessage) => {
    if (msg?.type !== PREDICT) return;
    let reply: ResultMessage;
    try {
      reply = {
        type: RESULT,
        id: msg.id,
        prediction: await model.predict(msg.audio, msg.sampleRate),
      };
    } catch (e) {
      reply = { type: RESULT, id: msg.id, error: e instanceof Error ? e.message : String(e) };
    }
    port.postMessage(reply);
  });
}
