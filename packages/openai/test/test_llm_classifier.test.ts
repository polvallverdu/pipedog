// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_llm_classifier.py

/**
 * Unit tests for LLMClassifier.
 *
 * A scripted LLM service stands in for the model: `runInference()` returns
 * the next scripted reply, so the tests exercise the question rendering, the
 * JSON parsing and the results.
 */

import { expect, test } from "bun:test";

import * as asyncio from "@pipedog/asyncio";
import {
  ChoiceQuestion,
  ClassifierError,
  ClassifierImage,
  ScoreQuestion,
  YesNoQuestion,
} from "@pipedog/core/classifiers/base_classifier";
import { LLMClassifier, type LLMClassifierOptions } from "@pipedog/core/classifiers/llm/classifier";
import { OutputImageRawFrame } from "@pipedog/core/frames/frames";
import { type MetricsData, ProcessingMetricsData } from "@pipedog/core/metrics/metrics";
import type { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LLMService } from "@pipedog/core/services/llm_service";
import { bytesToBase64 } from "@pipedog/core/utils/base64";

import { OpenAILLMService } from "../src/llm.ts";

type InferenceOptions = {
  maxTokens?: number | null;
  systemInstruction?: string | null;
  responseSchema?: Record<string, unknown> | null;
};

// Python's pytest.approx for floats.
function approx(actual: number, expected: number): void {
  expect(actual).toBeCloseTo(expected, 6);
}

/** Answers runInference() with the next scripted reply and records the request. */
class _ScriptedLLM extends LLMService {
  #replies: (string | null)[];
  requests: [string, string | null][] = [];
  schemas: (Record<string, unknown> | null)[] = [];

  constructor(...replies: (string | null)[]) {
    super();
    this.#replies = [...replies];
  }

  override async runInference(
    context: LLMContext,
    options: InferenceOptions = {},
  ): Promise<string | null> {
    const content = (context.messages.at(-1) as { content: unknown }).content;
    if (typeof content !== "string") {
      throw new Error("AssertionError: content is not a string");
    }
    this.requests.push([content, options.systemInstruction ?? null]);
    this.schemas.push(options.responseSchema ?? null);
    return this.#replies.shift() as string | null;
  }
}

class _NoInferenceLLM extends LLMService {}

/** Fails runInference() the way a provider client does. */
class _FailingLLM extends LLMService {
  override async runInference(
    _context: LLMContext,
    _options: InferenceOptions = {},
  ): Promise<string | null> {
    throw new Error("connection reset");
  }
}

/** Never answers runInference(). */
class _SilentLLM extends LLMService {
  override async runInference(
    _context: LLMContext,
    _options: InferenceOptions = {},
  ): Promise<string | null> {
    await new asyncio.Event().wait();
    return null;
  }
}

function _classifier(
  replies: (string | null)[],
  options: Omit<LLMClassifierOptions, "llm"> = {},
): [LLMClassifier, _ScriptedLLM] {
  const llm = new _ScriptedLLM(...replies);
  return [new LLMClassifier({ llm, ...options }), llm];
}

test("test_yes_no_answers_from_the_json_reply", async () => {
  const [classifier] = _classifier(['{"greeting": {"probability": 0.93}}']);
  const results = await classifier.yesNo("Hello?", {
    greeting: new YesNoQuestion({ instructions: "a greeting?" }),
  });
  expect(results.greeting!.probability).toEqual(0.93);
});

test("test_choice_answers_with_a_probability_per_option", async () => {
  const [classifier] = _classifier([
    '{"turn": {"choice": "short", "probabilities": {"short": 0.8, "complete": 0.2}}}',
  ]);
  const question = new ChoiceQuestion({
    instructions: "is the turn over?",
    options: { complete: "finished", short: "cut off", long: "needs time" },
  });
  const results = await classifier.choice("I'd like to", { turn: question });

  expect(results.turn!.choice).toEqual("short");
  expect(results.turn!.probabilities).toEqual({ complete: 0.2, short: 0.8, long: 0.0 });
  expect(results.turn!.confidence).toEqual(0.8);
});

test("test_score_answers_from_a_probability_per_level", async () => {
  const [classifier] = _classifier(['{"mood": {"probabilities": {"0": 0.0, "1": 0.3, "2": 0.7}}}']);
  const question = new ScoreQuestion({
    instructions: "how upset?",
    levels: ["calm", "impatient", "frustrated"],
  });
  const results = await classifier.score("This is the third time!", { mood: question });

  approx(results.mood!.score, 1.7);
  expect(results.mood!.confidence).toEqual(0.7);
  expect(results.mood!.levels.map((l) => [l.level, l.probability])).toEqual([
    ["calm", 0.0],
    ["impatient", 0.3],
    ["frustrated", 0.7],
  ]);
  expect(results.mood!.probability("frustrated")).toEqual(0.7);
});

test("test_score_probabilities_are_scaled_to_sum_to_one", async () => {
  const [classifier] = _classifier(['{"mood": {"probabilities": {"0": 0.5, "1": 1.0}}}']);
  const question = new ScoreQuestion({ instructions: "how upset?", levels: ["calm", "upset"] });
  const results = await classifier.score("hmm", { mood: question });

  const probabilities = results.mood!.levels.map((l) => l.probability);
  expect(probabilities.length).toEqual(2);
  approx(probabilities[0]!, 1 / 3);
  approx(probabilities[1]!, 2 / 3);
  approx(results.mood!.score, 2 / 3);
});

test("test_a_score_without_any_probability_is_an_error", async () => {
  const [classifier] = _classifier(['{"mood": {"probabilities": {}}}']);
  const question = new ScoreQuestion({ instructions: "how upset?", levels: ["calm", "upset"] });
  await expect(classifier.score("hmm", { mood: question })).rejects.toThrow(ClassifierError);
});

test("test_several_questions_go_in_one_call", async () => {
  const [classifier, llm] = _classifier([
    '{"greeting": {"probability": 0.9}, "mood": {"probabilities": {"0": 1.0, "1": 0.0}}}',
  ]);
  const results = await classifier.ask("Hello there!", {
    greeting: new YesNoQuestion({ instructions: "a greeting?" }),
    mood: new ScoreQuestion({ instructions: "how upset?", levels: ["calm", "upset"] }),
  });

  expect(llm.requests.length).toEqual(1);
  expect((results.greeting as { probability: number }).probability).toEqual(0.9);
  expect((results.mood as { score: number }).score).toEqual(0.0);
});

test("test_the_question_is_rendered_with_its_options_and_the_reply_shape", async () => {
  const [classifier, llm] = _classifier(['{"which": {"choice": "a"}}']);
  await classifier.choice(
    { assistant: "Where to?", user: "japan" },
    { which: new ChoiceQuestion({ instructions: "which?", options: { a: "first", b: null } }) },
  );

  const [message, instructions] = llm.requests[0]!;
  expect(message.startsWith('Input:\n{\n  "assistant": "Where to?"')).toBe(true);
  expect(message).toContain('Question "which": which?');
  expect(message).toContain("- a: first\n- b\n");
  expect(message).toContain(
    'Reply with one JSON object of this shape: {"which": <answer to "which">}',
  );
  expect(instructions !== null && instructions.includes("single JSON object")).toBe(true);
});

test("test_yes_and_no_meanings_are_written_into_the_question", async () => {
  const [classifier, llm] = _classifier(['{"q": {"probability": 0.1}}']);
  await classifier.yesNo("Hello?", {
    q: new YesNoQuestion({
      instructions: "is this a voicemail?",
      yes: "a recording",
      no: "a person",
    }),
  });
  const [message] = llm.requests[0]!;
  expect(message).toContain("Yes means: a recording");
  expect(message).toContain("No means: a person");
});

test("test_custom_instructions_reach_the_llm", async () => {
  const [classifier, llm] = _classifier(['{"q": {"probability": 0.5}}'], {
    instructions: "Decide.",
  });
  await classifier.yesNo("hi", { q: new YesNoQuestion({ instructions: "?" }) });
  expect(llm.requests[0]![1]).toEqual("Decide.");
});

test("test_a_fenced_reply_is_parsed", async () => {
  const [classifier] = _classifier(['Sure:\n```json\n{"q": {"probability": 0.4}}\n```\n']);
  const results = await classifier.yesNo("hi", { q: new YesNoQuestion({ instructions: "?" }) });
  expect(results.q!.probability).toEqual(0.4);
});

test("test_the_reply_schema_has_one_answer_per_question", async () => {
  const [classifier, llm] = _classifier([
    '{"q": {"probability": 0.5}, "w": {"choice": "a", "probabilities": {"a": 1, "b": 0}}}',
  ]);
  await classifier.ask("hi", {
    q: new YesNoQuestion({ instructions: "?" }),
    w: new ChoiceQuestion({ instructions: "?", options: { a: "", b: null } }),
  });

  const schema = llm.schemas[0] as any;
  expect(schema).not.toBeNull();
  expect(schema.required).toEqual(["q", "w"]);
  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties.q.required).toEqual(["probability"]);
  const choice = schema.properties.w.properties;
  expect(choice.choice.enum).toEqual(["a", "b"]);
  expect(choice.probabilities.required).toEqual(["a", "b"]);
});

test("test_the_score_schema_asks_for_a_probability_per_level", async () => {
  const [classifier, llm] = _classifier(['{"mood": {"probabilities": {"0": 0.5, "1": 0.5}}}']);
  await classifier.score("hi", {
    mood: new ScoreQuestion({ instructions: "?", levels: ["a", "b"] }),
  });

  const schema = llm.schemas[0] as any;
  expect(schema).not.toBeNull();
  expect(schema.properties.mood.required).toEqual(["probabilities"]);
  expect(schema.properties.mood.properties.probabilities.required).toEqual(["0", "1"]);
});

test("test_a_choice_without_probabilities_has_no_confidence", async () => {
  const [classifier] = _classifier(['{"q": {"choice": "b"}}']);
  const results = await classifier.choice("hi", {
    q: new ChoiceQuestion({ instructions: "?", options: { a: "", b: "" } }),
  });
  expect(results.q!.choice).toEqual("b");
  expect(results.q!.confidence).toEqual(0.0);
  expect(results.q!.probabilities).toEqual({ a: 0.0, b: 0.0 });
});

test("test_a_lone_answer_without_its_name_is_accepted", async () => {
  const [classifier] = _classifier(['{"choice": "b", "probabilities": {"a": 0.2, "b": 0.8}}']);
  const results = await classifier.choice("hi", {
    q: new ChoiceQuestion({ instructions: "?", options: { a: "", b: "" } }),
  });
  expect(results.q!.choice).toEqual("b");
});

test("test_a_failed_llm_call_is_a_classifier_error", async () => {
  const classifier = new LLMClassifier({ llm: new _FailingLLM() });
  const promise = classifier.yesNo("hi", { q: new YesNoQuestion({ instructions: "?" }) });
  await expect(promise).rejects.toThrow(ClassifierError);
  await expect(promise).rejects.toThrow(/connection reset/);
});

test("test_a_text_reply_is_an_error", async () => {
  const [classifier] = _classifier(["I think yes."]);
  const promise = classifier.yesNo("hi", { q: new YesNoQuestion({ instructions: "?" }) });
  await expect(promise).rejects.toThrow(ClassifierError);
  await expect(promise).rejects.toThrow(/JSON object/);
});

test("test_a_missing_answer_is_an_error", async () => {
  const [classifier] = _classifier(['{"other": {"probability": 0.5}}']);
  const promise = classifier.yesNo("hi", {
    a: new YesNoQuestion({ instructions: "?" }),
    b: new YesNoQuestion({ instructions: "?" }),
  });
  await expect(promise).rejects.toThrow(ClassifierError);
  await expect(promise).rejects.toThrow(/no answer for 'a'/);
});

test("test_a_choice_outside_the_options_is_an_error", async () => {
  const [classifier] = _classifier(['{"q": {"choice": "c"}}']);
  const promise = classifier.choice("hi", {
    q: new ChoiceQuestion({ instructions: "?", options: { a: "", b: "" } }),
  });
  await expect(promise).rejects.toThrow(ClassifierError);
  await expect(promise).rejects.toThrow(/not an option/);
});

test("test_a_reply_that_does_not_come_in_time_is_an_error", async () => {
  const classifier = new LLMClassifier({ llm: new _SilentLLM(), timeout: 0.05 });
  const promise = classifier.yesNo("hello", {
    answer: new YesNoQuestion({ instructions: "a greeting?" }),
  });
  await expect(promise).rejects.toThrow(ClassifierError);
  await expect(promise).rejects.toThrow(/did not answer within/);
});

test("test_a_service_without_run_inference_is_an_error", async () => {
  const classifier = new LLMClassifier({ llm: new _NoInferenceLLM() });
  const promise = classifier.yesNo("hi", { q: new YesNoQuestion({ instructions: "?" }) });
  await expect(promise).rejects.toThrow(ClassifierError);
  await expect(promise).rejects.toThrow(/one-shot/);
});

test("test_every_call_reports_its_time_without_tokens", async () => {
  const [classifier] = _classifier(['{"answer": {"probability": 0.9}}']);
  const reported = new asyncio.Event();
  const seen: MetricsData[] = [];

  classifier.eventHandler("on_metrics", async (_classifier: unknown, data: MetricsData[]) => {
    seen.push(...data);
    reported.set();
  });

  await classifier.yesNo("hello", { answer: new YesNoQuestion({ instructions: "a greeting?" }) });
  await asyncio.waitFor(() => reported.wait(), 1);

  expect(seen.length).toEqual(1);
  const [processing] = seen;
  expect(processing).toBeInstanceOf(ProcessingMetricsData);
  expect(processing!.processor).toEqual(classifier.name);
  expect(processing!.model).toBeNull();
  expect(processing!.value as number).toBeGreaterThanOrEqual(0);
});

test("test_a_named_classifier_reports_metrics_under_its_name", async () => {
  const [classifier] = _classifier(['{"answer": {"probability": 0.9}}'], { name: "voicemail" });
  const reported = new asyncio.Event();
  const seen: MetricsData[] = [];

  classifier.eventHandler("on_metrics", async (_classifier: unknown, data: MetricsData[]) => {
    seen.push(...data);
    reported.set();
  });

  await classifier.yesNo("hello", { answer: new YesNoQuestion({ instructions: "a greeting?" }) });
  await asyncio.waitFor(() => reported.wait(), 1);

  expect(classifier.name).toEqual("voicemail");
  expect(seen[0]!.processor).toEqual("voicemail");
});

/** Answers runInference() with one reply and keeps the message it was sent. */
class _RecordingLLM extends LLMService {
  #reply: string;
  contents: unknown[] = [];

  constructor(reply: string) {
    super();
    this.#reply = reply;
  }

  override async runInference(
    context: LLMContext,
    _options: InferenceOptions = {},
  ): Promise<string | null> {
    this.contents.push((context.messages.at(-1) as { content: unknown }).content);
    return this.#reply;
  }
}

test("test_images_go_to_the_llm_before_the_questions", async () => {
  const llm = new _RecordingLLM('{"red": {"probability": 0.9}}');
  const classifier = new LLMClassifier({ llm });
  const bytes = new TextEncoder().encode("jpeg bytes");
  const image = new ClassifierImage({ data: bytes, contentType: "image/jpeg" });
  const question = { red: new YesNoQuestion({ instructions: "is there a red circle?" }) };
  expect(classifier.supportsImages).toBe(true);

  const results = await classifier.yesNo("A camera frame.", question, { images: [image, image] });
  await classifier.yesNo("No frame.", question);

  expect(results.red!.probability).toEqual(0.9);
  expect(llm.contents.length).toEqual(2);
  const [withImages, withoutImages] = llm.contents as [Record<string, unknown>[], unknown];
  const url = `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
  expect(withImages.slice(0, 2)).toEqual([
    { type: "image_url", image_url: { url } },
    { type: "image_url", image_url: { url } },
  ]);
  expect(withImages[2]!.type).toEqual("text");
  expect(withImages[2]!.text as string).toContain("A camera frame.");
  expect(typeof withoutImages).toEqual("string");
});

test.skipIf(!process.env.OPENAI_API_KEY)(
  "test_a_vision_llm_answers_a_question_about_an_image",
  async () => {
    // PORTING NOTE: upstream draws the circle with Pillow and saves a JPEG;
    // this draws raw RGB pixels and encodes them as a JPEG via fromFrame().
    async function circle(color: [number, number, number]): Promise<ClassifierImage> {
      const [width, height] = [640, 480];
      const pixels = new Uint8Array(width * height * 3).fill(255);
      const [cx, cy, r] = [320, 240, 100];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
            pixels.set(color, (y * width + x) * 3);
          }
        }
      }
      const frame = new OutputImageRawFrame({
        image: pixels,
        size: [width, height],
        format: "RGB",
      });
      return ClassifierImage.fromFrame(frame);
    }

    const llm = new OpenAILLMService({
      apiKey: process.env.OPENAI_API_KEY,
      settings: new OpenAILLMService.Settings({ model: "gpt-4.1-mini" }),
    });
    const classifier = new LLMClassifier({ llm, timeout: 30 });
    const question = {
      red: new YesNoQuestion({ instructions: "Is there a red circle in the image?" }),
    };

    const red = await classifier.yesNo("A camera frame.", question, {
      images: [await circle([255, 0, 0])],
    });
    const blue = await classifier.yesNo("A camera frame.", question, {
      images: [await circle([0, 0, 255])],
    });

    expect(red.red!.isYes).toBe(true);
    expect(blue.red!.isYes).toBe(false);
  },
  60_000,
);
