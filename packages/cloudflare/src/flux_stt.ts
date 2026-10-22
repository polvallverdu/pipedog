// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Deepgram Flux on Workers AI (`@cf/deepgram/flux`).
 *
 * Workers AI hosts Flux and proxies Deepgram's Flux WebSocket protocol: raw
 * 16-bit PCM goes in as binary messages, and turn events (`StartOfTurn`,
 * `Update`, `EagerEndOfTurn`, `TurnResumed`, `EndOfTurn`) come back as JSON.
 * So this service is `DeepgramFluxSTTService` (from `@pipedog/deepgram`) with
 * a different way to open the socket, and it emits exactly the frames that
 * service emits: Flux owns turn detection, so it replaces VAD + Smart Turn.
 *
 * Differences from Deepgram's own endpoint, handled here:
 * - The model is in the URL path (or the binding call), not a `model` query
 *   parameter, and the session parameters are the model's input schema:
 *   `encoding`, `sample_rate`, `eot_threshold`, `eager_eot_threshold`,
 *   `eot_timeout_ms`, `keyterm`, `mip_opt_out`, `tag`.
 * - Workers AI's documented output has no `type` field, and does not document
 *   Deepgram's `Connected` message. A message with an `event` but no `type`
 *   is read as a `TurnInfo`, and the connection counts as confirmed as soon
 *   as the socket opens.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { State } from "@pipedog/core/services/websocket_service";
import { logger } from "@pipedog/core/utils/logger";
import { assertGiven } from "@pipedog/core/utils/types";
import {
  _describeRefusal,
  DeepgramFluxSTTService,
  type DeepgramFluxSTTServiceOptions,
  DeepgramFluxSTTSettings,
} from "@pipedog/deepgram/flux/stt";
import {
  splitConnectionOptions,
  type WorkersAIClient,
  type WorkersAIConnectionOptions,
  type WorkersAIWebSocketParams,
} from "./client.ts";

/** The Flux model on Workers AI. */
export const WORKERS_AI_FLUX_MODEL = "@cf/deepgram/flux";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Settings for `WorkersAIFluxSTTService`: Deepgram Flux's, with `model` a Workers AI model ID. */
export class WorkersAIFluxSTTSettings extends DeepgramFluxSTTSettings {}

export interface WorkersAIFluxSTTServiceOptions
  extends Omit<DeepgramFluxSTTServiceOptions, "apiKey" | "url" | "webSocketFactory" | "settings">,
    WorkersAIConnectionOptions {
  /**
   * Runtime-updatable settings. `model` is the Workers AI model ID (default
   * `"@cf/deepgram/flux"`). `languageHints`, `numerals`, `profanityFilter`,
   * `redact` and `minConfidence` are Deepgram options that Workers AI does not
   * document: they are sent as Deepgram sends them, and may be ignored.
   */
  settings?: DeepgramFluxSTTSettings | null;
}

/**
 * Deepgram Flux speech-to-text on Workers AI.
 *
 * Conversational STT with turn detection built in: emits the same frames and
 * events as `DeepgramFluxSTTService` (`on_start_of_turn`, `on_end_of_turn`,
 * `on_eager_end_of_turn`, `on_turn_resumed`), and recommends turn strategies
 * that leave turn detection to Flux, so no VAD or Smart Turn is needed.
 *
 * @example
 * // Inside a Worker
 * const stt = new WorkersAIFluxSTTService({ ai: env.AI });
 * // Anywhere else
 * const stt = new WorkersAIFluxSTTService({ accountId, apiToken });
 */
export class WorkersAIFluxSTTService extends DeepgramFluxSTTService {
  static override Settings: typeof WorkersAIFluxSTTSettings = WorkersAIFluxSTTSettings;

  protected _workersAI: WorkersAIClient;

  constructor(options: WorkersAIFluxSTTServiceOptions) {
    const [client, rest] = splitConnectionOptions(options);
    const settings = new WorkersAIFluxSTTSettings({ model: WORKERS_AI_FLUX_MODEL });
    if (options.settings !== undefined && options.settings !== null) {
      settings.applyUpdate(options.settings);
    }
    super({ ...rest, apiKey: "", settings });
    this._workersAI = client;
  }

  /** The client the service reaches Workers AI with. */
  get workersAI(): WorkersAIClient {
    return this._workersAI;
  }

  /** The session parameters: the model's input schema, from the current settings. */
  protected _buildSessionParams(): WorkersAIWebSocketParams {
    const s = this._settings;
    const params: Record<string, string | string[]> = {
      encoding: this._encoding,
      sample_rate: String(this.sampleRate),
    };
    if (s.eagerEotThreshold !== null) params.eager_eot_threshold = String(s.eagerEotThreshold);
    if (s.eotThreshold !== null) params.eot_threshold = String(s.eotThreshold);
    if (s.eotTimeoutMs !== null) params.eot_timeout_ms = String(s.eotTimeoutMs);
    if (s.numerals !== null) params.numerals = String(s.numerals);
    if (s.profanityFilter !== null) params.profanity_filter = String(s.profanityFilter);
    if (s.redact !== null) params.redact = String(s.redact);
    if (this._mipOptOut !== null) params.mip_opt_out = String(this._mipOptOut);
    const keyterm = assertGiven(s.keyterm);
    if (keyterm.length > 0) params.keyterm = [...keyterm];
    if (this._tag.length > 0) params.tag = [...this._tag];
    return params;
  }

  /** Open the Flux session through the binding or the REST WebSocket. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }
      this._connectionEstablishedEvent.clear();
      this._userIsSpeaking = false;
      this._websocket = await this._workersAI.connectWebSocket(
        String(this._settings.model),
        this._buildSessionParams(),
      );
      logger.debug(`${this}: Workers AI Flux session opened (${this._workersAI.mode})`);
      // Workers AI does not document Deepgram's `Connected` message, so an
      // open socket is the confirmation. A `Connected`, if one comes, sets it again.
      this._connectionEstablishedEvent.set();
    } catch (e) {
      rethrowIfCancelled(e);
      const refusal = _describeRefusal(e);
      await this.pushError(refusal ?? `Workers AI Flux connection failed: ${errorMessage(e)}`, {
        exception: e,
      });
      this._websocket = null;
      await this._callEventHandler("on_connection_error", refusal ?? errorMessage(e));
    }
  }

  /** Read Workers AI's turn messages, which carry an `event` but no `type`, as `TurnInfo`. */
  protected override async _handleMessage(data: unknown): Promise<void> {
    if (
      typeof data === "object" &&
      data !== null &&
      !Array.isArray(data) &&
      !("type" in data) &&
      "event" in data
    ) {
      await super._handleMessage({ type: "TurnInfo", ...data });
      return;
    }
    await super._handleMessage(data);
  }
}
