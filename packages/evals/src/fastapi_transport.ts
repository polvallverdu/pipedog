// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/fastapi_transport.py

/**
 * The eval transport over a WebSocket the bot accepted itself.
 *
 * On Pipecat Cloud a session's WebSocket arrives already accepted, and the hops
 * in between pass on only the session body, never the URL's query. The harness
 * therefore sends its connection's flags as its first message, `eval-connect`,
 * which `createTransport` reads before building this transport with them.
 * `skip_tts` is applied before `on_client_connected`, so a greeting made there
 * is silent too.
 *
 * The connection is the session, so `on_client_disconnected` fires whenever
 * the harness disconnects, letting the bot end with it.
 *
 * As with `FastAPIWebsocketTransport`, the socket is any `FastAPIWebSocket`
 * your own server accepted ("bring your own socket"), on any runtime.
 */

import {
  type Frame,
  LLMConfigureOutputFrame,
  OutputImageRawFrame,
  UserImageRequestFrame,
} from "@pipedog/core/frames/frames";
import type { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { logger } from "@pipedog/core/utils/logger";
import {
  type FastAPIWebSocket,
  FastAPIWebsocketInputTransport,
  FastAPIWebsocketOutputTransport,
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
  type FastAPIWebsocketTransportOptions,
} from "@pipedog/transport-websocket/fastapi";
import { type EvalConnectionFlags, EvalSerializer } from "./serializer.ts";
import type { EvalTransportParams } from "./transport.ts";

/**
 * Input transport that serves the harness's image.
 *
 * A vision bot asks for the user's camera image; under eval there is no
 * camera, so the image the harness registered for the turn is served instead.
 * With no image registered, the request is answered with an error, so the
 * function call that made it still finishes.
 */
export class EvalFastAPIWebsocketInputTransport extends FastAPIWebsocketInputTransport {
  /** Serve image requests; otherwise behave like the base input transport. */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof UserImageRequestFrame) {
      await this._serveUserImage(frame);
    }
  }

  protected async _serveUserImage(request: UserImageRequestFrame): Promise<void> {
    const serializer = this._params.serializer;
    let image = null;
    if (serializer instanceof EvalSerializer) {
      image = await serializer.userImageFrame(request);
    }
    if (image === null) {
      await this._answerImageRequests([request], "No user image is registered.");
    } else {
      await this.pushFrame(image);
    }
  }
}

/**
 * Output transport that reports the bot's images to the harness.
 *
 * An image the bot outputs is handed to the serializer as it arrives, whether
 * or not the bot enabled video output; the serializer sends it only when the
 * harness asked.
 */
export class EvalFastAPIWebsocketOutputTransport extends FastAPIWebsocketOutputTransport {
  /** Report output images; otherwise behave like the base output transport. */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof OutputImageRawFrame) {
      await this._writeFrame(frame);
    }
  }
}

/**
 * The eval transport over an accepted WebSocket (see the module docstring).
 *
 * Event handlers available:
 *
 * - on_client_connected(transport, websocket): The harness connected
 * - on_client_disconnected(transport, websocket): The harness disconnected
 * - on_session_timeout(transport, websocket): Session timed out
 */
export class EvalFastAPIWebsocketTransport extends FastAPIWebsocketTransport {
  protected _flags: EvalConnectionFlags;
  declare protected _input: EvalFastAPIWebsocketInputTransport;
  declare protected _output: EvalFastAPIWebsocketOutputTransport;

  /**
   * Initialize the transport.
   *
   * @param websocket The accepted WebSocket, its `eval-connect` message
   *   already read.
   * @param params The bot's eval transport parameters.
   * @param flags The connection's flags, from its `eval-connect` message.
   * @param options.inputName Optional name for the input processor.
   * @param options.outputName Optional name for the output processor.
   */
  constructor(
    websocket: FastAPIWebSocket,
    params: EvalTransportParams,
    flags: EvalConnectionFlags,
    options: FastAPIWebsocketTransportOptions = {},
  ) {
    // Upstream: `FastAPIWebsocketParams(**params.model_dump())`.
    super(websocket, new FastAPIWebsocketParams({ ...params }), {
      inputName: options.inputName ?? null,
      outputName: options.outputName ?? null,
    });
    this._flags = flags;

    const serializer = this._params.serializer;
    if (serializer instanceof EvalSerializer) {
      serializer.setCaptureAudio(flags.captureBotAudio);
      serializer.setCaptureImages(flags.captureBotImages);
    }

    this._input = new EvalFastAPIWebsocketInputTransport(this, this._client, this._params, {
      name: this._inputName,
    });
    this._output = new EvalFastAPIWebsocketOutputTransport(this, this._client, this._params, {
      name: this._outputName,
    });
  }

  /** Get the eval input transport processor. */
  override input(): EvalFastAPIWebsocketInputTransport {
    return this._input;
  }

  /** Get the eval output transport processor. */
  override output(): EvalFastAPIWebsocketOutputTransport {
    return this._output;
  }

  /** Configure the bot's output for the connection, then proceed (config before any greeting). */
  protected override async _onClientConnected(websocket: FastAPIWebSocket): Promise<void> {
    const skipTts = this._flags.skipTts;
    logger.debug(
      `${this}: configuring eval LLM output with skip_tts=${skipTts ? "True" : "False"}`,
    );
    await this._input.pushFrame(new LLMConfigureOutputFrame({ skipTts }));
    await super._onClientConnected(websocket);
  }
}
