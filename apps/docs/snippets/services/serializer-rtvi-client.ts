// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/serializers/rtvi-client.mdx. Type-checked on every docs build.

// #region usage
import { OutputTransportMessageFrame } from "@pipedog/core/frames/frames";
import { RTVIClientSerializer } from "@pipedog/serializer-rtvi-client/rtvi_client";
import {
  WebsocketClientParams,
  WebsocketClientTransport,
} from "@pipedog/transport-websocket/client";

// RTVIClientTransport uses this serializer by default. With the plain client
// transport, pass it yourself and turn off WAV headers.
const transport = new WebsocketClientTransport(
  "ws://localhost:7860",
  new WebsocketClientParams({
    audioInEnabled: true,
    audioOutEnabled: true,
    addWavHeader: false,
    serializer: new RTVIClientSerializer(),
  }),
);
// #endregion usage

// #region send
// An RTVI client message, built as a transport message frame. The serializer
// sends any message labelled "rtvi-ai" as it is.
const sendText = new OutputTransportMessageFrame({
  message: {
    label: "rtvi-ai",
    type: "send-text",
    id: "1",
    data: { content: "Hello, bot" },
  },
});
// #endregion send
