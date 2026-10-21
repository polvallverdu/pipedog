// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/serializers/plivo.mdx. Type-checked on every docs build.

// #region usage
import { parseTelephonyWebsocket } from "@pipedog/runner/utils";
import { PlivoFrameSerializer } from "@pipedog/serializer-plivo/plivo";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";

async function runCall(connection: WebsocketConnection): Promise<void> {
  // Plivo's "start" message carries the stream and call IDs.
  const [, callData] = await parseTelephonyWebsocket(connection);

  const serializer = new PlivoFrameSerializer({
    streamId: callData.streamId ?? "",
    callId: callData.callId,
    authId: process.env.PLIVO_AUTH_ID,
    authToken: process.env.PLIVO_AUTH_TOKEN,
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

// The <Stream> in your Plivo XML points here.
const handler = websocketFetchHandler(runCall);
// #endregion usage

// #region no-hangup
const noHangUp = new PlivoFrameSerializer({
  streamId: "stream-id",
  params: new PlivoFrameSerializer.InputParams({ autoHangUp: false }),
});
// #endregion no-hangup
