// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Parallel voice agents on Durable Objects, end to end: `wrangler dev` runs the
// Worker locally (workerd), two scripted users stream the same question to two
// sessions at once, and each session must answer on its own. The OpenAI API is
// the mock from the SmallWebRTC example, so no API key is needed.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type MockObservability,
  startMockObservability,
} from "@pipedog/example-test-mocks/mock_observability";
import { type MockOpenAI, startMockOpenAI } from "@pipedog/example-test-mocks/mock_openai";
import { ANSWER, SCRIPTED_QUESTION } from "@pipedog/example-test-mocks/mock_provider";
import { runScriptedUser } from "../client/client.ts";
import { wavToPcm16k } from "../client/wav.ts";

const EXAMPLE = join(import.meta.dir, "..");
const QUESTION_WAV = join(
  import.meta.dir,
  "..",
  "..",
  "test-mocks",
  "assets",
  "capital_question.wav",
);
const WRANGLER = join(EXAMPLE, "node_modules", ".bin", "wrangler");
const STARTUP_TIMEOUT_MS = 180_000;
const LOG_DIR = join(EXAMPLE, "node_modules", ".cache", "workers-e2e");

let mock: MockOpenAI;
let observability: MockObservability;
let worker: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;

/** Start `wrangler dev` and resolve once it reports it is ready. */
mkdirSync(LOG_DIR, { recursive: true });

async function startWorker(
  apiBase: string,
  realtimeUrl: string,
  obs: MockObservability,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; port: number }> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const freePort = probe.port;
  probe.stop(true);

  const proc = Bun.spawn(
    [
      WRANGLER,
      "dev",
      "--port",
      String(freePort),
      "--ip",
      "127.0.0.1",
      "--var",
      "OPENAI_API_KEY:test-key",
      "--var",
      `OPENAI_BASE_URL:${apiBase}`,
      "--var",
      `OPENAI_REALTIME_URL:${realtimeUrl}`,
      "--var",
      `OTEL_EXPORTER_OTLP_ENDPOINT:${obs.tracesUrl}`,
      "--var",
      `ERROR_WEBHOOK_URL:${obs.webhookUrl}`,
      // Fresh Durable Object storage each run: sessions keep their conversation.
      "--persist-to",
      mkdtempSync(join(LOG_DIR, "state-")),
    ],
    { cwd: EXAMPLE, stdout: "pipe", stderr: "pipe" },
  );

  const log = Bun.file(join(LOG_DIR, "wrangler.log")).writer();
  const ready = new Promise<void>((resolve, reject) => {
    const scan = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        log.write(chunk);
        if (decoder.decode(chunk).includes("Ready on")) resolve();
      }
    };
    scan(proc.stdout as ReadableStream<Uint8Array>).catch(reject);
    scan(proc.stderr as ReadableStream<Uint8Array>).catch(reject);
    proc.exited.then((code) => reject(new Error(`wrangler exited with code ${code}`)));
  });
  await Promise.race([
    ready,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("wrangler dev did not start")), STARTUP_TIMEOUT_MS),
    ),
  ]);
  return { proc, port: freePort };
}

beforeAll(async () => {
  mock = startMockOpenAI();
  observability = startMockObservability();
  const started = await startWorker(mock.baseUrl, mock.realtimeUrl, observability);
  worker = started.proc;
  port = started.port;
}, STARTUP_TIMEOUT_MS + 30_000);

afterAll(() => {
  worker?.kill();
  mock?.stop();
  observability?.stop();
});

test("two voice sessions run in parallel, each on its own Durable Object", async () => {
  const pcm = wavToPcm16k(readFileSync(QUESTION_WAV));
  const sessions = ["alice", "bob"].map((id) =>
    runScriptedUser(`ws://127.0.0.1:${port}/api/session/${id}`, pcm, 15),
  );
  const [alice, bob] = await Promise.all(sessions);

  // Each session heard its own reply.
  expect(alice!.spokenBytes).toBeGreaterThan(0);
  expect(bob!.spokenBytes).toBeGreaterThan(0);

  // Each session's question reached the chat model, and each got an answer.
  const questions = mock.asked.filter((q) => q.includes(SCRIPTED_QUESTION));
  expect(questions.length).toBeGreaterThanOrEqual(2);
  expect(mock.spoken.filter((s) => s === ANSWER).length).toBeGreaterThanOrEqual(2);

  // Turn detection ran on the provider: each session opened a realtime
  // transcription socket, authenticated with its key.
  expect(
    mock.realtimeAuth.filter((auth) => auth === "Bearer test-key").length,
  ).toBeGreaterThanOrEqual(2);

  // They ran at the same time.
  expect(alice!.startedAt < bob!.endedAt && bob!.startedAt < alice!.endedAt).toBe(true);

  // Each session was traced, and its spans flushed when it ended.
  for (let i = 0; i < 100 && observability.traces.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(observability.traces.length).toBeGreaterThan(0);
}, 240_000);

test("a pipeline error is posted to the error webhook", async () => {
  mock.failChat = true;
  try {
    const pcm = wavToPcm16k(readFileSync(QUESTION_WAV));
    await runScriptedUser(`ws://127.0.0.1:${port}/api/session/dave`, pcm, 10);
    for (let i = 0; i < 100 && observability.alerts.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const alert = observability.alerts[0]!;
    expect(String(alert.text)).toContain("Voice agent error in conversation");
    expect(String(alert.error).length).toBeGreaterThan(0);
  } finally {
    mock.failChat = false;
  }
}, 120_000);

test("a request that isn't a WebSocket upgrade is refused", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/session/carol`);
  expect(response.status).toBe(426);
});

test("a client that reconnects to its session continues the conversation", async () => {
  const pcm = wavToPcm16k(readFileSync(QUESTION_WAV));
  const url = `ws://127.0.0.1:${port}/api/session/erin`;
  const chatsBefore = mock.chats.length;

  // First connection: greeted, asks, hangs up.
  await runScriptedUser(url, pcm, 6);
  // Second connection to the same session: asks again.
  await runScriptedUser(url, pcm, 6);

  // Only the first connection asked the model for a greeting.
  const chats = mock.chats.slice(chatsBefore);
  const greetingRequests = chats.filter((messages) => {
    const last = messages[messages.length - 1];
    return last?.role === "developer" && String(last.content).includes("introduce yourself");
  });
  expect(greetingRequests.length).toBe(1);
  // Its question went to the model with the first connection's conversation.
  const userTurns = (messages: { role: string; content: unknown }[]) =>
    messages.filter((m) => m.role === "user" && String(m.content).includes(SCRIPTED_QUESTION))
      .length;
  const resumed = chats.some((messages) => userTurns(messages) >= 2);
  expect(resumed).toBe(true);
}, 120_000);
