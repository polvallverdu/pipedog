// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The two voice endpoints, as fetch handlers. Each framework's snippet mounts
// them; see the framework folders.

import { createTask } from "@pipedog/asyncio";
import { TransportParams } from "@pipedog/core/transports/base_transport";
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";
import { smallWebRTCOfferHandler } from "@pipedog/transport-smallwebrtc/http";
import { SmallWebRTCRequestHandler } from "@pipedog/transport-smallwebrtc/request_handler";
import { SmallWebRTCTransport } from "@pipedog/transport-smallwebrtc/transport";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";
import { runAgent } from "./agent.ts";

/**
 * WebRTC signalling: POST an SDP offer, get the answer. The media runs over UDP,
 * so this needs a long-lived server, not serverless functions.
 */
export const offer = smallWebRTCOfferHandler(new SmallWebRTCRequestHandler(), (connection) => {
  createTask(
    () =>
      runAgent(
        new SmallWebRTCTransport(
          connection,
          new TransportParams({ audioInEnabled: true, audioOutEnabled: true }),
        ),
      ),
    "voice-agent",
  );
});

/** Runs one agent on a WebSocket connection, with protobuf audio frames. */
export function runSocketAgent(connection: WebsocketConnection): Promise<void> {
  return runAgent(
    new FastAPIWebsocketTransport(
      connection,
      new FastAPIWebsocketParams({
        audioInEnabled: true,
        audioOutEnabled: true,
        serializer: new ProtobufFrameSerializer(),
      }),
    ),
  );
}

/** A WebSocket endpoint as a fetch handler, where the runtime upgrades from fetch. */
export const socket = websocketFetchHandler(runSocketAgent);
