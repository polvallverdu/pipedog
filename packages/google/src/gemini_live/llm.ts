// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/google/gemini_live/llm.py

/**
 * Google Gemini Live API service implementation.
 *
 * This module provides real-time conversational AI capabilities using Google's
 * Gemini Live API, supporting both text and audio modalities with
 * voice transcription, streaming responses, and tool usage.
 *
 * Porting notes:
 * - The client is `GoogleGenAI` from `@google/genai`, which talks to the Live
 *   API over the global `WebSocket`. Its Live session is callback based:
 *   `live.connect()` resolves with a `Session` once the socket is open, and
 *   server messages arrive through `onmessage`. The callbacks feed an asyncio
 *   `Queue` that the connection task reads, which is what upstream's
 *   `session.receive()` iterator does. A socket error or close is delivered
 *   through the same queue and raised in the connection task, so it goes
 *   through upstream's reconnect / failure counting path. The SDK's
 *   `async with` maps to `live.connect()` / `session.close()`.
 * - The JS SDK's `Session.send*` methods are synchronous (they write to the
 *   socket); errors they throw go through `_handleSendError` as upstream's
 *   awaited sends do.
 * - Config and messages use the JS SDK's camelCase shapes (`serverContent`,
 *   `modelTurn`, `inlineData`, ...). Audio and video blobs are base64 strings.
 * - Deprecated upstream APIs are not ported: the `InputParams` class, and the
 *   `model`, `voiceId` and `params` constructor arguments (use `settings`).
 * - `interaction_status`: the JS SDK passes Gemini API server messages through
 *   unchanged, so the field always reaches the service and the "SDK too old"
 *   warning never fires. It is kept for parity (and for subclasses).
 * - `thinkingLevel` exists in every supported JS SDK version, so upstream's
 *   `"thinking_level" in ThinkingConfig.model_fields` check is always true.
 * - `historyConfig` is set on the connect config as upstream does, but
 *   `@google/genai` 2.27 does not forward it in the setup message.
 * - Video frames are encoded with `encodeImage` (`utils/image.ts`): raw pixels
 *   become a JPEG as with Pillow; an image whose format is already a MIME
 *   type is sent as is (upstream's Pillow call would fail on it).
 * - A `Language` value in settings is detected with `isLanguage()`; a plain
 *   string that happens to be a `Language` value (e.g. `"es"`) is converted
 *   too, where upstream (a `StrEnum` check) would send it as given.
 */

import {
  type Content,
  type EndSensitivity,
  type FunctionResponse,
  type FunctionResponseScheduling,
  GoogleGenAI,
  type GroundingMetadata,
  type HistoryConfig,
  type HttpOptions,
  type LiveConnectConfig,
  type LiveServerContent,
  type LiveServerMessage,
  MediaModality,
  type MediaResolution,
  type Modality,
  type ModalityTokenCount,
  type ProactivityConfig,
  type RealtimeInputConfig,
  type Session,
  type StartSensitivity,
  type ThinkingConfig,
  type TurnCoverage,
} from "@google/genai";
import {
  CancelledError,
  currentTask,
  Future,
  Queue,
  rethrowIfCancelled,
  sleep,
  type Task,
  time,
} from "@pipedog/asyncio";
import type { BaseLLMAdapter } from "@pipedog/core/adapters/llm/base_llm_adapter";
import type { DirectFunction } from "@pipedog/core/adapters/llm/schemas/direct_function";
import type { FunctionSchema } from "@pipedog/core/adapters/llm/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type CancelFrame,
  EndFrame,
  type Frame,
  FunctionCallFromLLM,
  FunctionCallResultFrame,
  InputAudioRawFrame,
  InputImageRawFrame,
  InputTextRawFrame,
  InterruptionFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMMessagesAppendFrame,
  LLMServiceMetadataFrame,
  LLMSetToolsFrame,
  LLMTextFrame,
  LLMThoughtEndFrame,
  LLMThoughtStartFrame,
  LLMThoughtTextFrame,
  SpeechControlParamsFrame,
  TextType,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import * as asyncToolMessages from "@pipedog/core/processors/aggregators/async_tool_messages";
import {
  LLMContext,
  type LLMContextMessage,
  LLMSpecificMessage,
  type LLMStandardMessage,
  standardMessageText,
} from "@pipedog/core/processors/aggregators/llm_context";
import { FrameDirection, type FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { LLMService, type LLMServiceOptions } from "@pipedog/core/services/llm_service";
import { LLMSettings, type LLMSettingsOptions } from "@pipedog/core/services/settings";
import { isLanguage, Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";
import { encodeImage } from "@pipedog/core/utils/image";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { matchEndofsentence } from "@pipedog/core/utils/string";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt, tracedGeminiLive } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { LLMSearchOrigin, LLMSearchResponseFrame, LLMSearchResult } from "../frames.ts";
import type { GeminiLLMInvocationParams } from "../gemini_adapter.ts";
import { GeminiLiveLLMAdapter } from "../gemini_live_adapter.ts";
import { type GoogleClientHttpOptions, updateGoogleClientHttpOptions } from "../utils.ts";
import { GeminiFileAPI } from "./file_api.ts";

// Connection management constants
export const MAX_CONSECUTIVE_FAILURES = 3;
export const CONNECTION_ESTABLISHED_THRESHOLD = 10.0; // seconds

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Python truthiness for JSON-like values. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Uint8Array) return value.length > 0;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      return Object.keys(value).length > 0;
    }
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drop `null` / `undefined` fields, as pydantic leaves unset fields out of the request. */
function compact<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as T;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Get the AUDIO token count from a modality breakdown, if reported.
 *
 * Gemini omits modalities with no tokens (and omits the list entirely when
 * there is no breakdown), so absence means "not reported" rather than zero.
 *
 * @param details A modality breakdown from usage metadata, e.g.
 *   `promptTokensDetails`.
 * @returns The AUDIO token count, or null if not reported.
 */
function _audioTokenCount(details: ModalityTokenCount[] | null | undefined): number | null {
  if (!details || details.length === 0) {
    return null;
  }
  for (const entry of details) {
    if (entry.modality === MediaModality.AUDIO) {
      return entry.tokenCount ?? null;
    }
  }
  return null;
}

// Pre-roll cushion added on top of the auto-sized duration (start_secs), to
// absorb small timing slop between start_secs and the audio actually clipped,
// and to give a bit of extra audio context for the model.
// Not applied to an explicit userAudioPrerollSecs override.
export const AUTOSIZED_USER_AUDIO_PREROLL_MARGIN_SECS = 0.1;
// Pre-roll used before start_secs is known (no SpeechControlParamsFrame yet, or
// no upstream VAD) and no override is given.
export const DEFAULT_USER_AUDIO_PREROLL_SECS = 0.5;

/**
 * Maps a Language value to a Gemini Live supported language code.
 *
 * Source:
 * https://ai.google.dev/api/generate-content#MediaResolution
 *
 * @param language The language value to convert.
 * @returns The Gemini language code string. If `language` is not in the
 *   verified mapping, falls back to the full language code string and logs a
 *   warning (via `resolveLanguage(..., false)`).
 */
export function languageToGeminiLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    // Arabic
    [Language.AR]: "ar-XA",
    // Bengali
    [Language.BN_IN]: "bn-IN",
    // Chinese (Mandarin)
    [Language.CMN]: "cmn-CN",
    [Language.CMN_CN]: "cmn-CN",
    [Language.ZH]: "cmn-CN", // Map general Chinese to Mandarin for Gemini
    [Language.ZH_CN]: "cmn-CN", // Map Simplified Chinese to Mandarin for Gemini
    // German
    [Language.DE]: "de-DE",
    [Language.DE_DE]: "de-DE",
    // English
    [Language.EN]: "en-US", // Default to US English (though not explicitly listed in supported codes)
    [Language.EN_US]: "en-US",
    [Language.EN_AU]: "en-AU",
    [Language.EN_GB]: "en-GB",
    [Language.EN_IN]: "en-IN",
    // Spanish
    [Language.ES]: "es-ES", // Default to Spain Spanish
    [Language.ES_ES]: "es-ES",
    [Language.ES_US]: "es-US",
    // French
    [Language.FR]: "fr-FR", // Default to France French
    [Language.FR_FR]: "fr-FR",
    [Language.FR_CA]: "fr-CA",
    // Gujarati
    [Language.GU]: "gu-IN",
    [Language.GU_IN]: "gu-IN",
    // Hindi
    [Language.HI]: "hi-IN",
    [Language.HI_IN]: "hi-IN",
    // Indonesian
    [Language.ID]: "id-ID",
    [Language.ID_ID]: "id-ID",
    // Italian
    [Language.IT]: "it-IT",
    [Language.IT_IT]: "it-IT",
    // Japanese
    [Language.JA]: "ja-JP",
    [Language.JA_JP]: "ja-JP",
    // Kannada
    [Language.KN]: "kn-IN",
    [Language.KN_IN]: "kn-IN",
    // Korean
    [Language.KO]: "ko-KR",
    [Language.KO_KR]: "ko-KR",
    // Malayalam
    [Language.ML]: "ml-IN",
    [Language.ML_IN]: "ml-IN",
    // Marathi
    [Language.MR]: "mr-IN",
    [Language.MR_IN]: "mr-IN",
    // Dutch
    [Language.NL]: "nl-NL",
    [Language.NL_NL]: "nl-NL",
    // Polish
    [Language.PL]: "pl-PL",
    [Language.PL_PL]: "pl-PL",
    // Portuguese (Brazil)
    [Language.PT_BR]: "pt-BR",
    // Russian
    [Language.RU]: "ru-RU",
    [Language.RU_RU]: "ru-RU",
    // Tamil
    [Language.TA]: "ta-IN",
    [Language.TA_IN]: "ta-IN",
    // Telugu
    [Language.TE]: "te-IN",
    [Language.TE_IN]: "te-IN",
    // Thai
    [Language.TH]: "th-TH",
    [Language.TH_TH]: "th-TH",
    // Turkish
    [Language.TR]: "tr-TR",
    [Language.TR_TR]: "tr-TR",
    // Vietnamese
    [Language.VI]: "vi-VN",
    [Language.VI_VN]: "vi-VN",
  };

  return resolveLanguage(language, LANGUAGE_MAP, false);
}

/**
 * Supported modalities for Gemini Live.
 *
 * - `TEXT`: Text responses.
 * - `AUDIO`: Audio responses.
 */
export const GeminiModalities = {
  TEXT: "TEXT",
  AUDIO: "AUDIO",
} as const;
export type GeminiModalities = (typeof GeminiModalities)[keyof typeof GeminiModalities];

/**
 * Media resolution options for Gemini Live.
 *
 * - `UNSPECIFIED`: Use default resolution setting.
 * - `LOW`: Low resolution with 64 tokens.
 * - `MEDIUM`: Medium resolution with 256 tokens.
 * - `HIGH`: High resolution with zoomed reframing and 256 tokens.
 */
export const GeminiMediaResolution = {
  UNSPECIFIED: "MEDIA_RESOLUTION_UNSPECIFIED", // Use default
  LOW: "MEDIA_RESOLUTION_LOW", // 64 tokens
  MEDIUM: "MEDIA_RESOLUTION_MEDIUM", // 256 tokens
  HIGH: "MEDIA_RESOLUTION_HIGH", // Zoomed reframing with 256 tokens
} as const;
export type GeminiMediaResolution =
  (typeof GeminiMediaResolution)[keyof typeof GeminiMediaResolution];

export interface GeminiVADParamsOptions {
  /** Whether to disable VAD. Defaults to null (server-side VAD is enabled). */
  disabled?: boolean | null;
  /** Sensitivity for speech start detection. Defaults to null. */
  startSensitivity?: StartSensitivity | null;
  /** Sensitivity for speech end detection. Defaults to null. */
  endSensitivity?: EndSensitivity | null;
  /** Prefix padding in milliseconds. Defaults to null. */
  prefixPaddingMs?: number | null;
  /** Silence duration threshold in milliseconds. Defaults to null. */
  silenceDurationMs?: number | null;
}

/**
 * Voice Activity Detection parameters for Gemini Live.
 *
 * - `disabled`: Whether to disable VAD. Defaults to null (server-side VAD is enabled).
 * - `startSensitivity`: Sensitivity for speech start detection. Defaults to null.
 * - `endSensitivity`: Sensitivity for speech end detection. Defaults to null.
 * - `prefixPaddingMs`: Prefix padding in milliseconds. Defaults to null.
 * - `silenceDurationMs`: Silence duration threshold in milliseconds. Defaults to null.
 */
export class GeminiVADParams {
  disabled: boolean | null;
  startSensitivity: StartSensitivity | null;
  endSensitivity: EndSensitivity | null;
  prefixPaddingMs: number | null;
  silenceDurationMs: number | null;

  constructor(options: GeminiVADParamsOptions = {}) {
    this.disabled = options.disabled ?? null;
    this.startSensitivity = options.startSensitivity ?? null;
    this.endSensitivity = options.endSensitivity ?? null;
    this.prefixPaddingMs = options.prefixPaddingMs ?? null;
    this.silenceDurationMs = options.silenceDurationMs ?? null;
  }
}

export interface ContextWindowCompressionParamsOptions {
  /** Whether compression is enabled. Defaults to false. */
  enabled?: boolean;
  /** Token count to trigger compression. null uses 80% of context window. */
  triggerTokens?: number | null;
}

/**
 * Parameters for context window compression in Gemini Live.
 *
 * - `enabled`: Whether compression is enabled. Defaults to false.
 * - `triggerTokens`: Token count to trigger compression. null uses 80% of
 *   context window.
 */
export class ContextWindowCompressionParams {
  enabled: boolean;
  triggerTokens: number | null; // null = use default (80% of context window)

  constructor(options: ContextWindowCompressionParamsOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.triggerTokens = options.triggerTokens ?? null;
  }
}

export interface GeminiLiveLLMSettingsOptions extends LLMSettingsOptions {
  /** TTS voice identifier (e.g. `"Charon"`). */
  voice?: string | NotGiven;
  /** Response modalities. */
  modalities?: GeminiModalities | NotGiven;
  /**
   * Language for generation. A `Language` value is sent as Gemini's locale
   * code (`Language.ES` as `"es-ES"`); a string is sent as given.
   */
  language?: Language | string | NotGiven;
  /** Media resolution setting. */
  mediaResolution?: GeminiMediaResolution | NotGiven;
  /** Voice activity detection parameters. */
  vad?: GeminiVADParams | null | NotGiven;
  /** Which realtime input a user turn covers. Unset uses the model's own default. */
  turnCoverage?: TurnCoverage | null | NotGiven;
  /** Context window compression configuration. */
  contextWindowCompression?:
    | ContextWindowCompressionParams
    | ContextWindowCompressionParamsOptions
    | NotGiven;
  /**
   * Thinking configuration. Live thinking models require a `thinkingLevel`;
   * when none is set, the service applies the lowest level the model accepts.
   */
  thinking?: ThinkingConfig | NotGiven;
  /** Whether to enable affective dialog. */
  enableAffectiveDialog?: boolean | NotGiven;
  /** Proactivity configuration. */
  proactivity?: ProactivityConfig | NotGiven;
}

/**
 * Settings for GeminiLiveLLMService.
 *
 * - `voice`: TTS voice identifier (e.g. `"Charon"`).
 * - `modalities`: Response modalities.
 * - `language`: Language for generation. A `Language` value is sent as
 *   Gemini's locale code (`Language.ES` as `"es-ES"`); a string is sent as
 *   given.
 * - `mediaResolution`: Media resolution setting.
 * - `vad`: Voice activity detection parameters.
 * - `turnCoverage`: Which realtime input a user turn covers. Unset uses the
 *   model's own default.
 * - `contextWindowCompression`: Context window compression configuration.
 * - `thinking`: Thinking configuration. Live thinking models require a
 *   `thinkingLevel`; when none is set, the service applies the lowest level
 *   the model accepts.
 * - `enableAffectiveDialog`: Whether to enable affective dialog.
 * - `proactivity`: Proactivity configuration.
 */
export class GeminiLiveLLMSettings extends LLMSettings {
  voice: string | NotGiven = NOT_GIVEN;
  modalities: GeminiModalities | NotGiven = NOT_GIVEN;
  language: Language | string | NotGiven = NOT_GIVEN;
  mediaResolution: GeminiMediaResolution | NotGiven = NOT_GIVEN;
  vad: GeminiVADParams | null | NotGiven = NOT_GIVEN;
  turnCoverage: TurnCoverage | null | NotGiven = NOT_GIVEN;
  contextWindowCompression:
    | ContextWindowCompressionParams
    | ContextWindowCompressionParamsOptions
    | NotGiven = NOT_GIVEN;
  thinking: ThinkingConfig | NotGiven = NOT_GIVEN;
  enableAffectiveDialog: boolean | NotGiven = NOT_GIVEN;
  proactivity: ProactivityConfig | NotGiven = NOT_GIVEN;

  constructor(options: GeminiLiveLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface GeminiLiveLLMServiceOptions extends LLMServiceOptions {
  /** Google AI API key for authentication. */
  apiKey: string;
  /** Whether to start with audio input paused. Defaults to false. */
  startAudioPaused?: boolean;
  /** Whether to start with video input paused. Defaults to false. */
  startVideoPaused?: boolean;
  /** System prompt for the model. Defaults to null. */
  systemInstruction?: string | null;
  /**
   * Tools available to the model: a `ToolsSchema`, a plain list of direct
   * functions and/or `FunctionSchema` objects (handlers auto-register), or a
   * list of provider-native tool dicts. Defaults to null.
   */
  tools?: ToolsSchema | (FunctionSchema | DirectFunction)[] | Record<string, unknown>[] | null;
  /** Gemini Live LLM settings. */
  settings?: GeminiLiveLLMSettings | null;
  /** Whether to generate a response when context is first set. Defaults to true. */
  inferenceOnContextInitialization?: boolean;
  /**
   * In server-VAD-disabled (locally-driven turns) mode, how much recent audio
   * to replay after activity_start so the speech onset isn't clipped.
   */
  userAudioPrerollSecs?: number | null;
  /** Base URL for the Gemini File API. Defaults to the official endpoint. */
  fileApiBaseUrl?: string;
  /** HTTP options for the client. */
  httpOptions?: GoogleClientHttpOptions | null;
}

/** An item delivered by the Live session callbacks to the connection task. */
type SessionEvent =
  | { kind: "message"; message: LiveServerMessage }
  | { kind: "error"; error: unknown }
  | { kind: "close"; code?: number; reason?: string };

/**
 * Provides access to Google's Gemini Live API.
 *
 * This service enables real-time conversations with Gemini, supporting both
 * text and audio modalities. It handles voice transcription, streaming audio
 * responses, and tool usage.
 *
 * Does NOT emit `UserStartedSpeakingFrame` / `UserStoppedSpeakingFrame`
 * (the API exposes an `interrupted` event but no turn-start/-end), so
 * pipeline processors that depend on those frames — RTVI client speech
 * events, `TurnTrackingObserver`, `AudioBufferProcessor` turn
 * recording, `UserIdleController`, user mute strategies, voicemail
 * detector — won't activate with the default server-VAD-only setup.
 * `LLMContextAggregatorPair` auto-detects this realtime service so context
 * writes are correct anyway. To produce the turn frames
 * locally, see `examples/realtime/realtime-gemini-live-locally-driven-turns.py`;
 * note that locally-generated turn boundaries are a heuristic and may
 * not match Gemini Live's server-side turn decisions.
 */
export class GeminiLiveLLMService extends LLMService<GeminiLiveLLMAdapter & BaseLLMAdapter> {
  static Settings = GeminiLiveLLMSettings;
  declare protected _settings: GeminiLiveLLMSettings;

  // Overriding the default adapter to use the Gemini Live one.
  static override adapterClass = GeminiLiveLLMAdapter;

  // Minimum google-genai (Python) with full interaction_status support: 2.18.0
  // added the LiveServerContent field, 2.19.0 the IDLE enum value the server sends.
  static _INTERACTION_STATUS_MIN_SDK = "2.19.0";

  // The JS SDK passes Gemini API server messages through as received, so
  // `interactionStatus` always reaches the service.
  static _SDK_SUPPORTS_INTERACTION_STATUS = true;

  // Lowest thinking_level the Live thinking models accept (they reject
  // MINIMAL), applied when no level is configured. Lowest keeps reply
  // latency down, matching the thinking defaults of GoogleLLMService.
  static _DEFAULT_THINKING_LEVEL = "LOW";

  // Timeout (in seconds) for the EndFrame deferral. If turn_complete is not
  // received within this time, the EndFrame is released anyway to prevent the
  // pipeline from hanging indefinitely.
  static _END_FRAME_DEFERRAL_TIMEOUT_SECS = 30.0;

  // Timeout (in seconds) for a deferred turn_complete — one held open by an
  // IN_PROGRESS interaction status. Every incoming server message restarts
  // it, so it measures server silence, not total hold time; if the session
  // goes quiet without ever reporting idle, the bot turn is ended anyway so
  // downstream processors aren't left waiting on it.
  static _DEFERRED_TURN_COMPLETE_TIMEOUT_SECS = 30.0;

  protected _lastSentTime = 0;
  protected _systemInstructionFromInit: string | null | NotGiven;
  protected _toolsFromInit: ToolsSchema | unknown[] | null;
  protected _inferenceOnContextInitialization: boolean;
  protected _needsInitialTurnCompleteMessage = false;

  protected _audioInputPaused: boolean;
  protected _videoInputPaused: boolean;
  protected _readyForRealtimeInput = false;
  protected _context: LLMContext | null = null;
  protected _apiKey: string;
  protected _httpOptions: GoogleClientHttpOptions;
  protected _session: Session | null = null;
  protected _connectionTask: Task<unknown> | null = null;
  protected _client!: GoogleGenAI;

  protected _disconnecting = false;
  protected _runLlmWhenSessionReady = false;

  protected _userIsSpeaking = false;
  protected _botIsResponding = false;
  protected _userAudioPrerollBuffer: Uint8Array = new Uint8Array(0);
  protected _userAudioPrerollBufferSampleRate: number | null = null;
  // When set, pins the pre-roll duration; otherwise pre-roll is auto-sized
  // from the upstream VAD's start_secs (see _handleSpeechControlParams).
  protected _userAudioPrerollSecsOverride: number | null;
  protected _userAudioPrerollSecs: number;
  protected _userTranscriptionBuffer = "";
  protected _lastTranscriptionSent = "";
  protected _botAudioBuffer: Uint8Array = new Uint8Array(0);
  protected _botTextBuffer = "";
  protected _llmOutputBuffer = "";
  protected _transcriptionTimeoutTask: Task<unknown> | null = null;

  protected _sampleRate = 24000;
  protected _sampleRateWarningLogged = false;

  protected _language: Language | string;
  protected _languageCode: string;
  protected _vadDisabled: boolean;

  // Reconnection tracking
  protected _consecutiveFailures = 0;
  protected _connectionStartTime: number | null = null;

  protected _fileApiBaseUrl: string;
  protected _fileApi: GeminiFileAPI | null = null;

  // Grounding metadata tracking
  protected _searchResultBuffer = "";
  protected _accumulatedGroundingMetadata: GroundingMetadata | null = null;

  // Session resumption
  protected _sessionResumptionHandle: string | null = null;

  // Bookkeeping for ending gracefully (i.e. after the bot is finished)
  protected _endFramePendingBotTurnFinished: EndFrame | null = null;
  protected _endFrameDeferralTimeoutTask: Task<unknown> | null = null;

  // A turn_complete held open because the server reported it was still
  // working (see `_handleServerMessage`), plus its watchdog.
  protected _turnCompletePendingIdle: LiveServerMessage | null = null;
  // Content appended to the session that no turn has answered yet; the
  // aggregator's next upstream context frame completes the turn.
  protected _contentAwaitingResponse = false;
  protected _deferredTurnCompleteTimeoutTask: Task<unknown> | null = null;
  protected _warnedInteractionStatusUnsupported = false;

  // Bookkeeping for tool calls
  protected _completedToolCalls = new Set<string>();
  // tool_call_id -> tool_name, populated as the model issues tool
  // calls. Used to look up the function name when sending an async
  // tool's final result back to the provider, since the async-tool
  // message in the context only carries the id.
  protected _toolCallIdToName = new Map<string, string>();
  protected _asyncToolWarningLogged = false;
  protected _syncToolWarningLogged = false;

  /**
   * Initialize the Gemini Live LLM service.
   *
   * @param options.apiKey Google AI API key for authentication.
   * @param options.startAudioPaused Whether to start with audio input paused.
   *   Defaults to false.
   * @param options.startVideoPaused Whether to start with video input paused.
   *   Defaults to false.
   * @param options.systemInstruction System prompt for the model. Defaults to null.
   * @param options.tools Tools available to the model: a `ToolsSchema`, a
   *   plain list of direct functions and/or `FunctionSchema` objects (handlers
   *   auto-register), or a list of provider-native tool dicts. Defaults to null.
   * @param options.settings Gemini Live LLM settings.
   * @param options.inferenceOnContextInitialization Whether to generate a
   *   response when context is first set. Defaults to true.
   * @param options.userAudioPrerollSecs In server-VAD-disabled
   *   (locally-driven turns) mode, how much recent audio to replay after
   *   activity_start so the speech onset isn't clipped. Defaults to null:
   *   auto-sized to the upstream VAD's `startSecs` plus a small margin,
   *   falling back to `DEFAULT_USER_AUDIO_PREROLL_SECS` when no VAD is
   *   present. Auto-sizing assumes VAD drives turn starts (the default
   *   `VADUserTurnStartStrategy`); set this explicitly if you use a non-VAD
   *   turn-start strategy. No effect when server-side VAD is enabled.
   * @param options.fileApiBaseUrl Base URL for the Gemini File API. Defaults
   *   to the official endpoint.
   * @param options.httpOptions HTTP options for the client.
   *   Other options are passed to the parent LLMService.
   */
  constructor(options: GeminiLiveLLMServiceOptions) {
    const systemInstruction = options.systemInstruction ?? null;

    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = new GeminiLiveLLMSettings({
      model: "models/gemini-3.8-live",
      systemInstruction,
      voice: "Charon",
      frequencyPenalty: null,
      maxTokens: 4096,
      presencePenalty: null,
      temperature: null,
      topK: null,
      topP: null,
      seed: null,
      filterIncompleteUserTurns: false,
      userTurnCompletionConfig: null,
      modalities: GeminiModalities.AUDIO,
      language: "en-US",
      mediaResolution: GeminiMediaResolution.UNSPECIFIED,
      vad: null,
      turnCoverage: null,
      contextWindowCompression: {},
      thinking: {},
      enableAffectiveDialog: false,
      proactivity: {},
      extra: {},
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }
    if (isGiven(defaultSettings.language) && isLanguage(String(defaultSettings.language))) {
      defaultSettings.language = languageToGeminiLanguage(defaultSettings.language as Language);
    }

    // Warn if user requested TEXT modality
    const defaultModalities = assertGiven(defaultSettings.modalities);
    if (defaultModalities === GeminiModalities.TEXT) {
      logger.warning(
        `Modality '${defaultModalities}' may not be supported by recent Gemini Live models.`,
      );
    }

    super({ ...options, settings: defaultSettings });

    this._systemInstructionFromInit = this._settings.systemInstruction;
    // Accept a plain list of standard tools as a convenience; normalize it to a
    // ToolsSchema so the rest of the service has a single form to handle.
    // Provider-native tool lists (dicts) pass through unchanged.
    let tools: ToolsSchema | unknown[] | null = options.tools ?? null;
    if (Array.isArray(tools)) {
      const normalized = LLMContext._normalizeAndValidateTools(tools, {
        allowProviderTools: true,
      });
      tools = normalized instanceof ToolsSchema || Array.isArray(normalized) ? normalized : null;
    }
    this._toolsFromInit = tools;
    this._inferenceOnContextInitialization = options.inferenceOnContextInitialization ?? true;

    this._audioInputPaused = options.startAudioPaused ?? false;
    this._videoInputPaused = options.startVideoPaused ?? false;
    this._apiKey = options.apiKey;
    this._httpOptions = updateGoogleClientHttpOptions(
      options.httpOptions ?? null,
    ) as GoogleClientHttpOptions;

    const userAudioPrerollSecs = options.userAudioPrerollSecs ?? null;
    this._userAudioPrerollSecsOverride = userAudioPrerollSecs;
    this._userAudioPrerollSecs =
      userAudioPrerollSecs !== null ? userAudioPrerollSecs : DEFAULT_USER_AUDIO_PREROLL_SECS;

    this._language = assertGiven(this._settings.language) as Language | string;
    this._languageCode = this._language
      ? languageToGeminiLanguage(this._language as Language)
      : "en-US";
    const vadSettings = assertGiven(this._settings.vad);
    this._vadDisabled = Boolean(vadSettings?.disabled);

    this._fileApiBaseUrl =
      options.fileApiBaseUrl ?? "https://generativelanguage.googleapis.com/v1beta/files";

    // Initialize the API client. Subclasses can override this if needed.
    this.createClient();
  }

  /**
   * Whether the model takes a call's intermediate results.
   *
   * They ride the tool-response channel as a generator (`willContinue`),
   * which only a NON_BLOCKING call allows, so this follows the same model
   * gating as the rest of the async-tool support.
   */
  override get acceptsIntermediateFunctionCallResults(): boolean {
    return this._supportsNonBlockingTools;
  }

  /** Realtime service; emits no server-side turn frames, so recommends no external strategies. */
  override serviceMetadataFrame(): LLMServiceMetadataFrame {
    // The API exposes an `interrupted` event but no turn-start/-end.
    this._warnIfRealtimeServiceEmitsNoTurnFrames(false);
    return new LLMServiceMetadataFrame({ serviceName: this.name, isRealtimeService: true });
  }

  /** Check if the current model is a Gemini 3.x model. */
  protected get _isGemini3(): boolean {
    const version = this._geminiVersion;
    return version !== null && version[0] === 3;
  }

  /**
   * Major/minor version parsed from the model id, or null if absent.
   *
   * Handles ids that carry the version with or without a minor part
   * (`gemini-3.8-live`, `gemini-2.0-flash-live-001`).
   */
  protected get _geminiVersion(): [number, number] | null {
    const model = assertGiven(this._settings.model) || "";
    const match = /gemini(?:-[a-z]+)*-(\d+)(?:\.(\d+))?/.exec(model);
    if (!match) {
      return null;
    }
    return [Number.parseInt(match[1] as string, 10), Number.parseInt(match[2] ?? "0", 10)];
  }

  /**
   * Whether the current model reports `interactionStatus`.
   *
   * Thinking models from 3.8 on reason in the background between output
   * chunks; for those, `turnComplete` alone doesn't mean the turn is
   * over. The version gate excludes earlier thinking-named models (e.g.
   * `gemini-2.5-flash-exp-native-audio-thinking-dialog`), which don't
   * report the status.
   */
  protected get _expectsInteractionStatus(): boolean {
    const model = assertGiven(this._settings.model) || "";
    const version = this._geminiVersion;
    return model.includes("thinking") && version !== null && versionAtLeast(version, [3, 8]);
  }

  /**
   * Warn (once) when the installed SDK can't surface `interactionStatus`.
   *
   * An SDK that strips response fields it doesn't know about would never
   * deliver the status, and the turn gating would silently do nothing — the
   * model's background reasoning would split one reply across several
   * assistant turns.
   */
  protected _warnIfInteractionStatusUnsupported(): void {
    if (!this._expectsInteractionStatus || this._warnedInteractionStatusUnsupported) {
      return;
    }
    if ((this.constructor as typeof GeminiLiveLLMService)._SDK_SUPPORTS_INTERACTION_STATUS) {
      return;
    }
    this._warnedInteractionStatusUnsupported = true;
    logger.warning(
      `${this}: the installed google-genai does not support ` +
        `interaction_status, which ${String(this._settings.model)} uses to signal ` +
        "that it is still reasoning in the background. Without it, a " +
        "single reply may be split across multiple assistant turns. " +
        `Upgrade to google-genai>=${GeminiLiveLLMService._INTERACTION_STATUS_MIN_SDK}.`,
    );
  }

  /**
   * The thinking config to connect with.
   *
   * Live thinking models require a `thinkingLevel` — the API has no
   * default and rejects a setup without one — so an unset level defaults
   * to the lowest the model accepts. An explicitly configured level is
   * never overridden.
   */
  protected _resolvedThinkingConfig(): ThinkingConfig | null {
    let thinking: ThinkingConfig | null = assertGiven(this._settings.thinking) ?? null;
    if (thinking !== null && Object.keys(thinking).length === 0) {
      thinking = null;
    }
    if (this._expectsInteractionStatus && !thinking?.thinkingLevel) {
      thinking = {
        ...(thinking ?? {}),
        thinkingLevel:
          GeminiLiveLLMService._DEFAULT_THINKING_LEVEL as ThinkingConfig["thinkingLevel"],
      };
      logger.debug(
        `${this}: defaulting thinking_level to ${GeminiLiveLLMService._DEFAULT_THINKING_LEVEL} ` +
          `(${String(this._settings.model)} requires one)`,
      );
    }
    return thinking;
  }

  /**
   * Whether the current model supports the NON_BLOCKING tool behavior + scheduling hints.
   *
   * Before 3.8, Gemini 3.x models did not support NON_BLOCKING function declarations.
   * Thinking models (the first of which is gemini-3.8-live-extended-thinking) require
   * NON_BLOCKING.
   */
  protected get _supportsNonBlockingTools(): boolean {
    const version = this._geminiVersion;
    return version === null || !versionAtLeast(version, [3, 0]) || versionAtLeast(version, [3, 8]);
  }

  /**
   * Whether the model runs function calls NON_BLOCKING unless declared otherwise.
   *
   * The 3.8 Live family flipped the default: function calls execute
   * NON_BLOCKING unless the declaration explicitly asks for BLOCKING.
   */
  protected get _toolsDefaultToNonBlocking(): boolean {
    const version = this._geminiVersion;
    return version !== null && versionAtLeast(version, [3, 8]);
  }

  /**
   * Whether the model accepts BLOCKING function declarations.
   *
   * Live thinking models run every function call NON_BLOCKING and don't
   * accept a BLOCKING declaration.
   */
  protected get _supportsBlockingTools(): boolean {
    return !this._expectsInteractionStatus;
  }

  /**
   * Set each function declaration's `behavior` for the current model.
   *
   * Tools registered with `cancelOnInterruption: false` are declared
   * NON_BLOCKING so Gemini doesn't stall the conversation while they run.
   * Synchronous tools should block — the model finishes its turn only once
   * the result lands, avoiding the "let me look that up for you" filler it
   * produces when it knows the result is async — so where NON_BLOCKING is
   * the model's default they are explicitly declared BLOCKING. Live
   * thinking models accept only NON_BLOCKING: synchronous tools can't
   * block there, which is warned about once.
   *
   * https://ai.google.dev/gemini-api/docs/live-api/tools#async-function-calling
   */
  protected _tagToolBehaviors(tools: unknown[]): void {
    const declareBlocking = this._toolsDefaultToNonBlocking && this._supportsBlockingTools;
    for (const tool of tools) {
      if (!isPlainObject(tool)) {
        continue;
      }
      // The JS SDK takes camelCase; accept upstream's snake_case key too.
      const decls = tool.functionDeclarations ?? tool.function_declarations;
      if (!Array.isArray(decls)) {
        continue;
      }
      for (const decl of decls) {
        if (!isPlainObject(decl)) {
          continue;
        }
        const name = decl.name;
        if (typeof name !== "string") {
          continue;
        }
        if (this._functionIsAsync(name)) {
          decl.behavior = "NON_BLOCKING";
        } else if (declareBlocking) {
          decl.behavior = "BLOCKING";
        } else if (this._toolsDefaultToNonBlocking && !this._syncToolWarningLogged) {
          this._syncToolWarningLogged = true;
          logger.warning(
            `${this}: ${String(this._settings.model)} runs every function call ` +
              `NON_BLOCKING; synchronous tools like '${name}' won't pause ` +
              "the conversation while they execute, so the model may keep " +
              "talking before the result arrives.",
          );
        }
      }
    }
  }

  /** Create the Gemini API client instance. Subclasses can override this. */
  createClient(): void {
    this._client = new GoogleGenAI({
      apiKey: this._apiKey,
      httpOptions: this._httpOptions as HttpOptions,
    });
  }

  /**
   * Get the Gemini File API client instance. Subclasses can override this.
   *
   * @returns The Gemini File API client.
   */
  get fileApi(): GeminiFileAPI {
    if (!this._fileApi) {
      this._fileApi = new GeminiFileAPI({ apiKey: this._apiKey, baseUrl: this._fileApiBaseUrl });
    }
    return this._fileApi;
  }

  /**
   * Check if the service can generate usage metrics.
   *
   * @returns True as Gemini Live supports token usage metrics.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Apply a settings delta.
   *
   * Settings are stored but not applied to the active connection.
   */
  protected override async _updateSettings(delta: LLMSettings): Promise<Record<string, unknown>> {
    if (
      delta instanceof GeminiLiveLLMSettings &&
      isGiven(delta.language) &&
      isLanguage(String(delta.language))
    ) {
      delta.language = languageToGeminiLanguage(delta.language as Language);
    }

    const changed = await super._updateSettings(delta);

    if (Object.keys(changed).length === 0) {
      return changed;
    }

    // TODO: someday we could reconnect here to apply updated settings.
    // Code might look something like the below:
    // await this._disconnect();
    // await this._connect();

    this._warnUnhandledUpdatedSettings(changed);

    return changed;
  }

  /**
   * Set the audio input pause state.
   *
   * @param paused Whether to pause audio input.
   */
  setAudioInputPaused(paused: boolean): void {
    this._audioInputPaused = paused;
  }

  /**
   * Set the video input pause state.
   *
   * @param paused Whether to pause video input.
   */
  setVideoInputPaused(paused: boolean): void {
    this._videoInputPaused = paused;
  }

  /**
   * Set the model response modalities.
   *
   * @param modalities The modalities to use for responses.
   */
  setModelModalities(modalities: GeminiModalities): void {
    if (modalities === GeminiModalities.TEXT) {
      logger.warning(`Modality '${modalities}' may not be supported by recent Gemini Live models.`);
    }
    this._settings.modalities = modalities;
  }

  /**
   * Set the language for generation.
   *
   * @param language The language to use for generation.
   */
  setLanguage(language: Language): void {
    this._language = language;
    this._languageCode = languageToGeminiLanguage(language) || "en-US";
    this._settings.language = this._languageCode;
    logger.info(`Set Gemini language to: ${this._languageCode}`);
  }

  //
  // standard AIService frame handling
  //

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._connect();
  }

  /**
   * Stop the service and close connections.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the service and close connections.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /** Release resources at pipeline teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._disconnect();
  }

  //
  // speech and interruption handling
  //

  protected async _handleInterruption(): Promise<void> {
    // The interruption ends the turn, so a held turn_complete is moot, and
    // so is a reply owed for appended content: the user's turn makes one.
    this._discardDeferredTurn();
    this._contentAwaitingResponse = false;
    if (this._botIsResponding) {
      await this._setBotIsResponding(false);
      if (this._settings.modalities === GeminiModalities.AUDIO) {
        await this.pushFrame(new TTSStoppedFrame());
      }
      // Do not send LLMFullResponseEndFrame here - an interruption
      // already tells the assistant context aggregator that the response
      // is over.
    }
  }

  protected async _handleUserStartedSpeaking(_frame: UserStartedSpeakingFrame): Promise<void> {
    this._userIsSpeaking = true;
    if (this._vadDisabled && this._session && this._readyForRealtimeInput) {
      try {
        this._session.sendRealtimeInput({ activityStart: {} });
        // The speech onset arrived (and was buffered) before this
        // activity_start. Send it inside the window, so it's not clipped.
        await this._flushUserAudioPreroll();
      } catch (e) {
        rethrowIfCancelled(e);
        await this._handleSendError(e);
      }
    }
  }

  protected async _handleUserStoppedSpeaking(_frame: UserStoppedSpeakingFrame): Promise<void> {
    this._userIsSpeaking = false;
    this._userAudioPrerollBuffer = new Uint8Array(0);
    await this.startTtfbMetrics();

    if (!this._session) {
      return;
    }

    if (this._vadDisabled && this._readyForRealtimeInput) {
      try {
        this._session.sendRealtimeInput({ activityEnd: {} });
      } catch (e) {
        rethrowIfCancelled(e);
        await this._handleSendError(e);
      }
    }
    if (this._needsInitialTurnCompleteMessage) {
      this._needsInitialTurnCompleteMessage = false;
      // NOTE: without this, the model ignores the context it's been
      // seeded with before the user started speaking
      this._session.sendClientContent({ turnComplete: true });
    }
  }

  //
  // frame processing
  // StartFrame, StopFrame, CancelFrame implemented in base class
  //

  /**
   * Push a frame, sending function call results to the API on the way.
   *
   * Results are broadcast by the base service; the downstream copy is
   * observed here and sent as it is produced, so a tool that reports
   * progress reaches the model while it is still working.
   *
   * @param frame The frame to push.
   * @param direction The direction of frame pushing.
   */
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    if (direction === FrameDirection.DOWNSTREAM && frame instanceof FunctionCallResultFrame) {
      await this._handleFunctionCallResult(frame);
    }
    await super.pushFrame(frame, direction);
  }

  /** Send one result to the API, and say whether the model should answer it. */
  protected async _handleFunctionCallResult(frame: FunctionCallResultFrame): Promise<void> {
    const isFinal = frame.properties ? frame.properties.isFinal : true;
    if (!isFinal && !this.acceptsIntermediateFunctionCallResults) {
      logger.warning(
        `${this}: ${String(this._settings.model)} takes one result per function call; ` +
          `dropping the intermediate result for ${frame.functionName}`,
      );
      return;
    }
    let runLlm = frame.properties ? frame.properties.runLlm : null;
    if (runLlm === null || runLlm === undefined) {
      runLlm = frame.runLlm !== null ? frame.runLlm : true;
    }
    const toolName = this._toolCallIdToName.get(frame.toolCallId) ?? "tool_call_result";
    const result = truthy(frame.result)
      ? pyJsonDumps(frame.result, { ensureAscii: false })
      : "COMPLETED";
    await this._toolResult(
      frame.toolCallId,
      toolName,
      GeminiLiveLLMAdapter.toFunctionResponseDict(result),
      { isFinal, spoken: Boolean(runLlm) },
    );
    if (isFinal) {
      this._completedToolCalls.add(frame.toolCallId);
    }
  }

  /**
   * Process incoming frames for the Gemini Live service.
   *
   * @param frame The frame to process.
   * @param direction The frame processing direction.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    // Defer EndFrame handling until after the bot turn is finished
    if (frame instanceof EndFrame) {
      if (this._botIsResponding) {
        logger.debug("Deferring handling EndFrame until bot turn is finished");
        this._endFramePendingBotTurnFinished = frame;
        this._createEndFrameDeferralTimeout();
        return;
      }
    }

    await super.processFrame(frame, direction);

    if (frame instanceof TranscriptionFrame) {
      await this.pushFrame(frame, direction);
    } else if (frame instanceof LLMContextFrame) {
      await this._handleContext(frame.context, direction);
    } else if (frame instanceof InputTextRawFrame) {
      await this._sendUserText(frame.text);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof InputAudioRawFrame) {
      await this._sendUserAudio(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof InputImageRawFrame) {
      await this._sendUserVideo(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof InterruptionFrame) {
      await this._handleInterruption();
      await this.pushFrame(frame, direction);
    } else if (frame instanceof UserStartedSpeakingFrame) {
      await this._handleUserStartedSpeaking(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      await this._handleUserStoppedSpeaking(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof BotStartedSpeakingFrame) {
      // Ignore this frame. Use the serverContent API message instead
      await this.pushFrame(frame, direction);
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      // ignore this frame. Use the serverContent.turnComplete API message
      await this.pushFrame(frame, direction);
    } else if (frame instanceof SpeechControlParamsFrame) {
      this._handleSpeechControlParams(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof LLMMessagesAppendFrame) {
      await this._handleMessagesAppend(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof LLMSetToolsFrame) {
      // TODO: implement runtime tool updates for Gemini Live.
      // DIVERGENCE: upstream drops the frame silently. It is still dropped
      // here, with a warning like the one for unapplied settings updates.
      this._warnUnhandledUpdatedSettings(["tools"]);
    } else {
      await this.pushFrame(frame, direction);
    }
  }

  /** Return the tools configured via `tools` at construction, if any. */
  protected override _serviceTools(): ToolsSchema | unknown[] | null {
    return this._toolsFromInit;
  }

  /**
   * Put appended messages into the session, for the model to take in.
   *
   * They go in as client content that does not complete a turn, so the
   * model reads them without answering. Whether it answers is the
   * aggregator's call: an append that asks to run comes back to this
   * service as the context frame the assistant aggregator pushes upstream,
   * which completes the turn (see `_handleContext`). Without a
   * context aggregator, the append starts a conversation on its own, which
   * is how a pipeline with no aggregators kicks one off.
   */
  protected async _handleMessagesAppend(frame: LLMMessagesAppendFrame): Promise<void> {
    if (this._context === null) {
      await this._createSingleResponse(frame.messages);
      return;
    }
    if (this._disconnecting || !this._session) {
      return;
    }
    const turns: Content[] = [];
    for (const m of frame.messages) {
      const text = standardMessageText(m as LLMContextMessage);
      if (text) {
        turns.push({ role: "user", parts: [{ text }] });
      }
    }
    if (turns.length === 0) {
      return;
    }
    try {
      this._session.sendClientContent({ turns, turnComplete: false });
    } catch (e) {
      rethrowIfCancelled(e);
      await this._handleSendError(e);
      return;
    }
    this._contentAwaitingResponse = true;
  }

  /** Ask the model to answer the content it has been given. */
  protected async _completeTurn(): Promise<void> {
    if (this._disconnecting || !this._session) {
      return;
    }
    this._contentAwaitingResponse = false;
    logger.debug(`${this}: completing the turn for appended content`);
    try {
      this._session.sendClientContent({ turnComplete: true });
      // Gemini 3.x wants turn_complete=True, but also won't run inference
      // without a realtime input.
      if (this._isGemini3) {
        this._session.sendRealtimeInput({ text: " " });
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this._handleSendError(e);
    }
  }

  protected async _invocationParams(
    context: LLMContext,
    options: { systemInstruction?: string | null; serviceTools?: unknown } = {},
  ): Promise<GeminiLLMInvocationParams> {
    const adapter = this.getLlmAdapter();
    return await adapter.getLlmInvocationParams(context, options);
  }

  protected async _handleContext(
    context: LLMContext,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    if (!this._context) {
      // We got our initial context
      this._context = context;

      // Reconnect if context changes the effective system instruction
      // or tools compared to the initial connection (which used the
      // init-provided values). Note that the determination of "effective"
      // system instruction is delegated to the adapter, which still
      // chooses the init-provided value if there is one.
      const params = await this._invocationParams(this._context, {
        systemInstruction: assertGiven(this._systemInstructionFromInit),
      });
      const systemInstruction = params.system_instruction;
      const systemInstructionChanged = systemInstruction !== this._systemInstructionFromInit;
      // The context bringing tools of its own warrants a reconnect, without
      // diffing them against the init-provided ones.
      const contextHasTools = isGiven(this._context.tools);
      if (contextHasTools && truthy(this._toolsFromInit)) {
        logger.warning(
          "Tools provided both at init time and in context; using context-provided value.",
        );
      }
      if (systemInstructionChanged || contextHasTools) {
        await this._reconnect();
      }

      // Initialize our bookkeeping of already-completed tool calls in
      // the context
      await this._processCompletedFunctionCalls(false);

      // Create initial response if needed, based on conversation history
      // in context.
      // (If the context has no messages but we do have a system
      // instruction — meaning it was provided at init time — doctor our
      // context now so that we'll have something to send to the service
      // to trigger a response).
      const messages = params.messages;
      if ((!messages || messages.length === 0) && this._inferenceOnContextInitialization) {
        if (this._systemInstructionFromInit) {
          logger.debug(
            "No messages found in initial context; seeding with system instruction to trigger bot response.",
          );
          this._context.addMessage({
            role: "developer",
            content: assertGiven(this._systemInstructionFromInit) as string,
          } as LLMStandardMessage);
        } else {
          logger.warning(
            "No messages found in initial context; cannot trigger initial bot response without messages or system instruction.",
          );
        }
      }
      await this._createInitialResponse();
    } else {
      // We got an updated context.
      this._context = context;
      // A context frame from upstream is the aggregator asking for
      // inference — with the bot speech and user speech it accounts for —
      // so it is what has the model answer content appended since it
      // last spoke.
      if (direction === FrameDirection.UPSTREAM && this._contentAwaitingResponse) {
        await this._completeTurn();
      }

      // Here we assume that the updated context will contain either:
      // - new messages (that the Gemini Live service, with its own
      //   context management, is already aware of), or
      // - tool call results (that we need to tell the remote service
      //   about).
      // (In the future, we could do more sophisticated diffing here,
      // which would enable the user to programmatically manipulate the
      // context).

      // Send results for newly-completed function calls, if any.
      await this._processCompletedFunctionCalls(true);
    }
  }

  protected async _processCompletedFunctionCalls(sendNewResults: boolean): Promise<void> {
    if (this._context === null) {
      throw new Error("assertion failed: this._context is not null");
    }

    // If the user registered a function with cancelOnInterruption: false,
    // the aggregator emits async-tool-style messages into the context. On
    // models that don't support NON_BLOCKING tool calls, the conversation
    // freezes during tool execution, so the "keep talking while the tool
    // runs" intent of the flag is structurally not achievable. Surface a
    // one-time warning so users see they're not getting what they expect.
    if (!this._supportsNonBlockingTools && !this._asyncToolWarningLogged) {
      for (const message of this._context.getMessages()) {
        if (message instanceof LLMSpecificMessage) {
          continue;
        }
        if (asyncToolMessages.parseMessage(message) !== null) {
          logger.error(
            `${this}: cancel_on_interruption=False is not properly supported ` +
              "by the current Gemini Live model. Use cancel_on_interruption=True " +
              "(the default), or use a non-realtime LLM service if your tool " +
              "needs the async semantics.",
          );
          await this.pushError(
            "cancel_on_interruption=False is not properly supported by " +
              "the current Gemini Live model.",
          );
          this._asyncToolWarningLogged = true;
          break;
        }
      }
    }

    // Check for set of completed function calls in the context
    for (const message of this._context.getMessages()) {
      // LLMSpecificMessages are opaque provider-specific payloads, not
      // standard tool-result messages — skip them.
      if (message instanceof LLMSpecificMessage) {
        continue;
      }

      // Async-tool messages live alongside regular tool messages in the
      // context; detect and route them before the regular logic so we
      // don't try to send the async-tool envelope JSON as a tool result.
      const asyncPayload = asyncToolMessages.parseMessage(message);
      if (asyncPayload !== null) {
        if (this._completedToolCalls.has(asyncPayload.toolCallId)) {
          continue;
        }
        if (asyncPayload.kind === "started") {
          // The provider already issued the tool call and natively
          // awaits a result; nothing to send for the started marker.
          continue;
        }
        if (asyncPayload.kind === "intermediate") {
          // Sent as it was produced, keeping the call open for the
          // result that settles it.
          continue;
        }
        if (asyncPayload.kind === "final") {
          // Deliver via the formal tool-response channel — same
          // path as a synchronous tool result, just delayed.
          const toolName =
            this._toolCallIdToName.get(asyncPayload.toolCallId) ?? "tool_call_result";
          const responseDict = GeminiLiveLLMAdapter.toFunctionResponseDict(asyncPayload.result);
          if (sendNewResults) {
            await this._toolResult(asyncPayload.toolCallId, toolName, responseDict);
          }
          this._completedToolCalls.add(asyncPayload.toolCallId);
          continue;
        }
        // Defensive: any async-tool message must not fall through
        // to the regular tool-result block below, even if it
        // carries a kind we don't recognize.
        continue;
      }

      // Look for newly-completed "regular" (as opposed to async-tool) results
      const msg = message as Record<string, unknown>;
      if (msg.role === "tool" && msg.content !== "IN_PROGRESS") {
        const toolCallId = msg.tool_call_id as string | undefined;
        if (toolCallId && !this._completedToolCalls.has(toolCallId)) {
          // Found a newly-completed function call - send the result to the service
          const toolName = this._toolCallIdToName.get(toolCallId) ?? "tool_call_result";
          const responseDict = GeminiLiveLLMAdapter.toFunctionResponseDict(msg.content);
          if (sendNewResults) {
            await this._toolResult(toolCallId, toolName, responseDict);
          }
          this._completedToolCalls.add(toolCallId);
        }
      }
    }
  }

  protected async _setBotIsResponding(responding: boolean): Promise<void> {
    if (this._botIsResponding === responding) {
      return;
    }

    this._botIsResponding = responding;

    if (!this._botIsResponding && this._endFramePendingBotTurnFinished) {
      await this._releaseDeferredEndFrame();
    }
  }

  /** Release a deferred EndFrame and cancel the deferral timeout. */
  protected async _releaseDeferredEndFrame(): Promise<void> {
    if (this._endFramePendingBotTurnFinished) {
      this._cancelEndFrameDeferralTimeout();
      this._botIsResponding = false;
      const frame = this._endFramePendingBotTurnFinished;
      this._endFramePendingBotTurnFinished = null;
      await this.queueFrame(frame);
    }
  }

  /** Start a timeout that releases the deferred EndFrame if turn_complete never arrives. */
  protected _createEndFrameDeferralTimeout(): void {
    this._cancelEndFrameDeferralTimeout();

    const timeoutSecs = GeminiLiveLLMService._END_FRAME_DEFERRAL_TIMEOUT_SECS;
    const _timeout = async (): Promise<void> => {
      await sleep(timeoutSecs);
      if (this._endFramePendingBotTurnFinished) {
        logger.warning(
          `EndFrame deferral timed out after ${timeoutSecs}s ` +
            "without receiving turn_complete — releasing EndFrame",
        );
        await this._releaseDeferredEndFrame();
      }
    };

    this._endFrameDeferralTimeoutTask = this.createTask(_timeout, "end_frame_deferral_timeout");
  }

  /** Cancel the EndFrame deferral timeout if active. */
  protected _cancelEndFrameDeferralTimeout(): void {
    if (this._endFrameDeferralTimeoutTask && !this._endFrameDeferralTimeoutTask.done()) {
      this._endFrameDeferralTimeoutTask.cancel();
    }
    this._endFrameDeferralTimeoutTask = null;
  }

  /**
   * Return the history config for the Live API connection.
   *
   * Subclasses can override this to disable history config (e.g. Vertex AI
   * does not support it).
   */
  protected _getHistoryConfig(): HistoryConfig | null {
    return { initialHistoryInClientContent: true };
  }

  /** Establish client connection to Gemini Live API. */
  protected async _connect(sessionResumptionHandle: string | null = null): Promise<void> {
    if (this._session) {
      // Here we assume that if we have a client, we are connected. We
      // handle disconnections in the send/recv code paths.
      return;
    }

    if (sessionResumptionHandle) {
      logger.info(
        `Connecting to Gemini service with session_resumption_handle: ${sessionResumptionHandle}`,
      );
    } else {
      logger.info("Connecting to Gemini service");
    }

    this._warnIfInteractionStatusUnsupported();

    try {
      // Assemble basic configuration
      const modalities = assertGiven(this._settings.modalities);
      const mediaResolution = assertGiven(this._settings.mediaResolution);
      const language = assertGiven(this._settings.language);
      const config: LiveConnectConfig = {
        generationConfig: compact({
          frequencyPenalty: assertGiven(this._settings.frequencyPenalty),
          maxOutputTokens: assertGiven(this._settings.maxTokens),
          presencePenalty: assertGiven(this._settings.presencePenalty),
          seed: assertGiven(this._settings.seed),
          temperature: assertGiven(this._settings.temperature),
          topK: assertGiven(this._settings.topK),
          topP: assertGiven(this._settings.topP),
          responseModalities: [modalities as Modality],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: assertGiven(this._settings.voice),
              },
            },
            languageCode: language as string,
          },
          mediaResolution: mediaResolution as MediaResolution,
        }) as LiveConnectConfig["generationConfig"],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        sessionResumption: compact({ handle: sessionResumptionHandle ?? undefined }),
      };

      // Add history config, if supported (not supported by Vertex)
      const historyConfig = this._getHistoryConfig();
      if (historyConfig) {
        (config as Record<string, unknown>).historyConfig = historyConfig;
      }

      // Add context window compression to configuration, if enabled.
      // The setting may arrive as a ContextWindowCompressionParams or as a
      // plain object. Normalize to the params class.
      const cwcSetting = assertGiven(this._settings.contextWindowCompression);
      let cwc: ContextWindowCompressionParams | null;
      if (cwcSetting instanceof ContextWindowCompressionParams) {
        cwc = cwcSetting;
      } else {
        cwc =
          cwcSetting && Object.keys(cwcSetting).length > 0
            ? new ContextWindowCompressionParams(cwcSetting)
            : null;
      }
      if (cwc?.enabled) {
        // Add sliding window (always true if compression is enabled)
        const compressionConfig: NonNullable<LiveConnectConfig["contextWindowCompression"]> = {
          slidingWindow: {},
        };

        // Add triggerTokens if specified
        if (cwc.triggerTokens !== null) {
          compressionConfig.triggerTokens = String(cwc.triggerTokens);
        }

        config.contextWindowCompression = compressionConfig;
      }

      // Add thinking configuration to configuration, if provided
      const thinking = this._resolvedThinkingConfig();
      if (thinking) {
        config.thinkingConfig = thinking;
      }

      // Add affective dialog setting, if provided
      if (this._settings.enableAffectiveDialog === true) {
        config.enableAffectiveDialog = this._settings.enableAffectiveDialog;
      }

      // Add proactivity configuration to configuration, if provided
      let proactivity: ProactivityConfig | null = assertGiven(this._settings.proactivity) ?? null;
      if (proactivity !== null && Object.keys(proactivity).length === 0) {
        proactivity = null;
      }
      if (proactivity) {
        config.proactivity = proactivity;
      }

      // Add VAD configuration to configuration, if provided
      const vadParams = assertGiven(this._settings.vad);
      if (vadParams) {
        const vadConfig: NonNullable<RealtimeInputConfig["automaticActivityDetection"]> = {};
        let hasVadSettings = false;

        // Only add parameters that are explicitly set
        if (vadParams.disabled !== null) {
          vadConfig.disabled = vadParams.disabled;
          hasVadSettings = true;
        }

        if (vadParams.startSensitivity) {
          vadConfig.startOfSpeechSensitivity = vadParams.startSensitivity;
          hasVadSettings = true;
        }

        if (vadParams.endSensitivity) {
          vadConfig.endOfSpeechSensitivity = vadParams.endSensitivity;
          hasVadSettings = true;
        }

        if (vadParams.prefixPaddingMs !== null) {
          vadConfig.prefixPaddingMs = vadParams.prefixPaddingMs;
          hasVadSettings = true;
        }

        if (vadParams.silenceDurationMs !== null) {
          vadConfig.silenceDurationMs = vadParams.silenceDurationMs;
          hasVadSettings = true;
        }

        // Only add automaticActivityDetection if we have VAD settings
        if (hasVadSettings) {
          config.realtimeInputConfig = { automaticActivityDetection: vadConfig };
        }
      }

      // Add turn coverage to configuration, if provided
      const turnCoverage = assertGiven(this._settings.turnCoverage);
      if (turnCoverage) {
        if (config.realtimeInputConfig) {
          config.realtimeInputConfig.turnCoverage = turnCoverage;
        } else {
          config.realtimeInputConfig = { turnCoverage };
        }
      }

      // Add system instruction and tools to configuration, if provided.
      // These settings from the context take precedence over the ones
      // provided at initialization time.
      const adapter = this.getLlmAdapter();
      let systemInstruction: string | null;
      let tools: unknown[] | NotGiven | null;
      if (this._context) {
        const params = await this._invocationParams(this._context, {
          systemInstruction: assertGiven(this._systemInstructionFromInit),
          serviceTools: this._toolsFromInit,
        });
        systemInstruction = params.system_instruction;
        // The adapter settles the tools: the context's own when it has
        // any, else the init-provided ones; built-in tools ride along
        // either way.
        tools = params.tools;
      } else {
        systemInstruction = assertGiven(this._systemInstructionFromInit);
        // No context yet: the init-provided tools; built-in tools ride along.
        tools = adapter.fromStandardTools(this._toolsFromInit);
      }
      if (systemInstruction) {
        logger.debug(`Setting system instruction: ${systemInstruction}`);
        config.systemInstruction = systemInstruction;
      }
      if (isGiven(tools) && tools && tools.length > 0) {
        if (this._supportsNonBlockingTools) {
          this._tagToolBehaviors(tools);
        }
        logger.debug(`Setting tools: ${pyJsonDumps(tools)}`);
        config.tools = tools as LiveConnectConfig["tools"];
      }

      // Start the connection
      this._connectionTask = this.createTask(
        () => this._connectionTaskHandler(config),
        "_connectionTaskHandler",
      );
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Initialization error: ${errorMessage(e)}`, { exception: e });
    }
  }

  /**
   * Open a Live session.
   *
   * `live.connect()` resolves once the socket is open. If the socket fails or
   * is closed before that, the SDK reports it only through `onerror` /
   * `onclose` and the promise never settles, so until the session is open
   * those callbacks fail the connect instead of feeding the message queue.
   *
   * @returns The open session and the queue its messages arrive on.
   */
  protected async _openLiveSession(
    model: string,
    config: LiveConnectConfig,
  ): Promise<[Session, Queue<SessionEvent>]> {
    const messages = new Queue<SessionEvent>();
    const opened = new Future<Session>();
    let connected = false;
    const failConnect = (error: unknown) => {
      if (!opened.done()) opened.setException(error);
    };
    this._client.live
      .connect({
        model,
        config,
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            messages.putNowait({ kind: "message", message });
          },
          onerror: (event: unknown) => {
            const error = (event as { error?: unknown }).error ?? event;
            if (!connected) {
              failConnect(error instanceof Error ? error : new Error(errorMessage(error)));
              return;
            }
            messages.putNowait({ kind: "error", error });
          },
          onclose: (event: { code?: number; reason?: string } | null | undefined) => {
            if (!connected) {
              failConnect(
                new Error(
                  `Gemini Live connection closed (code ${event?.code ?? "unknown"}): ${event?.reason ?? ""}`,
                ),
              );
              return;
            }
            messages.putNowait({ kind: "close", code: event?.code, reason: event?.reason });
          },
        },
      })
      .then(
        (session) => {
          // Opened after the caller gave up: nobody owns this session, so close it.
          if (opened.done()) {
            session.close();
            return;
          }
          // From here on, socket errors and closes go to the connection task.
          connected = true;
          opened.setResult(session);
        },
        (e: unknown) => failConnect(e),
      );
    // A Future is a cancellation point; the SDK's promise is not.
    let session: Session;
    try {
      session = await opened;
    } catch (e) {
      // Cancelled after the session opened, before this task resumed.
      if (e instanceof CancelledError && opened.done() && !opened.cancelled()) {
        if (opened.exception() === null || opened.exception() === undefined) {
          opened.result().close();
        }
      }
      throw e;
    }
    return [session, messages];
  }

  protected async _connectionTaskHandler(config: LiveConnectConfig): Promise<void> {
    const model = assertGiven(this._settings.model);
    if (model === null) {
      throw new Error("Gemini Live model must be specified");
    }
    const [session, messages] = await this._openLiveSession(model, config);
    try {
      logger.info("Connected to Gemini service");

      // Mark connection start time
      this._connectionStartTime = time();

      await this._handleSessionReady(session);

      while (true) {
        try {
          while (true) {
            const event = await messages.get();
            if (event.kind === "error") {
              throw event.error instanceof Error ? event.error : new Error(String(event.error));
            }
            if (event.kind === "close") {
              throw new Error(
                `Gemini Live connection closed (code ${event.code ?? "unknown"}): ${event.reason ?? ""}`,
              );
            }
            // Reset failure counter if connection has been stable
            this._checkAndResetFailureCounter();

            await this._handleServerMessage(event.message);
          }
        } catch (e) {
          rethrowIfCancelled(e);
          if (!this._disconnecting) {
            const shouldReconnect = await this._handleConnectionError(e);
            if (shouldReconnect) {
              await this._reconnect();
              return; // Exit this connection handler, _reconnect will start a new one
            }
          }
          break;
        }
      }
    } finally {
      session.close();
    }
  }

  /** Dispatch a single message from the Live API receive stream. */
  protected async _handleServerMessage(message: LiveServerMessage): Promise<void> {
    // serverContent fields are NOT mutually exclusive — Gemini 3.x can
    // bundle multiple content fields and turnComplete on the same message,
    // so process the content-bearing fields before closing the turn.
    const sc = message.serverContent;
    const interactionIdle = this._readInteractionStatus(sc);
    // Any server message while a turn is held proves the session is still
    // alive, so the held-turn watchdog only measures silence.
    if (this._turnCompletePendingIdle) {
      this._startDeferredTurnCompleteTimeout();
    }
    if (sc?.interrupted) {
      // NOTE: while the service triggers interruptions in
      // the specific case of barge-ins, it does *not*
      // emit UserStarted/StoppedSpeakingFrames, as the
      // Gemini Live API does not give us broadly reliable
      // signals to base those off of. Pipelines that
      // require turn tracking (like those using context
      // aggregators) still need an independent way to
      // track turns, such as local Silero VAD in
      // combination with the context aggregator default
      // turn strategies.
      logger.debug("Gemini VAD: interrupted signal received");
      await this.broadcastInterruption();
    }
    if (sc?.modelTurn) {
      await this._handleMsgModelTurn(message);
    }
    if (sc?.inputTranscription) {
      await this._handleMsgInputTranscription(message);
    }
    if (sc?.outputTranscription) {
      await this._handleMsgOutputTranscription(message);
    }
    if (sc?.groundingMetadata && !sc.modelTurn && !sc.outputTranscription) {
      // modelTurn/outputTranscription already defer
      // bundled grounding metadata to turnComplete.
      await this._handleMsgGroundingMetadata(message);
    }
    if (sc?.turnComplete) {
      if (!message.usageMetadata) {
        logger.warning("Received turn_complete without usage_metadata");
      }
      if (interactionIdle === false) {
        // The server is still reasoning in the background, so this
        // turnComplete only closes an output chunk. Hold the turn
        // open until the session reports going idle.
        this._deferTurnCompleteUntilIdle(message);
      } else {
        // This turnComplete is the turn's last, so it supersedes any
        // earlier one still being held.
        this._discardDeferredTurn();
        await this._handleMsgTurnComplete(message);
      }
      if (message.usageMetadata) {
        await this._handleMsgUsageMetadata(message);
      }
    }
    if (message.toolCall) {
      await this._handleMsgToolCall(message);
    }
    if (message.sessionResumptionUpdate) {
      this._handleMsgResumptionUpdate(message);
    }
    // Close a held turn only after any bundled tool call has been
    // dispatched, so the turn ends with the message fully processed.
    if (interactionIdle) {
      await this._completeDeferredTurn();
    }
  }

  /**
   * Read the session's idle state from `serverContent`.
   *
   * @param serverContent The `serverContent` of an incoming message.
   * @returns True when the server reports being idle, false while it is
   *   still working, and null when it expresses no opinion (the model
   *   doesn't report a status).
   */
  protected _readInteractionStatus(
    serverContent: LiveServerContent | null | undefined,
  ): boolean | null {
    const status = serverContent
      ? (serverContent as { interactionStatus?: unknown }).interactionStatus
      : undefined;
    if (status === null || status === undefined) {
      return null;
    }
    logger.debug(`${this}: interaction_status=${String(status)}`);
    // Compare on the value: the idle state was renamed REQUIRES_ACTION ->
    // IDLE.
    const value =
      typeof status === "object" && "value" in (status as object)
        ? (status as { value: unknown }).value
        : status;
    if (value === "IDLE" || value === "REQUIRES_ACTION") {
      return true;
    }
    if (value === "IN_PROGRESS") {
      return false;
    }
    return null;
  }

  /** Hold a turnComplete until the session reports going idle. */
  protected _deferTurnCompleteUntilIdle(message: LiveServerMessage): void {
    this._turnCompletePendingIdle = message;
    this._startDeferredTurnCompleteTimeout();
  }

  /**
   * (Re)start the held-turn watchdog.
   *
   * The watchdog fires only after the server goes silent — a long reply
   * still streaming keeps restarting it — so it forces a held turn closed
   * only when the session goes quiet while stuck IN_PROGRESS.
   */
  protected _startDeferredTurnCompleteTimeout(): void {
    this._cancelDeferredTurnCompleteTimeout();

    const timeoutSecs = GeminiLiveLLMService._DEFERRED_TURN_COMPLETE_TIMEOUT_SECS;
    const _timeout = async (): Promise<void> => {
      await sleep(timeoutSecs);
      if (this._turnCompletePendingIdle) {
        logger.warning(
          `No server messages for ${timeoutSecs}s ` +
            "with the interaction status stuck IN_PROGRESS — ending the bot turn",
        );
        await this._completeDeferredTurn();
      }
    };

    this._deferredTurnCompleteTimeoutTask = this.createTask(
      _timeout,
      "deferred_turn_complete_timeout",
    );
  }

  /** Close a turn that was held open while the server was still working. */
  protected async _completeDeferredTurn(): Promise<void> {
    this._cancelDeferredTurnCompleteTimeout();
    const message = this._turnCompletePendingIdle;
    if (message === null) {
      return;
    }
    this._turnCompletePendingIdle = null;
    await this._handleMsgTurnComplete(message);
  }

  /** Drop a held turn without closing it, e.g. after an interruption. */
  protected _discardDeferredTurn(): void {
    this._cancelDeferredTurnCompleteTimeout();
    this._turnCompletePendingIdle = null;
  }

  /** Cancel the deferred-turn-complete watchdog if active. */
  protected _cancelDeferredTurnCompleteTimeout(): void {
    const task = this._deferredTurnCompleteTimeoutTask;
    this._deferredTurnCompleteTimeoutTask = null;
    // The watchdog itself ends the turn on expiry, so skip the cancel when
    // we're running inside it — otherwise it would cut itself off partway
    // through closing the turn.
    if (task && !task.done() && task !== currentTask()) {
      task.cancel();
    }
  }

  /**
   * Check if connection has been stable long enough to reset the failure counter.
   *
   * If the connection has been active for longer than the established threshold
   * and there are accumulated failures, reset the counter to 0.
   */
  protected _checkAndResetFailureCounter(): void {
    if (
      this._connectionStartTime &&
      this._consecutiveFailures > 0 &&
      time() - this._connectionStartTime >= CONNECTION_ESTABLISHED_THRESHOLD
    ) {
      logger.info(
        `Connection stable for ${CONNECTION_ESTABLISHED_THRESHOLD}s, ` +
          `resetting failure counter from ${this._consecutiveFailures} to 0`,
      );
      this._consecutiveFailures = 0;
    }
  }

  /**
   * Handle a connection error and determine if reconnection should be attempted.
   *
   * @param error The exception that caused the connection error.
   * @returns True if reconnection should be attempted, false if a fatal error
   *   should be pushed.
   */
  protected async _handleConnectionError(error: unknown): Promise<boolean> {
    this._consecutiveFailures += 1;
    logger.warning(
      `Connection error (failure ${this._consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${errorMessage(error)}`,
    );

    if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      const errorMsg =
        `Max consecutive failures (${MAX_CONSECUTIVE_FAILURES}) reached, ` +
        "treating as fatal error";
      await this.pushError(errorMsg, { exception: error });
      return false;
    }
    logger.info(
      `Attempting reconnection (${this._consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
    );
    return true;
  }

  /** Reconnect to Gemini Live API. */
  protected async _reconnect(): Promise<void> {
    await this._disconnect();
    await this._connect(this._sessionResumptionHandle);
  }

  /** Disconnect from Gemini Live API and clean up resources. */
  protected async _disconnect(): Promise<void> {
    logger.info("Disconnecting from Gemini service");
    try {
      this._disconnecting = true;
      await this.stopAllMetrics();
      if (this._connectionTask) {
        await this.cancelTask(this._connectionTask, 1.0);
        this._connectionTask = null;
      }
      if (this._transcriptionTimeoutTask) {
        await this.cancelTask(this._transcriptionTimeoutTask);
        this._transcriptionTimeoutTask = null;
      }
      this._cancelEndFrameDeferralTimeout();
      this._endFramePendingBotTurnFinished = null;
      this._discardDeferredTurn();
      if (this._session) {
        this._session.close();
        this._session = null;
      }
      this._completedToolCalls = new Set();
      this._toolCallIdToName = new Map();
      this._asyncToolWarningLogged = false;
      this._readyForRealtimeInput = false;
      this._disconnecting = false;
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error disconnecting: ${errorMessage(e)}`, { exception: e });
    }
  }

  /**
   * Auto-size the pre-roll from the upstream VAD's startSecs.
   *
   * `VADController` broadcasts the current `VADParams` at pipeline start
   * (and on any runtime change), so the pre-roll tracks `startSecs` — the
   * leading speech local turn detection consumes before confirming the turn
   * — plus a margin.
   *
   * This assumes VAD drives turn starts (the default
   * `VADUserTurnStartStrategy`). With a non-VAD turn-start strategy the
   * onset-to-turn-start gap isn't governed by `startSecs`; in that case
   * the developer should pin a pre-roll duration via
   * `userAudioPrerollSecs` (which short-circuits this).
   *
   * This mechanism is harmless when server-side VAD is enabled (the buffer
   * is simply unused).
   */
  protected _handleSpeechControlParams(frame: SpeechControlParamsFrame): void {
    if (this._userAudioPrerollSecsOverride !== null) {
      return;
    }
    if (frame.vadParams !== null) {
      this._userAudioPrerollSecs =
        frame.vadParams.startSecs + AUTOSIZED_USER_AUDIO_PREROLL_MARGIN_SECS;
    }
  }

  /**
   * Stream user audio to Gemini Live.
   *
   * With server-side VAD disabled (locally-driven turns) we honor the
   * activity-window contract: audio is streamed only during an active turn
   * (between activity_start and activity_end), since the service discards
   * anything outside that window. While idle we retain it in a rolling
   * pre-roll buffer that `_handleUserStartedSpeaking` flushes after
   * activity_start to recover the speech onset.
   *
   * With server-side VAD enabled we stream continuously, since Gemini's VAD
   * needs the uninterrupted stream to detect turns.
   */
  protected async _sendUserAudio(frame: InputAudioRawFrame): Promise<void> {
    if (
      this._audioInputPaused ||
      this._disconnecting ||
      !this._session ||
      !this._readyForRealtimeInput
    ) {
      return;
    }

    // Send all audio in server-VAD mode, or in local-VAD mode if we're
    // currently in a user turn. (Otherwise, it'll just live in the pre-roll
    // buffer, for use when we detect the user has started speaking).
    if (!this._vadDisabled || this._userIsSpeaking) {
      try {
        this._session.sendRealtimeInput({
          audio: {
            data: bytesToBase64(frame.audio),
            mimeType: `audio/pcm;rate=${frame.sampleRate}`,
          },
        });
      } catch (e) {
        rethrowIfCancelled(e);
        await this._handleSendError(e);
      }
    } else {
      // Retain the most recent userAudioPrerollSecs as a rolling buffer.
      const buffer = concatBytes(this._userAudioPrerollBuffer, frame.audio);
      const prerollLen = Math.trunc(
        frame.sampleRate * frame.numChannels * 2 * this._userAudioPrerollSecs,
      );
      // Python's `buf[-0:]` keeps the whole buffer, as `slice(-0)` does.
      this._userAudioPrerollBuffer = buffer.slice(-prerollLen);
      this._userAudioPrerollBufferSampleRate = frame.sampleRate;
    }
  }

  /**
   * Send the buffered pre-roll audio, then clear the buffer.
   *
   * Must run inside an active activity window (after activity_start). Throws
   * on send failure so the caller can route it through `_handleSendError`.
   */
  protected async _flushUserAudioPreroll(): Promise<void> {
    if (
      this._userAudioPrerollBuffer.length === 0 ||
      this._userAudioPrerollBufferSampleRate === null
    ) {
      return;
    }
    const audio = this._userAudioPrerollBuffer;
    const sampleRate = this._userAudioPrerollBufferSampleRate;
    this._userAudioPrerollBuffer = new Uint8Array(0);
    if (this._session === null) {
      throw new Error("assertion failed: this._session is not null");
    }
    this._session.sendRealtimeInput({
      audio: { data: bytesToBase64(audio), mimeType: `audio/pcm;rate=${sampleRate}` },
    });
  }

  /**
   * Send user text via Gemini Live API's realtime input stream.
   *
   * This method sends text through the realtimeInput stream (via TextInputMessage)
   * rather than the clientContent stream. This ensures text input is synchronized
   * with audio and video inputs, preventing temporal misalignment that can occur
   * when different modalities are processed through separate API pathways.
   *
   * For realtimeInput, turn completion is automatically inferred by the API based
   * on user activity, so no explicit turnComplete signal is needed.
   *
   * @param text The text to send as user input.
   */
  protected async _sendUserText(text: string): Promise<void> {
    if (this._disconnecting || !this._session || !this._readyForRealtimeInput) {
      return;
    }

    try {
      this._session.sendRealtimeInput({ text });
    } catch (e) {
      rethrowIfCancelled(e);
      await this._handleSendError(e);
    }
  }

  /** Send user video frame to Gemini Live API. */
  protected async _sendUserVideo(frame: InputImageRawFrame): Promise<void> {
    if (
      this._videoInputPaused ||
      this._disconnecting ||
      !this._session ||
      !this._readyForRealtimeInput
    ) {
      return;
    }

    const now = time();
    if (now - this._lastSentTime < 1) {
      return; // Ignore if less than 1 second has passed
    }

    this._lastSentTime = now; // Update last sent time
    logger.trace(`Sending video frame to Gemini: ${frame}`);

    const [image, mimeType] = await encodeImage(frame.image, frame.size, frame.format);

    try {
      this._session.sendRealtimeInput({ video: { data: bytesToBase64(image), mimeType } });
    } catch (e) {
      rethrowIfCancelled(e);
      await this._handleSendError(e);
    }
  }

  /**
   * Seed conversation history and optionally trigger an initial model response.
   *
   * Behavior by case:
   *
   * Initial connection, `_inferenceOnContextInitialization` true:
   *   Seed with `turnComplete: true` so the model generates a first
   *   response to the trailing user turn. On Gemini 3.x we also send a
   *   realtime-input nudge (the model won't actually run inference
   *   without one).
   *
   * Initial connection, `_inferenceOnContextInitialization` false:
   *   Seed with `turnComplete: false` (no response yet). On Gemini 2.5
   *   we set `_needsInitialTurnCompleteMessage` so the next
   *   user_stopped_speaking sends an explicit `turnComplete: true`;
   *   otherwise 2.5 ignores the seeded history when the user's first
   *   input is audio. Gemini 3.x merges seeded history and audio
   *   cleanly and needs no workaround.
   *
   *   Note: on Gemini 2.5 the first user utterance after this kind of
   *   seed still produces one "naive" response (context-ignoring) that
   *   is immediately followed by a context-aware response. This is
   *   Gemini 2.5's documented audio-input / history-recall limitation
   *   (https://discuss.ai.google.dev/t/audio-input-cannot-trigger-history-recall-in-gemini-live-api-only-text-input-works/111617).
   *   It's tolerable at the start of a conversation because the first
   *   utterance is usually a greeting.
   *
   * Reconnect, Gemini 3.x:
   *   Seed with `turnComplete: false` — no workaround needed, the
   *   next user utterance gets a single history-aware response.
   *
   * Reconnect, Gemini 2.5:
   *   Force `turnComplete: true` on the seed so the model generates
   *   an inference over the seeded history immediately (typically a
   *   recap/continuation of the conversation). This works around the
   *   same Gemini 2.5 audio-input / history-recall limitation noted
   *   above: if we seeded without triggering inference, the user's next
   *   utterance — mid-conversation — would briefly hear the bot act
   *   like it had forgotten everything before recovering on the
   *   following turn. Forcing a recap-style response up front avoids
   *   that jarring UX.
   *
   * Seed shape:
   *   Gemini 2.5's `sendClientContent` requires the seed's final
   *   turn to be a user turn. When it isn't (e.g. on reconnect where
   *   the bot had finished speaking before the disconnect), we append
   *   a blank user turn to satisfy the server. Gemini 3.x has no such
   *   requirement.
   *
   * @param forReconnect When true, we're re-seeding after a reconnect.
   */
  protected async _createInitialResponse(forReconnect = false): Promise<void> {
    if (this._disconnecting) {
      return;
    }

    if (!this._session) {
      this._runLlmWhenSessionReady = true;
      return;
    }

    if (this._context === null) {
      throw new Error("assertion failed: this._context is not null");
    }

    const messages = (await this._invocationParams(this._context)).messages ?? [];
    if (messages.length === 0) {
      // No messages to seed convo with, so we're ready for realtime input right away
      this._readyForRealtimeInput = true;
      return;
    }

    // On reconnect, Gemini 2.5 needs us to force an inference so the user
    // doesn't momentarily experience a "forgotten" assistant (see
    // docstring). Gemini 3.x doesn't have that limitation. In the
    // non-reconnect case we honor the configured setting.
    let triggerInference: boolean;
    if (forReconnect) {
      triggerInference = !this._isGemini3;
    } else {
      triggerInference = this._inferenceOnContextInitialization;
    }

    this._logLlmConversationSetup(this._context);

    // Enforce Gemini 2.5's "seed must end with user turn" requirement.
    let seedMessages = messages;
    if (!this._isGemini3) {
      const lastRole = (messages[messages.length - 1] as { role?: string } | undefined)?.role;
      if (lastRole !== "user") {
        seedMessages = [...messages, { role: "user", parts: [{ text: " " }] }];
      }
    }

    await this.startTtfbMetrics();

    try {
      this._session.sendClientContent({ turns: seedMessages, turnComplete: triggerInference });
      // Gemini 3.x wants turn_complete=True, but also won't run inference without a realtime input
      if (this._isGemini3 && triggerInference) {
        this._session.sendRealtimeInput({ text: " " });
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this._handleSendError(e);
    }

    // Gemini 2.5-only workaround: when we've seeded without triggering
    // inference, flag that the next user_stopped_speaking should send
    // turnComplete: true so 2.5 picks up the seeded history.
    if (!triggerInference && !this._isGemini3) {
      this._needsInitialTurnCompleteMessage = true;
    }

    this._readyForRealtimeInput = true;
  }

  /**
   * Create a single response from a list of messages.
   *
   * This is only here to support the very specific 'legacy' scenario of
   * kicking off a conversation using LLMMessagesAppendFrame when there's no
   * context aggregators in the pipeline (see processFrame for more details).
   */
  protected async _createSingleResponse(messagesList: unknown[]): Promise<void> {
    if (this._disconnecting || !this._session) {
      return;
    }

    // Create a throwaway context just for the purpose of getting messages
    // in the right format
    const context = new LLMContext({ messages: messagesList as LLMContextMessage[] });
    const messages = (await this._invocationParams(context)).messages ?? [];

    if (messages.length === 0) {
      return;
    }

    logger.debug(`Creating response: ${pyJsonDumps(messages)}`);

    await this.startTtfbMetrics();

    try {
      this._session.sendClientContent({ turns: messages, turnComplete: true });
      // Gemini 3.x wants turn_complete=True, but also won't run inference without a realtime input
      if (this._isGemini3) {
        this._session.sendRealtimeInput({ text: " " });
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this._handleSendError(e);
    }
  }

  /**
   * Send tool result back to the API.
   *
   * @param toolCallId The call the result belongs to.
   * @param toolName The function that was called.
   * @param toolResultMessage The result, as a response dict.
   * @param options.isFinal Whether this result completes the call. An
   *   intermediate one keeps it open (`willContinue`), which only a
   *   NON_BLOCKING call allows.
   * @param options.spoken Whether the model should address the result. It is
   *   told to stay silent otherwise, so the result is context it can draw on
   *   if the conversation turns that way.
   */
  protected async _toolResult(
    toolCallId: string,
    toolName: string,
    toolResultMessage: Record<string, unknown>,
    options: { isFinal?: boolean; spoken?: boolean } = {},
  ): Promise<void> {
    const isFinal = options.isFinal ?? true;
    const spoken = options.spoken ?? true;
    if (this._disconnecting || !this._session) {
      return;
    }

    logger.debug(
      `Sending tool result to Gemini Live for tool_call_id=${toolCallId}, tool_result_message=${pyJsonDumps(toolResultMessage)}`,
    );

    // Pair the NON_BLOCKING declaration on async tools with a
    // scheduling hint on the response. WHEN_IDLE lets Gemini finish
    // whatever it's currently saying before addressing the result, so
    // we don't cut off mid-sentence when delayed results land; SILENT
    // takes the result in without answering it. Only meaningful for
    // NON_BLOCKING tools — synchronous tools never leave the model
    // mid-turn — so we mirror the gating used at tool-declaration time.
    // https://ai.google.dev/gemini-api/docs/live-api/tools#async-function-calling
    const nonBlocking = this._supportsNonBlockingTools && this._functionIsAsync(toolName);
    const scheduling = nonBlocking ? (spoken ? "WHEN_IDLE" : "SILENT") : null;
    const responsePayload = scheduling ? { ...toolResultMessage, scheduling } : toolResultMessage;

    // For now we're shoving the name into the toolCallId field, so this
    // will work until we revisit that.
    const response: FunctionResponse = {
      name: toolName,
      id: toolCallId,
      response: responsePayload,
    };
    // The guides document scheduling inside the response, the API reference
    // as a field of its own; set both so whichever the server reads is
    // there. willContinue only exists as a field: true keeps the call open
    // for more responses, and false closes it, which the last response has
    // to say or the call stays open for good.
    if (nonBlocking) {
      response.scheduling = scheduling as FunctionResponseScheduling;
      response.willContinue = !isFinal;
    }

    try {
      this._session.sendToolResponse({ functionResponses: response });
    } catch (e) {
      rethrowIfCancelled(e);
      await this._handleSendError(e);
    }
  }

  /** Handle the session being ready. */
  protected async _handleSessionReady(session: Session): Promise<void> {
    this._session = session;
    if (this._runLlmWhenSessionReady) {
      // Initial connection: context arrived before session was ready.
      this._runLlmWhenSessionReady = false;
      await this._createInitialResponse();
    } else if (this._sessionResumptionHandle) {
      // Reconnect with session resumption: the server will restore
      // session state, so we can accept realtime input right away.
      this._readyForRealtimeInput = true;
    } else if (this._context) {
      // Reconnect without session resumption (e.g. error occurred
      // before server sent a resumption handle): re-seed conversation
      // history so the new session retains full context before
      // accepting input. We route through _createInitialResponse so
      // that the seed/commit dance stays in one place. See that
      // method's docstring for the reconnect-specific behavior.
      await this._createInitialResponse(true);
    } else {
      // Initial connection: session is ready before context has
      // arrived. Nothing to do — _handleContext will call
      // _createInitialResponse when the context arrives.
    }
  }

  /** Handle the model turn message. */
  protected async _handleMsgModelTurn(msg: LiveServerMessage): Promise<void> {
    const parts = msg.serverContent?.modelTurn?.parts;
    if (!parts || parts.length === 0) {
      return;
    }
    const part = parts[0]!;

    await this.stopTtfbMetrics();

    // part.text is added when `modalities` is set to TEXT; otherwise, it's undefined
    const text = part.text;
    if (text) {
      if (!this._botIsResponding) {
        // Update bot responding state and send service start frame
        // (AUDIO modality case)
        await this._setBotIsResponding(true);
        await this.pushFrame(new LLMFullResponseStartFrame());
      }

      // Check if this is a thought
      if (part.thought) {
        // Gemini Live emits fully-formed thoughts rather than chunks,
        // so bracket each thought in start/end frames
        await this.pushFrame(new LLMThoughtStartFrame());
        await this.pushFrame(new LLMThoughtTextFrame({ text }));
        await this.pushFrame(new LLMThoughtEndFrame());
      } else {
        // Regular text response
        this._botTextBuffer += text;
        this._searchResultBuffer += text; // Also accumulate for grounding
        const frame = new LLMTextFrame({ text });
        await this.pushFrame(frame);
      }
    }

    // Check for grounding metadata in server content
    if (msg.serverContent?.groundingMetadata) {
      this._accumulatedGroundingMetadata = msg.serverContent.groundingMetadata;
    }

    // If we have no audio, stop here.
    // All logic below this point pertains to the AUDIO modality.
    const inlineData = part.inlineData;
    if (!inlineData) {
      return;
    }

    // Check if mime type matches expected format
    const expectedMimeType = `audio/pcm;rate=${this._sampleRate}`;
    if (inlineData.mimeType === expectedMimeType) {
      // Perfect match, continue processing
    } else if (inlineData.mimeType === "audio/pcm") {
      // Sample rate not provided in mime type, assume default
      if (!this._sampleRateWarningLogged) {
        logger.warning(
          `Sample rate not provided in mime type '${inlineData.mimeType}', assuming rate of ${this._sampleRate}`,
        );
        this._sampleRateWarningLogged = true;
      }
    } else {
      // Unrecognized format
      logger.warning(`Unrecognized server_content format ${inlineData.mimeType}`);
      return;
    }

    if (!inlineData.data) {
      return;
    }
    const audio = base64ToBytes(inlineData.data);
    if (audio.length === 0) {
      return;
    }

    // Update bot responding state and send service start frames
    // (AUDIO modality case)
    if (!this._botIsResponding) {
      await this._setBotIsResponding(true);
      await this.pushFrame(new TTSStartedFrame());
      await this.pushFrame(new LLMFullResponseStartFrame());
    }

    this._botAudioBuffer = concatBytes(this._botAudioBuffer, audio);
    const frame = new TTSAudioRawFrame({
      audio,
      sampleRate: this._sampleRate,
      numChannels: 1,
    });
    await this.pushFrame(frame);
  }

  /** Handle tool call messages. */
  protected async _handleMsgToolCall(message: LiveServerMessage): Promise<void> {
    if (!message.toolCall) {
      throw new Error("assertion failed: message.toolCall is not null");
    }

    const functionCalls = message.toolCall.functionCalls;
    if (!functionCalls || functionCalls.length === 0) {
      return;
    }
    if (!this._context) {
      logger.error("Function calls are not supported without a context object.");
    }

    const functionCallsLlm = functionCalls.map(
      (f) =>
        new FunctionCallFromLLM({
          context: this._context,
          // NOTE: when using Vertex AI we don't get server-provided
          // tool call IDs here
          toolCallId: f.id || crypto.randomUUID(),
          functionName: f.name || "",
          arguments: f.args || {},
        }),
    );

    for (const fc of functionCallsLlm) {
      this._toolCallIdToName.set(fc.toolCallId, fc.functionName);
    }

    await this.runFunctionCalls(functionCallsLlm);
  }

  /** Handle the turn complete message. */
  protected async _handleMsgTurnComplete(_message: LiveServerMessage): Promise<void> {
    const text = this._botTextBuffer;

    // Trace the complete LLM response (this will be handled by the decorator)
    // The decorator will extract the output text and usage metadata from the message

    this._botTextBuffer = "";
    this._llmOutputBuffer = "";

    // Process grounding metadata if we have accumulated any
    if (this._accumulatedGroundingMetadata) {
      await this._processGroundingMetadata(
        this._accumulatedGroundingMetadata,
        this._searchResultBuffer,
      );
    }

    // Reset grounding tracking for next response
    this._searchResultBuffer = "";
    this._accumulatedGroundingMetadata = null;

    if (this._botIsResponding) {
      await this._setBotIsResponding(false);
      if (!text) {
        // AUDIO modality case
        await this.pushFrame(new TTSStoppedFrame());
        await this.pushFrame(new LLMFullResponseEndFrame());
      } else {
        // TEXT modality case
        await this.pushFrame(new LLMFullResponseEndFrame());
      }
    }
  }

  /** Handle a transcription result with tracing. */
  protected async _handleUserTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | string | null = null,
  ): Promise<void> {}

  /**
   * Push a user transcription frame upstream.
   *
   * Helper method to ensure consistent handling of user transcriptions
   * from both punctuation-based and timeout-based paths.
   *
   * @param text The transcription text to push
   * @param result Optional LiveServerMessage that triggered this transcription
   */
  protected async _pushUserTranscription(
    text: string,
    result: LiveServerMessage | null = null,
  ): Promise<void> {
    const language = this._settings.language;
    await this._handleUserTranscription(text, true, isGiven(language) ? language : null);
    await this.pushFrame(
      new TranscriptionFrame({
        text,
        userId: "",
        timestamp: timeNowIso8601(),
        result,
      }),
      FrameDirection.UPSTREAM,
    );
  }

  /**
   * Handle timeout for user transcription buffer.
   *
   * If no new transcription messages arrive within the timeout period,
   * flush any remaining text in the buffer as a complete sentence.
   */
  protected async _transcriptionTimeoutHandler(): Promise<void> {
    try {
      // Wait for timeout period (0.5 seconds)
      await sleep(0.5);

      // If we still have buffered text after timeout, flush it
      if (this._userTranscriptionBuffer) {
        logger.trace(
          `[Transcription:user:timeout] Flushing buffer: [${this._userTranscriptionBuffer}]`,
        );
        const completeSentence = this._userTranscriptionBuffer;
        this._userTranscriptionBuffer = "";

        await this._pushUserTranscription(completeSentence, null);
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        // Task was cancelled because new transcription arrived. This is expected
        // when back to back transcription messages arrive.
        logger.trace("Transcription timeout task cancelled (new text arrived)");
      }
      throw e;
    }
  }

  /**
   * Handle the input transcription message.
   *
   * Gemini Live sends user transcriptions in either single words or multi-word
   * phrases. As a result, we have to aggregate the input transcription. This handler
   * aggregates into sentences, splitting on the end of sentence markers. If no
   * punctuation arrives within a timeout period, the buffer is flushed automatically.
   */
  protected async _handleMsgInputTranscription(message: LiveServerMessage): Promise<void> {
    if (!message.serverContent) {
      throw new Error("assertion failed: message.serverContent is not null");
    }

    if (!message.serverContent.inputTranscription) {
      return;
    }

    let text = message.serverContent.inputTranscription.text;

    if (!text) {
      return;
    }

    // Cancel any existing timeout task since we received new text
    if (this._transcriptionTimeoutTask) {
      await this.cancelTask(this._transcriptionTimeoutTask);
      this._transcriptionTimeoutTask = null;
    }

    // Strip leading space from sentence starts if buffer is empty
    if (text.startsWith(" ") && !this._userTranscriptionBuffer) {
      text = text.trimStart();
    }

    // Accumulate text in the buffer
    this._userTranscriptionBuffer += text;

    // Check for complete sentences
    while (true) {
      const eosEndMarker = matchEndofsentence(this._userTranscriptionBuffer);
      if (!eosEndMarker) {
        break;
      }

      // Extract the complete sentence
      const completeSentence = this._userTranscriptionBuffer.slice(0, eosEndMarker);
      // Keep the remainder for the next chunk
      this._userTranscriptionBuffer = this._userTranscriptionBuffer.slice(eosEndMarker);

      // Send a TranscriptionFrame with the complete sentence
      logger.debug(`[Transcription:user] [${completeSentence}]`);
      await this._pushUserTranscription(completeSentence, message);
    }

    // If there's still text in the buffer (no end-of-sentence marker found),
    // start a timeout task to flush it later
    if (this._userTranscriptionBuffer) {
      this._transcriptionTimeoutTask = this.createTask(
        () => this._transcriptionTimeoutHandler(),
        "_transcriptionTimeoutHandler",
      );
    }
  }

  /** Handle the output transcription message. */
  protected async _handleMsgOutputTranscription(message: LiveServerMessage): Promise<void> {
    if (!message.serverContent) {
      throw new Error("assertion failed: message.serverContent is not null");
    }

    if (!message.serverContent.outputTranscription) {
      return;
    }

    // This is the output transcription text when modalities is set to AUDIO.
    // In this case, we push TTSTextFrame to be handled by the downstream
    // assistant context aggregator.
    const text = message.serverContent.outputTranscription.text;

    if (!text) {
      return;
    }

    // Accumulate text for grounding as well
    this._searchResultBuffer += text;

    // Check for grounding metadata in server content
    if (message.serverContent.groundingMetadata) {
      this._accumulatedGroundingMetadata = message.serverContent.groundingMetadata;
    }
    // Collect text for tracing
    this._llmOutputBuffer += text;

    // NOTE: Shoot. When using Vertex AI, output transcription messages
    // arrive *before* the modelTurn messages with audio, so we need to
    // handle sending TTSStartedFrame and LLMFullResponseStartFrame here as
    // well. These messages also contain much *more* text (it looks further
    // ahead). That means that on an interruption our recorded context will
    // contain some text that was actually never spoken.
    if (!this._botIsResponding) {
      await this._setBotIsResponding(true);
      await this.pushFrame(new TTSStartedFrame());
      await this.pushFrame(new LLMFullResponseStartFrame());
    }

    await this._pushOutputTranscriptionTextFrames(text);
  }

  protected async _pushOutputTranscriptionTextFrames(text: string): Promise<void> {
    // In a typical "cascade" LLM + TTS setup, LLMTextFrames would not
    // proceed beyond the TTS service. Therefore, since a speech-to-speech
    // service like Gemini Live combines both LLM and TTS functionality, you
    // might think we wouldn't need to push LLMTextFrames at all. However,
    // RTVI relies on LLMTextFrames being pushed to trigger its
    // "bot-llm-text" event. So here we push an LLMTextFrame, too, but avoid
    // appending it to context to avoid context message duplication.

    // Push LLMTextFrame
    const llmTextFrame = new LLMTextFrame({ text });
    llmTextFrame.appendToContext = false;
    await this.pushFrame(llmTextFrame);

    // Push TTSTextFrame
    const ttsTextFrame = new TTSTextFrame({ text, textType: TextType.SENTENCE });
    ttsTextFrame.includesInterFrameSpaces = true;
    await this.pushFrame(ttsTextFrame);
  }

  /** Handle dedicated grounding metadata messages. */
  protected async _handleMsgGroundingMetadata(message: LiveServerMessage): Promise<void> {
    if (message.serverContent?.groundingMetadata) {
      const groundingMetadata = message.serverContent.groundingMetadata;
      // Process the grounding metadata immediately
      await this._processGroundingMetadata(groundingMetadata, this._searchResultBuffer);
    }
  }

  /** Process grounding metadata and emit LLMSearchResponseFrame. */
  protected async _processGroundingMetadata(
    groundingMetadata: GroundingMetadata,
    searchResult = "",
  ): Promise<void> {
    if (!groundingMetadata) {
      return;
    }

    // Extract rendered content for search suggestions
    let renderedContent: string | null = null;
    if (groundingMetadata.searchEntryPoint?.renderedContent) {
      renderedContent = groundingMetadata.searchEntryPoint.renderedContent;
    }

    // Convert grounding chunks and supports to LLMSearchOrigin format
    const origins: LLMSearchOrigin[] = [];

    const chunks = groundingMetadata.groundingChunks;
    const supports = groundingMetadata.groundingSupports;
    if (chunks && chunks.length > 0 && supports && supports.length > 0) {
      // Create a mapping of chunk indices to origins
      const chunkToOrigin = new Map<number, LLMSearchOrigin>();

      chunks.forEach((chunk, index) => {
        if (chunk.web) {
          const origin = new LLMSearchOrigin({
            siteUri: chunk.web.uri ?? null,
            siteTitle: chunk.web.title ?? null,
            results: [],
          });
          chunkToOrigin.set(index, origin);
          origins.push(origin);
        }
      });

      // Add grounding support results to the appropriate origins
      for (const support of supports) {
        const indices = support.groundingChunkIndices;
        if (support.segment && indices && indices.length > 0) {
          const text = support.segment.text || "";
          const confidenceScores = support.confidenceScores || [];

          // Add this result to all origins referenced by this support
          for (const chunkIndex of indices) {
            const origin = chunkToOrigin.get(chunkIndex);
            if (origin) {
              const result = new LLMSearchResult({ text, confidence: confidenceScores });
              origin.results.push(result);
            }
          }
        }
      }
    }

    // Create and push the search response frame
    const searchFrame = new LLMSearchResponseFrame({
      searchResult,
      origins,
      renderedContent,
    });

    await this.pushFrame(searchFrame);
  }

  /** Handle the usage metadata message. */
  protected async _handleMsgUsageMetadata(message: LiveServerMessage): Promise<void> {
    if (!message.usageMetadata) {
      return;
    }

    const usage = message.usageMetadata;

    // Gemini counts tool results fed back to the model apart from the prompt,
    // and thinking tokens apart from the response, but they are input and
    // output too. Its totalTokenCount sometimes leaves the thinking tokens
    // out, so the total is computed.
    const promptTokens = (usage.promptTokenCount || 0) + (usage.toolUsePromptTokenCount || 0);
    const completionTokens = (usage.responseTokenCount || 0) + (usage.thoughtsTokenCount || 0);
    const totalTokens = promptTokens + completionTokens;

    const tokens = new LLMTokenUsage({
      promptTokens,
      completionTokens,
      totalTokens,
      cacheReadInputTokens: usage.cachedContentTokenCount ?? null,
      reasoningTokens: usage.thoughtsTokenCount ?? null,
      inputAudioTokens: _audioTokenCount(usage.promptTokensDetails),
      outputAudioTokens: _audioTokenCount(usage.responseTokensDetails),
      cacheReadInputAudioTokens: _audioTokenCount(usage.cacheTokensDetails),
    });

    await this.startLlmUsageMetrics(tokens);
  }

  protected _handleMsgResumptionUpdate(message: LiveServerMessage): void {
    const update = message.sessionResumptionUpdate;
    if (!update) {
      throw new Error("assertion failed: message.sessionResumptionUpdate is not null");
    }

    if (update.resumable && update.newHandle) {
      this._sessionResumptionHandle = update.newHandle;
    }
  }

  protected async _handleSendError(error: unknown): Promise<void> {
    // Ignore "expected" errors that may have occurred for messages that
    // were in-flight when a disconnection occurred.
    if (this._disconnecting || !this._session) {
      return;
    }

    // In server-to-server contexts, a WebSocket error should be quite rare.
    // Given how hard it is to recover from a send-side error with proper
    // state management, and that exponential backoff for retries can have
    // cost/stability implications for a service cluster, let's just treat a
    // send-side error as fatal.
    await this.pushError(`Send error: ${errorMessage(error)}`);
  }

  // Tracing, as upstream's decorators on these methods.
  static {
    const proto = GeminiLiveLLMService.prototype;
    proto._toolResult = tracedGeminiLive("llm_tool_result")(proto._toolResult);
    proto._handleSessionReady = tracedGeminiLive("llm_setup")(proto._handleSessionReady);
    proto._handleMsgToolCall = tracedGeminiLive("llm_tool_call")(proto._handleMsgToolCall);
    proto._handleMsgTurnComplete = tracedGeminiLive("llm_response")(proto._handleMsgTurnComplete);
    installTracedStt(proto, "_handleUserTranscription");
  }
}

/** Python tuple comparison `version >= minimum` for `(major, minor)`. */
function versionAtLeast(version: [number, number], minimum: [number, number]): boolean {
  return version[0] !== minimum[0] ? version[0] > minimum[0] : version[1] >= minimum[1];
}
