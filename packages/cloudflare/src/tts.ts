// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Deepgram Aura text-to-speech on Workers AI.
 *
 * Models: `@cf/deepgram/aura-2-en` (default), `@cf/deepgram/aura-2-es` and
 * `@cf/deepgram/aura-1`. The voice is Workers AI's `speaker` input (`luna`,
 * `asteria`, `aquila`, ...), not a Deepgram model name.
 *
 * - `WorkersAIAuraTTSService` streams over a WebSocket. Workers AI proxies
 *   Deepgram's `/v1/speak` protocol (`Speak`, `Flush`, `Clear` and `Close`
 *   in, binary PCM and `Flushed` / `Cleared` out), so this is
 *   `DeepgramTTSService` (from `@pipedog/deepgram`) opening its socket
 *   through Workers AI.
 * - `WorkersAIAuraHttpTTSService` makes one request per sentence and streams
 *   the PCM body back. Use it if the WebSocket is unavailable to you.
 */

import { abortable, rethrowIfCancelled } from "@pipedog/asyncio";
import { ErrorFrame, type Frame } from "@pipedog/core/frames/frames";
import type { TTSSettings } from "@pipedog/core/services/settings";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { State } from "@pipedog/core/services/websocket_service";
import { logger } from "@pipedog/core/utils/logger";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { isGiven } from "@pipedog/core/utils/types";
import {
  DeepgramTTSService,
  type DeepgramTTSServiceOptions,
  DeepgramTTSSettings,
} from "@pipedog/deepgram/tts";
import {
  splitConnectionOptions,
  type WorkersAIClient,
  type WorkersAIConnectionOptions,
} from "./client.ts";

/** Aura models on Workers AI. */
export const WorkersAIAuraModel = {
  AURA_2_EN: "@cf/deepgram/aura-2-en",
  AURA_2_ES: "@cf/deepgram/aura-2-es",
  AURA_1: "@cf/deepgram/aura-1",
} as const;
export type WorkersAIAuraModel = (typeof WorkersAIAuraModel)[keyof typeof WorkersAIAuraModel];

/** The default speaker of each Aura model, from Workers AI's input schema. */
export const DEFAULT_AURA_SPEAKERS: Readonly<Record<string, string>> = {
  [WorkersAIAuraModel.AURA_2_EN]: "luna",
  [WorkersAIAuraModel.AURA_2_ES]: "aquila",
  [WorkersAIAuraModel.AURA_1]: "angus",
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Settings for the Workers AI Aura services: `model` is the Workers AI model
 * ID and `voice` the `speaker`. Deepgram's `speed` is not in Workers AI's
 * schema and is not sent.
 */
export class WorkersAIAuraTTSSettings extends DeepgramTTSSettings {}

/** The model and speaker settings resolve to, filling the model's default speaker. */
function auraDefaults(settings: DeepgramTTSSettings | null | undefined): WorkersAIAuraTTSSettings {
  const model =
    settings && isGiven(settings.model) && settings.model
      ? settings.model
      : WorkersAIAuraModel.AURA_2_EN;
  const resolved = new WorkersAIAuraTTSSettings({
    model,
    voice: DEFAULT_AURA_SPEAKERS[model] ?? "luna",
  });
  if (settings) resolved.applyUpdate(settings);
  return resolved;
}

export interface WorkersAIAuraTTSServiceOptions
  extends Omit<
      DeepgramTTSServiceOptions,
      "apiKey" | "baseUrl" | "webSocketFactory" | "mipOptOut" | "settings"
    >,
    WorkersAIConnectionOptions {
  /**
   * Runtime-updatable settings. `model` is the Workers AI model ID (default
   * `"@cf/deepgram/aura-2-en"`), `voice` the speaker (default: the model's).
   */
  settings?: DeepgramTTSSettings | null;
}

/**
 * Deepgram Aura streaming text-to-speech on Workers AI, over a WebSocket.
 *
 * Text is sent as it arrives (`Speak`) and flushed at the end of each LLM
 * response; an interruption sends `Clear`. Output is 16-bit PCM at the
 * service's sample rate.
 *
 * @example
 * const tts = new WorkersAIAuraTTSService({
 *   ai: env.AI,
 *   settings: new WorkersAIAuraTTSService.Settings({ voice: "asteria" }),
 * });
 */
export class WorkersAIAuraTTSService extends DeepgramTTSService {
  static override Settings: typeof WorkersAIAuraTTSSettings = WorkersAIAuraTTSSettings;

  protected _workersAI: WorkersAIClient;
  /** The Workers AI model ID; `DeepgramTTSService` keeps `model` in sync with `voice`. */
  protected _workersModel: string;

  constructor(options: WorkersAIAuraTTSServiceOptions) {
    const [client, rest] = splitConnectionOptions(options);
    const settings = auraDefaults(options.settings);
    super({ ...rest, apiKey: "", settings });
    this._workersModel = String(settings.model);
    this._settings.model = this._workersModel;
    this._syncModelNameToMetrics();
    this._workersAI = client;
  }

  /** The client the service reaches Workers AI with. */
  get workersAI(): WorkersAIClient {
    return this._workersAI;
  }

  /** Apply a settings delta; `model` stays the Workers AI model ID. */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    if (isGiven(delta.model) && delta.model) {
      this._workersModel = String(delta.model);
    }
    const changed = await super._updateSettings(delta);
    this._settings.model = this._workersModel;
    this._syncModelNameToMetrics();
    return changed;
  }

  /** Open the Aura session through the binding or the REST WebSocket. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }
      this._websocket = await this._workersAI.connectWebSocket(this._workersModel, {
        speaker: String(this._settings.voice),
        encoding: this._encoding,
        sample_rate: String(this.sampleRate),
      });
      logger.debug(`${this}: Workers AI Aura session opened (${this._workersAI.mode})`);
      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} exception: ${errorMessage(e)}`);
      await this.pushErrorFrame(
        new ErrorFrame({ error: `${this} error: ${errorMessage(e)}`, exception: e }),
      );
      this._websocket = null;
      await this._callEventHandler("on_connection_error", errorMessage(e));
    }
  }
}

export interface WorkersAIAuraHttpTTSServiceOptions
  extends TTSServiceOptions,
    WorkersAIConnectionOptions {
  /** Runtime-updatable settings: `model` (Workers AI model ID) and `voice` (speaker). */
  settings?: DeepgramTTSSettings | null;
}

/**
 * Deepgram Aura text-to-speech on Workers AI, one request per sentence.
 *
 * Asks for raw 16-bit PCM (`encoding: "linear16"`, `container: "none"`) at
 * the service's sample rate and streams the response body as audio frames.
 */
export class WorkersAIAuraHttpTTSService extends TTSService {
  static Settings: typeof WorkersAIAuraTTSSettings = WorkersAIAuraTTSSettings;
  declare protected _settings: WorkersAIAuraTTSSettings;

  static {
    installTracedTts(WorkersAIAuraHttpTTSService.prototype, "runTts");
  }

  protected _workersAI: WorkersAIClient;

  constructor(options: WorkersAIAuraHttpTTSServiceOptions) {
    const [client, rest] = splitConnectionOptions(options);
    super({
      ...rest,
      sampleRate: options.sampleRate ?? null,
      pushStartFrame: true,
      pushStopFrames: true,
      settings: auraDefaults(options.settings),
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

  /** Synthesize `text` and stream the PCM back as audio frames. */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      await this.startTtfbMetrics();
      const response = await this._workersAI.runRaw(String(this._settings.model), {
        text,
        speaker: String(this._settings.voice),
        encoding: "linear16",
        container: "none",
        sample_rate: this.sampleRate,
      });
      await this.startTtsUsageMetrics(text);
      for await (const frame of this._streamAudioFramesFromIterator(readBody(response.body), {
        contextId,
      })) {
        await this.stopTtfbMetrics();
        yield frame;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Workers AI Aura error: ${errorMessage(e)}`, exception: e });
    }
  }
}

/** Yield a response body's chunks as they arrive. */
async function* readBody(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array, void, unknown> {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await abortable(reader.read());
      if (done) break;
      if (value && value.length > 0) yield value;
    }
  } finally {
    try {
      await reader.cancel();
    } catch (e) {
      rethrowIfCancelled(e);
    }
  }
}
