// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/gradium/tts.py

/**
 * Gradium Text-to-Speech service implementation.
 *
 * Wire format: upstream's, checked against Gradium's API reference
 * (https://docs.gradium.ai/api-reference/endpoint/tts-websocket.md): the
 * `wss://api.gradium.ai/api/speech/tts` endpoint, an `x-api-key` header, and
 * the `setup`, `text`, `end_of_stream`, `ready`, `audio` and `error` messages,
 * multiplexed on one socket by `client_req_id`.
 *
 * Porting notes:
 * - The socket is opened through `WebsocketService._websocketConnect()` (the
 *   core `websocketConnect`), which sends the `x-api-key` header on every
 *   runtime.
 * - Deprecated upstream APIs are not ported: `InputParams` and the `params`,
 *   `voice_id` and `model` constructor parameters (use `settings`).
 */

import { rethrowIfCancelled, type Task } from "@pipedog/asyncio";
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
  WebsocketTTSService,
  type WebsocketTTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import {
  ConnectionClosedOK,
  State,
  type WebsocketClientConnection,
} from "@pipedog/core/services/websocket_service";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const SAMPLE_RATE = 48000;

export interface GradiumTTSSettingsOptions extends TTSSettingsOptions {}

/** Settings for GradiumTTSService. */
export class GradiumTTSSettings extends TTSSettings {
  constructor(options: GradiumTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface GradiumTTSServiceOptions
  extends Omit<WebsocketTTSServiceOptions, "settings" | "sampleRate"> {
  /** Gradium API key for authentication. */
  apiKey: string;
  /** Gradium websocket API endpoint. Defaults to "wss://api.gradium.ai/api/speech/tts". */
  url?: string;
  /** Optional JSON configuration string for additional model settings. */
  jsonConfig?: string | null;
  /** Runtime-updatable settings. */
  settings?: GradiumTTSSettings | null;
}

/** Text-to-Speech service using Gradium's websocket API. */
export class GradiumTTSService extends WebsocketTTSService {
  static Settings: typeof GradiumTTSSettings = GradiumTTSSettings;
  declare protected _settings: GradiumTTSSettings;

  static {
    installTracedTts(GradiumTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _url: string;
  protected _jsonConfig: string | null;

  // State tracking
  protected _receiveTask: Task<unknown> | null = null;
  protected _setupContextIds: Set<string> = new Set();

  /**
   * Initialize the Gradium TTS service.
   *
   * @param options.apiKey Gradium API key for authentication.
   * @param options.url Gradium websocket API endpoint.
   * @param options.jsonConfig Optional JSON configuration string for
   *   additional model settings.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent WebsocketTTSService.
   */
  constructor(options: GradiumTTSServiceOptions) {
    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = new (new.target as typeof GradiumTTSService).Settings({
      model: "default",
      voice: "_6Aslh2DxfmnRLmP",
      language: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      pushStopFrames: true,
      pushStartFrame: true,
      pushTextFrames: false,
      pauseFrameProcessing: true,
      sampleRate: SAMPLE_RATE,
      settings: defaultSettings,
    });

    // Store service configuration
    this._apiKey = options.apiKey;
    this._url = options.url ?? "wss://api.gradium.ai/api/speech/tts";
    this._jsonConfig = options.jsonConfig ?? null;
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Gradium service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Apply a settings delta and reconnect if voice changed.
   *
   * @param delta A TTSSettings (or `GradiumTTSService.Settings`) delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if (Object.hasOwn(changed, "voice")) {
      await this._disconnect();
      await this._connect();
    } else {
      this._warnUnhandledUpdatedSettings(changed);
    }
    return changed;
  }

  /**
   * Build setup message for Gradium API.
   *
   * @param contextId Context ID to use as `client_req_id`.
   */
  protected _buildSetupMsg(contextId: string): Dict {
    const setupMsg: Dict = {
      type: "setup",
      output_format: "pcm",
      voice_id: this._settings.voice,
      close_ws_on_eos: false,
      client_req_id: contextId,
    };
    if (this._jsonConfig !== null) {
      setupMsg.json_config = this._jsonConfig;
    }
    return setupMsg;
  }

  /** Build text message for Gradium API. */
  protected _buildTextMsg(text = "", contextId = ""): Dict {
    return { text, type: "text", client_req_id: contextId };
  }

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._connect();
  }

  /** Stop the service and close connection. */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /** Cancel current operation and clean up. */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /** Establish websocket connection and start receive task. */
  override async _connect(): Promise<void> {
    await super._connect();

    logger.debug(`${this}: connecting`);

    // If the server disconnected, cancel the receive-task so that it can be reset below.
    if (this._websocket === null || this._websocket.state !== State.OPEN) {
      if (this._receiveTask) {
        await this.cancelTask(this._receiveTask);
        this._receiveTask = null;
      }
    }

    await this._connectWebsocket();

    if (this._websocket && !this._receiveTask) {
      logger.debug(`${this}: setting receive task`);
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  /** Close websocket connection and clean up tasks. */
  override async _disconnect(): Promise<void> {
    await super._disconnect();

    logger.debug(`${this}: disconnecting`);
    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._disconnectWebsocket();
  }

  /** Connect to Gradium websocket API with configured settings. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      const headers = { "x-api-key": this._apiKey, "x-api-source": "pipecat" };
      this._websocket = await this._websocketConnect(this._url, { additionalHeaders: headers });

      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      this._websocket = null;
      await this._callEventHandler("on_connection_error", errorMessage(e));
    }
  }

  /** Close websocket connection and reset state. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      await this.stopAllMetrics();
      if (this._websocket) {
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    } finally {
      this._websocket = null;
      this._setupContextIds.clear();
      await this._callEventHandler("on_disconnected");
    }
  }

  /** Get active websocket connection or raise exception. */
  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /** Flush any pending audio synthesis. */
  override async flushAudio(contextId: string | null = null): Promise<void> {
    const flushId = contextId || this.getActiveAudioContextId();
    if (!flushId || !this._websocket) {
      return;
    }
    try {
      const msg = { type: "end_of_stream", client_req_id: flushId };
      await this._websocket.send(pyJsonDumps(msg));
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof ConnectionClosedOK) {
        logger.debug(`${this}: connection closed normally during flush`);
      } else {
        logger.error(`${this} exception: ${errorMessage(e)}`);
      }
    }
  }

  /**
   * Called when an audio context is cancelled due to an interruption.
   *
   * No WebSocket message is needed: audio from the interrupted
   * `client_req_id` will be silently dropped by the base class once the audio
   * context no longer exists.
   */
  override async onAudioContextInterrupted(contextId: string): Promise<void> {
    await this.stopAllMetrics();
    await super.onAudioContextInterrupted(contextId);
  }

  /**
   * Called after an audio context has finished playing all of its audio.
   *
   * No close message is needed: Gradium signals completion with an
   * `end_of_stream` message (handled in `_receiveMessages`), after which the
   * server-side context is already closed.
   */
  override async onAudioContextCompleted(contextId: string): Promise<void> {
    await super.onAudioContextCompleted(contextId);
  }

  /** Process incoming websocket messages, demultiplexing by client_req_id. */
  override async _receiveMessages(): Promise<void> {
    // TODO(laurent) upstream: This should not be necessary as it should happen
    // when receiving the messages but this does not seem to always be the case
    // and that may lead to a busy polling loop.
    if (this._websocket && this._websocket.state === State.CLOSED) {
      throw new ConnectionClosedOK(null, "");
    }
    for await (const message of this._getWebsocket()) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      const msg = pyJsonLoads(text) as Dict;
      const ctxId: string | undefined = msg.client_req_id ?? undefined;

      if (msg.type === "audio") {
        if (!ctxId || !this.audioContextAvailable(ctxId)) {
          continue;
        }
        const frame = new TTSAudioRawFrame({
          audio: base64ToBytes(msg.audio),
          sampleRate: this.sampleRate,
          numChannels: 1,
          contextId: ctxId,
        });
        await this.appendToAudioContext(ctxId, frame);
      } else if (msg.type === "text") {
        if (ctxId && this.audioContextAvailable(ctxId)) {
          await this.addWordTimestamps([[msg.text, msg.start_s]], ctxId);
        }
      } else if (msg.type === "ready") {
        // Nothing to do.
      } else if (msg.type === "end_of_stream") {
        if (ctxId && this.audioContextAvailable(ctxId)) {
          await this.appendToAudioContext(ctxId, new TTSStoppedFrame({ contextId: ctxId }));
          await this.removeAudioContext(ctxId);
        }
        if (ctxId) {
          this._setupContextIds.delete(ctxId);
        }
        await this.stopAllMetrics();
      } else if (msg.type === "error") {
        await this.pushFrame(new TTSStoppedFrame({ contextId: ctxId }));
        await this.stopAllMetrics();
        await this.pushError(`Error: ${msg.message ?? pyJsonDumps(msg)}`);
      }
    }
  }

  /**
   * Generate speech from text using Gradium's streaming API.
   *
   * @param text The text to convert to speech.
   * @param contextId Unique identifier for this TTS context.
   * @returns Audio frames containing the synthesized speech.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        this._websocket = null;
        await this._connect();
      }

      try {
        const ws = this._getWebsocket();
        if (!this._setupContextIds.has(contextId)) {
          await ws.send(pyJsonDumps(this._buildSetupMsg(contextId)));
          this._setupContextIds.add(contextId);
        }
        const msg = this._buildTextMsg(text, contextId);
        await ws.send(pyJsonDumps(msg));
        await this.startTtsUsageMetrics(text);
      } catch (e) {
        rethrowIfCancelled(e);
        yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
        yield new TTSStoppedFrame({ contextId });
        await this._disconnect();
        await this._connect();
        return;
      }
      yield null;
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    }
  }
}
