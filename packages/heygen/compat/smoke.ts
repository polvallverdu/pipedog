// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat (bun, node, deno; workerd is unsupported):
// - imports every module (nothing may load @livekit/rtc-node at import time);
// - runs LiveAvatarApi and HeyGenApi against in-process fake `fetch` functions;
// - loads the real @livekit/rtc-node native addon through loadRtc() and converts
//   an I420 VideoFrame to RGB24, as HeyGenClient does with the avatar's video;
// - runs HeyGenClient's session flow (API, control websocket, room join, avatar
//   commands, teardown) with a fake websocket and a fake LiveKit Room, since a
//   real one needs a LiveKit server and a HeyGen account.

import { sleep } from "@pipedog/asyncio";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TransportParams } from "@pipedog/core/transports/base_transport";
import { TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { HeyGenApi, NewSessionRequest } from "@pipedog/heygen/api_interactive_avatar";
import { LiveAvatarApi, LiveAvatarNewSessionRequest } from "@pipedog/heygen/api_liveavatar";
import { HeyGenCallbacks, HeyGenClient, ServiceType } from "@pipedog/heygen/client";
import { HeyGenVideoService } from "@pipedog/heygen/video";
import { loadRtc, type Rtc, rtc, setRtc } from "@pipedog/transport-livekit/rtc";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`heygen smoke: ${message}`);
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const liveAvatarFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith("/sessions/token")) {
    return json({ code: 100, data: { session_id: "s1", session_token: "st" }, message: "ok" });
  }
  if (url.endsWith("/sessions/start")) {
    return json({
      code: 100,
      data: {
        session_id: "s1",
        livekit_url: "wss://lk.invalid",
        livekit_client_token: "client",
        livekit_agent_token: "agent",
        ws_url: "wss://ws.invalid",
      },
      message: "ok",
    });
  }
  return json({ code: 100, data: null, message: "ok" });
}) as typeof fetch;

/** A WebSocket that is open at once and records what is sent. */
class FakeWebSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  binaryType = "arraybuffer";
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
}

class FakeRoom {
  static last: FakeRoom | null = null;
  remoteParticipants = new Map();
  localParticipant = { sid: "PA_local" };
  name = "room";
  token = "";
  disconnected = false;
  constructor() {
    FakeRoom.last = this;
  }
  on(): this {
    return this;
  }
  async connect(_url: string, token: string): Promise<void> {
    this.token = token;
  }
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

export default async function smoke(): Promise<{ rgbBytes: number; sent: string[] }> {
  // Session APIs over fetch.
  const session = await new LiveAvatarApi("key", { fetch: liveAvatarFetch }).newSession(
    new LiveAvatarNewSessionRequest({ avatarId: "av" }),
  );
  check(session.livekitAgentToken === "agent", "LiveAvatar session");
  const heygen = new HeyGenApi("key", {
    fetch: (async () => json({ data: { token: "t" } })) as unknown as typeof fetch,
  });
  check((await heygen.createToken()) === "t", "HeyGen token");
  check(new NewSessionRequest().version === "v2", "NewSessionRequest");
  new HeyGenVideoService({ apiKey: "key" });

  // The native addon: load it and convert a frame as the client does.
  await loadRtc();
  const w = 4;
  const h = 2;
  const i420 = new Uint8Array(w * h * 1.5).fill(128);
  const frame = new rtc.VideoFrame(i420, w, h, rtc.VideoBufferType.I420);
  const rgb = frame.convert(rtc.VideoBufferType.RGB24);
  check(rgb.data.length === w * h * 3, `RGB24 size ${rgb.data.length}`);

  // The client's session flow, with a fake websocket and room.
  const RealRoom = rtc.Room;
  setRtc({ Room: FakeRoom as unknown as Rtc["Room"] });
  const ws = new FakeWebSocket();
  try {
    const client = new HeyGenClient({
      apiKey: "key",
      fetch: liveAvatarFetch,
      params: new TransportParams(),
      serviceType: ServiceType.LIVE_AVATAR,
      callbacks: new HeyGenCallbacks({
        onConnected: async () => {},
        onParticipantConnected: async () => {},
        onParticipantDisconnected: async () => {},
      }),
      websocketOptions: { webSocketFactory: () => ws as unknown as WebSocket },
    });
    await client.setup(
      new FrameProcessorSetup({
        clock: new SystemClock(),
        pipelineWorker: null,
        taskManager: new TaskManager(),
      }),
    );
    check(FakeRoom.last?.token === "agent", "room joined with the agent token");
    await client.agentSpeak(new Uint8Array(480), "ev");
    await client.agentSpeakEnd("ev");
    await sleep(0);
    await client.cleanup();
    check(FakeRoom.last?.disconnected, "room left");
  } finally {
    setRtc({ Room: RealRoom });
  }
  const sent = ws.sent.map((m) => (JSON.parse(m) as { type: string }).type);
  check(sent.join() === "agent.speak,agent.speak_end", `sent ${sent.join()}`);
  return { rgbBytes: rgb.data.length, sent };
}
