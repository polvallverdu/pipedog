// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Synthesized audio kept for reuse by `TTSService` (its `audioCache` option).
 *
 * Fixed lines (a greeting, a disclaimer, a hold message) are synthesized again
 * on every call that says them. With a cache, a service that already has the
 * audio for a line serves it at once, with no request to the provider. The
 * cache is keyed by the text and everything the audio depends on (service,
 * settings, sample rate), so it can be shared by every service in a process.
 *
 * Not in upstream Pipecat.
 */

/**
 * Where a `TTSService` keeps synthesized audio: 16-bit mono PCM at the
 * service's sample rate, by key. `TTSAudioCache` keeps it in memory; implement
 * this interface to keep it elsewhere (methods may return promises).
 */
export interface TTSAudioCacheStore {
  /** The audio stored for `key`, if any. */
  get(key: string): Uint8Array | null | undefined | Promise<Uint8Array | null | undefined>;
  /** Store the audio for `key`, replacing any previous entry. */
  set(key: string, audio: Uint8Array): void | Promise<void>;
}

export interface TTSAudioCacheOptions {
  /** Most audio kept, in bytes; the least recently used entries go first. Defaults to 32 MiB. */
  maxBytes?: number;
}

/**
 * An in-memory `TTSAudioCacheStore`, bounded by size, that drops the least
 * recently used audio first.
 *
 * @example
 * const audioCache = new TTSAudioCache({ maxBytes: 16 * 1024 * 1024 });
 * const tts = new OpenAITTSService({ apiKey, audioCache });
 * await tts.warmAudioCache("Hi! Thanks for calling.", { sampleRate: 24000 });
 */
export class TTSAudioCache implements TTSAudioCacheStore {
  readonly maxBytes: number;
  #entries = new Map<string, Uint8Array>();
  #bytes = 0;

  constructor(options: TTSAudioCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  }

  /** Bytes of audio currently kept. */
  get bytes(): number {
    return this.#bytes;
  }

  /** Number of entries currently kept. */
  get size(): number {
    return this.#entries.size;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  get(key: string): Uint8Array | undefined {
    const audio = this.#entries.get(key);
    if (audio === undefined) return undefined;
    // Most recently used goes last.
    this.#entries.delete(key);
    this.#entries.set(key, audio);
    return audio;
  }

  set(key: string, audio: Uint8Array): void {
    this.delete(key);
    if (audio.byteLength > this.maxBytes) return;
    this.#entries.set(key, audio);
    this.#bytes += audio.byteLength;
    for (const [oldest, value] of this.#entries) {
      if (this.#bytes <= this.maxBytes) break;
      this.#entries.delete(oldest);
      this.#bytes -= value.byteLength;
    }
  }

  delete(key: string): boolean {
    const audio = this.#entries.get(key);
    if (audio === undefined) return false;
    this.#entries.delete(key);
    this.#bytes -= audio.byteLength;
    return true;
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }
}
