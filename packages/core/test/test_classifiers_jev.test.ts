// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_classifiers_jev.py

import { afterEach, describe, expect, mock, test } from "bun:test";
import { deflateSync } from "node:zlib";

import * as asyncio from "@pipecat-ts/asyncio";

import {
  ChoiceQuestion,
  ClassifierError,
  ClassifierImage,
  ScoreQuestion,
  type ScoreResult,
  YesNoQuestion,
  YesNoResult,
} from "../src/classifiers/base_classifier.ts";
import type { HttpClient } from "../src/classifiers/http_client.ts";
import {
  JEV_MAX_CHOICE_OPTIONS,
  JevClassifier,
} from "../src/classifiers/typesafe/jev/classifier.ts";
import { JevClient, type JevClientOptions } from "../src/classifiers/typesafe/jev/client.ts";
import {
  LLMUsageMetricsData,
  type MetricsData,
  ProcessingMetricsData,
} from "../src/metrics/metrics.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";

const USAGE = { input_tokens: 12, output_tokens: 3 };

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
function http(client: JevClient): HttpClient {
  return (client as unknown as { _http: HttpClient })._http;
}

/** A client whose requests `handler` answers instead of Jev. */
function _client(handler: Handler, options: Omit<JevClientOptions, "apiKey"> = {}): JevClient {
  const client = new JevClient({ apiKey: "key", ...options });
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

function _reply(answer: Record<string, unknown>): Response {
  return jsonResponse(200, { model: "jev-1.13.0", answers: { answer }, usage: USAGE });
}

const NOUL = { answer: { type: "noul", instructions: "?" } };

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
 * encoder in the port, this writes the same picture as a PNG, which Jev also reads.
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

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
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

describe("TestJevClient", () => {
  test("test_sends_one_question_with_auth", async () => {
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
    const answer = answers.answer;

    expect(answer).toEqual({ type: "noul", noul: 0.9 });
    expect([usage.inputTokens, usage.outputTokens]).toEqual([12, 3]);
    expect(seen.url).toEqual("https://api.typesafe.ai/v1/systemone");
    expect(seen.auth).toEqual("Bearer key");
    expect(seen.body).toEqual({
      model: "jev-1.13.0",
      state: "hello",
      questions: { answer: { type: "noul", instructions: "a greeting?" } },
    });
    await client.close();
  });

  test("test_counts_tokens_over_requests", async () => {
    const client = _client(() => _reply({ type: "noul", noul: 0.5 }));
    await client.ask("a", NOUL);
    await client.ask("b", NOUL);

    expect(client.usage.inputTokens).toEqual(24);
    expect(client.usage.outputTokens).toEqual(6);
    await client.close();
  });

  test("test_retries_when_busy", async () => {
    const statuses = [429, 529];
    const waits: number[] = [];

    patchSleep(async (seconds) => {
      waits.push(seconds);
    });

    const handler = (_request: MockRequest): Response => {
      const status = statuses.shift();
      if (status !== undefined) {
        return new Response(null, { status });
      }
      return _reply({ type: "noul", noul: 0.7 });
    };

    const client = _client(handler);
    const answer = (await client.ask("a", NOUL))[0].answer!;

    expect(answer.noul).toEqual(0.7);
    expect(waits).toEqual([0.25, 0.5]);
    await client.close();
  });

  test("test_gives_up_after_max_retries", async () => {
    patchSleep(async () => {});
    const client = _client(() => new Response(null, { status: 429 }), { maxRetries: 2 });

    const promise = client.ask("a", NOUL);
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/busy/);
    await client.close();
  });

  test("test_sends_assets_with_the_images_header", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.header = request.headers.get("TypeSafe-Danger-Zone-Images");
      seen.body = JSON.parse(request.content);
      return _reply({ type: "noul", noul: 0.9 });
    };

    const client = _client(handler);
    const asset = { type: "image", format: "jpg", data_base64: "anBlZw==" };
    await client.ask(
      { images: ["ref-1"], state: "a frame" },
      { answer: { type: "noul", instructions: "a person?" } },
      { "ref-1": asset },
    );

    expect(seen.header).toEqual("true");
    expect((seen.body as Record<string, unknown>).assets).toEqual({ "ref-1": asset });
    await client.close();
  });

  test("test_no_images_header_without_assets", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.header = request.headers.get("TypeSafe-Danger-Zone-Images");
      seen.body = JSON.parse(request.content);
      return _reply({ type: "noul", noul: 0.9 });
    };

    const client = _client(handler);
    await client.ask("a", NOUL, {});

    expect(seen.header).toBeNull();
    expect("assets" in (seen.body as Record<string, unknown>)).toBe(false);
    await client.close();
  });

  test("test_rejected_request_is_an_error", async () => {
    const client = _client(() => new Response(null, { status: 401 }));

    const promise = client.ask("a", NOUL);
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/401/);
    await client.close();
  });

  test("test_rejected_request_error_carries_jev_reason", async () => {
    const reply = { detail: { error_type: "api_usage_error", message: "Invalid image request." } };
    const client = _client(() => jsonResponse(400, reply));

    const promise = client.ask("a", NOUL);
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/HTTP 400: Invalid image request\.$/);
    await client.close();
  });

  test("test_rejected_request_error_carries_a_plain_reason", async () => {
    const client = _client(() => jsonResponse(413, { detail: "Too large." }));

    const promise = client.ask("a", NOUL);
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/HTTP 413: Too large\.$/);
    await client.close();
  });

  test("test_rejected_request_without_a_reason_reports_the_status", async () => {
    const client = _client(() => jsonResponse(422, { detail: [{ loc: ["x"] }] }));

    const promise = client.ask("a", NOUL);
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/HTTP 422$/);
    await client.close();
  });

  test("test_a_reply_that_is_not_json_is_an_error", async () => {
    const client = _client(() => new Response("<html>busy</html>", { status: 200 }));

    const promise = client.ask("a", NOUL);
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/not valid JSON/);
    await client.close();
  });

  test("test_a_reply_that_is_not_an_object_is_an_error", async () => {
    const client = _client(() => jsonResponse(200, ["answers"]));

    const promise = client.ask("a", NOUL);
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/not a JSON object/);
    await client.close();
  });

  test("test_a_reply_without_answers_is_an_error", async () => {
    const client = _client(() => jsonResponse(200, { model: "jev-1.13.0" }));

    const promise = client.ask("a", NOUL);
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/no answers/);
    await client.close();
  });

  test("test_usage_that_is_not_an_object_is_ignored", async () => {
    const handler = (_request: MockRequest): Response =>
      jsonResponse(200, { answers: { answer: { type: "noul", noul: 0.5 } }, usage: "none" });

    const client = _client(handler);
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

  test("test_needs_an_api_key", () => {
    expect(() => new JevClient({ apiKey: "" })).toThrow(Error);
  });
});

describe("TestJevClassifier", () => {
  test("test_yes_no", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.question = JSON.parse(request.content).questions.answer;
      return _reply({ type: "noul", noul: 0.95 });
    };

    const classifier = new JevClassifier({ client: _client(handler) });
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

    const classifier = new JevClassifier({ client: _client(handler) });
    (
      await classifier.yesNo("Hello?", {
        answer: new YesNoQuestion({
          instructions: "is this a voicemail greeting?",
          yes: "a recorded greeting or carrier message",
          no: "a person talking",
        }),
      })
    ).answer;

    expect(seen.question).toEqual({
      type: "noul",
      instructions: "is this a voicemail greeting?",
      criteria: {
        true: "a recorded greeting or carrier message",
        false: "a person talking",
      },
    });
    await classifier.client.close();
  });

  test("test_choice", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.question = JSON.parse(request.content).questions.answer;
      return _reply({
        type: "choice",
        choice: "short",
        probabilities: { complete: 0.1, short: 0.88 },
        confidence: 0.8,
      });
    };

    const classifier = new JevClassifier({ client: _client(handler) });
    const options = {
      complete: "the turn is over",
      short: "a brief pause",
      long: "asked for time",
    };
    const result = (
      await classifier.choice("I think, um", {
        answer: new ChoiceQuestion({ instructions: "is the user's turn over?", options }),
      })
    ).answer!;

    expect(result.choice).toEqual("short");
    expect(result.probabilities).toEqual({ complete: 0.1, short: 0.88, long: 0.0 });
    expect(result.confidence).toEqual(0.8);
    expect(seen.question).toEqual({
      type: "choice",
      instructions: "is the user's turn over?",
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

    const classifier = new JevClassifier({ client: _client(handler) });
    const options: Record<string, null> = {};
    for (let i = 0; i < JEV_MAX_CHOICE_OPTIONS + 1; i++) {
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
    const classifier = new JevClassifier({
      client: _client(() => _reply({ type: "choice", choice: "maybe", confidence: 0.8 })),
    });
    const question = new ChoiceQuestion({ instructions: "?", options: { yes: null, no: null } });
    const promise = classifier.choice("hmm", { answer: question });
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/not an option/);
    await classifier.client.close();
  });

  test("test_an_unusable_probability_is_an_error", async () => {
    const classifier = new JevClassifier({
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
        score: 1.05,
        legend: { "0": "calm", "1": "frustrated", "2": "angry" },
        probabilities: { "0": 0.0, "1": 0.95, "2": 0.05 },
        confidence: 0.92,
      });
    };

    const classifier = new JevClassifier({ client: _client(handler) });
    const levels = ["calm", "frustrated", "angry"];
    const result = (
      await classifier.score("This is the third time!", {
        answer: new ScoreQuestion({ instructions: "how upset is the user?", levels }),
      })
    ).answer!;

    expect(result.score).toEqual(1.05);
    expect(result.levels.map((l) => [l.level, l.probability])).toEqual([
      ["calm", 0.0],
      ["frustrated", 0.95],
      ["angry", 0.05],
    ]);
    expect(result.probability("frustrated")).toEqual(0.95);
    expect(result.confidence).toEqual(0.92);
    expect(seen.question).toEqual({
      type: "score",
      instructions: "how upset is the user?",
      criteria: levels,
    });
    await classifier.client.close();
  });

  test("test_missing_answer_field_is_an_error", async () => {
    const classifier = new JevClassifier({ client: _client(() => _reply({ type: "noul" })) });

    const promise = classifier.yesNo("a", { answer: new YesNoQuestion({ instructions: "?" }) });
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/noul/);
    await classifier.client.close();
  });

  test("test_images_are_referenced_ahead_of_the_state", async () => {
    const requests: MockRequest[] = [];

    const handler = (request: MockRequest): Response => {
      requests.push(request);
      return _reply({ type: "noul", noul: 0.99 });
    };

    const classifier = new JevClassifier({ client: _client(handler) });
    const png = new ClassifierImage({ data: bytes("png bytes"), contentType: "image/png" });
    const jpeg = new ClassifierImage({ data: bytes("jpeg bytes"), contentType: "image/jpeg" });
    const question = { answer: new YesNoQuestion({ instructions: "is there a red circle?" }) };
    expect(classifier.supportsImages).toBeTruthy();

    await classifier.yesNo("a camera frame", question, { images: [png, jpeg] });
    await classifier.yesNo("no frame", question);

    let body = JSON.parse(requests[0]!.content);
    const references: string[] = body.state.images;
    expect(body.state).toEqual({ images: references, state: "a camera frame" });
    expect(new Set(references).size).toEqual(2);
    expect(body.assets).toEqual({
      [references[0]!]: {
        type: "image",
        format: "png",
        data_base64: b64("png bytes"),
      },
      [references[1]!]: {
        type: "image",
        format: "jpg",
        data_base64: b64("jpeg bytes"),
      },
    });
    expect(requests[0]!.headers.get("TypeSafe-Danger-Zone-Images")).toEqual("true");
    body = JSON.parse(requests[1]!.content);
    expect(body.state).toEqual("no frame");
    expect("assets" in body).toBe(false);
    await classifier.client.close();
  });

  test("test_an_image_jev_cannot_read_is_an_error_before_any_request", async () => {
    const sent: MockRequest[] = [];

    const handler = (request: MockRequest): Response => {
      sent.push(request);
      return _reply({ type: "noul", noul: 0.5 });
    };

    const classifier = new JevClassifier({ client: _client(handler) });
    const webp = new ClassifierImage({ data: bytes("webp bytes"), contentType: "image/webp" });

    const promise = classifier.yesNo(
      "a frame",
      { answer: new YesNoQuestion({ instructions: "?" }) },
      { images: [webp] },
    );
    await expect(promise).rejects.toThrow(ClassifierError);
    await expect(promise).rejects.toThrow(/PNG or JPEG images, got image\/webp/);
    expect(sent).toEqual([]);
    await classifier.client.close();
  });

  test("test_needs_a_key_or_a_client", () => {
    expect(() => new JevClassifier()).toThrow(Error);
  });

  test("test_a_client_of_its_own_takes_the_model_endpoint_and_timeout", () => {
    const classifier = new JevClassifier({
      apiKey: "k",
      model: "jev-x",
      baseUrl: "https://jev.test",
      timeout: 1.5,
    });
    expect((classifier as unknown as { _ownsClient: boolean })._ownsClient).toBeTruthy();
    expect(classifier.client.model).toEqual("jev-x");
    const httpClient = http(classifier.client) as unknown as { _baseUrl: string; _timeout: number };
    expect(httpClient._baseUrl).toEqual("https://jev.test");
    expect(httpClient._timeout).toEqual(1.5);
  });

  test("test_cleanup_closes_only_an_owned_client", async () => {
    const owned = new JevClassifier({ apiKey: "key" });
    await owned.cleanup();
    expect(http(owned.client).isClosed).toBeTruthy();

    const shared = new JevClient({ apiKey: "key" });
    const classifier = new JevClassifier({ client: shared });
    await classifier.cleanup();
    expect(http(shared).isClosed).toBeFalsy();
    await shared.close();
  });
});

const LIVE = Boolean(process.env.TYPESAFE_API_KEY);

// Skipped unless TYPESAFE_API_KEY is set, as upstream.
describe("TestJevLive", () => {
  test.skipIf(!LIVE)(
    "test_three_questions",
    async () => {
      const classifier = new JevClassifier({ apiKey: process.env.TYPESAFE_API_KEY });
      try {
        const greeting =
          "Hi, you've reached Sam. I can't take your call right now, leave a message.";
        const yesNo = (
          await classifier.yesNo(greeting, {
            answer: new YesNoQuestion({ instructions: "is this a voicemail greeting?" }),
          })
        ).answer!;
        expect(yesNo.probability).toBeGreaterThan(0.5);

        const choice = (
          await classifier.choice("I'd like to book a table for, um", {
            answer: new ChoiceQuestion({
              instructions: "is the user's turn over?",
              options: {
                complete: "the user finished",
                short: "a brief pause",
                long: "asked for time",
              },
            }),
          })
        ).answer!;
        expect(["complete", "short", "long"]).toContain(choice.choice);
        const total = Object.values(choice.probabilities).reduce((a, b) => a + b, 0);
        expect(Math.abs(total - 1.0)).toBeLessThan(0.05);

        const score = (
          await classifier.score("This is the third time I call and nobody helps me!", {
            answer: new ScoreQuestion({
              instructions: "how upset is the user?",
              levels: ["calm", "impatient", "frustrated", "asking for a person"],
            }),
          })
        ).answer!;
        expect(score.score).toBeGreaterThanOrEqual(0);
        expect(score.score).toBeLessThanOrEqual(3);
        expect(classifier.client.usage.inputTokens).toBeGreaterThan(0);
      } finally {
        await classifier.cleanup();
      }
    },
    60_000,
  );

  test.skipIf(!LIVE)(
    "test_a_question_about_an_image",
    async () => {
      const classifier = new JevClassifier({ apiKey: process.env.TYPESAFE_API_KEY });
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
    60_000,
  );
});

describe("TestJevClientConnection", () => {
  // DIVERGENCE: upstream checks httpx's connection pool keep-alive expiry
  // (240 s). The port sends requests through `fetch` and leaves connection
  // reuse to the runtime, so there is no pool to inspect.
  test.skip("test_keeps_idle_connections_open_between_questions", () => {});

  test("test_setup_opens_the_connection", async () => {
    const seen: [string, string][] = [];

    const handler = (request: MockRequest): Response => {
      seen.push([request.method, request.url.pathname]);
      return jsonResponse(200, { models: [] });
    };

    const classifier = new JevClassifier({ client: _client(handler) });
    await classifier.setup(new TaskManager());

    expect(seen).toEqual([["GET", "/v1/models"]]);
    await classifier.client.close();
  });

  test("test_a_failed_connect_at_setup_is_only_a_warning", async () => {
    const handler = (_request: MockRequest): Response => {
      // Upstream raises httpx.ConnectError("down").
      throw new TypeError("down");
    };

    const classifier = new JevClassifier({ client: _client(handler) });
    await classifier.setup(new TaskManager());
    await classifier.client.close();
  });
});

describe("TestJevClassifierStructuredQuestions", () => {
  test("test_choice_with_structured_and_empty_descriptions", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.question = JSON.parse(request.content).questions.answer;
      return _reply({ type: "choice", choice: "b", probabilities: { b: 1.0 }, confidence: 1.0 });
    };

    const classifier = new JevClassifier({ client: _client(handler) });
    const options = { a: { examples: ["hi", "hello"] }, b: null };
    const result = (
      await classifier.choice("hey", {
        answer: new ChoiceQuestion({
          instructions: { question: "which?", note: "casual" },
          options,
        }),
      })
    ).answer!;

    expect(result.choice).toEqual("b");
    expect(seen.question).toEqual({
      type: "choice",
      instructions: { question: "which?", note: "casual" },
      criteria: options,
    });
    await classifier.client.close();
  });

  test("test_score_with_structured_levels_keys_probabilities_by_their_json", async () => {
    const handler = (_request: MockRequest): Response =>
      _reply({
        type: "score",
        score: 1.0,
        probabilities: { "0": 0.1, "1": 0.9 },
        confidence: 0.9,
      });

    const classifier = new JevClassifier({ client: _client(handler) });
    const levels = [{ level: "calm" }, { level: "angry", signs: ["shouting"] }];
    const result = (
      await classifier.score("This is the third time!", {
        answer: new ScoreQuestion({ instructions: "how upset?", levels }),
      })
    ).answer!;

    expect(result.levels.map((l) => l.level)).toEqual(levels);
    expect(result.probability({ level: "calm" })).toEqual(0.1);
    expect(result.probability({ signs: ["shouting"], level: "angry" })).toEqual(0.9);
    // Upstream raises KeyError.
    expect(() => result.probability({ level: "elated" })).toThrow(Error);
    await classifier.client.close();
  });
});

describe("TestJevClassifierSeveralQuestions", () => {
  test("test_ask_sends_every_question_in_one_request", async () => {
    const seen: Record<string, unknown> = {};

    const handler = (request: MockRequest): Response => {
      seen.body = JSON.parse(request.content);
      return jsonResponse(200, {
        model: "jev-1.13.0",
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

    const classifier = new JevClassifier({ client: _client(handler) });
    const results = await classifier.ask("Hello there!", {
      greeting: new YesNoQuestion({ instructions: "is this a greeting?" }),
      mood: new ScoreQuestion({ instructions: "how upset?", levels: ["calm", "upset"] }),
    });

    const body = seen.body as { questions: Record<string, unknown> };
    expect(new Set(Object.keys(body.questions))).toEqual(new Set(["greeting", "mood"]));
    expect((results.greeting as YesNoResult).probability).toEqual(0.9);
    const mood = results.mood as ScoreResult;
    expect(mood.score).toEqual(0.2);
    expect(mood.probability("calm")).toEqual(0.8);
    expect(mood.probability("upset")).toEqual(0.2);
    await classifier.client.close();
  });

  test("test_typed_method_takes_several_questions_of_its_kind", async () => {
    const handler = (_request: MockRequest): Response =>
      jsonResponse(200, {
        answers: {
          a: { type: "noul", noul: 0.1 },
          b: { type: "noul", noul: 0.7 },
        },
        usage: USAGE,
      });

    const classifier = new JevClassifier({ client: _client(handler) });
    const results = await classifier.yesNo("hi", {
      a: new YesNoQuestion({ instructions: "a?" }),
      b: new YesNoQuestion({ instructions: "b?" }),
    });

    expect(
      Object.fromEntries(Object.entries(results).map(([name, r]) => [name, r.probability])),
    ).toEqual({ a: 0.1, b: 0.7 });
    await classifier.client.close();
  });

  test("test_a_missing_answer_is_an_error", async () => {
    const classifier = new JevClassifier({
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

  test("test_a_shared_client_connects_once", async () => {
    const connects: string[] = [];

    const handler = (request: MockRequest): Response => {
      connects.push(request.url.pathname);
      return jsonResponse(200, { models: [] });
    };

    const client = _client(handler);
    const [first, second] = [new JevClassifier({ client }), new JevClassifier({ client })];
    const taskManager = new TaskManager();
    await asyncio.gather(
      () => first.setup(taskManager),
      () => second.setup(taskManager),
    );
    await first.setup(taskManager);

    expect(connects).toEqual(["/v1/models"]);
    await client.close();
  });
});

describe("TestResults", () => {
  test("test_yes_when_yes_is_likelier", () => {
    expect(new YesNoResult({ probability: 0.5 }).isYes).toBeTruthy();
    expect(new YesNoResult({ probability: 0.9 }).isYes).toBeTruthy();
    expect(new YesNoResult({ probability: 0.49 }).isYes).toBeFalsy();
  });
});

describe("TestMetrics", () => {
  test("test_every_call_reports_its_time_and_tokens", async () => {
    const client = _client(() => _reply({ type: "noul", noul: 0.9 }));
    const classifier = new JevClassifier({ client });
    await classifier.setup(new TaskManager());
    const reported = new asyncio.Event();
    const seen: MetricsData[] = [];

    classifier.eventHandler("on_metrics", async (_classifier, data: MetricsData[]) => {
      seen.push(...data);
      reported.set();
    });

    await classifier.yesNo("hello", {
      answer: new YesNoQuestion({ instructions: "a greeting?" }),
    });
    await asyncio.waitFor(() => reported.wait(), 1);

    const [processing, usage] = seen;
    expect(processing).toBeInstanceOf(ProcessingMetricsData);
    expect(processing!.processor).toEqual(classifier.name);
    expect(processing!.model).toEqual(classifier.model);
    expect((processing as ProcessingMetricsData).value).toBeGreaterThanOrEqual(0);
    expect(usage).toBeInstanceOf(LLMUsageMetricsData);
    const value = (usage as LLMUsageMetricsData).value;
    expect([value.promptTokens, value.completionTokens]).toEqual([12, 3]);
    expect(value.totalTokens).toEqual(15);
    await classifier.cleanup();
    await client.close();
  });

  test("test_a_named_classifier_reports_metrics_under_its_name", async () => {
    const client = _client(() => _reply({ type: "noul", noul: 0.9 }));
    const classifier = new JevClassifier({ client, name: "voicemail" });
    const reported = new asyncio.Event();
    const seen: MetricsData[] = [];

    classifier.eventHandler("on_metrics", async (_classifier, data: MetricsData[]) => {
      seen.push(...data);
      reported.set();
    });

    await classifier.yesNo("hello", {
      answer: new YesNoQuestion({ instructions: "a greeting?" }),
    });
    await asyncio.waitFor(() => reported.wait(), 1);

    expect(classifier.name).toEqual("voicemail");
    expect(seen.every((item) => item.processor === "voicemail")).toBeTruthy();
    await client.close();
  });
});
