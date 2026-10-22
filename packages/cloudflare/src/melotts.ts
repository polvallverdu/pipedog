// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * MeloTTS on Workers AI (`@cf/myshell-ai/melotts`), one request per sentence.
 *
 * The model takes `{ prompt, lang }` and answers with MP3 only: base64 in a
 * JSON `{ audio }` (the binding, and the REST `result` envelope), or the raw
 * `audio/mpeg` body. Pipelines carry PCM, so the service needs an MP3 decoder,
 * passed as `decodeAudio`. pipedog ships none (Workers have no Web Audio, and
 * a WASM decoder has to be imported as a module there). Any decoder that
 * returns per-channel `Float32Array`s and a sample rate works, for example
 * `mpg123-decoder`'s `MPEGDecoder.decode()`, or Web Audio's `decodeAudioData`.
 * The decoded audio is mixed down to mono and resampled to the service rate.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { ErrorFrame, type Frame } from "@pipedog/core/frames/frames";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { isGiven } from "@pipedog/core/utils/types";
import {
  splitConnectionOptions,
  type WorkersAIClient,
  type WorkersAIConnectionOptions,
} from "./client.ts";

/** The MeloTTS model on Workers AI. */
export const WORKERS_AI_MELOTTS_MODEL = "@cf/myshell-ai/melotts";

/** Decoded audio: one `Float32Array` per channel (samples in -1..1) and its sample rate. */
export interface DecodedAudio {
  channelData: Float32Array[];
  sampleRate: number;
}

/** Decodes an MP3 file into PCM. */
export type AudioDecoder = (encoded: Uint8Array) => DecodedAudio | Promise<DecodedAudio>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Convert a Language to a MeloTTS `lang` code.
 *
 * MeloTTS speaks English, Spanish, French, Chinese, Japanese and Korean.
 */
export function languageToMeloTTSLanguage(language: Language): string | null {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.EN]: "en",
    [Language.ES]: "es",
    [Language.FR]: "fr",
    [Language.ZH]: "zh",
    [Language.JA]: "jp",
    [Language.KO]: "kr",
  };
  return resolveLanguage(language, LANGUAGE_MAP, true);
}

/** Mix channels down to mono 16-bit little-endian PCM. */
export function floatChannelsToPcm16(channels: readonly Float32Array[]): Uint8Array {
  const length = channels.reduce((n, c) => Math.max(n, c.length), 0);
  const out = new Int16Array(length);
  const count = channels.length || 1;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    const sample = Math.max(-1, Math.min(1, sum / count));
    out[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return new Uint8Array(out.buffer);
}

/** Settings for `WorkersAIMeloTTSService`: `model` and `language`; MeloTTS has one voice per language. */
export class WorkersAIMeloTTSSettings extends TTSSettings {
  constructor(options: TTSSettingsOptions = {}) {
    super(options);
  }
}

export interface WorkersAIMeloTTSServiceOptions
  extends TTSServiceOptions,
    WorkersAIConnectionOptions {
  /**
   * Decodes MeloTTS's MP3 output. Required: without it every request fails
   * with an error saying so.
   */
  decodeAudio?: AudioDecoder | null;
  /** Runtime-updatable settings. */
  settings?: WorkersAIMeloTTSSettings | null;
}

/**
 * MeloTTS text-to-speech on Workers AI (batch: one request per sentence).
 *
 * @example
 * import { MPEGDecoder } from "mpg123-decoder";
 * const decoder = new MPEGDecoder();
 * await decoder.ready;
 * const tts = new WorkersAIMeloTTSService({
 *   ai: env.AI,
 *   decodeAudio: (mp3) => { decoder.reset(); return decoder.decode(mp3); },
 * });
 */
export class WorkersAIMeloTTSService extends TTSService {
  static Settings: typeof WorkersAIMeloTTSSettings = WorkersAIMeloTTSSettings;
  declare protected _settings: WorkersAIMeloTTSSettings;

  static {
    installTracedTts(WorkersAIMeloTTSService.prototype, "runTts");
  }

  protected _workersAI: WorkersAIClient;
  protected _decodeAudio: AudioDecoder | null;

  constructor(options: WorkersAIMeloTTSServiceOptions) {
    const defaultSettings = new (new.target as typeof WorkersAIMeloTTSService).Settings({
      model: WORKERS_AI_MELOTTS_MODEL,
      voice: null,
      language: Language.EN,
    });
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }
    const [client, { decodeAudio, ...rest }] = splitConnectionOptions(options);
    super({
      ...rest,
      sampleRate: options.sampleRate ?? null,
      pushStartFrame: true,
      pushStopFrames: true,
      settings: defaultSettings,
    });
    this._workersAI = client;
    this._decodeAudio = decodeAudio ?? null;
    if (!this._decodeAudio) {
      logger.warning(
        `${this}: no \`decodeAudio\` given; MeloTTS answers with MP3, so requests will fail`,
      );
    }
  }

  /** The client the service reaches Workers AI with. */
  get workersAI(): WorkersAIClient {
    return this._workersAI;
  }

  override canGenerateMetrics(): boolean {
    return true;
  }

  override languageToServiceLanguage(language: Language): string | null {
    return languageToMeloTTSLanguage(language);
  }

  /** The MP3 bytes of a MeloTTS response, whichever shape it came in. */
  protected async _readMp3(response: Response): Promise<Uint8Array> {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      return new Uint8Array(await response.arrayBuffer());
    }
    const data = (await response.json()) as Record<string, any> | null;
    const audio = data?.result?.audio ?? data?.audio;
    if (typeof audio !== "string" || !audio) {
      throw new Error("MeloTTS reply has no audio");
    }
    return base64ToBytes(audio);
  }

  /** Synthesize `text` and push it as audio frames. */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      if (!this._decodeAudio) {
        throw new Error(
          "MeloTTS answers with MP3: pass a `decodeAudio` function to WorkersAIMeloTTSService",
        );
      }
      await this.startTtfbMetrics();
      const input: Record<string, unknown> = { prompt: text };
      const language = this._settings.language;
      if (isGiven(language) && language) {
        input.lang = String(language);
      }
      const response = await this._workersAI.runRaw(String(this._settings.model), input);
      const mp3 = await this._readMp3(response);
      await this.startTtsUsageMetrics(text);
      const decoded = await this._decodeAudio(mp3);
      const pcm = floatChannelsToPcm16(decoded.channelData);
      async function* once(): AsyncGenerator<Uint8Array, void, unknown> {
        yield pcm;
      }
      for await (const frame of this._streamAudioFramesFromIterator(once(), {
        contextId,
        inSampleRate: decoded.sampleRate,
      })) {
        await this.stopTtfbMetrics();
        yield frame;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Workers AI MeloTTS error: ${errorMessage(e)}`, exception: e });
    }
  }
}
