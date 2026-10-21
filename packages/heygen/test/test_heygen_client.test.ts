// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Tests for HeyGenClient against a fake avatar API, a local websocket server
// (Bun.serve) for the control channel, and a fake LiveKit SDK (upstream has
// no tests for this module).

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sleep } from "@pipedog/asyncio";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import { TTSAudioRawFrame } from "@pipedog/core/frames/frames";
import { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { TransportParams } from "@pipedog/core/transports/base_transport";
import { TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { type Rtc, rtc, setRtc } from "@pipedog/transport-livekit/rtc";
import { LiveAvatarNewSessionRequest } from "../src/api_liveavatar.ts";
import { BaseAvatarApi, StandardSessionResponse } from "../src/base_api.ts";
import { type HeyGenAudioData, HeyGenCallbacks, HeyGenClient, ServiceType } from "../src/client.ts";
import { HeyGenVideoService } from "../src/video.ts";

const KIND_AUDIO = 1;
const KIND_VIDEO = 2;

class FakeRoom {
  static last: FakeRoom | null = null;
  handlers = new Map<string, (...args: unknown[]) => void>();
  remoteParticipants = new Map<string, unknown>();
  localParticipant = { sid: "PA_local" };
  name = "room";
  connected: [string, string] | null = null;
  disconnected = false;

  constructor() {
    FakeRoom.last = this;
  }
  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, handler);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.(...args);
  }
  async connect(url: string, token: string): Promise<void> {
    this.connected = [url, token];
  }
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

/** A stand-in for rtc.AudioStream: a ReadableStream of three 10 ms frames. */
class FakeAudioStream extends ReadableStream<{ data: Int16Array; sampleRate: number }> {
  static options: unknown = null;
  constructor(_track: unknown, options: unknown) {
    FakeAudioStream.options = options;
    let n = 0;
    super({
      pull(controller) {
        if (n++ < 3) controller.enqueue({ data: new Int16Array(480).fill(n), sampleRate: 48000 });
      },
    });
  }
}

class FakeApi extends BaseAvatarApi {
  closed: string[] = [];
  constructor(
    readonly wsUrl: string | null,
    readonly agentToken: string | null = "agent-token",
  ) {
    super();
  }
  async newSession(): Promise<StandardSessionResponse> {
    return new StandardSessionResponse({
      sessionId: "sess-1",
      accessToken: "user-token",
      livekitAgentToken: this.agentToken,
      livekitUrl: "wss://lk.example",
      wsUrl: this.wsUrl,
      rawResponse: null,
    });
  }
  async closeSession(sessionId: string): Promise<unknown> {
    this.closed.push(sessionId);
    return null;
  }
}

let server: ReturnType<typeof Bun.serve>;
let received: Record<string, unknown>[] = [];
const saved: Partial<Rtc> = { ...rtc };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("no", { status: 400 });
    },
    websocket: {
      message(_ws, message) {
        received.push(JSON.parse(String(message)));
      },
    },
  });
  setRtc({
    Room: FakeRoom,
    AudioStream: FakeAudioStream,
    TrackKind: { KIND_AUDIO, KIND_VIDEO },
  } as unknown as Partial<Rtc>);
});

afterAll(() => {
  server.stop(true);
  for (const key of Object.keys(rtc)) delete (rtc as Record<string, unknown>)[key];
  Object.assign(rtc, saved);
});

afterEach(() => {
  received = [];
  FakeRoom.last = null;
});

function makeSetup(): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    taskManager: new TaskManager(),
  });
}

function makeClient(api: FakeApi, events: string[], connectAsUser = false): HeyGenClient {
  return new HeyGenClient({
    apiKey: "key",
    params: new TransportParams({ audioInSampleRate: 16000 }),
    serviceType: ServiceType.LIVE_AVATAR,
    sessionRequest: new LiveAvatarNewSessionRequest({ avatarId: "av" }),
    callbacks: new HeyGenCallbacks({
      onConnected: async () => {
        events.push("connected");
      },
      onParticipantConnected: async (id) => {
        events.push(`joined:${id}`);
      },
      onParticipantDisconnected: async (id) => {
        events.push(`left:${id}`);
      },
    }),
    connectAsUser,
    api,
  });
}

async function waitUntil(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await sleep(0.01);
}

describe("HeyGenClient", () => {
  test("setup connects the websocket and the room, and sends avatar commands", async () => {
    const api = new FakeApi(`ws://localhost:${server.port}`);
    const events: string[] = [];
    const client = makeClient(api, events);
    await client.setup(makeSetup());

    const room = FakeRoom.last!;
    expect(room.connected).toEqual(["wss://lk.example", "agent-token"]);
    expect(client.inSampleRate).toBe(16000);
    expect(client.outSampleRate).toBe(24000);

    room.emit("participantConnected", {
      sid: "PA_1",
      identity: "user-1",
      trackPublications: new Map(),
    });
    await waitUntil(() => events.length >= 2);
    expect(events).toEqual(["connected", "joined:user-1"]);

    const audio = new Uint8Array([1, 2, 3, 4]);
    await client.agentSpeak(audio, "ev-1");
    await client.agentSpeakEnd("ev-1");
    await client.interrupt(null);
    await client.startAgentListening();
    await client.stopAgentListening();
    await waitUntil(() => received.length >= 5);

    expect(received.map((m) => m.type)).toEqual([
      "agent.speak",
      "agent.speak_end",
      "agent.interrupt",
      "agent.start_listening",
      "agent.stop_listening",
    ]);
    expect(base64ToBytes(received[0]!.audio as string)).toEqual(audio);
    expect(received[0]!.event_id).toBe("ev-1");
    expect(received[2]!.event_id).toBeNull();

    await client.cleanup();
    expect(room.disconnected).toBe(true);
    expect(api.closed).toEqual(["sess-1"]);
  });

  test("connect_as_user joins with the user token", async () => {
    const api = new FakeApi(`ws://localhost:${server.port}`);
    const client = makeClient(api, [], true);
    await client.setup(makeSetup());
    expect(FakeRoom.last!.connected).toEqual(["wss://lk.example", "user-token"]);
    await client.stop();
  });

  test("a session without a websocket URL or agent token still joins the room", async () => {
    const api = new FakeApi(null, null);
    const client = makeClient(api, []);
    await client.setup(makeSetup());
    // DIVERGENCE: falls back to the client token (upstream requires both fields).
    expect(FakeRoom.last!.connected).toEqual(["wss://lk.example", "user-token"]);
    // Without a websocket, commands are dropped.
    await client.startAgentListening();
    expect(received).toEqual([]);
    await client.stop();
    expect(api.closed).toEqual(["sess-1"]);
  });

  test("captures audio from a subscribed track once the transport is ready", async () => {
    const api = new FakeApi(`ws://localhost:${server.port}`);
    const client = makeClient(api, []);
    await client.setup(makeSetup());
    const frames: HeyGenAudioData[] = [];
    await client.captureParticipantAudio("user-1", async (f) => {
      frames.push(f);
    });
    client.transportReady();
    FakeRoom.last!.emit("trackSubscribed", { kind: KIND_AUDIO }, { sid: "TR_1" }, {});
    await waitUntil(() => frames.length >= 3);

    expect(FakeAudioStream.options).toEqual({ sampleRate: 16000 });
    expect(frames.length).toBe(3);
    expect(frames[0]!.sampleRate).toBe(48000);
    expect(frames[0]!.numChannels).toBe(1);
    expect(frames[0]!.audio.length).toBe(960);
    expect(frames[0]!.audio[0]).toBe(1);
    await client.stop();
  });

  test("setup and cleanup run once for the input and output transports", async () => {
    const api = new FakeApi(`ws://localhost:${server.port}`);
    const client = makeClient(api, []);
    const setup = makeSetup();
    await Promise.all([client.setup(setup), client.setup(setup)]);
    const room = FakeRoom.last!;
    await client.cleanup();
    expect(room.disconnected).toBe(false);
    expect(api.closed).toEqual([]);
    await client.cleanup();
    expect(room.disconnected).toBe(true);
    expect(api.closed).toEqual(["sess-1"]);
  });
});

describe("HeyGenVideoService", () => {
  test("sends TTS audio in 400 ms then 1 s chunks and ends the utterance", async () => {
    const api = new FakeApi(`ws://localhost:${server.port}`);
    const service = new HeyGenVideoService({ apiKey: "key", clientOptions: { api } });
    // 1.5 s of 24 kHz audio in 100 ms frames.
    const frames = Array.from(
      { length: 15 },
      () =>
        new TTSAudioRawFrame({ audio: new Uint8Array(4800), sampleRate: 24000, numChannels: 1 }),
    );
    await runTest(service, {
      framesToSend: [...frames, new SleepFrame({ sleep: 0.6 })],
    });
    await waitUntil(() => received.length >= 4);

    const speaks = received.filter((m) => m.type === "agent.speak");
    expect(speaks.map((m) => base64ToBytes(m.audio as string).length)).toEqual([
      19200, 48000, 4800,
    ]);
    const eventId = String(frames[0]!.id);
    expect(speaks.every((m) => m.event_id === eventId)).toBe(true);
    expect(received.at(-1)).toEqual({ type: "agent.speak_end", event_id: eventId });
    expect(api.closed).toEqual(["sess-1"]);
  });
});
