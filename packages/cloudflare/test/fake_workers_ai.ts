// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A fake Workers AI for the tests: a local server that answers the REST API
// (`/client/v4/accounts/{id}/ai/run/{model}`, HTTP and WebSocket) the way the
// model pages document it, and a fake `env.AI` binding whose `run()` goes to
// the same server, so both paths of every service run against one fake.

import type { Server, ServerWebSocket } from "bun";
import { WorkersAIClient } from "../src/client.ts";

export const ACCOUNT_ID = "test-account";
export const API_TOKEN = "test-token";

/** Bytes the fake Aura answers with, per flush. */
export const AURA_PCM = new Uint8Array(960).map((_, i) => i % 251);
/** The fake MeloTTS "MP3". */
export const MELO_MP3 = new TextEncoder().encode("ID3-fake-mp3");

export interface RecordedRequest {
  via: "rest" | "binding";
  model: string;
  /** JSON input (HTTP) or session parameters (WebSocket). */
  input: Record<string, unknown>;
  authorization: string | null;
  websocket: boolean;
  options?: Record<string, unknown>;
}

interface SessionData {
  model: string;
  audioMessages: number;
  textMessages: string[];
}

export interface FakeWorkersAI {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Text messages each WebSocket session received, in order of the sessions. */
  sessions: SessionData[];
  /** The fake `env.AI`. */
  binding: {
    run(model: string, input: unknown, options?: Record<string, unknown>): Promise<unknown>;
  };
  /** A client for the given path. */
  client(via: "rest" | "binding"): WorkersAIClient;
  /** Answer the next HTTP request for `model` with this status (once). */
  failNext(model: string, status: number): void;
  stop(): void;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function envelope(result: unknown): Response {
  return json({ result, success: true, errors: [], messages: [] });
}

/** The model's answer to an HTTP request, as the REST API gives it (in its envelope). */
function answer(model: string, input: Record<string, unknown>): Response {
  if (model.startsWith("@cf/openai/whisper")) {
    return envelope({ text: ` hello from ${model.split("/").at(-1)} `, word_count: 3 });
  }
  if (model === "@cf/pipecat-ai/smart-turn-v2") {
    const audio = typeof input.audio === "string" ? input.audio : "";
    // Complete when the segment is long enough (more than 0.25 s of float32 at 16 kHz).
    const samples = (audio.length * 3) / 4 / 4;
    return envelope({ is_complete: samples > 4000, probability: samples > 4000 ? 0.93 : 0.12 });
  }
  if (model === "@cf/myshell-ai/melotts") {
    return envelope({ audio: Buffer.from(MELO_MP3).toString("base64") });
  }
  if (model.startsWith("@cf/deepgram/aura")) {
    return new Response(AURA_PCM, { headers: { "Content-Type": "audio/l16" } });
  }
  return json({ success: false, errors: [{ code: 5007, message: `No such model ${model}` }] }, 400);
}

function sessionMessage(ws: ServerWebSocket<SessionData>, message: string | Buffer): void {
  const data = ws.data;
  if (typeof message === "string") {
    data.textMessages.push(message);
    if (data.model.startsWith("@cf/deepgram/aura")) {
      const msg = JSON.parse(message) as { type: string };
      if (msg.type === "Flush") {
        ws.sendBinary(AURA_PCM);
        ws.send(JSON.stringify({ type: "Flushed", sequence_id: 0 }));
      } else if (msg.type === "Clear") {
        ws.send(JSON.stringify({ type: "Cleared", sequence_id: 0 }));
      }
    }
    return;
  }
  data.audioMessages += 1;
  if (data.model === "@cf/deepgram/flux" && data.audioMessages === 5) {
    // Workers AI's documented Flux output: no `type` field.
    const turn = (event: string, transcript: string, extra: Record<string, unknown> = {}) =>
      ws.send(
        JSON.stringify({
          request_id: "req",
          sequence_id: 0,
          event,
          turn_index: 0,
          audio_window_start: 0,
          audio_window_end: 1,
          transcript,
          words: transcript
            ? transcript.split(" ").map((word) => ({ word, confidence: 0.98 }))
            : [],
          end_of_turn_confidence: event === "EndOfTurn" ? 0.9 : 0.1,
          ...extra,
        }),
      );
    turn("StartOfTurn", "");
    turn("Update", "hello");
    turn("EndOfTurn", "hello cloudflare");
  }
  if (data.model === "@cf/deepgram/nova-3" && data.audioMessages === 5) {
    ws.send(
      JSON.stringify({
        type: "Results",
        is_final: false,
        speech_final: false,
        channel: { alternatives: [{ transcript: "hello", confidence: 0.9 }] },
      }),
    );
    ws.send(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: true,
        channel: { alternatives: [{ transcript: "hello nova", confidence: 0.95 }] },
      }),
    );
  }
}

/** Start the fake. Call `stop()` when done. */
export function startFakeWorkersAI(): FakeWorkersAI {
  const requests: RecordedRequest[] = [];
  const sessions: SessionData[] = [];
  const failures = new Map<string, number>();
  const prefix = `/client/v4/accounts/${ACCOUNT_ID}/ai/run/`;

  const server: Server<SessionData> = Bun.serve<SessionData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, srv) {
      const url = new URL(request.url);
      const binding = url.pathname.startsWith("/binding/");
      const path = binding ? url.pathname.slice("/binding/".length) : url.pathname;
      if (!binding && !path.startsWith(prefix)) {
        return json({ success: false, errors: [{ message: "not found" }] }, 404);
      }
      const model = decodeURIComponent(binding ? path : path.slice(prefix.length));
      const authorization = request.headers.get("authorization");
      if (!binding && authorization !== `Bearer ${API_TOKEN}`) {
        return json(
          { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
          401,
        );
      }
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const input: Record<string, unknown> = {};
        for (const key of new Set(url.searchParams.keys())) {
          const values = url.searchParams.getAll(key);
          input[key] = values.length > 1 ? values : values[0];
        }
        if (!binding) {
          requests.push({ via: "rest", model, input, authorization, websocket: true });
        }
        const data: SessionData = { model, audioMessages: 0, textMessages: [] };
        sessions.push(data);
        if (srv.upgrade(request, { data })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      const input = (await request.json()) as Record<string, unknown>;
      if (!binding) requests.push({ via: "rest", model, input, authorization, websocket: false });
      const status = failures.get(model);
      if (status !== undefined) {
        failures.delete(model);
        return json(
          { success: false, errors: [{ code: 3040, message: "Capacity temporarily exceeded" }] },
          status,
        );
      }
      return answer(model, input);
    },
    // Deepgram's own endpoints greet a session with `Connected`/`Metadata`;
    // Workers AI documents neither, so the fake sends nothing on open.
    websocket: { message: sessionMessage },
  });

  const httpBase = `http://127.0.0.1:${server.port}`;

  const fakeBinding = {
    async run(model: string, input: unknown, options: Record<string, unknown> = {}) {
      const inputs = (input ?? {}) as Record<string, unknown>;
      requests.push({
        via: "binding",
        model,
        input: inputs,
        authorization: null,
        websocket: Boolean(options.websocket),
        options,
      });
      if (options.websocket) {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(inputs)) {
          for (const item of Array.isArray(value) ? value : [value])
            query.append(key, String(item));
        }
        const ws = new WebSocket(
          `ws://127.0.0.1:${server.port}/binding/${encodeURIComponent(model)}?${query}`,
        ) as WebSocket & { accept(): void; accepted?: boolean };
        // Workers sockets from a `fetch` need accept(); a test can check it was called.
        ws.accept = () => {
          ws.accepted = true;
        };
        return { status: 101, webSocket: ws };
      }
      const failure = failures.get(model);
      let response: Response;
      if (failure !== undefined) {
        failures.delete(model);
        response = json({ errors: [{ message: "Capacity temporarily exceeded" }] }, failure);
      } else {
        response = await fetch(`${httpBase}/binding/${encodeURIComponent(model)}`, {
          method: "POST",
          body: JSON.stringify(inputs),
        });
      }
      if (options.returnRawResponse) {
        // The binding answers with the model's own output, not the REST envelope.
        if ((response.headers.get("content-type") ?? "").includes("json") && response.ok) {
          const data = (await response.json()) as { result?: unknown };
          return json(data.result ?? data);
        }
        return response;
      }
      if (!response.ok) throw new Error(`AiError: ${await response.text()}`);
      const data = (await response.json()) as { result?: unknown };
      return data.result;
    },
  };

  return {
    baseUrl: `${httpBase}/client/v4`,
    requests,
    sessions,
    binding: fakeBinding,
    client(via) {
      return via === "binding"
        ? new WorkersAIClient({ ai: fakeBinding })
        : new WorkersAIClient({
            accountId: ACCOUNT_ID,
            apiToken: API_TOKEN,
            baseUrl: `${httpBase}/client/v4`,
          });
    },
    failNext(model, status) {
      failures.set(model, status);
    },
    stop() {
      server.stop(true);
    },
  };
}
