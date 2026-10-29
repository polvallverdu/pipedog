// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/elevenlabs/tts_base.py

/**
 * Shared foundation for the ElevenLabs multi-context WebSocket TTS services.
 *
 * Holds what the text-to-speech and Text-to-Dialogue services have in common:
 * the connection and task lifecycle, settings-change dispatch, the
 * word-timestamp clock, and the shape of a synthesis request. Each service
 * supplies its own endpoint URL and wire protocol.
 *
 * Porting notes:
 * - The socket is the global `WebSocket` through
 *   `WebsocketService._websocketConnect()`. The `xi-api-key` header is sent on
 *   the opening handshake: by the Bun, Node and Deno `WebSocket`, and on
 *   Cloudflare Workers through `fetch`, which `websocketConnect` uses there.
 * - `websocket.wait_closed()` is awaited by listening for the underlying
 *   `WebSocket`'s `close` event (`WebsocketClientConnection` exposes no public
 *   `waitClosed()`).
 * - Settings field names are camelCase, so `URL_FIELDS` and
 *   `VOICE_SETTINGS_FIELDS` name the camelCase fields (`similarityBoost`).
 */

import { Future, rethrowIfCancelled, type Task, TimeoutError, waitFor } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  TTSStartedFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import {
  WebsocketTTSService,
  type WebsocketTTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import {
  ConnectionClosed,
  State,
  type WebsocketClientConnection,
} from "@pipedog/core/services/websocket_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Python truthiness for JSON values (empty strings, arrays and objects are falsy). */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Languages the Flash and Turbo v2.5 models accept as a `language_code`. */
export const ELEVENLABS_V2_5_LANGUAGES: ReadonlySet<string> = new Set([
  "ar",
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "fi",
  "fil",
  "fr",
  "hi",
  "hr",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "ms",
  "nl",
  "no",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sv",
  "ta",
  "tr",
  "uk",
  "vi",
  "zh",
]);

/**
 * Languages the Eleven v3 models accept as a `language_code`. A superset of
 * `ELEVENLABS_V2_5_LANGUAGES`.
 */
export const ELEVENLABS_V3_LANGUAGES: ReadonlySet<string> = new Set([
  "af",
  "ar",
  "as",
  "az",
  "be",
  "bg",
  "bn",
  "bs",
  "ca",
  "ceb",
  "cs",
  "cy",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "fa",
  "fi",
  "fil",
  "fr",
  "ga",
  "gl",
  "gu",
  "ha",
  "he",
  "hi",
  "hr",
  "hu",
  "hy",
  "id",
  "is",
  "it",
  "ja",
  "jv",
  "ka",
  "kk",
  "kn",
  "ko",
  "ky",
  "lb",
  "ln",
  "lt",
  "lv",
  "mk",
  "ml",
  "mr",
  "ms",
  "ne",
  "nl",
  "no",
  "ny",
  "pa",
  "pl",
  "ps",
  "pt",
  "ro",
  "ru",
  "sd",
  "sk",
  "sl",
  "so",
  "sr",
  "sv",
  "sw",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "ur",
  "vi",
  "zh",
]);

/**
 * Languages the Eleven v4 models accept as a `language_code`. A superset of
 * `ELEVENLABS_V3_LANGUAGES`. This is the set the API accepts, which differs
 * from the list ElevenLabs publishes for the models.
 */
export const ELEVENLABS_V4_LANGUAGES: ReadonlySet<string> = new Set([
  ...ELEVENLABS_V3_LANGUAGES,
  "ast",
  "mi",
  "mn",
  "mt",
  "my",
  "oc",
  "or",
  "tg",
  "uz",
  "yue",
]);

/**
 * Models that accept a `language_code`, and the languages each one takes.
 * Sending a language a model doesn't cover is rejected with a 400, so the
 * language is checked against this mapping rather than only the model id.
 *
 * Models absent from the mapping take no language code at all. For
 * `eleven_multilingual_v2` that is deliberate: ElevenLabs documents
 * `language_code` as unsupported for it, and omitting the key is how its
 * auto-detection is meant to be used.
 */
export const ELEVENLABS_MODEL_LANGUAGES: Readonly<Record<string, ReadonlySet<string>>> = {
  eleven_flash_v2_5: ELEVENLABS_V2_5_LANGUAGES,
  eleven_turbo_v2_5: ELEVENLABS_V2_5_LANGUAGES,
  eleven_v3: ELEVENLABS_V3_LANGUAGES,
  eleven_v3_conversational: ELEVENLABS_V3_LANGUAGES,
  eleven_v4: ELEVENLABS_V4_LANGUAGES,
  eleven_v4_turbo: ELEVENLABS_V4_LANGUAGES,
};

/**
 * Resolve the `language_code` to send for a model.
 *
 * @param model The ElevenLabs model the request will use.
 * @param language An ElevenLabs language code, or null to send none.
 * @returns The language code to send, or null if it can't be used - either
 *   because the model takes no language code or because it doesn't cover this
 *   language. Both cases are logged.
 */
export function elevenlabsLanguageCode(
  model: string | null | undefined,
  language: string | null | undefined,
): string | null {
  if (!language) {
    return null;
  }

  const key = model || "";
  const supported = Object.hasOwn(ELEVENLABS_MODEL_LANGUAGES, key)
    ? ELEVENLABS_MODEL_LANGUAGES[key]
    : undefined;
  if (supported === undefined) {
    logger.warning(
      `Language code [${language}] not applied. Language codes can only be used with: ` +
        `${Object.keys(ELEVENLABS_MODEL_LANGUAGES).sort().join(", ")}`,
    );
    return null;
  }

  if (!supported.has(language)) {
    logger.warning(
      `Language code [${language}] not applied. ${model} supports ` +
        `${supported.size} languages, which don't include [${language}].`,
    );
    return null;
  }

  logger.debug(`Using language code: ${language}`);
  return language;
}

const LANGUAGE_MAP: Partial<Record<Language, string>> = {
  [Language.AF]: "af",
  [Language.AR]: "ar",
  [Language.AS]: "as",
  [Language.AST]: "ast",
  [Language.AZ]: "az",
  [Language.BE]: "be",
  [Language.BG]: "bg",
  [Language.BN]: "bn",
  [Language.BS]: "bs",
  [Language.CA]: "ca",
  [Language.CEB]: "ceb",
  [Language.CS]: "cs",
  [Language.CY]: "cy",
  [Language.DA]: "da",
  [Language.DE]: "de",
  [Language.EL]: "el",
  [Language.EN]: "en",
  [Language.ES]: "es",
  [Language.ET]: "et",
  [Language.FA]: "fa",
  [Language.FI]: "fi",
  [Language.FIL]: "fil",
  [Language.FR]: "fr",
  [Language.GA]: "ga",
  [Language.GL]: "gl",
  [Language.GU]: "gu",
  [Language.HA]: "ha",
  [Language.HE]: "he",
  [Language.HI]: "hi",
  [Language.HR]: "hr",
  [Language.HU]: "hu",
  [Language.HY]: "hy",
  [Language.ID]: "id",
  [Language.IS]: "is",
  [Language.IT]: "it",
  [Language.JA]: "ja",
  [Language.JV]: "jv",
  [Language.KA]: "ka",
  [Language.KK]: "kk",
  [Language.KN]: "kn",
  [Language.KO]: "ko",
  [Language.KY]: "ky",
  [Language.LB]: "lb",
  [Language.LN]: "ln",
  [Language.LT]: "lt",
  [Language.LV]: "lv",
  [Language.MI]: "mi",
  [Language.MK]: "mk",
  [Language.ML]: "ml",
  [Language.MN]: "mn",
  [Language.MR]: "mr",
  [Language.MS]: "ms",
  [Language.MT]: "mt",
  [Language.MY]: "my",
  [Language.NE]: "ne",
  [Language.NL]: "nl",
  [Language.NO]: "no",
  [Language.NY]: "ny",
  [Language.OC]: "oc",
  [Language.OR]: "or",
  [Language.PA]: "pa",
  [Language.PL]: "pl",
  [Language.PS]: "ps",
  [Language.PT]: "pt",
  [Language.RO]: "ro",
  [Language.RU]: "ru",
  [Language.SD]: "sd",
  [Language.SK]: "sk",
  [Language.SL]: "sl",
  [Language.SO]: "so",
  [Language.SR]: "sr",
  [Language.SV]: "sv",
  [Language.SW]: "sw",
  [Language.TA]: "ta",
  [Language.TE]: "te",
  [Language.TG]: "tg",
  [Language.TH]: "th",
  [Language.TR]: "tr",
  [Language.UK]: "uk",
  [Language.UR]: "ur",
  [Language.UZ]: "uz",
  [Language.VI]: "vi",
  [Language.YUE]: "yue",
  [Language.ZH]: "zh",
};

/**
 * Convert a Language value to ElevenLabs language code.
 *
 * @param language The Language value to convert.
 * @returns The corresponding service language code. If `language` is not in
 *   the verified mapping, falls back to the base language code (e.g., `en`
 *   from `en-US`) and logs a warning (via
 *   `resolveLanguage(..., useBaseCode = true)`).
 */
export function languageToElevenlabsLanguage(language: Language): string {
  return resolveLanguage(language, LANGUAGE_MAP, true);
}

/**
 * Get the appropriate output format string for a given sample rate.
 *
 * @param sampleRate The audio sample rate in Hz.
 * @returns The ElevenLabs output format string.
 */
export function outputFormatFromSampleRate(sampleRate: number): string {
  switch (sampleRate) {
    case 8000:
      return "pcm_8000";
    case 16000:
      return "pcm_16000";
    case 22050:
      return "pcm_22050";
    case 24000:
      return "pcm_24000";
    case 32000:
      return "pcm_32000";
    case 44100:
      return "pcm_44100";
    case 48000:
      return "pcm_48000";
  }
  logger.warning(`ElevenLabsTTSService: No output format available for ${sampleRate} sample rate`);
  return "pcm_24000";
}

/** Check if the given language is Chinese (including Cantonese) or Japanese. */
export function _isChineseOrJapaneseLanguage(language: string): boolean {
  const baseLang = (language.split("-")[0] ?? "").toLowerCase();
  return baseLang === "zh" || baseLang === "yue" || baseLang === "ja";
}

/** Whether timestamp text should be treated as carrying its own spacing. */
export function _wordTimestampsIncludeInterFrameSpaces(
  language: string | null | undefined,
): boolean {
  return Boolean(language && _isChineseOrJapaneseLanguage(language));
}

/**
 * Pick the alignment field to use from a TTS message, with fallback.
 *
 * ElevenLabs returns two alignment fields per chunk:
 *
 * - `normalizedKey` (`normalizedAlignment` for WebSocket,
 *   `normalized_alignment` for HTTP): the post-normalized form of what was
 *   spoken - pronunciation-dictionary substitutions, text normalization, or
 *   romanization of non-Latin scripts (e.g., Chinese rendered as pinyin).
 * - `alignmentKey` (`alignment`): the original input characters.
 *
 * Prefer `normalized` only when a pronunciation dictionary is configured -
 * that's the case where `alignment` has overlapping restarts that produce
 * duplicated/garbled words (issue #4316). Otherwise prefer `alignment` so the
 * LLM context preserves the original input rather than the normalized form.
 * Fall back to the other field if the preferred one is missing or null - the
 * API schema marks both as nullable.
 *
 * @param msg TTS response message from ElevenLabs.
 * @param options.normalizedKey Key for the normalized-alignment field on this
 *   transport.
 * @param options.alignmentKey Key for the original-alignment field on this
 *   transport.
 * @param options.preferNormalized True iff the caller is using pronunciation
 *   dictionaries.
 * @returns The chosen alignment dict, or null if both fields are absent/null.
 */
export function _selectAlignment(
  msg: Dict,
  options: { normalizedKey: string; alignmentKey: string; preferNormalized: boolean },
): Dict | null {
  const normalized = msg[options.normalizedKey];
  const alignment = msg[options.alignmentKey];
  if (options.preferNormalized) {
    return (pyTruthy(normalized) ? normalized : alignment) ?? null;
  }
  return (pyTruthy(alignment) ? alignment : normalized) ?? null;
}

/** Whether a word ends inside a bracketed audio tag, as one cut off between chunks does. */
export function _endsInAudioTag(word: string): boolean {
  return word.lastIndexOf("[") > word.lastIndexOf("]");
}

/**
 * Return alignment with utterance-leading space chars removed, if requested.
 *
 * ElevenLabs Flash normalized alignment chunks can begin with a leading space
 * at the start of an utterance. Strip only utterance-leading spaces so bot
 * turn text does not start with whitespace. On subsequent chunks, however, a
 * leading space can be a real inter-word separator (Flash models commonly
 * split sentences this way), so it must be preserved for `calculateWordTimes`
 * to flush any partial word carried over from the previous chunk.
 *
 * @param alignment Alignment dict from the API.
 * @param keys Tuple of [charsKey, startTimesKey, durationsOrEndTimesKey]
 *   naming the three parallel arrays - these differ between the WebSocket and
 *   HTTP response schemas.
 * @param shouldStrip Whether this is still utterance-leading alignment data.
 */
export function _stripUtteranceLeadingSpaces(
  alignment: Dict,
  keys: readonly [string, string, string],
  shouldStrip: boolean,
): Dict {
  const [charsKey, startsKey, tailKey] = keys;
  const chars: string[] = pyTruthy(alignment[charsKey]) ? alignment[charsKey] : [];
  if (shouldStrip && chars.length > 0 && chars[0] === " ") {
    let stripCount = 0;
    while (stripCount < chars.length && chars[stripCount] === " ") {
      stripCount += 1;
    }

    const stripped: Dict = { ...alignment };
    stripped[charsKey] = chars.slice(stripCount);
    stripped[startsKey] = (alignment[startsKey] ?? []).slice(stripCount);
    stripped[tailKey] = (alignment[tailKey] ?? []).slice(stripCount);
    return stripped;
  }
  return alignment;
}

/**
 * Calculate word timestamps from character alignment information.
 *
 * @param alignmentInfo Character alignment data from ElevenLabs API.
 * @param cumulativeTime Base time offset for this chunk.
 * @param partialWord Partial word carried over from previous chunk.
 * @param partialWordStartTime Start time of the partial word.
 * @param options.audioTags Whether a bracketed audio tag, such as `[short pause]`,
 *   is one word, spaces and all. Eleven v3 and v4 return the tags they
 *   perform in the alignment, and a tag reported whole matches the text
 *   it was sent in.
 * @returns Tuple of [wordTimes, newPartialWord, newPartialWordStartTime]:
 *   - wordTimes: List of [word, timestamp] tuples for complete words
 *   - newPartialWord: Incomplete word at end of chunk (empty if chunk ends
 *     with space)
 *   - newPartialWordStartTime: Start time of the incomplete word
 */
export function calculateWordTimes(
  alignmentInfo: Dict,
  cumulativeTime: number,
  partialWord = "",
  partialWordStartTime = 0.0,
  options: { audioTags?: boolean } = {},
): [[string, number][], string, number] {
  const audioTags = options.audioTags ?? false;
  const chars: string[] = alignmentInfo.chars;
  const charStartTimesMs: number[] = alignmentInfo.charStartTimesMs;

  if (chars.length !== charStartTimesMs.length) {
    logger.error(
      `calculate_word_times: length mismatch - chars=${chars.length}, times=${charStartTimesMs.length}`,
    );
    return [[], partialWord, partialWordStartTime];
  }

  // Build words and track their start positions
  const words: string[] = [];
  const wordStartTimes: number[] = [];
  let currentWord = partialWord; // Start with any partial word from previous chunk
  let wordStartTime: number | null = partialWord ? partialWordStartTime : null;
  let inTag = audioTags && _endsInAudioTag(currentWord);

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    if (audioTags && (char === "[" || char === "]")) {
      inTag = char === "[";
    }
    if (char === " " && !inTag) {
      // End of current word
      if (currentWord) {
        // Only add non-empty words
        words.push(currentWord);
        wordStartTimes.push(wordStartTime as number);
        currentWord = "";
        wordStartTime = null;
      }
    } else {
      // Building a word
      if (wordStartTime === null) {
        // First character of new word
        // Convert from milliseconds to seconds and add cumulative offset
        wordStartTime = cumulativeTime + charStartTimesMs[i]! / 1000.0;
      }
      currentWord += char;
    }
  }

  // Build result for complete words
  const wordTimes: [string, number][] = words.map((w, i) => [w, wordStartTimes[i]!]);

  // Return any incomplete word at the end of this chunk
  const newPartialWord = currentWord ? currentWord : "";
  const newPartialWordStartTime = wordStartTime !== null ? wordStartTime : 0.0;

  return [wordTimes, newPartialWord, newPartialWordStartTime];
}

/**
 * Wait until a websocket connection is closed (`websockets`' `wait_closed()`).
 * A cancellation point.
 */
async function waitClosed(websocket: WebsocketClientConnection): Promise<void> {
  if (websocket.state === State.CLOSED) return;
  const closed = new Future<void>();
  const onClose = (): void => {
    if (!closed.done()) closed.setResult(undefined);
  };
  const raw = websocket.webSocket;
  raw.addEventListener("close", onClose);
  try {
    if ((websocket.state as State) === State.CLOSED) onClose();
    await closed;
  } finally {
    raw.removeEventListener("close", onClose);
  }
}

export interface ElevenLabsTTSSettingsBaseOptions extends TTSSettingsOptions {}

/**
 * Settings shared by the ElevenLabs WebSocket TTS services.
 *
 * Carries the two declarative sets that `ElevenLabsTTSBase._updateSettings`
 * dispatches on. A service names the settings it can only change by
 * reconnecting, and the settings it can change by opening a fresh context.
 */
export class ElevenLabsTTSSettingsBase extends TTSSettings {
  /** Fields in the WS URL — changing any of these requires a reconnect. */
  static URL_FIELDS: ReadonlySet<string> = new Set();

  /**
   * Fields carried in a context's opening message — changing these requires
   * closing the current audio context so the next one picks them up.
   */
  static VOICE_SETTINGS_FIELDS: ReadonlySet<string> = new Set();

  constructor(options: ElevenLabsTTSSettingsBaseOptions = {}) {
    super(options);
  }
}

export interface ElevenLabsTTSBaseOptions extends WebsocketTTSServiceOptions {
  /** ElevenLabs API key for authentication. */
  apiKey: string;
  /** Base WebSocket URL for the ElevenLabs API. */
  url: string;
  /** Whether to enable ElevenLabs server-side logging. */
  enableLogging?: boolean | null;
}

/**
 * Shared behavior for the ElevenLabs multi-context WebSocket TTS services.
 *
 * Owns the WebSocket connection and its receive and keepalive tasks, the
 * settings-change dispatch, the word-timestamp clock, and the shape of a
 * synthesis request. Subclasses supply the endpoint URL and the wire protocol:
 * how text, keepalives, flushes and context closes are framed, and how server
 * messages are read.
 */
export abstract class ElevenLabsTTSBase extends WebsocketTTSService {
  static Settings: typeof ElevenLabsTTSSettingsBase = ElevenLabsTTSSettingsBase;
  declare protected _settings: ElevenLabsTTSSettingsBase;

  /** Name of the endpoint, used in connection log lines. */
  static CONNECTION_NAME = "ElevenLabs";

  static {
    installTracedTts(ElevenLabsTTSBase.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _url: string;
  protected _enableLogging: boolean | null;
  protected _outputFormat: string;
  protected _voiceSettings: Dict | null;
  protected _cumulativeTime: number;
  protected _partialWord: string;
  protected _partialWordStartTime: number;
  protected _receiveTask: Task<unknown> | null;

  /**
   * Initialize the ElevenLabs WebSocket TTS service.
   *
   * @param options.apiKey ElevenLabs API key for authentication.
   * @param options.url Base WebSocket URL for the ElevenLabs API.
   * @param options.enableLogging Whether to enable ElevenLabs server-side
   *   logging. Other options are passed to the parent service.
   */
  constructor(options: ElevenLabsTTSBaseOptions) {
    super(options);

    this._apiKey = options.apiKey;
    this._url = options.url;
    this._enableLogging = options.enableLogging ?? null;

    this._outputFormat = ""; // initialized in setup()
    this._voiceSettings = this._setVoiceSettings();

    this._cumulativeTime = 0.0;
    // Track partial words that span across alignment chunks
    this._partialWord = "";
    this._partialWordStartTime = 0.0;

    this._receiveTask = null;
  }

  /** The service's `Settings` class (`self.Settings` upstream). */
  protected get _settingsClass(): typeof ElevenLabsTTSSettingsBase {
    return (this.constructor as typeof ElevenLabsTTSBase).Settings;
  }

  /** Name of the endpoint, used in connection log lines. */
  protected get _connectionName(): string {
    return (this.constructor as typeof ElevenLabsTTSBase).CONNECTION_NAME;
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as ElevenLabs service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language value to ElevenLabs language format.
   *
   * @param language The language to convert.
   * @returns The ElevenLabs-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToElevenlabsLanguage(language);
  }

  /** Build the voice settings sent when a context opens. */
  protected abstract _setVoiceSettings(): Dict | null;

  /** Build the endpoint URL, including query parameters, for a new connection. */
  protected abstract _buildWebsocketUrl(): string;

  /** Send the message that opens a server-side context. */
  protected abstract _sendContextInit(contextId: string): Promise<void>;

  /** Send text to the WebSocket for synthesis. */
  protected abstract _sendText(text: string, contextId: string): Promise<void>;

  /** Reset the server's inactivity timer on the connection. */
  protected abstract override _sendKeepalive(): Promise<void>;

  /** Close a server-side context to free its slot. */
  protected abstract _closeContext(contextId: string): Promise<void>;

  /** Run any protocol-specific setup once the connection is open. */
  protected async _onWebsocketConnected(): Promise<void> {}

  /** Drop per-connection context bookkeeping after the socket closes. */
  protected _clearConnectionState(): void {}

  /**
   * Apply a settings delta, reconnecting as needed.
   *
   * Uses the declarative `URL_FIELDS` and `VOICE_SETTINGS_FIELDS` sets on the
   * service's `Settings` to decide whether to reconnect the WebSocket or close
   * the current audio context.
   *
   * @param delta A TTSSettings (or service-specific `Settings`) delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    const changedKeys = Object.keys(changed);
    if (changedKeys.length === 0) {
      return changed;
    }

    // Rebuild voice settings for next context
    this._voiceSettings = this._setVoiceSettings();

    const urlFields = this._settingsClass.URL_FIELDS;
    const voiceSettingsFields = this._settingsClass.VOICE_SETTINGS_FIELDS;
    const urlChangedKeys = changedKeys.filter((k) => urlFields.has(k));
    const voiceChangedKeys = changedKeys.filter((k) => voiceSettingsFields.has(k));
    const urlChanged = urlChangedKeys.length > 0;
    const voiceSettingsChanged = voiceChangedKeys.length > 0;

    if (urlChanged) {
      logger.debug(
        `URL-level setting changed ({${urlChangedKeys.map((k) => `'${k}'`).join(", ")}}), ` +
          "reconnecting WebSocket",
      );
      await this._disconnect();
      await this._connect();
    } else if (voiceSettingsChanged) {
      logger.debug(
        `Voice settings changed ({${voiceChangedKeys.map((k) => `'${k}'`).join(", ")}}), ` +
          "closing current context to apply changes",
      );
      for (const ctxId of this.getAudioContexts()) {
        await this._closeContext(ctxId);
        this._resetAlignmentState(ctxId);
      }
    }

    if (!urlChanged) {
      // Reconnect applies all settings; only warn about fields not handled
      // by voice settings or URL changes.
      this._warnUnhandledUpdatedSettings(
        changedKeys.filter((k) => !urlFields.has(k) && !voiceSettingsFields.has(k)),
      );
    }

    return changed;
  }

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._outputFormat = outputFormatFromSampleRate(this.sampleRate);
    await this._connect();
  }

  override async _connect(): Promise<void> {
    await super._connect();

    await this._connectWebsocket();

    if (this._websocket && !this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }

    if (this._websocket) {
      this._createKeepaliveTask(10);
    }
  }

  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._cancelKeepaliveTask();

    await this._disconnectWebsocket();
  }

  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug(`Connecting to ${this._connectionName}`);

      // DIVERGENCE: upstream sets a 16MB max message size for large audio
      // responses; the standard `WebSocket` has no message size limit.
      this._websocket = await this._websocketConnect(this._buildWebsocketUrl(), {
        additionalHeaders: { "xi-api-key": this._apiKey },
      });

      await this._onWebsocketConnected();

      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      await this._callEventHandler("on_connection_error", `${errorMessage(e)}`);
    }
  }

  override async _disconnectWebsocket(): Promise<void> {
    try {
      await this.stopAllMetrics();
      const websocket = this._websocket;
      if (websocket) {
        logger.debug(`Disconnecting from ${this._connectionName}`);
        // The multi-stream protocol tears down in two steps: we ask
        // ElevenLabs to close, then it closes. Wait for its close before
        // forcing ours, so we don't race the closing handshake (which
        // otherwise ends a notable fraction of sessions in a 1006 close).
        // The timeout is only a fallback ceiling; the clean close normally
        // arrives well within it.
        await websocket.send(pyJsonDumps({ close_socket: true }));
        try {
          await waitFor(() => waitClosed(websocket), 2.0);
        } catch (e) {
          if (!(e instanceof TimeoutError)) throw e;
          logger.debug("ElevenLabs did not close the WebSocket within 2.0s; closing from our side");
        }
        await websocket.close();
        logger.debug(`Disconnected from ${this._connectionName}`);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof ConnectionClosed) {
        // The server closed the connection first — normal during teardown, or
        // a race on the closing handshake. The connection is gone either way;
        // this is not a pipeline error, so don't push an ErrorFrame (which
        // would e.g. trigger a spurious ServiceSwitcherStrategyFailover switch
        // during shutdown).
        logger.debug(`${this} websocket already closed during disconnect: ${e.message}`);
      } else {
        await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      }
    } finally {
      this._websocket = null;
      this._clearConnectionState();
      await this._callEventHandler("on_disconnected");
    }
  }

  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /** Reset the running word-timestamp clock for a new context. */
  protected _resetWordClock(): void {
    this._cumulativeTime = 0.0;
    this._partialWord = "";
    this._partialWordStartTime = 0.0;
  }

  protected _resetAlignmentState(_contextId: string | null): void {
    this._resetWordClock();
  }

  /** Close the ElevenLabs context when the bot is interrupted. */
  override async onAudioContextInterrupted(contextId: string): Promise<void> {
    await this._closeContext(contextId);
    this._resetAlignmentState(contextId);
    await super.onAudioContextInterrupted(contextId);
  }

  /** Reset alignment state after all audio for the context has played. */
  override async onAudioContextCompleted(contextId: string): Promise<void> {
    this._resetAlignmentState(contextId);
    await super.onAudioContextCompleted(contextId);
  }

  /**
   * Generate speech from text using ElevenLabs' streaming WebSocket API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @yields Audio frames containing the synthesized speech.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        await this._connect();
      }

      if (this._websocket === null) {
        logger.warning(`${this}: websocket unavailable after reconnect, skipping TTS`);
        yield new ErrorFrame({ error: "websocket unavailable" });
        return;
      }

      try {
        if (!this.audioContextAvailable(contextId)) {
          await this.createAudioContext(contextId);
          await this.startTtfbMetrics();
          yield new TTSStartedFrame({ contextId });
          this._resetWordClock();

          await this._sendContextInit(contextId);
          logger.trace(`Created new context ${contextId}`);
        }

        await this._sendText(text, contextId);
        await this.startTtsUsageMetrics(text);
      } catch (e) {
        rethrowIfCancelled(e);
        yield new TTSStoppedFrame({ contextId });
        yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
        return;
      }
      yield null;
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    }
  }
}
