// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// CloudflareRealtimeTransport against a fake SFU: the test plays the SFU's two WebSocket
// adapters (and the browser's messages socket) with in-memory connections, and runs a real
// pipeline over them.

import { afterEach, describe, expect, test } from "bun:test";
import { createTask, sleep, type Task, waitFor } from "@pipedog/asyncio";
import {
  EndFrame,
  type Frame,
  InputAudioRawFrame,
  InputTransportMessageFrame,
  InterruptionFrame,
  OutputAudioRawFrame,
  OutputTransportMessageUrgentFrame,
} from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { State, WebsocketConnection } from "@pipedog/transport-websocket/socket";

import {
  decodePacket,
  encodePacket,
  MAX_PAYLOAD_BYTES,
  monoToStereo,
  PacketError,
  stereoToMono,
} from "../src/packet.ts";
import {
  type CloudflareRealtimeClient,
  CloudflareRealtimeParams,
  CloudflareRealtimeTransport,
} from "../src/transport.ts";

/** One end of an adapter socket, as the SFU sees it. */
class FakeSfuSocket {
  readonly sent: (string | Uint8Array)[] = [];
  readonly connection: WebsocketConnection;
  closedByBot = false;

  constructor() {
    this.connection = new WebsocketConnection({
      send: (data) => {
        this.sent.push(data);
      },
      close: (code, reason) => {
        this.closedByBot = true;
        // The SFU answers the closing handshake.
        queueMicrotask(() => this.connection.feedClose(code, reason));
      },
    });
  }

  /** The SFU sends a message to the bot. */
  push(data: string | Uint8Array): void {
    this.connection.feedMessage(data);
  }

  /** The SFU drops the socket. */
  drop(code = 1006): void {
    this.connection.feedClose(code, "");
  }

  packets() {
    return this.sent.filter((d): d is Uint8Array => d instanceof Uint8Array).map(decodePacket);
  }
}

/** Records frames that pass through it. */
class Recorder extends FrameProcessor {
  readonly frames: Frame[] = [];

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    this.frames.push(frame);
    await this.pushFrame(frame, direction);
  }

  of<T>(cls: abstract new (...args: never[]) => T): T[] {
    return this.frames.filter((f): f is Frame & T => f instanceof cls) as T[];
  }
}

/** 48 kHz stereo PCM: `ms` milliseconds of a constant sample value. */
function sfuPcm(ms: number, value = 1000): Uint8Array {
  const frames = (48000 * ms) / 1000;
  const samples = new Int16Array(frames * 2).fill(value);
  return new Uint8Array(samples.buffer);
}

async function until(cond: () => boolean, timeout = 3): Promise<void> {
  await waitFor(async () => {
    while (!cond()) await sleep(0.01);
  }, timeout);
}

interface Harness {
  transport: CloudflareRealtimeTransport;
  worker: PipelineWorker;
  recorder: Recorder;
  run: Task<void>;
  events: string[];
}

let running: Harness[] = [];

afterEach(async () => {
  for (const h of running) {
    if (!h.run.done()) {
      await h.worker.cancel();
      await waitFor(() => h.run, 5).catch(() => {});
    }
  }
  running = [];
});

async function start(
  options: {
    params?: ConstructorParameters<typeof CloudflareRealtimeParams>[0];
    inRate?: number;
    outRate?: number;
  } = {},
): Promise<Harness> {
  const transport = new CloudflareRealtimeTransport(
    new CloudflareRealtimeParams({
      audioInEnabled: true,
      audioOutEnabled: true,
      ...options.params,
    }),
    { clientId: "user-1" },
  );
  const recorder = new Recorder();
  const worker = new PipelineWorker(
    new Pipeline([transport.input(), recorder, transport.output()]),
    {
      cancelOnIdleTimeout: false,
      enableRtvi: false,
      params: new PipelineParams({
        audioInSampleRate: options.inRate ?? 16000,
        audioOutSampleRate: options.outRate ?? 48000,
      }),
    },
  );
  const events: string[] = [];
  transport.eventHandler(
    "on_client_connected",
    async (_t: unknown, client: CloudflareRealtimeClient) => {
      events.push(`connected:${transport.getClientId(client)}`);
    },
  );
  transport.eventHandler("on_client_disconnected", async () => {
    events.push("disconnected");
  });
  transport.eventHandler(
    "on_app_message",
    async (_t: unknown, message: unknown, sender: string) => {
      events.push(`message:${JSON.stringify(message)}:${sender}`);
    },
  );
  const runner = new WorkerRunner({ handleSigint: false });
  await runner.addWorkers(worker);
  const run = createTask(() => runner.run());
  const harness = { transport, worker, recorder, run, events };
  running.push(harness);
  return harness;
}

describe("packet", () => {
  test("round trip", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const packet = decodePacket(
      encodePacket({ sequenceNumber: 300, timestamp: 2 ** 32 - 1, payload }),
    );
    expect(packet.sequenceNumber).toBe(300);
    expect(packet.timestamp).toBe(2 ** 32 - 1);
    expect(packet.payload).toEqual(payload);
  });

  test("sequence numbers and timestamps wrap to 32 bits", () => {
    const packet = decodePacket(
      encodePacket({ sequenceNumber: 2 ** 32 + 5, timestamp: -1, payload: new Uint8Array() }),
    );
    expect(packet.sequenceNumber).toBe(5);
    expect(packet.timestamp).toBe(2 ** 32 - 1);
  });

  test("matches the protobuf encoding byte for byte", () => {
    // sequenceNumber=1, timestamp=150, payload=[0xaa, 0xbb]
    const bytes = encodePacket({
      sequenceNumber: 1,
      timestamp: 150,
      payload: new Uint8Array([0xaa, 0xbb]),
    });
    expect([...bytes]).toEqual([0x08, 0x01, 0x10, 0x96, 0x01, 0x2a, 0x02, 0xaa, 0xbb]);
  });

  test("skips unknown fields and accepts missing ones", () => {
    // field 3 (varint 7), field 4 (fixed32), then payload; no sequence number or timestamp.
    const bytes = new Uint8Array([0x18, 0x07, 0x25, 1, 2, 3, 4, 0x2a, 0x02, 9, 9]);
    const packet = decodePacket(bytes);
    expect(packet.sequenceNumber).toBe(0);
    expect(packet.timestamp).toBe(0);
    expect([...packet.payload]).toEqual([9, 9]);
  });

  test("rejects truncated packets", () => {
    expect(() => decodePacket(new Uint8Array([0x2a, 0x05, 1, 2]))).toThrow(PacketError);
    expect(() => decodePacket(new Uint8Array([0x08, 0x80]))).toThrow(PacketError);
  });

  test("stereo and mono conversions", () => {
    const stereo = new Uint8Array(new Int16Array([100, 300, -100, -300, 32767, 32767]).buffer);
    expect([...new Int16Array(stereoToMono(stereo).buffer)]).toEqual([200, -200, 32767]);
    const mono = new Uint8Array(new Int16Array([1, -2]).buffer);
    expect([...new Int16Array(monoToStereo(mono).buffer)]).toEqual([1, 1, -2, -2]);
  });

  test("a full payload stays within the 32 KB message limit", () => {
    const bytes = encodePacket({
      sequenceNumber: 2 ** 32 - 1,
      timestamp: 2 ** 32 - 1,
      payload: new Uint8Array(MAX_PAYLOAD_BYTES),
    });
    expect(bytes.length).toBeLessThanOrEqual(32 * 1024);
  });
});

describe("CloudflareRealtimeTransport", () => {
  test("connects once both adapters are attached, and turns SFU audio into input frames", async () => {
    const h = await start({ inRate: 16000 });
    const input = new FakeSfuSocket();
    const output = new FakeSfuSocket();

    h.transport.attachSocket("input", input.connection);
    await sleep(0.05);
    expect(h.events).toEqual([]);
    h.transport.attachSocket("output", output.connection);
    await until(() => h.events.length > 0);
    expect(h.events).toEqual(["connected:user-1"]);

    for (let i = 0; i < 10; i++) {
      input.push(encodePacket({ sequenceNumber: i, timestamp: i * 960, payload: sfuPcm(20) }));
    }
    await until(() => h.recorder.of(InputAudioRawFrame).length >= 8);
    const frames = h.recorder.of(InputAudioRawFrame);
    for (const frame of frames) {
      expect(frame.sampleRate).toBe(16000);
      expect(frame.numChannels).toBe(1);
    }
    // 200 ms of 48 kHz stereo becomes about 200 ms of 16 kHz mono (less the resampler's delay).
    const bytes = frames.reduce((n, f) => n + f.audio.length, 0);
    expect(bytes).toBeGreaterThan(5000);
    expect(bytes).toBeLessThanOrEqual(6400);
  });

  test("keeps 48 kHz stereo when the pipeline asks for it", async () => {
    const h = await start({ inRate: 48000, params: { audioInChannels: 2 } });
    const input = new FakeSfuSocket();
    h.transport.attachSocket("output", new FakeSfuSocket().connection);
    h.transport.attachSocket("input", input.connection);
    const pcm = sfuPcm(20, 1234);
    input.push(encodePacket({ sequenceNumber: 0, timestamp: 0, payload: pcm }));
    await until(() => h.recorder.of(InputAudioRawFrame).length > 0);
    const frame = h.recorder.of(InputAudioRawFrame)[0]!;
    expect(frame.numChannels).toBe(2);
    expect(frame.sampleRate).toBe(48000);
    expect(frame.audio).toEqual(pcm);
  });

  test("ignores invalid packets and text on the input socket", async () => {
    const h = await start({ inRate: 48000 });
    const input = new FakeSfuSocket();
    h.transport.attachSocket("output", new FakeSfuSocket().connection);
    h.transport.attachSocket("input", input.connection);
    input.push("hello");
    input.push(new Uint8Array([0x2a, 0x10, 1]));
    input.push(encodePacket({ sequenceNumber: 0, timestamp: 0, payload: new Uint8Array(6) }));
    input.push(encodePacket({ sequenceNumber: 1, timestamp: 0, payload: sfuPcm(10, 50) }));
    await until(() => h.recorder.of(InputAudioRawFrame).length > 0);
    await sleep(0.05);
    const frames = h.recorder.of(InputAudioRawFrame);
    expect(frames.length).toBe(1);
    expect(frames[0]!.audio.length).toBe(960); // 10 ms at 48 kHz mono
  });

  test("sends the bot's audio as 48 kHz stereo packets, paced in real time", async () => {
    const h = await start({ outRate: 48000 });
    const output = new FakeSfuSocket();
    h.transport.attachSocket("input", new FakeSfuSocket().connection);
    h.transport.attachSocket("output", output.connection);
    await until(() => h.events.length > 0);

    // 200 ms of 48 kHz mono, in one frame: the output transport sends it in 40 ms chunks.
    const mono = new Int16Array(9600);
    for (let i = 0; i < mono.length; i++) mono[i] = i % 1000;
    const started = performance.now();
    await h.worker.queueFrames([
      new OutputAudioRawFrame({
        audio: new Uint8Array(mono.buffer),
        sampleRate: 48000,
        numChannels: 1,
      }),
    ]);
    await until(() => output.packets().reduce((n, p) => n + p.payload.length, 0) >= 9600 * 4);
    const elapsed = performance.now() - started;

    const packets = output.packets();
    expect(packets.length).toBe(5);
    packets.forEach((p, i) => {
      expect(p.sequenceNumber).toBe(i);
      expect(p.timestamp).toBe(i * 1920);
      expect(p.payload.length).toBe(1920 * 4);
    });
    const all = new Uint8Array(packets.reduce((n, p) => n + p.payload.length, 0));
    let offset = 0;
    for (const p of packets) {
      all.set(p.payload, offset);
      offset += p.payload.length;
    }
    expect(all).toEqual(monoToStereo(new Uint8Array(mono.buffer)));
    // Five 40 ms chunks: the first goes at once, the rest wait for the clock.
    expect(elapsed).toBeGreaterThan(120);
  });

  test("resamples the bot's audio to 48 kHz", async () => {
    const h = await start({ outRate: 24000 });
    const output = new FakeSfuSocket();
    h.transport.attachSocket("input", new FakeSfuSocket().connection);
    h.transport.attachSocket("output", output.connection);
    await until(() => h.events.length > 0);
    await h.worker.queueFrames([
      new OutputAudioRawFrame({
        audio: new Uint8Array(24000 * 0.2 * 2),
        sampleRate: 24000,
        numChannels: 1,
      }),
    ]);
    await until(() => output.packets().length >= 5);
    const bytes = output.packets().reduce((n, p) => n + p.payload.length, 0);
    // 200 ms at 48 kHz stereo is 38400 bytes, less the resampler's delay.
    expect(bytes).toBeGreaterThan(30000);
    expect(bytes).toBeLessThanOrEqual(38400);
    for (const p of output.packets()) expect(p.payload.length % 4).toBe(0);
  });

  test("an interruption stops the bot's queued audio", async () => {
    const h = await start({ outRate: 48000 });
    const output = new FakeSfuSocket();
    h.transport.attachSocket("input", new FakeSfuSocket().connection);
    h.transport.attachSocket("output", output.connection);
    await until(() => h.events.length > 0);

    // Two seconds of audio, then an interruption after a few chunks.
    await h.worker.queueFrames([
      new OutputAudioRawFrame({
        audio: new Uint8Array(48000 * 2 * 2),
        sampleRate: 48000,
        numChannels: 1,
      }),
    ]);
    await until(() => output.packets().length >= 3);
    await h.worker.queueFrames([new InterruptionFrame()]);
    await sleep(0.1);
    const atInterruption = output.packets().length;
    await sleep(0.4);
    // 50 chunks were queued; at most one more goes out after the interruption.
    expect(output.packets().length).toBeLessThanOrEqual(atInterruption + 1);
    expect(output.packets().length).toBeLessThan(20);

    // New audio after the interruption plays.
    await h.worker.queueFrames([
      new OutputAudioRawFrame({
        audio: new Uint8Array(48000 * 0.08 * 2),
        sampleRate: 48000,
        numChannels: 1,
      }),
    ]);
    await until(() => output.packets().length >= atInterruption + 2);
  });

  test("drops output while the output adapter isn't attached", async () => {
    const h = await start({ outRate: 48000 });
    await sleep(0.05);
    await h.worker.queueFrames([
      new OutputAudioRawFrame({ audio: new Uint8Array(3840), sampleRate: 48000, numChannels: 1 }),
    ]);
    await sleep(0.1);
    const output = new FakeSfuSocket();
    h.transport.attachSocket("output", output.connection);
    await sleep(0.1);
    expect(output.packets().length).toBe(0);
  });

  test("waits for the SFU to reconnect the input adapter", async () => {
    const h = await start({ inRate: 48000, params: { inputReconnectTimeout: 0.5 } });
    const first = new FakeSfuSocket();
    h.transport.attachSocket("output", new FakeSfuSocket().connection);
    h.transport.attachSocket("input", first.connection);
    await until(() => h.events.length > 0);

    first.drop();
    await sleep(0.1);
    const second = new FakeSfuSocket();
    h.transport.attachSocket("input", second.connection);
    second.push(encodePacket({ sequenceNumber: 0, timestamp: 0, payload: sfuPcm(10) }));
    await until(() => h.recorder.of(InputAudioRawFrame).length > 0);
    await sleep(0.6);
    expect(h.events).toEqual(["connected:user-1"]);
  });

  test("reports a disconnect when the input adapter doesn't come back", async () => {
    const h = await start({ params: { inputReconnectTimeout: 0.2 } });
    const input = new FakeSfuSocket();
    h.transport.attachSocket("output", new FakeSfuSocket().connection);
    h.transport.attachSocket("input", input.connection);
    await until(() => h.events.length > 0);
    input.drop();
    await until(() => h.events.includes("disconnected"));
    expect(h.events).toEqual(["connected:user-1", "disconnected"]);
  });

  test("reports a disconnect when the output adapter closes", async () => {
    const h = await start();
    const output = new FakeSfuSocket();
    h.transport.attachSocket("input", new FakeSfuSocket().connection);
    h.transport.attachSocket("output", output.connection);
    await until(() => h.events.length > 0);
    output.drop(1000);
    await until(() => h.events.includes("disconnected"));
  });

  test("carries app messages over the messages socket, both ways", async () => {
    const h = await start();
    const messages = new FakeSfuSocket();
    // Sent before the browser attached: queued.
    await h.worker.queueFrames([
      new OutputTransportMessageUrgentFrame({ message: { label: "rtvi-ai", type: "early" } }),
    ]);
    await sleep(0.05);
    h.transport.attachSocket("messages", messages.connection);
    messages.push(JSON.stringify({ label: "rtvi-ai", type: "client-ready", id: "1" }));
    await until(() => h.events.some((e) => e.startsWith("message:")));
    expect(h.events).toContain('message:{"label":"rtvi-ai","type":"client-ready","id":"1"}:user-1');
    await until(() => h.recorder.of(InputTransportMessageFrame).length > 0);
    expect(h.recorder.of(InputTransportMessageFrame)[0]!.message).toEqual({
      label: "rtvi-ai",
      type: "client-ready",
      id: "1",
    });

    await h.worker.queueFrames([
      new OutputTransportMessageUrgentFrame({ message: { label: "rtvi-ai", type: "bot-ready" } }),
    ]);
    await until(() => messages.sent.length >= 2);
    expect(messages.sent.map((m) => JSON.parse(m as string).type)).toEqual(["early", "bot-ready"]);
  });

  test("the messages socket closing ends the call", async () => {
    const h = await start();
    const messages = new FakeSfuSocket();
    h.transport.attachSocket("input", new FakeSfuSocket().connection);
    h.transport.attachSocket("output", new FakeSfuSocket().connection);
    h.transport.attachSocket("messages", messages.connection);
    await until(() => h.events.length > 0);
    messages.drop(1001);
    await until(() => h.events.includes("disconnected"));
  });

  test("ending the pipeline closes every socket and refuses new ones", async () => {
    const h = await start();
    const input = new FakeSfuSocket();
    const output = new FakeSfuSocket();
    const messages = new FakeSfuSocket();
    h.transport.attachSocket("input", input.connection);
    h.transport.attachSocket("output", output.connection);
    h.transport.attachSocket("messages", messages.connection);
    await until(() => h.events.length > 0);
    await h.worker.queueFrames([new EndFrame()]);
    await waitFor(() => h.run, 5);
    expect(input.closedByBot && output.closedByBot && messages.closedByBot).toBe(true);
    expect(h.events).toEqual(["connected:user-1"]);

    const late = new FakeSfuSocket();
    h.transport.attachSocket("input", late.connection);
    await until(() => late.connection.state === State.CLOSED);
  });

  test("acceptSocket refuses requests that aren't upgrades", () => {
    const transport = new CloudflareRealtimeTransport();
    const response = transport.acceptSocket("input", new Request("https://bot.example/input"));
    expect(response.status).toBe(426);
  });
});
