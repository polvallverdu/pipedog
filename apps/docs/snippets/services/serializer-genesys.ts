// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/serializers/genesys.mdx. Type-checked on every docs build.

// #region usage
import { AudioHookChannel, GenesysAudioHookSerializer } from "@pipedog/serializer-genesys/genesys";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";

async function runSession(connection: WebsocketConnection): Promise<void> {
  const serializer = new GenesysAudioHookSerializer({
    params: new GenesysAudioHookSerializer.InputParams({
      channel: AudioHookChannel.EXTERNAL,
      supportedLanguages: ["en-US", "es-ES"],
      selectedLanguage: "en-US",
    }),
  });

  const transport = new FastAPIWebsocketTransport(
    connection,
    new FastAPIWebsocketParams({
      audioInEnabled: true,
      audioOutEnabled: true,
      serializer,
      // Genesys rate-limits (HTTP 429) many small audio messages.
      fixedAudioPacketSize: 1600,
    }),
  );
  // ... build and run the pipeline with transport.input() and transport.output()
}

// The AudioHook integration's connection URI points here.
const handler = websocketFetchHandler(runSession);
// #endregion usage

// #region variables
const serializer = new GenesysAudioHookSerializer();

serializer.eventHandler("on_open", async () => {
  // From Genesys's "open" message.
  const ani = serializer.participant?.ani;
  const queue = serializer.inputVariables?.queue_name;
  console.log(`call from ${ani} for ${queue}`);
});

// Returned to the Architect flow in "closed" (and "disconnect").
serializer.setOutputVariables({ intent: "billing", resolved: true });
// #endregion variables
