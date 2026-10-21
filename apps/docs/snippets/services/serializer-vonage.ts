// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/serializers/vonage.mdx. Type-checked on every docs build.

// #region usage
import { VonageFrameSerializer } from "@pipedog/serializer-vonage/vonage";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";

async function runSession(connection: WebsocketConnection): Promise<void> {
  const serializer = new VonageFrameSerializer({
    // The rate you gave the Audio Connector (audio/l16;rate=16000).
    params: new VonageFrameSerializer.InputParams({ vonageSampleRate: 16000 }),
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

// The Audio Connector's websocket.uri points here.
const handler = websocketFetchHandler(runSession);
// #endregion usage
