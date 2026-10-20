// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The two ends of the WebSocket end-to-end runs (see run.ts): an echo bot
// behind a server transport, and a client pipeline that sends audio and
// transport messages to it and checks what comes back. Both speak the
// protobuf serializer, so either end can be swapped for upstream Python
// (upstream_server.py / upstream_client.py).
//
// Runtime-agnostic: the same code is bundled for Bun, Node, Deno and workerd.

import {
  EndFrame,
  type Frame,
  InputAudioRawFrame,
  InputTransportMessageFrame,
  OutputAudioRawFrame,
  OutputTransportMessageFrame,
  OutputTransportMessageUrgentFrame,
} from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { logger } from "@pipedog/core/utils/logger";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";
import { WebsocketClientParams, WebsocketClientTransport } from "../../src/client.ts";
import {
  type FastAPIWebSocket,
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "../../src/fastapi.ts";
import {
  SingleClientWebsocketServerParams,
  SingleClientWebsocketServerTransport,
} from "../../src/server.ts";
import type { WebsocketConnectFn } from "../../src/socket.ts";

export const SAMPLE_RATE = 16000;

/** 0.2 s of 16 kHz mono s16 audio with a recognizable byte pattern. */
export function testAudio(): Uint8Array {
  const out = new Uint8Array(SAMPLE_RATE * 2 * 0.2);
  for (let i = 0; i < out.length; i++) out[i] = (i * 7 + 3) & 0xff;
  return out;
}

/** A transport message exercising JSON corners: unicode, nesting, floats, null. */
export const TEST_MESSAGE = {
  label: "e2e",
  text: 'héllo wörld 🐶   "quoted"',
  nested: { list: [1, 2.5, -3e-7, null, true, false, "x"], empty: {} },
  big: 9007199254740991,
};

/** What the echo bot sends back for a message. */
export function echoOf(message: unknown): unknown {
  return { echo: message };
}

export function env(name: string): string | undefined {
  const g = globalThis as {
    Deno?: { env: { get(k: string): string | undefined } };
    process?: { env: Record<string, string | undefined> };
  };
  if (g.Deno) return g.Deno.env.get(name);
  return g.process?.env[name];
}

export function exit(code: number): never {
  const g = globalThis as {
    Deno?: { exit(c: number): never };
    process?: { exit(c: number): never };
  };
  if (g.Deno) g.Deno.exit(code);
  g.process?.exit(code);
  throw new Error(`exit ${code}`);
}

/** Quiet logs unless PIPEDOG_E2E_VERBOSE is set. */
export function quietLogs(): void {
  if (!env("PIPEDOG_E2E_VERBOSE")) logger.setLevel("WARNING");
}

function audioParams() {
  return {
    audioInEnabled: true,
    audioInSampleRate: SAMPLE_RATE,
    audioOutEnabled: true,
    audioOutSampleRate: SAMPLE_RATE,
  };
}

/** Echoes input audio as output audio and transport messages as `{ echo }` messages. */
export class EchoProcessor extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof InputAudioRawFrame && direction === FrameDirection.DOWNSTREAM) {
      await this.pushFrame(
        new OutputAudioRawFrame({
          audio: frame.audio,
          sampleRate: frame.sampleRate,
          numChannels: frame.numChannels,
        }),
      );
    } else if (
      frame instanceof InputTransportMessageFrame &&
      direction === FrameDirection.DOWNSTREAM
    ) {
      await this.pushFrame(
        new OutputTransportMessageUrgentFrame({ message: echoOf(frame.message) }),
      );
    } else {
      await this.pushFrame(frame, direction);
    }
  }
}

function pipelineParams(): PipelineParams {
  return new PipelineParams({ audioInSampleRate: SAMPLE_RATE, audioOutSampleRate: SAMPLE_RATE });
}

async function runWorker(worker: PipelineWorker): Promise<void> {
  const runner = new WorkerRunner({ handleSigint: false });
  await runner.addWorkers(worker);
  await runner.run();
}

/**
 * Run the echo bot behind `SingleClientWebsocketServerTransport` until its
 * first client disconnects.
 *
 * @param onReady Called once the server listens.
 * @param allowedOrigins Origins the server accepts (empty: any).
 */
export async function runEchoServer(
  port: number,
  onReady: () => void,
  allowedOrigins: string[] = [],
): Promise<void> {
  const transport = new SingleClientWebsocketServerTransport(
    new SingleClientWebsocketServerParams({
      ...audioParams(),
      serializer: new ProtobufFrameSerializer(),
      allowedOrigins,
    }),
    { host: "127.0.0.1", port },
  );
  const worker = new PipelineWorker(
    new Pipeline([transport.input(), new EchoProcessor(), transport.output()]),
    { params: pipelineParams(), cancelOnIdleTimeout: false },
  );
  transport.eventHandler("on_websocket_ready", async () => onReady());
  transport.eventHandler("on_client_disconnected", async () => {
    await worker.queueFrame(new EndFrame());
  });
  await runWorker(worker);
}

/**
 * Run the echo bot behind `FastAPIWebsocketTransport` on an accepted socket
 * until the client disconnects.
 */
export async function runEchoBotOnSocket(websocket: FastAPIWebSocket): Promise<void> {
  const transport = new FastAPIWebsocketTransport(
    websocket,
    new FastAPIWebsocketParams({
      ...audioParams(),
      serializer: new ProtobufFrameSerializer(),
      allowedOrigins: [],
    }),
  );
  const worker = new PipelineWorker(
    new Pipeline([transport.input(), new EchoProcessor(), transport.output()]),
    { params: pipelineParams(), cancelOnIdleTimeout: false },
  );
  transport.eventHandler("on_client_disconnected", async () => {
    await worker.queueFrame(new EndFrame());
  });
  await runWorker(worker);
}

export interface EchoClientResult {
  ok: boolean;
  audioSent: number;
  audioReceived: number;
  audioMatches: boolean;
  messages: unknown[];
  messagesMatch: boolean;
  error?: string;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Collects what the client receives and resolves once everything came back. */
class Collector extends FrameProcessor {
  audio: Uint8Array[] = [];
  messages: unknown[] = [];
  #expectedAudio: number;
  #expectedMessages: number;
  #done: () => void;

  constructor(expectedAudio: number, expectedMessages: number, done: () => void) {
    super();
    this.#expectedAudio = expectedAudio;
    this.#expectedMessages = expectedMessages;
    this.#done = done;
  }

  get audioLength(): number {
    return this.audio.reduce((n, c) => n + c.length, 0);
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof InputAudioRawFrame) {
      this.audio.push(frame.audio);
    } else if (
      frame instanceof InputTransportMessageFrame &&
      direction === FrameDirection.DOWNSTREAM
    ) {
      this.messages.push(frame.message);
    } else {
      await this.pushFrame(frame, direction);
    }
    if (this.audioLength >= this.#expectedAudio && this.messages.length >= this.#expectedMessages) {
      this.#done();
    }
  }
}

/**
 * Connect `WebsocketClientTransport` to `uri`, send the test audio and two
 * transport messages (normal and urgent), and wait for their echoes.
 */
export async function runEchoClient(
  uri: string,
  timeoutSecs = 10,
  additionalHeaders: Record<string, string> | null = null,
  connect: WebsocketConnectFn | null = null,
): Promise<EchoClientResult> {
  const audio = testAudio();
  const messages = [TEST_MESSAGE, { label: "e2e", urgent: true, n: 0.1 }];
  const transport = new WebsocketClientTransport(
    uri,
    new WebsocketClientParams({
      ...audioParams(),
      serializer: new ProtobufFrameSerializer(),
      addWavHeader: false,
      additionalHeaders,
    }),
  );
  if (connect) {
    // Hand the client a socket opened some other way (e.g. a WebSocketPair).
    (transport as unknown as { _session: { _connect: WebsocketConnectFn } })._session._connect =
      connect;
  }
  let worker: PipelineWorker | null = null;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    void worker?.queueFrame(new EndFrame());
  };
  const collector = new Collector(audio.length, messages.length, finish);
  worker = new PipelineWorker(new Pipeline([transport.input(), collector, transport.output()]), {
    params: pipelineParams(),
    cancelOnIdleTimeout: false,
  });
  const w = worker;
  transport.eventHandler("on_connected", async () => {
    // 20 ms chunks, as a TTS would push them.
    const chunk = (SAMPLE_RATE * 2) / 50;
    const frames: Frame[] = [];
    for (let i = 0; i < audio.length; i += chunk) {
      frames.push(
        new OutputAudioRawFrame({
          audio: audio.slice(i, i + chunk),
          sampleRate: SAMPLE_RATE,
          numChannels: 1,
        }),
      );
    }
    frames.push(new OutputTransportMessageFrame({ message: messages[0] }));
    frames.push(new OutputTransportMessageUrgentFrame({ message: messages[1] }));
    await w.queueFrames(frames);
  });
  let error: string | undefined;
  const timer = setTimeout(() => {
    error = `timed out after ${timeoutSecs}s`;
    finish();
  }, timeoutSecs * 1000);
  try {
    await runWorker(w);
  } finally {
    clearTimeout(timer);
  }
  const received = new Uint8Array(collector.audioLength);
  let offset = 0;
  for (const c of collector.audio) {
    received.set(c, offset);
    offset += c.length;
  }
  const audioMatches = bytesEqual(received.subarray(0, audio.length), audio);
  const expectedMessages = messages.map(echoOf);
  // The urgent message may overtake the other one: compare as sets.
  const sorted = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).sort();
  const messagesMatch =
    JSON.stringify(sorted(collector.messages)) === JSON.stringify(sorted(expectedMessages));
  return {
    ok: !error && audioMatches && messagesMatch,
    audioSent: audio.length,
    audioReceived: received.length,
    audioMatches,
    messages: collector.messages,
    messagesMatch,
    error,
  };
}
