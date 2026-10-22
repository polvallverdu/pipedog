// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/minimax/tts.py

/**
 * MiniMax text-to-speech service implementation.
 *
 * This module provides integration with MiniMax's T2A (Text-to-Audio) API
 * for streaming text-to-speech synthesis.
 *
 * Porting notes:
 * - The HTTP request goes through `fetch`. Upstream's required `aiohttp_session`
 *   becomes an optional `fetch` function (defaults to the global `fetch`).
 * - Not ported, as deprecated upstream: `InputParams` and the `params`, `model` and
 *   `voice_id` constructor arguments. Use `settings`.
 */

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  type StartFrame,
  TTSAudioRawFrame,
} from "@pipedog/core/frames/frames";
import {
  type ServiceSettings,
  TTSSettings,
  type TTSSettingsOptions,
} from "@pipedog/core/services/settings";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Convert a Language enum to MiniMax language format.
 *
 * @param language The Language enum value to convert.
 * @returns The corresponding MiniMax language name. If `language` is not in
 *   the verified mapping, falls back to its base language's name (`pt-BR`
 *   becomes `Portuguese`) and logs a warning (via
 *   `resolveLanguage(..., true)`).
 */
export function languageToMinimaxLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.AF]: "Afrikaans",
    [Language.AR]: "Arabic",
    [Language.BG]: "Bulgarian",
    [Language.CA]: "Catalan",
    [Language.CS]: "Czech",
    [Language.DA]: "Danish",
    [Language.DE]: "German",
    [Language.EL]: "Greek",
    [Language.EN]: "English",
    [Language.ES]: "Spanish",
    [Language.FA]: "Persian", // Only supported by speech-2.6-* models
    [Language.FI]: "Finnish",
    [Language.FIL]: "Filipino", // Only supported by speech-2.6-* models
    [Language.FR]: "French",
    [Language.HE]: "Hebrew",
    [Language.HI]: "Hindi",
    [Language.HR]: "Croatian",
    [Language.HU]: "Hungarian",
    [Language.ID]: "Indonesian",
    [Language.IT]: "Italian",
    [Language.JA]: "Japanese",
    [Language.KO]: "Korean",
    [Language.MS]: "Malay",
    [Language.NB]: "Norwegian",
    [Language.NN]: "Nynorsk",
    [Language.NL]: "Dutch",
    [Language.PL]: "Polish",
    [Language.PT]: "Portuguese",
    [Language.RO]: "Romanian",
    [Language.RU]: "Russian",
    [Language.SK]: "Slovak",
    [Language.SL]: "Slovenian",
    [Language.SV]: "Swedish",
    [Language.TA]: "Tamil", // Only supported by speech-2.6-* models
    [Language.TH]: "Thai",
    [Language.TR]: "Turkish",
    [Language.UK]: "Ukrainian",
    [Language.VI]: "Vietnamese",
    [Language.YUE]: "Chinese,Yue",
    [Language.ZH]: "Chinese",
  };

  return resolveLanguage(language, LANGUAGE_MAP, true);
}

export interface MiniMaxTTSSettingsOptions extends TTSSettingsOptions {
  /** Speech speed (range: 0.5 to 2.0). */
  speed?: number | null | NotGiven;
  /** Speech volume (range: 0 to 10). */
  volume?: number | null | NotGiven;
  /** Pitch adjustment (range: -12 to 12). */
  pitch?: number | null | NotGiven;
  /**
   * Emotional tone (options: "happy", "sad", "angry", "fearful", "disgusted",
   * "surprised", "calm", "fluent").
   */
  emotion?: string | null | NotGiven;
  /** Enable text normalization (Chinese/English). */
  textNormalization?: boolean | null | NotGiven;
  /** Enable LaTeX formula reading. */
  latexRead?: boolean | null | NotGiven;
  /** Language boost string for multilingual support. */
  languageBoost?: string | null | NotGiven;
}

/**
 * Settings for MiniMaxHttpTTSService.
 *
 * - `speed`: speech speed (range: 0.5 to 2.0).
 * - `volume`: speech volume (range: 0 to 10).
 * - `pitch`: pitch adjustment (range: -12 to 12).
 * - `emotion`: emotional tone (options: "happy", "sad", "angry", "fearful",
 *   "disgusted", "surprised", "calm", "fluent").
 * - `textNormalization`: enable text normalization (Chinese/English).
 * - `latexRead`: enable LaTeX formula reading.
 * - `languageBoost`: language boost string for multilingual support.
 */
export class MiniMaxTTSSettings extends TTSSettings {
  speed: number | null | NotGiven = NOT_GIVEN;
  volume: number | null | NotGiven = NOT_GIVEN;
  pitch: number | null | NotGiven = NOT_GIVEN;
  emotion: string | null | NotGiven = NOT_GIVEN;
  textNormalization: boolean | null | NotGiven = NOT_GIVEN;
  latexRead: boolean | null | NotGiven = NOT_GIVEN;
  languageBoost: string | null | NotGiven = NOT_GIVEN;

  constructor(options: MiniMaxTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }

  /**
   * Construct settings from a plain dict, destructuring legacy nested dicts.
   *
   * Handles `voice_setting` (with `vol` to `volume` rename).
   */
  static override fromMapping<T extends ServiceSettings>(
    this: new (
      options?: object,
    ) => T,
    settings: Record<string, unknown>,
  ): T {
    const flat: Dict = { ...settings };

    const voice = flat.voice_setting;
    delete flat.voice_setting;
    if (voice && typeof voice === "object" && !Array.isArray(voice)) {
      const setDefault = (key: string, value: unknown) => {
        if (!Object.hasOwn(flat, key)) flat[key] = value ?? null;
      };
      setDefault("speed", (voice as Dict).speed);
      setDefault("volume", (voice as Dict).vol);
      setDefault("pitch", (voice as Dict).pitch);
      setDefault("emotion", (voice as Dict).emotion);
      setDefault("text_normalization", (voice as Dict).text_normalization);
      setDefault("latex_read", (voice as Dict).latex_read);
    }

    // Upstream's `super().from_mapping(flat)`, building an instance of this class.
    // biome-ignore lint/complexity/noThisInStatic: polymorphic classmethod.
    return TTSSettings.fromMapping.call(this as never, flat) as T;
  }
}

/** Python's `bytes.fromhex`: ASCII whitespace is skipped, anything else must be hex pairs. */
function bytesFromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[ \t\n\r\f\v]/g, "");
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("non-hexadecimal number found in fromhex() arg");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Yield a body stream's bytes as they arrive, in chunks of at most `chunkSize` bytes. */
async function* iterChunked(
  body: ReadableStream<Uint8Array> | null,
  chunkSize: number,
): AsyncGenerator<Uint8Array, void, unknown> {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await abortable(reader.read());
      if (done) break;
      if (!value || value.length === 0) continue;
      for (let offset = 0; offset < value.length; offset += chunkSize) {
        yield value.subarray(offset, Math.min(offset + chunkSize, value.length));
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch (e) {
      rethrowIfCancelled(e);
    }
  }
}

const DATA = new TextEncoder().encode("data:");

/** `bytearray.find(b"data:", from)`. */
function findData(buffer: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= buffer.length - DATA.length; i++) {
    for (let j = 0; j < DATA.length; j++) {
      if (buffer[i + j] !== DATA[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export interface MiniMaxHttpTTSServiceOptions extends TTSServiceOptions {
  /** MiniMax API key for authentication. */
  apiKey: string;
  /**
   * API base URL, defaults to MiniMax's T2A endpoint.
   *
   * - Global: https://api.minimax.io/v1/t2a_v2
   * - Mainland China: https://api.minimaxi.chat/v1/t2a_v2
   * - Western United States: https://api-uw.minimax.io/v1/t2a_v2
   */
  baseUrl?: string;
  /** MiniMax Group ID to identify project. */
  groupId: string;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: upstream takes a required shared `aiohttp_session`.
   */
  fetch?: typeof fetch | null;
  /** Whether to use streaming mode. Defaults to true. */
  stream?: boolean;
  /** Runtime-updatable settings. */
  settings?: MiniMaxTTSSettings | null;
}

/**
 * Text-to-speech service using MiniMax's T2A (Text-to-Audio) API.
 *
 * Provides streaming text-to-speech synthesis using MiniMax's HTTP API
 * with support for various voice settings, emotions, and audio configurations.
 * Supports real-time audio streaming with configurable voice parameters.
 *
 * Platform documentation:
 * https://platform.minimax.io/docs/api-reference/speech-t2a-http
 */
export class MiniMaxHttpTTSService extends TTSService {
  static Settings: typeof MiniMaxTTSSettings = MiniMaxTTSSettings;
  declare protected _settings: MiniMaxTTSSettings;

  static {
    installTracedTts(MiniMaxHttpTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _groupId: string;
  protected _stream: boolean;
  protected _baseUrl: string;
  protected _fetch: typeof fetch;

  // Init-only audio format config
  protected _audioBitrate = 128000;
  protected _audioFormat = "pcm";
  protected _audioChannel = 1;
  protected _audioSampleRate = 0; // Set in start()

  /**
   * Initialize the MiniMax TTS service.
   *
   * @param options.apiKey MiniMax API key for authentication.
   * @param options.baseUrl API base URL, defaults to MiniMax's T2A endpoint.
   * @param options.groupId MiniMax Group ID to identify project.
   * @param options.fetch `fetch` used for HTTP requests (upstream: an aiohttp session).
   * @param options.sampleRate Output audio sample rate in Hz. If null, uses pipeline default.
   * @param options.stream Whether to use streaming mode. Defaults to true.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent TTSService.
   */
  constructor(options: MiniMaxHttpTTSServiceOptions) {
    const defaultSettings = new (new.target as typeof MiniMaxHttpTTSService).Settings({
      model: "speech-2.8-turbo",
      voice: "Calm_Woman",
      language: null,
      speed: 1.0,
      volume: 1.0,
      pitch: 0,
      languageBoost: null,
      emotion: null,
      textNormalization: null,
      latexRead: null,
    });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      pushStartFrame: true,
      pushStopFrames: true,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._groupId = options.groupId;
    this._stream = options.stream ?? true;
    this._baseUrl = `${options.baseUrl ?? "https://api.minimax.io/v1/t2a_v2"}?GroupId=${options.groupId}`;
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Check if this service can generate processing metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to MiniMax service language format.
   *
   * @param language The language to convert.
   * @returns The MiniMax-specific language name, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToMinimaxLanguage(language);
  }

  /**
   * Start the MiniMax TTS service.
   *
   * @param frame The start frame containing initialization parameters.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    this._audioSampleRate = this.sampleRate;
    logger.debug(`MiniMax TTS initialized with sample_rate: ${this.sampleRate}`);
  }

  /**
   * Generate TTS audio from text using MiniMax's streaming API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const headers = {
      accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Authorization: `Bearer ${this._apiKey}`,
    };

    // Build voice_setting dict for API
    const voiceSetting: Dict = {
      voice_id: this._settings.voice,
      speed: this._settings.speed,
      vol: this._settings.volume,
      pitch: this._settings.pitch,
    };
    if (this._settings.emotion !== null) {
      voiceSetting.emotion = this._settings.emotion;
    }
    if (this._settings.textNormalization !== null) {
      voiceSetting.text_normalization = this._settings.textNormalization;
    }
    if (this._settings.latexRead !== null) {
      voiceSetting.latex_read = this._settings.latexRead;
    }

    // Build audio_setting dict for API
    const audioSetting = {
      bitrate: this._audioBitrate,
      format: this._audioFormat,
      channel: this._audioChannel,
      sample_rate: this._audioSampleRate,
    };

    // Create payload from settings
    const payload: Dict = {
      stream: this._stream,
      voice_setting: voiceSetting,
      audio_setting: audioSetting,
      model: this._settings.model,
      text,
    };
    if (this._settings.languageBoost !== null) {
      payload.language_boost = this._settings.languageBoost;
    }

    try {
      const response = await abortable(
        this._fetch(this._baseUrl, {
          method: "POST",
          headers,
          body: pyJsonDumps(payload),
          signal: currentSignal(),
        }),
      );
      if (response.status !== 200) {
        const errorMessageText = `MiniMax TTS error: HTTP ${response.status}`;
        yield new ErrorFrame({ error: errorMessageText });
        await response.body?.cancel().catch(() => {});
        return;
      }

      await this.startTtsUsageMetrics(text);

      // Process the streaming response
      let buffer: Uint8Array = new Uint8Array(0);

      const CHUNK_SIZE = this.chunkSize;

      for await (const chunk of iterChunked(response.body, CHUNK_SIZE)) {
        if (chunk.length === 0) {
          continue;
        }

        buffer = concat(buffer, chunk);

        // Find complete data blocks
        while (findData(buffer) !== -1) {
          const start = findData(buffer);
          const nextStart = findData(buffer, start + 5);

          if (nextStart === -1) {
            // No next data block found, keep current data for next iteration
            if (start > 0) {
              buffer = buffer.slice(start);
            }
            break;
          }

          // Extract a complete data block
          const dataBlock = buffer.slice(start, nextStart);
          buffer = buffer.slice(nextStart);

          try {
            const data = pyJsonLoads(
              new TextDecoder("utf-8", { fatal: true }).decode(dataBlock.subarray(5)),
            ) as Dict;
            // Skip data blocks containing extra_info
            if ("extra_info" in data) {
              logger.debug("Received final chunk with extra info");
              continue;
            }

            const chunkData = data.data ?? {};
            if (!chunkData || Object.keys(chunkData).length === 0) {
              continue;
            }

            const audioData: string | undefined = chunkData.audio;
            if (!audioData) {
              continue;
            }

            // Process audio data in chunks
            for (let i = 0; i < audioData.length; i += CHUNK_SIZE * 2) {
              // *2 for hex string
              // Split hex string
              const hexChunk = audioData.slice(i, i + CHUNK_SIZE * 2);
              if (!hexChunk) {
                continue;
              }

              let audioChunk: Uint8Array;
              try {
                // Convert this chunk of data
                audioChunk = bytesFromHex(hexChunk);
              } catch (e) {
                rethrowIfCancelled(e);
                logger.error(`Error converting hex to binary: ${errorMessage(e)}`);
                continue;
              }
              if (audioChunk.length > 0) {
                await this.stopTtfbMetrics();
                yield new TTSAudioRawFrame({
                  audio: audioChunk,
                  sampleRate: this.sampleRate,
                  numChannels: 1,
                  contextId,
                });
              }
            }
          } catch (e) {
            rethrowIfCancelled(e);
            if (e instanceof SyntaxError || e instanceof TypeError) {
              // JSON decode (or UTF-8 decode) failure.
              logger.error(
                `Error decoding JSON: ${errorMessage(e)}, data: ${new TextDecoder().decode(dataBlock.subarray(0, 100))}`,
              );
              continue;
            }
            throw e;
          }
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}`, exception: e });
    } finally {
      await this.stopTtfbMetrics();
    }
  }
}
