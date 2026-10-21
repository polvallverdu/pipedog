// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/serializers/telnyx.mdx. Type-checked on every docs build.

// #region usage
import { TelnyxFrameSerializer } from "@pipedog/serializer-telnyx/telnyx";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";

async function runCall(connection: WebsocketConnection): Promise<void> {
  // Telnyx sends a "connected" message, then "start" with the call details.
  await connection.recv();
  const start = JSON.parse(String(await connection.recv()));

  const serializer = new TelnyxFrameSerializer({
    streamId: start.stream_id,
    callControlId: start.start.call_control_id,
    outboundEncoding: start.start.media_format.encoding,
    inboundEncoding: "PCMU",
    apiKey: process.env.TELNYX_API_KEY ?? "",
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

// The WebSocket URL you give Telnyx's media streaming points here.
const handler = websocketFetchHandler(runCall);
// #endregion usage

// #region no-hangup
const noHangUp = new TelnyxFrameSerializer({
  streamId: "stream-id",
  outboundEncoding: "PCMU",
  inboundEncoding: "PCMU",
  params: new TelnyxFrameSerializer.InputParams({ autoHangUp: false }),
});
// #endregion no-hangup
