// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * End-to-end tests of GrokRealtimeLLMService against a mock xAI Voice Agent
 * server (`Bun.serve`). No upstream counterpart: upstream's tests drive the
 * handlers directly; these check the wire protocol the service speaks over a
 * real websocket (URL, auth header, session.update payload, response flow,
 * audio in and out, function calls, DTMF).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type Frame,
  InputAudioRawFrame,
  InputDTMFFrame,
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

import { SessionProperties, WebSearchTool } from "../src/realtime/events.ts";
import { GrokRealtimeLLMService } from "../src/realtime/llm.ts";

type Json = Record<string, any>;

/** A scripted xAI Voice Agent server. */
class MockGrok {
  server: ReturnType<typeof Bun.serve>;
  received: Json[] = [];
  urls: string[] = [];
  authorizations: (string | null)[] = [];
  /** What to answer a `response.create` with. */
  onResponseCreate: (send: (event: Json) => void) => void = () => {};
  /** Sent after the session is configured. */
  afterSessionUpdated: (send: (event: Json) => void) => void = () => {};

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
          ws.send(
            JSON.stringify({
              event_id: "evt_0",
              type: "session.created",
              session: { id: "sess_1", object: "realtime.session", voice: "eve" },
            }),
          );
          ws.send(
            JSON.stringify({
              event_id: "evt_1",
              type: "conversation.created",
              conversation: { id: "conv_1", object: "realtime.conversation" },
            }),
          );
        },
        message: (ws, message) => {
          const event = JSON.parse(String(message)) as Json;
          this.received.push(event);
          const send = (e: Json) => ws.send(JSON.stringify(e));
          if (event.type === "session.update") {
            send({ event_id: "evt_su", type: "session.updated", session: event.session });
            this.afterSessionUpdated(send);
          } else if (event.type === "response.create") {
            this.onResponseCreate(send);
          }
        },
      },
    });
  }

  get baseUrl(): string {
    return `ws://localhost:${this.server.port}/v1/realtime`;
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

function responseDone(id: string): Json {
  return {
    event_id: `evt_rd_${id}`,
    type: "response.done",
    response: { id, object: "realtime.response", status: "completed", output: [] },
    usage: { total_tokens: 12, input_tokens: 5, output_tokens: 7 },
  };
}

let mockServer: MockGrok;

beforeEach(() => {
  mockServer = new MockGrok();
});

afterEach(() => {
  mockServer.stop();
});

describe("GrokRealtimeLLMService over a websocket", () => {
  test("connects with the model in the URL and a bearer token", async () => {
    const service = new GrokRealtimeLLMService({ apiKey: "secret", baseUrl: mockServer.baseUrl });

    await runTest(service, { framesToSend: [new SleepFrame({ sleep: 0.2 })] });

    expect(mockServer.urls).toHaveLength(1);
    const url = new URL(mockServer.urls[0]!);
    expect(url.pathname).toBe("/v1/realtime");
    expect(url.searchParams.get("model")).toBe("grok-voice-latest");
    expect(mockServer.authorizations[0]).toBe("Bearer secret");
  });

  test("answers conversation.created with a session.update", async () => {
    const service = new GrokRealtimeLLMService({
      apiKey: "secret",
      baseUrl: mockServer.baseUrl,
      settings: new GrokRealtimeLLMService.Settings({
        systemInstruction: "Be brief.",
        sessionProperties: new SessionProperties({
          voice: "rex",
          tools: [new WebSearchTool()],
        }),
      }),
    });

    await runTest(service, { framesToSend: [new SleepFrame({ sleep: 0.2 })] });

    const updates = mockServer.ofType("session.update");
    expect(updates).toHaveLength(1);
    const session = updates[0]!.session;
    expect(session.instructions).toBe("Be brief.");
    expect(session.voice).toBe("rex");
    expect(session.turn_detection).toEqual({ type: "server_vad" });
    // The PCM rates follow the pipeline's (16 kHz in, 24 kHz out by default).
    expect(session.audio).toEqual({
      input: { format: { type: "audio/pcm", rate: 16000 } },
      output: { format: { type: "audio/pcm", rate: 24000 } },
    });
    // Built-in tools ride along.
    expect(session.tools).toEqual([{ type: "web_search" }]);
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
      send(responseDone("resp_1"));
    };

    const service = new GrokRealtimeLLMService({ apiKey: "secret", baseUrl: mockServer.baseUrl });
    const context = new LLMContext({ messages: [{ role: "user", content: "Hi!" }] as any });

    const [down] = await runTest(service, {
      framesToSend: [new LLMContextFrame({ context }), new SleepFrame({ sleep: 0.5 })],
    });

    const created = mockServer.ofType("conversation.item.create");
    expect(created).toHaveLength(1);
    expect(created[0]!.item.content).toEqual([{ type: "input_text", text: "Hi!" }]);
    const [create] = mockServer.ofType("response.create");
    expect(create!.response).toEqual({ modalities: ["text", "audio"] });

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
    // The service opens the response itself when it asks for it, and again
    // when the assistant item arrives.
    expect(kinds(down)).toEqual([
      "LLMFullResponseStartFrame",
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
  });

  test("user audio is sent once the session is ready, frame by frame", async () => {
    const service = new GrokRealtimeLLMService({ apiKey: "secret", baseUrl: mockServer.baseUrl });
    const frames = [1, 2].map(
      (i) =>
        new InputAudioRawFrame({
          audio: new Uint8Array(640).fill(i),
          sampleRate: 16000,
          numChannels: 1,
        }),
    );

    await runTest(service, {
      framesToSend: [new SleepFrame({ sleep: 0.3 }), ...frames, new SleepFrame({ sleep: 0.2 })],
    });

    const appends = mockServer.ofType("input_audio_buffer.append");
    expect(appends).toHaveLength(2);
    expect(base64ToBytes(appends[0]!.audio)).toEqual(new Uint8Array(640).fill(1));
    expect(base64ToBytes(appends[1]!.audio)).toEqual(new Uint8Array(640).fill(2));
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
          type: "conversation.item.added",
          item: {
            id: "item_fc",
            type: "function_call",
            call_id: "call_1",
            name: "get_weather",
            arguments: "",
          },
        });
        send({
          event_id: "evt_fcd",
          type: "response.function_call_arguments.done",
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"city": "Paris"}',
        });
      }
      send(responseDone(id));
    };

    const service = new GrokRealtimeLLMService({ apiKey: "secret", baseUrl: mockServer.baseUrl });
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

  test("a DTMF digit from a SIP session goes upstream as InputDTMFFrame", async () => {
    mockServer.afterSessionUpdated = (send) => {
      send({ event_id: "evt_d", type: "input_audio_buffer.dtmf_event_received", digit: "5" });
      send({ event_id: "evt_e", type: "input_audio_buffer.dtmf_event_received", digit: "A" });
    };
    const service = new GrokRealtimeLLMService({ apiKey: "secret", baseUrl: mockServer.baseUrl });
    const digits: unknown[] = [];
    service.addEventHandler("on_dtmf_received", async (_service: unknown, button: unknown) => {
      digits.push(button);
    });

    const [, up] = await runTest(service, { framesToSend: [new SleepFrame({ sleep: 0.3 })] });

    const dtmf = up.filter((f): f is InputDTMFFrame => f instanceof InputDTMFFrame);
    expect(dtmf.map((f) => f.button)).toEqual(["5"]);
    expect(digits).toEqual(["5"]);
  });
});
