// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Everything the demo talks to, faked on one local server, for the end-to-end test and for
// running the landing page's widget against a local Worker:
//
// - Workers AI through the binding (`/binding/<model>`, as `src/dev_ai.ts` calls it):
//   - Deepgram Nova-3 (Deepgram's listen protocol): each stretch of sound on the microphone is the
//     next scripted user turn, transcribed a word at a time as interim `Results`, and in full as
//     the final one when the service sends `Finalize` (VAD heard the user stop) or after a second
//     of silence. Silence transcribes as nothing, so it's real speech that drives the turns, as
//     Silero VAD in the Worker needs.
//   - Deepgram Flux (Workers AI's Flux messages, which carry no `type`): the same stretches of
//     sound and scripted turns, as `StartOfTurn`, `Update`s a word at a time, and `EndOfTurn`
//     after 600 ms of silence (Flux decides the end of the turn itself).
//   - Smart Turn v2 (`run`): every turn is complete.
//   - Aura, which answers each Flush with a short tone.
// - The Anthropic Messages API (`/v1/messages`), streaming: a user turn gets a sentence and a
//   tool call, chosen from what the user said; a tool result gets a short spoken answer.
// - Open-Meteo, the docs' llms.txt, /cdn-cgi/trace and Turnstile's siteverify.

import type { Server, ServerWebSocket } from "bun";

export interface FakesOptions {
  /** What the user says, one per stretch of speech on the microphone, in order. */
  turns?: string[];
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
  /** Smart Turn requests. */
  smartTurnRequests: number;
  /** The speech-to-text models sessions opened, in order. */
  sttModels: string[];
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

/** Whether 16-bit PCM is louder than silence or line noise. */
function isLoud(audio: Uint8Array): boolean {
  const pcm = new Int16Array(audio.buffer, audio.byteOffset, Math.floor(audio.byteLength / 2));
  let sum = 0;
  for (const v of pcm) sum += v * v;
  return pcm.length > 0 && Math.sqrt(sum / pcm.length) > 500;
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
  /** Nova-3: the next scripted turn. */
  turn: number;
  /** Nova-3: whether the microphone is in a stretch of sound, and how long it and the silence after it have lasted. */
  speaking: boolean;
  speechMs: number;
  silenceMs: number;
  /** Nova-3: words sent as interim results so far, and the transcript of this stretch (null: none). */
  interimWords: number;
  utterance: string | null;
  /** Flux: the turn's index. */
  fluxTurn: number;
}

/** Flux ends a turn after this much silence. */
const FLUX_END_OF_TURN_MS = 600;

export function startFakes(options: FakesOptions = {}): Fakes {
  const turns = options.turns ?? ["What's the weather in Paris?"];
  const pcm = tone(options.toneMs ?? 600);
  const anthropicRequests: Record<string, any>[] = [];
  const anthropicHeaders: Record<string, string>[] = [];
  const siteverify: Fakes["siteverify"] = [];
  const spoken: string[] = [];

  let smartTurnRequests = 0;
  const sttModels: string[] = [];

  const results = (
    ws: ServerWebSocket<SocketData>,
    transcript: string,
    final: { isFinal: boolean; fromFinalize?: boolean },
  ) =>
    ws.send(
      JSON.stringify({
        type: "Results",
        channel_index: [0, 1],
        duration: 0.5,
        start: 0,
        is_final: final.isFinal,
        speech_final: final.isFinal,
        from_finalize: final.fromFinalize ?? false,
        channel: {
          alternatives: [
            {
              transcript,
              confidence: 0.97,
              words: transcript ? transcript.split(" ").map((word) => ({ word })) : [],
              languages: ["en"],
            },
          ],
        },
        metadata: { request_id: "req", model_info: { name: "nova-3" } },
      }),
    );

  /** The current stretch of speech is over: its final transcript, if it has one. */
  const finish = (ws: ServerWebSocket<SocketData>, fromFinalize: boolean) => {
    const data = ws.data;
    if (data.utterance !== null) {
      results(ws, data.utterance, { isFinal: true, fromFinalize });
      data.utterance = null;
    } else if (fromFinalize) {
      results(ws, "", { isFinal: true, fromFinalize });
    }
    data.speaking = false;
    data.speechMs = 0;
  };

  const nova3Audio = (ws: ServerWebSocket<SocketData>, audio: Uint8Array) => {
    const data = ws.data;
    const ms = (audio.byteLength / 2 / 16000) * 1000;
    if (isLoud(audio)) {
      data.silenceMs = 0;
      if (!data.speaking) {
        // A new stretch of speech: the next scripted turn, if any is left.
        data.speaking = true;
        data.utterance = data.turn < turns.length ? turns[data.turn++]! : null;
      }
      data.speechMs += ms;
      if (data.utterance !== null) {
        // Interim results: a word per 150 ms of speech.
        const words = data.utterance.split(" ");
        const n = Math.min(words.length, Math.floor(data.speechMs / 150));
        if (n > data.interimWords) {
          data.interimWords = n;
          results(ws, words.slice(0, n).join(" "), { isFinal: false });
        }
      }
    } else if (data.speaking) {
      data.silenceMs += ms;
      // Deepgram's own endpointing, if the service never asks to finalize.
      if (data.silenceMs >= 1000) finish(ws, false);
    }
    if (!data.speaking) data.interimWords = 0;
  };

  /** A Flux TurnInfo message. */
  const turnInfo = (ws: ServerWebSocket<SocketData>, event: string, transcript: string) =>
    ws.send(
      JSON.stringify({
        request_id: "req",
        sequence_id: 0,
        event,
        turn_index: ws.data.fluxTurn,
        audio_window_start: 0,
        audio_window_end: 1,
        transcript,
        words: transcript ? transcript.split(" ").map((word) => ({ word, confidence: 0.98 })) : [],
        end_of_turn_confidence: event === "EndOfTurn" ? 0.92 : 0.1,
      }),
    );

  const fluxAudio = (ws: ServerWebSocket<SocketData>, audio: Uint8Array) => {
    const data = ws.data;
    const ms = (audio.byteLength / 2 / 16000) * 1000;
    if (isLoud(audio)) {
      data.silenceMs = 0;
      if (!data.speaking) {
        data.speaking = true;
        data.speechMs = 0;
        data.interimWords = 0;
        data.utterance = data.turn < turns.length ? turns[data.turn++]! : null;
        if (data.utterance !== null) turnInfo(ws, "StartOfTurn", "");
      }
      data.speechMs += ms;
      if (data.utterance !== null) {
        const words = data.utterance.split(" ");
        const n = Math.min(words.length, Math.floor(data.speechMs / 150));
        if (n > data.interimWords) {
          data.interimWords = n;
          turnInfo(ws, "Update", words.slice(0, n).join(" "));
        }
      }
    } else if (data.speaking) {
      data.silenceMs += ms;
      if (data.silenceMs >= FLUX_END_OF_TURN_MS) {
        if (data.utterance !== null) {
          turnInfo(ws, "EndOfTurn", data.utterance);
          data.fluxTurn += 1;
        }
        data.speaking = false;
        data.utterance = null;
      }
    }
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
          const data: SocketData = {
            model,
            turn: 0,
            speaking: false,
            speechMs: 0,
            silenceMs: 0,
            interimWords: 0,
            utterance: null,
            fluxTurn: 0,
          };
          if (model === "@cf/deepgram/flux" || model === "@cf/deepgram/nova-3") {
            sttModels.push(model);
          }
          if (srv.upgrade(request, { data })) return undefined;
          return new Response("upgrade failed", { status: 400 });
        }
        if (model === "@cf/pipecat-ai/smart-turn-v2") {
          smartTurnRequests += 1;
          return Response.json({ result: { is_complete: true, probability: 0.95 } });
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
          if (model === "@cf/deepgram/nova-3") {
            const msg = JSON.parse(message) as { type: string };
            if (msg.type === "Finalize") finish(ws, true);
            else if (msg.type === "CloseStream") ws.close();
            // KeepAlive: nothing to do.
          }
          return;
        }
        if (model === "@cf/deepgram/nova-3") nova3Audio(ws, new Uint8Array(message));
        else if (model === "@cf/deepgram/flux") fluxAudio(ws, new Uint8Array(message));
      },
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    anthropicRequests,
    anthropicHeaders,
    siteverify,
    spoken,
    get smartTurnRequests() {
      return smartTurnRequests;
    },
    sttModels,
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
