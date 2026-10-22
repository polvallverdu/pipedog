// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_asyncai_tts.py

/**
 * Tests for AsyncAITTSService runtime settings updates.
 *
 * Porting notes:
 * - `monkeypatch.setattr(service, "_disconnect", AsyncMock(...))` assigns an instance
 *   function that records the call.
 * - `FakeWebsocket` parks on an asyncio `Event` so the receive task stays cancellable.
 * - `logger.add(sink, level="WARNING")` is `logger.addSink`.
 * - The tests after the ported ones are not in upstream: the WebSocket service against a
 *   `Bun.serve` fake of Async's protocol, and `AsyncAIHttpTTSService` against a fake endpoint.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Event } from "@pipedog/asyncio";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import { TTSAudioRawFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { State } from "@pipedog/core/services/websocket_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { logger } from "@pipedog/core/utils/logger";
import { AsyncAIHttpTTSService, AsyncAITTSService } from "../src/tts.ts";

type Dict = Record<string, any>;

function frameProcessorSetup(taskManager: TaskManager): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    taskManager,
  });
}

function service(): AsyncAITTSService {
  return new AsyncAITTSService({
    apiKey: "test-key",
    settings: new AsyncAITTSService.Settings({ model: "m1", voice: "v1", language: null }),
  });
}

/** Record the reconnect sequence in place of the real websocket calls. */
function stubReconnect(svc: AsyncAITTSService): string[] {
  const calls: string[] = [];
  svc._disconnect = async () => {
    calls.push("disconnect");
  };
  svc._connect = async () => {
    calls.push("connect");
  };
  return calls;
}

/**
 * Websocket that records what the service sends and never yields a message.
 *
 * The receive loop reconnects on its own whenever it sees the connection
 * drop, so the iterator parks until close instead of ending: a socket that
 * stops iterating would leave the base class opening sessions of its own,
 * on top of the ones under test.
 */
class FakeWebsocket {
  state: State = State.OPEN;
  #sent: string[];
  #closed = new Event();

  constructor(sent: string[]) {
    this.#sent = sent;
  }

  async send(msg: string): Promise<void> {
    this.#sent.push(msg);
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {
    this.state = State.CLOSED;
    this.#closed.set();
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  async next(): Promise<IteratorResult<string>> {
    await this.#closed.wait();
    return { done: true, value: undefined };
  }
}

const sinkCleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of sinkCleanups.splice(0)) cleanup();
});

const SESSION_INIT_CASES: [string, string][] = [
  ["voice", "v2"],
  ["model", "m2"],
  ["language", "es"],
];

for (const [field, value] of SESSION_INIT_CASES) {
  test(`test_session_init_field_change_starts_a_new_session[${field}]`, async () => {
    // model, voice and language are only ever sent in the init message, so the
    // session has to be rebuilt for a change to them to reach Async at all.
    const svc = service();
    const calls = stubReconnect(svc);

    await svc["_updateSettings"](new AsyncAITTSService.Settings({ [field]: value }));

    expect(calls).toEqual(["disconnect", "connect"]);
  });
}

test("test_unchanged_settings_keep_the_session", async () => {
  const svc = service();
  const calls = stubReconnect(svc);

  await svc["_updateSettings"](new AsyncAITTSService.Settings({ voice: "v1" }));

  expect(calls).toEqual([]);
});

test("test_new_session_carries_the_updated_voice", async () => {
  // The reconnect is only worth anything if the fresh init message actually
  // carries the new value, so drive the real _connectWebsocket and read it.
  const svc = service();
  const sent: string[] = [];

  svc._websocketConnect = async () => new FakeWebsocket(sent) as never;

  await svc.setup(frameProcessorSetup(new TaskManager()));
  try {
    expect(JSON.parse(sent[sent.length - 1]!).voice.id).toBe("v1");
    const before = sent.length;

    await svc["_updateSettings"](new AsyncAITTSService.Settings({ voice: "v2" }));

    // the settings change must open exactly one new session
    expect(sent.length - before).toBe(1);
    expect(JSON.parse(sent[sent.length - 1]!).voice.id).toBe("v2");
  } finally {
    await svc.cleanup();
  }
});

test("test_a_field_that_is_not_in_the_init_message_still_warns", async () => {
  // Anything outside model/voice/language genuinely cannot be applied to a
  // live session, so it must keep warning rather than look handled.
  const svc = service();
  stubReconnect(svc);

  const lines: string[] = [];
  const remove = logger.addSink((record) => {
    if (record.level === "WARNING" || record.level === "ERROR") lines.push(record.message);
  });
  sinkCleanups.push(remove);
  try {
    await svc["_updateSettings"](new AsyncAITTSService.Settings({ extra: { pace: 1.2 } }));
  } finally {
    remove();
  }

  expect(lines.join("\n")).toContain("pace");
});

//
// Not in upstream.
//

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

describe("TestAsyncAITTSServiceWebsocket", () => {
  test("sends the init message, a forced transcript, and closes the context after playback", async () => {
    const audio = Uint8Array.from({ length: 4096 }, (_, i) => (i * 5) & 0xff);
    const messages: Dict[] = [];
    let requestUrl = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, srv) {
        requestUrl = request.url;
        if (srv.upgrade(request, { data: {} })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
          messages.push(msg);
          if (msg.transcript?.trim() && msg.force && msg.context_id) {
            ws.send(
              JSON.stringify({ context_id: msg.context_id, audio: b64(audio), final: false }),
            );
          }
        },
      },
    });
    try {
      const tts = new AsyncAITTSService({
        apiKey: "k1",
        url: `ws://127.0.0.1:${server.port}/ws`,
        sampleRate: 24000,
        settings: new AsyncAITTSService.Settings({ voice: "voice-1", language: "en" }),
      });
      const [down] = await runTest(tts, {
        framesToSend: [new TTSSpeakFrame({ text: "Hello." }), new SleepFrame({ sleep: 0.4 })],
      });

      const url = new URL(requestUrl);
      expect(url.searchParams.get("api_key")).toBe("k1");
      expect(url.searchParams.get("version")).toBe("v1");
      expect(messages[0]).toEqual({
        model_id: "async_flash_v1.5",
        voice: { mode: "id", id: "voice-1" },
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
        language: "en",
      });
      const speak = messages.find((m) => m.transcript === "Hello.");
      expect(speak).toBeDefined();
      expect(speak!.force).toBe(true);
      expect(
        messages.some(
          (m) =>
            m.close_context === true && m.transcript === "" && m.context_id === speak!.context_id,
        ),
      ).toBe(true);
      const frames = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
      expect(frames.reduce((n, f) => n + f.audio.length, 0)).toBe(audio.length);
    } finally {
      server.stop(true);
    }
  });
});

describe("TestAsyncAIHttpTTSService", () => {
  test("posts the transcript with the key and version headers and returns the bytes as one frame", async () => {
    const audio = Uint8Array.from({ length: 3000 }, (_, i) => (i * 11) & 0xff);
    const requests: { url: string; headers: Headers; body: Dict }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({
          url: new URL(request.url).pathname,
          headers: request.headers,
          body: (await request.json()) as Dict,
        });
        return new Response(audio, { headers: { "Content-Type": "application/octet-stream" } });
      },
    });
    try {
      const tts = new AsyncAIHttpTTSService({
        apiKey: "k2",
        url: `http://127.0.0.1:${server.port}`,
        sampleRate: 24000,
        settings: new AsyncAIHttpTTSService.Settings({ voice: "voice-2" }),
      });
      const [down] = await runTest(tts, {
        framesToSend: [new TTSSpeakFrame({ text: "Hi there." })],
      });

      expect(requests.length).toBe(1);
      const request = requests[0]!;
      expect(request.url).toBe("/text_to_speech/streaming");
      expect(request.headers.get("x-api-key")).toBe("k2");
      expect(request.headers.get("version")).toBe("v1");
      expect(request.body).toEqual({
        model_id: "async_flash_v1.5",
        transcript: "Hi there.",
        voice: { mode: "id", id: "voice-2" },
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
        language: null,
      });
      const frames = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
      expect(frames.length).toBe(1);
      expect(frames[0]!.audio).toEqual(audio);
    } finally {
      server.stop(true);
    }
  });
});
