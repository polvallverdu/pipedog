// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A scripted chat model that calls tools, for tests that run function calling
// through a real pipeline. It speaks the streaming chat protocol of OpenAI
// (/v1/chat/completions), Anthropic (/v1/messages) or Gemini
// (:streamGenerateContent), and answers the nth request with the nth scripted
// reply: text, or one or more tool calls. It records each request with the
// names of the tools the request offered, so a test can check which tools the
// service advertised at each step.

export type ToolLLMProvider = "openai" | "anthropic" | "google";

export interface ScriptedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** What the mock model says: text, tool calls, or both. */
export interface ScriptedReply {
  text?: string;
  toolCalls?: ScriptedToolCall[];
}

export interface ToolLLMRequest {
  /** The names of the tools the request offered. */
  tools: string[];
  /** The request's JSON body, as the provider's API defines it. */
  body: Record<string, any>;
}

export interface MockToolLLM {
  /** Base URL for the provider's client: OpenAI's `baseUrl`, Anthropic's `baseURL`, Gemini's `httpOptions.baseUrl`. */
  baseUrl: string;
  /** Every chat request received, in order. */
  requests: ToolLLMRequest[];
  stop(): void;
}

/** The script: one reply per request, or a function of the request and its index. */
export type ToolLLMScript =
  | readonly ScriptedReply[]
  | ((request: ToolLLMRequest, index: number) => ScriptedReply);

/** The names of the tools a request offers, in the provider's format. */
function toolNames(provider: ToolLLMProvider, body: Record<string, any>): string[] {
  const tools: any[] = body.tools ?? [];
  if (provider === "openai") return tools.map((t) => t.function?.name);
  if (provider === "anthropic") return tools.map((t) => t.name);
  return tools.flatMap((t) => (t.functionDeclarations ?? []).map((d: any) => d.name));
}

function sseResponse(events: string): Response {
  return new Response(events, { headers: { "content-type": "text/event-stream" } });
}

function openaiReply(reply: ScriptedReply, index: number): Response {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: `chatcmpl-mock-${index}`,
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  let out = chunk({ role: "assistant", content: reply.text ?? null }, null);
  const calls = reply.toolCalls ?? [];
  calls.forEach((call, i) => {
    out += chunk(
      {
        tool_calls: [
          {
            index: i,
            id: `call_${index}_${i}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          },
        ],
      },
      null,
    );
  });
  out += chunk({}, calls.length > 0 ? "tool_calls" : "stop");
  return sseResponse(`${out}data: [DONE]\n\n`);
}

function anthropicReply(reply: ScriptedReply, index: number): Response {
  const event = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const calls = reply.toolCalls ?? [];
  let out = event("message_start", {
    message: {
      id: `msg_mock_${index}`,
      type: "message",
      role: "assistant",
      content: [],
      model: "mock",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  let block = 0;
  if (reply.text) {
    out += event("content_block_start", {
      index: block,
      content_block: { type: "text", text: "" },
    });
    out += event("content_block_delta", {
      index: block,
      delta: { type: "text_delta", text: reply.text },
    });
    out += event("content_block_stop", { index: block });
    block++;
  }
  calls.forEach((call, i) => {
    out += event("content_block_start", {
      index: block,
      content_block: { type: "tool_use", id: `toolu_${index}_${i}`, name: call.name, input: {} },
    });
    out += event("content_block_delta", {
      index: block,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) },
    });
    out += event("content_block_stop", { index: block });
    block++;
  });
  out += event("message_delta", {
    delta: { stop_reason: calls.length > 0 ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  out += event("message_stop", {});
  return sseResponse(out);
}

function googleReply(reply: ScriptedReply): Response {
  const parts: Record<string, unknown>[] = [];
  if (reply.text) parts.push({ text: reply.text });
  for (const call of reply.toolCalls ?? []) {
    parts.push({ functionCall: { name: call.name, args: call.arguments } });
  }
  return sseResponse(
    `data: ${JSON.stringify({
      candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
    })}\n\n`,
  );
}

/**
 * Start a mock chat model that follows `script`.
 *
 * A request past the end of an array script gets an empty text reply, so a
 * conversation that loops does not hang.
 */
export function startMockToolLLM(provider: ToolLLMProvider, script: ToolLLMScript): MockToolLLM {
  const mock: MockToolLLM = { baseUrl: "", requests: [], stop: () => server.stop(true) };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const path =
        provider === "openai"
          ? "/v1/chat/completions"
          : provider === "anthropic"
            ? "/v1/messages"
            : ":streamGenerateContent";
      if (request.method !== "POST" || !pathname.endsWith(path)) {
        return new Response("not found", { status: 404 });
      }
      const body = (await request.json()) as Record<string, any>;
      const entry: ToolLLMRequest = { tools: toolNames(provider, body), body };
      const index = mock.requests.length;
      mock.requests.push(entry);
      const reply: ScriptedReply =
        typeof script === "function" ? script(entry, index) : (script[index] ?? { text: "" });
      if (provider === "openai") return openaiReply(reply, index);
      if (provider === "anthropic") return anthropicReply(reply, index);
      return googleReply(reply);
    },
  });

  mock.baseUrl =
    provider === "openai"
      ? `http://127.0.0.1:${server.port}/v1`
      : `http://127.0.0.1:${server.port}`;
  return mock;
}
