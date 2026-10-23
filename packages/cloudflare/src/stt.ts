// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Deepgram Nova-3 streaming speech-to-text on Workers AI (`@cf/deepgram/nova-3`).
 *
 * Workers AI proxies Deepgram's `/v1/listen` WebSocket protocol for Nova-3:
 * raw audio in, `Results` / `SpeechStarted` / `UtteranceEnd` JSON out, and
 * the `Finalize`, `KeepAlive` and `CloseStream` control messages. So this is
 * `DeepgramSTTService` (from `@pipedog/deepgram`) with a client that opens
 * the socket through Workers AI instead of `api.deepgram.com`. The model is
 * in the URL path (or the binding call); every other Deepgram parameter is
 * sent as the session's input.
 */

import {
  type DeepgramClient,
  DeepgramSTTService,
  type DeepgramSTTServiceOptions,
  DeepgramSTTSettings,
  ListenV1Connection,
  type ListenV1ConnectParams,
} from "@pipedog/deepgram/stt";
import {
  splitConnectionOptions,
  type WorkersAIClient,
  type WorkersAIConnectionOptions,
  type WorkersAIWebSocketParams,
} from "./client.ts";

/** The Nova-3 model on Workers AI. */
export const WORKERS_AI_NOVA_3_MODEL = "@cf/deepgram/nova-3";

/** Settings for `WorkersAINova3STTService`: Deepgram's, with `model` a Workers AI model ID. */
export class WorkersAINova3STTSettings extends DeepgramSTTSettings {}

export interface WorkersAINova3STTServiceOptions
  extends Omit<DeepgramSTTServiceOptions, "apiKey" | "baseUrl" | "webSocketFactory" | "settings">,
    WorkersAIConnectionOptions {
  /**
   * Runtime-updatable settings (Deepgram's). `model` is the Workers AI model
   * ID, `"@cf/deepgram/nova-3"` by default.
   */
  settings?: DeepgramSTTSettings | null;
}

/** One session parameter as a string, as it appears in the query string. */
function paramValue(value: unknown): string {
  return String(value);
}

/**
 * A `DeepgramClient` stand-in whose `listen.v1.connect()` opens the session
 * through Workers AI.
 */
export function workersAIDeepgramClient(
  client: WorkersAIClient,
  defaultModel: string = WORKERS_AI_NOVA_3_MODEL,
): DeepgramClient {
  const connect = async (params: ListenV1ConnectParams): Promise<ListenV1Connection> => {
    const { model, ...rest } = params;
    const session: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(rest)) {
      session[key] = Array.isArray(value) ? value.map(paramValue) : paramValue(value);
    }
    const modelId = typeof model === "string" && model.startsWith("@") ? model : defaultModel;
    const ws = await client.connectWebSocket(modelId, session as WorkersAIWebSocketParams);
    return new ListenV1Connection(ws);
  };
  // The service only uses `listen.v1.connect()`; DeepgramClient's private
  // fields make the stand-in nominally different, hence the cast.
  return {
    apiKey: "",
    environment: { base: client.baseUrl, production: client.baseUrl, agent: client.baseUrl },
    webSocketFactory: null,
    listen: { v1: { connect } },
  } as unknown as DeepgramClient;
}

/**
 * Deepgram Nova-3 streaming speech-to-text on Workers AI.
 *
 * Behaves like `DeepgramSTTService`: interim and final transcriptions,
 * `Finalize` when the user stops speaking, keepalives, and reconnects. Use
 * it with a VAD and a turn strategy (or Smart Turn), as with Deepgram.
 *
 * @example
 * const stt = new WorkersAINova3STTService({ ai: env.AI });
 */
export class WorkersAINova3STTService extends DeepgramSTTService {
  static override Settings: typeof WorkersAINova3STTSettings = WorkersAINova3STTSettings;

  protected _workersAI: WorkersAIClient;

  constructor(options: WorkersAINova3STTServiceOptions) {
    const [client, rest] = splitConnectionOptions(options);
    const settings = new WorkersAINova3STTSettings({ model: WORKERS_AI_NOVA_3_MODEL });
    if (options.settings !== undefined && options.settings !== null) {
      settings.applyUpdate(options.settings);
    }
    super({ ...rest, apiKey: "", settings });
    this._workersAI = client;
    this._client = workersAIDeepgramClient(this._workersAI);
  }

  /** The client the service reaches Workers AI with. */
  get workersAI(): WorkersAIClient {
    return this._workersAI;
  }
}
