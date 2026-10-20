// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_classifiers_clef.py

import { afterEach, describe, expect, mock, test } from "bun:test";
import { deflateSync } from "node:zlib";

import * as asyncio from "@pipecat-ts/asyncio";

import {
  ChoiceQuestion,
  ClassifierError,
  ClassifierImage,
  ScoreQuestion,
  YesNoQuestion,
} from "../src/classifiers/base_classifier.ts";
import {
  CLEF_MAX_CHOICE_OPTIONS,
  CLEF_MAX_IMAGES,
  ClefClassifier,
} from "../src/classifiers/cloudflare/clef/classifier.ts";
import { ClefClient, type ClefClientOptions } from "../src/classifiers/cloudflare/clef/client.ts";
import type { HttpClient } from "../src/classifiers/http_client.ts";
import {
  LLMUsageMetricsData,
  type MetricsData,
  ProcessingMetricsData,
} from "../src/metrics/metrics.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";

const USAGE = { input_tokens: 12, output_tokens: 0 };
const NOUL = { answer: { type: "noul", instructions: "?" } };

/** The parts of a request the handlers look at (upstream's `httpx.Request`). */
interface MockRequest {
  method: string;
  url: URL;
  headers: Headers;
  /** The body as sent. */
  content: string;
}

type Handler = (request: MockRequest) => Response;

/** The client's HTTP client, protected in the port (upstream's `client._http`). */
function http(client: ClefClient): HttpClient {
  return (client as unknown as { _http: HttpClient })._http;
}

/** A client whose requests `handler` answers instead of Workers AI. */
function _client(
  handler: Handler,
  options: Omit<ClefClientOptions, "accountId" | "apiKey"> = {},
): ClefClient {
  const client = new ClefClient({ accountId: "acct", apiKey: "key", ...options });
  // Upstream swaps in an `httpx.MockTransport`.
  http(client).transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: MockRequest = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      content: typeof init?.body === "string" ? init.body : "",
    };
    return handler(request);
  }) as typeof fetch;
  return client;
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function _success(result: Record<string, unknown>): Response {
  return jsonResponse(200, { result, success: true, errors: [], messages: [] });
}

function _reply(answer: Record<string, unknown>): Response {
  return _success({ model: "clef", answers: { answer }, usage: USAGE });
}

function _failure(status: number, ...reasons: string[]): Response {
  return jsonResponse(status, {
    result: null,
    success: false,
    errors: reasons.map((reason) => ({ code: 1000, message: reason })),
    messages: [],
  });
}

function _schema(_request: MockRequest): Response {
  return _success({ input: {}, output: {} });
}

/** CRC-32 for PNG chunks. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

const COLORS: Record<string, [number, number, number]> = {
  red: [255, 0, 0],
  blue: [0, 0, 255],
};

/**
 * A camera-sized image with a circle in the middle.
 *
 * PORTING NOTE: upstream draws it with Pillow and saves a JPEG; with no image
 * encoder in the port, this writes the same picture as a PNG.
 */
function _circle(color: string): ClassifierImage {
  const [width, height] = [640, 480];
  const fill = COLORS[color] as [number, number, number];
  const raw = new Uint8Array(height * (1 + width * 3));
  // Pillow's ellipse((220, 140, 420, 340)): center (320, 240), radius 100.
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const inside = (x - 320) ** 2 + (y - 240) ** 2 <= 100 ** 2;
      const [r, g, b] = inside ? fill : [255, 255, 255];
      raw.set([r, g, b], row + 1 + x * 3);
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw))),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const data = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return new ClassifierImage({ data, contentType: "image/png" });
}

/** Python's `base64.b64encode(data).decode()`. */
function b64(text: string): string {
  return btoa(text);
}

/** Replaces the client's `sleep` (upstream monkeypatches `asyncio.sleep`). */
// Like upstream's monkeypatch of `asyncio.sleep` in the client module. Replace
// the module rather than spying on a namespace object: other test files swap
// @pipecat-ts/asyncio with mock.module, and a spy on a stale namespace would
// then miss the binding the client actually calls.
const originalAsyncio = { ...asyncio };
let sleepPatched = false;

function patchSleep(fn: (seconds: number) => Promise<void>) {
  sleepPatched = true;
  mock.module("@pipecat-ts/asyncio", () => ({ ...originalAsyncio, sleep: fn }));
}

afterEach(() => {
  // Restore any sleep patched by a test.
  if (sleepPatched) {
    mock.module("@pipecat-ts/asyncio", () => originalAsyncio);
    sleepPatched = false;
  }
});

describe("TestClefClient", () => {
  test("test_sends_questions_to_the_models_endpoint_with_auth", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.url = String(request.url);
      seen.auth = request.headers.get("Authorization");
      seen.body = JSON.parse(request.content);
      return _reply({ type: "noul", noul: 0.9 });
    };

    const client = _client(handler);
    const [answers, usage] = await client.ask("hello", {
      answer: { type: "noul", instructions: "a greeting?" },
    });

    expect(answers.answer).toEqual({ type: "noul", noul: 0.9 });
    expect([usage.inputTokens, usage.outputTokens]).toEqual([12, 0]);
    expect(seen.url).toEqual(
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef",
    );
    expect(seen.auth).toEqual("Bearer key");
    expect(seen.body).toEqual({
      model: "clef",
      state: "hello",
      questions: { answer: { type: "noul", instructions: "a greeting?" } },
    });
    await client.close();
  });

  test("test_the_model_picks_the_endpoint", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.path = request.url.pathname;
      seen.model = JSON.parse(request.content).model;
      return _reply({ type: "noul", noul: 0.9 });
    };

    const client = _client(handler, { model: "clef-flash" });
    await client.ask("a", NOUL);

    expect(seen).toEqual({
      path: "/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef-flash",
      model: "clef-flash",
    });
    await client.close();
  });

  test("test_counts_tokens_over_requests", async () => {
    const client = _client(() => _reply({ type: "noul", noul: 0.5 }));
    await client.ask("a", NOUL);
    await client.ask("b", NOUL);

    expect(client.usage.inputTokens).toEqual(24);
    await client.close();
  });

  test("test_retries_when_out_of_capacity", async () => {
    const statuses = [429, 429];
    const waits: number[] = [];

    patchSleep(async (seconds) => {
      waits.push(seconds);
    });

    const handler = (_request: MockRequest): Response => {
      const status = statuses.shift();
      if (status !== undefined) {
        return _failure(status, "Capacity temporarily exceeded, please try again");
      }
      return _reply({ type: "noul", noul: 0.7 });
    };

    const client = _client(handler);
    const [answers] = await client.ask("a", NOUL);

    expect(answers.answer?.noul).toEqual(0.7);
    expect(waits).toEqual([0.25, 0.5]);
    await client.close();
  });

  test("test_gives_up_after_max_retries_with_cloudflares_reason", async () => {
    patchSleep(async () => {});
    const client = _client(() => _failure(429, "Account limited"), { maxRetries: 2 });

    const promise = client.ask("a", NOUL);
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/busy \(HTTP 429: Account limited\)/);
    await client.close();
  });

  test("test_a_rejected_request_carries_cloudflares_reasons", async () => {
    const client = _client(() => _failure(403, "Account blocked", "Try later"));

    const promise = client.ask("a", NOUL);
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(
      /Clef rejected the request: HTTP 403: Account blocked; Try later/,
    );
    await client.close();
  });

  test("test_a_rejected_request_without_reasons_has_only_the_status", async () => {
    const client = _client(() => new Response("<html>bad gateway</html>", { status: 502 }));

    const promise = client.ask("a", NOUL);
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/rejected the request: HTTP 502$/);
    await client.close();
  });

  test("test_a_reply_that_is_not_json_is_an_error", async () => {
    const client = _client(() => new Response("<html>busy</html>", { status: 200 }));

    const promise = client.ask("a", NOUL);
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/not valid JSON/);
    await client.close();
  });

  test("test_a_reply_without_a_result_is_an_error", async () => {
    const client = _client(() => jsonResponse(200, { success: true }));

    const promise = client.ask("a", NOUL);
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/no result/);
    await client.close();
  });

  test("test_a_reply_without_answers_is_an_error", async () => {
    const client = _client(() => _success({ model: "clef" }));

    const promise = client.ask("a", NOUL);
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/no answers/);
    await client.close();
  });

  test("test_usage_that_is_not_an_object_is_ignored", async () => {
    const client = _client(() =>
      _success({ answers: { answer: { type: "noul", noul: 0.5 } }, usage: "none" }),
    );
    await client.ask("a", NOUL);

    expect(client.usage.inputTokens).toEqual(0);
    await client.close();
  });

  test("test_unreachable_is_an_error", async () => {
    const handler = (_request: MockRequest): Response => {
      // Upstream raises httpx.ConnectError("down").
      throw new TypeError("down");
    };

    const client = _client(handler);

    const promise = client.ask("a", NOUL);
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/failed/);
    await client.close();
  });

  test("test_connect_asks_for_the_models_schema", async () => {
    const seen: [string, string, string | null][] = [];

    const handler = (request: MockRequest): Response => {
      seen.push([request.method, request.url.pathname, request.url.searchParams.get("model")]);
      return _schema(request);
    };

    const client = _client(handler, { model: "clef-flash" });
    await client.connect();

    expect(seen).toEqual([
      ["GET", "/client/v4/accounts/acct/ai/models/schema", "@cf/cloudflare/clef-flash"],
    ]);
    await client.close();
  });

  test("test_a_refused_connect_carries_cloudflares_reason", async () => {
    const client = _client(() => _failure(404, "Model schema not found"));

    const promise = client.connect();
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/HTTP 404: Model schema not found/);
    await client.close();
  });

  // DIVERGENCE: upstream checks httpx's connection pool keep-alive expiry
  // (240 s). The port sends requests through `fetch` and leaves connection
  // reuse to the runtime, so there is no pool to inspect.
  test.skip("test_keeps_idle_connections_open_between_questions", () => {});

  test("test_needs_an_account_id_and_an_api_key", () => {
    expect(() => new ClefClient({ accountId: "", apiKey: "key" })).toThrow(Error);
    expect(() => new ClefClient({ accountId: "acct", apiKey: "" })).toThrow(Error);
  });
});

describe("TestClefClassifier", () => {
  test("test_yes_no", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.question = JSON.parse(request.content).questions.answer;
      return _reply({ type: "noul", noul: 0.95 });
    };

    const classifier = new ClefClassifier({ client: _client(handler) });
    const result = (
      await classifier.yesNo("Please leave a message", {
        answer: new YesNoQuestion({ instructions: "is this a voicemail greeting?" }),
      })
    ).answer!;

    expect(result.probability).toEqual(0.95);
    expect(seen.question).toEqual({ type: "noul", instructions: "is this a voicemail greeting?" });
    await classifier.client.close();
  });

  test("test_yes_no_with_what_counts_as_each_answer", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.question = JSON.parse(request.content).questions.answer;
      return _reply({ type: "noul", noul: 0.2 });
    };

    const classifier = new ClefClassifier({ client: _client(handler) });
    await classifier.yesNo("Hello?", {
      answer: new YesNoQuestion({
        instructions: "is this a voicemail greeting?",
        yes: "a recorded greeting",
        no: "a person talking",
      }),
    });

    expect((seen.question as Record<string, unknown>).criteria).toEqual({
      true: "a recorded greeting",
      false: "a person talking",
    });
    await classifier.client.close();
  });

  test("test_choice", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.question = JSON.parse(request.content).questions.answer;
      return _reply({
        type: "choice",
        choice: "technical",
        probabilities: { billing: 0.16, technical: 0.83 },
        confidence: 0.56,
      });
    };

    const classifier = new ClefClassifier({ client: _client(handler) });
    const options = { billing: "payments", technical: "outages", sales: null };
    const result = (
      await classifier.choice("Checkout is down", {
        answer: new ChoiceQuestion({ instructions: "which team?", options }),
      })
    ).answer!;

    expect(result.choice).toEqual("technical");
    expect(result.probabilities).toEqual({ billing: 0.16, technical: 0.83, sales: 0.0 });
    expect(result.confidence).toEqual(0.56);
    expect(seen.question).toEqual({
      type: "choice",
      instructions: "which team?",
      criteria: options,
    });
    await classifier.client.close();
  });

  test("test_too_many_options_is_an_error_before_any_request", async () => {
    const sent: MockRequest[] = [];

    const handler = (request: MockRequest): Response => {
      sent.push(request);
      return _reply({ type: "choice", choice: "o0", confidence: 1.0 });
    };

    const classifier = new ClefClassifier({ client: _client(handler) });
    const options: Record<string, null> = {};
    for (let i = 0; i < CLEF_MAX_CHOICE_OPTIONS + 1; i++) {
      options[`o${i}`] = null;
    }
    const promise = classifier.choice("hmm", {
      answer: new ChoiceQuestion({ instructions: "?", options }),
    });
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/at most 255 options/);
    expect(sent).toEqual([]);
    await classifier.client.close();
  });

  test("test_a_choice_outside_the_options_is_an_error", async () => {
    const classifier = new ClefClassifier({
      client: _client(() => _reply({ type: "choice", choice: "maybe", confidence: 0.8 })),
    });
    const question = new ChoiceQuestion({ instructions: "?", options: { yes: null, no: null } });
    const promise = classifier.choice("hmm", { answer: question });
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/Clef chose 'maybe'/);
    await classifier.client.close();
  });

  test("test_an_unusable_probability_is_an_error", async () => {
    const classifier = new ClefClassifier({
      client: _client(() =>
        _reply({
          type: "choice",
          choice: "yes",
          probabilities: { yes: "high", no: 0.1 },
          confidence: 0.8,
        }),
      ),
    });
    const question = new ChoiceQuestion({ instructions: "?", options: { yes: null, no: null } });
    const promise = classifier.choice("hmm", { answer: question });
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/unusable probability/);
    await classifier.client.close();
  });

  test("test_score_keys_probabilities_by_level", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.question = JSON.parse(request.content).questions.answer;
      return _reply({
        type: "score",
        score: 1.98,
        legend: { "0": "calm", "1": "impatient", "2": "angry" },
        probabilities: { "0": 0.01, "1": 0.01, "2": 0.98 },
        confidence: 0.96,
      });
    };

    const classifier = new ClefClassifier({ client: _client(handler) });
    const levels = ["calm", "impatient", "angry"];
    const result = (
      await classifier.score("This is the third time!", {
        answer: new ScoreQuestion({ instructions: "how upset?", levels }),
      })
    ).answer!;

    expect(result.score).toEqual(1.98);
    expect(result.levels.map((l) => [l.level, l.probability])).toEqual([
      ["calm", 0.01],
      ["impatient", 0.01],
      ["angry", 0.98],
    ]);
    expect(result.confidence).toEqual(0.96);
    expect(seen.question).toEqual({
      type: "score",
      instructions: "how upset?",
      criteria: levels,
    });
    await classifier.client.close();
  });

  test("test_a_missing_answer_field_is_an_error", async () => {
    const classifier = new ClefClassifier({ client: _client(() => _reply({ type: "noul" })) });

    const promise = classifier.yesNo("a", { answer: new YesNoQuestion({ instructions: "?" }) });
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/noul/);
    await classifier.client.close();
  });

  test("test_ask_sends_every_question_in_one_request", async () => {
    const requests: Record<string, unknown>[] = [];

    const handler = (request: MockRequest): Response => {
      requests.push(JSON.parse(request.content));
      return _success({
        answers: {
          greeting: { type: "noul", noul: 0.9 },
          mood: {
            type: "score",
            score: 0.2,
            probabilities: { "0": 0.8, "1": 0.2 },
            confidence: 0.8,
          },
        },
        usage: USAGE,
      });
    };

    const classifier = new ClefClassifier({ client: _client(handler) });
    const results = await classifier.ask("Hello there!", {
      greeting: new YesNoQuestion({ instructions: "is this a greeting?" }),
      mood: new ScoreQuestion({ instructions: "how upset?", levels: ["calm", "upset"] }),
    });

    expect(requests.length).toEqual(1);
    expect(new Set(Object.keys(requests[0]!.questions as object))).toEqual(
      new Set(["greeting", "mood"]),
    );
    expect((results.greeting as { probability: number }).probability).toEqual(0.9);
    expect(
      (results.mood as { probability: (level: string) => number }).probability("calm"),
    ).toEqual(0.8);
    await classifier.client.close();
  });

  test("test_a_missing_answer_is_an_error", async () => {
    const classifier = new ClefClassifier({
      client: _client(() => _reply({ type: "noul", noul: 0.5 })),
    });
    const promise = classifier.ask("hi", {
      answer: new YesNoQuestion({ instructions: "?" }),
      other: new YesNoQuestion({ instructions: "?" }),
    });
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/no answer for other/);
    await classifier.client.close();
  });

  test("test_images_go_with_the_state", async () => {
    const bodies: Record<string, unknown>[] = [];

    const handler = (request: MockRequest): Response => {
      bodies.push(JSON.parse(request.content));
      return _reply({ type: "noul", noul: 0.99 });
    };

    const classifier = new ClefClassifier({ client: _client(handler) });
    const png = new ClassifierImage({
      data: new TextEncoder().encode("png bytes"),
      contentType: "image/png",
    });
    const question = { answer: new YesNoQuestion({ instructions: "is there a red circle?" }) };
    expect(classifier.supportsImages).toBeTruthy();

    await classifier.yesNo("a camera frame", question, { images: [png] });
    await classifier.yesNo("no frame", question);

    expect(bodies[0]!.state).toEqual("a camera frame");
    expect(bodies[0]!.images).toEqual([{ content_type: "image/png", base64: b64("png bytes") }]);
    expect("images" in bodies[1]!).toBe(false);
    await classifier.client.close();
  });

  test("test_too_many_images_is_an_error_before_any_request", async () => {
    const sent: MockRequest[] = [];

    const handler = (request: MockRequest): Response => {
      sent.push(request);
      return _reply({ type: "noul", noul: 0.5 });
    };

    const classifier = new ClefClassifier({ client: _client(handler) });
    const circle = _circle("red");
    const images = Array.from({ length: CLEF_MAX_IMAGES + 1 }, () => circle);
    const promise = classifier.yesNo(
      "frames",
      { answer: new YesNoQuestion({ instructions: "?" }) },
      { images },
    );
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/at most 4 images/);
    expect(sent).toEqual([]);
    await classifier.client.close();
  });

  test("test_needs_an_account_and_key_or_a_client", () => {
    expect(() => new ClefClassifier()).toThrow(Error);
    expect(() => new ClefClassifier({ apiKey: "key" })).toThrow(Error);
    expect(() => new ClefClassifier({ accountId: "acct" })).toThrow(Error);
  });

  test("test_a_client_of_its_own_takes_the_model_and_timeout", () => {
    const classifier = new ClefClassifier({
      accountId: "acct",
      apiKey: "key",
      model: "clef-flash",
      timeout: 1.5,
    });
    expect((classifier as unknown as { _ownsClient: boolean })._ownsClient).toBeTruthy();
    expect(classifier.model).toEqual("clef-flash");
    expect((http(classifier.client) as unknown as { _timeout: number })._timeout).toEqual(1.5);
  });

  test("test_cleanup_closes_only_an_owned_client", async () => {
    const owned = new ClefClassifier({ accountId: "acct", apiKey: "key" });
    await owned.cleanup();
    expect(http(owned.client).isClosed).toBeTruthy();

    const shared = new ClefClient({ accountId: "acct", apiKey: "key" });
    const classifier = new ClefClassifier({ client: shared });
    await classifier.cleanup();
    expect(http(shared).isClosed).toBeFalsy();
    await shared.close();
  });

  test("test_setup_opens_the_connection", async () => {
    const seen: string[] = [];

    const handler = (request: MockRequest): Response => {
      seen.push(request.url.pathname);
      return _schema(request);
    };

    const classifier = new ClefClassifier({ client: _client(handler) });
    await classifier.setup(new TaskManager());

    expect(seen).toEqual(["/client/v4/accounts/acct/ai/models/schema"]);
    await classifier.client.close();
  });

  test("test_a_failed_connect_at_setup_is_only_a_warning", async () => {
    const handler = (_request: MockRequest): Response => {
      // Upstream raises httpx.ConnectError("down").
      throw new TypeError("down");
    };

    const classifier = new ClefClassifier({ client: _client(handler) });
    await classifier.setup(new TaskManager());
    await classifier.client.close();
  });

  test("test_a_shared_client_connects_once", async () => {
    const connects: string[] = [];

    const handler = (request: MockRequest): Response => {
      connects.push(request.url.pathname);
      return _schema(request);
    };

    const client = _client(handler);
    const [first, second] = [new ClefClassifier({ client }), new ClefClassifier({ client })];
    const taskManager = new TaskManager();
    await Promise.all([first.setup(taskManager), second.setup(taskManager)]);
    await first.setup(taskManager);

    expect(connects.length).toEqual(1);
    await client.close();
  });

  test("test_every_call_reports_its_time_and_tokens", async () => {
    const client = _client(() => _reply({ type: "noul", noul: 0.9 }));
    const classifier = new ClefClassifier({ client, name: "voicemail" });
    const reported = new asyncio.Event();
    const seen: MetricsData[] = [];

    classifier.eventHandler("on_metrics", async (_classifier, data: MetricsData[]) => {
      seen.push(...data);
      reported.set();
    });

    await classifier.yesNo("hello", {
      answer: new YesNoQuestion({ instructions: "a greeting?" }),
    });
    await asyncio.waitFor(reported.wait(), 1);

    const [processing, usage] = seen;
    expect(processing).toBeInstanceOf(ProcessingMetricsData);
    expect([processing!.processor, processing!.model]).toEqual(["voicemail", "clef"]);
    expect(usage).toBeInstanceOf(LLMUsageMetricsData);
    const value = (usage as LLMUsageMetricsData).value;
    expect([value.promptTokens, value.totalTokens]).toEqual([12, 12]);
    await client.close();
  });
});

const LIVE = Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_KEY);

// Skipped unless CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_KEY are set, as upstream.
describe("TestClefLive", () => {
  for (const model of ["clef", "clef-flash"]) {
    test.skipIf(!LIVE)(
      `test_three_questions[${model}]`,
      async () => {
        const classifier = new ClefClassifier({
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
          apiKey: process.env.CLOUDFLARE_API_KEY,
          model,
        });
        try {
          await classifier.client.connect();
          const results = await classifier.ask(
            "Hi, you've reached Sam. I can't take your call right now, leave a message.",
            {
              voicemail: new YesNoQuestion({ instructions: "is this a voicemail greeting?" }),
              turn: new ChoiceQuestion({
                instructions: "is the speaker's turn over?",
                options: { complete: "finished", short: "a brief pause" },
              }),
              mood: new ScoreQuestion({
                instructions: "how upset is the speaker?",
                levels: ["calm", "impatient", "angry"],
              }),
            },
          );
          const voicemail = results.voicemail as { probability: number };
          const turn = results.turn as { choice: string; probabilities: Record<string, number> };
          const mood = results.mood as { score: number };
          expect(voicemail.probability).toBeGreaterThan(0.5);
          expect(["complete", "short"]).toContain(turn.choice);
          const total = Object.values(turn.probabilities).reduce((a, b) => a + b, 0);
          expect(Math.abs(total - 1.0)).toBeLessThan(0.05);
          expect(mood.score).toBeGreaterThanOrEqual(0);
          expect(mood.score).toBeLessThanOrEqual(2);
          expect(classifier.client.usage.inputTokens).toBeGreaterThan(0);
        } finally {
          await classifier.cleanup();
        }
      },
      60_000,
    );

    test.skipIf(!LIVE)(
      `test_a_question_about_an_image[${model}]`,
      async () => {
        const classifier = new ClefClassifier({
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
          apiKey: process.env.CLOUDFLARE_API_KEY,
          model,
          timeout: 30,
        });
        const question = {
          red: new YesNoQuestion({ instructions: "Is there a red circle in the image?" }),
        };
        try {
          const red = await classifier.yesNo("A camera frame.", question, {
            images: [_circle("red")],
          });
          const blue = await classifier.yesNo("A camera frame.", question, {
            images: [_circle("blue")],
          });
          expect(red.red!.isYes).toBeTruthy();
          expect(blue.red!.isYes).toBeFalsy();
        } finally {
          await classifier.cleanup();
        }
      },
      120_000,
    );
  }
});
