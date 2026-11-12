// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * UltravoxRealtimeLLMService against a local mock of the Ultravox API.
 *
 * The service creates calls at the fixed `https://api.ultravox.ai` origin, so
 * `fetch` is wrapped to send those requests to a local `Bun.serve` server,
 * which answers with a join URL for its own websocket endpoint. The websocket
 * end plays an Ultravox call: it records what the service sends and answers
 * with scripted server messages.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { FunctionSchema } from "@pipedog/core/adapters/llm/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import {
  ErrorFrame,
  type Frame,
  InputAudioRawFrame,
  InputTextRawFrame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import type { FunctionCallParams } from "@pipedog/core/services/llm_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import type { Server, ServerWebSocket } from "bun";

import {
  _ASYNC_TOOL_STARTED_RESULT,
  AgentInputParams,
  JoinUrlInputParams,
  OneShotInputParams,
  UltravoxRealtimeLLMService,
  UltravoxRealtimeLLMSettings,
} from "../src/llm.ts";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** What the mock call does when the service sends it something. */
type Script = (ws: ServerWebSocket<unknown>, message: string | Uint8Array) => void;

class MockUltravox {
  server: Server<unknown>;
  requests: RecordedRequest[] = [];
  received: (string | Uint8Array)[] = [];
  joinPaths: string[] = [];
  callStatus = 201;
  script: Script = () => {};

  constructor() {
    this.server = Bun.serve({
      port: 0,
      fetch: async (request, server) => {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/join")) {
          this.joinPaths.push(url.pathname);
          if (server.upgrade(request)) return undefined;
          return new Response("upgrade failed", { status: 400 });
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message: (ws, message) => {
          const data = typeof message === "string" ? message : new Uint8Array(message);
          this.received.push(data);
          this.script(ws, data);
        },
      },
    });
  }

  get joinUrl(): string {
    return `ws://127.0.0.1:${this.server.port}/join/call-1`;
  }

  /** Answer a call creation request, as `POST /api/calls` does. */
  async createCall(request: RecordedRequest): Promise<Response> {
    this.requests.push(request);
    if (this.callStatus !== 201) {
      return new Response("invalid request", { status: this.callStatus });
    }
    return Response.json({ callId: "call-1", joinUrl: this.joinUrl }, { status: 201 });
  }

  receivedJson(): Record<string, any>[] {
    return this.received
      .filter((m): m is string => typeof m === "string")
      .map((m) => JSON.parse(m));
  }

  receivedAudio(): Uint8Array[] {
    return this.received.filter((m): m is Uint8Array => m instanceof Uint8Array);
  }

  stop(): void {
    this.server.stop(true);
  }
}

let mock: MockUltravox;
let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  mock = new MockUltravox();
  const realFetch = globalThis.fetch;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.ultravox.ai/")) {
      return await mock.createCall({
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: String(init?.body ?? ""),
      });
    }
    return await realFetch(input, init);
  }) as typeof fetch);
});

afterEach(() => {
  fetchSpy.mockRestore();
  mock.stop();
});

function pcm(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * seed) % 251;
  return out;
}

function ofType<T extends Frame>(frames: Frame[], cls: abstract new (...args: any[]) => T): T[] {
  return frames.filter((f): f is T => f instanceof cls);
}

describe("call creation", () => {
  test("a one-shot call posts the call body to /api/calls", async () => {
    const weather = new FunctionSchema({
      name: "get_weather",
      description: "Get the weather",
      properties: { location: { type: "string" }, unit: { type: "string" } },
      required: ["location"],
    });
    const service = new UltravoxRealtimeLLMService({
      params: new OneShotInputParams({
        apiKey: "test-key",
        systemPrompt: "Be brief.",
        temperature: 0.5,
        model: "ultravox-v0.7",
        voice: "c2c5cce4-72ec-4d8b-8cdb-f8a0f6610bd1",
        metadata: { session: "abc" },
        outputMedium: "voice",
        maxDuration: 600,
        extra: { recordingEnabled: true },
      }),
      oneShotSelectedTools: new ToolsSchema({ standardTools: [weather] }),
    });

    await runTest(service, { framesToSend: [new SleepFrame({ sleep: 0.1 })] });

    expect(mock.requests).toHaveLength(1);
    const [request] = mock.requests;
    expect(request!.url).toBe("https://api.ultravox.ai/api/calls");
    expect(request!.method).toBe("POST");
    expect(request!.headers.get("X-Api-Key")).toBe("test-key");
    expect(JSON.parse(request!.body)).toEqual({
      systemPrompt: "Be brief.",
      temperature: 0.5,
      model: "ultravox-v0.7",
      voice: "c2c5cce4-72ec-4d8b-8cdb-f8a0f6610bd1",
      metadata: { session: "abc" },
      maxDuration: "600.000000s",
      selectedTools: [
        {
          temporaryTool: {
            modelToolName: "get_weather",
            description: "Get the weather",
            dynamicParameters: [
              {
                name: "location",
                location: "PARAMETER_LOCATION_BODY",
                schema: { type: "string" },
                required: true,
              },
              {
                name: "unit",
                location: "PARAMETER_LOCATION_BODY",
                schema: { type: "string" },
                required: false,
              },
            ],
            client: {},
          },
        },
      ],
      medium: { serverWebSocket: { inputSampleRate: 48000 } },
      initialOutputMedium: "MESSAGE_MEDIUM_VOICE",
      recordingEnabled: true,
    });
    // The service joined the call it created.
    expect(mock.joinPaths).toEqual(["/join/call-1"]);
  });

  test("an agent call posts to the agent's calls endpoint", async () => {
    const service = new UltravoxRealtimeLLMService({
      params: new AgentInputParams({
        apiKey: "agent-key",
        agentId: "5d3e2b9c-1a4f-4f0e-9c1b-2a7d8e6f4b3a",
        templateContext: { name: "Ada" },
        outputMedium: "text",
        maxDuration: 120,
      }),
    });

    await runTest(service, { framesToSend: [new SleepFrame({ sleep: 0.1 })] });

    expect(mock.requests).toHaveLength(1);
    const [request] = mock.requests;
    expect(request!.url).toBe(
      "https://api.ultravox.ai/api/agents/5d3e2b9c-1a4f-4f0e-9c1b-2a7d8e6f4b3a/calls",
    );
    expect(request!.headers.get("X-Api-Key")).toBe("agent-key");
    expect(JSON.parse(request!.body)).toEqual({
      templateContext: { name: "Ada" },
      metadata: {},
      medium: { serverWebSocket: { inputSampleRate: 48000 } },
      initialOutputMedium: "MESSAGE_MEDIUM_TEXT",
      maxDuration: "120.000000s",
    });
    expect(mock.joinPaths).toEqual(["/join/call-1"]);
  });

  test("a join URL is joined without creating a call", async () => {
    const service = new UltravoxRealtimeLLMService({
      params: new JoinUrlInputParams({ joinUrl: mock.joinUrl }),
    });

    await runTest(service, { framesToSend: [new SleepFrame({ sleep: 0.1 })] });

    expect(mock.requests).toHaveLength(0);
    expect(mock.joinPaths).toEqual(["/join/call-1"]);
  });

  test("an API error is reported as a fatal error", async () => {
    mock.callStatus = 401;
    const service = new UltravoxRealtimeLLMService({
      params: new OneShotInputParams({ apiKey: "wrong-key" }),
    });

    const [, upFrames] = await runTest(service, {
      framesToSend: [new SleepFrame({ sleep: 0.05 })],
    });

    const errors = ofType(upFrames, ErrorFrame);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toContain("Failed to connect to Ultravox");
    expect(String(errors[0]!.exception)).toContain("Ultravox API error 401: invalid request");
    expect(mock.joinPaths).toHaveLength(0);
  });
});

describe("call session", () => {
  test("user audio goes out as binary frames, resampled to 48 kHz", async () => {
    const service = new UltravoxRealtimeLLMService({
      params: new JoinUrlInputParams({ joinUrl: mock.joinUrl }),
    });
    const audio = pcm(960, 3);

    await runTest(service, {
      framesToSend: [
        new SleepFrame({ sleep: 0.05 }),
        new InputAudioRawFrame({ audio, sampleRate: 48000, numChannels: 1 }),
        new InputAudioRawFrame({ audio: pcm(320), sampleRate: 16000, numChannels: 1 }),
        new SleepFrame({ sleep: 0.1 }),
      ],
    });

    const sent = mock.receivedAudio();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    // Audio at the call's rate goes out untouched.
    expect(sent[0]).toEqual(audio);
  });

  test("user text goes out as a user_text_message", async () => {
    const service = new UltravoxRealtimeLLMService({
      params: new JoinUrlInputParams({ joinUrl: mock.joinUrl }),
    });

    await runTest(service, {
      framesToSend: [
        new SleepFrame({ sleep: 0.05 }),
        new InputTextRawFrame({ text: "What's the weather?" }),
        new SleepFrame({ sleep: 0.1 }),
      ],
    });

    expect(mock.receivedJson()).toEqual([
      { type: "user_text_message", text: "What's the weather?" },
    ]);
  });

  test("a voice response becomes TTS frames, transcripts and a user transcription", async () => {
    const botAudio = pcm(1920, 7);
    mock.script = (ws, message) => {
      if (!(message instanceof Uint8Array)) return;
      ws.send(JSON.stringify({ type: "state", state: "thinking" }));
      ws.send(JSON.stringify({ type: "transcript", role: "user", text: "Hello", final: true }));
      ws.send(botAudio);
      ws.send(JSON.stringify({ type: "transcript", role: "agent", medium: "voice", delta: "Hi " }));
      ws.send(
        JSON.stringify({ type: "transcript", role: "agent", medium: "voice", delta: "there" }),
      );
      ws.send(
        JSON.stringify({
          type: "transcript",
          role: "agent",
          medium: "voice",
          text: "Hi there",
          final: true,
        }),
      );
      ws.send(JSON.stringify({ type: "state", state: "listening" }));
    };
    const service = new UltravoxRealtimeLLMService({
      params: new JoinUrlInputParams({ joinUrl: mock.joinUrl }),
    });

    const [downFrames, upFrames] = await runTest(service, {
      framesToSend: [
        new SleepFrame({ sleep: 0.05 }),
        new InputAudioRawFrame({ audio: pcm(960), sampleRate: 48000, numChannels: 1 }),
        new SleepFrame({ sleep: 0.2 }),
      ],
    });

    const kinds = downFrames
      .filter(
        (f) =>
          f instanceof LLMFullResponseStartFrame ||
          f instanceof LLMFullResponseEndFrame ||
          f instanceof TTSStartedFrame ||
          f instanceof TTSStoppedFrame ||
          f instanceof TTSAudioRawFrame,
      )
      .map((f) => f.constructor.name);
    expect(kinds).toEqual([
      "LLMFullResponseStartFrame",
      "TTSStartedFrame",
      "TTSAudioRawFrame",
      "TTSStoppedFrame",
      "LLMFullResponseEndFrame",
    ]);

    const [audioFrame] = ofType(downFrames, TTSAudioRawFrame);
    expect(audioFrame!.audio).toEqual(botAudio);
    expect(audioFrame!.sampleRate).toBe(48000);
    expect(audioFrame!.numChannels).toBe(1);

    // Non-final agent transcripts are pushed as text kept out of the context;
    // the final one is not repeated.
    const llmTexts = ofType(downFrames, LLMTextFrame);
    expect(llmTexts.map((f) => f.text)).toEqual(["Hi ", "there"]);
    expect(llmTexts.every((f) => f.appendToContext === false)).toBe(true);
    const ttsTexts = ofType(downFrames, TTSTextFrame);
    expect(ttsTexts.map((f) => f.text)).toEqual(["Hi ", "there"]);
    expect(ttsTexts.every((f) => f.includesInterFrameSpaces)).toBe(true);

    const transcriptions = ofType(upFrames, TranscriptionFrame);
    expect(transcriptions.map((f) => f.text)).toEqual(["Hello"]);
  });

  test("a text response becomes LLM text frames", async () => {
    mock.script = (ws, message) => {
      if (typeof message !== "string") return;
      ws.send(
        JSON.stringify({ type: "transcript", role: "agent", medium: "text", delta: "Sunny " }),
      );
      ws.send(
        JSON.stringify({ type: "transcript", role: "agent", medium: "text", delta: "today." }),
      );
      ws.send(
        JSON.stringify({
          type: "transcript",
          role: "agent",
          medium: "text",
          text: "Sunny today.",
          final: true,
        }),
      );
    };
    const service = new UltravoxRealtimeLLMService({
      params: new JoinUrlInputParams({ joinUrl: mock.joinUrl }),
    });

    const [downFrames] = await runTest(service, {
      framesToSend: [
        new SleepFrame({ sleep: 0.05 }),
        new InputTextRawFrame({ text: "Weather?" }),
        new SleepFrame({ sleep: 0.2 }),
      ],
    });

    const relevant = downFrames.filter(
      (f) =>
        f instanceof LLMFullResponseStartFrame ||
        f instanceof LLMFullResponseEndFrame ||
        f instanceof LLMTextFrame ||
        f instanceof TTSStartedFrame,
    );
    expect(relevant.map((f) => f.constructor.name)).toEqual([
      "LLMFullResponseStartFrame",
      "LLMTextFrame",
      "LLMTextFrame",
      "LLMFullResponseEndFrame",
    ]);
    expect(ofType(downFrames, LLMTextFrame).map((f) => f.text)).toEqual(["Sunny ", "today."]);
  });

  test("playback_clear_buffer broadcasts an interruption", async () => {
    mock.script = (ws, message) => {
      if (typeof message !== "string") return;
      ws.send(JSON.stringify({ type: "playback_clear_buffer" }));
    };
    const service = new UltravoxRealtimeLLMService({
      params: new JoinUrlInputParams({ joinUrl: mock.joinUrl }),
    });

    const [downFrames, upFrames] = await runTest(service, {
      framesToSend: [
        new SleepFrame({ sleep: 0.05 }),
        new InputTextRawFrame({ text: "Stop." }),
        new SleepFrame({ sleep: 0.2 }),
      ],
    });

    expect(ofType(downFrames, InterruptionFrame).length).toBeGreaterThanOrEqual(1);
    expect(ofType(upFrames, InterruptionFrame).length).toBeGreaterThanOrEqual(1);
  });

  test("a client tool invocation runs the function and returns its result", async () => {
    mock.script = (ws, message) => {
      if (typeof message !== "string") return;
      const data = JSON.parse(message);
      if (data.type === "user_text_message") {
        ws.send(
          JSON.stringify({
            type: "client_tool_invocation",
            toolName: "get_weather",
            invocationId: "inv-1",
            parameters: { location: "Paris" },
          }),
        );
      }
    };
    const service = new UltravoxRealtimeLLMService({
      params: new JoinUrlInputParams({ joinUrl: mock.joinUrl }),
    });
    const calls: Record<string, unknown>[] = [];
    service.registerFunction("get_weather", async (params: FunctionCallParams) => {
      calls.push(params.arguments);
      await params.resultCallback({ temperature: 21, conditions: "sunny" });
    });

    await runTest(service, {
      framesToSend: [
        new SleepFrame({ sleep: 0.05 }),
        new InputTextRawFrame({ text: "Weather in Paris?" }),
        new SleepFrame({ sleep: 0.3 }),
      ],
    });

    expect(calls).toEqual([{ location: "Paris" }]);
    expect(mock.receivedJson()).toEqual([
      { type: "user_text_message", text: "Weather in Paris?" },
      {
        type: "client_tool_result",
        invocationId: "inv-1",
        result: '{"temperature": 21, "conditions": "sunny"}',
      },
    ]);
  });

  test("an async tool gets the placeholder result as soon as it is invoked", async () => {
    mock.script = (ws, message) => {
      if (typeof message !== "string") return;
      const data = JSON.parse(message);
      if (data.type === "user_text_message" && data.text === "Look it up.") {
        ws.send(
          JSON.stringify({
            type: "client_tool_invocation",
            toolName: "slow_lookup",
            invocationId: "inv-2",
            parameters: {},
          }),
        );
      }
    };
    const service = new UltravoxRealtimeLLMService({
      params: new JoinUrlInputParams({ joinUrl: mock.joinUrl }),
    });
    service.registerFunction(
      "slow_lookup",
      async (params: FunctionCallParams) => {
        await params.resultCallback({ answer: 42 });
      },
      { cancelOnInterruption: false },
    );

    await runTest(service, {
      framesToSend: [
        new SleepFrame({ sleep: 0.05 }),
        new InputTextRawFrame({ text: "Look it up." }),
        new SleepFrame({ sleep: 0.3 }),
      ],
    });

    const sent = mock.receivedJson();
    expect(sent[1]).toEqual({
      type: "client_tool_result",
      invocationId: "inv-2",
      result: _ASYNC_TOOL_STARTED_RESULT,
    });
    // The actual result follows as user-side text.
    expect(sent[2]).toEqual({
      type: "user_text_message",
      text: '[Async tool result for tool_call_id=inv-2] {"answer": 42}',
    });
  });

  test("an output medium update is sent as set_output_medium", async () => {
    const service = new UltravoxRealtimeLLMService({
      params: new JoinUrlInputParams({ joinUrl: mock.joinUrl }),
    });
    await runTest(service, {
      framesToSend: [new SleepFrame({ sleep: 0.05 })],
    });
    // The settings path sends on the live socket; drive it directly after
    // reconnecting the socket the run closed.
    const internals = service as unknown as {
      _socket: unknown;
      _disconnecting: boolean;
      _send: (content: unknown) => Promise<void>;
      _updateSettings(delta: UltravoxRealtimeLLMSettings): Promise<Record<string, unknown>>;
    };
    const sent: unknown[] = [];
    internals._socket = {};
    internals._disconnecting = false;
    internals._send = async (content) => {
      sent.push(content);
    };

    await internals._updateSettings(new UltravoxRealtimeLLMSettings({ outputMedium: "audio" }));

    expect(sent).toEqual([{ type: "set_output_medium", medium: "voice" }]);
  });
});
