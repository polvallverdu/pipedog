// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/transports/websocket.mdx (server). Type-checked on every docs build.

// #region usage
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";
import {
  SingleClientWebsocketServerParams,
  SingleClientWebsocketServerTransport,
} from "@pipedog/transport-websocket/server";

const transport = new SingleClientWebsocketServerTransport(
  new SingleClientWebsocketServerParams({
    audioInEnabled: true,
    audioOutEnabled: true,
    serializer: new ProtobufFrameSerializer(),
  }),
  { host: "localhost", port: 8765 },
);

transport.eventHandler("on_websocket_ready", async () => {
  console.log("listening on ws://localhost:8765");
});
transport.eventHandler("on_client_connected", async () => {
  console.log("client connected");
});

const pipeline = new Pipeline([
  transport.input(),
  // ... STT, LLM context aggregators, LLM, TTS
  transport.output(),
]);

const runner = new WorkerRunner();
await runner.addWorkers(new PipelineWorker(pipeline));
await runner.run();
// #endregion usage
