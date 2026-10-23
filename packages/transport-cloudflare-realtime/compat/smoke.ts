// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat. On every runtime:
//
// - the packet codec round-trips;
// - CloudflareRealtimeCall runs its whole flow against a fake API (an injected fetch);
// - CloudflareRealtimeTransport runs a real pipeline against a fake SFU: user audio arrives on
//   the input adapter socket at 48 kHz stereo, is resampled to the pipeline's 16 kHz, echoed
//   back as the bot's 24 kHz audio, and leaves on the output adapter socket at 48 kHz stereo;
//   an app message goes through the messages socket.
//
// On workerd, the adapter sockets are also accepted from real upgrade requests, through
// `acceptSocket` and a WebSocketPair, as in a Durable Object.

import { sleep, waitFor } from "@pipedog/asyncio";
import {
  EndFrame,
  type Frame,
  InputAudioRawFrame,
  OutputAudioRawFrame,
} from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { logger } from "@pipedog/core/utils/logger";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { WebsocketConnection } from "@pipedog/transport-websocket/socket";

import { CloudflareRealtimeAPI, CloudflareRealtimeCall } from "../src/api.ts";
import { decodePacket, encodePacket } from "../src/packet.ts";
import { CloudflareRealtimeParams, CloudflareRealtimeTransport } from "../src/transport.ts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`transport-cloudflare-realtime smoke: ${message}`);
}

const isWorkerd =
  (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ===
  "Cloudflare-Workers";

/** Turns the user's audio into the bot's audio. */
class Echo extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof InputAudioRawFrame) {
      await this.pushFrame(
        new OutputAudioRawFrame({
          audio: frame.audio,
          sampleRate: frame.sampleRate,
          numChannels: frame.numChannels,
        }),
      );
      return;
    }
    await this.pushFrame(frame, direction);
  }
}

/** A socket end the test plays the SFU (or browser) on. */
interface Peer {
  connection: WebsocketConnection;
  sent: (string | Uint8Array)[];
  push(data: string | Uint8Array): void;
}

function memoryPeer(): Peer {
  const sent: (string | Uint8Array)[] = [];
  const connection: WebsocketConnection = new WebsocketConnection({
    send: (data) => {
      sent.push(data);
    },
    close: (code, reason) => queueMicrotask(() => connection.feedClose(code, reason)),
  });
  return { connection, sent, push: (data) => connection.feedMessage(data) };
}

/** On workerd: the two ends of a WebSocketPair, as in a Durable Object. */
function pairPeer(
  transport: CloudflareRealtimeTransport,
  role: "input" | "output" | "messages",
): Peer {
  const Pair = (
    globalThis as unknown as {
      WebSocketPair: new () => Record<0 | 1, WebSocket & { accept(): void }>;
    }
  ).WebSocketPair;
  const pair = new Pair();
  const client = pair[0];
  const server = pair[1];
  client.accept();
  server.accept();
  // Binary messages arrive as Blobs by default on newer compatibility dates.
  (client as { binaryType: string }).binaryType = "arraybuffer";
  transport.attachSocket(role, WebsocketConnection.fromWebSocket(server));
  const sent: (string | Uint8Array)[] = [];
  client.addEventListener("message", (event: MessageEvent) => {
    sent.push(
      typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer),
    );
  });
  return {
    connection: null as unknown as WebsocketConnection,
    sent,
    push: (data) => client.send(data),
  };
}

/** On workerd: `acceptSocket` upgrades a request with a WebSocketPair. */
function smokeAcceptSocket(): void {
  const transport = new CloudflareRealtimeTransport();
  const response = transport.acceptSocket(
    "input",
    new Request("https://bot.example/input", { headers: { Upgrade: "websocket" } }),
  );
  check(response.status === 101, `acceptSocket answered ${response.status}`);
  check((response as Response & { webSocket?: unknown }).webSocket, "acceptSocket: no webSocket");
  check(transport.client.inputSocket !== null, "acceptSocket didn't attach the socket");
}

async function until(
  cond: () => boolean,
  timeout: number,
  what: string | (() => string),
): Promise<void> {
  try {
    await waitFor(async () => {
      while (!cond()) await sleep(0.01);
    }, timeout);
  } catch (e) {
    throw new Error(
      `transport-cloudflare-realtime smoke: timed out waiting for ${typeof what === "string" ? what : what()} (${e})`,
    );
  }
}

async function smokeApi(): Promise<void> {
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const path = new URL(input).pathname;
    const body = init.body ? JSON.parse(init.body as string) : null;
    let result: unknown = {};
    if (path.endsWith("/sessions/new")) result = { sessionId: "s1" };
    else if (path.endsWith("/tracks/new")) {
      result = body.sessionDescription
        ? { sessionDescription: { type: "answer", sdp: "a" }, tracks: [{ mid: "0" }] }
        : { sessionDescription: { type: "offer", sdp: "o" }, tracks: [{ mid: "1" }] };
    } else if (path.endsWith("/adapters/websocket/new")) {
      result = {
        tracks: body.tracks.map((t: { trackName: string; location: string }, i: number) => ({
          trackName: t.trackName,
          adapterId: `a${i}`,
          ...(t.location === "local" ? { sessionId: "bot" } : {}),
        })),
      };
    } else if (path.endsWith("/adapters/websocket/close")) {
      result = { tracks: body.tracks };
    } else if (path.endsWith("/tracks/close")) {
      result = { tracks: body.tracks };
    }
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const call = new CloudflareRealtimeCall(
    new CloudflareRealtimeAPI({ appId: "app", appSecret: "secret", fetch }),
  );
  await call.publishUser({ type: "offer", sdp: "o" }, "0");
  const offer = await call.connectBot({ input: "wss://x/in", output: "wss://x/out" });
  check(offer.sessionDescription.type === "offer", "connectBot should return the SFU's offer");
  await call.renegotiate({ type: "answer", sdp: "a" });
  check(await call.close(), "close() should release everything");
}

async function smokeTransport(): Promise<void> {
  const transport = new CloudflareRealtimeTransport(
    new CloudflareRealtimeParams({ audioInEnabled: true, audioOutEnabled: true }),
  );
  const worker = new PipelineWorker(
    new Pipeline([transport.input(), new Echo(), transport.output()]),
    {
      cancelOnIdleTimeout: false,
      params: new PipelineParams({ audioInSampleRate: 16000, audioOutSampleRate: 24000 }),
    },
  );
  let connected = false;
  const messages: unknown[] = [];
  transport.eventHandler("on_client_connected", async () => {
    connected = true;
  });
  transport.eventHandler("on_app_message", async (_t: unknown, message: unknown) => {
    messages.push(message);
  });

  const peer = (role: "input" | "output" | "messages"): Peer => {
    if (isWorkerd) return pairPeer(transport, role);
    const p = memoryPeer();
    transport.attachSocket(role, p.connection);
    return p;
  };
  const input = peer("input");
  const output = peer("output");
  const browser = peer("messages");

  const runner = new WorkerRunner({ handleSigint: false, handleSigterm: false });
  await runner.addWorkers(worker);
  const run = runner.run();

  await until(() => connected, 5, "on_client_connected");

  // 400 ms of a 440 Hz tone, 20 ms per packet, 48 kHz stereo.
  for (let p = 0; p < 20; p++) {
    const samples = new Int16Array(960 * 2);
    for (let i = 0; i < 960; i++) {
      const v = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (p * 960 + i)) / 48000));
      samples[2 * i] = v;
      samples[2 * i + 1] = v;
    }
    input.push(
      encodePacket({
        sequenceNumber: p,
        timestamp: p * 960,
        payload: new Uint8Array(samples.buffer),
      }),
    );
  }
  browser.push(
    JSON.stringify({ label: "rtvi-ai", type: "client-ready", id: "1", data: { version: "1.2.0" } }),
  );

  const outputBytes = () =>
    output.sent
      .filter((d): d is Uint8Array => d instanceof Uint8Array)
      .reduce((n, d) => n + decodePacket(d).payload.length, 0);
  await until(() => outputBytes() >= 48000 * 4 * 0.2, 10, "the bot's audio on the output socket");
  await until(() => messages.length > 0, 5, "on_app_message");
  // RTVI is on by default: the bot answers client-ready with bot-ready.
  await until(
    () => browser.sent.some((m) => typeof m === "string" && m.includes("bot-ready")),
    5,
    "bot-ready on the messages socket",
  );

  await worker.queueFrame(new EndFrame());
  await waitFor(() => run, 10);
}

export default async function smoke(): Promise<void> {
  logger.setLevel("WARNING");
  const packet = decodePacket(
    encodePacket({ sequenceNumber: 7, timestamp: 9, payload: new Uint8Array([1, 2, 3, 4]) }),
  );
  check(packet.sequenceNumber === 7 && packet.payload.length === 4, "packet round trip");
  await smokeApi();
  await smokeTransport();
  if (isWorkerd) smokeAcceptSocket();
}
