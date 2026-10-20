// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_classifiers_openai_decisions.py

import { describe, expect, mock, test } from "bun:test";
import { deflateSync } from "node:zlib";

import * as asyncio from "@pipedog/asyncio";
import { Event, gather, waitFor } from "@pipedog/asyncio";

import {
  ChoiceQuestion,
  ClassifierError,
  ClassifierImage,
  ScoreQuestion,
  YesNoQuestion,
} from "../src/classifiers/base_classifier.ts";
import { bytesToBase64, type HttpClient } from "../src/classifiers/http_client.ts";
import {
  OPENAI_DECISIONS_MAX_CHOICE_OPTIONS,
  OPENAI_DECISIONS_MAX_IMAGES,
  OpenAIDecisionsClassifier,
} from "../src/classifiers/openai/decisions/classifier.ts";
import {
  OpenAIDecisionsClient,
  type OpenAIDecisionsClientOptions,
} from "../src/classifiers/openai/decisions/client.ts";
import {
  LLMUsageMetricsData,
  type MetricsData,
  ProcessingMetricsData,
} from "../src/metrics/metrics.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";

const USAGE = {
  input_tokens: 12,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  output_tokens: 0,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 12,
};
const PREDICATE = { answer: { type: "predicate", instructions: "?" } };

/** What a handler sees of a request (the parts of `httpx.Request` the tests read). */
interface MockRequest {
  url: URL;
  method: string;
  headers: Headers;
  content: string;
}

type Handler = (request: MockRequest) => Response;

/** The protected HTTP client of a decisions client. */
function http(client: OpenAIDecisionsClient): HttpClient {
  return (client as unknown as { _http: HttpClient })._http;
}

/** A client whose requests `handler` answers instead of OpenAI. */
function _client(
  handler: Handler,
  options: Partial<OpenAIDecisionsClientOptions> = {},
): OpenAIDecisionsClient {
  const client = new OpenAIDecisionsClient({ apiKey: "key", ...options });
  // Upstream swaps in an httpx.MockTransport.
  http(client).transport = async (input, init) => {
    const headers = new Headers(init?.headers);
    return handler({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers,
      content: typeof init?.body === "string" ? init.body : "",
    });
  };
  return client;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function _reply(...answers: Record<string, unknown>[]): Response {
  return jsonResponse(200, { model: "gpt-6-luna", answers, usage: USAGE });
}

function _predicate(probability: number, name = "answer"): Record<string, unknown> {
  return { type: "predicate", name, probability };
}

function _failure(status: number, message: string, code: string | null = null): Response {
  return jsonResponse(status, {
    error: { message, type: "invalid_request_error", param: null, code },
  });
}

// PORTING NOTE: upstream draws the circle with Pillow and saves a JPEG. There
// is no image library here, so the circle is encoded by hand as a PNG.

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const COLORS: Record<string, [number, number, number]> = {
  red: [255, 0, 0],
  blue: [0, 0, 255],
};

/** A camera-sized image with a circle in the middle. */
function _circle(color: string): ClassifierImage {
  const width = 640;
  const height = 480;
  const fill = COLORS[color] as [number, number, number];
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const inside = (x - 320) ** 2 + (y - 240) ** 2 <= 100 ** 2;
      const [r, g, b] = inside ? fill : [255, 255, 255];
      const p = row + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw))),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return new ClassifierImage({ data, contentType: "image/png" });
}

function _model(_request: MockRequest): Response {
  return jsonResponse(200, { id: "gpt-6-luna", object: "model", created: 0, owned_by: "system" });
}

/** `pytest.raises(E, match=...)`: the promise rejects with `E` whose message matches. */
async function expectRaises(
  promise: Promise<unknown>,
  errorType: new (...args: never[]) => Error,
  match?: RegExp,
): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(errorType);
  if (match) {
    expect((error as Error).message).toMatch(match);
  }
}

/**
 * Equivalent of `monkeypatch.setattr("...client.asyncio.sleep", fn)`.
 * Restores the original module afterwards.
 */
async function withPatchedSleep(
  fn: (seconds: number) => Promise<void>,
  body: () => Promise<void>,
): Promise<void> {
  const original = { ...asyncio };
  mock.module("@pipedog/asyncio", () => ({ ...original, sleep: fn }));
  try {
    await body();
  } finally {
    mock.module("@pipedog/asyncio", () => original);
  }
}

describe("TestOpenAIDecisionsClient", () => {
  test("test_sends_questions_to_the_decisions_endpoint_with_auth", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.url = String(request.url);
      seen.auth = request.headers.get("Authorization");
      seen.body = JSON.parse(request.content);
      return _reply(_predicate(0.9));
    };

    const client = _client(handler);
    const [answers, usage] = await client.ask("hello", {
      answer: { type: "predicate", instructions: "a greeting?" },
    });

    expect(answers.answer).toEqual(_predicate(0.9));
    expect([usage.inputTokens, usage.outputTokens]).toEqual([12, 0]);
    expect(seen.url).toBe("https://api.openai.com/v1/decisions");
    expect(seen.auth).toBe("Bearer key");
    expect(seen.body).toEqual({
      model: "gpt-6-luna",
      input: "hello",
      questions: [{ name: "answer", type: "predicate", instructions: "a greeting?" }],
    });
    await client.close();
  });

  test("test_the_base_url_and_model_pick_where_questions_go", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.url = String(request.url);
      seen.model = JSON.parse(request.content).model;
      return _reply(_predicate(0.9));
    };

    const client = _client(handler, {
      baseUrl: "https://eu.api.openai.com/v1",
      model: "gpt-6-sol",
    });
    await client.ask("a", PREDICATE);

    expect(seen).toEqual({ url: "https://eu.api.openai.com/v1/decisions", model: "gpt-6-sol" });
    await client.close();
  });

  test("test_answers_are_matched_to_questions_by_name", async () => {
    const client = _client(() => _reply(_predicate(0.2, "b"), _predicate(0.8, "a")));
    const [answers] = await client.ask("x", {
      a: { type: "predicate", instructions: "a?" },
      b: { type: "predicate", instructions: "b?" },
    });

    expect(answers.a?.probability).toBe(0.8);
    expect(answers.b?.probability).toBe(0.2);
    await client.close();
  });

  test("test_counts_tokens_over_requests", async () => {
    const client = _client(() => _reply(_predicate(0.5)));
    await client.ask("a", PREDICATE);
    await client.ask("b", PREDICATE);

    expect(client.usage.inputTokens).toBe(24);
    await client.close();
  });

  for (const busy of [429, 503]) {
    test(`test_retries_when_busy[${busy}]`, async () => {
      const statuses = [busy, busy];
      const waits: number[] = [];

      const noSleep = async (seconds: number): Promise<void> => {
        waits.push(seconds);
      };

      await withPatchedSleep(noSleep, async () => {
        const handler = (_request: MockRequest): Response => {
          const status = statuses.shift();
          if (status !== undefined) {
            return _failure(status, "Rate limit reached");
          }
          return _reply(_predicate(0.7));
        };

        const client = _client(handler);
        const [answers] = await client.ask("a", PREDICATE);

        expect(answers.answer?.probability).toBe(0.7);
        expect(waits).toEqual([0.25, 0.5]);
        await client.close();
      });
    });
  }

  test("test_gives_up_after_max_retries_with_openais_reason", async () => {
    const noSleep = async (_seconds: number): Promise<void> => {};

    await withPatchedSleep(noSleep, async () => {
      const client = _client(() => _failure(429, "Rate limit reached"), { maxRetries: 2 });

      await expectRaises(
        client.ask("a", PREDICATE),
        ClassifierError,
        /busy \(HTTP 429: Rate limit reached\)/,
      );
      await client.close();
    });
  });

  test("test_a_rejected_request_carries_openais_reason", async () => {
    const client = _client(() =>
      _failure(
        400,
        "Invalid type for 'questions[0].instructions': expected a string",
        "invalid_type",
      ),
    );

    await expectRaises(
      client.ask("a", PREDICATE),
      ClassifierError,
      /rejected the request: HTTP 400: Invalid type for 'questions\[0\]/,
    );
    await client.close();
  });

  test("test_a_rejected_request_without_a_reason_has_only_the_status", async () => {
    const client = _client(() => new Response("<html>bad gateway</html>", { status: 502 }));

    await expectRaises(
      client.ask("a", PREDICATE),
      ClassifierError,
      /rejected the request: HTTP 502$/,
    );
    await client.close();
  });

  test("test_a_reply_that_is_not_json_is_an_error", async () => {
    const client = _client(() => new Response("<html>busy</html>", { status: 200 }));

    await expectRaises(client.ask("a", PREDICATE), ClassifierError, /not valid JSON/);
    await client.close();
  });

  test("test_a_reply_that_is_not_an_object_is_an_error", async () => {
    const client = _client(() => jsonResponse(200, []));

    await expectRaises(client.ask("a", PREDICATE), ClassifierError, /not a JSON object/);
    await client.close();
  });

  test("test_a_reply_without_answers_is_an_error", async () => {
    const client = _client(() => jsonResponse(200, { model: "gpt-6-luna" }));

    await expectRaises(client.ask("a", PREDICATE), ClassifierError, /no answers/);
    await client.close();
  });

  test("test_a_question_left_unanswered_is_an_error", async () => {
    const client = _client(() => _reply(_predicate(0.5, "other"), { name: null }));

    await expectRaises(client.ask("a", PREDICATE), ClassifierError, /no answer for answer/);
    await client.close();
  });

  test("test_usage_that_is_not_an_object_is_ignored", async () => {
    const client = _client(() => jsonResponse(200, { answers: [_predicate(0.5)], usage: "none" }));
    await client.ask("a", PREDICATE);

    expect(client.usage.inputTokens).toBe(0);
    await client.close();
  });

  test("test_unreachable_is_an_error", async () => {
    const handler = (_request: MockRequest): Response => {
      // Upstream raises httpx.ConnectError.
      throw new TypeError("down");
    };

    const client = _client(handler);

    await expectRaises(client.ask("a", PREDICATE), ClassifierError, /failed/);
    await client.close();
  });

  test("test_connect_looks_up_the_model", async () => {
    const seen: [string, string][] = [];

    const handler = (request: MockRequest): Response => {
      seen.push([request.method, request.url.pathname]);
      return _model(request);
    };

    const client = _client(handler, { model: "gpt-6-sol" });
    await client.connect();

    expect(seen).toEqual([["GET", "/v1/models/gpt-6-sol"]]);
    await client.close();
  });

  test("test_connect_sends_only_once", async () => {
    const seen: string[] = [];

    const handler = (request: MockRequest): Response => {
      seen.push(request.url.pathname);
      return _model(request);
    };

    const client = _client(handler);
    await client.connect();
    await client.connect();

    expect(seen.length).toBe(1);
    await client.close();
  });

  test("test_a_refused_connect_carries_openais_reason", async () => {
    const client = _client(() =>
      _failure(
        404,
        "The model `gpt-6-luna` does not exist or you do not have access to it.",
        "model_not_found",
      ),
    );

    await expectRaises(
      client.connect(),
      ClassifierError,
      /HTTP 404: The model `gpt-6-luna` does not/,
    );
    await client.close();
  });

  // DIVERGENCE: upstream checks httpx's pool keep-alive expiry (240 s). The
  // port sends requests through `fetch`, and connection reuse is left to the
  // runtime, so there is no pool setting to check.
  test.skip("test_keeps_idle_connections_open_between_questions", () => {});

  test("test_needs_an_api_key", () => {
    expect(() => new OpenAIDecisionsClient({ apiKey: "" })).toThrow(Error);
  });
});

/** The one question a request sent, without its name. */
function _question(request: MockRequest): Record<string, unknown> {
  const questions = JSON.parse(request.content).questions as Record<string, unknown>[];
  expect(questions.length).toBe(1);
  const { name: _name, ...rest } = questions[0] as Record<string, unknown>;
  return rest;
}

describe("TestOpenAIDecisionsClassifier", () => {
  test("test_yes_no", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.question = _question(request);
      return _reply(_predicate(0.95));
    };

    const classifier = new OpenAIDecisionsClassifier({ client: _client(handler) });
    const result = (
      await classifier.yesNo("Please leave a message", {
        answer: new YesNoQuestion({ instructions: "is this a voicemail greeting?" }),
      })
    ).answer;

    expect(result?.probability).toBe(0.95);
    expect(seen.question).toEqual({
      type: "predicate",
      instructions: "is this a voicemail greeting?",
    });
    await classifier.client.close();
  });

  test("test_yes_no_says_what_counts_as_each_answer_in_the_instructions", async () => {
    const seen: Record<string, Record<string, unknown>> = {};

    const handler = (request: MockRequest): Response => {
      seen.question = _question(request);
      return _reply(_predicate(0.2));
    };

    const classifier = new OpenAIDecisionsClassifier({ client: _client(handler) });
    await classifier.yesNo("Hello?", {
      answer: new YesNoQuestion({
        instructions: "is this a voicemail greeting?",
        yes: "a recorded greeting",
        no: "a person talking",
      }),
    });

    expect(seen.question?.instructions).toBe(
      "is this a voicemail greeting?\n" +
        "Yes means: a recorded greeting\n" +
        "No means: a person talking",
    );
    await classifier.client.close();
  });

  test("test_structured_state_and_instructions_are_sent_as_json", async () => {
    const seen: Record<string, string> = {};

    const handler = (request: MockRequest): Response => {
      const body = JSON.parse(request.content);
      seen.input = body.input;
      seen.instructions = body.questions[0].instructions;
      return _reply(_predicate(0.5));
    };

    const classifier = new OpenAIDecisionsClassifier({ client: _client(handler) });
    const state = [{ role: "user", content: "hi" }];
    const instructions = { question: "did they greet?", speaker: "user" };
    await classifier.yesNo(state, { answer: new YesNoQuestion({ instructions }) });

    expect(JSON.parse(seen.input as string)).toEqual(state);
    expect(JSON.parse(seen.instructions as string)).toEqual(instructions);
    await classifier.client.close();
  });

  test("test_choice", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.question = _question(request);
      return _reply({
        type: "choice",
        name: "answer",
        choice: "technical",
        probabilities: [
          { value: "billing", probability: 0.16 },
          { value: "technical", probability: 0.83 },
        ],
        confidence: 0.56,
      });
    };

    const classifier = new OpenAIDecisionsClassifier({ client: _client(handler) });
    const options = { billing: "payments", technical: { covers: ["outages"] }, sales: null };
    const result = (
      await classifier.choice("Checkout is down", {
        answer: new ChoiceQuestion({ instructions: "which team?", options }),
      })
    ).answer;

    expect(result?.choice).toBe("technical");
    expect(result?.probabilities).toEqual({ billing: 0.16, technical: 0.83, sales: 0.0 });
    expect(result?.confidence).toBe(0.56);
    expect(seen.question).toEqual({
      type: "choice",
      instructions: "which team?",
      choices: [
        { value: "billing", description: "payments" },
        { value: "technical", description: '{\n  "covers": [\n    "outages"\n  ]\n}' },
        { value: "sales" },
      ],
    });
    await classifier.client.close();
  });

  test("test_too_many_options_is_an_error_before_any_request", async () => {
    const sent: MockRequest[] = [];

    const handler = (request: MockRequest): Response => {
      sent.push(request);
      return _reply(_predicate(1.0));
    };

    const classifier = new OpenAIDecisionsClassifier({ client: _client(handler) });
    const options: Record<string, null> = {};
    for (let i = 0; i < OPENAI_DECISIONS_MAX_CHOICE_OPTIONS + 1; i++) {
      options[`o${i}`] = null;
    }
    await expectRaises(
      classifier.choice("hmm", { answer: new ChoiceQuestion({ instructions: "?", options }) }),
      ClassifierError,
      /at most 255 options/,
    );
    expect(sent).toEqual([]);
    await classifier.client.close();
  });

  test("test_images_go_in_a_user_message_with_the_state", async () => {
    const bodies: Record<string, unknown>[] = [];

    const handler = (request: MockRequest): Response => {
      bodies.push(JSON.parse(request.content));
      return _reply(_predicate(0.99));
    };

    const classifier = new OpenAIDecisionsClassifier({ client: _client(handler) });
    const pngBytes = new TextEncoder().encode("png bytes");
    const png = new ClassifierImage({ data: pngBytes, contentType: "image/png" });
    const question = { answer: new YesNoQuestion({ instructions: "is there a red circle?" }) };
    expect(classifier.supportsImages).toBe(true);

    await classifier.yesNo("a camera frame", question, { images: [png] });
    await classifier.yesNo("no frame", question);

    expect(bodies[0]?.input).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: `data:image/png;base64,${bytesToBase64(pngBytes)}`,
          },
          { type: "input_text", text: "a camera frame" },
        ],
      },
    ]);
    expect(bodies[1]?.input).toBe("no frame");
    await classifier.client.close();
  });

  test("test_too_many_images_is_an_error_before_any_request", async () => {
    const sent: MockRequest[] = [];

    const handler = (request: MockRequest): Response => {
      sent.push(request);
      return _reply(_predicate(0.5));
    };

    const classifier = new OpenAIDecisionsClassifier({ client: _client(handler) });
    const circle = _circle("red");
    const images = Array.from({ length: OPENAI_DECISIONS_MAX_IMAGES + 1 }, () => circle);
    await expectRaises(
      classifier.yesNo("frames", { answer: new YesNoQuestion({ instructions: "?" }) }, { images }),
      ClassifierError,
      /at most 128 images/,
    );
    expect(sent).toEqual([]);
    await classifier.client.close();
  });

  test("test_a_choice_outside_the_options_is_an_error", async () => {
    const classifier = new OpenAIDecisionsClassifier({
      client: _client(() =>
        _reply({ type: "choice", name: "answer", choice: "maybe", confidence: 0.8 }),
      ),
    });
    const question = new ChoiceQuestion({ instructions: "?", options: { yes: null, no: null } });
    await expectRaises(
      classifier.choice("hmm", { answer: question }),
      ClassifierError,
      /OpenAI Decisions chose 'maybe'/,
    );
    await classifier.client.close();
  });

  test("test_an_unusable_probability_is_an_error", async () => {
    const classifier = new OpenAIDecisionsClassifier({
      client: _client(() =>
        _reply({
          type: "choice",
          name: "answer",
          choice: "yes",
          probabilities: [
            { value: "yes", probability: "high" },
            { value: "no", probability: 0.1 },
          ],
          confidence: 0.8,
        }),
      ),
    });
    const question = new ChoiceQuestion({ instructions: "?", options: { yes: null, no: null } });
    await expectRaises(
      classifier.choice("hmm", { answer: question }),
      ClassifierError,
      /unusable probability/,
    );
    await classifier.client.close();
  });

  test("test_score_keys_probabilities_by_level", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.question = _question(request);
      return _reply({
        type: "score",
        name: "answer",
        score: 1.97,
        probabilities: [
          { value: 0, label: "calm", probability: 0.01 },
          { value: 1, label: "impatient", probability: 0.01 },
          { value: 2, label: '{\n  "level": "angry"\n}', probability: 0.98 },
        ],
        confidence: 0.96,
      });
    };

    const classifier = new OpenAIDecisionsClassifier({ client: _client(handler) });
    const levels = ["calm", "impatient", { level: "angry" }];
    const result = (
      await classifier.score("This is the third time!", {
        answer: new ScoreQuestion({ instructions: "how upset?", levels }),
      })
    ).answer;

    expect(result?.score).toBe(1.97);
    expect(result?.levels.map((l) => [l.level, l.probability])).toEqual([
      ["calm", 0.01],
      ["impatient", 0.01],
      [{ level: "angry" }, 0.98],
    ]);
    expect(result?.confidence).toBe(0.96);
    expect(seen.question).toEqual({
      type: "score",
      instructions: "how upset?",
      levels: [{ label: "calm" }, { label: "impatient" }, { label: '{\n  "level": "angry"\n}' }],
    });
    await classifier.client.close();
  });

  test("test_a_missing_answer_field_is_an_error", async () => {
    const classifier = new OpenAIDecisionsClassifier({
      client: _client(() => _reply({ type: "predicate", name: "answer" })),
    });

    await expectRaises(
      classifier.yesNo("a", { answer: new YesNoQuestion({ instructions: "?" }) }),
      ClassifierError,
      /probability/,
    );
    await classifier.client.close();
  });

  test("test_a_refusal_is_an_error_naming_the_question", async () => {
    const classifier = new OpenAIDecisionsClassifier({
      client: _client(() => _reply({ type: "refusal", name: "answer" })),
    });

    await expectRaises(
      classifier.yesNo("a", { answer: new YesNoQuestion({ instructions: "?" }) }),
      ClassifierError,
      /refused to answer 'answer'/,
    );
    await classifier.client.close();
  });

  test("test_ask_sends_every_question_in_one_request", async () => {
    const requests: { questions: { name: string }[] }[] = [];

    const handler = (request: MockRequest): Response => {
      requests.push(JSON.parse(request.content));
      return _reply(_predicate(0.9, "greeting"), {
        type: "score",
        name: "mood",
        score: 0.2,
        probabilities: [
          { value: 0, label: "calm", probability: 0.8 },
          { value: 1, label: "upset", probability: 0.2 },
        ],
        confidence: 0.8,
      });
    };

    const classifier = new OpenAIDecisionsClassifier({ client: _client(handler) });
    const results = await classifier.ask("Hello there!", {
      greeting: new YesNoQuestion({ instructions: "is this a greeting?" }),
      mood: new ScoreQuestion({ instructions: "how upset?", levels: ["calm", "upset"] }),
    });

    expect(requests.length).toBe(1);
    expect(requests[0]?.questions.map((q) => q.name)).toEqual(["greeting", "mood"]);
    expect((results.greeting as { probability: number }).probability).toBe(0.9);
    expect((results.mood as { probability(level: string): number }).probability("calm")).toBe(0.8);
    await classifier.client.close();
  });

  test("test_a_missing_answer_is_an_error", async () => {
    const classifier = new OpenAIDecisionsClassifier({
      client: _client(() => _reply(_predicate(0.5))),
    });
    await expectRaises(
      classifier.ask("hi", {
        answer: new YesNoQuestion({ instructions: "?" }),
        other: new YesNoQuestion({ instructions: "?" }),
      }),
      ClassifierError,
      /no answer for other/,
    );
    await classifier.client.close();
  });

  test("test_needs_an_api_key_or_a_client", () => {
    expect(() => new OpenAIDecisionsClassifier()).toThrow(Error);
  });

  test("test_a_client_of_its_own_takes_the_model_base_url_and_timeout", () => {
    const classifier = new OpenAIDecisionsClassifier({
      apiKey: "key",
      model: "gpt-6-sol",
      baseUrl: "https://eu.api.openai.com/v1",
      timeout: 1.5,
    });
    expect((classifier as unknown as { _ownsClient: boolean })._ownsClient).toBe(true);
    expect(classifier.model).toBe("gpt-6-sol");
    const client = http(classifier.client) as unknown as { _baseUrl: string; _timeout: number };
    // PORTING NOTE: httpx keeps the base URL with a trailing slash; the
    // fetch-based client keeps it without one and joins paths with "/".
    expect(client._baseUrl).toBe("https://eu.api.openai.com/v1");
    expect(client._timeout).toBe(1.5);
  });

  test("test_cleanup_closes_only_an_owned_client", async () => {
    const owned = new OpenAIDecisionsClassifier({ apiKey: "key" });
    await owned.cleanup();
    expect(http(owned.client).isClosed).toBe(true);

    const shared = new OpenAIDecisionsClient({ apiKey: "key" });
    const classifier = new OpenAIDecisionsClassifier({ client: shared });
    await classifier.cleanup();
    expect(http(shared).isClosed).toBe(false);
    await shared.close();
  });

  test("test_setup_opens_the_connection", async () => {
    const seen: string[] = [];

    const handler = (request: MockRequest): Response => {
      seen.push(request.url.pathname);
      return _model(request);
    };

    const classifier = new OpenAIDecisionsClassifier({ client: _client(handler) });
    await classifier.setup(new TaskManager());

    expect(seen).toEqual(["/v1/models/gpt-6-luna"]);
    await classifier.client.close();
  });

  test("test_a_failed_connect_at_setup_is_only_a_warning", async () => {
    const handler = (_request: MockRequest): Response => {
      throw new TypeError("down");
    };

    const classifier = new OpenAIDecisionsClassifier({ client: _client(handler) });
    await classifier.setup(new TaskManager());
    await classifier.client.close();
  });

  test("test_a_shared_client_connects_once", async () => {
    const connects: string[] = [];

    const handler = (request: MockRequest): Response => {
      connects.push(request.url.pathname);
      return _model(request);
    };

    const client = _client(handler);
    const first = new OpenAIDecisionsClassifier({ client });
    const second = new OpenAIDecisionsClassifier({ client });
    const taskManager = new TaskManager();
    await gather(
      () => first.setup(taskManager),
      () => second.setup(taskManager),
    );
    await first.setup(taskManager);

    expect(connects.length).toBe(1);
    await client.close();
  });

  test("test_every_call_reports_its_time_and_tokens", async () => {
    const client = _client(() => _reply(_predicate(0.9)));
    const classifier = new OpenAIDecisionsClassifier({ client, name: "voicemail" });
    const reported = new Event();
    const seen: MetricsData[] = [];

    classifier.eventHandler("on_metrics", async (_classifier: unknown, data: MetricsData[]) => {
      seen.push(...data);
      reported.set();
    });

    await classifier.yesNo("hello", {
      answer: new YesNoQuestion({ instructions: "a greeting?" }),
    });
    await waitFor(() => reported.wait(), 1);

    expect(seen.length).toBe(2);
    const [processing, usage] = seen as [ProcessingMetricsData, LLMUsageMetricsData];
    expect(processing).toBeInstanceOf(ProcessingMetricsData);
    expect([processing.processor, processing.model]).toEqual(["voicemail", "gpt-6-luna"]);
    expect(usage).toBeInstanceOf(LLMUsageMetricsData);
    expect([usage.value.promptTokens, usage.value.totalTokens]).toEqual([12, 12]);
    await client.close();
  });
});

// Live tests need an OpenAI key, as upstream (skipped when OPENAI_API_KEY is not set).
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

describe.skipIf(!OPENAI_API_KEY)("TestOpenAIDecisionsLive", () => {
  test("test_three_questions", async () => {
    const classifier = new OpenAIDecisionsClassifier({ apiKey: OPENAI_API_KEY as string });
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
  });

  test("test_a_question_about_an_image", async () => {
    const classifier = new OpenAIDecisionsClassifier({ apiKey: OPENAI_API_KEY as string });
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
      expect(red.red?.isYes).toBe(true);
      expect(blue.red?.isYes).toBe(false);
    } finally {
      await classifier.cleanup();
    }
  });
});
