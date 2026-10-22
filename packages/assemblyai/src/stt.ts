// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/assemblyai/stt.py

/**
 * AssemblyAI speech-to-text services.
 *
 * `AssemblyAISTTService` streams audio to AssemblyAI's Universal-Streaming v3
 * WebSocket API; `AssemblyAISyncSTTService` transcribes whole speech segments
 * against the Sync API over HTTP.
 *
 * Wire-format sources (checked against upstream's code):
 * - Streaming API: https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api
 *   (endpoint `wss://streaming.assemblyai.com/v3/ws`, raw `Authorization` key header, query
 *   parameters, binary audio chunks of 50-1000 ms, `Terminate` / `ForceEndpoint` /
 *   `UpdateConfiguration` client messages, `Begin` / `Turn` / `SpeechStarted` /
 *   `Termination` server messages).
 * - Sync API: https://www.assemblyai.com/docs/sync-stt/getting-started/transcribe-a-short-audio-file
 *   and https://www.assemblyai.com/docs/sync-stt/conversation-context (multipart `audio` and
 *   `config` parts, `X-AAI-Model` header).
 *
 * Porting notes:
 * - The socket is opened through `WebsocketService._websocketConnect()` (core's
 *   `websocketConnect`), which sends the `Authorization` header on Bun, Node,
 *   Deno and Workers alike. No SDK is used.
 * - DIVERGENCE: deprecated upstream APIs are not ported: the `language` and
 *   `connection_params` constructor arguments and `AssemblyAIConnectionParams`
 *   (all deprecated since 0.0.105). Use `settings`.
 * - DIVERGENCE: upstream's required `aiohttp_session` for `AssemblyAISyncSTTService`
 *   becomes an optional `fetch` option (the global `fetch` by default). The multipart
 *   body is built by hand so the parts carry exactly the headers aiohttp sends.
 * - Query strings are encoded with `quote_plus` rules, like Python's `urlencode`.
 */

import {
  abortable,
  currentSignal,
  Event,
  rethrowIfCancelled,
  type Task,
  TimeoutError,
  waitFor,
} from "@pipedog/asyncio";
import { version as pipecatVersion } from "@pipedog/core";
import {
  type CancelFrame,
  type EndFrame,
  ErrorFrame,
  type Frame,
  InterimTranscriptionFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  type STTMetadataFrame,
  type StartFrame,
  TranscriptionFrame,
  type VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import type { FrameDirection, FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { ASSEMBLYAI_SYNC_TTFS_P99, ASSEMBLYAI_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import {
  SegmentedSTTService,
  type SegmentedSTTServiceOptions,
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { isLanguage, Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import {
  type BaseMessage,
  BeginMessage,
  SpeechStartedMessage,
  TerminationMessage,
  TurnMessage,
} from "./models.ts";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Maximum length of an `agent_context` value (context carryover). AssemblyAI
 * keeps a rolling ~1500-character budget of carryover context, so longer values
 * are clipped before sending; a single value can never exceed the whole budget.
 */
export const MAX_AGENT_CONTEXT_CHARS = 1500;

/**
 * Model-name prefixes shared by every Universal-3 Pro streaming variant, all of
 * which expose the full U3 Pro feature set: built-in turn detection, prompting,
 * continuous partials, interruption_delay, context carryover, and voice focus.
 * universal-3-6-pro and universal-3-5-pro share that feature set; 3.6 covers 32
 * declared languages against 3.5's 19.
 */
export const U3_PRO_MODEL_PREFIXES: readonly string[] = [
  "u3-rt-pro",
  "universal-3-5-pro",
  "universal-3-6-pro",
];

/**
 * Settings AssemblyAI accepts in an `UpdateConfiguration` message, so changing
 * them applies to the live session. Every other setting is a connect-time query
 * parameter and only takes effect on a new connection.
 */
export const HOT_UPDATABLE_SETTINGS: ReadonlySet<string> = new Set([
  "agentContext",
  "languageCodes",
]);

/**
 * Longest declared-language list the streaming API accepts. The Sync API sets no
 * such limit, so it prepares its codes without a cap.
 */
export const MAX_LANGUAGE_CODES = 10;

/**
 * Return whether a model name is a Universal-3 Pro streaming variant.
 *
 * Matches the `u3-rt-pro` family (`u3-rt-pro`, `u3-rt-pro-beta-1`, and any
 * `u3-rt-pro-*` variant) and the `universal-3-5-pro` / `universal-3-6-pro`
 * releases (and any `universal-3-5-pro-*` / `universal-3-6-pro-*` variant) so U3
 * Pro-only features are gated on the whole family rather than a single exact
 * string.
 *
 * @param model The model identifier. Anything that is not a matching string
 *   returns false.
 * @returns True if `model` is a U3 Pro family model.
 */
export function isU3ProModel(model: unknown): boolean {
  return typeof model === "string" && U3_PRO_MODEL_PREFIXES.some((p) => model.startsWith(p));
}

/**
 * Map AssemblyAI language codes to the Language enum.
 *
 * AssemblyAI returns simple language codes like "es", "fr", etc.
 *
 * @param languageCode AssemblyAI language code (e.g., "es", "fr", "de").
 * @returns Corresponding Language enum value, defaulting to Language.EN if not found.
 */
export function mapLanguageFromAssemblyai(languageCode: string): Language {
  const code = languageCode.toLowerCase();
  if (isLanguage(code)) {
    return code;
  }
  logger.warning(`Unknown language code from AssemblyAI: ${languageCode}, defaulting to English`);
  return Language.EN;
}

/**
 * Convert a Language to an AssemblyAI language code.
 *
 * AssemblyAI declares languages as base ISO codes, so regional variants
 * (`Language.ES_MX`) resolve to their base code (`"es"`).
 *
 * @param language The Language enum value to convert.
 * @returns The AssemblyAI language code.
 */
export function languageToAssemblyaiLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.AF]: "af",
    [Language.AR]: "ar",
    [Language.CA]: "ca",
    [Language.DA]: "da",
    [Language.DE]: "de",
    [Language.EN]: "en",
    [Language.ES]: "es",
    [Language.ET]: "et",
    [Language.FA]: "fa",
    [Language.FI]: "fi",
    [Language.FR]: "fr",
    [Language.GL]: "gl",
    [Language.HE]: "he",
    [Language.HI]: "hi",
    [Language.IT]: "it",
    [Language.JA]: "ja",
    [Language.KO]: "ko",
    [Language.MR]: "mr",
    [Language.NL]: "nl",
    [Language.NN]: "nn",
    [Language.NO]: "no",
    [Language.PT]: "pt",
    [Language.RO]: "ro",
    [Language.RU]: "ru",
    [Language.SV]: "sv",
    [Language.TR]: "tr",
    [Language.UR]: "ur",
    [Language.VI]: "vi",
    [Language.XH]: "xh",
    [Language.YUE]: "yue",
    [Language.ZH]: "zh",
    [Language.ZU]: "zu",
  };
  return resolveLanguage(language, LANGUAGE_MAP, true);
}

/**
 * Resolve declared languages to the AssemblyAI codes sent on the wire.
 *
 * Duplicates are collapsed (regional variants of one language share a base
 * code) while preserving order, which the steering prompt follows.
 *
 * @param languageCodes Declared languages.
 * @param options.maxCodes Most distinct codes the endpoint accepts, or null for
 *   an endpoint that sets no limit.
 * @returns AssemblyAI language codes, deduplicated in declaration order.
 * @throws Error If more than `maxCodes` distinct languages remain after resolution.
 */
export function _prepareLanguageCodes(
  languageCodes: Language[],
  options: { maxCodes?: number | null } = {},
): string[] {
  const maxCodes = options.maxCodes === undefined ? MAX_LANGUAGE_CODES : options.maxCodes;
  const prepared = languageCodes.map((lang) => languageToAssemblyaiLanguage(lang));
  const deduped = [...new Set(prepared)];
  if (maxCodes !== null && deduped.length > maxCodes) {
    throw new Error(`language_codes accepts at most ${maxCodes} languages, got ${deduped.length}.`);
  }
  return deduped;
}

/** Python's `urllib.parse.quote_plus`. */
function quotePlus(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/** Python's `str(float)` for the integral values a float setting can hold (`1` -> `1.0`). */
function pyFloatStr(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

export interface AssemblyAISTTSettingsOptions extends STTSettingsOptions {
  /** Whether to enable transcript formatting. */
  formattedFinals?: boolean | NotGiven;
  /** Maximum time to wait for word finalization in milliseconds. */
  wordFinalizationMaxWaitTime?: number | null | NotGiven;
  /** Confidence threshold for end-of-turn detection. */
  endOfTurnConfidenceThreshold?: number | null | NotGiven;
  /** Minimum silence duration when confident about end-of-turn. */
  minTurnSilence?: number | null | NotGiven;
  /** Maximum silence duration before forcing end-of-turn. */
  maxTurnSilence?: number | null | NotGiven;
  /** List of key terms to guide transcription. */
  keytermsPrompt?: string[] | null | NotGiven;
  /** Text prompt to guide transcription (U3 Pro models only). */
  prompt?: string | null | NotGiven;
  /** Enable automatic language detection. */
  languageDetection?: boolean | null | NotGiven;
  /** Customer-declared audio language as an ISO code. Prefer `languageCodes`. */
  languageCode?: string | null | NotGiven;
  /** Customer-declared audio languages; order is significant. U3 Pro only; hot-updatable. */
  languageCodes?: Language[] | null | NotGiven;
  /** Whether to format transcript turns. */
  formatTurns?: boolean | NotGiven;
  /** Enable speaker diarization. */
  speakerLabels?: boolean | null | NotGiven;
  /** VAD confidence threshold (0.0-1.0). U3 Pro only. */
  vadThreshold?: number | null | NotGiven;
  /** Domain for specialized recognition modes (e.g. "medical-v1"). */
  domain?: string | null | NotGiven;
  /** Emit partial transcripts at a steady cadence during long turns. U3 Pro only. */
  continuousPartials?: boolean | NotGiven;
  /** Override (0-1000 ms) for how soon the first partial is emitted. U3 Pro only. */
  interruptionDelay?: number | null | NotGiven;
  /** Context carryover seed: the agent's latest spoken reply. U3 Pro only; hot-updatable. */
  agentContext?: string | null | NotGiven;
  /** Maximum number of prior conversation entries carried as context ([0, 100]). U3 Pro only. */
  previousContextNTurns?: number | null | NotGiven;
  /** Isolate the primary voice: "near-field" or "far-field". U3 Pro only. */
  voiceFocus?: "near-field" | "far-field" | null | NotGiven;
  /** How aggressively background audio is suppressed ([0.0, 1.0]). U3 Pro only. */
  voiceFocusThreshold?: number | null | NotGiven;
  /** Latency/accuracy preset. U3 Pro only. */
  mode?: "min_latency" | "balanced" | "max_accuracy" | null | NotGiven;
}

/**
 * Settings for AssemblyAISTTService.
 *
 * See `AssemblyAISTTSettingsOptions` for each field. Fields marked "U3 Pro
 * only" are sent (or applied) only for the Universal-3 Pro model family.
 * `languageCodes` and `agentContext` apply to a live session without
 * reconnecting; every other field is a connect-time query parameter.
 */
export class AssemblyAISTTSettings extends STTSettings {
  formattedFinals: boolean | NotGiven = NOT_GIVEN;
  wordFinalizationMaxWaitTime: number | null | NotGiven = NOT_GIVEN;
  endOfTurnConfidenceThreshold: number | null | NotGiven = NOT_GIVEN;
  minTurnSilence: number | null | NotGiven = NOT_GIVEN;
  maxTurnSilence: number | null | NotGiven = NOT_GIVEN;
  keytermsPrompt: string[] | null | NotGiven = NOT_GIVEN;
  prompt: string | null | NotGiven = NOT_GIVEN;
  languageDetection: boolean | null | NotGiven = NOT_GIVEN;
  languageCode: string | null | NotGiven = NOT_GIVEN;
  languageCodes: Language[] | null | NotGiven = NOT_GIVEN;
  formatTurns: boolean | NotGiven = NOT_GIVEN;
  speakerLabels: boolean | null | NotGiven = NOT_GIVEN;
  vadThreshold: number | null | NotGiven = NOT_GIVEN;
  domain: string | null | NotGiven = NOT_GIVEN;
  continuousPartials: boolean | NotGiven = NOT_GIVEN;
  interruptionDelay: number | null | NotGiven = NOT_GIVEN;
  agentContext: string | null | NotGiven = NOT_GIVEN;
  previousContextNTurns: number | null | NotGiven = NOT_GIVEN;
  voiceFocus: "near-field" | "far-field" | null | NotGiven = NOT_GIVEN;
  voiceFocusThreshold: number | null | NotGiven = NOT_GIVEN;
  mode: "min_latency" | "balanced" | "max_accuracy" | null | NotGiven = NOT_GIVEN;

  constructor(options: AssemblyAISTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface AssemblyAISTTServiceOptions extends WebsocketSTTServiceOptions {
  /** AssemblyAI API key for authentication. */
  apiKey: string;
  /** WebSocket endpoint URL. Defaults to "wss://streaming.assemblyai.com/v3/ws". */
  apiEndpointBaseUrl?: string;
  /** Audio encoding format. Defaults to "pcm_s16le". */
  encoding?: string;
  /**
   * Controls turn detection mode. When true (Pipecat mode, default), AssemblyAI
   * is forced to return finals ASAP so Pipecat's turn detection decides when the
   * user is done. When false (AssemblyAI turn detection mode, U3 Pro models
   * only), AssemblyAI's model controls turn endings and the service proposes
   * turn starts and stops.
   */
  vadForceTurnEndpoint?: boolean;
  /**
   * Whether to interrupt the bot when the user starts speaking in AssemblyAI
   * turn detection mode (`vadForceTurnEndpoint: false`). Defaults to true.
   */
  shouldInterrupt?: boolean;
  /**
   * Format string for speaker labels when diarization is enabled; use
   * `{speaker}` and `{text}`. Example: "<{speaker}>{text}</{speaker}>".
   */
  speakerFormat?: string | null;
  /** Runtime-updatable settings. */
  settings?: AssemblyAISTTSettings | null;
}

/**
 * AssemblyAI real-time speech-to-text service.
 *
 * Provides real-time speech transcription using AssemblyAI's WebSocket API.
 * Supports both interim and final transcriptions with configurable parameters
 * for audio processing and connection management.
 *
 * Event handlers available (in addition to WebsocketSTTService events):
 *
 * - on_end_of_turn(service, transcript): Called when AssemblyAI detects end of turn.
 *
 * @example
 * service.addEventHandler("on_end_of_turn", async (service, transcript) => {
 *   // ...
 * });
 */
export class AssemblyAISTTService extends WebsocketSTTService {
  static Settings: typeof AssemblyAISTTSettings = AssemblyAISTTSettings;
  declare protected _settings: AssemblyAISTTSettings;

  static {
    installTracedStt(AssemblyAISTTService.prototype, "_traceTranscription");
  }

  protected _apiKey: string;
  protected _apiEndpointBaseUrl: string;
  protected _vadForceTurnEndpoint: boolean;
  protected _shouldInterrupt: boolean;
  protected _speakerFormat: string | null;
  protected _encoding: string;
  protected _terminationEvent = new Event();
  protected _connected = false;
  protected _receiveTask: Task<unknown> | null = null;
  protected _audioBuffer: Uint8Array = new Uint8Array(0);
  protected _chunkSizeMs = 50;
  protected _chunkSizeBytes = 0;
  protected override _userSpeaking = false;
  // Warn only once if updateAgentContext is called on a non-U3 Pro model (the
  // observer would otherwise warn on every bot turn).
  protected _agentContextWarned = false;
  // Same, for a language re-steer on a model that can't be steered.
  protected _languageCodesWarned = false;

  /**
   * Initialize the AssemblyAI STT service.
   *
   * @param options.apiKey AssemblyAI API key for authentication.
   * @param options.apiEndpointBaseUrl WebSocket endpoint URL. Defaults to
   *   AssemblyAI's streaming endpoint.
   * @param options.sampleRate Audio sample rate in Hz. If null, uses the input
   *   sample rate from the start frame.
   * @param options.encoding Audio encoding format. Defaults to "pcm_s16le".
   * @param options.vadForceTurnEndpoint Turn detection mode (see the options
   *   interface). In Pipecat mode `min_turn_silence` defaults to 100ms on U3 Pro
   *   models, `max_turn_silence` is always set equal to it, and a VAD stop sends
   *   `ForceEndpoint`.
   * @param options.shouldInterrupt Whether AssemblyAI turn starts interrupt the
   *   bot. Passed to the user turn strategies this service recommends.
   * @param options.speakerFormat Format string for speaker labels.
   * @param options.settings Runtime-updatable settings.
   * @param options.ttfsP99Latency P99 latency from speech end to final transcript
   *   in seconds. See https://github.com/pipecat-ai/stt-benchmark. Other options
   *   are passed to WebsocketSTTService.
   */
  constructor(options: AssemblyAISTTServiceOptions) {
    // 1. Initialize default settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof AssemblyAISTTService).Settings({
      model: "universal-3-6-pro",
      language: Language.EN,
      formattedFinals: true,
      wordFinalizationMaxWaitTime: null,
      endOfTurnConfidenceThreshold: null,
      minTurnSilence: null,
      maxTurnSilence: null,
      keytermsPrompt: null,
      prompt: null,
      languageDetection: null,
      languageCode: null,
      languageCodes: null,
      formatTurns: true,
      speakerLabels: null,
      vadThreshold: null,
      domain: null,
      continuousPartials: true,
      interruptionDelay: null,
      agentContext: null,
      previousContextNTurns: null,
      voiceFocus: null,
      voiceFocusThreshold: null,
      mode: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    const vadForceTurnEndpoint = options.vadForceTurnEndpoint ?? true;

    // 3. Validate final settings
    const isU3Pro = isU3ProModel(defaultSettings.model);
    if (!vadForceTurnEndpoint && !isU3Pro) {
      throw new Error(
        "AssemblyAI turn detection mode (vadForceTurnEndpoint=false) requires " +
          "a U3 Pro model for SpeechStarted support. Either set " +
          `vadForceTurnEndpoint=true for ${defaultSettings.model}, ` +
          "or use model='universal-3-6-pro'.",
      );
    }

    if (!isU3Pro && defaultSettings.prompt !== null) {
      throw new Error(
        "prompt is only supported by U3 Pro models and will be rejected by the server " +
          `for model ${defaultSettings.model}. Use keytermsPrompt instead, or switch to ` +
          "a U3 Pro model to use prompt (optionally combined with keytermsPrompt). " +
          "For more info go to: https://www.assemblyai.com/docs/streaming/universal-3-pro",
      );
    }

    // continuous_partials and interruption_delay are U3 Pro-only.
    const interruptionDelay = defaultSettings.interruptionDelay;
    if (
      typeof interruptionDelay === "number" &&
      !(interruptionDelay >= 0 && interruptionDelay <= 1000)
    ) {
      throw new Error("interruption_delay must be between 0 and 1000 ms");
    }

    if (!isU3Pro && typeof interruptionDelay === "number") {
      logger.warning(
        "interruption_delay is only supported by U3 Pro models and will be ignored " +
          `for model '${defaultSettings.model}'.`,
      );
    }

    // previous_context_n_turns is U3 Pro-only (context carryover). Valid range
    // is [0, 100] (0 disables carryover entirely), matching the server.
    const previousContextNTurns = defaultSettings.previousContextNTurns;
    if (
      typeof previousContextNTurns === "number" &&
      !(previousContextNTurns >= 0 && previousContextNTurns <= 100)
    ) {
      throw new Error("previous_context_n_turns must be between 0 and 100");
    }

    if (!isU3Pro && typeof previousContextNTurns === "number") {
      logger.warning(
        "previous_context_n_turns is only supported by U3 Pro models and will be ignored " +
          `for model '${defaultSettings.model}'.`,
      );
    }

    // voice_focus / voice_focus_threshold are U3 Pro-only. The threshold is a
    // float in [0, 1].
    const voiceFocus = defaultSettings.voiceFocus;
    const voiceFocusThreshold = defaultSettings.voiceFocusThreshold;
    if (typeof voiceFocusThreshold === "number") {
      if (!(voiceFocusThreshold >= 0.0 && voiceFocusThreshold <= 1.0)) {
        throw new Error("voice_focus_threshold must be between 0.0 and 1.0");
      }
    }

    if (!isU3Pro && (voiceFocus !== null || voiceFocusThreshold !== null)) {
      logger.warning(
        "voice_focus and voice_focus_threshold are only supported by U3 Pro models " +
          `and will be ignored for model '${defaultSettings.model}'.`,
      );
    }

    if (voiceFocusThreshold !== null && voiceFocus === null) {
      logger.warning(
        "voice_focus_threshold has no effect unless voice_focus is set " +
          "(to 'near-field' or 'far-field').",
      );
    }

    // mode (latency/accuracy preset) is U3 Pro-only; the server rejects it for
    // other models.
    if (!isU3Pro && defaultSettings.mode !== null) {
      logger.warning(
        "mode is only supported by U3 Pro models and will be ignored " +
          `for model '${defaultSettings.model}'.`,
      );
    }

    // AssemblyAI rejects an over-long declared-language list at connect time,
    // so fail where it was set. Counted after resolution, since that is the
    // list the server sees.
    if (Array.isArray(defaultSettings.languageCodes)) {
      _prepareLanguageCodes(defaultSettings.languageCodes);
    }

    // Language steering is prompt-based and therefore U3 Pro-only. Other models,
    // including universal-streaming-multilingual, which transcribes multilingual
    // audio without steering, don't accept it, so it isn't sent.
    if (!isU3Pro && Array.isArray(defaultSettings.languageCodes)) {
      logger.warning(
        "language_codes is only supported by U3 Pro models and will be ignored " +
          `for model '${defaultSettings.model}'.`,
      );
    }

    const declaredLanguageFields: string[] = [];
    if (defaultSettings.languageCode !== null) declaredLanguageFields.push("language_code");
    if (defaultSettings.languageCodes !== null) declaredLanguageFields.push("language_codes");
    // Declaring a language and detecting one are independent server-side, and
    // setting both is usually a mistake about which one is in effect.
    if (declaredLanguageFields.length > 0 && defaultSettings.languageDetection) {
      logger.warning(
        `${declaredLanguageFields.join(" and ")} and language_detection are set ` +
          "together. These are independent: the declared codes steer transcription, " +
          "while language_detection reports a detected language on each turn. Both " +
          "will be sent to AssemblyAI as-is.",
      );
    }

    if (declaredLanguageFields.length === 2) {
      logger.warning(
        "language_code and language_codes are both set. AssemblyAI treats them as " +
          "aliases for a single parameter and binds language_codes, ignoring " +
          "language_code entirely. Set only language_codes (a single-element list " +
          "such as [Language.ES] declares one language).",
      );
    }

    // 4. Configure pipecat turn mode (mutates defaultSettings)
    if (vadForceTurnEndpoint) {
      AssemblyAISTTService._configurePipecatTurnMode(defaultSettings, isU3Pro);
    }

    const { apiKey, apiEndpointBaseUrl, encoding, shouldInterrupt, speakerFormat, ...rest } =
      options;
    super({
      ...rest,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? ASSEMBLYAI_TTFS_P99 : options.ttfsP99Latency,
      settings: defaultSettings,
    });

    this._apiKey = apiKey;
    this._apiEndpointBaseUrl = apiEndpointBaseUrl ?? "wss://streaming.assemblyai.com/v3/ws";
    this._vadForceTurnEndpoint = vadForceTurnEndpoint;
    this._shouldInterrupt = shouldInterrupt ?? true;
    this._speakerFormat = speakerFormat ?? null;

    // Init-only audio config (not runtime-updatable)
    this._encoding = encoding ?? "pcm_s16le";

    this._registerEventHandler("on_end_of_turn");
  }

  /**
   * Configure settings for Pipecat turn detection mode.
   *
   * When vadForceTurnEndpoint is enabled, force AssemblyAI to return finals as
   * fast as possible so Pipecat's smart turn analyzer can decide when the user
   * is done speaking. VAD stop is the absolute ceiling.
   *
   * U3 Pro models: `min_turn_silence` defaults to 100ms (user can override);
   * `max_turn_silence` is ALWAYS set equal to `min_turn_silence` to avoid double
   * turn detection (a user-set `max_turn_silence` is overridden with a warning);
   * `end_of_turn_confidence_threshold` is not set (API default).
   *
   * universal-streaming-*: `end_of_turn_confidence_threshold` = 1.0 (disable
   * semantic turn detection), `min_turn_silence` = 160, `max_turn_silence` not
   * set (API default).
   */
  protected static _configurePipecatTurnMode(
    settings: AssemblyAISTTSettings,
    isU3Pro: boolean,
  ): void {
    if (isU3Pro) {
      // U3 Pro: Synchronize max_turn_silence with min_turn_silence
      let minSilence = settings.minTurnSilence;
      if (minSilence === null) {
        minSilence = 100;
      }

      // Warn if user set max_turn_silence (will be overridden)
      if (settings.maxTurnSilence !== null) {
        logger.warning(
          `Your max_turn_silence value (${settings.maxTurnSilence}ms) will be ` +
            "OVERRIDDEN in Pipecat mode (vadForceTurnEndpoint=true). It will be set to " +
            `${minSilence}ms (matching min_turn_silence) and SENT to ` +
            "AssemblyAI to avoid double turn detection. To use your max_turn_silence as-is, " +
            "switch to AssemblyAI turn detection mode (vadForceTurnEndpoint=false).",
        );
      }

      settings.minTurnSilence = minSilence as number;
      settings.maxTurnSilence = minSilence as number;
    } else {
      // universal-streaming: Different configuration (works differently)
      settings.endOfTurnConfidenceThreshold = 1.0;
      settings.minTurnSilence = 160;
    }
  }

  /**
   * Check if the service can generate metrics.
   *
   * @returns True if metrics generation is supported.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Request external turn strategies in AssemblyAI's turn-detection mode.
   *
   * With `vadForceTurnEndpoint: false` AssemblyAI's model decides turn endings
   * and emits `ProposedUserStarted/StoppedSpeakingFrame`, so the user aggregator
   * resolves those rather than running local VAD/smart-turn. In the default
   * Pipecat mode the STT proposes no turns, so the defaults are left in place.
   * Applied unless the user passed their own `userTurnStrategies`.
   */
  override serviceMetadataFrame(): STTMetadataFrame {
    const frame = super.serviceMetadataFrame();
    if (!this._vadForceTurnEndpoint) {
      frame.userTurnStrategies = new ExternalUserTurnStrategies({
        enableInterruptions: this._shouldInterrupt,
      });
    }
    return frame;
  }

  /**
   * Apply a settings delta and apply the changes to the live session.
   *
   * Most settings are connection-time WebSocket query parameters, so changing
   * them reconnects. The fields in `HOT_UPDATABLE_SETTINGS` are the exception:
   * they are applied live via an `UpdateConfiguration` message and do not
   * require a reconnect.
   *
   * @param delta A settings delta with updated values.
   * @returns Dict mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    let d = delta as AssemblyAISTTSettings;
    if (Array.isArray(d.languageCodes)) {
      try {
        _prepareLanguageCodes(d.languageCodes);
      } catch (e) {
        rethrowIfCancelled(e);
        // An over-long list closes the session server-side rather than being
        // ignored, and one that reached _settings would fail every later
        // reconnect too. Drop the field and leave steering as-is.
        logger.warning(`${this} ignoring language_codes update: ${errorMessage(e)}`);
        d = d.copy();
        d.languageCodes = NOT_GIVEN;
      }
    }

    const changed = await super._updateSettings(d);

    const changedNames = Object.keys(changed);
    if (changedNames.length === 0) {
      return changed;
    }

    if (changedNames.some((name) => !HOT_UPDATABLE_SETTINGS.has(name))) {
      // A connect-time-only field changed (they become WS query params, which
      // can only be set when the connection is opened). Reconnect; the new
      // connection's URL re-seeds the hot-updatable fields too.
      await this._disconnect();
      await this._connect();
      return changed;
    }

    if ("agentContext" in changed && typeof this._settings.agentContext === "string") {
      // updateAgentContext() guards on model and clips.
      await this.updateAgentContext(this._settings.agentContext);
    }
    if ("languageCodes" in changed && Array.isArray(this._settings.languageCodes)) {
      // _updateLanguageCodes() guards on model.
      await this._updateLanguageCodes(this._settings.languageCodes);
    }

    return changed;
  }

  /**
   * Re-steer the live session toward a new set of declared languages.
   *
   * Steering is prompt-based and therefore U3 Pro-only; AssemblyAI discards a
   * mid-session change for any other model, so don't bother sending one.
   * Reconnecting wouldn't help either, since those models aren't steered at all.
   *
   * @param languageCodes Declared languages, or an empty list to clear steering
   *   back to the model default.
   */
  protected async _updateLanguageCodes(languageCodes: Language[]): Promise<void> {
    if (!isU3ProModel(this._settings.model)) {
      if (!this._languageCodesWarned) {
        this._languageCodesWarned = true;
        logger.warning(
          `${this} language_codes steering is only supported by U3 Pro models; ` +
            `ignoring mid-session change for model '${this._settings.model}'.`,
        );
      }
      return;
    }

    await this._sendUpdateConfiguration({
      language_codes: _prepareLanguageCodes(languageCodes),
    });
  }

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._chunkSizeBytes = Math.trunc((this._chunkSizeMs * this.sampleRate * 2) / 1000);
    await this._connect();
  }

  /**
   * Stop the speech-to-text service.
   *
   * @param frame End frame to stop processing.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the speech-to-text service.
   *
   * @param frame Cancel frame to abort processing.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /**
   * Process audio data for speech-to-text conversion.
   *
   * Audio is buffered into 50 ms chunks and sent as binary WebSocket messages;
   * transcripts arrive through the receive task.
   *
   * @param audio Raw audio bytes to process.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    const grown = new Uint8Array(this._audioBuffer.length + audio.length);
    grown.set(this._audioBuffer, 0);
    grown.set(audio, this._audioBuffer.length);
    this._audioBuffer = grown;

    if (this._websocket && this._websocket.state === State.OPEN) {
      while (this._audioBuffer.length >= this._chunkSizeBytes) {
        const chunk = this._audioBuffer.slice(0, this._chunkSizeBytes);
        this._audioBuffer = this._audioBuffer.slice(this._chunkSizeBytes);
        try {
          await this._websocket.send(chunk);
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`${this}: send failed: ${errorMessage(e)}`);
          break;
        }
      }
    }

    yield null;
  }

  /**
   * Forward a Pipecat-detected turn end to AssemblyAI as a ForceEndpoint.
   *
   * @param frame Frame to process.
   * @param direction Direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof VADUserStoppedSpeakingFrame) {
      if (this._vadForceTurnEndpoint && this._websocket && this._websocket.state === State.OPEN) {
        this.requestFinalize();
        await this._websocket.send(pyJsonDumps({ type: "ForceEndpoint" }));
      }
    }
  }

  /** Record transcription event for tracing. */
  protected async _traceTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language,
  ): Promise<void> {}

  /** Build the WebSocket URL with query parameters (`urlencode` rules). */
  _buildWsUrl(): string {
    const s = this._settings;
    const params: [string, string][] = [];
    const add = (key: string, value: unknown, float = false): void => {
      if (value === null || value === undefined || !isGiven(value)) {
        return;
      }
      if (typeof value === "boolean") {
        params.push([key, String(value).toLowerCase()]);
      } else if (typeof value === "number" && float) {
        params.push([key, pyFloatStr(value)]);
      } else {
        params.push([key, String(value)]);
      }
    };

    // Init-only audio config
    add("sample_rate", this.sampleRate);
    add("encoding", this._encoding);

    // Map model -> speech_model (AssemblyAI API naming)
    add("speech_model", s.model);

    // Settings fields (skip null values)
    add("formatted_finals", s.formattedFinals);
    add("word_finalization_max_wait_time", s.wordFinalizationMaxWaitTime);
    add("end_of_turn_confidence_threshold", s.endOfTurnConfidenceThreshold, true);
    add("min_turn_silence", s.minTurnSilence);
    add("max_turn_silence", s.maxTurnSilence);
    add("prompt", s.prompt);
    add("language_detection", s.languageDetection);
    add("language_code", s.languageCode);
    add("format_turns", s.formatTurns);
    add("speaker_labels", s.speakerLabels);
    add("vad_threshold", s.vadThreshold, true);
    add("domain", s.domain);

    // continuous_partials, interruption_delay, agent_context,
    // previous_context_n_turns, voice_focus(_threshold), mode, and
    // language_codes only apply to the U3 Pro family.
    if (isU3ProModel(s.model)) {
      add("continuous_partials", s.continuousPartials);
      add("interruption_delay", s.interruptionDelay);
      add("previous_context_n_turns", s.previousContextNTurns);
      add("voice_focus", s.voiceFocus);
      add("voice_focus_threshold", s.voiceFocusThreshold, true);
      add("mode", s.mode);
      if (typeof s.agentContext === "string") {
        add("agent_context", this._clipAgentContext(s.agentContext));
      }
    }

    // List-valued parameters travel as JSON-encoded query values.
    if (isGiven(s.keytermsPrompt) && s.keytermsPrompt !== null) {
      add("keyterms_prompt", pyJsonDumps(s.keytermsPrompt));
    }
    if (isU3ProModel(s.model) && Array.isArray(s.languageCodes)) {
      add("language_codes", pyJsonDumps(_prepareLanguageCodes(s.languageCodes)));
    }

    if (params.length > 0) {
      const query = params.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join("&");
      return `${this._apiEndpointBaseUrl}?${query}`;
    }
    return this._apiEndpointBaseUrl;
  }

  /**
   * Clip an agent_context value to the server-side character limit.
   *
   * Keeps the tail of the text (the part nearest the user's next turn) when the
   * value is too long.
   */
  protected _clipAgentContext(text: string): string {
    if (text.length > MAX_AGENT_CONTEXT_CHARS) {
      logger.warning(
        `${this} agent_context is ${text.length} chars; clipping to the last ` +
          `${MAX_AGENT_CONTEXT_CHARS}.`,
      );
      return text.slice(-MAX_AGENT_CONTEXT_CHARS);
    }
    return text;
  }

  /**
   * Send an UpdateConfiguration message with the given fields.
   *
   * Fields whose value is null are omitted. No-op if the websocket is not
   * currently open.
   *
   * @param fields Configuration fields to update (e.g. `agent_context`).
   */
  protected async _sendUpdateConfiguration(fields: Dict): Promise<void> {
    if (!(this._websocket && this._websocket.state === State.OPEN)) {
      return;
    }

    const payload: Dict = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== null && v !== undefined) {
        payload[k] = v;
      }
    }
    if (Object.keys(payload).length === 0) {
      return;
    }

    try {
      await this._websocket.send(pyJsonDumps({ type: "UpdateConfiguration", ...payload }));
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`${this}: failed to send UpdateConfiguration: ${errorMessage(e)}`);
    }
  }

  /**
   * Send the agent's latest spoken reply to AssemblyAI as carryover context.
   *
   * Context carryover (U3 Pro models only) gives the model a short memory of
   * what the agent just said so it can better transcribe the user's reply:
   * short answers, spelled-out entities (emails, IDs), and similar-sounding
   * words. No-op for non-U3 Pro models.
   *
   * @param text The agent's spoken reply text. Clipped to ~1500 characters.
   */
  async updateAgentContext(text: string): Promise<void> {
    if (!isU3ProModel(this._settings.model)) {
      if (!this._agentContextWarned) {
        this._agentContextWarned = true;
        logger.warning(
          `${this} update_agent_context is only supported by U3 Pro models; ` +
            `ignoring for model '${this._settings.model}'.`,
        );
      }
      return;
    }

    if (!text) {
      return;
    }

    text = this._clipAgentContext(text);
    // Store it so a later reconnect re-seeds the context via the WS URL.
    this._settings.agentContext = text;
    await this._sendUpdateConfiguration({ agent_context: text });
  }

  /**
   * Feed the assistant's completed reply to AssemblyAI as carryover context.
   *
   * Called automatically when the assistant's turn ends. Delegates to
   * `updateAgentContext()`. No-op for non-U3-Pro models or when
   * `previousContextNTurns` is 0 (carryover explicitly disabled).
   *
   * @param text The assistant's aggregated spoken text for this turn.
   */
  protected override async _processAssistantTurn(text: string): Promise<void> {
    // Context carryover is a U3 Pro-only feature.
    if (!isU3ProModel(this._settings.model)) {
      return;
    }
    // previous_context_n_turns=0 means the user explicitly disabled carryover.
    if (this._settings.previousContextNTurns === 0) {
      return;
    }
    await this.updateAgentContext(text);
  }

  /**
   * Connect to the AssemblyAI service.
   *
   * Establishes the websocket connection and starts the receive task.
   */
  override async _connect(): Promise<void> {
    await super._connect();

    await this._connectWebsocket();

    // Started even when the connection failed: with no socket the receive loop
    // goes straight to its reconnect path, which retries the connect.
    if (!this._receiveTask) {
      this._receiveTask = this.createTask(
        () => this._receiveTaskHandler((error, options) => this._reportError(error, options)),
        "_receive_task_handler",
      );
    }
  }

  /**
   * Disconnect from the AssemblyAI service.
   *
   * Sends the termination message, waits for acknowledgment, and cleans up.
   */
  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (!this._connected || !this._websocket) {
      return;
    }

    try {
      this._terminationEvent.clear();

      if (this._websocket.state === State.OPEN) {
        // Send any remaining audio
        if (this._audioBuffer.length > 0) {
          await this._websocket.send(this._audioBuffer);
          this._audioBuffer = new Uint8Array(0);
        }

        // Send termination message and wait for acknowledgment
        try {
          await this._websocket.send(pyJsonDumps({ type: "Terminate" }));

          try {
            await waitFor(() => this._terminationEvent.wait(), 5.0);
          } catch (e) {
            rethrowIfCancelled(e);
            if (!(e instanceof TimeoutError)) {
              throw e;
            }
            logger.warning("Timed out waiting for termination message from server");
          }
        } catch (e) {
          rethrowIfCancelled(e);
          await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    } finally {
      // Clean up tasks and connection
      if (this._receiveTask) {
        await this.cancelTask(this._receiveTask);
        this._receiveTask = null;
      }

      await this._disconnectWebsocket();
    }
  }

  /** Establish the websocket connection to AssemblyAI. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug("Connecting to AssemblyAI WebSocket");

      const wsUrl = this._buildWsUrl();
      const headers = {
        Authorization: this._apiKey,
        "User-Agent": `AssemblyAI/1.0 (integration=Pipecat/${pipecatVersion()})`,
      };
      this._websocket = await this._websocketConnect(wsUrl, { additionalHeaders: headers });
      this._connected = true;
      await this._callEventHandler("on_connected");
      logger.debug(`${this} Connected to AssemblyAI WebSocket`);
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      this._connected = false;
      await this.pushError(`Unable to connect to AssemblyAI: ${errorMessage(e)}`, {
        exception: e,
      });
    }
  }

  /** Close the websocket connection to AssemblyAI. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      if (this._websocket) {
        logger.debug("Disconnecting from AssemblyAI WebSocket");
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error closing websocket: ${errorMessage(e)}`, { exception: e });
    } finally {
      this._websocket = null;
      this._connected = false;
      await this._callEventHandler("on_disconnected");
    }
  }

  /**
   * Get the current WebSocket connection.
   *
   * @throws Error If WebSocket is not connected.
   */
  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /** Receive and process websocket messages until the connection closes. */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      let data: Dict;
      try {
        data = pyJsonLoads(text) as Dict;
      } catch (e) {
        rethrowIfCancelled(e);
        if (e instanceof SyntaxError) {
          logger.warning(`Received non-JSON message: ${text}`);
          continue;
        }
        throw e;
      }
      // Log raw JSON for Turn messages to debug speaker_label
      if (data?.type === "Turn") {
        logger.trace(`${this} RAW JSON from AssemblyAI: ${JSON.stringify(data, null, 2)}`);
      }
      await this._handleMessage(data);
    }
  }

  /** Parse a raw message into the appropriate message type. */
  protected _parseMessage(message: Dict): BaseMessage {
    const msgType = message.type;

    if (msgType === "Begin") {
      return BeginMessage.modelValidate(message);
    } else if (msgType === "Turn") {
      return TurnMessage.modelValidate(message);
    } else if (msgType === "SpeechStarted") {
      return SpeechStartedMessage.modelValidate(message);
    } else if (msgType === "Termination") {
      return TerminationMessage.modelValidate(message);
    }
    throw new Error(`Unknown message type: ${msgType}`);
  }

  /** Handle AssemblyAI WebSocket messages. */
  protected async _handleMessage(message: Dict): Promise<void> {
    try {
      const parsedMessage = this._parseMessage(message);

      if (parsedMessage instanceof BeginMessage) {
        logger.debug(`Session Begin: ${parsedMessage.id} (expires at ${parsedMessage.expiresAt})`);
      } else if (parsedMessage instanceof TurnMessage) {
        await this._handleTranscription(parsedMessage);
      } else if (parsedMessage instanceof SpeechStartedMessage) {
        await this._handleSpeechStarted(parsedMessage);
      } else if (parsedMessage instanceof TerminationMessage) {
        await this._handleTermination(parsedMessage);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    }
  }

  /**
   * Handle SpeechStarted event: fast barge-in for AssemblyAI turn detection.
   *
   * Proposes a turn start, which the user turn strategies resolve into a
   * `UserStartedSpeakingFrame` and an interruption. SpeechStarted fires before
   * any transcript arrives, so the turn is cleanly started before any
   * transcription frames are pushed.
   *
   * Only applies when using AssemblyAI's built-in turn detection. When using
   * Pipecat turn detection, VAD + smart turn analyzer handle interruptions.
   */
  protected async _handleSpeechStarted(_message: SpeechStartedMessage | null): Promise<void> {
    if (this._vadForceTurnEndpoint) {
      return; // Pipecat mode: handled by aggregator
    }

    await this.broadcastFrame(ProposedUserStartedSpeakingFrame);
    this._userSpeaking = true;
  }

  /** Handle termination message. */
  protected async _handleTermination(message: TerminationMessage): Promise<void> {
    this._terminationEvent.set();

    logger.info(
      `Session Terminated: Audio Duration=${message.audioDurationSeconds}s, ` +
        `Session Duration=${message.sessionDurationSeconds}s`,
    );
  }

  /**
   * Handle transcription results with two turn detection modes.
   *
   * Pipecat turn detection (`vadForceTurnEndpoint` true): no
   * UserStarted/StoppedSpeakingFrame from STT; end_of_turn pushes a
   * TranscriptionFrame (finalized set by the base class if this is a
   * ForceEndpoint response), else an InterimTranscriptionFrame.
   *
   * AssemblyAI turn detection (`vadForceTurnEndpoint` false): end_of_turn
   * pushes a TranscriptionFrame and proposes the turn stop; otherwise an
   * InterimTranscriptionFrame.
   */
  protected async _handleTranscription(message: TurnMessage): Promise<void> {
    if (!message.transcript) {
      return;
    }

    // Use detected language if available with sufficient confidence
    let language: Language = Language.EN;
    if (message.languageCode && message.languageConfidence) {
      if (message.languageConfidence >= 0.7) {
        language = mapLanguageFromAssemblyai(message.languageCode);
      } else {
        logger.warning(
          `Low language detection confidence (${message.languageConfidence.toFixed(2)}) ` +
            `for language '${message.languageCode}', falling back to English`,
        );
      }
    }

    // Handle speaker diarization
    let speakerId = this._userId;
    let transcriptText = message.transcript;

    if (message.speaker) {
      speakerId = message.speaker;
      // Format transcript with speaker labels if format string provided
      if (this._speakerFormat) {
        const speaker = message.speaker;
        const text = message.transcript;
        transcriptText = this._speakerFormat.replace(
          /\{\{|\}\}|\{(speaker|text)\}/g,
          (m, key: string | undefined) =>
            m === "{{" ? "{" : m === "}}" ? "}" : key === "speaker" ? speaker : text,
        );
      }
    }

    // Determine if this is a final turn from AssemblyAI
    const isFinalTurn =
      message.endOfTurn && (!this._settings.formatTurns || message.turnIsFormatted);

    if (this._vadForceTurnEndpoint) {
      // --- Pipecat turn detection mode ---
      // No UserStarted/StoppedSpeakingFrame: VAD + smart turn analyzer handle this
      if (isFinalTurn) {
        const finalizeConfirmed = Boolean(message.turnIsFormatted);
        if (finalizeConfirmed) {
          this.confirmFinalize();
        }
        logger.debug(`${this} Transcript: "${transcriptText}"`);
        // Report usage before the transcription frame so tracing can attach it
        // to the STT span the frame closes.
        await this.emitSttUsageMetrics();
        await this.pushFrame(
          new TranscriptionFrame({
            text: transcriptText,
            userId: speakerId,
            timestamp: timeNowIso8601(),
            language,
            result: message,
          }),
        );
        await this._traceTranscription(transcriptText, true, language);
        await this._callEventHandler("on_end_of_turn", transcriptText);
      } else {
        await this.pushFrame(
          new InterimTranscriptionFrame({
            text: transcriptText,
            userId: speakerId,
            timestamp: timeNowIso8601(),
            language,
            result: message,
          }),
        );
      }
    } else {
      // --- AssemblyAI turn detection mode ---
      // SpeechStarted always arrives before transcripts on U3 Pro models, so the
      // turn start is guaranteed to be proposed first.
      if (isFinalTurn) {
        // AssemblyAI controls finalization, just mark as finalized.
        // Report usage before the transcription frame so tracing can attach it
        // to the STT span the frame closes.
        await this.emitSttUsageMetrics();
        await this.pushFrame(
          new TranscriptionFrame({
            text: transcriptText,
            userId: speakerId,
            timestamp: timeNowIso8601(),
            language,
            result: message,
            finalized: true,
          }),
        );
        await this._traceTranscription(transcriptText, true, language);
        // Propose the turn stop immediately. broadcastFrame pushes downstream
        // (same queue as the TranscriptionFrame above, so ordering is
        // preserved) and upstream.
        await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
        this._userSpeaking = false;
        await this._callEventHandler("on_end_of_turn", transcriptText);
      } else {
        await this.pushFrame(
          new InterimTranscriptionFrame({
            text: transcriptText,
            userId: speakerId,
            timestamp: timeNowIso8601(),
            language,
            result: message,
          }),
        );
      }
    }
  }
}

/** Default host for the Sync speech-to-text API. */
export const ASSEMBLYAI_SYNC_BASE_URL = "https://sync.assemblyai.com";

/** Sync API paths appended to the base URL. */
export const ASSEMBLYAI_SYNC_TRANSCRIBE_PATH = "/v1/transcribe";
export const ASSEMBLYAI_SYNC_WARM_PATH = "/v1/warm";

export interface AssemblyAISyncSTTSettingsOptions extends STTSettingsOptions {
  /** Description of what the audio is about; prepended to the model's system prompt. */
  prompt?: string | null | NotGiven;
  /** Key terms or phrases to bias the decoder toward. */
  keytermsPrompt?: string[] | null | NotGiven;
  /**
   * Prior turns from the same conversation, oldest first. A single string is one
   * turn. Setting this explicitly turns off the service's automatic context
   * buffer and sends exactly this value.
   */
  conversationContext?: string | string[] | null | NotGiven;
  /**
   * Declared audio languages for multilingual or code-switching audio. Regional
   * variants resolve to their base code and duplicates are dropped. Bound in
   * preference to the single `language` setting when both are set.
   */
  languageCodes?: Language[] | null | NotGiven;
  /** Whether to compute per-word `start`/`end` timestamps, at a small added latency. */
  timestamps?: boolean | null | NotGiven;
}

/** Settings for AssemblyAISyncSTTService. */
export class AssemblyAISyncSTTSettings extends STTSettings {
  prompt: string | null | NotGiven = NOT_GIVEN;
  keytermsPrompt: string[] | null | NotGiven = NOT_GIVEN;
  conversationContext: string | string[] | null | NotGiven = NOT_GIVEN;
  languageCodes: Language[] | null | NotGiven = NOT_GIVEN;
  timestamps: boolean | null | NotGiven = NOT_GIVEN;

  constructor(options: AssemblyAISyncSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface AssemblyAISyncSTTServiceOptions extends SegmentedSTTServiceOptions {
  /** AssemblyAI API key for authentication. */
  apiKey: string;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`. (Upstream
   * takes an aiohttp session here.)
   */
  fetch?: typeof fetch | null;
  /**
   * Base URL for the Sync API. Override for a data-residency endpoint (e.g.
   * `https://sync.us.assemblyai.com` or `https://sync.eu.assemblyai.com`).
   */
  baseUrl?: string;
  /**
   * Whether to open the connection when the user starts speaking so the
   * transcription request avoids the connection handshake. Defaults to true.
   */
  enablePrewarming?: boolean;
  /**
   * Number of prior conversation turns (user transcripts and agent replies
   * together) automatically carried as `conversation_context`. 0 disables it.
   * Ignored when `conversationContext` is set explicitly. Defaults to 5.
   */
  maxContextTurns?: number;
  /** Character budget for the same buffer; oldest turns drop first. Defaults to 1500. */
  maxContextChars?: number;
  /** Runtime-updatable settings. */
  settings?: AssemblyAISyncSTTSettings | null;
}

/**
 * AssemblyAI Sync speech-to-text service.
 *
 * Transcribes a complete speech segment in a single request/response against
 * AssemblyAI's Sync API, rather than holding open a streaming WebSocket. It
 * inherits from SegmentedSTTService, which uses VAD events to buffer each
 * utterance and calls `runStt()` once per segment with the audio as a WAV
 * container. Each segment is POSTed as `multipart/form-data` and the transcript
 * is returned directly: no upload step, no polling, no session to manage.
 *
 * Audio segments must be at most 120 seconds; the API rejects longer ones.
 *
 * When pre-warming is enabled (the default), the service opens the connection
 * as soon as the user starts speaking, so the transcription request skips the
 * connection handshake once the utterance ends. Call `warm()` directly to warm
 * the connection at any other time.
 *
 * Because the Sync API is stateless, the service also carries recent
 * conversation context automatically: it keeps a rolling buffer of the most
 * recent turns (user transcripts and the agent's replies together, in the order
 * spoken) and sends them as `conversation_context` on each request. Set
 * `maxContextTurns: 0` to disable it, or set `conversationContext` explicitly in
 * `settings` to supply the context yourself.
 */
export class AssemblyAISyncSTTService extends SegmentedSTTService {
  static Settings: typeof AssemblyAISyncSTTSettings = AssemblyAISyncSTTSettings;
  declare protected _settings: AssemblyAISyncSTTSettings;

  static {
    installTracedStt(AssemblyAISyncSTTService.prototype, "_handleTranscription");
  }

  protected _apiKey: string;
  protected _fetch: typeof fetch;
  protected _baseUrl: string;
  protected _enablePrewarming: boolean;
  protected _warmTask: Task<unknown> | null = null;
  protected _maxContextTurns: number;
  protected _maxContextChars: number;
  // Rolling buffer of prior turns (user + agent) carried as conversation_context.
  protected _contextTurns: string[] = [];

  /**
   * Initialize the AssemblyAI Sync STT service.
   *
   * @param options.apiKey AssemblyAI API key for authentication.
   * @param options.fetch `fetch` used for HTTP requests.
   * @param options.baseUrl Base URL for the Sync API.
   * @param options.sampleRate Audio sample rate in Hz. If null, uses the
   *   pipeline's rate.
   * @param options.enablePrewarming Whether to pre-warm the connection.
   * @param options.maxContextTurns Automatic conversation context turn cap.
   * @param options.maxContextChars Automatic conversation context character cap.
   * @param options.settings Runtime-updatable settings.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Other options are passed to SegmentedSTTService.
   */
  constructor(options: AssemblyAISyncSTTServiceOptions) {
    const defaultSettings = new (new.target as typeof AssemblyAISyncSTTService).Settings({
      model: "universal-3-6-pro",
      language: Language.EN,
      prompt: null,
      keytermsPrompt: null,
      conversationContext: null,
      languageCodes: null,
      timestamps: null,
    });
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    const {
      apiKey,
      fetch: fetchOption,
      baseUrl,
      enablePrewarming,
      maxContextTurns,
      maxContextChars,
      ...rest
    } = options;
    super({
      ...rest,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? ASSEMBLYAI_SYNC_TTFS_P99 : options.ttfsP99Latency,
      settings: defaultSettings,
    });

    this._apiKey = apiKey;
    this._fetch = fetchOption ?? ((input, init) => globalThis.fetch(input, init));
    this._baseUrl = (baseUrl ?? ASSEMBLYAI_SYNC_BASE_URL).replace(/\/+$/, "");
    this._enablePrewarming = enablePrewarming ?? true;
    this._maxContextTurns = maxContextTurns ?? 5;
    this._maxContextChars = maxContextChars ?? 1500;
  }

  /**
   * Whether this service generates processing metrics.
   *
   * @returns True. The Sync API issues a discrete request per segment, so its
   *   duration is measured and reported.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /** Convert a Language to an AssemblyAI language code (base ISO code). */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToAssemblyaiLanguage(language);
  }

  /** The routing header both endpoints send. */
  protected _modelHeader(): Record<string, string> {
    const model = assertGiven(this._settings.model);
    return { "X-AAI-Model": String(model) };
  }

  protected _requestHeaders(): Record<string, string> {
    return { Authorization: this._apiKey, ...this._modelHeader() };
  }

  /** Assemble the optional `config` part from the current settings. */
  protected _buildConfig(): Dict {
    const config: Dict = {};

    // `languageCodes` (multilingual / code-switching) wins over the single
    // `language` when both are set; either way the wire field is a list.
    const languageCodes = this._settings.languageCodes;
    const language = this._settings.language;
    if (isGiven(languageCodes) && languageCodes && languageCodes.length > 0) {
      // The Sync API caps no declared-language list, so none is imposed here.
      config.language_codes = _prepareLanguageCodes(languageCodes, { maxCodes: null });
    } else if (isGiven(language) && language !== null) {
      config.language_codes = [language];
    }

    const prompt = this._settings.prompt;
    if (isGiven(prompt) && prompt !== null) {
      config.prompt = prompt;
    }

    const keytermsPrompt = this._settings.keytermsPrompt;
    if (isGiven(keytermsPrompt) && keytermsPrompt && keytermsPrompt.length > 0) {
      config.keyterms_prompt = [...keytermsPrompt];
    }

    const timestamps = this._settings.timestamps;
    if (isGiven(timestamps) && timestamps !== null) {
      config.timestamps = timestamps;
    }

    if (this._contextIsManual()) {
      config.conversation_context = this._settings.conversationContext;
    } else if (this._contextTurns.length > 0) {
      config.conversation_context = [...this._contextTurns];
    }

    return config;
  }

  /** Whether conversation_context was supplied explicitly in settings. */
  protected _contextIsManual(): boolean {
    const ctx = this._settings.conversationContext;
    return isGiven(ctx) && ctx !== null && ctx.length > 0;
  }

  /**
   * Append a completed turn (user or agent) to the rolling context buffer.
   *
   * Both sides share one chronological buffer under a single turn/char cap,
   * matching how the model consumes context. The oldest turns are evicted first
   * once a cap is exceeded. No-op when automatic context is disabled or a manual
   * conversation_context is set.
   */
  protected _appendContextTurn(text: string): void {
    text = (text || "").trim();
    if (!text || this._maxContextTurns <= 0 || this._contextIsManual()) {
      return;
    }
    this._contextTurns.push(text);
    while (
      this._contextTurns.length > 1 &&
      (this._contextTurns.length > this._maxContextTurns ||
        this._contextTurns.reduce((n, t) => n + t.length, 0) > this._maxContextChars)
    ) {
      this._contextTurns.shift();
    }
  }

  /**
   * Start the service on an empty conversation context.
   *
   * The buffer holds one conversation, so an instance reused for another run
   * starts it fresh.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    this._contextTurns.length = 0;
  }

  /**
   * Feed the agent's completed reply into the conversation context.
   *
   * Called automatically by the base class when an assistant turn ends. The
   * reply is appended to the same chronological buffer as user turns.
   */
  protected override async _processAssistantTurn(text: string): Promise<void> {
    this._appendContextTurn(text);
  }

  /**
   * Pre-warm the connection to the Sync API.
   *
   * Establishes the connection ahead of a transcription request so the next
   * `runStt()` starts uploading audio immediately. Best-effort: failures are
   * logged and swallowed, since a failed warm-up only forfeits the latency
   * saving.
   */
  async warm(): Promise<void> {
    const url = `${this._baseUrl}${ASSEMBLYAI_SYNC_WARM_PATH}`;
    try {
      // Route the warm with the same model as the transcription so the opened
      // connection lands on the right backend.
      const response = await abortable(
        this._fetch(url, { method: "GET", headers: this._modelHeader(), signal: currentSignal() }),
      );
      await abortable(response.arrayBuffer());
    } catch (e) {
      rethrowIfCancelled(e);
      logger.debug(`${this}: connection pre-warm failed (ignored): ${errorMessage(e)}`);
    }
  }

  protected override async _handleUserStartedSpeaking(
    frame: VADUserStartedSpeakingFrame,
  ): Promise<void> {
    await super._handleUserStartedSpeaking(frame);
    if (this._enablePrewarming && (this._warmTask === null || this._warmTask.done())) {
      this._warmTask = this.createTask(() => this.warm(), "warm");
    }
  }

  /**
   * POST an audio segment to the Sync API and return the parsed result.
   *
   * @param audio Raw audio bytes in WAV format (already converted by the base class).
   * @returns The decoded JSON transcription result.
   * @throws Error (carrying `status`) If the API returns a non-200 status.
   */
  protected async _transcribe(audio: Uint8Array): Promise<Dict> {
    const url = `${this._baseUrl}${ASSEMBLYAI_SYNC_TRANSCRIBE_PATH}`;

    // The base class always hands runStt a WAV container, so the audio part is
    // always sent as audio/wav.
    const boundary = `----pipedog${crypto.randomUUID().replaceAll("-", "")}`;
    const enc = new TextEncoder();
    const chunks: Uint8Array[] = [
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.wav"\r\n` +
          "Content-Type: audio/wav\r\n\r\n",
      ),
      audio,
      enc.encode("\r\n"),
    ];
    const config = this._buildConfig();
    if (Object.keys(config).length > 0) {
      chunks.push(
        enc.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="config"\r\n` +
            `Content-Type: application/json\r\n\r\n${pyJsonDumps(config)}\r\n`,
        ),
      );
    }
    chunks.push(enc.encode(`--${boundary}--\r\n`));
    const body = new Blob(chunks as BlobPart[]);

    const response = await abortable(
      this._fetch(url, {
        method: "POST",
        body,
        headers: {
          ...this._requestHeaders(),
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        signal: currentSignal(),
      }),
    );
    if (response.status !== 200) {
      // The status rides on the exception so the framework can classify the
      // failure: a rejected key leaves the service unusable, a rate limit or a
      // server error does not.
      const detail = await this._errorDetail(response);
      const error = new Error(`${response.status}, message='${detail}', url='${url}'`);
      (error as Error & { status: number }).status = response.status;
      throw error;
    }
    return (await abortable(response.json())) as Dict;
  }

  /**
   * Build a readable message from a non-200 response.
   *
   * Errors arrive either as a problem-details body (`title`/`detail`) or as
   * `{"error_code", "message"}`; surface whichever fields are present, falling
   * back to the raw body.
   */
  protected async _errorDetail(response: Response): Promise<string> {
    const text = await abortable(response.text());
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const b = body as Dict;
      const fields = [b.error_code, b.title, b.detail || b.message];
      const parts = fields.filter((f) => f);
      if (parts.length > 0) {
        return parts.join(" - ");
      }
    }
    return text;
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: string | null = null,
  ): Promise<void> {
    await this.stopProcessingMetrics();
  }

  /**
   * Transcribe an audio segment using the AssemblyAI Sync API.
   *
   * @param audio Raw audio bytes in WAV format (already converted by the base class).
   * @yields A TranscriptionFrame with the transcribed text, or an ErrorFrame on
   *   failure. Only non-empty transcriptions are yielded.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    try {
      await this.startProcessingMetrics();

      const result = await this._transcribe(audio);

      const text = String(result.text ?? "").trim();
      if (text) {
        const language = assertGiven(this._settings.language) as Language | null;
        await this._handleTranscription(text, true, language);
        logger.debug(`Transcription: [${text}]`);
        yield new TranscriptionFrame({
          text,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          language,
          result,
        });
        // Record this user turn for the next request's context. This request's
        // config was already built, so an utterance never appears in its own
        // context.
        this._appendContextTurn(text);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this}: error transcribing audio: ${errorMessage(e)}`);
      yield new ErrorFrame({ error: `Sync transcription error: ${errorMessage(e)}`, exception: e });
    }
  }

  /** Cancel any in-flight pre-warm task and clean up. */
  override async cleanup(): Promise<void> {
    if (this._warmTask !== null && !this._warmTask.done()) {
      await this.cancelTask(this._warmTask);
    }
    this._warmTask = null;
    await super.cleanup();
  }
}
