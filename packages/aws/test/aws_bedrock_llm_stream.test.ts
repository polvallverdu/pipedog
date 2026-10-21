// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

// AWSBedrockLLMService against a fake `fetch` that serves Converse and
// ConverseStream responses (event stream bodies built with the codec).

import { describe, expect, mock, test } from "bun:test";

import {
  type Frame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { base64ToBytes } from "@pipedog/core/utils/base64";

import { AWSServiceError } from "../src/aws_session.ts";
import { encodeEventStreamMessage } from "../src/event_stream.ts";
import { AWSBedrockLLMService, AWSBedrockLLMSettings } from "../src/llm.ts";

const enc = new TextEncoder();

function event(type: string, body: object): Uint8Array {
  return encodeEventStreamMessage({
    headers: {
      ":message-type": "event",
      ":event-type": type,
      ":content-type": "application/json",
    },
    body: enc.encode(JSON.stringify(body)),
  });
}

function exception(type: string, message: string): Uint8Array {
  return encodeEventStreamMessage({
    headers: {
      ":message-type": "exception",
      ":exception-type": type,
      ":content-type": "application/json",
    },
    body: enc.encode(JSON.stringify({ message })),
  });
}

function streamBody(messages: Uint8Array[]): ReadableStream<Uint8Array> {
  const all = new Uint8Array(messages.reduce((n, m) => n + m.length, 0));
  let o = 0;
  for (const m of messages) {
    all.set(m, o);
    o += m.length;
  }
  return new ReadableStream({
    start(c) {
      // Split mid-message to exercise the incremental decoder.
      const cut = Math.floor(all.length / 3);
      c.enqueue(all.slice(0, cut));
      c.enqueue(all.slice(cut));
      c.close();
    },
  });
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function makeService(
  respond: (req: Captured) => Response,
  settings?: AWSBedrockLLMSettings,
): { service: AWSBedrockLLMService; requests: Captured[]; frames: Frame[]; s: any } {
  const requests: Captured[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const req: Captured = {
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    };
    requests.push(req);
    return respond(req);
  };
  const service = new AWSBedrockLLMService({
    awsAccessKey: "AKID",
    awsSecretKey: "SECRET",
    awsSessionToken: "TOKEN",
    awsRegion: "eu-west-1",
    fetch: fetchFn,
    settings,
  });
  const frames: Frame[] = [];
  const s = service as any;
  s.pushFrame = mock(async (f: Frame) => {
    frames.push(f);
  });
  s.pushError = mock(async () => {});
  s.runFunctionCalls = mock(async () => {});
  s.startLlmUsageMetrics = mock(async () => {});
  return { service, requests, frames, s };
}

describe("AWSBedrockLLMService ConverseStream", () => {
  test("streams text, signs the request and reports usage", async () => {
    const { requests, frames, s } = makeService(
      () =>
        new Response(
          streamBody([
            event("messageStart", { role: "assistant", p: "abc" }),
            event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hello" } }),
            event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: " world" } }),
            event("contentBlockStop", { contentBlockIndex: 0 }),
            event("messageStop", { stopReason: "end_turn" }),
            event("metadata", {
              usage: {
                inputTokens: 10,
                outputTokens: 4,
                totalTokens: 14,
                cacheReadInputTokens: 3,
                cacheWriteInputTokens: 2,
              },
              metrics: { latencyMs: 100 },
            }),
          ]),
          { headers: { "content-type": "application/vnd.amazon.eventstream" } },
        ),
      new AWSBedrockLLMSettings({
        systemInstruction: "Be brief.",
        temperature: 0.5,
        maxTokens: 100,
        enablePromptCaching: true,
      }),
    );
    const context = new LLMContext({ messages: [{ role: "user", content: "Hi" }] });
    await s._processContext(context);

    expect(requests.length).toBe(1);
    const req = requests[0] as Captured;
    expect(req.url).toBe(
      "https://bedrock-runtime.eu-west-1.amazonaws.com/model/us.amazon.nova-lite-v1%3A0/converse-stream",
    );
    expect(req.headers.authorization).toStartWith("AWS4-HMAC-SHA256 Credential=AKID/" as string);
    expect(req.headers.authorization).toContain("/eu-west-1/bedrock/aws4_request");
    expect(req.headers["x-amz-security-token"]).toBe("TOKEN");
    expect(req.body).toEqual({
      messages: [{ role: "user", content: [{ text: "Hi" }] }],
      additionalModelRequestFields: {},
      inferenceConfig: { maxTokens: 100, temperature: 0.5 },
      system: [{ text: "Be brief." }, { cachePoint: { type: "default" } }],
    });

    expect(frames[0]).toBeInstanceOf(LLMFullResponseStartFrame);
    const texts = frames.filter((f) => f instanceof LLMTextFrame).map((f) => (f as any).text);
    expect(texts).toEqual(["Hello", " world"]);
    expect(frames[frames.length - 1]).toBeInstanceOf(LLMFullResponseEndFrame);

    const usage = s.startLlmUsageMetrics.mock.calls[0][0];
    expect(usage.promptTokens).toBe(10);
    expect(usage.completionTokens).toBe(4);
    expect(usage.cacheReadInputTokens).toBe(3);
    expect(usage.cacheCreationInputTokens).toBe(2);
    expect(usage.totalTokens).toBe(19);
  });

  test("parallel tool calls become function calls", async () => {
    const { requests, s } = makeService(
      () =>
        new Response(
          streamBody([
            event("messageStart", { role: "assistant" }),
            event("contentBlockStart", {
              contentBlockIndex: 0,
              start: { toolUse: { toolUseId: "t1", name: "get_weather" } },
            }),
            event("contentBlockStart", {
              contentBlockIndex: 1,
              start: { toolUse: { toolUseId: "t2", name: "get_time" } },
            }),
            event("contentBlockDelta", {
              contentBlockIndex: 0,
              delta: { toolUse: { input: '{"city":' } },
            }),
            event("contentBlockDelta", {
              contentBlockIndex: 1,
              delta: { toolUse: { input: "" } },
            }),
            event("contentBlockDelta", {
              contentBlockIndex: 0,
              delta: { toolUse: { input: '"Paris"}' } },
            }),
            event("contentBlockStop", { contentBlockIndex: 0 }),
            event("contentBlockStop", { contentBlockIndex: 1 }),
            event("messageStop", { stopReason: "tool_use" }),
          ]),
        ),
    );
    const context = new LLMContext({
      messages: [{ role: "user", content: "Weather?" }],
      toolChoice: "auto",
    });
    // Tools in the standard schema.
    const { FunctionSchema } = await import("@pipedog/core/adapters/schemas/function_schema");
    const { ToolsSchema } = await import("@pipedog/core/adapters/schemas/tools_schema");
    context.setTools(
      new ToolsSchema({
        standardTools: [
          new FunctionSchema({
            name: "get_weather",
            description: "Weather",
            properties: { city: { type: "string" } },
            required: ["city"],
          }),
        ],
      }),
    );
    await s._processContext(context);

    expect((requests[0] as Captured).body.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: "get_weather",
            description: "Weather",
            inputSchema: {
              json: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
        },
      ],
      toolChoice: { auto: {} },
    });
    const calls = s.runFunctionCalls.mock.calls[0][0];
    expect(calls.map((c: any) => [c.toolCallId, c.functionName, c.arguments])).toEqual([
      ["t1", "get_weather", { city: "Paris" }],
      ["t2", "get_time", {}],
    ]);
  });

  test("tool content without tools uses the no-op tool, and images go as base64", async () => {
    const { requests, s } = makeService(
      () =>
        new Response(
          streamBody([
            event("contentBlockStart", {
              contentBlockIndex: 0,
              start: { toolUse: { toolUseId: "n", name: "no_operation" } },
            }),
            event("contentBlockStop", { contentBlockIndex: 0 }),
          ]),
        ),
    );
    const context = new LLMContext({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
          ],
        },
        {
          role: "assistant",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "f", arguments: '{"a": 1}' } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: '{"ok": true}' },
      ] as any,
    });
    await s._processContext(context);
    const body = (requests[0] as Captured).body;
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { image: { format: "png", source: { bytes: "AQID" } } },
          { text: "What is this?" },
        ],
      },
      {
        role: "assistant",
        content: [{ toolUse: { toolUseId: "c1", name: "f", input: { a: 1 } } }],
      },
      {
        role: "user",
        content: [{ toolResult: { toolUseId: "c1", content: [{ json: { ok: true } }] } }],
      },
    ]);
    expect(base64ToBytes(body.messages[0].content[0].image.source.bytes)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(body.toolConfig.tools[0].toolSpec.name).toBe("no_operation");
    expect(body.toolConfig.toolChoice).toBeUndefined();
    expect(s.runFunctionCalls.mock.calls[0][0]).toEqual([]);
  });

  test("a mid-stream exception event becomes an AWSServiceError", async () => {
    const { frames, s } = makeService(
      () =>
        new Response(
          streamBody([
            event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hi" } }),
            exception("validationException", "bad bytes"),
          ]),
        ),
    );
    const context = new LLMContext({ messages: [{ role: "user", content: "Hi" }] });
    await s._processContext(context);
    const [msg, opts] = s.pushError.mock.calls[0];
    expect(msg).toContain("validationException");
    expect(opts.exception).toBeInstanceOf(AWSServiceError);
    expect(opts.exception.code).toBe("validationException");
    expect(frames[frames.length - 1]).toBeInstanceOf(LLMFullResponseEndFrame);
  });

  test("an HTTP error response becomes an AWSServiceError", async () => {
    const { s } = makeService(
      () =>
        new Response(JSON.stringify({ message: "Too many requests" }), {
          status: 429,
          headers: { "x-amzn-ErrorType": "ThrottlingException:http://internal.amazon.com/" },
        }),
    );
    const context = new LLMContext({ messages: [{ role: "user", content: "Hi" }] });
    await s._processContext(context);
    const [, opts] = s.pushError.mock.calls[0];
    expect(opts.exception.code).toBe("ThrottlingException");
    expect(opts.exception.status).toBe(429);
  });
});

describe("AWSBedrockLLMService Converse", () => {
  test("runInference returns the first text block", async () => {
    const { requests, service } = makeService(
      () =>
        new Response(
          JSON.stringify({
            output: { message: { role: "assistant", content: [{ text: "Summary." }] } },
            stopReason: "end_turn",
          }),
        ),
      new AWSBedrockLLMSettings({ model: "us.anthropic.claude-sonnet-4-6-v1:0", effort: "low" }),
    );
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
    });
    const result = await service.runInference(context, {
      maxTokens: 50,
      systemInstruction: "Summarize.",
    });
    expect(result).toBe("Summary.");
    const req = requests[0] as Captured;
    expect(req.url).toBe(
      "https://bedrock-runtime.eu-west-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-6-v1%3A0/converse",
    );
    expect(req.body).toEqual({
      messages: [
        { role: "user", content: [{ text: "Hi" }] },
        { role: "assistant", content: [{ text: "Hello" }] },
        // Claude 4.6 rejects assistant prefill, so a user turn is appended.
        { role: "user", content: [{ text: "." }] },
      ],
      additionalModelRequestFields: {},
      inferenceConfig: { maxTokens: 50 },
      outputConfig: { effort: "low" },
      system: [{ text: "Summarize." }],
    });
  });
});
