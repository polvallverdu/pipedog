// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/deepgram/flux/tts_base.py

/**
 * Deepgram Flux TTS base class shared across transports (WebSocket,
 * SageMaker, etc.).
 *
 * Porting note: query values are written with JS number formatting, so a
 * float with an integral value (`speed=1.0` upstream) is written `speed=1`.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import {
  type CancelFrame,
  type EndFrame,
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import {
  TextAggregationMode,
  TTSService,
  type TTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Python's `urlencode({key: value})` for a single pair. */
function urlencode(key: string, value: unknown): string {
  return new URLSearchParams([[key, String(value)]]).toString();
}

/** Python's `str()` of a value that may be None. */
function pyStr(value: unknown): string {
  return value === null || value === undefined ? "None" : String(value);
}

/** Expressive range values Flux accepts. */
export type DeepgramFluxExpressivity = -2 | -1 | 0 | 1 | 2;

export interface DeepgramFluxTTSSettingsOptions extends TTSSettingsOptions {
  /** Speech-rate multiplier, from 0.5 to 1.5 in steps of 0.05. */
  speed?: number | null | NotGiven;
  /** Expressive range on a calm-to-animated axis. */
  expressivity?: DeepgramFluxExpressivity | null | NotGiven;
}

/**
 * Settings for Deepgram Flux TTS services.
 *
 * The Flux voice is a single `flux-{voice}-{language}` identifier (e.g.
 * `flux-alexis-en`), carried by `voice`. Deepgram's API passes it as its
 * `model` query parameter, so `model` is kept in sync with `voice` and is not
 * directly settable.
 *
 * - `speed`: speech-rate multiplier, from 0.5 to 1.5 in steps of 0.05.
 *   `null` leaves Flux at its default rate. Applied to the open connection,
 *   so a speed change keeps the cross-turn acoustic state.
 * - `expressivity`: expressive range on a calm-to-animated axis. `null`
 *   leaves Flux at its default range. Flux fixes expressivity when the
 *   connection opens, so a change reconnects.
 */
export class DeepgramFluxTTSSettings extends TTSSettings {
  speed: number | null | NotGiven = NOT_GIVEN;
  expressivity: DeepgramFluxExpressivity | null | NotGiven = NOT_GIVEN;

  constructor(options: DeepgramFluxTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface DeepgramFluxTTSBaseOptions extends TTSServiceOptions {
  /**
   * Opt out of the Deepgram Model Improvement Program. See
   * https://dpgr.am/deepgram-mip for pricing impacts before setting to true.
   */
  mipOptOut?: boolean | null;
  /** Tags to label requests for identification during usage reporting. */
  tag?: string[] | null;
  /**
   * How to aggregate incoming text before synthesis. Defaults to
   * `TextAggregationMode.TOKEN`, streaming LLM tokens straight to Flux for
   * the lowest latency.
   */
  textAggregationMode?: TextAggregationMode;
  /** Fully resolved settings instance (built by concrete subclass). */
  settings: DeepgramFluxTTSSettings;
}

/**
 * Base class for Deepgram Flux TTS services across transports.
 *
 * Contains all shared Flux protocol logic (message handling, turn lifecycle,
 * metrics, settings). Concrete subclasses implement the transport layer by
 * providing `_transportSendJson`, `_transportIsActive`, `_connect` and
 * `_disconnect`.
 *
 * Flux keeps acoustic state across turns on a single connection, so prosody
 * and pacing stay consistent throughout a conversation.
 *
 * Flux's inline pronunciation markup is Early Access and is rejected with a
 * fatal `DATA-0002` on any connection whose `speed` is not 1.0, so
 * `formatPronunciation` is left at the base implementation and
 * `TTSService.pronunciationTransformIpa` speaks the words as written. The
 * Aura-2 services take inline pronunciations; see
 * https://developers.deepgram.com/docs/tts-voice-controls for which controls
 * each model supports.
 *
 * Event handlers:
 *
 * - on_connected: Called when the connection is established.
 * - on_disconnected: Called when the connection is closed.
 * - on_connection_error: Called when a connection error occurs.
 */
export abstract class DeepgramFluxTTSBase extends TTSService {
  static Settings: typeof DeepgramFluxTTSSettings = DeepgramFluxTTSSettings;
  declare protected _settings: DeepgramFluxTTSSettings;

  /**
   * Audio is always requested as linear16 (raw PCM), the format Pipecat
   * pipelines use internally.
   */
  static readonly SUPPORTED_SAMPLE_RATES: readonly number[] = [
    8000, 16000, 24000, 32000, 44100, 48000,
  ];

  /**
   * Settings Flux can change on an open connection, via `Configure`. Every
   * other setting is a query parameter, fixed for the life of the connection.
   */
  static readonly _CONFIGURE_FIELDS: ReadonlySet<string> = new Set(["speed"]);

  static {
    installTracedTts(DeepgramFluxTTSBase.prototype, "runTts");
  }

  protected _mipOptOut: boolean | null;
  protected _tag: string[];

  /**
   * Initialize the Deepgram Flux TTS base service.
   *
   * @param options.mipOptOut Opt out of the Deepgram Model Improvement
   *   Program. See https://dpgr.am/deepgram-mip for pricing impacts before
   *   setting to true.
   * @param options.tag Tags to label requests for identification during
   *   usage reporting.
   * @param options.textAggregationMode How to aggregate incoming text before
   *   synthesis. Defaults to `TextAggregationMode.TOKEN`, streaming LLM
   *   tokens straight to Flux for the lowest latency.
   * @param options.settings Fully resolved settings instance (built by
   *   concrete subclass).
   *   Other options are passed to the parent TTSService (e.g. `sampleRate`).
   */
  constructor(options: DeepgramFluxTTSBaseOptions) {
    const settings = options.settings;
    // Deepgram passes the voice identifier as its `model` query parameter, so
    // keep `model` in sync with `voice` for metrics.
    settings.model = settings.voice;

    super({
      ...options,
      pauseFrameProcessing: true,
      pushStopFrames: false,
      pushStartFrame: true,
      textAggregationMode: options.textAggregationMode ?? TextAggregationMode.TOKEN,
      // Flux never inserts or strips whitespace between Speak messages, so
      // consecutive sentences would otherwise glue together. Applies in
      // sentence mode only; when streaming tokens, the LLM's own whitespace
      // is used as-is.
      appendTrailingSpace: true,
      settings,
    });

    this._mipOptOut = options.mipOptOut ?? null;
    this._tag = options.tag ?? [];
  }

  /** The class of this instance, for its class-level configuration. */
  protected get _cls(): typeof DeepgramFluxTTSBase {
    return this.constructor as typeof DeepgramFluxTTSBase;
  }

  /**
   * Check if the service can generate metrics.
   *
   * @returns True, as Deepgram Flux TTS supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Whether this service has a meaningful processing-time metric.
   *
   * False: `runTts` sends the text and returns, and audio arrives later on
   * the receive task, so there is no synthesis inside the measured window.
   */
  override get supportsProcessingMetrics(): boolean {
    return false;
  }

  // ------------------------------------------------------------------
  // Abstract transport interface — implemented by each concrete subclass
  // ------------------------------------------------------------------

  /** Serialize and send a JSON control message over the transport. */
  abstract _transportSendJson(message: Dict): Promise<void>;

  /** Return true if the transport connection is currently active. */
  abstract _transportIsActive(): boolean;

  /** Establish the transport connection. */
  abstract _connect(): Promise<void>;

  /** Tear down the transport connection. */
  abstract _disconnect(): Promise<void>;

  // ------------------------------------------------------------------
  // Service lifecycle
  // ------------------------------------------------------------------

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
   * Stop the service on a graceful end.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the service immediately.
   *
   * Disconnecting here is the prompt teardown: the receive loop runs
   * independently of the audio-context task, so it keeps reading from Flux
   * until the connection is closed.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /** Release the connection at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._disconnect();
  }

  // ------------------------------------------------------------------
  // Connection helpers
  // ------------------------------------------------------------------

  /** Warn if the pipeline sample rate is one Flux doesn't synthesize. */
  protected _validateSampleRate(): void {
    const supported = this._cls.SUPPORTED_SAMPLE_RATES;
    if (!supported.includes(this.sampleRate)) {
      logger.warning(
        `${this}: sample rate ${this.sampleRate} is not supported. ` +
          `Supported rates: (${supported.join(", ")}).`,
      );
    }
  }

  /** Build query string from current settings and init-only connection config. */
  protected _buildQueryString(): string {
    const params = [
      `model=${this._settings.voice}`,
      "encoding=linear16",
      `sample_rate=${this.sampleRate}`,
    ];

    if (this._settings.speed !== null) {
      params.push(`speed=${this._settings.speed}`);
    }

    if (this._settings.expressivity !== null) {
      params.push(`expressivity=${this._settings.expressivity}`);
    }

    if (this._mipOptOut !== null) {
      params.push(`mip_opt_out=${String(this._mipOptOut)}`);
    }

    // Add tag parameters (can have multiple)
    for (const tagValue of this._tag) {
      params.push(urlencode("tag", tagValue));
    }

    return params.join("&");
  }

  // ------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------

  /**
   * Apply a settings delta.
   *
   * A speed change is sent to Flux with a `Configure` message. Every other
   * setting is a query parameter, so a change reconnects.
   *
   * @param delta A TTSSettings (or `Settings`) delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    // Deepgram uses voice as the model, so keep them in sync for metrics
    if ("voice" in changed) {
      this._settings.model = this._settings.voice as string | null;
      this._syncModelNameToMetrics();
    }

    const changedKeys = Object.keys(changed);
    if (changedKeys.some((k) => !this._cls._CONFIGURE_FIELDS.has(k))) {
      await this._disconnect();
      await this._connect();
    } else if (changedKeys.length > 0) {
      await this._sendConfigure();
    }

    return changed;
  }

  /** Apply the current speed to the open connection with a Configure message. */
  protected async _sendConfigure(): Promise<void> {
    if (!this._transportIsActive()) {
      return;
    }

    // Flux's own default is 1.0, so clearing the setting restores that rate
    // explicitly — there is no way to ask Flux to forget a configured speed.
    const speed = this._settings.speed !== null ? this._settings.speed : 1.0;

    try {
      await this._transportSendJson({ type: "Configure", speed });
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} error sending Configure message: ${errorMessage(e)}`);
    }
  }

  // ------------------------------------------------------------------
  // Turn lifecycle
  // ------------------------------------------------------------------

  /**
   * Cancel the turn on the Flux connection when the user barges in.
   *
   * Flux's `Interrupt` message ends the active turn without closing the
   * connection, so the cross-turn acoustic state survives a barge-in.
   *
   * @param contextId The ID of the audio context that was interrupted.
   */
  override async onAudioContextInterrupted(contextId: string): Promise<void> {
    if (this._transportIsActive()) {
      try {
        await this._transportSendJson({ type: "Interrupt" });
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`${this} error sending Interrupt message: ${errorMessage(e)}`);
      }
    }

    await super.onAudioContextInterrupted(contextId);
  }

  /**
   * Flush any pending audio synthesis by sending a Flush message.
   *
   * This ends the active turn: the server generates any remaining audio and
   * reports the turn's `SpeechMetadata`.
   */
  override async flushAudio(_contextId: string | null = null): Promise<void> {
    if (this._transportIsActive()) {
      try {
        await this._transportSendJson({ type: "Flush" });
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`${this} error sending Flush message: ${errorMessage(e)}`);
      }
    }
  }

  /**
   * Generate speech from text using Deepgram Flux.
   *
   * @param text The text to synthesize into speech.
   * @param _contextId The context ID for tracking audio frames.
   * @returns Audio frames are delivered by the receive task; yields null, or
   *   an ErrorFrame on failure.
   */
  override async *runTts(text: string, _contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      if (!this._transportIsActive()) {
        // Full disconnect/connect cycle: after a server-initiated close (e.g.
        // Flux's one-hour session cap) the transport's receive task has
        // completed but is still set, so a plain _connect() would not restart
        // the receive loop.
        await this._disconnect();
        await this._connect();

        if (!this._transportIsActive()) {
          yield new ErrorFrame({ error: `${this} is not connected` });
          return;
        }
      }

      await this._transportSendJson({ type: "Speak", text });

      await this.startTtsUsageMetrics(text);
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
      return;
    }

    // The audio frames will be handled by the receive task
    yield null;
  }

  // ------------------------------------------------------------------
  // Message handling
  // ------------------------------------------------------------------

  /**
   * Append a chunk of synthesized audio to the active audio context.
   *
   * Audio carries no speech_id, so it is attributed to the active audio
   * context. This is safe because `pauseFrameProcessing: true` serializes
   * turns, and an interruption leaves no active context, so audio the server
   * had already generated for the abandoned turn is discarded.
   */
  protected async _handleAudio(audio: Uint8Array): Promise<void> {
    const ctxId = this.getActiveAudioContextId();
    const frame = new TTSAudioRawFrame({
      audio,
      sampleRate: this.sampleRate,
      numChannels: 1,
      contextId: ctxId,
    });
    await this.appendToAudioContext(ctxId, frame);
  }

  /** Handle a JSON control message from Flux. */
  protected async _handleMessage(msg: Dict): Promise<void> {
    const msgType = msg?.type;

    if (msgType === "Connected") {
      logger.debug(
        `${this}: connected (request_id: ${pyStr(msg.request_id)}, ` +
          `model: ${pyStr(msg.model_name)})`,
      );
    } else if (msgType === "SpeechStarted") {
      logger.trace(`Received SpeechStarted: ${pyJsonDumps(msg)}`);
    } else if (msgType === "Flushed") {
      // Not end-of-turn: Flux acknowledges the flush and may still send audio
      // afterwards. SpeechMetadata is the definitive end-of-turn signal.
      logger.trace(`Received Flushed: ${pyJsonDumps(msg)}`);
    } else if (msgType === "SpeechMetadata") {
      // Sent once per turn after all of its audio.
      logger.debug(
        `${this}: speech complete (speech_id: ${pyStr(msg.speech_id)}, ` +
          `duration: ${pyStr(msg.audio_duration_ms)}ms, ` +
          `billable characters: ${pyStr(msg.billable_character_count)})`,
      );
      const ctxId = this.getActiveAudioContextId();
      await this.appendToAudioContext(ctxId, new TTSStoppedFrame({ contextId: ctxId }));
      await this.removeAudioContext(ctxId);
    } else if (msgType === "SpeechInterrupted") {
      // Acknowledges an Interrupt. The reported total covers audio the server
      // generated, not audio the user heard, since the request carries no
      // playback offset.
      logger.trace(
        `${this}: speech interrupted (speech_id: ${pyStr(msg.speech_id)}, ` +
          `audio played: ${pyStr(msg.audio_played_ms)}ms)`,
      );
    } else if (msgType === "SessionMetadata") {
      logger.debug(`${this}: session totals: ${pyJsonDumps(msg)}`);
    } else if (msgType === "ConfigureSuccess") {
      logger.debug(`${this}: configuration applied: ${pyJsonDumps(msg.applied ?? null)}`);
    } else if (msgType === "ConfigureFailure") {
      // Non-fatal: synthesis continues with the previous configuration, so
      // application code decides what a rejected settings update means for
      // the conversation.
      const errorMsg =
        `${this} configuration rejected ${pyStr(msg.code)} ` +
        `(${pyStr(msg.field)}=${pyStr(msg.value)}): ` +
        `${msg.description ?? "Unknown failure"}`;
      await this.pushError(errorMsg);
    } else if (msgType === "Warning") {
      const code = msg.code;
      if (code === "NO_ACTIVE_SPEECH") {
        // Routine: an audio context outlives the turn that filled it, so a
        // barge-in late in playback sends an Interrupt the server has nothing
        // left to cancel.
        logger.trace(`${this}: no active turn to interrupt`);
      } else {
        logger.warning(`${this} warning ${pyStr(code)}: ${msg.description ?? "Unknown warning"}`);
      }
    } else if (msgType === "Error") {
      const errorMsg = `${this} error ${pyStr(msg.code)}: ${msg.description ?? "Unknown error"}`;
      logger.error(errorMsg);
      await this.pushError(errorMsg);
    } else {
      logger.debug(`Received unknown message type: ${pyJsonDumps(msg)}`);
    }
  }
}
