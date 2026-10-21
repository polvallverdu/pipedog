// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * End-to-end tests of InworldRealtimeLLMService against a mock Inworld
 * Realtime server (`Bun.serve`). No upstream counterpart: upstream's tests
 * drive the handlers directly; these check the wire protocol the service
 * speaks over a real websocket (URL, auth header, session.update payload,
 * response flow, audio in and out, function calls).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type Frame,
  InputAudioRawFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  TTSAudioRawFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import type { FunctionCallParams } from "@pipedog/core/services/llm_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";

import { InworldRealtimeLLMService } from "../src/realtime/llm.ts";

type Json = Record<string, any>;

/** A scripted Inworld Realtime server. */
class MockInworld {
  server: ReturnType<typeof Bun.serve>;
  received: Json[] = [];
  urls: string[] = [];
  authorizations: (string | null)[] = [];
  /** What to answer a `response.create` with. */
  onResponseCreate: (send: (event: Json) => void) => void = () => {};

  constructor() {
    this.server = Bun.serve({
      port: 0,
      fetch: (req, srv) => {
        this.urls.push(req.url);
        this.authorizations.push(req.headers.get("authorization"));
        if (srv.upgrade(req)) return undefined;
        return new Response("expected a websocket", { status: 400 });
      },
      websocket: {
        open: (ws) => {
          ws.send(JSON.stringify({ event_id: "evt_0", type: "session.created", session: {} }));
        },
        message: (ws, message) => {
          const event = JSON.parse(String(message)) as Json;
          this.received.push(event);
          const send = (e: Json) => ws.send(JSON.stringify(e));
          if (event.type === "session.update") {
            send({ event_id: "evt_su", type: "session.updated", session: event.session });
          } else if (event.type === "response.create") {
            this.onResponseCreate(send);
          }
        },
      },
    });
  }

  get baseUrl(): string {
    return `ws://localhost:${this.server.port}/api/v1/realtime/session`;
  }

  ofType(type: string): Json[] {
    return this.received.filter((e) => e.type === type);
  }

  stop(): void {
    this.server.stop(true);
  }
}

function responseCreated(id: string): Json {
  return {
    event_id: `evt_rc_${id}`,
    type: "response.created",
    response: { id, object: "realtime.response", status: "in_progress", output: [] },
  };
}

function responseDone(id: string, output: Json[] = []): Json {
  return {
    event_id: `evt_rd_${id}`,
    type: "response.done",
    response: { id, object: "realtime.response", status: "completed", output },
    usage: { total_tokens: 12, input_tokens: 5, output_tokens: 7 },
  };
}

let mockServer: MockInworld;

beforeEach(() => {
  mockServer = new MockInworld();
});

afterEach(() => {
  mockServer.stop();
});

describe("InworldRealtimeLLMService over a websocket", () => {
  test("connects with the session key, protocol and auth header", async () => {
    const service = new InworldRealtimeLLMService({
      apiKey: "secret",
      baseUrl: mockServer.baseUrl,
      authType: "bearer",
    });

    await runTest(service, { framesToSend: [new SleepFrame({ sleep: 0.2 })] });

    expect(mockServer.urls).toHaveLength(1);
    const url = new URL(mockServer.urls[0]!);
    expect(url.searchParams.get("protocol")).toBe("realtime");
    expect(url.searchParams.get("key")).toMatch(/^pipecat-realtime-[0-9a-f]{32}$/);
    expect(mockServer.authorizations[0]).toBe("Bearer secret");
  });

  test("answers session.created with a session.update", async () => {
    const service = new InworldRealtimeLLMService({
      apiKey: "secret",
      baseUrl: mockServer.baseUrl,
      voice: "Sarah",
    });

    await runTest(service, { framesToSend: [new SleepFrame({ sleep: 0.2 })] });

    const [update] = mockServer.ofType("session.update");
    expect(update).toBeDefined();
    expect(typeof update!.event_id).toBe("string");
    const session = update!.session;
    expect(session.type).toBe("realtime");
    expect(session.model).toBe("openai/gpt-4.1-mini");
    expect(session.output_modalities).toEqual(["audio", "text"]);
    // The PCM rates follow the pipeline's (16 kHz in, 24 kHz out by default).
    expect(session.audio.input.format).toEqual({ type: "audio/pcm", rate: 16000 });
    expect(session.audio.input.transcription).toEqual({ model: "inworld/inworld-stt-1" });
    expect(session.audio.input.turn_detection).toEqual({
      type: "semantic_vad",
      eagerness: "low",
      create_response: true,
      interrupt_response: true,
    });
    expect(session.audio.output).toEqual({
      format: { type: "audio/pcm", rate: 24000 },
      model: "inworld-tts-2",
      voice: "Sarah",
    });
    // No tools and no context yet: the field is left out (excludeNone).
    expect("tools" in session).toBe(false);
    // providerData is sent under its alias.
    expect(session.providerData).toEqual({
      metadata: { sdk: "pipecat-realtime" },
      auto_tool_response: false,
    });
    expect("provider_data" in session).toBe(false);
  });

  test("a context runs a response: audio, transcript and text frames", async () => {
    const audio = new Uint8Array(960).map((_, i) => i % 256);
    mockServer.onResponseCreate = (send) => {
      send(responseCreated("resp_1"));
      send({
        event_id: "evt_oia",
        type: "response.output_item.added",
        response_id: "resp_1",
        output_index: 0,
        item: { id: "item_1", type: "message", role: "assistant", content: [] },
      });
      send({
        event_id: "evt_ad",
        type: "response.output_audio.delta",
        response_id: "resp_1",
        item_id: "item_1",
        output_index: 0,
        content_index: 0,
        delta: bytesToBase64(audio),
      });
      send({
        event_id: "evt_td",
        type: "response.output_audio_transcript.delta",
        response_id: "resp_1",
        item_id: "item_1",
        delta: "Hello there.",
      });
      send({
        event_id: "evt_adone",
        type: "response.output_audio.done",
        response_id: "resp_1",
        item_id: "item_1",
      });
      // An event without a model is skipped quietly.
      send({ event_id: "evt_x", type: "response.output_text.done" });
      send(responseDone("resp_1"));
    };

    const service = new InworldRealtimeLLMService({
      apiKey: "secret",
      baseUrl: mockServer.baseUrl,
    });
    const context = new LLMContext({ messages: [{ role: "user", content: "Hi!" }] as any });

    const [down] = await runTest(service, {
      framesToSend: [new LLMContextFrame({ context }), new SleepFrame({ sleep: 0.5 })],
    });

    // The conversation is set up from the context before the response.
    const created = mockServer.ofType("conversation.item.create");
    expect(created).toHaveLength(1);
    expect(created[0]!.item.role).toBe("user");
    expect(created[0]!.item.content).toEqual([{ type: "input_text", text: "Hi!" }]);
    const [create] = mockServer.ofType("response.create");
    expect(create!.response).toEqual({ modalities: ["audio", "text"] });

    const kinds = (frames: Frame[]) =>
      frames
        .filter(
          (f) =>
            f instanceof LLMFullResponseStartFrame ||
            f instanceof TTSStartedFrame ||
            f instanceof TTSAudioRawFrame ||
            f instanceof LLMTextFrame ||
            f instanceof TTSTextFrame ||
            f instanceof TTSStoppedFrame ||
            f instanceof LLMFullResponseEndFrame,
        )
        .map((f) => f.constructor.name);
    expect(kinds(down)).toEqual([
      "LLMFullResponseStartFrame",
      "TTSStartedFrame",
      "TTSAudioRawFrame",
      "LLMTextFrame",
      "TTSTextFrame",
      "TTSStoppedFrame",
      "LLMFullResponseEndFrame",
    ]);
    const audioFrame = down.find((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame)!;
    expect(audioFrame.audio).toEqual(audio);
    expect(audioFrame.sampleRate).toBe(24000);
    const textFrame = down.find((f): f is LLMTextFrame => f instanceof LLMTextFrame)!;
    expect(textFrame.text).toBe("Hello there.");
    expect(textFrame.appendToContext).toBe(false);
  });

  test("user audio goes out in ~60 ms chunks once the conversation is set up", async () => {
    mockServer.onResponseCreate = (send) => {
      send(responseCreated("resp_1"));
      send(responseDone("resp_1"));
    };
    const service = new InworldRealtimeLLMService({
      apiKey: "secret",
      baseUrl: mockServer.baseUrl,
    });
    const context = new LLMContext({ messages: [{ role: "user", content: "Hi!" }] as any });
    // 16 kHz, 16-bit mono: 60 ms is 1920 bytes. Five 20 ms frames make one
    // full chunk and leave 1280 bytes buffered.
    const frames = Array.from(
      { length: 5 },
      (_, i) =>
        new InputAudioRawFrame({
          audio: new Uint8Array(640).fill(i + 1),
          sampleRate: 16000,
          numChannels: 1,
        }),
    );

    await runTest(service, {
      framesToSend: [
        new LLMContextFrame({ context }),
        new SleepFrame({ sleep: 0.3 }),
        ...frames,
        new SleepFrame({ sleep: 0.2 }),
      ],
    });

    const appends = mockServer.ofType("input_audio_buffer.append");
    expect(appends).toHaveLength(1);
    const chunk = base64ToBytes(appends[0]!.audio);
    expect(chunk.length).toBe(1920);
    expect([chunk[0], chunk[640], chunk[1280]]).toEqual([1, 2, 3]);
  });

  test("a function call runs and its result answers the call", async () => {
    let responses = 0;
    mockServer.onResponseCreate = (send) => {
      responses += 1;
      const id = `resp_${responses}`;
      send(responseCreated(id));
      if (responses === 1) {
        send({
          event_id: "evt_fc",
          type: "response.output_item.added",
          response_id: id,
          output_index: 0,
          item: {
            id: "item_fc",
            type: "function_call",
            call_id: "call_1",
            name: "get_weather",
            arguments: "",
          },
        });
        // Inworld may leave the name out of the done event.
        send({
          event_id: "evt_fcd",
          type: "response.function_call_arguments.done",
          call_id: "call_1",
          arguments: '{"city": "Paris"}',
        });
      }
      send(responseDone(id));
    };

    const service = new InworldRealtimeLLMService({
      apiKey: "secret",
      baseUrl: mockServer.baseUrl,
    });
    const calls: Record<string, unknown>[] = [];
    service.registerFunction("get_weather", async (params: FunctionCallParams) => {
      calls.push(params.arguments as Record<string, unknown>);
      await params.resultCallback({ temperature: 21 });
    });
    const context = new LLMContext({
      messages: [{ role: "user", content: "Weather in Paris?" }] as any,
    });

    await runTest(service, {
      framesToSend: [new LLMContextFrame({ context }), new SleepFrame({ sleep: 0.5 })],
    });

    expect(calls).toEqual([{ city: "Paris" }]);
    const outputs = mockServer
      .ofType("conversation.item.create")
      .filter((e) => e.item.type === "function_call_output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.item.call_id).toBe("call_1");
    expect(outputs[0]!.item.output).toBe('{"temperature": 21}');
  });
});
