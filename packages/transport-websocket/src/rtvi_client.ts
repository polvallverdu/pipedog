// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/websocket/rtvi_client.py

/**
 * A Pipecat pipeline acting as an RTVI *client*.
 *
 * `RTVIClientTransport` connects to a bot that runs an RTVI *server* transport
 * (e.g. the eval transport) and exchanges frames with it: the bot's RTVI server
 * messages arrive as pipeline frames, and outgoing frames (audio, pre-built RTVI
 * client messages) are sent to the bot. It is the client-side counterpart to a bot
 * running an RTVI server transport, and the foundation for the eval harness and
 * eval simulations (see `docs/design/eval-simulations.md`).
 *
 * It wraps `WebsocketClientTransport`, defaulting its serializer to
 * `RTVIClientSerializer` and adding the `client-ready` / `bot-ready` handshake.
 */

import * as RTVI from "@pipedog/core/processors/frameworks/rtvi/models";
import { RTVIClientSerializer } from "@pipedog/serializer-rtvi-client/rtvi_client";

import { WebsocketClientParams, WebsocketClientTransport } from "./client.ts";
import type { WebsocketConnection, WebsocketData } from "./socket.ts";

/**
 * WebSocket transport that speaks RTVI as a client to a bot.
 *
 * Event handlers available:
 *
 * - on_connected: the WebSocket connection was established
 * - on_disconnected: the WebSocket connection was closed
 * - on_bot_ready: the bot answered the `client-ready` handshake with `bot-ready`
 *
 * @example
 * const transport = new RTVIClientTransport("ws://localhost:7860");
 *
 * transport.eventHandler("on_bot_ready", async (transport) => {
 *   ...
 * });
 */
export class RTVIClientTransport extends WebsocketClientTransport {
  protected _botReady = false;

  /**
   * Initialize the RTVI client transport.
   *
   * @param uri The WebSocket URI of the bot's RTVI server transport.
   * @param params Optional transport parameters. The serializer defaults to
   *   `RTVIClientSerializer` when not provided.
   */
  constructor(uri: string, params: WebsocketClientParams | null = null) {
    const p = params ?? new WebsocketClientParams();
    p.serializer = p.serializer ?? new RTVIClientSerializer();
    // An RTVI raw-audio message carries bare PCM with its own sample rate and
    // channel count, so a WAV header is never valid on this wire.
    p.addWavHeader = false;
    super(uri, p);

    this._botReady = false;
    this._registerEventHandler("on_bot_ready");
  }

  /** Whether the bot has answered the handshake with `bot-ready`. */
  get botReady(): boolean {
    return this._botReady;
  }

  /** On connect, fire the user's handler and start the RTVI handshake. */
  protected override async _onConnected(websocket: WebsocketConnection): Promise<void> {
    await super._onConnected(websocket);
    await this._sendClientReady();
  }

  /** Watch for `bot-ready` to complete the handshake, then dispatch normally. */
  protected override async _onMessage(
    websocket: WebsocketConnection,
    message: WebsocketData,
  ): Promise<void> {
    if (!this._botReady && RTVIClientTransport._isBotReady(message)) {
      this._botReady = true;
      await this._callEventHandler("on_bot_ready");
    }
    await super._onMessage(websocket, message);
  }

  /** Send the RTVI `client-ready` message that starts the handshake. */
  protected async _sendClientReady(): Promise<void> {
    const message = new RTVI.Message({
      type: "client-ready",
      id: "client-ready",
      data: new RTVI.ClientReadyData({
        version: RTVI.PROTOCOL_VERSION,
        about: new RTVI.AboutClientData({ library: "pipecat" }),
      }).modelDump(),
    });
    await this._session.send(JSON.stringify(message.modelDump()));
  }

  /** Return true if `message` is an RTVI `bot-ready` message. */
  protected static _isBotReady(message: unknown): boolean {
    let data: unknown;
    try {
      if (typeof message === "string") {
        data = JSON.parse(message);
      } else if (message instanceof Uint8Array) {
        data = JSON.parse(new TextDecoder().decode(message));
      } else {
        return false;
      }
    } catch (e) {
      if (e instanceof SyntaxError || e instanceof TypeError) return false;
      throw e;
    }
    return (
      typeof data === "object" &&
      data !== null &&
      !Array.isArray(data) &&
      (data as Record<string, unknown>).label === RTVI.MESSAGE_LABEL &&
      (data as Record<string, unknown>).type === "bot-ready"
    );
  }
}
