// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/elevenlabs/tts.py

/**
 * ElevenLabs text-to-speech service implementations.
 *
 * This module provides WebSocket and HTTP-based TTS services using ElevenLabs
 * API with support for streaming audio, word timestamps, and voice
 * customization.
 *
 * Porting notes:
 * - `ElevenLabsTTSService` uses the global `WebSocket` (see `tts_base.ts`).
 * - `ElevenLabsHttpTTSService` uses `fetch`. DIVERGENCE: upstream's required
 *   `aiohttp_session` becomes an optional `fetch` option (the global `fetch`
 *   by default).
 * - Deprecated APIs are not ported: `PronunciationDictionaryLocator`,
 *   `ElevenLabsTTSService.InputParams`, `ElevenLabsHttpTTSService.InputParams`
 *   and the `voiceId`, `model`, `params`, `pronunciationDictionaryLocators`
 *   and `aggregateSentences` constructor options. Without pronunciation
 *   dictionaries the alignment is always read from `alignment` first (the
 *   `preferNormalized` branch of `_selectAlignment` is never taken here).
 */

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import type { BaseExpressionAdapter } from "@pipedog/core/adapters/tts/base_expression_adapter";
import {
  ErrorFrame,
  type Frame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  TTSAudioRawFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import { FrameDirection, type FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import {
  TextAggregationMode,
  TTSService,
  type TTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import { State } from "@pipedog/core/services/websocket_service";
import type { Language } from "@pipedog/core/transcriptions/language";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { normalizeIpa } from "@pipedog/core/utils/text/phonemes";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { ElevenLabsAudioTagExpressionAdapter } from "./elevenlabs_adapter.ts";
import {
  _endsInAudioTag,
  _selectAlignment,
  _stripUtteranceLeadingSpaces,
  _wordTimestampsIncludeInterFrameSpaces,
  calculateWordTimes,
  ELEVENLABS_MODEL_LANGUAGES,
  ElevenLabsTTSBase,
  type ElevenLabsTTSBaseOptions,
  ElevenLabsTTSSettingsBase,
  type ElevenLabsTTSSettingsBaseOptions,
  elevenlabsLanguageCode,
  languageToElevenlabsLanguage,
  outputFormatFromSampleRate,
} from "./tts_base.ts";

// Re-exported so the documented import path for these helpers keeps working.
export {
  calculateWordTimes,
  ELEVENLABS_MODEL_LANGUAGES,
  languageToElevenlabsLanguage,
  outputFormatFromSampleRate,
};

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Models that support language codes. Which languages each one accepts
 * differs, so the language itself is validated by `elevenlabsLanguageCode`.
 */
export const ELEVENLABS_MULTILINGUAL_MODELS: ReadonlySet<string> = new Set(
  Object.keys(ELEVENLABS_MODEL_LANGUAGES),
);

/** Models that reject the previous_text/next_text context parameters. */
export const ELEVENLABS_CONTEXT_UNSUPPORTED_MODELS: ReadonlySet<string> = new Set([
  "eleven_v3",
  "eleven_v3_conversational",
]);

/** Voice-setting keys (dict keys) and the settings fields they come from. */
const VOICE_SETTING_KEYS: readonly (readonly [string, string])[] = [
  ["stability", "stability"],
  ["similarity_boost", "similarityBoost"],
  ["style", "style"],
  ["use_speaker_boost", "useSpeakerBoost"],
  ["speed", "speed"],
];

/**
 * Build voice settings dictionary for ElevenLabs based on provided settings.
 *
 * @param settings Dictionary or settings containing voice settings
 *   parameters. A dictionary is read by the wire key (`similarity_boost`).
 * @returns Dictionary of voice settings or null if no valid settings are
 *   provided.
 */
export function buildElevenlabsVoiceSettings(
  settings: Record<string, unknown> | TTSSettings,
): Record<string, number | boolean> | null {
  const voiceSettings: Record<string, number | boolean> = {};
  for (const [key, field] of VOICE_SETTING_KEYS) {
    let val: unknown;
    if (settings instanceof TTSSettings) {
      // Upstream reads the field with getattr(settings, field): a dynamic lookup.
      val = (settings as unknown as Record<string, unknown>)[field];
    } else {
      val = settings[key];
    }
    // NOT_GIVEN is an attribute value upstream too, but never in a store.
    if (val !== null && val !== undefined && val !== NOT_GIVEN) {
      voiceSettings[key] = val as number | boolean;
    }
  }

  return Object.keys(voiceSettings).length > 0 ? voiceSettings : null;
}

/**
 * Models that read SSML `<phoneme>` tags. ElevenLabs' docs list only
 * eleven_flash_v2; eleven_turbo_v2 reads them too.
 */
export const ELEVENLABS_PHONEME_MODELS: ReadonlySet<string> = new Set([
  "eleven_flash_v2",
  "eleven_turbo_v2",
]);

/** Python `html.escape(s, quote)`. */
function htmlEscape(s: string, quote = true): string {
  let out = s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (quote) {
    out = out.replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
  }
  return out;
}

/** Python `str.split()` with no separator. */
function pySplit(s: string): string[] {
  return s.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Render a pronunciation as ElevenLabs SSML `<phoneme>` tags.
 *
 * A phoneme tag holds a single word, so a phrase gets one tag per word and its
 * IPA must have as many words. Only the models in `ELEVENLABS_PHONEME_MODELS`
 * read phoneme tags.
 *
 * @param word The word being pronounced, kept inside the tag.
 * @param ipa The pronunciation, in IPA.
 * @returns The phoneme tags, e.g.
 *   `<phoneme alphabet="ipa" ph="mɛtˈfɔɹmɪn">Metformin</phoneme>`, or null when
 *   the words and the IPA do not line up.
 */
export function formatElevenlabsPronunciation(word: string, ipa: string): string | null {
  const words = pySplit(word);
  const spoken = pySplit(normalizeIpa(ipa));
  if (words.length === 0 || spoken.length !== words.length) {
    return null;
  }
  return words
    .map(
      (w, i) =>
        `<phoneme alphabet="ipa" ph="${htmlEscape(spoken[i]!)}">${htmlEscape(w, false)}</phoneme>`,
    )
    .join(" ");
}

export type ElevenLabsTextNormalization = "auto" | "on" | "off";

export interface ElevenLabsTTSSettingsOptions extends ElevenLabsTTSSettingsBaseOptions {
  /** Voice stability control (0.0 to 1.0). */
  stability?: number | null | NotGiven;
  /** Similarity boost control (0.0 to 1.0). */
  similarityBoost?: number | null | NotGiven;
  /** Style control for voice expression (0.0 to 1.0). */
  style?: number | null | NotGiven;
  /** Whether to use speaker boost enhancement. */
  useSpeakerBoost?: boolean | null | NotGiven;
  /** Voice speed control (0.7 to 1.2). */
  speed?: number | null | NotGiven;
  /** Text normalization mode ("auto", "on", "off"). */
  applyTextNormalization?: ElevenLabsTextNormalization | null | NotGiven;
}

/**
 * Settings for ElevenLabsTTSService.
 *
 * Fields that appear in the WebSocket URL (`voice`, `model`, `language`)
 * require a full reconnect when changed. Fields that affect the voice
 * character (`stability`, `similarityBoost`, `style`, `useSpeakerBoost`,
 * `speed`) can be applied by closing the current audio context so a new one
 * is opened with updated settings.
 *
 * - `stability`: voice stability control (0.0 to 1.0).
 * - `similarityBoost`: similarity boost control (0.0 to 1.0).
 * - `style`: style control for voice expression (0.0 to 1.0).
 * - `useSpeakerBoost`: whether to use speaker boost enhancement.
 * - `speed`: voice speed control (0.7 to 1.2).
 * - `applyTextNormalization`: text normalization mode ("auto", "on", "off").
 */
export class ElevenLabsTTSSettings extends ElevenLabsTTSSettingsBase {
  stability: number | null | NotGiven = NOT_GIVEN;
  similarityBoost: number | null | NotGiven = NOT_GIVEN;
  style: number | null | NotGiven = NOT_GIVEN;
  useSpeakerBoost: boolean | null | NotGiven = NOT_GIVEN;
  speed: number | null | NotGiven = NOT_GIVEN;
  applyTextNormalization: ElevenLabsTextNormalization | null | NotGiven = NOT_GIVEN;

  /** Fields in the WS URL — changing any of these requires a reconnect. */
  static override URL_FIELDS: ReadonlySet<string> = new Set(["voice", "model", "language"]);

  /**
   * Fields affecting voice character — changing these requires closing the
   * current audio context so the next one picks up new settings.
   */
  static override VOICE_SETTINGS_FIELDS: ReadonlySet<string> = new Set([
    "stability",
    "similarityBoost",
    "style",
    "useSpeakerBoost",
    "speed",
  ]);

  constructor(options: ElevenLabsTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface ElevenLabsHttpTTSSettingsOptions extends TTSSettingsOptions {
  /** Latency optimization level (0-4). */
  optimizeStreamingLatency?: number | null | NotGiven;
  /** Voice stability control (0.0 to 1.0). */
  stability?: number | null | NotGiven;
  /** Similarity boost control (0.0 to 1.0). */
  similarityBoost?: number | null | NotGiven;
  /** Style control for voice expression (0.0 to 1.0). */
  style?: number | null | NotGiven;
  /** Whether to use speaker boost enhancement. */
  useSpeakerBoost?: boolean | null | NotGiven;
  /** Voice speed control (0.25 to 4.0). */
  speed?: number | null | NotGiven;
  /** Text normalization mode ("auto", "on", "off"). */
  applyTextNormalization?: ElevenLabsTextNormalization | null | NotGiven;
}

/**
 * Settings for ElevenLabsHttpTTSService.
 *
 * - `optimizeStreamingLatency`: latency optimization level (0-4).
 * - `stability`: voice stability control (0.0 to 1.0).
 * - `similarityBoost`: similarity boost control (0.0 to 1.0).
 * - `style`: style control for voice expression (0.0 to 1.0).
 * - `useSpeakerBoost`: whether to use speaker boost enhancement.
 * - `speed`: voice speed control (0.25 to 4.0).
 * - `applyTextNormalization`: text normalization mode ("auto", "on", "off").
 */
export class ElevenLabsHttpTTSSettings extends TTSSettings {
  optimizeStreamingLatency: number | null | NotGiven = NOT_GIVEN;
  stability: number | null | NotGiven = NOT_GIVEN;
  similarityBoost: number | null | NotGiven = NOT_GIVEN;
  style: number | null | NotGiven = NOT_GIVEN;
  useSpeakerBoost: boolean | null | NotGiven = NOT_GIVEN;
  speed: number | null | NotGiven = NOT_GIVEN;
  applyTextNormalization: ElevenLabsTextNormalization | null | NotGiven = NOT_GIVEN;

  constructor(options: ElevenLabsHttpTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface ElevenLabsTTSServiceOptions extends Omit<ElevenLabsTTSBaseOptions, "url"> {
  /** WebSocket URL for ElevenLabs TTS API. Defaults to "wss://api.elevenlabs.io". */
  url?: string;
  /**
   * Whether to enable ElevenLabs' auto mode, which reduces latency by
   * disabling server-side chunk scheduling and buffering. Recommended when
   * sending complete sentences or phrases. When null (default), auto mode is
   * enabled for `SENTENCE` aggregation and disabled for `TOKEN` aggregation —
   * because token streaming relies on the server-side chunk scheduler to
   * accumulate enough text for natural-sounding synthesis.
   */
  autoMode?: boolean | null;
  /** Whether to parse SSML tags in text. */
  enableSsmlParsing?: boolean | null;
  /**
   * Runtime-updatable settings. Its given fields override the defaults
   * (model "eleven_flash_v2_5").
   */
  settings?: ElevenLabsTTSSettings | null;
}

/**
 * ElevenLabs WebSocket-based TTS service with word timestamps.
 *
 * Provides real-time text-to-speech using ElevenLabs' WebSocket streaming
 * API. Supports word-level timestamps, audio context management, and various
 * voice customization options including stability, similarity boost, and
 * speed controls.
 */
export class ElevenLabsTTSService extends ElevenLabsTTSBase {
  static override Settings: typeof ElevenLabsTTSSettings = ElevenLabsTTSSettings;
  declare protected _settings: ElevenLabsTTSSettings;

  protected _autoMode: boolean;
  protected _enableSsmlParsing: boolean | null;
  protected _alignmentStartedContextIds: Set<string | null>;
  /**
   * Context IDs whose context-init has been sent, so the keepalive knows
   * which contexts are safe to target.
   */
  protected _contextInitSent: Set<string>;

  /**
   * Initialize the ElevenLabs TTS service.
   *
   * @param options.apiKey ElevenLabs API key for authentication.
   * @param options.url WebSocket URL for ElevenLabs TTS API.
   * @param options.sampleRate Audio sample rate. If null, uses default.
   * @param options.autoMode Whether to enable ElevenLabs' auto mode, which
   *   reduces latency by disabling server-side chunk scheduling and
   *   buffering. Recommended when sending complete sentences or phrases. When
   *   null (default), auto mode is enabled for `SENTENCE` aggregation and
   *   disabled for `TOKEN` aggregation — because token streaming relies on the
   *   server-side chunk scheduler to accumulate enough text for
   *   natural-sounding synthesis.
   * @param options.enableSsmlParsing Whether to parse SSML tags in text.
   * @param options.enableLogging Whether to enable ElevenLabs server-side
   *   logging.
   * @param options.settings Runtime-updatable settings.
   * @param options.textAggregationMode How to aggregate incoming text before
   *   synthesis. Other options are passed to the parent service.
   */
  constructor(options: ElevenLabsTTSServiceOptions) {
    // By default, we aggregate sentences before sending to TTS. This adds
    // ~200-300ms of latency per sentence (waiting for the sentence-ending
    // punctuation token from the LLM). Setting
    // textAggregationMode=TextAggregationMode.TOKEN streams tokens directly.
    // To use this mode, you must set autoMode=false. This eliminates
    // aggregation time, but slows down ElevenLabs.
    //
    // We also don't want to automatically push LLM response text frames,
    // because the context aggregators will add them to the LLM context even
    // if we're interrupted. ElevenLabs gives us word-by-word timestamps. We
    // can use those to generate text frames ourselves aligned with the
    // playout timing of the audio!
    //
    // Finally, ElevenLabs doesn't provide information on when the bot stops
    // speaking for a while, so we want the parent class to send TTSStopFrame
    // after a short period not receiving any audio.

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof ElevenLabsTTSService).Settings({
      model: "eleven_flash_v2_5",
      voice: null,
      language: null,
      stability: null,
      similarityBoost: null,
      style: null,
      useSpeakerBoost: null,
      speed: null,
      applyTextNormalization: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      url: options.url ?? "wss://api.elevenlabs.io",
      enableLogging: options.enableLogging ?? null,
      pushTextFrames: false,
      pushStopFrames: false,
      pauseFrameProcessing: true,
      sampleRate: options.sampleRate ?? null,
      settings: defaultSettings,
    });

    // Init-only WebSocket URL params (not runtime-updatable).
    //
    // ElevenLabs' auto mode reduces latency by disabling server-side chunk
    // scheduling and buffering — it's designed for inputs that are already
    // complete sentences or phrases. In TOKEN mode we stream individual LLM
    // tokens, so we need the server-side scheduler to accumulate enough text
    // for natural-sounding synthesis; enabling auto mode there would hurt
    // quality. When the caller hasn't set autoMode explicitly, we derive the
    // right default from the text aggregation strategy.
    let autoMode = options.autoMode ?? null;
    if (autoMode === null) {
      autoMode = this._textAggregationMode !== TextAggregationMode.TOKEN;
    }

    this._autoMode = autoMode;
    this._enableSsmlParsing = options.enableSsmlParsing ?? null;

    this._alignmentStartedContextIds = new Set();

    // Context IDs whose context-init has been sent, so the keepalive knows
    // which contexts are safe to target.
    this._contextInitSent = new Set();
  }

  /**
   * Render a pronunciation as SSML `<phoneme>` tags.
   *
   * See `formatElevenlabsPronunciation`.
   *
   * @param word The word being pronounced.
   * @param ipa The pronunciation, in IPA.
   * @returns The phoneme tags, or null when the pronunciation cannot be used.
   */
  static override formatPronunciation(word: string, ipa: string): string | null {
    return formatElevenlabsPronunciation(word, ipa);
  }

  /**
   * Whether phoneme tags are read with the current settings.
   *
   * They are read only with a model in `ELEVENLABS_PHONEME_MODELS` and with
   * `enableSsmlParsing: true`.
   *
   * @returns True when phoneme tags are read.
   */
  override get supportsPronunciations(): boolean {
    return (
      ELEVENLABS_PHONEME_MODELS.has(this._settings.model as string) &&
      Boolean(this._enableSsmlParsing)
    );
  }

  protected override _setVoiceSettings(): Dict | null {
    return buildElevenlabsVoiceSettings(this._settings);
  }

  /**
   * Flush any pending audio and finalize the current context.
   *
   * @param contextId The specific context to flush. If null, falls back to
   *   the currently active context.
   */
  override async flushAudio(contextId: string | null = null): Promise<void> {
    const flushId = contextId || this.getActiveAudioContextId();
    if (!flushId || !this._websocket) {
      return;
    }
    logger.trace(`${this}: flushing audio`);
    const msg = { context_id: flushId, flush: true };
    await this._websocket.send(pyJsonDumps(msg));
  }

  protected override _buildWebsocketUrl(): string {
    const voiceId = this._settings.voice;
    const model = this._settings.model;
    const outputFormat = this._outputFormat;
    let url = `${this._url}/v1/text-to-speech/${voiceId}/multi-stream-input?model_id=${model}&output_format=${outputFormat}&auto_mode=${String(this._autoMode).toLowerCase()}`;

    if (this._enableSsmlParsing !== null) {
      url += `&enable_ssml_parsing=${String(this._enableSsmlParsing).toLowerCase()}`;
    }

    if (this._enableLogging !== null) {
      url += `&enable_logging=${String(this._enableLogging).toLowerCase()}`;
    }

    if (this._settings.applyTextNormalization !== null) {
      url += `&apply_text_normalization=${this._settings.applyTextNormalization}`;
    }

    const languageCode = elevenlabsLanguageCode(
      assertGiven(model),
      assertGiven(this._settings.language),
    );
    if (languageCode) {
      url += `&language_code=${languageCode}`;
    }

    return url;
  }

  protected override _clearConnectionState(): void {
    this._contextInitSent.clear();
  }

  protected override async _closeContext(contextId: string): Promise<void> {
    // ElevenLabs requires that Pipecat explicitly closes contexts to free
    // server-side resources, both on interruption and on normal completion.
    if (contextId && this._websocket) {
      logger.trace(`${this}: Closing context ${contextId}`);
      try {
        // ElevenLabs requires that Pipecat manages the contexts and closes
        // them when they're not longer in use. Since an InterruptionFrame is
        // pushed every time the user speaks, we'll use this as a trigger to
        // close the context and reset the state.
        // Note: We do not need to call removeAudioContext here, as the context
        // is automatically reset when super._handleInterruption is called.
        await this._websocket.send(pyJsonDumps({ context_id: contextId, close_context: true }));
      } catch (e) {
        rethrowIfCancelled(e);
        await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      }
    }
  }

  protected override _resetAlignmentState(contextId: string | null): void {
    super._resetAlignmentState(contextId);
    this._alignmentStartedContextIds.delete(contextId);
    if (contextId !== null) this._contextInitSent.delete(contextId);
  }

  /**
   * Close the server-side context at end of turn.
   *
   * Sends close_context so isFinal arrives immediately after the last audio
   * byte.
   */
  override async onTurnContextCompleted(): Promise<void> {
    const contextId = this._turnContextId;
    await super.onTurnContextCompleted();
    if (contextId) {
      await this._closeContext(contextId);
    }
  }

  /** Handle incoming WebSocket messages from ElevenLabs. */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      const msg = pyJsonLoads(
        typeof message === "string" ? message : new TextDecoder().decode(message),
      ) as Dict;

      const receivedCtxId: string | null = msg.contextId ?? null;

      // Handle final messages first, regardless of context availability
      if (msg.isFinal === true) {
        logger.debug(`Received final message for context ${receivedCtxId}`);
        // In case of interruption, there is no audio context available, so we
        // don’t need to do anything.
        if (this.audioContextAvailable(receivedCtxId as string)) {
          await this.appendToAudioContext(
            receivedCtxId as string,
            new TTSStoppedFrame({ contextId: receivedCtxId }),
          );
          await this.removeAudioContext(receivedCtxId);
        }
        continue;
      }

      if (msg.audio) {
        const audio = base64ToBytes(msg.audio);
        const frame = new TTSAudioRawFrame({
          audio,
          sampleRate: this.sampleRate,
          numChannels: 1,
          contextId: receivedCtxId,
        });
        await this.appendToAudioContext(receivedCtxId as string, frame);
      }

      const rawAlignment = _selectAlignment(msg, {
        normalizedKey: "normalizedAlignment",
        alignmentKey: "alignment",
        preferNormalized: false,
      });
      if (rawAlignment && Object.keys(rawAlignment).length > 0) {
        const alignment = _stripUtteranceLeadingSpaces(
          rawAlignment,
          ["chars", "charStartTimesMs", "charDurationsMs"],
          !this._alignmentStartedContextIds.has(receivedCtxId),
        );
        this._alignmentStartedContextIds.add(receivedCtxId);
        const [wordTimes, partialWord, partialWordStartTime] = calculateWordTimes(
          alignment,
          this._cumulativeTime,
          this._partialWord,
          this._partialWordStartTime,
        );
        this._partialWord = partialWord;
        this._partialWordStartTime = partialWordStartTime;

        if (wordTimes.length > 0) {
          await this.addWordTimestamps(wordTimes, receivedCtxId, {
            includesInterFrameSpaces: _wordTimestampsIncludeInterFrameSpaces(
              assertGiven(this._settings.language),
            )
              ? true
              : null,
          });
        }

        // Alignment times restart at zero in every message, so the clock
        // advances by each chunk's span, including chunks that complete no
        // word, such as trailing punctuation arriving on its own.
        const charStartTimesMs: number[] = alignment.charStartTimesMs ?? [];
        const charDurationsMs: number[] = alignment.charDurationsMs ?? [];

        if (charStartTimesMs.length > 0 && charDurationsMs.length > 0) {
          const chunkEndTimeMs = charStartTimesMs.at(-1)! + charDurationsMs.at(-1)!;
          this._cumulativeTime += chunkEndTimeMs / 1000.0;
        } else if (wordTimes.length > 0) {
          this._cumulativeTime = wordTimes.at(-1)![1];
        }
      }
    }
  }

  /**
   * Send a single keepalive message to keep the WebSocket connection alive.
   *
   * Only stamps a `context_id` once its context-init (carrying
   * `voice_settings`) has been sent. Otherwise the keepalive would be the
   * context's first message, with no `voice_settings`, and ElevenLabs would
   * reject the later context-init with a 1008 policy violation. A context-less
   * keepalive is sufficient until the context-init is sent.
   */
  protected override async _sendKeepalive(): Promise<void> {
    if (!this._websocket || this._websocket.state !== State.OPEN) {
      return;
    }

    const contextId = this.getActiveAudioContextId();
    let keepaliveMessage: Dict;
    if (contextId && this._contextInitSent.has(contextId)) {
      // The context's voice_settings context-init has been sent, so it's safe
      // to keep that context alive.
      keepaliveMessage = { text: "", context_id: contextId };
    } else {
      // No active context, or the active context's context-init hasn't been
      // sent yet. A context-less keepalive keeps the connection alive without
      // opening the context prematurely.
      keepaliveMessage = { text: "" };
    }
    await this._websocket.send(pyJsonDumps(keepaliveMessage));
  }

  /** Open a context, carrying voice settings. */
  protected override async _sendContextInit(contextId: string): Promise<void> {
    // Mark the context-init as sent so the keepalive may now target this
    // contextId.
    this._contextInitSent.add(contextId);
    const msg: Dict = { text: " ", context_id: contextId };
    if (this._voiceSettings) {
      msg.voice_settings = this._voiceSettings;
    }
    await this._getWebsocket().send(pyJsonDumps(msg));
  }

  /** Send text to the WebSocket for synthesis. */
  protected override async _sendText(text: string, contextId: string): Promise<void> {
    if (this._websocket && contextId) {
      const msg = { text, context_id: contextId };
      await this._websocket.send(pyJsonDumps(msg));
    }
  }
}

export interface ElevenLabsHttpTTSServiceOptions extends TTSServiceOptions {
  /** ElevenLabs API key for authentication. */
  apiKey: string;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: replaces upstream's required `aiohttp_session`.
   */
  fetch?: typeof fetch | null;
  /** Base URL for ElevenLabs HTTP API. Defaults to "https://api.elevenlabs.io". */
  baseUrl?: string;
  /**
   * Whether to enable ElevenLabs server-side logging. Set to false for zero
   * retention mode (enterprise only).
   */
  enableLogging?: boolean | null;
  /**
   * Runtime-updatable settings. Its given fields override the defaults
   * (model "eleven_flash_v2_5").
   */
  settings?: ElevenLabsHttpTTSSettings | null;
}

/** Split a byte stream into lines, as iterating an aiohttp `StreamReader` does. */
async function* iterLines(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array, void, unknown> {
  if (!body) return;
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await abortable(reader.read());
      if (done) break;
      if (!value || value.length === 0) continue;
      const merged = new Uint8Array(buffer.length + value.length);
      merged.set(buffer);
      merged.set(value, buffer.length);
      buffer = merged;
      let nl = buffer.indexOf(0x0a);
      while (nl !== -1) {
        yield buffer.slice(0, nl + 1);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf(0x0a);
      }
    }
    if (buffer.length > 0) {
      yield buffer;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already closed or errored.
    }
  }
}

/**
 * ElevenLabs HTTP-based TTS service with word timestamps.
 *
 * Provides text-to-speech using ElevenLabs' HTTP streaming API for simpler,
 * non-WebSocket integration. Suitable for use cases where streaming WebSocket
 * connection is not required or desired.
 */
export class ElevenLabsHttpTTSService extends TTSService {
  static Settings: typeof ElevenLabsHttpTTSSettings = ElevenLabsHttpTTSSettings;
  declare protected _settings: ElevenLabsHttpTTSSettings;

  static {
    installTracedTts(ElevenLabsHttpTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _fetch: typeof fetch;
  protected _enableLogging: boolean | null;
  protected _outputFormat: string;
  protected _voiceSettings: Dict | null;
  /** Track cumulative time to properly sequence word timestamps across utterances. */
  protected _cumulativeTime: number;
  /** Store previous text for context within a turn. */
  protected _previousText: string;
  /** Track partial words that span across alignment chunks. */
  protected _partialWord: string;
  protected _partialWordStartTime: number;
  protected _audioTagExpressionAdapter: ElevenLabsAudioTagExpressionAdapter;

  /**
   * Initialize the ElevenLabs HTTP TTS service.
   *
   * @param options.apiKey ElevenLabs API key for authentication.
   * @param options.fetch `fetch` used for HTTP requests (upstream: an aiohttp
   *   ClientSession).
   * @param options.baseUrl Base URL for ElevenLabs HTTP API.
   * @param options.sampleRate Audio sample rate. If null, uses default.
   * @param options.enableLogging Whether to enable ElevenLabs server-side
   *   logging. Set to false for zero retention mode (enterprise only).
   * @param options.settings Runtime-updatable settings.
   * @param options.textAggregationMode How to aggregate incoming text before
   *   synthesis. Other options are passed to the parent service.
   */
  constructor(options: ElevenLabsHttpTTSServiceOptions) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof ElevenLabsHttpTTSService).Settings({
      model: "eleven_flash_v2_5",
      voice: null,
      language: null,
      optimizeStreamingLatency: null,
      stability: null,
      similarityBoost: null,
      style: null,
      useSpeakerBoost: null,
      speed: null,
      applyTextNormalization: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      pushTextFrames: false,
      pushStopFrames: true,
      pushStartFrame: true,
      sampleRate: options.sampleRate ?? null,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl ?? "https://api.elevenlabs.io";
    this._fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this._enableLogging = options.enableLogging ?? null;

    this._outputFormat = ""; // initialized in setup()
    this._voiceSettings = this._setVoiceSettings();

    // Track cumulative time to properly sequence word timestamps across utterances
    this._cumulativeTime = 0;

    // Store previous text for context within a turn
    this._previousText = "";

    // Track partial words that span across alignment chunks
    this._partialWord = "";
    this._partialWordStartTime = 0.0;

    this._audioTagExpressionAdapter = new ElevenLabsAudioTagExpressionAdapter();
  }

  /**
   * The adapter for the model: audio tags on Eleven v3 and v4, otherwise none.
   *
   * @returns The expression adapter for the current model.
   */
  override getExpressionAdapter(): BaseExpressionAdapter {
    const model = this._settings.model;
    if (
      typeof model === "string" &&
      (model.startsWith("eleven_v3") || model.startsWith("eleven_v4"))
    ) {
      return this._audioTagExpressionAdapter;
    }
    return super.getExpressionAdapter();
  }

  /**
   * Convert pipecat Language to ElevenLabs language code.
   *
   * @param language The language to convert.
   * @returns The ElevenLabs-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToElevenlabsLanguage(language);
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as ElevenLabs HTTP service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Render a pronunciation as SSML `<phoneme>` tags.
   *
   * See `formatElevenlabsPronunciation`.
   *
   * @param word The word being pronounced.
   * @param ipa The pronunciation, in IPA.
   * @returns The phoneme tags, or null when the pronunciation cannot be used.
   */
  static override formatPronunciation(word: string, ipa: string): string | null {
    return formatElevenlabsPronunciation(word, ipa);
  }

  /**
   * Whether phoneme tags are read with the current model.
   *
   * They are read only with a model in `ELEVENLABS_PHONEME_MODELS`.
   *
   * @returns True when phoneme tags are read.
   */
  override get supportsPronunciations(): boolean {
    return ELEVENLABS_PHONEME_MODELS.has(this._settings.model as string);
  }

  protected _setVoiceSettings(): Dict | null {
    return buildElevenlabsVoiceSettings(this._settings);
  }

  /**
   * Apply a settings delta and rebuild voice settings.
   *
   * @param delta A TTSSettings (or `ElevenLabsHttpTTSService.Settings`) delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if (Object.keys(changed).length > 0) {
      this._voiceSettings = this._setVoiceSettings();
    }
    return changed;
  }

  /** Reset internal state variables. */
  protected _resetState(): void {
    this._cumulativeTime = 0;
    this._previousText = "";
    this._partialWord = "";
    this._partialWordStartTime = 0.0;
    logger.debug(`${this}: Reset internal state`);
  }

  /**
   * Set up the service.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._outputFormat = outputFormatFromSampleRate(this.sampleRate);
    this._resetState();
  }

  /**
   * Push a frame and handle state changes.
   *
   * @param frame The frame to push.
   * @param direction The direction to push the frame.
   */
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    await super.pushFrame(frame, direction);
    if (frame instanceof InterruptionFrame || frame instanceof TTSStoppedFrame) {
      // Reset timing on interruption or stop
      this._resetState();
    } else if (frame instanceof LLMFullResponseEndFrame) {
      // End of turn - reset previous text
      this._previousText = "";
    }
  }

  /**
   * Calculate word timing from character alignment data.
   *
   * This method handles partial words that may span across multiple
   * alignment chunks.
   *
   * @param alignmentInfo Character timing data from ElevenLabs.
   * @param options.audioTags Whether a bracketed audio tag, such as
   *   `[short pause]`, is one word, spaces and all.
   * @returns List of [word, timestamp] pairs for complete words in this chunk.
   *
   * @example
   * // Input data:
   * // {
   * //   characters: [" ", "H", "e", "l", "l", "o", " ", "w", "o", "r", "l", "d"],
   * //   character_start_times_seconds: [0.0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
   * //   character_end_times_seconds: [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
   * // }
   * // Would produce word times (with cumulativeTime = 0):
   * // [["Hello", 0.1], ["world", 0.5]]
   */
  calculateWordTimes(
    alignmentInfo: Dict,
    options: { audioTags?: boolean } = {},
  ): [string, number][] {
    const audioTags = options.audioTags ?? false;
    const chars: string[] = alignmentInfo.characters ?? [];
    const charStartTimes: number[] = alignmentInfo.character_start_times_seconds ?? [];

    if (
      chars.length === 0 ||
      charStartTimes.length === 0 ||
      chars.length !== charStartTimes.length
    ) {
      logger.warning(
        `Invalid alignment data: chars=${chars.length}, times=${charStartTimes.length}`,
      );
      return [];
    }

    // Build the words and find their start times
    const words: string[] = [];
    const wordStartTimes: number[] = [];
    // Start with any partial word from previous chunk
    let currentWord = this._partialWord;
    let wordStartTime: number | null = this._partialWord ? this._partialWordStartTime : null;
    let inTag = audioTags && _endsInAudioTag(currentWord);

    for (let i = 0; i < chars.length; i++) {
      const char = chars[i]!;
      if (audioTags && (char === "[" || char === "]")) {
        inTag = char === "[";
      }
      if (char === " " && !inTag) {
        if (currentWord) {
          // Only add non-empty words
          words.push(currentWord);
          wordStartTimes.push(wordStartTime as number);
          currentWord = "";
          wordStartTime = null;
        }
      } else {
        if (wordStartTime === null) {
          // First character of a new word
          // Use time of the first character of the word, offset by cumulative time
          wordStartTime = this._cumulativeTime + charStartTimes[i]!;
        }
        currentWord += char;
      }
    }

    // Store any incomplete word at the end of this chunk
    this._partialWord = currentWord ? currentWord : "";
    this._partialWordStartTime = wordStartTime !== null ? wordStartTime : 0.0;

    // Create word-time pairs for complete words only
    const wordTimes: [string, number][] = words.map((w, i) => [w, wordStartTimes[i]!]);

    return wordTimes;
  }

  /** `includesInterFrameSpaces` for the current language. */
  protected _includesInterFrameSpaces(): true | null {
    return _wordTimestampsIncludeInterFrameSpaces(assertGiven(this._settings.language))
      ? true
      : null;
  }

  /**
   * Generate speech from text using ElevenLabs streaming API with timestamps.
   *
   * Makes a request to the ElevenLabs API to generate audio and timing data.
   * Tracks the duration of each utterance to ensure correct sequencing.
   * Includes previous text as context for better prosody continuity.
   *
   * @param text Text to convert to speech.
   * @param contextId The context ID for tracking audio frames.
   * @yields Audio and control frames containing the synthesized speech.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    // Use the with-timestamps endpoint
    const url = `${this._baseUrl}/v1/text-to-speech/${this._settings.voice}/stream/with-timestamps`;

    const modelId = assertGiven(this._settings.model);
    const payload: Dict = {
      text,
      model_id: modelId,
    };

    // Include previous text as context when the model supports it
    if (this._previousText && !ELEVENLABS_CONTEXT_UNSUPPORTED_MODELS.has(modelId as string)) {
      payload.previous_text = this._previousText;
    }

    if (this._voiceSettings) {
      payload.voice_settings = this._voiceSettings;
    }

    const applyTextNormalization = assertGiven(this._settings.applyTextNormalization);
    if (applyTextNormalization !== null) {
      payload.apply_text_normalization = applyTextNormalization;
    }

    const languageCode = elevenlabsLanguageCode(modelId, assertGiven(this._settings.language));
    if (languageCode) {
      payload.language_code = languageCode;
    }

    const headers = {
      "xi-api-key": this._apiKey,
      "Content-Type": "application/json",
    };

    // Build query parameters
    const params = new URLSearchParams({ output_format: this._outputFormat });
    const optimizeStreamingLatency = assertGiven(this._settings.optimizeStreamingLatency);
    if (optimizeStreamingLatency !== null) {
      params.set("optimize_streaming_latency", String(optimizeStreamingLatency));
    }
    if (this._enableLogging !== null) {
      params.set("enable_logging", String(this._enableLogging).toLowerCase());
    }

    try {
      const response = await abortable(
        this._fetch(`${url}?${params.toString()}`, {
          method: "POST",
          headers,
          body: pyJsonDumps(payload),
          signal: currentSignal(),
        }),
      );
      try {
        if (response.status !== 200) {
          const errorText = await abortable(response.text());
          yield new ErrorFrame({ error: `ElevenLabs API error: ${errorText}` });
          return;
        }

        await this.startTtsUsageMetrics(text);

        // Track the duration of this utterance based on the last character's end time
        let utteranceDuration = 0;
        let alignmentStarted = false;
        // Strict, like Python's `bytes.decode("utf-8")`: invalid bytes raise.
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for await (const line of iterLines(response.body)) {
          const lineStr = decoder.decode(line).trim();
          if (!lineStr) {
            continue;
          }

          let data: Dict;
          try {
            // Parse the JSON object
            data = pyJsonLoads(lineStr) as Dict;
          } catch (e) {
            rethrowIfCancelled(e);
            logger.warning(`Failed to parse JSON from stream: ${errorMessage(e)}`);
            continue;
          }

          try {
            // Process audio if present
            if (data && typeof data === "object" && "audio_base64" in data) {
              await this.stopTtfbMetrics();
              const audio = base64ToBytes(data.audio_base64);
              yield new TTSAudioRawFrame({
                audio,
                sampleRate: this.sampleRate,
                numChannels: 1,
                contextId,
              });
            }

            const rawAlignment =
              data && typeof data === "object"
                ? _selectAlignment(data, {
                    normalizedKey: "normalized_alignment",
                    alignmentKey: "alignment",
                    preferNormalized: false,
                  })
                : null;
            if (rawAlignment && Object.keys(rawAlignment).length > 0) {
              const alignment = _stripUtteranceLeadingSpaces(
                rawAlignment,
                ["characters", "character_start_times_seconds", "character_end_times_seconds"],
                !alignmentStarted,
              );
              alignmentStarted = true;
              // Get end time of the last character in this chunk
              const charEndTimes: number[] = alignment.character_end_times_seconds ?? [];
              if (charEndTimes.length > 0) {
                const chunkEndTime = charEndTimes.at(-1)!;
                // Update to the longest end time seen so far
                utteranceDuration = Math.max(utteranceDuration, chunkEndTime);
              }

              // Calculate word timestamps. The audio tags expressive
              // conversation sends mark when its sounds are performed.
              const wordTimes = this.calculateWordTimes(alignment, {
                audioTags: Boolean(this._expressionFormatter),
              });
              if (wordTimes.length > 0) {
                await this.addWordTimestamps(wordTimes, contextId, {
                  includesInterFrameSpaces: this._includesInterFrameSpaces(),
                });
              }
            }
          } catch (e) {
            rethrowIfCancelled(e);
            yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
          }
        }

        // After processing all chunks, emit any remaining partial word since
        // this is the end of the utterance
        if (this._partialWord) {
          const finalWordTime: [string, number][] = [
            [this._partialWord, this._partialWordStartTime],
          ];
          await this.addWordTimestamps(finalWordTime, contextId, {
            includesInterFrameSpaces: this._includesInterFrameSpaces(),
          });
          this._partialWord = "";
          this._partialWordStartTime = 0.0;
        }

        // After processing all chunks, add the total utterance duration to
        // the cumulative time to ensure next utterance starts after this one
        if (utteranceDuration > 0) {
          this._cumulativeTime += utteranceDuration;
        }

        // Append the current text to previous_text for context continuity
        // Only add a space if there's already text
        if (this._previousText) {
          this._previousText += ` ${text}`;
        } else {
          this._previousText = text;
        }
      } finally {
        if (!response.bodyUsed) {
          try {
            await response.body?.cancel();
          } catch {
            // The body is already closed.
          }
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    } finally {
      await this.stopTtfbMetrics();
    }
  }
}
