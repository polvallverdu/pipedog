// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/transports/websocket.mdx (client). Type-checked on every docs build.

// #region usage
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import {
  WebsocketClientParams,
  WebsocketClientTransport,
} from "@pipedog/transport-websocket/client";
import { RTVIClientTransport } from "@pipedog/transport-websocket/rtvi_client";

// The serializer defaults to ProtobufFrameSerializer.
const client = new WebsocketClientTransport(
  "ws://localhost:8765",
  new WebsocketClientParams({
    audioInEnabled: true,
    audioOutEnabled: true,
    additionalHeaders: { Authorization: `Bearer ${process.env.BOT_TOKEN ?? ""}` },
  }),
);

client.eventHandler("on_connected", async () => {
  console.log("connected to the bot");
});

const pipeline = new Pipeline([client.input(), client.output()]);
// #endregion usage

// #region rtvi
// Talks RTVI to a bot: sends client-ready on connect and waits for bot-ready.
const rtvi = new RTVIClientTransport("ws://localhost:7860");

rtvi.eventHandler("on_bot_ready", async () => {
  console.log("bot ready:", rtvi.botReady);
});
// #endregion rtvi
