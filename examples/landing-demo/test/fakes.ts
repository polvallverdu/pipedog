// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Everything the demo talks to, faked on one local server, for the end-to-end test and for
// running the landing page's widget against a local Worker:
//
// - Workers AI through the binding (`/binding/<model>`, as `src/dev_ai.ts` calls it): Deepgram
//   Flux, which answers a scripted user turn every `turnEvery` audio messages, and Aura, which
//   answers each Flush with a short tone. The protocols are those of @pipedog/cloudflare's
//   `test/fake_workers_ai.ts` (Workers AI's Flux messages carry no `type`).
// - The Anthropic Messages API (`/v1/messages`), streaming: a user turn gets a sentence and a
//   tool call, chosen from what the user said; a tool result gets a short spoken answer.
// - Open-Meteo, the docs' llms.txt, /cdn-cgi/trace and Turnstile's siteverify.

import type { Server, ServerWebSocket } from "bun";

export interface FakesOptions {
  /** What the user says, one per turn, in order. */
  turns?: string[];
  /** Audio messages between turns. About 20-32 ms of audio each. */
  turnEvery?: number;
  /** Milliseconds of tone Aura answers each Flush with. */
  toneMs?: number;
}

export interface Fakes {
  url: string;
  anthropicRequests: Record<string, any>[];
  anthropicHeaders: Record<string, string>[];
  siteverify: { secret: string; response: string; remoteip: string | null }[];
  /** Text Aura was asked to speak. */
  spoken: string[];
  stop(): void;
}

export const DOCS_INDEX = `# pipedog

> pipedog is an unofficial TypeScript port of Pipecat.

- **Get started**
- [Introduction](http://docs.test/pipedog/docs.md): pipedog is an unofficial TypeScript port of Pipecat.
- [Quickstart](http://docs.test/pipedog/docs/quickstart.md): Build and run your first pipedog pipeline.

- **Core concepts**
- [Turn detection](http://docs.test/pipedog/docs/concepts/turn-detection.md): Decide when the user has finished speaking, with local models, with VAD only, or on the provider's side.
- [Typed tools](http://docs.test/pipedog/docs/concepts/typed-tools.md): Define LLM function calls with a Zod, Valibot or ArkType schema.

- **Deployment**
- [Voice agent fully on Cloudflare](http://docs.test/pipedog/docs/deployment/cloudflare-workers-ai.md): Run the whole voice stack on Cloudflare, with Deepgram Flux and Aura.
`;

export const TRACE =
  "fl=1f1\nh=www.cloudflare.com\nip=203.0.113.9\nts=1761220000.1\nvisit_scheme=https\ncolo=MAD\nhttp=http/2\nloc=ES\ntls=TLSv1.3\n";

/** Which tool the fake model calls for an utterance, and with what. */
export function toolFor(
  utterance: string,
): { name: string; input: Record<string, unknown> } | null {
  const text = utterance.toLowerCase();
  if (text.includes("weather")) {
    const city =
      /in ([a-z ]+)/i
        .exec(utterance)?.[1]
        ?.replace(/[?.!]+$/, "")
        .trim() ?? "Paris";
    return { name: "get_weather", input: { city } };
  }
  if (text.includes("where") && (text.includes("running") || text.includes("am i"))) {
    return { name: "where_am_i", input: {} };
  }
  if (text.includes("time")) return { name: "get_time", input: { timezone: "Asia/Tokyo" } };
  if (text.includes("doc") || text.includes("turn detection") || text.includes("how")) {
    return { name: "search_docs", input: { query: "turn detection" } };
  }
  if (text.includes("bye")) return { name: "end_call", input: {} };
  return null;
}

/** The fake model's spoken answer to a tool result. */
function answerFor(name: string, result: string): string {
  if (name === "get_weather") {
    const t = /"temperature_c":\s*([\d.]+)/.exec(result)?.[1] ?? "18";
    return `It's ${Math.round(Number(t))} degrees and partly cloudy there right now.`;
  }
  if (name === "where_am_i") {
    const colo = /"bot_data_center":\s*"([A-Z]+)"/.exec(result)?.[1] ?? "somewhere";
    return `I'm running in Cloudflare's ${colo} data centre, close to you.`;
  }
  if (name === "get_time") return "It's evening in Tokyo, a little after seven.";
  if (name === "search_docs") {
    return "The docs cover that under Concepts, Turn detection: Flux decides turns on Cloudflare's side.";
  }
  return "Done.";
}

function sse(events: Record<string, unknown>[]): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
        );
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

let messageCount = 0;

/** A streamed Messages API reply: optional text, then optionally one tool call. */
function streamReply(text: string, tool: { name: string; input: Record<string, unknown> } | null) {
  messageCount += 1;
  const events: Record<string, unknown>[] = [
    {
      type: "message_start",
      message: {
        id: `msg_${messageCount}`,
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 42,
          output_tokens: 1,
          cache_creation_input_tokens: messageCount === 1 ? 1300 : 0,
          cache_read_input_tokens: messageCount === 1 ? 0 : 1300,
        },
      },
    },
    { type: "ping" },
  ];
  let index = 0;
  if (text) {
    events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    for (const piece of text.match(/\S+\s*/g) ?? []) {
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: piece },
      });
    }
    events.push({ type: "content_block_stop", index });
    index += 1;
  }
  if (tool) {
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: `toolu_${messageCount}`, name: tool.name, input: {} },
    });
    const json = JSON.stringify(tool.input);
    const half = Math.ceil(json.length / 2);
    for (const part of [json.slice(0, half), json.slice(half)]) {
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: part },
      });
    }
    events.push({ type: "content_block_stop", index });
  }
  events.push({
    type: "message_delta",
    delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 24 },
  });
  events.push({ type: "message_stop" });
  return sse(events);
}

/** A declined request: HTTP 200, no content, `stop_reason: "refusal"`. */
function streamRefusal(): Response {
  messageCount += 1;
  return sse([
    {
      type: "message_start",
      message: {
        id: `msg_${messageCount}`,
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 40, output_tokens: 1 },
      },
    },
    {
      type: "message_delta",
      delta: {
        stop_reason: "refusal",
        stop_sequence: null,
        stop_details: { type: "refusal", category: "general_harms", explanation: null },
      },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

function anthropicReply(body: Record<string, any>): Response {
  const messages = (body.messages ?? []) as { role: string; content: unknown }[];
  const last = messages.at(-1);
  const blocks = Array.isArray(last?.content) ? (last.content as Record<string, any>[]) : [];
  const toolResult = blocks.find((b) => b.type === "tool_result");
  if (toolResult) {
    // Find the call it answers, for its name.
    let name = "";
    for (const m of messages) {
      for (const b of Array.isArray(m.content) ? (m.content as Record<string, any>[]) : []) {
        if (b.type === "tool_use" && b.id === toolResult.tool_use_id) name = b.name;
      }
    }
    const content =
      typeof toolResult.content === "string"
        ? toolResult.content
        : JSON.stringify(toolResult.content);
    return streamReply(answerFor(name, content), null);
  }
  const said =
    typeof last?.content === "string"
      ? last.content
      : blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join(" ");
  if (/dangerous/i.test(said)) return streamRefusal();
  const tool = toolFor(said);
  return streamReply(
    tool ? "Let me check." : "Happy to help. Ask me about the weather, or the docs.",
    tool,
  );
}

/** A 440 Hz tone, 16-bit PCM at 24 kHz, fading in and out. */
function tone(ms: number): Uint8Array {
  const samples = Math.round((24000 * ms) / 1000);
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    const env = Math.min(1, i / 1200, (samples - i) / 1200);
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 6000 * env);
  }
  return new Uint8Array(pcm.buffer);
}

interface SocketData {
  model: string;
  audioMessages: number;
  turn: number;
}

export function startFakes(options: FakesOptions = {}): Fakes {
  const turns = options.turns ?? ["What's the weather in Paris?"];
  const turnEvery = options.turnEvery ?? 60;
  const pcm = tone(options.toneMs ?? 600);
  const anthropicRequests: Record<string, any>[] = [];
  const anthropicHeaders: Record<string, string>[] = [];
  const siteverify: Fakes["siteverify"] = [];
  const spoken: string[] = [];

  const flux = (ws: ServerWebSocket<SocketData>) => {
    const data = ws.data;
    data.audioMessages += 1;
    if (data.audioMessages % turnEvery !== 0 || data.turn >= turns.length) return;
    const transcript = turns[data.turn]!;
    const turnIndex = data.turn;
    data.turn += 1;
    const words = transcript.split(" ");
    const send = (event: string, text: string) =>
      ws.send(
        JSON.stringify({
          request_id: "req",
          sequence_id: 0,
          event,
          turn_index: turnIndex,
          audio_window_start: 0,
          audio_window_end: 1,
          transcript: text,
          words: text ? text.split(" ").map((word) => ({ word, confidence: 0.98 })) : [],
          end_of_turn_confidence: event === "EndOfTurn" ? 0.92 : 0.1,
        }),
      );
    send("StartOfTurn", "");
    // Interim updates, a word or two at a time, then the end of the turn.
    const steps = [Math.ceil(words.length / 3), Math.ceil((2 * words.length) / 3)];
    steps.forEach((n, i) => {
      setTimeout(() => send("Update", words.slice(0, n).join(" ")), 120 * (i + 1));
    });
    setTimeout(() => send("EndOfTurn", transcript), 120 * (steps.length + 1));
  };

  const server: Server<SocketData> = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, srv) {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path.startsWith("/binding/")) {
        const model = decodeURIComponent(path.slice("/binding/".length));
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (srv.upgrade(request, { data: { model, audioMessages: 0, turn: 0 } }))
            return undefined;
          return new Response("upgrade failed", { status: 400 });
        }
        return Response.json({ errors: [{ message: `no HTTP model ${model}` }] }, { status: 400 });
      }

      if (path === "/v1/messages" && request.method === "POST") {
        const body = (await request.json()) as Record<string, any>;
        anthropicRequests.push(body);
        anthropicHeaders.push(Object.fromEntries(request.headers));
        return anthropicReply(body);
      }

      if (path === "/geocoding") {
        const name = url.searchParams.get("name") ?? "";
        if (/nowhere/i.test(name)) return Response.json({});
        return Response.json({
          results: [
            { name, country: "France", admin1: "Île-de-France", latitude: 48.85, longitude: 2.35 },
          ],
        });
      }
      if (path === "/forecast") {
        return Response.json({
          timezone: "Europe/Paris",
          current: {
            time: "2026-10-23T14:00",
            temperature_2m: 18.4,
            apparent_temperature: 17.6,
            relative_humidity_2m: 61,
            weather_code: 2,
            wind_speed_10m: 11.2,
          },
        });
      }
      if (path === "/llms.txt") return new Response(DOCS_INDEX);
      if (path === "/cdn-cgi/trace") return new Response(TRACE);
      if (path === "/siteverify" && request.method === "POST") {
        const form = await request.formData();
        const entry = {
          secret: String(form.get("secret") ?? ""),
          response: String(form.get("response") ?? ""),
          remoteip: form.get("remoteip") === null ? null : String(form.get("remoteip")),
        };
        siteverify.push(entry);
        return Response.json({
          success: entry.response === "pass-token" && entry.secret === "turnstile-secret",
        });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, message) {
        const { model } = ws.data;
        if (typeof message === "string") {
          if (model.startsWith("@cf/deepgram/aura")) {
            const msg = JSON.parse(message) as { type: string; text?: string };
            if (msg.type === "Speak" && msg.text) spoken.push(msg.text);
            if (msg.type === "Flush") {
              ws.sendBinary(pcm);
              ws.send(JSON.stringify({ type: "Flushed", sequence_id: 0 }));
            } else if (msg.type === "Clear") {
              ws.send(JSON.stringify({ type: "Cleared", sequence_id: 0 }));
            }
          }
          return;
        }
        if (model === "@cf/deepgram/flux") flux(ws);
      },
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    anthropicRequests,
    anthropicHeaders,
    siteverify,
    spoken,
    stop: () => server.stop(true),
  };
}

/** The `--var` flags that point the Worker at the fakes. */
export function fakeVars(url: string): string[] {
  return [
    `FAKE_AI_URL:${url}`,
    `ANTHROPIC_BASE_URL:${url}`,
    `TURNSTILE_VERIFY_URL:${url}/siteverify`,
    `OPEN_METEO_GEOCODING_URL:${url}/geocoding`,
    `OPEN_METEO_FORECAST_URL:${url}/forecast`,
    `DOCS_INDEX_URL:${url}/llms.txt`,
    `TRACE_URL:${url}/cdn-cgi/trace`,
  ];
}
