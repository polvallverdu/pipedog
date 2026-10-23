// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Whisper speech-to-text on Workers AI, one request per speech segment.
 *
 * Models:
 * - `@cf/openai/whisper-large-v3-turbo` (default): input `{ audio: <base64> }`,
 *   plus `language`, `task`, `vad_filter` and `initial_prompt`.
 * - `@cf/openai/whisper` and `@cf/openai/whisper-tiny-en`: input
 *   `{ audio: number[] }`, the file's bytes as an array of 0–255 integers. They
 *   take no other options.
 *
 * Every model answers with `{ text, ... }`. Like the other segmented STT
 * services it needs a VAD: the segment between `VADUserStartedSpeakingFrame`
 * and `VADUserStoppedSpeakingFrame` is sent as a WAV file.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { ErrorFrame, type Frame, TranscriptionFrame } from "@pipedog/core/frames/frames";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { WHISPER_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import {
  SegmentedSTTService,
  type SegmentedSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import type { Language } from "@pipedog/core/transcriptions/language";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import {
  splitConnectionOptions,
  type WorkersAIClient,
  type WorkersAIConnectionOptions,
} from "./client.ts";

/** Whisper models on Workers AI. */
export const WorkersAIWhisperModel = {
  LARGE_V3_TURBO: "@cf/openai/whisper-large-v3-turbo",
  WHISPER: "@cf/openai/whisper",
  TINY_EN: "@cf/openai/whisper-tiny-en",
} as const;
export type WorkersAIWhisperModel =
  (typeof WorkersAIWhisperModel)[keyof typeof WorkersAIWhisperModel];

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface WorkersAIWhisperSTTSettingsOptions extends STTSettingsOptions {
  /** Context for the model: names, terms, the topic (`initial_prompt`). Turbo only. */
  prompt?: string | null | NotGiven;
  /** Run Whisper's own VAD before transcribing (`vad_filter`). Turbo only. */
  vadFilter?: boolean | null | NotGiven;
}

/**
 * Settings for `WorkersAIWhisperSTTService`.
 *
 * - `model`: a Workers AI Whisper model ID.
 * - `language`: the language of the audio, sent as its ISO 639-1 code
 *   (turbo only; `null` lets the model detect it).
 * - `prompt`: context for the model (`initial_prompt`). Turbo only.
 * - `vadFilter`: run Whisper's own VAD first (`vad_filter`). Turbo only.
 */
export class WorkersAIWhisperSTTSettings extends STTSettings {
  prompt: string | null | NotGiven = NOT_GIVEN;
  vadFilter: boolean | null | NotGiven = NOT_GIVEN;

  constructor(options: WorkersAIWhisperSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface WorkersAIWhisperSTTServiceOptions
  extends SegmentedSTTServiceOptions,
    WorkersAIConnectionOptions {
  /** Runtime-updatable settings. */
  settings?: WorkersAIWhisperSTTSettings | null;
}

/**
 * Whisper speech-to-text on Workers AI (segmented: one request per utterance).
 *
 * @example
 * const stt = new WorkersAIWhisperSTTService({
 *   ai: env.AI,
 *   settings: new WorkersAIWhisperSTTService.Settings({ language: Language.EN }),
 * });
 */
export class WorkersAIWhisperSTTService extends SegmentedSTTService {
  static Settings: typeof WorkersAIWhisperSTTSettings = WorkersAIWhisperSTTSettings;
  declare protected _settings: WorkersAIWhisperSTTSettings;

  static {
    installTracedStt(WorkersAIWhisperSTTService.prototype, "_handleTranscription");
  }

  protected _workersAI: WorkersAIClient;

  constructor(options: WorkersAIWhisperSTTServiceOptions) {
    const defaultSettings = new (new.target as typeof WorkersAIWhisperSTTService).Settings({
      model: WorkersAIWhisperModel.LARGE_V3_TURBO,
      language: null,
      prompt: null,
      vadFilter: null,
    });
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }
    const [client, rest] = splitConnectionOptions(options);
    super({
      ...rest,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? WHISPER_TTFS_P99 : options.ttfsP99Latency,
      settings: defaultSettings,
    });
    this._workersAI = client;
  }

  /** The client the service reaches Workers AI with. */
  get workersAI(): WorkersAIClient {
    return this._workersAI;
  }

  override canGenerateMetrics(): boolean {
    return true;
  }

  /** Whisper takes an ISO 639-1 code: `en-US` is sent as `en`. */
  override languageToServiceLanguage(language: Language): string | null {
    return String(language).split("-")[0]?.toLowerCase() ?? null;
  }

  /** The request input for the current model. */
  protected _buildInput(wav: Uint8Array): Record<string, unknown> {
    const model = String(this._settings.model);
    if (model !== WorkersAIWhisperModel.LARGE_V3_TURBO) {
      // The original Whisper models take the file as an array of bytes.
      return { audio: Array.from(wav) };
    }
    const input: Record<string, unknown> = { audio: bytesToBase64(wav), task: "transcribe" };
    const language = this._settings.language;
    if (isGiven(language) && language !== null) {
      input.language = this.languageToServiceLanguage(language as Language);
    }
    const prompt = this._settings.prompt;
    if (isGiven(prompt) && prompt) input.initial_prompt = prompt;
    const vadFilter = this._settings.vadFilter;
    if (isGiven(vadFilter) && vadFilter !== null) input.vad_filter = vadFilter;
    return input;
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | null = null,
  ): Promise<void> {
    await this.stopProcessingMetrics();
  }

  /**
   * Transcribe one speech segment.
   *
   * @param audio The segment as a WAV file (the base class wraps it).
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    try {
      await this.startProcessingMetrics();
      const result = await this._workersAI.run(
        String(this._settings.model),
        this._buildInput(audio),
      );
      const text = String(result.text ?? "").trim();
      const language = isGiven(this._settings.language)
        ? ((this._settings.language as Language | null) ?? null)
        : null;
      await this._handleTranscription(text, true, language);
      if (text) {
        logger.debug(`Transcription: [${text}]`);
        yield new TranscriptionFrame({
          text,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          language,
          result,
        });
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this}: error transcribing audio: ${errorMessage(e)}`);
      yield new ErrorFrame({ error: `Workers AI Whisper error: ${errorMessage(e)}`, exception: e });
    }
  }
}
