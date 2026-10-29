// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/speechify/tts.py

/**
 * Speechify Text-to-Speech Service Implementation.
 *
 * Contains SpeechifyHttpTTSService, which streams audio and word-level speech marks
 * from Speechify's `/v1/audio/stream/with-timestamps` endpoint over Server-Sent Events.
 *
 * Porting notes:
 * - The HTTP request goes through `fetch`. Upstream's required `aiohttp_session` becomes
 *   an optional `fetch` function (defaults to the global `fetch`).
 * - Speech-mark offsets are Python string indexes, so the accumulator indexes the text by
 *   code point, not by UTF-16 unit, to keep them meaning the same characters.
 */

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import { version as pipecatVersion } from "@pipedog/core";
import {
  ErrorFrame,
  type Frame,
  InterruptionFrame,
  TTSAudioRawFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import { FrameDirection, type FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Identifies the integration to Speechify's platform attribution. Speechify-Caller
// and its companion Speechify-Caller-Version are the standard attribution pair
// Speechify reads uniformly across every integration.
export const CALLER_HEADERS = {
  "Speechify-Caller": "pipecat",
  "Speechify-Caller-Version": pipecatVersion(),
};

// Pinned so behavior doesn't depend on the workspace default; `pcm_16000` is 16 kHz from here on.
export const SPEECHIFY_API_VERSION = "2026-09-30";

// PCM rates Speechify can synthesize, as the `pcm_<rate>` output formats.
export const SPEECHIFY_PCM_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000];

export const SPEECHIFY_DEFAULT_SAMPLE_RATE = 24000;

/**
 * Convert a Language enum to a Speechify language tag.
 *
 * @param language The Language enum value to convert.
 * @returns The corresponding Speechify language tag (e.g. `"en-US"`). Languages outside
 *   the officially supported set fall back to their BCP-47 value with a warning.
 */
export function languageToSpeechifyLanguage(language: Language): string | null {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.DE]: "de-DE",
    [Language.EN]: "en-US",
    [Language.ES]: "es-ES",
    [Language.FR]: "fr-FR",
    [Language.IT]: "it-IT",
    [Language.PT]: "pt-BR",
  };
  return resolveLanguage(language, LANGUAGE_MAP, false);
}

/**
 * Pick the Speechify PCM output format for a sample rate.
 *
 * @param sampleRate The desired audio sample rate in Hz.
 * @returns `[outputFormat, sampleRate]`, where the returned sample rate is the one
 *   Speechify will actually synthesize at. It differs from the requested rate when
 *   Speechify has no matching PCM format (e.g. 32000 Hz), so callers must stamp the
 *   returned rate onto their audio frames and let the output transport resample.
 */
export function _outputFormatFromSampleRate(sampleRate: number): [string, number] {
  if (SPEECHIFY_PCM_SAMPLE_RATES.includes(sampleRate)) {
    return [`pcm_${sampleRate}`, sampleRate];
  }
  logger.warning(
    `Speechify has no PCM output format for ${sampleRate} Hz, ` +
      `synthesizing at ${SPEECHIFY_DEFAULT_SAMPLE_RATE} Hz instead`,
  );
  return [`pcm_${SPEECHIFY_DEFAULT_SAMPLE_RATE}`, SPEECHIFY_DEFAULT_SAMPLE_RATE];
}

/**
 * Python's `mark.get(key, default)`: the default only applies to a missing key.
 *
 * Returns `any` on purpose: speech marks are untyped server JSON (a plain dict in
 * Python), and callers check the value's runtime type themselves.
 */
function get(mark: Dict, key: string, fallback: unknown): any {
  return Object.hasOwn(mark, key) ? mark[key] : fallback;
}

/**
 * Return a mark's character span within the synthesized text, if it has one.
 *
 * `start` and `end` are offsets into the request's `input`. They are the
 * authority on a mark's text: a mark's `value` is the word as Speechify
 * pronounced it, which sometimes normalizes characters (typographic apostrophes
 * become ASCII, for instance), and downstream word tracking matches words against
 * the text that was sent, where a normalized word derails the match for the rest
 * of the sentence.
 *
 * @param textLength The text's length in code points.
 */
function _markSpan(mark: Dict, textLength: number): [number, number] | null {
  const start = get(mark, "start", null);
  const end = get(mark, "end", null);
  if (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    0 <= start &&
    start < end &&
    end <= textLength
  ) {
    return [start, end];
  }
  return null;
}

// Python's whitespace set (`str.isspace()` / `str.strip()`), which differs from JS `\s`:
// it includes \x1c-\x1f and \x85, and excludes \ufeff.
const PY_WS =
  "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_SPACE_RE = new RegExp(`^[${PY_WS}]+$`, "u");
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "gu");

/** Python's `str.isspace()` for one character. */
function isSpace(char: string): boolean {
  return PY_SPACE_RE.test(char);
}

/** Python's `str.strip()` with no arguments. */
function pyStrip(text: string): string {
  return text.replace(PY_STRIP_RE, "");
}

/**
 * Assembles a request's speech marks into whole words.
 *
 * Speechify marks intra-word punctuation separately, and the resulting run of marks
 * can straddle the boundary between two `speech.chunk` events. Marks that abut in
 * the source text (the next starting exactly where the previous ended) are joined
 * into one word. A word is released as soon as the text shows it cannot continue
 * (the next character is whitespace, or the text ends), which is every word not
 * split this way.
 *
 * Example marks for "text-to-speech is well-known.", split across two events:
 *
 *     event 1: "text"  "-"  "to"  "-"
 *     event 2: "speech"  "is"  "well"  "-"  "known."
 *
 * Which are assembled into:
 *
 *     ["text-to-speech", "is", "well-known."]
 */
export class _SpeechMarkAccumulator {
  // The text as code points: marks index into it the way Python indexes a str.
  #text: string[];
  #timeOffset: number;
  #pending: [number, number, number] | null = null;
  /** The last mark's end, in seconds and without the offset applied. */
  endTime = 0.0;

  /**
   * @param text The text sent for synthesis, which the marks index into.
   * @param timeOffset Seconds to add to each word, carrying over the duration of
   *   the utterances already synthesized in this turn.
   */
  constructor(text: string, timeOffset = 0.0) {
    this.#text = Array.from(text);
    this.#timeOffset = timeOffset;
  }

  /**
   * Add one event's speech marks.
   *
   * @param speechMarks The `speech_marks` payload from a `speech.chunk` event,
   *   absent on an audio-only event.
   * @returns The `[word, seconds]` pairs completed by these marks.
   */
  add(speechMarks: Dict[] | null | undefined): [string, number][] {
    const wordTimes: [string, number][] = [];

    for (const mark of speechMarks ?? []) {
      // The stream carries word marks; skip any other type Speechify may add.
      if (get(mark, "type", "word") !== "word") {
        continue;
      }

      this.endTime = Math.max(this.endTime, get(mark, "end_time", 0) / 1000);
      const startTime = this.#timeOffset + get(mark, "start_time", 0) / 1000;

      const span = _markSpan(mark, this.#text.length);
      if (span === null) {
        wordTimes.push(...this.flush());
        const value = pyStrip(String(get(mark, "value", "")));
        if (value) {
          wordTimes.push([value, startTime]);
        }
        continue;
      }

      const [start, end] = span;
      if (this.#pending && this.#pending[1] === start) {
        this.#pending = [this.#pending[0], end, this.#pending[2]];
      } else {
        wordTimes.push(...this.flush());
        this.#pending = [start, end, startTime];
      }

      if (end >= this.#text.length || isSpace(this.#text[end]!)) {
        wordTimes.push(...this.flush());
      }
    }

    return wordTimes;
  }

  /** Release the word still being assembled, if any. */
  flush(): [string, number][] {
    if (this.#pending === null) {
      return [];
    }
    const [start, end, startTime] = this.#pending;
    this.#pending = null;
    const word = pyStrip(this.#text.slice(start, end).join(""));
    return word ? [[word, startTime]] : [];
  }
}

/** Python's `str.splitlines()`. */
function splitLines(text: string): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the separators Python's splitlines() uses.
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Parse one Server-Sent Events block into its event name and decoded data.
 *
 * @param block The block's lines, newline-joined and without the terminating blank line.
 * @returns `[eventName, data]`, or null if the block carries no decodable data.
 */
export function _parseSseEvent(block: string): [string, Dict] | null {
  let eventName = "";
  const dataLines: string[] = [];

  for (const line of splitLines(block)) {
    const colon = line.indexOf(":");
    const fieldName = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (!fieldName) {
      // Comment line.
      continue;
    }
    if (value.startsWith(" ")) value = value.slice(1);
    if (fieldName === "event") {
      eventName = value;
    } else if (fieldName === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  try {
    return [eventName, pyJsonLoads(dataLines.join("\n")) as Dict];
  } catch (e) {
    rethrowIfCancelled(e);
    if (e instanceof SyntaxError) {
      logger.warning(`Failed to parse Speechify SSE event: ${e.message}`);
      return null;
    }
    throw e;
  }
}

/** Yield a response body's lines (aiohttp's `async for line in response.content`). */
async function* iterLines(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<string, void, unknown> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending: Uint8Array = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await abortable(reader.read());
      if (done) break;
      if (!value || value.length === 0) continue;
      const joined = new Uint8Array(pending.length + value.length);
      joined.set(pending);
      joined.set(value, pending.length);
      let from = 0;
      let newline = joined.indexOf(0x0a, from);
      while (newline !== -1) {
        yield decoder.decode(joined.subarray(from, newline + 1));
        from = newline + 1;
        newline = joined.indexOf(0x0a, from);
      }
      pending = joined.slice(from);
    }
    if (pending.length > 0) {
      yield decoder.decode(pending);
    }
  } finally {
    try {
      await reader.cancel();
    } catch (e) {
      rethrowIfCancelled(e);
    }
  }
}

/** Yield `[eventName, data]` for each Server-Sent Events block in a response. */
export async function* _iterSseEvents(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<[string, Dict], void, unknown> {
  const block: string[] = [];

  for await (const rawLine of iterLines(body)) {
    const line = rawLine.replace(/[\r\n]+$/, "");
    if (line) {
      block.push(line);
      continue;
    }
    if (block.length > 0) {
      const event = _parseSseEvent(block.join("\n"));
      block.length = 0;
      if (event) {
        yield event;
      }
    }
  }

  if (block.length > 0) {
    const event = _parseSseEvent(block.join("\n"));
    if (event) {
      yield event;
    }
  }
}

export interface SpeechifyTTSSettingsOptions extends TTSSettingsOptions {
  /** Whether to normalize audio loudness to a standard level. Adds latency. */
  loudnessNormalization?: boolean | null | NotGiven;
  /** Whether to spell out numbers, dates and similar tokens before synthesis. Adds latency. */
  textNormalization?: boolean | null | NotGiven;
  /**
   * Stable, opaque identifier for the end user a request is synthesized for, so
   * Speechify can rate-limit or block that user instead of the whole workspace.
   * 1 to 64 characters of letters, digits and `. _ - : | + / =`: a keyed hash of an
   * internal user id, never personal data such as an email address, which Speechify
   * rejects.
   */
  safetyIdentifier?: string | null | NotGiven;
  /**
   * How specific words in the text should be spoken, up to 200 entries. Each entry
   * gives the `text` to match and exactly one of `ipa` (phones from the model's set,
   * for a single word) or `alias` (replacement text), plus an optional
   * `case_sensitive`:
   *
   * ```ts
   * [{ text: "Pipecat", ipa: "p ˈaɪ p k æ t" },
   *  { text: "TTS", alias: "text to speech" }]
   * ```
   *
   * Speechify applies these on `simba-3.5` in every language it lists under
   * `pronunciation_languages` in `GET /v1/audio/models`, which excludes English; any
   * other model or language returns `pronunciations_unsupported`.
   */
  pronunciations?: Dict[] | null | NotGiven;
}

/**
 * Settings for SpeechifyHttpTTSService.
 *
 * - `loudnessNormalization`: whether to normalize audio loudness to a standard level.
 *   Adds latency.
 * - `textNormalization`: whether to spell out numbers, dates and similar tokens
 *   before synthesis. Adds latency.
 * - `safetyIdentifier`: stable, opaque identifier for the end user a request is
 *   synthesized for, so Speechify can rate-limit or block that user instead of
 *   the whole workspace. 1 to 64 characters of letters, digits and
 *   `. _ - : | + / =`: a keyed hash of an internal user id, never personal
 *   data such as an email address, which Speechify rejects.
 * - `pronunciations`: how specific words in the text should be spoken, up to 200
 *   entries. Each entry gives the `text` to match and exactly one of `ipa`
 *   (phones from the model's set, for a single word) or `alias` (replacement
 *   text), plus an optional `case_sensitive`:
 *
 *   ```ts
 *   [{ text: "Pipecat", ipa: "p ˈaɪ p k æ t" },
 *    { text: "TTS", alias: "text to speech" }]
 *   ```
 *
 *   Speechify applies these on `simba-3.5` in every language it lists under
 *   `pronunciation_languages` in `GET /v1/audio/models`, which excludes
 *   English; any other model or language returns `pronunciations_unsupported`.
 */
export class SpeechifyTTSSettings extends TTSSettings {
  loudnessNormalization: boolean | null | NotGiven = NOT_GIVEN;
  textNormalization: boolean | null | NotGiven = NOT_GIVEN;
  safetyIdentifier: string | null | NotGiven = NOT_GIVEN;
  pronunciations: Dict[] | null | NotGiven = NOT_GIVEN;

  constructor(options: SpeechifyTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface SpeechifyHttpTTSServiceOptions extends TTSServiceOptions {
  /** Speechify API key for authentication. */
  apiKey: string;
  /** Base URL for the Speechify API. Defaults to "https://api.speechify.ai". */
  baseUrl?: string;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: upstream takes a required shared `aiohttp_session`.
   */
  fetch?: typeof fetch | null;
  /** Runtime-updatable settings. */
  settings?: SpeechifyTTSSettings | null;
}

/**
 * Speechify HTTP-based TTS service with word timestamps.
 *
 * Streams PCM audio and word-level speech marks over Server-Sent Events from
 * Speechify's `/v1/audio/stream/with-timestamps` endpoint. Defaults to `simba-3.5`,
 * which covers 48 languages, English included, under one model id.
 *
 * Requests pin Speechify's API version to `SPEECHIFY_API_VERSION` rather than
 * letting the workspace default decide it. The legacy `simba-english` and
 * `simba-multilingual` models are retired at that version and return a
 * `model_retired` error.
 */
export class SpeechifyHttpTTSService extends TTSService {
  static Settings: typeof SpeechifyTTSSettings = SpeechifyTTSSettings;
  declare protected _settings: SpeechifyTTSSettings;

  static {
    installTracedTts(SpeechifyHttpTTSService.prototype, "runTts");
  }

  protected _fetch: typeof fetch;
  protected _url: string;
  protected _headers: Record<string, string>;
  protected _outputFormat = ""; // Initialized in setup().
  protected _audioSampleRate = 0; // Initialized in setup().
  // Speech-mark times restart at zero for every request, so successive utterances
  // in a turn are offset by the duration of everything synthesized before them.
  protected _cumulativeTime = 0.0;

  /**
   * Initialize the Speechify HTTP TTS service.
   *
   * @param options.apiKey Speechify API key for authentication.
   * @param options.baseUrl Base URL for the Speechify API.
   * @param options.sampleRate Audio sample rate in Hz. If null, uses the pipeline's rate.
   * @param options.fetch `fetch` used for HTTP requests (upstream: an aiohttp session).
   * @param options.settings Runtime-updatable settings.
   * @param options.textAggregationMode How to aggregate incoming text before synthesis.
   *   Other options are passed to the parent service.
   */
  constructor(options: SpeechifyHttpTTSServiceOptions) {
    const defaultSettings = new (new.target as typeof SpeechifyHttpTTSService).Settings({
      model: "simba-3.5",
      voice: "geffen_32",
      language: null,
      loudnessNormalization: null,
      textNormalization: null,
      safetyIdentifier: null,
      pronunciations: null,
    });

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

    const baseUrl = options.baseUrl ?? "https://api.speechify.ai";
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this._url = `${baseUrl}/v1/audio/stream/with-timestamps`;
    this._headers = {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      "Speechify-Version": SPEECHIFY_API_VERSION,
      ...CALLER_HEADERS,
    };
  }

  /** Check if this service can generate processing metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to a Speechify language tag.
   *
   * @param language The language to convert.
   * @returns The Speechify language tag, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToSpeechifyLanguage(language);
  }

  /**
   * Set up the service.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    [this._outputFormat, this._audioSampleRate] = _outputFormatFromSampleRate(this.sampleRate);
    this._cumulativeTime = 0.0;
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
      this._cumulativeTime = 0.0;
    }
  }

  /**
   * Flush any pending audio synthesis.
   *
   * HTTP-based service doesn't require explicit flushing.
   */
  override async flushAudio(_contextId: string | null = null): Promise<void> {}

  /**
   * Build the request body for synthesizing a piece of text.
   *
   * @param text Text to convert to speech.
   * @returns The JSON request body, carrying the settings in effect for this request.
   */
  protected _buildPayload(text: string): Dict {
    const payload: Dict = {
      input: text,
      voice_id: assertGiven(this._settings.voice),
      model: assertGiven(this._settings.model),
      output_format: this._outputFormat,
    };

    const language = assertGiven(this._settings.language);
    if (language) {
      payload.language = language;
    }

    const safetyIdentifier = assertGiven(this._settings.safetyIdentifier);
    if (safetyIdentifier) {
      payload.safety_identifier = safetyIdentifier;
    }

    const pronunciations = assertGiven(this._settings.pronunciations);
    if (pronunciations && pronunciations.length > 0) {
      payload.pronunciations = pronunciations;
    }

    const options: Dict = {};
    const loudnessNormalization = assertGiven(this._settings.loudnessNormalization);
    if (loudnessNormalization !== null) {
      options.loudness_normalization = loudnessNormalization;
    }
    const textNormalization = assertGiven(this._settings.textNormalization);
    if (textNormalization !== null) {
      options.text_normalization = textNormalization;
    }
    if (Object.keys(options).length > 0) {
      payload.options = options;
    }

    return payload;
  }

  /**
   * Generate speech from text using the Speechify streaming API with timestamps.
   *
   * @param text Text to convert to speech.
   * @param contextId Unique identifier for this TTS context.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      const response = await abortable(
        this._fetch(this._url, {
          method: "POST",
          headers: this._headers,
          body: pyJsonDumps(this._buildPayload(text)),
          signal: currentSignal(),
        }),
      );
      if (response.status !== 200) {
        const errorText = await abortable(response.text());
        yield new ErrorFrame({ error: `Speechify API error: ${errorText}` });
        return;
      }

      await this.startTtsUsageMetrics(text);

      for await (const frame of this._processStream(response, text, contextId)) {
        yield frame;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    } finally {
      await this.stopAllMetrics();
    }
  }

  /**
   * Process the Server-Sent Events stream from the Speechify API.
   *
   * @param response The streaming response from the Speechify API.
   * @param text The text sent for synthesis, which the speech marks index into.
   * @param contextId Unique identifier for this TTS context.
   */
  protected async *_processStream(
    response: Response,
    text: string,
    contextId: string,
  ): AsyncGenerator<Frame, void> {
    // An event may carry audio, speech marks, or both, and marks lag their audio, so
    // the last event of a stream is often marks-only.
    const words = new _SpeechMarkAccumulator(text, this._cumulativeTime);
    let utteranceDuration = 0.0;

    for await (const [eventName, data] of _iterSseEvents(response.body)) {
      if (eventName === "speech.chunk") {
        const audio = data.audio;
        if (audio) {
          await this.stopTtfbMetrics();
          yield new TTSAudioRawFrame({
            audio: base64ToBytes(audio),
            sampleRate: this._audioSampleRate,
            numChannels: 1,
            contextId,
          });
        }

        await this.addWordTimestamps(words.add(data.speech_marks), contextId);
      } else if (eventName === "speech.done") {
        // Preferred over the last mark's end time, since it includes any
        // trailing silence.
        const audioDurationMs = data.audio_duration_ms;
        if (audioDurationMs) {
          utteranceDuration = Math.max(utteranceDuration, audioDurationMs / 1000);
        }
      } else if (eventName === "speech.error") {
        // The status code is already committed once the stream has started, so
        // mid-stream failures arrive as an event rather than an HTTP error.
        const error: Dict = get(data, "error", {});
        await this.pushError(
          `Speechify API error (${get(error, "code", "unknown")}): ` +
            `${Object.hasOwn(error, "message") ? error.message : pyJsonDumps(data)}`,
        );
      }
    }

    // A word split across marks is still pending if the text ran out mid-run.
    await this.addWordTimestamps(words.flush(), contextId);
    this._cumulativeTime += Math.max(utteranceDuration, words.endTime);
  }
}
