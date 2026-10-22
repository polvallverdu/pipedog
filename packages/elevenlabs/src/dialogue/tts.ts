// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/elevenlabs/dialogue/tts.py

/**
 * ElevenLabs Text-to-Dialogue text-to-speech service implementation.
 *
 * This module provides a WebSocket TTS service for ElevenLabs' multi-context
 * Text-to-Dialogue endpoint, which serves the Eleven v3 and v4 dialogue models.
 *
 * Porting notes:
 * - Runs on the global `WebSocket` through `ElevenLabsTTSBase` (the
 *   `xi-api-key` header is sent on the handshake on every runtime).
 * - The wire format is upstream's: `/v1/text-to-dialogue/multi-stream-input`,
 *   per-context `voices` registration, `inputs` arrays, `close_context`,
 *   `flush` and `keep_alive` messages, and snake_case alignment fields.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { TTSAudioRawFrame, TTSStoppedFrame } from "@pipedog/core/frames/frames";
import { TextAggregationMode } from "@pipedog/core/services/tts_service";
import { State } from "@pipedog/core/services/websocket_service";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { normalizeIpa } from "@pipedog/core/utils/text/phonemes";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import {
  _selectAlignment,
  _stripUtteranceLeadingSpaces,
  _wordTimestampsIncludeInterFrameSpaces,
  calculateWordTimes,
  ElevenLabsTTSBase,
  type ElevenLabsTTSBaseOptions,
  ElevenLabsTTSSettingsBase,
  type ElevenLabsTTSSettingsBaseOptions,
  elevenlabsLanguageCode,
} from "../tts_base.ts";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Python truthiness for the JSON values that appear in server messages. */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return Boolean(value);
}

// Text-to-Dialogue rejects a keepalive that doesn't name a registered context,
// and between bot turns there isn't one. This context is registered at connect
// and never receives text.
export const _KEEPALIVE_CONTEXT_ID = "pipecat-keepalive";

export interface ElevenLabsDialogueTTSSettingsOptions extends ElevenLabsTTSSettingsBaseOptions {
  /** Voice stability control (0.0 to 1.0). */
  stability?: number | null | NotGiven;
}

/**
 * Settings for ElevenLabsDialogueTTSService.
 *
 * - `stability`: voice stability control (0.0 to 1.0), the only voice setting
 *   Text-to-Dialogue reads. ElevenLabs documents three reference points: 0.0
 *   is the most expressive but can hallucinate, 0.5 stays closest to the
 *   reference recording, and 1.0 is the most consistent but least responsive
 *   to audio tags. Values in between are accepted.
 */
export class ElevenLabsDialogueTTSSettings extends ElevenLabsTTSSettingsBase {
  stability: number | null | NotGiven = NOT_GIVEN;

  /**
   * Fields in the WS URL — changing any of these requires a reconnect. Voice
   * is absent because Text-to-Dialogue registers voices per context rather
   * than in the URL, so a voice change only needs a new context.
   */
  static override URL_FIELDS: ReadonlySet<string> = new Set(["model", "language"]);

  /**
   * Fields carried in the per-context registration message — changing these
   * requires closing the current audio context so the next one picks them up.
   */
  static override VOICE_SETTINGS_FIELDS: ReadonlySet<string> = new Set(["voice", "stability"]);

  constructor(options: ElevenLabsDialogueTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/**
 * Build a Text-to-Dialogue voice settings dict.
 *
 * `stability` is the only setting Text-to-Dialogue reads. The endpoint
 * silently ignores the other voice settings the text-to-speech endpoint
 * accepts, so sending them would suggest an effect they don't have.
 *
 * @param settings A settings object or dict to read `stability` from.
 * @returns The voice settings dict, or null if stability is unset.
 */
export function buildElevenlabsTtdVoiceSettings(settings: Dict): Record<string, number> | null {
  const stability = settings.stability ?? null;
  if (stability === null || stability === NOT_GIVEN) {
    return null;
  }
  return { stability };
}

/**
 * Convert Text-to-Dialogue alignment keys to the casing shared helpers expect.
 *
 * Text-to-Dialogue emits snake_case alignment fields where the text-to-speech
 * endpoint emits camelCase, and `calculateWordTimes` expects the latter.
 */
export function _normalizeTtdAlignment(alignment: Dict): Dict {
  return {
    chars: pyTruthy(alignment.chars) ? alignment.chars : [],
    charStartTimesMs: pyTruthy(alignment.char_start_times_ms) ? alignment.char_start_times_ms : [],
    charDurationsMs: pyTruthy(alignment.char_durations_ms) ? alignment.char_durations_ms : [],
  };
}

/**
 * Server-side state for one Text-to-Dialogue context.
 *
 * Tracked separately from the audio context the base class owns, because the
 * two have different lifetimes: a Text-to-Dialogue context outlives its audio
 * context while draining after an interruption, and the keepalive context
 * never has one at all.
 */
export class _DialogueContext {
  /**
   * Whether the server will accept messages naming this context. It rejects
   * any message for a context that has no `voices` registration, and a closed
   * context counts as unregistered.
   */
  registered: boolean;
  /** Whether the next input should reset prosody. */
  newTurnPending: boolean;
  /**
   * Whether an alignment message has been seen, so leading spaces are only
   * stripped from the first one.
   */
  alignmentStarted: boolean;

  constructor(
    options: { registered?: boolean; newTurnPending?: boolean; alignmentStarted?: boolean } = {},
  ) {
    this.registered = options.registered ?? true;
    this.newTurnPending = options.newTurnPending ?? true;
    this.alignmentStarted = options.alignmentStarted ?? false;
  }
}

export interface ElevenLabsDialogueTTSServiceOptions
  extends Omit<ElevenLabsTTSBaseOptions, "url" | "settings"> {
  /** WebSocket URL for the ElevenLabs API. Defaults to "wss://api.elevenlabs.io". */
  url?: string;
  /** Seed for reproducible generation. */
  seed?: number | null;
  /**
   * Runtime-updatable settings. Its given fields override the defaults
   * (model "eleven_v4_turbo").
   */
  settings?: ElevenLabsDialogueTTSSettings | null;
}

/**
 * ElevenLabs Text-to-Dialogue WebSocket TTS service for Eleven v3 and v4 models.
 *
 * Uses the multi-context Text-to-Dialogue endpoint, which serves the
 * `eleven_v3` and `eleven_v4` model families. The default model is
 * `eleven_v4_turbo`. Use `ElevenLabsTTSService` for Flash, Turbo v2.5, and
 * Multilingual models — it has a fuller set of voice controls.
 *
 * Eleven v3 and v4 perform inline audio tags such as `[laughs]` and
 * `[excited]`. They come back as spoken characters in the alignment, so they
 * reach the LLM context as text unless a text filter removes them.
 */
export class ElevenLabsDialogueTTSService extends ElevenLabsTTSBase {
  static override Settings: typeof ElevenLabsDialogueTTSSettings = ElevenLabsDialogueTTSSettings;
  declare protected _settings: ElevenLabsDialogueTTSSettings;

  static override CONNECTION_NAME = "ElevenLabs Text-to-Dialogue";

  protected _seed: number | null;
  protected _contexts: Map<string, _DialogueContext>;

  /**
   * Initialize the ElevenLabs Text-to-Dialogue TTS service.
   *
   * @param options.apiKey ElevenLabs API key for authentication.
   * @param options.url WebSocket URL for the ElevenLabs API.
   * @param options.sampleRate Audio sample rate. If null, uses default.
   * @param options.enableLogging Whether to enable ElevenLabs server-side logging.
   * @param options.seed Seed for reproducible generation.
   * @param options.settings Runtime-updatable settings.
   * @param options.textAggregationMode How to aggregate incoming text before
   *   synthesis. Only `TextAggregationMode.SENTENCE` is supported; any other
   *   value is ignored with a warning. Other options are passed to the parent
   *   service.
   */
  constructor(options: ElevenLabsDialogueTTSServiceOptions) {
    const defaultSettings = new ElevenLabsDialogueTTSSettings({
      model: "eleven_v4_turbo",
      voice: null,
      language: null,
      stability: null,
    });
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
      // Consecutive inputs are concatenated verbatim, so without a trailing
      // space one input's last word merges into the next's first.
      appendTrailingSpace: true,
      // Verbatim concatenation plus the trailing space above means a
      // token-sized input would insert a space mid-word.
      textAggregationMode: TextAggregationMode.SENTENCE,
      sampleRate: options.sampleRate ?? null,
      settings: defaultSettings,
    });

    const model = defaultSettings.model;
    if (
      typeof model === "string" &&
      !model.startsWith("eleven_v3") &&
      !model.startsWith("eleven_v4")
    ) {
      logger.warning(
        `${this}: Text-to-Dialogue requires an eleven_v3 or eleven_v4 model, got '${model}'. ` +
          "Use ElevenLabsTTSService for Flash, Turbo v2.5, and Multilingual models.",
      );
    }

    const requestedMode = options.textAggregationMode ?? null;
    if (requestedMode !== null && requestedMode !== TextAggregationMode.SENTENCE) {
      logger.warning(
        `${this}: Text-to-Dialogue aggregates by sentence; ignoring ` +
          `textAggregationMode=${requestedMode}.`,
      );
    }

    this._seed = options.seed ?? null;

    this._contexts = new Map();
  }

  /**
   * Render a pronunciation as IPA between slashes, as Eleven v3 reads it.
   *
   * @param _word The word being pronounced (unused: the IPA replaces it).
   * @param ipa The pronunciation, in IPA.
   * @returns The IPA wrapped in slashes, e.g. `/mɛtˈfɔɹmɪn/`, or null for an
   *   empty pronunciation.
   */
  static override formatPronunciation(_word: string, ipa: string): string | null {
    const normalized = normalizeIpa(ipa);
    return normalized ? `/${normalized}/` : null;
  }

  protected override _setVoiceSettings(): Dict | null {
    return buildElevenlabsTtdVoiceSettings(this._settings);
  }

  /**
   * Force generation of any text still held in the server-side buffer.
   *
   * Text accumulates until roughly 40 characters and 8 words, at which point
   * the server starts generating on its own, so a turn is usually under way
   * before the end-of-turn flush covers what is left.
   *
   * @param contextId The specific context to flush. If null, falls back to the
   *   currently active context.
   */
  override async flushAudio(contextId: string | null = null): Promise<void> {
    const flushId = contextId || this.getActiveAudioContextId();
    if (!flushId || !this._websocket) {
      return;
    }
    const context = this._contexts.get(flushId);
    if (!context || !context.registered) {
      return;
    }

    logger.trace(`${this}: flushing context ${flushId}`);
    await this._websocket.send(pyJsonDumps({ context_id: flushId, flush: true }));
  }

  protected override _buildWebsocketUrl(): string {
    const model = this._settings.model;
    let url =
      `${this._url}/v1/text-to-dialogue/multi-stream-input` +
      `?model_id=${model}&output_format=${this._outputFormat}&sync_alignment=true`;

    if (this._enableLogging !== null) {
      url += `&enable_logging=${String(this._enableLogging).toLowerCase()}`;
    }

    if (this._seed !== null) {
      url += `&seed=${this._seed}`;
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

  protected override async _onWebsocketConnected(): Promise<void> {
    // runTts can reconnect in place, bypassing the disconnect that clears this.
    this._clearConnectionState();
    await this._registerKeepaliveContext();
  }

  protected override _clearConnectionState(): void {
    this._contexts.clear();
  }

  /**
   * Close a server-side context to free its slot.
   *
   * A close generates whatever text the context still holds, streams that
   * audio, and ends with an `is_final`. A context closed on an interruption
   * therefore keeps producing audio for a while; removing the audio context
   * discards it.
   */
  protected override async _closeContext(contextId: string): Promise<void> {
    const context = this._contexts.get(contextId);
    if (!context || !context.registered) {
      return;
    }
    // The entry outlives the close so that alignment still arriving for this
    // context is handled with the right state; `is_final` removes it.
    context.registered = false;
    if (!this._websocket) {
      return;
    }
    logger.trace(`${this}: Closing context ${contextId}`);
    try {
      await this._websocket.send(pyJsonDumps({ context_id: contextId, close_context: true }));
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    }
  }

  /** Close the turn's context, which generates any text still buffered in it. */
  override async onTurnContextCompleted(): Promise<void> {
    const contextId = this._turnContextId;
    await super.onTurnContextCompleted();
    if (contextId) {
      await this._closeContext(contextId);
    }
  }

  /** Handle incoming WebSocket messages from ElevenLabs Text-to-Dialogue. */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      await this._handleMessage(
        pyJsonLoads(
          typeof message === "string" ? message : new TextDecoder().decode(message),
        ) as Dict,
      );
    }
  }

  /** Dispatch a single Text-to-Dialogue server message. */
  async _handleMessage(msg: Dict): Promise<void> {
    if (pyTruthy(msg.error)) {
      await this.pushError(`ElevenLabs Text-to-Dialogue error: ${msg.message ?? pyJsonDumps(msg)}`);
      return;
    }

    const receivedCtxId: string | null = msg.context_id ?? null;
    if (!receivedCtxId) {
      logger.debug(`${this}: ignoring message with no context: ${pyJsonDumps(msg)}`);
      return;
    }

    if (receivedCtxId === _KEEPALIVE_CONTEXT_ID) {
      return;
    }

    // `is_final` marks the end of a context. `is_final_audio_for_turn` arrives
    // each time the server finishes a batch of generation, several times
    // within a turn, so it can't be used to end one.
    if (msg.is_final === true) {
      logger.debug(`Received final message for context ${receivedCtxId}`);
      this._contexts.delete(receivedCtxId);
      if (this.audioContextAvailable(receivedCtxId)) {
        await this.appendToAudioContext(
          receivedCtxId,
          new TTSStoppedFrame({ contextId: receivedCtxId }),
        );
        await this.removeAudioContext(receivedCtxId);
      }
      return;
    }

    // An interrupted context keeps producing audio until the server finishes
    // the batch it had started. That audio is discarded, and its alignment
    // must not advance the word clock, which by now belongs to the next turn.
    const context = this._contexts.get(receivedCtxId);
    if (!context || !this.audioContextAvailable(receivedCtxId)) {
      return;
    }

    if (pyTruthy(msg.audio)) {
      const audio = base64ToBytes(msg.audio);
      const frame = new TTSAudioRawFrame({
        audio,
        sampleRate: this.sampleRate,
        numChannels: 1,
        contextId: receivedCtxId,
      });
      await this.appendToAudioContext(receivedCtxId, frame);
    }

    const rawAlignment = _selectAlignment(msg, {
      normalizedKey: "normalized_alignment",
      alignmentKey: "alignment",
      preferNormalized: false,
    });
    if (rawAlignment && pyTruthy(rawAlignment)) {
      const alignment = _stripUtteranceLeadingSpaces(
        _normalizeTtdAlignment(rawAlignment),
        ["chars", "charStartTimesMs", "charDurationsMs"],
        !context.alignmentStarted,
      );
      context.alignmentStarted = true;
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
      // advances by each chunk's span. It has to advance for chunks that
      // complete no word too — trailing punctuation arrives on its own — or
      // every later word is timestamped early by the shortfall.
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

  /**
   * Open a context that exists only to keep the connection alive.
   *
   * ElevenLabs closes the connection after 20 seconds without a message, and
   * rejects a keepalive that doesn't name a registered context. Between bot
   * turns there is no such context, so this one is registered up front and
   * never receives text.
   */
  async _registerKeepaliveContext(): Promise<void> {
    if (!this._websocket) {
      return;
    }

    const voice = this._settings.voice;
    if (voice === null || voice === NOT_GIVEN) {
      logger.debug(`${this}: no voice set, connection will idle out after 20s`);
      return;
    }

    await this._websocket.send(pyJsonDumps({ context_id: _KEEPALIVE_CONTEXT_ID, voices: [voice] }));
    this._contexts.set(_KEEPALIVE_CONTEXT_ID, new _DialogueContext());
  }

  /** Reset the server's inactivity timer on the connection. */
  protected override async _sendKeepalive(): Promise<void> {
    if (!this._websocket || this._websocket.state !== State.OPEN) {
      return;
    }

    const context = this._contexts.get(_KEEPALIVE_CONTEXT_ID);
    if (!context || !context.registered) {
      return;
    }

    await this._websocket.send(
      pyJsonDumps({ context_id: _KEEPALIVE_CONTEXT_ID, keep_alive: true }),
    );
  }

  /**
   * Open a context, registering the voice it speaks with.
   *
   * Every context must open with a `voices` registration; ElevenLabs closes
   * the socket otherwise. Registration opens a context once: naming one the
   * connection already has is a policy violation, open or closing.
   */
  protected override async _sendContextInit(contextId: string): Promise<void> {
    const context = this._contexts.get(contextId);
    if (context) {
      if (!context.registered) {
        logger.warning(
          `${this}: context ${contextId} is closing, so text still arriving for it is not spoken`,
        );
      }
      return;
    }
    const msg: Dict = {
      context_id: contextId,
      voices: [assertGiven(this._settings.voice)],
    };
    if (this._voiceSettings) {
      msg.voice_settings = this._voiceSettings;
    }
    await this._getWebsocket().send(pyJsonDumps(msg));
    this._contexts.set(contextId, new _DialogueContext());
  }

  /** Send text to the WebSocket for synthesis. */
  protected override async _sendText(text: string, contextId: string): Promise<void> {
    const context = this._contexts.get(contextId);
    if (!this._websocket || !context || !context.registered) {
      return;
    }

    const newTurn = context.newTurnPending;
    context.newTurnPending = false;
    logger.trace(
      `${this}: input for context ${contextId} (new_turn=${newTurn}): ${pyJsonDumps(text)}`,
    );
    const msg = {
      context_id: contextId,
      inputs: [
        {
          text,
          voice_id: assertGiven(this._settings.voice),
          new_turn: newTurn,
        },
      ],
    };
    await this._websocket.send(pyJsonDumps(msg));
  }
}
