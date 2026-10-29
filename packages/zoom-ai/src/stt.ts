// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/zoom_ai/stt.py

/**
 * Zoom Scribe speech-to-text service.
 *
 * `ZoomAISTTService` streams audio to Scribe Live over a WebSocket. Scribe's
 * own voice activity detection ends each turn and returns its final transcript.
 *
 * Settings map to the Scribe API fields of the same name. For what each feature
 * does, and its availability, pricing and enablement, see
 * https://developers.zoom.us/docs/ai-services/scribe/ and https://www.zoom.ai/
 *
 * Porting notes:
 * - DIVERGENCE: upstream matches the `websockets` library's `InvalidStatus`
 *   exception to read Zoom's refusal reason from the handshake response body.
 *   A standard `WebSocket` exposes neither the handshake's HTTP status nor its
 *   body, so `describeRefusal()` duck-types the error instead: it finds Zoom's
 *   `message` only when the error thrown by the connect (e.g. from a custom
 *   `webSocketFactory`) carries a `response` with a JSON `body` (a string or
 *   bytes). The status is read from `status_code`, `statusCode` or `status`.
 * - `pipecat.version()` is `version()` from `@pipedog/core` (the pipedog
 *   version); the `User-Agent` keeps upstream's `pipecat/<version>` shape.
 * - `uuid.uuid4()` is the global `crypto.randomUUID()`.
 * - DIVERGENCE: an ES module export is read-only, so `SESSION_CLOSE_TIMEOUT_SECS`
 *   and `INPUT_GAP_SECS` are read through the `_sessionCloseTimeoutSecs` and
 *   `_inputGapSecs` instance fields (defaulting to them), which tests override
 *   where upstream monkeypatches the module.
 */

import {
  Event,
  monotonic,
  rethrowIfCancelled,
  sleep,
  type Task,
  TimeoutError,
  waitFor,
} from "@pipedog/asyncio";
import { version as pipecatVersion } from "@pipedog/core";
import { createStreamResampler } from "@pipedog/core/audio/utils";
import {
  type EndFrame,
  type Frame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  type STTMetadataFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import {
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { State } from "@pipedog/core/services/websocket_service";
import { isLanguage, Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

// Zoom AI websocket payloads are untyped JSON dicts in the Python source (genuinely dynamic).
type Dict = Record<string, any>;

/** Scribe Live accepts 16 kHz mono PCM16 only. */
export const SCRIBE_SAMPLE_RATE = 16000;
/** Silence that ends a Scribe Live turn, tuned for voice agents. */
export const DEFAULT_SILENCE_DURATION_MS = 350;
/** How long, in seconds, `stop()` waits for Scribe to send the last transcript and session.closed. */
export const SESSION_CLOSE_TIMEOUT_SECS = 2.0;
/**
 * When input stops mid-turn (e.g. the user muted), Scribe's VAD hears no silence and
 * the turn stays open. After this long (seconds) without input, send enough silence to end it.
 */
export const INPUT_GAP_SECS = 1.0;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

// Scribe adds speaker or channel tags to transcripts when diarization is on.
const SPEAKER_TAG = /\[(?:speaker[ _]?\d+|spk_\d+|channel\d+)\]\s*/gi;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python truthiness for JSON values: empty objects, arrays and strings, and 0, are false. */
function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Python's `f"{value}"` for the JSON scalars Scribe sends. */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

/** Python's `str.strip()` (whitespace only). */
function pyStrip(text: string): string {
  return text.trim();
}

function clean(text: string | null | undefined): string {
  return pyStrip((text || "").replace(SPEAKER_TAG, ""));
}

/** A new `x-zm-trackingid`, which Zoom support uses to find a session. */
function trackingId(): string {
  return `zoom_ai_community_pipecat_${crypto.randomUUID()}`;
}

function headers(apiKey: string, trackingIdValue: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": `pipecat/${pipecatVersion()}`,
    "x-zm-trackingid": trackingIdValue,
  };
}

/**
 * Describe Zoom refusing the handshake, if that is what failed.
 *
 * Zoom explains a refusal (a bad API key, say) in the JSON response body,
 * which the exception's own message leaves out.
 */
function describeRefusal(exception: unknown): string | null {
  const response = (exception as { response?: any } | null)?.response;
  if (!response || typeof response !== "object") {
    return null;
  }
  let reason: unknown = null;
  try {
    let body: unknown = response.body;
    if (body instanceof Uint8Array) {
      body = new TextDecoder().decode(body);
    }
    if (typeof body !== "string") {
      throw new TypeError("no body");
    }
    const parsed = pyJsonLoads(body);
    if (!isDict(parsed)) {
      throw new TypeError("not a JSON object");
    }
    reason = parsed.message;
  } catch (e) {
    // no body, or not a JSON object
    rethrowIfCancelled(e);
    reason = null;
  }
  if (pyTruthy(reason)) {
    const status = response.status_code ?? response.statusCode ?? response.status;
    return `Zoom refused the connection (HTTP ${pyStr(status)}): ${pyStr(reason)}`;
  }
  return null;
}

/** Return `url`, warning if it sends the API key and audio unencrypted to a remote host. */
function checkUrl(url: string): string {
  let scheme = "";
  let hostname: string | null = null;
  try {
    const parsed = new URL(url);
    scheme = parsed.protocol.replace(/:$/, "");
    hostname = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  } catch (e) {
    rethrowIfCancelled(e);
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
    scheme = match?.[1] ?? "";
  }
  if (scheme.toLowerCase() === "ws" && !LOOPBACK_HOSTS.includes(hostname ?? "")) {
    logger.warning(
      "Zoom Scribe url is not encrypted (ws://); the API key and audio are sent in plaintext",
    );
  }
  return url;
}

/** `base` with `extra` merged in, nested objects merged key by key; `extra` wins. */
function merge(base: Dict, extra: Dict): Dict {
  const merged: Dict = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (isDict(value) && isDict(merged[key])) {
      merged[key] = merge(merged[key], value);
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

/** What the service acts on, read from the final request (settings plus `extra`). */
class RequestView {
  readonly diarization: boolean;
  readonly textPolishing: boolean;
  readonly languageDetection: boolean;
  readonly silenceDurationMs: number | null;

  constructor(options: {
    diarization: boolean;
    textPolishing: boolean;
    languageDetection: boolean;
    silenceDurationMs: number | null;
  }) {
    this.diarization = options.diarization;
    this.textPolishing = options.textPolishing;
    this.languageDetection = options.languageDetection;
    this.silenceDurationMs = options.silenceDurationMs;
    Object.freeze(this);
  }

  static of(request: Dict): RequestView {
    const config: Dict = request.config || {};
    const polishing: Dict = request.outputs?.text_polishing || {};
    const silence: unknown = request.turn_detection?.silence_duration_ms;
    return new RequestView({
      diarization: pyTruthy(config.diarization),
      textPolishing: pyTruthy(polishing.enabled),
      languageDetection: pyTruthy(config.language_detection),
      silenceDurationMs: typeof silence === "number" && Number.isInteger(silence) ? silence : null,
    });
  }
}

/**
 * Scribe's polished text (`outputs.text_polishing.text`), or null if absent or failed.
 *
 * When polishing fails, Scribe still returns the transcription and puts a
 * `[polishing_failed: <reason>]` marker in place of the polished text.
 */
function polishedText(payload: Dict): string | null {
  const polishing: Dict = payload.outputs?.text_polishing || {};
  const text: unknown = polishing.text;
  if (typeof text !== "string" || text.trimStart().startsWith("[polishing_failed")) {
    return null;
  }
  return clean(text);
}

/**
 * The frame language: Scribe's, else null when detecting, else the configured one.
 *
 * With language detection on and no language from Scribe, the language isn't known, so
 * it is left out rather than guessed.
 */
function reportedLanguage(
  scribeLanguage: unknown,
  detecting: boolean,
  configured: unknown,
): Language | null {
  if (typeof scribeLanguage === "string" && scribeLanguage) {
    return frameLanguage(scribeLanguage);
  }
  return detecting ? null : frameLanguage(configured);
}

/** Convert a stored Scribe locale back to a Language for transcription frames. */
function frameLanguage(value: unknown): Language | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  return isLanguage(value) ? value : null;
}

const LANGUAGE_MAP: Partial<Record<Language, string>> = {
  // zoom-scribe-multilingual (and whisper)
  [Language.AR]: "ar-SA",
  [Language.AR_AE]: "ar-AE",
  [Language.AR_SA]: "ar-SA",
  [Language.DE]: "de-DE",
  [Language.DE_DE]: "de-DE",
  [Language.EN]: "en-US",
  [Language.EN_US]: "en-US",
  [Language.ES]: "es-ES",
  [Language.ES_ES]: "es-ES",
  [Language.FR]: "fr-FR",
  [Language.FR_FR]: "fr-FR",
  [Language.IT]: "it-IT",
  [Language.IT_IT]: "it-IT",
  [Language.JA]: "ja-JP",
  [Language.JA_JP]: "ja-JP",
  [Language.KO]: "ko-KR",
  [Language.KO_KR]: "ko-KR",
  [Language.PT]: "pt-BR",
  [Language.PT_BR]: "pt-BR",
  [Language.PT_PT]: "pt-PT",
  [Language.ZH]: "zh-CN",
  [Language.ZH_CN]: "zh-CN",
  // whisper only
  [Language.BN]: "bn-IN",
  [Language.BN_IN]: "bn-IN",
  [Language.CA]: "ca-ES",
  [Language.CA_ES]: "ca-ES",
  [Language.CS]: "cs-CZ",
  [Language.CS_CZ]: "cs-CZ",
  [Language.DA]: "da-DK",
  [Language.DA_DK]: "da-DK",
  [Language.EL]: "el-GR",
  [Language.EL_GR]: "el-GR",
  [Language.ET]: "et-EE",
  [Language.ET_EE]: "et-EE",
  [Language.FA]: "fa-IR",
  [Language.FA_IR]: "fa-IR",
  [Language.FI]: "fi-FI",
  [Language.FI_FI]: "fi-FI",
  [Language.FIL]: "tl-PH",
  [Language.FIL_PH]: "tl-PH",
  [Language.HE]: "he-IL",
  [Language.HE_IL]: "he-IL",
  [Language.HI]: "hi-IN",
  [Language.HI_IN]: "hi-IN",
  [Language.HU]: "hu-HU",
  [Language.HU_HU]: "hu-HU",
  [Language.ID]: "id-ID",
  [Language.ID_ID]: "id-ID",
  [Language.MS]: "ms-MY",
  [Language.MS_MY]: "ms-MY",
  [Language.NL]: "nl-NL",
  [Language.NL_NL]: "nl-NL",
  [Language.PL]: "pl-PL",
  [Language.PL_PL]: "pl-PL",
  [Language.RO]: "ro-RO",
  [Language.RO_RO]: "ro-RO",
  [Language.RU]: "ru-RU",
  [Language.RU_RU]: "ru-RU",
  [Language.SV]: "sv-SE",
  [Language.SV_SE]: "sv-SE",
  [Language.TA]: "ta-IN",
  [Language.TA_IN]: "ta-IN",
  [Language.TE]: "te-IN",
  [Language.TE_IN]: "te-IN",
  [Language.TH]: "th-TH",
  [Language.TH_TH]: "th-TH",
  [Language.TL]: "tl-PH",
  [Language.TR]: "tr-TR",
  [Language.TR_TR]: "tr-TR",
  [Language.UK]: "uk-UA",
  [Language.UK_UA]: "uk-UA",
  [Language.VI]: "vi-VN",
  [Language.VI_VN]: "vi-VN",
  [Language.YUE]: "zh-HK",
  [Language.ZH_HK]: "zh-HK",
};

/**
 * Convert a Language to a Scribe locale, e.g. `Language.EN` to `"en-US"`.
 *
 * A regional variant Scribe doesn't list resolves to the locale of its base
 * language, e.g. `Language.EN_GB` to `"en-US"`. For the supported
 * languages of each model, see
 * https://developers.zoom.us/docs/ai-services/scribe/speech-understanding/
 *
 * @param language The language to convert.
 * @returns The Scribe locale.
 */
export function languageToZoomAiLanguage(language: Language): string {
  return resolveLanguage(language, LANGUAGE_MAP, true);
}

export interface ZoomAISTTSettingsOptions extends STTSettingsOptions {
  silenceDurationMs?: number | null | NotGiven;
  diarization?: boolean | null | NotGiven;
  languageDetection?: string | null | NotGiven;
  vocabulary?: string[] | null | NotGiven;
  textPolishing?: boolean | null | NotGiven;
}

/**
 * Settings for `ZoomAISTTService`.
 *
 * Changing a setting reconnects with a new Scribe session.
 *
 * - `silenceDurationMs`: Milliseconds of silence that end a turn in Scribe's
 *   voice activity detection. Defaults to 350, tuned for voice agents;
 *   lower is faster, higher keeps sentences with longer pauses together.
 *   For transcription without an agent, a longer value such as 600 can
 *   improve accuracy. `null` uses Scribe's default (see the Scribe docs).
 * - `diarization`: Whether Scribe labels each completed transcript with a
 *   speaker. Off by default. The labels are in the Scribe event attached
 *   as `TranscriptionFrame.result`: `speaker`, plus `speaker_segments`
 *   with each one's span when several speakers spoke. Scribe's speaker
 *   tags are removed from the transcript text.
 * - `languageDetection`: Scribe language detection mode
 *   (`config.language_detection.mode`). `null` turns it off. A
 *   detected language Scribe reports is in `TranscriptionFrame.language`;
 *   when Scribe reports none, it is `null`.
 * - `vocabulary`: Words and phrases that customize recognition
 *   (`config.vocabulary.phrases`).
 * - `textPolishing`: Scribe's text polishing (`outputs.text_polishing`).
 *   The polished text is the transcript, and the recognized text is in
 *   the Scribe event attached as `TranscriptionFrame.result`
 *   (`transcript`); if polishing fails, the recognized text is used.
 *   Off by default.
 *
 * `extra` holds Scribe request fields this class has no setting for, shaped
 * like the request (e.g. `{ config: { profanity_filter: true } }`). It is
 * merged into the `session.update` over the settings above, except that
 * `audio.format` stays `pcm16`.
 */
export class ZoomAISTTSettings extends STTSettings {
  silenceDurationMs: number | null | NotGiven = NOT_GIVEN;
  diarization: boolean | null | NotGiven = NOT_GIVEN;
  languageDetection: string | null | NotGiven = NOT_GIVEN;
  vocabulary: string[] | null | NotGiven = NOT_GIVEN;
  textPolishing: boolean | null | NotGiven = NOT_GIVEN;

  constructor(options: ZoomAISTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface ZoomAISTTServiceOptions extends WebsocketSTTServiceOptions {
  /**
   * Zoom AI Services API key or JWT. It is sent on every request and
   * reconnect, so it must stay valid for as long as the service runs.
   */
  apiKey: string;
  /**
   * Scribe Live WebSocket URL. A plaintext `ws://` URL to a host other than
   * localhost logs a warning.
   */
  url?: string;
  /** Input audio sample rate. Audio is resampled to 16 kHz. */
  sampleRate?: number | null;
  /** Whether a user turn started by Scribe interrupts the bot. Defaults to true. */
  shouldInterrupt?: boolean;
  /** Runtime-updatable settings. */
  settings?: ZoomAISTTSettings | null;
}

/**
 * Zoom Scribe Live streaming speech-to-text service.
 *
 * Streams 16 kHz PCM16 audio to Scribe Live over a WebSocket. Scribe's own
 * voice activity detection decides when the user starts and stops speaking:
 * its `speech_started` event broadcasts a `ProposedUserStartedSpeakingFrame`,
 * and each completed transcript is pushed as a `TranscriptionFrame` followed
 * by a `ProposedUserStoppedSpeakingFrame`. `serviceMetadataFrame()`
 * recommends `ExternalUserTurnStrategies` so the user aggregator resolves
 * those proposals instead of running local VAD. The service pushes final
 * transcripts only. A transcript that arrives without a preceding
 * `speech_started` (for example right after a reconnect) opens its own turn,
 * so it is never dropped; a turn whose transcript comes back empty ends with
 * no transcription.
 *
 * @example
 * const stt = new ZoomAISTTService({
 *   apiKey: process.env.ZOOM_AI_API_KEY!,
 *   settings: new ZoomAISTTService.Settings({ language: Language.EN_US }),
 * });
 */
export class ZoomAISTTService extends WebsocketSTTService {
  static Settings: typeof ZoomAISTTSettings = ZoomAISTTSettings;
  declare protected _settings: ZoomAISTTSettings;

  static {
    installTracedStt(ZoomAISTTService.prototype, "_handleTranscription");
  }

  protected _apiKey: string;
  protected _url: string;
  protected _shouldInterrupt: boolean;
  protected _resampler = createStreamResampler();
  protected _userTurnOpen = false;
  protected _receiveTask: Task<unknown> | null = null;
  protected _sessionClosed = new Event();
  /** Scribe accepted this session's settings. */
  protected _sessionUpdated = false;
  /** The current session's x-zm-trackingid. */
  protected _trackingId: string | null = null;
  protected _inputGapTask: Task<unknown> | null = null;
  protected _lastInputTime = monotonic();
  /** Silence already sent for the current input gap. */
  protected _gapFilled = false;
  /** What the current session was configured with (settings plus `extra`). */
  protected _view: RequestView;
  /** `SESSION_CLOSE_TIMEOUT_SECS`, overridable per instance. */
  protected _sessionCloseTimeoutSecs = SESSION_CLOSE_TIMEOUT_SECS;
  /** `INPUT_GAP_SECS`, overridable per instance. */
  protected _inputGapSecs = INPUT_GAP_SECS;

  /**
   * Initialize the Zoom Scribe Live STT service.
   *
   * @param options.apiKey Zoom AI Services API key or JWT. It is sent on every
   *   request and reconnect, so it must stay valid for as long as the service runs.
   * @param options.url Scribe Live WebSocket URL. A plaintext `ws://` URL to a
   *   host other than localhost logs a warning.
   * @param options.sampleRate Input audio sample rate. Audio is resampled to 16 kHz.
   * @param options.shouldInterrupt Whether a user turn started by Scribe
   *   interrupts the bot.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent WebsocketSTTService.
   */
  constructor(options: ZoomAISTTServiceOptions) {
    const cls = new.target as typeof ZoomAISTTService;
    const defaultSettings = new cls.Settings({
      model: null,
      language: Language.EN_US,
      silenceDurationMs: DEFAULT_SILENCE_DURATION_MS,
      diarization: false,
      languageDetection: null,
      vocabulary: null,
      textPolishing: false,
    });
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      // Scribe ends a session after 30 seconds without audio.
      keepaliveTimeout: 10,
      keepaliveInterval: 5,
      settings: defaultSettings,
    });
    this._apiKey = options.apiKey;
    this._url = checkUrl(options.url ?? "wss://api.zoom.us/v2/aiservices/scribe/live");
    this._shouldInterrupt = options.shouldInterrupt ?? true;
    this._view = RequestView.of(this._sessionUpdate());
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as this service supports metrics.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language to a Scribe locale.
   *
   * @param language The language to convert.
   * @returns The Scribe locale. Regional variants Scribe doesn't list resolve
   *   to the locale of their base language.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToZoomAiLanguage(language);
  }

  /** Scribe defines the turn boundary, so there is no TTFS to report. */
  override get supportsTtfs(): boolean {
    return false;
  }

  /**
   * Recommend external turn strategies, since Scribe detects the turns.
   *
   * @returns The STT metadata frame.
   */
  override serviceMetadataFrame(): STTMetadataFrame {
    const frame = super.serviceMetadataFrame();
    frame.userTurnStrategies = new ExternalUserTurnStrategies({
      enableInterruptions: this._shouldInterrupt,
    });
    return frame;
  }

  /** Apply a settings delta and reconnect so the new session config takes effect. */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if (Object.keys(changed).length > 0) {
      await this._requestReconnect();
    }
    return changed;
  }

  /**
   * Set up the service and connect to Scribe Live.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._connect();
  }

  /**
   * Close the Scribe session, then stop the service.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    // Scribe answers session.close by closing the socket; mark the shutdown first so
    // the receive loop doesn't treat that as a dropped connection and reconnect.
    this._disconnecting = true;
    if (this._websocket && this._websocket.state === State.OPEN) {
      await this._sendJson({ type: "session.close" });
      // As the Live docs describe: keep reading until Scribe sends the remaining
      // final transcript and session.closed, so the last utterance isn't lost.
      try {
        await waitFor(() => this._sessionClosed.wait(), this._sessionCloseTimeoutSecs);
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        logger.debug(`${this} Scribe did not confirm session.close; closing`);
      }
    }
    await super.stop(frame);
  }

  /**
   * Send audio to Scribe Live.
   *
   * Transcriptions are pushed from the receive task, not yielded here.
   *
   * @param audio Raw PCM16 mono audio at the pipeline sample rate.
   * @returns An async generator yielding null.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    this._lastInputTime = monotonic();
    this._gapFilled = false;
    await this._sendAudio(audio);
    yield null;
  }

  /** Send keepalive silence at Scribe's sample rate. */
  protected override async _sendKeepalive(silence: Uint8Array): Promise<void> {
    await this._sendAudio(silence);
    // Keepalive silence is real audio submitted to the service, so it
    // counts toward usage.
    this._recordSttAudioUsage(silence);
  }

  /**
   * End a Scribe turn that input stopped in the middle of (e.g. the user muted).
   *
   * Scribe's VAD ends a turn after `silence_duration_ms` of silence, but no audio is
   * not silence. Once input has stopped for `INPUT_GAP_SECS` with a turn open, send
   * that much silence (plus 100 ms), once per gap.
   */
  protected async _inputGapHandler(): Promise<void> {
    while (true) {
      await sleep(this._inputGapSecs / 2);
      if (
        !this._userTurnOpen ||
        this._gapFilled ||
        monotonic() - this._lastInputTime < this._inputGapSecs
      ) {
        continue;
      }
      this._gapFilled = true;
      const windowMs = this._view.silenceDurationMs || 1000;
      const silence = new Uint8Array(Math.floor((this.sampleRate * (windowMs + 100)) / 1000) * 2);
      await this._sendAudio(silence);
      // Gap silence is real audio submitted to the service, so it counts toward usage.
      this._recordSttAudioUsage(silence);
    }
  }

  /** Send pipeline-rate audio to Scribe, resampled to 16 kHz. */
  protected async _sendAudio(audio: Uint8Array): Promise<void> {
    let data = audio;
    if (this.sampleRate !== SCRIBE_SAMPLE_RATE) {
      data = await this._resampler.resample(data, this.sampleRate, SCRIBE_SAMPLE_RATE);
    }
    if (data.length > 0 && this._websocket && this._websocket.state === State.OPEN) {
      try {
        await this._websocket.send(data);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this} failed to send audio: ${errorText(e)}`);
      }
    }
  }

  protected async _sendJson(message: Dict): Promise<void> {
    if (this._websocket && this._websocket.state === State.OPEN) {
      try {
        await this._websocket.send(pyJsonDumps(message));
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this} failed to send ${pyStr(message.type)}: ${errorText(e)}`);
      }
    }
  }

  protected _sessionUpdate(): Dict {
    const settings = this._settings;
    let update: Dict = {
      type: "session.update",
      language: (settings.language as string | null) || "en-US",
      audio: { format: "pcm16" },
    };
    const config: Dict = {};
    if (settings.model) {
      config.model = settings.model;
    }
    if (settings.languageDetection) {
      config.language_detection = { mode: settings.languageDetection };
    }
    if (settings.diarization) {
      config.diarization = true;
    }
    if (Array.isArray(settings.vocabulary) && settings.vocabulary.length > 0) {
      config.vocabulary = { phrases: [...settings.vocabulary] };
    }
    if (Object.keys(config).length > 0) {
      update.config = config;
    }
    if (settings.silenceDurationMs !== null) {
      update.turn_detection = { silence_duration_ms: settings.silenceDurationMs };
    }
    if (settings.textPolishing) {
      update.outputs = { text_polishing: { enabled: true } };
    }
    update = merge(update, settings.extra);
    // Fields the service depends on, whatever `extra` says.
    update.type = "session.update";
    update.audio = { ...(isDict(update.audio) ? update.audio : {}), format: "pcm16" };
    const polishing: unknown = isDict(update.outputs) ? update.outputs.text_polishing : undefined;
    if (isDict(polishing) && pyTruthy(polishing.enabled)) {
      // Live returns only the polished text unless the transcript is asked for too,
      // and the transcript is the fallback when polishing fails.
      polishing.include_transcript = true;
    }
    return update;
  }

  override async _connect(): Promise<void> {
    await super._connect();
    await this._connectWebsocket();
    // Started even when the connection failed: with no socket the receive
    // loop goes straight to its reconnect path, which retries the connect.
    if (!this._receiveTask) {
      this._receiveTask = this.createTask(
        () => this._receiveTaskHandler((error, options) => this._reportError(error, options)),
        "receive",
      );
    }
    if (!this._inputGapTask) {
      this._inputGapTask = this.createTask(() => this._inputGapHandler(), "input_gap");
    }
  }

  override async _disconnect(): Promise<void> {
    await super._disconnect();
    if (this._inputGapTask) {
      await this.cancelTask(this._inputGapTask);
      this._inputGapTask = null;
    }
    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }
    await this._disconnectWebsocket();
  }

  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }
      this._trackingId = trackingId();
      logger.debug(`Connecting to Zoom Scribe Live (tracking_id=${this._trackingId})`);
      const websocket = await this._websocketConnect(this._url, {
        subprotocols: ["live-asr"],
        additionalHeaders: headers(this._apiKey, this._trackingId),
      });
      this._websocket = websocket;
      this._sessionClosed.clear();
      this._sessionUpdated = false;
      const update = this._sessionUpdate();
      this._view = RequestView.of(update);
      await websocket.send(pyJsonDumps(update));
      logger.info(`${this} connected to Zoom Scribe Live (tracking_id=${this._trackingId})`);
      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      const refusal = describeRefusal(e);
      await this.pushError(refusal || `Unable to connect to Zoom Scribe Live: ${errorText(e)}`, {
        exception: e,
      });
      await this._callEventHandler("on_connection_error", refusal || errorText(e));
    }
  }

  override async _disconnectWebsocket(): Promise<void> {
    if (!this._websocket) {
      return;
    }
    try {
      logger.debug("Disconnecting from Zoom Scribe Live");
      await this._websocket.close();
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`${this} error closing websocket: ${errorText(e)}`);
    } finally {
      this._websocket = null;
      this._canReconnect = true;
      await this._endOpenTurn();
      await this._callEventHandler("on_disconnected");
    }
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | null = null,
  ): Promise<void> {}

  override async _receiveMessages(): Promise<void> {
    if (!this._websocket) {
      return;
    }
    for await (const message of this._websocket) {
      if (typeof message !== "string") {
        continue;
      }
      let event: unknown;
      try {
        event = pyJsonLoads(message);
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        logger.warning(`${this} ignoring a non-JSON message`);
        continue;
      }
      if (isDict(event)) {
        await this._handleEvent(event);
      }
    }
  }

  protected async _handleEvent(event: Dict): Promise<void> {
    const kind = event.type;
    if (kind === "input_audio_buffer.speech_started") {
      // Hold settings-change reconnects until the turn ends, even without a local VAD.
      this._canReconnect = false;
      if (!this._userTurnOpen) {
        this._userTurnOpen = true;
        await this.broadcastFrame(ProposedUserStartedSpeakingFrame);
      }
    } else if (kind === "transcription.completed") {
      await this._pushFinalTranscript(event);
    } else if (kind === "session.updated") {
      this._sessionUpdated = true;
      // Scribe never rejects diarization; it reports whether labels will come.
      if (this._view.diarization && event.diarization_enabled === false) {
        logger.warning(`${this} Scribe can't label speakers for this session`);
      }
    } else if (kind === "error") {
      const error = event.error;
      await this._handleErrorEvent(isDict(error) ? error : {});
    } else if (kind === "session.closed") {
      logger.debug(`${this} session closed: ${pyStr(event.reason)}`);
      this._sessionClosed.set();
    }
  }

  protected async _handleErrorEvent(error: Dict): Promise<void> {
    const message =
      `Zoom Scribe Live error ${pyStr(error.code)}: ${pyStr(error.message)} ` +
      `(tracking_id=${pyStr(this._trackingId)})`;
    if (pyTruthy(error.fatal) && !this._sessionUpdated) {
      // Scribe rejects a session's settings with a fatal error in place of
      // session.updated, then closes; a new session would be rejected the same way.
      await this.pushError(message, { category: ErrorCategory.INVALID_REQUEST });
    } else {
      await this.pushError(message);
    }
  }

  protected async _pushFinalTranscript(event: Dict): Promise<void> {
    let text = clean(event.transcript);
    if (this._view.textPolishing) {
      const polished = polishedText(event);
      if (polished !== null) {
        text = polished;
      }
    }
    if (text) {
      if (!this._userTurnOpen) {
        // No speech_started for this transcript (e.g. it was lost in a
        // reconnect): open the turn so the aggregator doesn't drop it.
        this._userTurnOpen = true;
        await this.broadcastFrame(ProposedUserStartedSpeakingFrame);
      }
      const language = reportedLanguage(
        event.language,
        this._view.languageDetection,
        this._settings.language,
      );
      await this.emitSttUsageMetrics();
      await this.pushFrame(
        new TranscriptionFrame({
          text,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          language,
          result: event,
          finalized: true,
        }),
      );
      await this._handleTranscription(text, true, language);
    }
    await this._endOpenTurn();
    // Scribe's turn is over: apply a settings change held since speech_started. In its
    // own task, because the reconnect cancels the receive task this runs in.
    this._canReconnect = true;
    if (this._needReconnect) {
      this.createTask(() => this._reconnect(), "settings_reconnect");
    }
  }

  protected async _endOpenTurn(): Promise<void> {
    if (this._userTurnOpen) {
      this._userTurnOpen = false;
      await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
    }
  }
}
