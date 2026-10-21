// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/tts.py

/**
 * The user's voice: a caching TTS in the harness pipeline.
 *
 * In audio mode the harness synthesizes each user turn and streams it to the
 * bot. `CachingTTSService` wraps a real TTS service and caches its audio on
 * disk, keyed by service, voice, model, language, speed, and text, so a
 * scripted utterance is synthesized once and reused across runs and bots.
 *
 * Only local and HTTP (Cartesia) services fit, since the wrapper reads the
 * inner service's `runTts` generator directly.
 *
 * The disk cache uses `node:fs/promises`, imported when a file is first read
 * or written, so importing this module stays portable.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { pcmToWav, readWav } from "@pipedog/core/audio/utils";
import type { CancelFrame } from "@pipedog/core/frames/frames";
import {
  type EndFrame,
  ErrorFrame,
  type Frame,
  StartFrame,
  TTSAudioRawFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { WebsocketService } from "@pipedog/core/services/websocket_service";
import { getEnv } from "@pipedog/core/utils/env";
import { logger } from "@pipedog/core/utils/logger";

import { pyFloat, pyFloatStr, pyStr, pyStrRepr, sha256Hex } from "./_pyutil.ts";

/** A `user_audio` (`user.speech`) config mapping. */
export type VoiceConfig = Record<string, unknown>;

function _defaultCacheDir(): string {
  // DIVERGENCE: Python's `Path.home()`; read from `$HOME` (or `%USERPROFILE%`)
  // so that this module imports without `node:os`.
  const root = getEnv("XDG_CACHE_HOME");
  const base = root ? root : `${getEnv("HOME") ?? getEnv("USERPROFILE") ?? "~"}/.cache`;
  return `${base}/pipecat/evals/tts`;
}

export const DEFAULT_CACHE_DIR = _defaultCacheDir();

// Default sample rate for generated audio (matches pipecat input default).
export const DEFAULT_SAMPLE_RATE = 16000;

/** The sample rate a `user_audio` block asks for (default 16 kHz). */
export function ttsSampleRate(voiceCfg: VoiceConfig): number {
  const value = voiceCfg.sample_rate;
  return Math.trunc(value === undefined ? DEFAULT_SAMPLE_RATE : pyFloat(value));
}

/** A stable identity for a `user_audio` config: service, voice, model, language, and speed, not the sample rate. */
export function ttsCacheKey(voiceCfg: VoiceConfig): string {
  const service = pyStr(voiceCfg.service ?? "").toLowerCase();
  const voice = pyStr(voiceCfg.voice ?? "");
  const model = pyStr(voiceCfg.model ?? "");
  const language = pyStr(voiceCfg.language || "");
  const speed = voiceCfg.speed;
  // An absent speed and the service's default rate render the same audio.
  const speedKey =
    speed === undefined || speed === null || pyFloat(speed) === 1.0
      ? ""
      : pyFloatStr(pyFloat(speed));
  return [service, voice, model, language, speedKey].join("\x00");
}

/** Resolve the cache directory: explicit override > env var > default. */
async function _resolveCacheDir(override: string | null): Promise<string> {
  let base: string;
  if (override !== null) {
    base = override;
  } else if (getEnv("PIPECAT_EVALS_CACHE_DIR")) {
    base = getEnv("PIPECAT_EVALS_CACHE_DIR") as string;
  } else {
    base = DEFAULT_CACHE_DIR;
  }
  const fs = await import("node:fs/promises");
  await fs.mkdir(base, { recursive: true });
  return base;
}

/** Read a mono 16-bit PCM WAV file. Returns `[pcmBytes, sampleRate]`. */
async function _readWav(path: string): Promise<[Uint8Array, number]> {
  const fs = await import("node:fs/promises");
  const wav = readWav(new Uint8Array(await fs.readFile(path)));
  if (wav.numChannels !== 1) {
    throw new Error(`${path}: expected mono, got ${wav.numChannels} channels`);
  }
  if (wav.sampleWidth !== 2) {
    throw new Error(`${path}: expected 16-bit, got ${wav.sampleWidth * 8}-bit`);
  }
  return [wav.audio, wav.sampleRate];
}

/** Write mono 16-bit PCM to a WAV file. */
async function _writeWav(path: string, pcm: Uint8Array, sampleRate: number): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.writeFile(path, pcmToWav(pcm, sampleRate, 1));
}

async function _exists(path: string): Promise<boolean> {
  const fs = await import("node:fs/promises");
  try {
    await fs.access(path);
    return true;
  } catch (e) {
    rethrowIfCancelled(e);
    return false;
  }
}

function _concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface CachingTTSServiceOptions extends TTSServiceOptions {
  /**
   * Stable identity for the inner config (see `ttsCacheKey`); combined with
   * the text to key the cache.
   */
  cacheKey: string;
  /**
   * Where to store cached audio. Defaults to
   * `<user-cache-dir>/pipecat/evals/tts` (or `$PIPECAT_EVALS_CACHE_DIR`).
   */
  cacheDir?: string | null;
  /** When false, ignore cached audio and don't write new files. */
  useCache?: boolean;
}

/**
 * A pipeline TTS that wraps a real service and caches its audio on disk.
 *
 * On a `TTSSpeakFrame` it emits the cached audio when present, otherwise it
 * runs the wrapped service, caches the audio, and forwards it. The inner
 * service's lifecycle is forwarded so it works inside the pipeline. Only
 * local and HTTP inner services are supported.
 */
export class CachingTTSService extends TTSService {
  protected _inner: TTSService;
  protected _cacheKey: string;
  protected _cacheDirOverride: string | null;
  protected _useCache: boolean;

  /**
   * Initialize the caching TTS.
   *
   * @param inner The local/HTTP `TTSService` that does the synthesis.
   * @param options The cache key and location; other options are passed to
   *   `TTSService`.
   * @throws Error If `inner` is a websocket-streaming TTS service (its
   *   `runTts` doesn't yield audio); use a local or HTTP service.
   */
  constructor(inner: TTSService, options: CachingTTSServiceOptions) {
    if (inner instanceof WebsocketService) {
      throw new Error(
        `CachingTTSService supports only local or HTTP TTS services, not the ` +
          `websocket-streaming ${inner.constructor.name}. Use an HTTP variant ` +
          "(e.g. CartesiaHttpTTSService) or a local service.",
      );
    }
    const { cacheKey: _k, cacheDir: _d, useCache: _u, ...rest } = options;
    super(rest);
    this._inner = inner;
    this._cacheKey = options.cacheKey;
    this._cacheDirOverride = options.cacheDir ?? null;
    this._useCache = options.useCache ?? true;
  }

  /**
   * Set up this service and forward setup to the inner service.
   *
   * DIVERGENCE: upstream starts the inner service with a `StartFrame` carrying
   * this service's sample rate and metrics off. Pipedog's `StartFrame` has no
   * such fields (they come from the setup), so the inner service is set up
   * with them instead.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._inner.setup(
      new FrameProcessorSetup({
        ...setup,
        audioOutSampleRate: this.sampleRate,
        enableMetrics: false,
      }),
    );
  }

  /** Start this service and the inner one, the inner with metrics off since it has no downstream. */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    await this._inner.start(new StartFrame());
  }

  /** Stop the inner service, then this one. */
  override async stop(frame: EndFrame): Promise<void> {
    await this._inner.stop(frame);
    await super.stop(frame);
  }

  /** Cancel the inner service, then this one. */
  override async cancel(frame: CancelFrame): Promise<void> {
    await this._inner.cancel(frame);
    await super.cancel(frame);
  }

  /** Clean up the inner service, then this one. */
  override async cleanup(): Promise<void> {
    await this._inner.cleanup();
    await super.cleanup();
  }

  /**
   * Return the audio for `text`, from cache or by driving the inner service.
   *
   * @param text The utterance to synthesize.
   * @returns The utterance as 16-bit mono PCM, at this service's sample rate.
   */
  async synthesize(text: string): Promise<Uint8Array> {
    const audio: Uint8Array[] = [];
    for await (const frame of this.runTts(text, this.createContextId())) {
      if (frame instanceof TTSAudioRawFrame) {
        audio.push(frame.audio);
      }
    }
    return _concat(audio);
  }

  /**
   * Emit the audio for `text` from cache, or by driving the inner service.
   *
   * @param text The utterance to synthesize.
   * @param contextId TTS context id (forwarded to the inner service).
   * @yields `TTSStartedFrame` / `TTSAudioRawFrame` / `TTSStoppedFrame` (cache
   *   hit), or the inner service's own frames (cache miss).
   */
  async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const cacheFile = this._useCache ? await this._cacheFile(text) : null;

    if (cacheFile !== null && (await _exists(cacheFile))) {
      let hit: Uint8Array | null = null;
      try {
        const [pcm, cachedSr] = await _readWav(cacheFile);
        if (cachedSr === this.sampleRate) {
          hit = pcm;
        } else {
          logger.info(
            `Cache SR ${cachedSr} != requested ${this.sampleRate} ` +
              `for ${pyStrRepr(text)} — regenerating`,
          );
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(
          `Cache read failed for ${cacheFile}: ${e instanceof Error ? e.message : String(e)} — regenerating`,
        );
      }
      if (hit !== null) {
        yield new TTSStartedFrame();
        yield new TTSAudioRawFrame({ audio: hit, sampleRate: this.sampleRate, numChannels: 1 });
        yield new TTSStoppedFrame();
        return;
      }
    }

    // Cache miss: drive the inner service, capturing its audio as we forward it.
    const captured: Uint8Array[] = [];
    for await (const frame of this._inner.runTts(text, contextId)) {
      if (frame instanceof TTSAudioRawFrame) {
        captured.push(frame.audio);
      } else if (frame instanceof ErrorFrame) {
        logger.warning(`TTS error during synthesis of ${pyStrRepr(text)}: ${frame.error}`);
      }
      yield frame;
    }

    const audio = _concat(captured);
    if (cacheFile !== null && audio.length > 0) {
      await _writeWav(cacheFile, audio, this.sampleRate);
    }
  }

  /** Resolve the WAV cache path for `text` (keyed by config identity + text). */
  protected async _cacheFile(text: string): Promise<string> {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    for (const part of [this._cacheKey, text]) {
      // Lower-case so trivial casing differences hit the same slot.
      parts.push(encoder.encode(part.toLowerCase()));
      parts.push(new Uint8Array([0]));
    }
    const dir = await _resolveCacheDir(this._cacheDirOverride);
    return `${dir.replace(/[\\/]+$/, "")}/${sha256Hex(_concat(parts))}.wav`;
  }
}
