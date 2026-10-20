// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Hand-written wrapper over the rubato resampler's WebAssembly exports.
 *
 * The module has no imports and a tiny C ABI (see `rust/src/lib.rs`), so
 * there is no generated glue: we instantiate it, keep the exports, and copy
 * PCM in and out of linear memory. Everything here is synchronous; only
 * loading the module (`initResampler`) is async.
 */

/** Quality presets, same names as libsoxr's (QQ fastest .. VHQ best). */
export type Quality = "QQ" | "LQ" | "MQ" | "HQ" | "VHQ";

/** All presets, lowest quality first. */
export const QUALITIES: readonly Quality[] = ["QQ", "LQ", "MQ", "HQ", "VHQ"];

export interface ResampleOptions {
  /** Quality preset. Defaults to "VHQ" (as upstream's soxr resamplers). */
  quality?: Quality;
  /** Interleaved channel count, 1..8. Defaults to 1. */
  channels?: number;
}

/** What a quality preset maps to in rubato (see the README for the table). */
export interface QualityInfo {
  quality: Quality;
  /** Filter length in samples of the lower rate (stretched by the factor when downsampling). */
  sincLen: number;
  /** Sinc table points per sample of the lower rate. */
  oversampling: number;
}

interface Exports {
  memory: WebAssembly.Memory;
  rs_stream_new(inRate: number, outRate: number, channels: number, quality: number): number;
  rs_stream_free(h: number): void;
  rs_stream_input(h: number, n: number): number;
  rs_stream_process(h: number, n: number): number;
  rs_stream_flush(h: number): number;
  rs_stream_output(h: number): number;
  rs_stream_input_f32(h: number, n: number): number;
  rs_stream_process_f32(h: number, n: number): number;
  rs_stream_flush_f32(h: number): number;
  rs_stream_output_f32(h: number): number;
  rs_stream_reset(h: number): void;
  rs_stream_delay(h: number): number;
  rs_stream_cutoff(h: number): number;
  rs_quality_sinc_len(q: number): number;
  rs_quality_oversampling(q: number): number;
}

const EMPTY_BYTES = new Uint8Array(0);

function qualityIndex(quality: Quality): number {
  const i = QUALITIES.indexOf(quality);
  if (i < 0) throw new Error(`unknown resampler quality: ${String(quality)}`);
  return i;
}

/** View 16-bit PCM bytes as samples (copying when the offset is odd). */
function bytesToInt16(audio: Uint8Array): Int16Array {
  const length = audio.length >> 1;
  if (audio.byteOffset % 2 !== 0) return new Int16Array(audio.slice(0, length * 2).buffer);
  return new Int16Array(audio.buffer, audio.byteOffset, length);
}

function int16ToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/**
 * A stateful streaming resampler (one rubato instance in WASM memory).
 *
 * Accepts chunks of any size and keeps the filter history between them, so
 * there are no clicks at chunk boundaries. Output is aligned with the input
 * (the filter delay is trimmed), and `flush()` emits the tail so the stream's
 * total output is round(totalInputFrames * outRate / inRate) frames.
 *
 * Call `destroy()` when done; a FinalizationRegistry frees forgotten streams
 * eventually, but WASM memory is not reclaimed promptly by GC.
 */
export class RubatoStream {
  readonly inRate: number;
  readonly outRate: number;
  readonly channels: number;
  readonly quality: Quality;
  #x: Exports;
  #h: number;
  #token = {};

  /** @internal Use `RubatoEngine.createStream`. */
  constructor(
    engine: RubatoEngine,
    x: Exports,
    inRate: number,
    outRate: number,
    opts: ResampleOptions,
  ) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.channels = opts.channels ?? 1;
    this.quality = opts.quality ?? "VHQ";
    if (!Number.isInteger(inRate) || !Number.isInteger(outRate) || inRate <= 0 || outRate <= 0) {
      throw new Error(`invalid sample rates: ${inRate}->${outRate}`);
    }
    if (!Number.isInteger(this.channels) || this.channels < 1 || this.channels > 8) {
      throw new Error(`invalid channel count: ${this.channels}`);
    }
    this.#x = x;
    this.#h = x.rs_stream_new(inRate, outRate, this.channels, qualityIndex(this.quality));
    if (this.#h === 0) throw new Error(`could not create resampler ${inRate}->${outRate}`);
    engine._register(this, this.#h, this.#token);
  }

  #handle(): number {
    if (this.#h === 0) throw new Error("RubatoStream has been destroyed");
    return this.#h;
  }

  /** Filter delay in output frames (already compensated for in the output). */
  get delayFrames(): number {
    return this.#x.rs_stream_delay(this.#handle());
  }

  /** Relative anti-aliasing cutoff (1.0 = input Nyquist; scaled when downsampling). */
  get cutoff(): number {
    return this.#x.rs_stream_cutoff(this.#handle());
  }

  /** Resample interleaved int16 samples. Returns a fresh array. */
  processSamples(samples: Int16Array): Int16Array {
    const h = this.#handle();
    const x = this.#x;
    if (samples.length > 0) {
      const ptr = x.rs_stream_input(h, samples.length);
      new Int16Array(x.memory.buffer, ptr, samples.length).set(samples);
    }
    return this.#readI16(h, x.rs_stream_process(h, samples.length));
  }

  /** Resample interleaved float samples in [-1, 1] (unclipped). Returns a fresh array. */
  processFloat32(samples: Float32Array): Float32Array {
    const h = this.#handle();
    const x = this.#x;
    if (samples.length > 0) {
      const ptr = x.rs_stream_input_f32(h, samples.length);
      new Float32Array(x.memory.buffer, ptr, samples.length).set(samples);
    }
    return this.#readF32(h, x.rs_stream_process_f32(h, samples.length));
  }

  /** Resample 16-bit little-endian PCM bytes. */
  process(audio: Uint8Array): Uint8Array {
    const out = this.processSamples(bytesToInt16(audio));
    return out.length === 0 ? EMPTY_BYTES : int16ToBytes(out);
  }

  /** Emit the audio held in the filter as int16 samples, then reset. */
  flushSamples(): Int16Array {
    const h = this.#handle();
    return this.#readI16(h, this.#x.rs_stream_flush(h));
  }

  /** Emit the audio held in the filter as float samples, then reset. */
  flushFloat32(): Float32Array {
    const h = this.#handle();
    return this.#readF32(h, this.#x.rs_stream_flush_f32(h));
  }

  /** Emit the audio held in the filter as PCM bytes, then reset. */
  flush(): Uint8Array {
    const out = this.flushSamples();
    return out.length === 0 ? EMPTY_BYTES : int16ToBytes(out);
  }

  /** Discard the audio held in the filter and start a new stream. */
  reset(): void {
    this.#x.rs_stream_reset(this.#handle());
  }

  /** Free the WASM-side state. The stream is unusable afterwards. */
  destroy(): void {
    if (this.#h === 0) return;
    RubatoEngine._unregister(this.#token);
    this.#x.rs_stream_free(this.#h);
    this.#h = 0;
  }

  #readI16(h: number, n: number): Int16Array {
    if (n < 0) throw new Error("resampler failed");
    if (n === 0) return new Int16Array(0);
    // Copy out: the view would be invalidated by the next call or a memory grow.
    return new Int16Array(this.#x.memory.buffer, this.#x.rs_stream_output(h), n).slice();
  }

  #readF32(h: number, n: number): Float32Array {
    if (n < 0) throw new Error("resampler failed");
    if (n === 0) return new Float32Array(0);
    return new Float32Array(this.#x.memory.buffer, this.#x.rs_stream_output_f32(h), n).slice();
  }
}

/**
 * The resampler engine: one instantiated WASM module. Cheap to share; all
 * methods are synchronous.
 */
export class RubatoEngine {
  #x: Exports;
  static #registry =
    typeof FinalizationRegistry === "function"
      ? new FinalizationRegistry<{ x: Exports; h: number }>(({ x, h }) => x.rs_stream_free(h))
      : null;

  constructor(instance: WebAssembly.Instance) {
    this.#x = instance.exports as unknown as Exports;
    if (typeof this.#x.rs_stream_new !== "function") {
      throw new Error("not the @pipedog/resampler-wasm module");
    }
  }

  /** @internal */
  _register(stream: RubatoStream, h: number, token: object): void {
    RubatoEngine.#registry?.register(stream, { x: this.#x, h }, token);
  }

  /** @internal */
  static _unregister(token: object): void {
    RubatoEngine.#registry?.unregister(token);
  }

  /** Create a streaming resampler. */
  createStream(inRate: number, outRate: number, opts: ResampleOptions = {}): RubatoStream {
    return new RubatoStream(this, this.#x, inRate, outRate, opts);
  }

  /** One-shot resampling of interleaved int16 samples (whole clip, tail included). */
  resampleSamples(
    samples: Int16Array,
    inRate: number,
    outRate: number,
    opts: ResampleOptions = {},
  ): Int16Array {
    if (inRate === outRate) return samples;
    const stream = this.createStream(inRate, outRate, opts);
    try {
      const head = stream.processSamples(samples);
      const tail = stream.flushSamples();
      if (tail.length === 0) return head;
      const out = new Int16Array(head.length + tail.length);
      out.set(head);
      out.set(tail, head.length);
      return out;
    } finally {
      stream.destroy();
    }
  }

  /** One-shot resampling of interleaved float samples (whole clip, tail included). */
  resampleFloat32(
    samples: Float32Array,
    inRate: number,
    outRate: number,
    opts: ResampleOptions = {},
  ): Float32Array {
    if (inRate === outRate) return samples;
    const stream = this.createStream(inRate, outRate, opts);
    try {
      const head = stream.processFloat32(samples);
      const tail = stream.flushFloat32();
      if (tail.length === 0) return head;
      const out = new Float32Array(head.length + tail.length);
      out.set(head);
      out.set(tail, head.length);
      return out;
    } finally {
      stream.destroy();
    }
  }

  /**
   * One-shot resampling of 16-bit little-endian PCM bytes. Returns the input
   * unchanged when the rates are equal, like upstream.
   */
  resample(
    audio: Uint8Array,
    inRate: number,
    outRate: number,
    opts: ResampleOptions = {},
  ): Uint8Array {
    if (inRate === outRate) return audio;
    return int16ToBytes(this.resampleSamples(bytesToInt16(audio), inRate, outRate, opts));
  }

  /** The rubato parameters behind a quality preset. */
  qualityInfo(quality: Quality): QualityInfo {
    const q = qualityIndex(quality);
    return {
      quality,
      sincLen: this.#x.rs_quality_sinc_len(q),
      oversampling: this.#x.rs_quality_oversampling(q),
    };
  }
}

/** Instantiate the engine from a compiled module (synchronous). */
export function engineFromModule(module: WebAssembly.Module): RubatoEngine {
  return new RubatoEngine(new WebAssembly.Instance(module, {}));
}

/**
 * Instantiate the engine from a module or raw bytes. Compiling from bytes is
 * not allowed on Cloudflare Workers; use the `workerd` entry there.
 */
export async function engineFromSource(
  source: WebAssembly.Module | BufferSource,
): Promise<RubatoEngine> {
  if (source instanceof WebAssembly.Module) return engineFromModule(source);
  // Compile, then instantiate, both async (browsers restrict synchronous
  // instantiation of large modules); unambiguous across lib.dom typings.
  const module = await WebAssembly.compile(source as BufferSource);
  const instance: WebAssembly.Instance = await WebAssembly.instantiate(module, {});
  return new RubatoEngine(instance);
}

// ---------------------------------------------------------------------------
// soxr-compatible facade
// ---------------------------------------------------------------------------

/** Mirrors python-soxr's `soxr.ResampleStream` (int16 or float32, by first use). */
export interface SoxrCompatibleStream {
  resampleChunk<T extends Int16Array | Float32Array>(chunk: T, last?: boolean): T;
  clear(): void;
  destroy(): void;
}

/**
 * The shape core's `SOXRAudioResampler` / `SOXRStreamAudioResampler` delegate
 * to: `resample` stands in for `soxr.resample()` and `createStream` for
 * `soxr.ResampleStream(...)`.
 */
export interface SoxrCompatibleEngine {
  resample<T extends Int16Array | Float32Array>(
    audio: T,
    inRate: number,
    outRate: number,
    quality: Quality,
  ): T;
  createStream(options: {
    inRate: number;
    outRate: number;
    numChannels: number;
    quality: Quality;
  }): SoxrCompatibleStream;
}

/** Wrap an engine in the soxr-shaped API core expects. */
export function createSoxrCompatibleEngine(engine: RubatoEngine): SoxrCompatibleEngine {
  return {
    resample<T extends Int16Array | Float32Array>(
      audio: T,
      inRate: number,
      outRate: number,
      quality: Quality,
    ): T {
      if (audio instanceof Float32Array)
        return engine.resampleFloat32(audio, inRate, outRate, { quality }) as T;
      return engine.resampleSamples(audio as Int16Array, inRate, outRate, { quality }) as T;
    },
    createStream({ inRate, outRate, numChannels, quality }) {
      const stream = engine.createStream(inRate, outRate, { quality, channels: numChannels });
      return {
        resampleChunk<T extends Int16Array | Float32Array>(chunk: T, last = false): T {
          if (chunk instanceof Float32Array) {
            const head = stream.processFloat32(chunk);
            if (!last) return head as T;
            const tail = stream.flushFloat32();
            const out = new Float32Array(head.length + tail.length);
            out.set(head);
            out.set(tail, head.length);
            return out as T;
          }
          const head = stream.processSamples(chunk as Int16Array);
          if (!last) return head as T;
          const tail = stream.flushSamples();
          const out = new Int16Array(head.length + tail.length);
          out.set(head);
          out.set(tail, head.length);
          return out as T;
        },
        clear: () => stream.reset(),
        destroy: () => stream.destroy(),
      };
    },
  };
}
