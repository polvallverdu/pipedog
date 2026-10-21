// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/transport.py

/**
 * The bot's eval transport parameters.
 *
 * The harness sets per-connection flags. `skip_tts` silences the bot's speech
 * for the session (text mode), applied before `on_client_connected` so a
 * greeting made there is silent too. `capture_bot_audio` forwards the bot's
 * synthesized audio to the harness, for transcription and the recording.
 * `capture_bot_images` reports each image the bot outputs, by size and format.
 *
 * Upstream's WebSocket server, `EvalTransport`, is deprecated and not ported
 * (nor its URL query flags and server input/output transports, which only it
 * used): `EvalFastAPIWebsocketTransport` (in `./fastapi_transport.ts`) is the
 * same transport over a WebSocket the bot accepted itself, which the dev
 * runner hands it. This module keeps the parameters it uses.
 */

import { SingleClientWebsocketServerParams } from "@pipedog/transport-websocket/server";

/** Options for {@link EvalTransportParams}. */
export type { SingleClientWebsocketServerParamsOptions as EvalTransportParamsOptions } from "@pipedog/transport-websocket/server";

/** Parameters of the eval transport, so a bot's `transport_params` names it as such. */
export class EvalTransportParams extends SingleClientWebsocketServerParams {}
