// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Media primitives with aiortc's and PyAV's shapes: frames, tracks, the
 * events they emit, and an audio resampler.
 *
 * Upstream's SmallWebRTC code is written against aiortc (`MediaStreamTrack`,
 * `AudioStreamTrack`, `VideoStreamTrack`, `MediaStreamError`) and PyAV
 * (`AudioFrame`, `VideoFrame`, `AudioResampler`). These classes keep those
 * names and behaviors so the port reads like upstream.
 */

import { createTask, Queue, sleep, time } from "@pipedog/asyncio";
import type { BaseAudioResampler } from "@pipedog/core/audio/resamplers/base_audio_resampler";
import { createStreamResampler } from "@pipedog/core/audio/utils";
import { logger } from "@pipedog/core/utils/logger";

import { VideoFrame } from "./video.ts";

export { VideoFrame } from "./video.ts";

// ---------------------------------------------------------------------------
// Events

type Listener = (...args: any[]) => unknown;

function isAsyncFunction(fn: Listener): boolean {
  const name = fn.constructor?.name;
  return name === "AsyncFunction" || name === "AsyncGeneratorFunction";
}

/**
 * pyee's `AsyncIOEventEmitter`, which aiortc objects extend: `emit()` calls
 * plain handlers inline and runs async handlers in a task of their own.
 */
export class EventEmitter {
  #listeners = new Map<string, Listener[]>();

  /** Add a handler for `event`, and return it. */
  on<F extends Listener>(event: string, handler: F): F {
    const list = this.#listeners.get(event);
    if (list) list.push(handler);
    else this.#listeners.set(event, [handler]);
    return handler;
  }

  /** Remove a handler. */
  off(event: string, handler: Listener): void {
    const list = this.#listeners.get(event);
    if (!list) return;
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
  }

  /** Call the handlers of `event`. Returns whether there were any. */
  emit(event: string, ...args: unknown[]): boolean {
    const list = this.#listeners.get(event);
    if (!list || list.length === 0) return false;
    for (const handler of [...list]) {
      if (isAsyncFunction(handler)) {
        const task = createTask(async () => {
          await handler(...args);
        }, `${this.constructor.name}::${event}`);
        task.addDoneCallback((t) => {
          if (t.cancelled()) return;
          const e = t.exception();
          if (e !== undefined)
            logger.error(`${this.constructor.name}: error in '${event}' handler: ${e}`, e);
        });
      } else {
        handler(...args);
      }
    }
    return true;
  }

  /** Remove every handler, of `event` or of all events. */
  removeAllListeners(event?: string): void {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
  }

  listenerCount(event: string): number {
    return this.#listeners.get(event)?.length ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Frames

/** Channel layouts of 16-bit PCM audio frames. */
export type AudioLayoutName = "mono" | "stereo";

function layoutChannels(layout: AudioLayoutName): number {
  return layout === "stereo" ? 2 : 1;
}

/** A raw audio frame: 16-bit signed interleaved PCM (PyAV's `AudioFrame`, format `s16`). */
export class AudioFrame {
  data: Int16Array;
  sampleRate: number;
  layout: { name: AudioLayoutName; channels: number };
  readonly format = { name: "s16" };
  /** Presentation timestamp, in `timeBase` units. */
  pts: number | null;
  /** Seconds per `pts` unit. */
  timeBase: number;

  constructor(options: {
    data: Int16Array;
    sampleRate: number;
    layout?: AudioLayoutName;
    pts?: number | null;
    timeBase?: number;
  }) {
    const layout = options.layout ?? "mono";
    this.data = options.data;
    this.sampleRate = options.sampleRate;
    this.layout = { name: layout, channels: layoutChannels(layout) };
    this.pts = options.pts ?? null;
    this.timeBase = options.timeBase ?? 1 / options.sampleRate;
  }

  /** Samples per channel. */
  get samples(): number {
    return this.data.length / this.layout.channels;
  }

  /** A frame of interleaved samples (`AudioFrame.from_ndarray`). */
  static fromNdarray(
    data: Int16Array,
    options: { layout?: AudioLayoutName; sampleRate: number },
  ): AudioFrame {
    return new AudioFrame({
      data,
      sampleRate: options.sampleRate,
      layout: options.layout ?? "mono",
    });
  }

  /** The interleaved samples (`AudioFrame.to_ndarray`). */
  toNdarray(): Int16Array {
    return this.data;
  }

  /** The samples as little-endian bytes. */
  toBytes(): Uint8Array {
    return new Uint8Array(this.data.buffer, this.data.byteOffset, this.data.byteLength);
  }
}

/** Raised by `recv()` once a track has ended (aiortc's `MediaStreamError`). */
export class MediaStreamError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "MediaStreamError";
  }
}

// ---------------------------------------------------------------------------
// Tracks

let trackCounter = 0;

/** A media track (aiortc's `MediaStreamTrack`). Emits `"ended"` when stopped. */
export abstract class MediaStreamTrack extends EventEmitter {
  abstract readonly kind: "audio" | "video";
  readonly id: string = globalThis.crypto?.randomUUID?.() ?? `track-${++trackCounter}`;
  #ended = false;

  /** `"live"`, or `"ended"` once stopped. */
  get readyState(): "live" | "ended" {
    return this.#ended ? "ended" : "live";
  }

  /** Receive the next frame. */
  abstract recv(): Promise<AudioFrame | VideoFrame>;

  /** Stop the track. */
  stop(): void {
    if (!this.#ended) {
      this.#ended = true;
      this.emit("ended");
      this.removeAllListeners();
    }
  }
}

const AUDIO_PTIME = 0.02; // 20ms audio packetization

/** A track that sends 20 ms of silence at 8 kHz (aiortc's `AudioStreamTrack`). */
export class AudioStreamTrack extends MediaStreamTrack {
  readonly kind = "audio" as const;
  protected _start = 0;
  protected _timestamp: number | null = null;

  async recv(): Promise<AudioFrame | VideoFrame> {
    if (this.readyState !== "live") throw new MediaStreamError();
    const sampleRate = 8000;
    const samples = Math.trunc(AUDIO_PTIME * sampleRate);
    if (this._timestamp !== null) {
      this._timestamp += samples;
      const wait = this._start + this._timestamp / sampleRate - time();
      await sleep(Math.max(0, wait));
    } else {
      this._start = time();
      this._timestamp = 0;
    }
    const frame = new AudioFrame({ data: new Int16Array(samples), sampleRate });
    frame.pts = this._timestamp;
    return frame;
  }
}

/** The RTP clock rate of video. */
export const VIDEO_CLOCK_RATE = 90000;
/** The time between frames of `VideoStreamTrack`. */
export const VIDEO_PTIME = 1 / 30;
/** Seconds per video `pts` unit. */
export const VIDEO_TIME_BASE = 1 / VIDEO_CLOCK_RATE;

/** A track that sends green 640x480 frames at 30 fps (aiortc's `VideoStreamTrack`). */
export class VideoStreamTrack extends MediaStreamTrack {
  readonly kind = "video" as const;
  protected _start = 0;
  protected _timestamp: number | null = null;

  /** Wait until the next frame is due and return its `[pts, timeBase]`. */
  async nextTimestamp(): Promise<[number, number]> {
    if (this.readyState !== "live") throw new MediaStreamError();
    if (this._timestamp !== null) {
      this._timestamp += Math.trunc(VIDEO_PTIME * VIDEO_CLOCK_RATE);
      const wait = this._start + this._timestamp / VIDEO_CLOCK_RATE - time();
      await sleep(Math.max(0, wait));
    } else {
      this._start = time();
      this._timestamp = 0;
    }
    return [this._timestamp, VIDEO_TIME_BASE];
  }

  async recv(): Promise<AudioFrame | VideoFrame> {
    const [pts, timeBase] = await this.nextTimestamp();
    const width = 640;
    const height = 480;
    // yuv420p green: Y=0, U=V=0 (BT.601 limited range renders this as green).
    const frame = new VideoFrame({
      width,
      height,
      format: "yuv420p",
      data: new Uint8Array(width * height * 1.5),
    });
    frame.pts = pts;
    frame.timeBase = timeBase;
    return frame;
  }
}

/** A track received from the peer (aiortc's `RemoteStreamTrack`). */
export class RemoteStreamTrack extends MediaStreamTrack {
  readonly kind: "audio" | "video";
  /** Decoded frames waiting for `recv()`; `null` ends the track. */
  readonly _queue = new Queue<AudioFrame | VideoFrame | null>();

  constructor(kind: "audio" | "video", id?: string) {
    super();
    this.kind = kind;
    if (id !== undefined) (this as { id: string }).id = id;
  }

  async recv(): Promise<AudioFrame | VideoFrame> {
    if (this.readyState !== "live") throw new MediaStreamError();
    const frame = await this._queue.get();
    if (frame === null) {
      this.stop();
      throw new MediaStreamError();
    }
    return frame;
  }
}

// ---------------------------------------------------------------------------
// Resampling

/**
 * Converts audio frames to a sample rate and channel layout (PyAV's
 * `AudioResampler`, for format `s16`), with core's stream resampler.
 */
export class AudioResampler {
  readonly format: string;
  readonly layout: AudioLayoutName;
  readonly rate: number;
  #resamplers: BaseAudioResampler[] = [];
  #inRate = 0;

  constructor(format: string, layout: AudioLayoutName, rate: number) {
    if (format !== "s16") throw new Error(`Unsupported sample format: ${format}`);
    this.format = format;
    this.layout = layout;
    this.rate = rate;
  }

  /** Resample a frame; returns the converted frames (none while the filter fills). */
  async resample(frame: AudioFrame): Promise<AudioFrame[]> {
    const outChannels = layoutChannels(this.layout);
    const planes = splitChannels(frame.data, frame.layout.channels, outChannels);
    let outPlanes = planes;
    if (frame.sampleRate !== this.rate) {
      if (this.#inRate !== frame.sampleRate || this.#resamplers.length !== outChannels) {
        this.#inRate = frame.sampleRate;
        this.#resamplers = planes.map(() => createStreamResampler({ clearAfterSecs: null }));
      }
      outPlanes = [];
      for (let c = 0; c < planes.length; c++) {
        const bytes = await this.#resamplers[c]!.resample(
          new Uint8Array(planes[c]!.buffer, planes[c]!.byteOffset, planes[c]!.byteLength),
          frame.sampleRate,
          this.rate,
        );
        outPlanes.push(toInt16(bytes));
      }
    }
    const samples = Math.min(...outPlanes.map((p) => p.length));
    if (samples === 0) return [];
    const data = new Int16Array(samples * outChannels);
    for (let c = 0; c < outChannels; c++) {
      const plane = outPlanes[c]!;
      for (let i = 0; i < samples; i++) data[i * outChannels + c] = plane[i]!;
    }
    const out = new AudioFrame({ data, sampleRate: this.rate, layout: this.layout });
    out.pts = frame.pts;
    return [out];
  }
}

function toInt16(bytes: Uint8Array): Int16Array {
  if (bytes.byteOffset % 2 === 0) {
    return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  }
  return new Int16Array(bytes.slice().buffer);
}

/** Split interleaved samples into `outChannels` planes, mixing down or duplicating. */
function splitChannels(data: Int16Array, inChannels: number, outChannels: number): Int16Array[] {
  const samples = Math.floor(data.length / inChannels);
  const planes: Int16Array[] = [];
  for (let c = 0; c < outChannels; c++) planes.push(new Int16Array(samples));
  for (let i = 0; i < samples; i++) {
    if (inChannels === outChannels) {
      for (let c = 0; c < outChannels; c++) planes[c]![i] = data[i * inChannels + c]!;
    } else if (outChannels === 1) {
      let sum = 0;
      for (let c = 0; c < inChannels; c++) sum += data[i * inChannels + c]!;
      planes[0]![i] = Math.round(sum / inChannels);
    } else {
      for (let c = 0; c < outChannels; c++)
        planes[c]![i] = data[i * inChannels + (c % inChannels)]!;
    }
  }
  return planes;
}
