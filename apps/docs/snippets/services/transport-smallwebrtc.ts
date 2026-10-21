// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/transports/smallwebrtc.mdx. Type-checked on every docs build.

// #region usage
import { createServer } from "node:http";
import { createTask } from "@pipedog/asyncio";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { TransportParams } from "@pipedog/core/transports/base_transport";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { IceServer, type SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import { nodeRequestListener, smallWebRTCOfferHandler } from "@pipedog/transport-smallwebrtc/http";
import {
  ConnectionMode,
  SmallWebRTCRequestHandler,
} from "@pipedog/transport-smallwebrtc/request_handler";
import { SmallWebRTCTransport } from "@pipedog/transport-smallwebrtc/transport";

/** Runs one bot on a new peer connection. */
async function runBot(connection: SmallWebRTCConnection): Promise<void> {
  const transport = new SmallWebRTCTransport(
    connection,
    new TransportParams({ audioInEnabled: true, audioOutEnabled: true }),
  );

  const pipeline = new Pipeline([
    transport.input(),
    // ... STT, LLM context aggregators, LLM, TTS
    transport.output(),
  ]);
  const worker = new PipelineWorker(pipeline);
  const runner = new WorkerRunner({ handleSigint: false });

  transport.eventHandler("on_client_connected", async () => {
    console.log("client connected");
  });
  transport.eventHandler("on_client_disconnected", async () => {
    await runner.cancel();
  });

  await runner.addWorkers(worker);
  await runner.run();
}

// POST /api/offer takes the browser's SDP offer and answers it; PATCH sends ICE candidates.
const offer = smallWebRTCOfferHandler(new SmallWebRTCRequestHandler(), (connection) => {
  // Start the bot in the background: the answer is sent once this returns.
  createTask(() => runBot(connection), "voice-bot");
});

Bun.serve({
  port: 7860,
  fetch(request) {
    if (new URL(request.url).pathname === "/api/offer") return offer(request);
    return new Response("not found", { status: 404 });
  },
});
// #endregion usage

// #region node
// On Node, serve the same handler with the http module instead of Bun.serve.
createServer(nodeRequestListener(offer)).listen(7860);
// #endregion node

// #region ice
// A TURN server, for peers behind NATs that block direct connections.
const handler = new SmallWebRTCRequestHandler({
  iceServers: [
    new IceServer({ urls: "stun:stun.l.google.com:19302" }),
    new IceServer({
      urls: "turn:turn.example.com:3478",
      username: process.env.TURN_USERNAME ?? "",
      credential: process.env.TURN_CREDENTIAL ?? "",
    }),
  ],
  // Accept one peer at a time.
  connectionMode: ConnectionMode.SINGLE,
});
// #endregion ice

// #region messages
async function runWithMessages(connection: SmallWebRTCConnection): Promise<void> {
  const transport = new SmallWebRTCTransport(
    connection,
    new TransportParams({ audioInEnabled: true, audioOutEnabled: true }),
  );

  transport.eventHandler("on_app_message", async (_transport, message: unknown, sender: string) => {
    console.log(`message from ${sender}:`, message);
    // Reply on the data channel.
    connection.sendAppMessage({ type: "ack" });
  });
}
// #endregion messages
