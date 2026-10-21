// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/mixers/soundfile_mixer.py

/**
 * Soundfile-based audio mixer for file playback integration.
 *
 * Provides an audio mixer that combines incoming audio with audio loaded from
 * sound files. Supports runtime configuration changes.
 *
 * PORTING NOTES:
 * - DIVERGENCE: upstream reads files with libsndfile (WAV, FLAC, Ogg, AIFF, ...). Here
 *   the files are parsed by a small pure-TypeScript WAV reader (`./wav.ts`), so only WAV
 *   is supported (PCM 8/16/24/32-bit, float, A-law, mu-law, incl. WAVE_FORMAT_EXTENSIBLE).
 *   FLAC, Ogg/Vorbis/Opus, MP3, AIFF and the rest are rejected with an error that says
 *   so (logged, and the sound is skipped, as for any unreadable file upstream). Convert
 *   them to WAV first.
 * - DIVERGENCE: a sound source can be bytes (`Uint8Array`/`ArrayBuffer`), a `URL` or an
 *   `http(s):`/`file:`/`data:` URL string (fetched), or a path. A path needs a
 *   filesystem: it is read through `fileSystem` (default: `node:fs/promises`, imported
 *   lazily, so Cloudflare Workers can use the mixer with bytes or URLs).
 * - `asyncio.to_thread` is gone: parsing a WAV file is quick, and the reads are async.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { BaseAudioMixer } from "@pipedog/core/audio/mixers/base_audio_mixer";
import {
  type MixerControlFrame,
  MixerEnableFrame,
  MixerUpdateSettingsFrame,
} from "@pipedog/core/frames/frames";
import { logger } from "@pipedog/core/utils/logger";
import { readWavSound } from "./wav.ts";

/** Where a sound comes from: WAV bytes, a URL, or a file path (where a filesystem exists). */
export type SoundSource = Uint8Array | ArrayBuffer | URL | string;

/** The part of `node:fs/promises` the mixer needs to read a path. */
export interface SoundFileSystem {
  readFile(path: string): Promise<Uint8Array>;
}

export interface SoundfileMixerOptions {
  /** Mapping of sound names to sources (a path, URL or WAV bytes) for loading. */
  soundFiles: Record<string, SoundSource>;
  /** Name of the default sound to play initially. */
  defaultSound: string;
  /** Mixing volume level (0.0 to 1.0). Defaults to 0.4. */
  volume?: number;
  /** Whether mixing is initially enabled. Defaults to true. */
  mixing?: boolean;
  /** Whether to loop audio files when they end. Defaults to true. */
  loop?: boolean;
  /**
   * The filesystem used to read sources given as a path (default: `node:fs/promises`,
   * imported on first use). Not needed for bytes or URLs.
   */
  fileSystem?: SoundFileSystem | null;
}

const URL_SCHEME = /^(https?|file|data):/i;

/**
 * Audio mixer that combines incoming audio with file-based audio.
 *
 * This is an audio mixer that mixes incoming audio with audio from a file. The
 * audio files need to only have one channel (mono) and it needs to match the
 * sample rate of the output transport.
 *
 * Multiple files can be loaded, each with a different name. The
 * `MixerUpdateSettingsFrame` has the following settings available: `sound`
 * (str) and `volume` (float) to be able to update to a different sound file or
 * to change the volume at runtime.
 */
export class SoundfileMixer extends BaseAudioMixer {
  protected _soundFiles: Record<string, SoundSource>;
  protected _volume: number;
  protected _sampleRate = 0;
  protected _soundPos = 0;
  protected _sounds: Record<string, Int16Array> = {};
  protected _currentSound: string;
  protected _mixing: boolean;
  protected _loop: boolean;
  #fileSystem: SoundFileSystem | null;

  /**
   * @param options `soundFiles` and `defaultSound` are required; see `SoundfileMixerOptions`.
   */
  constructor(options: SoundfileMixerOptions) {
    super();
    this._soundFiles = options.soundFiles;
    this._volume = options.volume ?? 0.4;
    this._currentSound = options.defaultSound;
    this._mixing = options.mixing ?? true;
    this._loop = options.loop ?? true;
    this.#fileSystem = options.fileSystem ?? null;
  }

  /**
   * Initialize the mixer and load all sound files.
   *
   * @param sampleRate The sample rate of the output transport in Hz.
   */
  async start(sampleRate: number): Promise<void> {
    this._sampleRate = sampleRate;
    for (const [soundName, source] of Object.entries(this._soundFiles)) {
      await this._loadSoundFile(soundName, source);
    }
  }

  /**
   * Clean up mixer resources.
   *
   * Currently performs no cleanup as sound data is managed by garbage collection.
   */
  async stop(): Promise<void> {}

  /**
   * Process mixer control frames to update settings or enable/disable mixing.
   *
   * @param frame The mixer control frame to process.
   */
  async processFrame(frame: MixerControlFrame): Promise<void> {
    if (frame instanceof MixerUpdateSettingsFrame) {
      await this._updateSettings(frame);
    } else if (frame instanceof MixerEnableFrame) {
      await this._enableMixing(frame.enable);
    }
  }

  /**
   * Mix transport audio with the current sound file.
   *
   * @param audio Raw audio bytes from the transport to mix.
   * @returns Mixed audio bytes combining transport and file audio.
   */
  async mix(audio: Uint8Array): Promise<Uint8Array> {
    return this._mixWithSound(audio);
  }

  /** Enable or disable audio mixing. */
  protected async _enableMixing(enable: boolean): Promise<void> {
    this._mixing = enable;
  }

  /** Update mixer settings from a control frame. */
  protected async _updateSettings(frame: MixerUpdateSettingsFrame): Promise<void> {
    for (const [setting, value] of Object.entries(frame.settings)) {
      switch (setting) {
        case "sound":
          await this._changeSound(value as string);
          break;
        case "volume":
          await this._updateVolume(value as number);
          break;
        case "loop":
          await this._updateLoop(value as boolean);
          break;
      }
    }
  }

  /**
   * Change the currently playing sound file.
   *
   * @param sound Name of the sound file to switch to.
   */
  protected async _changeSound(sound: string): Promise<void> {
    if (Object.hasOwn(this._soundFiles, sound)) {
      this._currentSound = sound;
      this._soundPos = 0;
    } else {
      logger.error(`Sound ${sound} is not available`);
    }
  }

  /** Update the mixing volume level. */
  protected async _updateVolume(volume: number): Promise<void> {
    this._volume = volume;
  }

  /** Update the looping behavior. */
  protected async _updateLoop(loop: boolean): Promise<void> {
    this._loop = loop;
  }

  /** The bytes of a sound source. */
  protected async _readSource(source: SoundSource): Promise<Uint8Array> {
    if (source instanceof Uint8Array) return source;
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    if (source instanceof URL || URL_SCHEME.test(source)) {
      const url = source instanceof URL ? source : new URL(source);
      if (url.protocol === "file:") return this._readPath(decodeURIComponent(url.pathname));
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return new Uint8Array(await response.arrayBuffer());
    }
    return this._readPath(source);
  }

  /** Read a file path, lazily importing `node:fs/promises` when no filesystem was given. */
  protected async _readPath(path: string): Promise<Uint8Array> {
    if (!this.#fileSystem) {
      try {
        // A variable specifier keeps bundlers (and Workers builds) from resolving it.
        const specifier = "node:fs/promises";
        this.#fileSystem = (await import(specifier)) as SoundFileSystem;
      } catch (e) {
        rethrowIfCancelled(e);
        throw new Error(
          `cannot read "${path}": this runtime has no filesystem; pass the sound as bytes or a URL`,
        );
      }
    }
    return new Uint8Array(await this.#fileSystem.readFile(path));
  }

  /** Load an audio file into memory for mixing. */
  protected async _loadSoundFile(soundName: string, source: SoundSource): Promise<void> {
    const label = typeof source === "string" || source instanceof URL ? String(source) : soundName;
    try {
      logger.debug(`Loading mixer sound from ${label}`);
      const { samples, sampleRate, numChannels } = readWavSound(await this._readSource(source));

      if (sampleRate === this._sampleRate) {
        if (numChannels !== 1) {
          // Upstream does not check either: the interleaved samples play back as one channel.
          logger.warning(`Sound file ${label} has ${numChannels} channels (should be mono)`);
        }
        this._sounds[soundName] = samples;
      } else {
        logger.warning(
          `Sound file ${label} has incorrect sample rate ${sampleRate} (should be ${this._sampleRate})`,
        );
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Unable to open file ${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Mix raw audio frames with chunks of the same length from the sound file. */
  protected _mixWithSound(audio: Uint8Array): Uint8Array {
    if (!this._mixing || !Object.hasOwn(this._sounds, this._currentSound)) {
      return audio;
    }

    // Copied: the bytes may not be 2-aligned.
    const audioNp = new Int16Array(audio.length >> 1);
    new Uint8Array(audioNp.buffer).set(audio.subarray(0, audioNp.length * 2));
    const chunkSize = audioNp.length;

    // Sound currently playing.
    const sound = this._sounds[this._currentSound] as Int16Array;

    // Go back to the beginning if we don't have enough data.
    if (this._soundPos + chunkSize > sound.length) {
      if (!this._loop) {
        return audio;
      }
      this._soundPos = 0;
    }

    const startPos = this._soundPos;
    const endPos = this._soundPos + chunkSize;
    this._soundPos = endPos;

    const soundNp = sound.subarray(startPos, endPos);

    const mixed = new Int16Array(chunkSize);
    for (let i = 0; i < chunkSize; i++) {
      const v = (audioNp[i] as number) + (soundNp[i] as number) * this._volume;
      mixed[i] = Math.trunc(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
    }
    return new Uint8Array(mixed.buffer);
  }
}
