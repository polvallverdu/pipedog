// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The bot side of the end-to-end test (see ../e2e.test.ts), runnable on Bun,
// Node and Deno: an HTTP server with the runner's POST/PATCH /api/offer
// contract (SmallWebRTCRequestHandler), a page for the browser, and per
// connection a tiny pipeline: SmallWebRTCTransport input -> loopback (the
// user's audio is played back) -> output, with the worker's RTVIProcessor.
//
//   <runtime> bot.ts   (env: PAGE_BUNDLE=<page.js path>, PORT=0)
//
// Prints "LISTENING <port>" once it serves.

import { readFileSync } from "node:fs";
import http from "node:http";
import { createTask, monotonic } from "@pipedog/asyncio";
import { type Frame, InputAudioRawFrame, OutputAudioRawFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import type { RTVIProcessor } from "@pipedog/core/processors/frameworks/rtvi/index";
import { TransportParams } from "@pipedog/core/transports/base_transport";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import type { SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import { nodeRequestListener, smallWebRTCOfferHandler } from "@pipedog/transport-smallwebrtc/http";
import { SmallWebRTCRequestHandler } from "@pipedog/transport-smallwebrtc/request_handler";
import { SmallWebRTCTransport } from "@pipedog/transport-smallwebrtc/transport";

const SAMPLE_RATE = 16000;
const env = (name: string): string | undefined =>
  (globalThis as any).Deno
    ? (globalThis as any).Deno.env.get(name)
    : (globalThis as any).process.env[name];
const runtime = (globalThis as any).Bun
  ? `bun ${(globalThis as any).Bun.version}`
  : (globalThis as any).Deno
    ? `deno ${(globalThis as any).Deno.version.deno}`
    : `node ${(globalThis as any).process.version}`;

const stats = {
  runtime,
  connections: 0,
  offers: 0,
  renegotiations: 0,
  restarts: 0,
  patches: [] as { candidates: number; ms: number }[],
  audioFrames: 0,
  loudFrames: 0,
  clientReady: 0,
  getStats: null as Record<string, number> | null,
};

/** Plays the user's audio back, and counts what it hears. */
class LoopbackProcessor extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof InputAudioRawFrame) {
      stats.audioFrames++;
      const pcm = new Int16Array(frame.audio.slice().buffer);
      let sum = 0;
      for (const s of pcm) sum += s * s;
      if (Math.sqrt(sum / Math.max(1, pcm.length)) > 1500) stats.loudFrames++;
      await this.pushFrame(
        new OutputAudioRawFrame({
          audio: frame.audio,
          sampleRate: frame.sampleRate,
          numChannels: frame.numChannels,
        }),
      );
    } else {
      await this.pushFrame(frame, direction);
    }
  }
}

let lastConnection: SmallWebRTCConnection | null = null;

async function runBot(connection: SmallWebRTCConnection): Promise<void> {
  lastConnection = connection;
  const transport = new SmallWebRTCTransport(
    connection,
    new TransportParams({ audioInEnabled: true, audioOutEnabled: true }),
  );
  const worker = new PipelineWorker(
    new Pipeline([transport.input(), new LoopbackProcessor(), transport.output()]),
    {
      cancelOnIdleTimeout: false,
      params: new PipelineParams({
        audioInSampleRate: SAMPLE_RATE,
        audioOutSampleRate: SAMPLE_RATE,
      }),
    },
  );
  worker.rtvi.eventHandler("on_client_ready", async () => {
    stats.clientReady++;
  });
  worker.rtvi.eventHandler("on_client_message", async (rtvi: RTVIProcessor, msg: any) => {
    const { type, data } = msg;
    if (type === "echo") {
      await rtvi.sendServerMessage({ kind: "echo", n: data.n });
    } else if (type === "big") {
      // Larger than any SCTP chunk: exercises fragmentation of RTVI messages.
      await rtvi.sendServerMessage({ kind: "big", payload: "x".repeat(data.size) });
    } else if (type === "please-renegotiate") {
      (connection as any)._renegotiationInProgress = false;
      connection.askToRenegotiate();
    } else if (type === "stats") {
      const report = await connection.pc.getStats();
      const types: Record<string, number> = {};
      for (const s of report.values()) types[s.type] = (types[s.type] ?? 0) + 1;
      stats.getStats = types;
      await rtvi.sendServerMessage({ kind: "stats", types });
    }
  });
  transport.eventHandler("on_client_disconnected", async () => {
    await worker.cancel();
  });
  const runner = new WorkerRunner({ handleSigint: false, handleSigterm: false });
  await runner.addWorkers(worker);
  await runner.run();
}

const requestHandler = new SmallWebRTCRequestHandler();
const offer = smallWebRTCOfferHandler(requestHandler, (connection) => {
  stats.connections++;
  createTask(() => runBot(connection), "bot");
});

const pageHtml =
  '<!doctype html><html><head><meta charset="utf-8"><title>e2e</title></head><body><script src="/page.js"></script></body></html>';

async function app(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/")
    return new Response(pageHtml, { headers: { "content-type": "text/html" } });
  if (url.pathname === "/page.js") {
    return new Response(readFileSync(env("PAGE_BUNDLE")!), {
      headers: { "content-type": "text/javascript" },
    });
  }
  if (url.pathname === "/summary") return Response.json(stats);
  if (url.pathname === "/api/offer") {
    const body = await request.clone().json();
    const t0 = monotonic();
    if (request.method === "POST") {
      stats.offers++;
      if (body.pc_id && body.restart_pc) stats.restarts++;
      else if (body.pc_id) stats.renegotiations++;
    }
    const response = await offer(request);
    if (request.method === "PATCH") {
      stats.patches.push({
        candidates: body.candidates.length,
        ms: Math.round((monotonic() - t0) * 1000),
      });
    }
    return response;
  }
  return new Response("not found", { status: 404 });
}

void lastConnection;
const server = http.createServer(nodeRequestListener(app) as any);
server.listen(Number(env("PORT") ?? 0), "127.0.0.1", () => {
  const address = server.address() as { port: number };
  console.log(`LISTENING ${address.port}`);
});
