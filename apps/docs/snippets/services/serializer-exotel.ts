// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/serializers/exotel.mdx. Type-checked on every docs build.

// #region usage
import { parseTelephonyWebsocket } from "@pipedog/runner/utils";
import { ExotelFrameSerializer } from "@pipedog/serializer-exotel/exotel";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";

async function runCall(connection: WebsocketConnection): Promise<void> {
  // Exotel sends "connected", then "start" with the stream and call SIDs.
  const [, callData] = await parseTelephonyWebsocket(connection);

  const serializer = new ExotelFrameSerializer({
    streamSid: callData.streamId ?? "",
    callSid: callData.callId,
  });

  const transport = new FastAPIWebsocketTransport(
    connection,
    new FastAPIWebsocketParams({
      audioInEnabled: true,
      audioOutEnabled: true,
      addWavHeader: false,
      serializer,
    }),
  );
  // ... build and run the pipeline with transport.input() and transport.output()
}

// The Voicebot applet's WebSocket URL points here.
const handler = websocketFetchHandler(runCall);
// #endregion usage
