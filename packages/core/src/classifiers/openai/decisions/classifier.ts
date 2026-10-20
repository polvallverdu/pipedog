// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/classifiers/openai/decisions/classifier.py

/**
 * Classifier backed by OpenAI's Decisions API.
 *
 * `OpenAIDecisionsClassifier` turns each question into a request and each
 * reply into a result, through an `OpenAIDecisionsClient`.
 */

import { rethrowIfCancelled } from "@pipecat-ts/asyncio";
import { LLMTokenUsage } from "../../../metrics/metrics.ts";
import type { BaseTaskManager } from "../../../utils/asyncio/task_manager.ts";
import { logger } from "../../../utils/logger.ts";
import {
  BaseClassifier,
  type BaseClassifierOptions,
  ChoiceQuestion,
  ChoiceResult,
  ClassifierError,
  type ClassifierImage,
  type ClassifierQuestion,
  type ClassifierResult,
  type ClassifierValue,
  ScoreLevel,
  ScoreResult,
  YesNoQuestion,
  YesNoResult,
} from "../../base_classifier.ts";
import { bytesToBase64, isDict, toFloat } from "../../http_client.ts";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT,
  OpenAIDecisionsClient,
} from "./client.ts";

/** The most options the Decisions API takes in one choice question. */
export const OPENAI_DECISIONS_MAX_CHOICE_OPTIONS = 255;

/** The most images the Decisions API takes in one request. */
export const OPENAI_DECISIONS_MAX_IMAGES = 128;

export interface OpenAIDecisionsClassifierOptions extends BaseClassifierOptions {
  /** OpenAI API key, when the classifier should have a client of its own. */
  apiKey?: string | null;
  /** A client to share. One of `apiKey` and `client` is required. */
  client?: OpenAIDecisionsClient | null;
  /** The decision model a client of its own asks. */
  model?: string;
  /** Where a client of its own sends its questions. */
  baseUrl?: string;
  /** Seconds a client of its own waits for an answer. */
  timeout?: number;
}

/**
 * Answers questions by asking OpenAI's Decisions API.
 *
 * Structured state, instructions and descriptions are sent as JSON. Build
 * one with an API key to get a client of its own, or pass an
 * `OpenAIDecisionsClient` to share one between several classifiers. A client
 * the classifier created is closed in `cleanup()`; a shared one is left to
 * whoever made it.
 *
 * The Decisions API can see images: up to `OPENAI_DECISIONS_MAX_IMAGES` per
 * call.
 *
 * @example
 * const classifier = new OpenAIDecisionsClassifier({ apiKey: process.env.OPENAI_API_KEY });
 */
export class OpenAIDecisionsClassifier extends BaseClassifier {
  protected _ownsClient: boolean;
  protected _client: OpenAIDecisionsClient;

  constructor(options: OpenAIDecisionsClassifierOptions = {}) {
    super(options);
    this._ownsClient = options.client == null;
    let client = options.client ?? null;
    if (!client) {
      if (!options.apiKey) {
        throw new Error("OpenAIDecisionsClassifier needs an API key or an OpenAIDecisionsClient");
      }
      client = new OpenAIDecisionsClient({
        apiKey: options.apiKey,
        model: options.model ?? DEFAULT_MODEL,
        baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
        timeout: options.timeout ?? DEFAULT_TIMEOUT,
      });
    }
    this._client = client;
  }

  /** The client this classifier asks through. */
  get client(): OpenAIDecisionsClient {
    return this._client;
  }

  /**
   * Open the connection to OpenAI ahead of the first question.
   *
   * A connection that cannot be opened now is only a warning: the first
   * question opens it itself.
   *
   * @param taskManager The task manager of the owner.
   */
  override async setup(taskManager: BaseTaskManager): Promise<void> {
    await super.setup(taskManager);
    try {
      await this._client.connect();
    } catch (e) {
      if (!(e instanceof ClassifierError)) {
        throw e;
      }
      logger.warning(`${this}: ${e.message}`);
    }
  }

  /** Close the client if this classifier created it. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    if (this._ownsClient) {
      await this._client.close();
    }
  }

  /** The decision model the questions go to. */
  override get model(): string {
    return this._client.model;
  }

  /** The Decisions API can see images. */
  override get supportsImages(): boolean {
    return true;
  }

  /** Answer the questions in one request. */
  protected async _ask(
    state: ClassifierValue,
    questions: Readonly<Record<string, ClassifierQuestion>>,
    images: readonly ClassifierImage[] = [],
  ): Promise<[Record<string, ClassifierResult>, LLMTokenUsage]> {
    if (images.length > OPENAI_DECISIONS_MAX_IMAGES) {
      throw new ClassifierError(
        `OpenAI Decisions takes at most ${OPENAI_DECISIONS_MAX_IMAGES} images, got ${images.length}`,
      );
    }
    const openaiQuestions: Record<string, Record<string, unknown>> = {};
    for (const [name, q] of Object.entries(questions)) {
      openaiQuestions[name] = this._toOpenai(q);
    }
    const [answers, usage] = await this._client.ask(this._input(state, images), openaiQuestions);
    const results: Record<string, ClassifierResult> = {};
    for (const [name, question] of Object.entries(questions)) {
      results[name] = this._fromOpenai(name, question, answers[name] as Record<string, unknown>);
    }
    return [
      results,
      new LLMTokenUsage({
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens,
      }),
    ];
  }

  /** The request's input: the state as text, or a user message with any images first. */
  protected _input(
    state: ClassifierValue,
    images: readonly ClassifierImage[],
  ): string | Record<string, unknown>[] {
    const text = this._text(state);
    if (images.length === 0) {
      return text;
    }
    const content: Record<string, unknown>[] = images.map((image) => ({
      type: "input_image",
      image_url: `data:${image.contentType};base64,${bytesToBase64(image.data)}`,
    }));
    content.push({ type: "input_text", text });
    return [{ role: "user", content }];
  }

  /** A question in the Decisions API's own format. */
  protected _toOpenai(question: ClassifierQuestion): Record<string, unknown> {
    if (question instanceof YesNoQuestion) {
      // A predicate has no field for what counts as each answer, so it goes
      // in the instructions.
      const lines = [this._text(question.instructions)];
      if (question.yes !== null) {
        lines.push(`Yes means: ${this._text(question.yes)}`);
      }
      if (question.no !== null) {
        lines.push(`No means: ${this._text(question.no)}`);
      }
      return { type: "predicate", instructions: lines.join("\n") };
    }
    if (question instanceof ChoiceQuestion) {
      const count = Object.keys(question.options).length;
      if (count > OPENAI_DECISIONS_MAX_CHOICE_OPTIONS) {
        throw new ClassifierError(
          `OpenAI Decisions takes at most ${OPENAI_DECISIONS_MAX_CHOICE_OPTIONS} options, got ${count}`,
        );
      }
      return {
        type: "choice",
        instructions: this._text(question.instructions),
        choices: Object.entries(question.options).map(([option, description]) =>
          description === null
            ? { value: option }
            : { value: option, description: this._text(description) },
        ),
      };
    }
    return {
      type: "score",
      instructions: this._text(question.instructions),
      levels: question.levels.map((level) => ({ label: this._text(level) })),
    };
  }

  /** A result built from the Decisions API's answer to the question. */
  protected _fromOpenai(
    name: string,
    question: ClassifierQuestion,
    answer: Record<string, unknown>,
  ): ClassifierResult {
    if (answer.type === "refusal") {
      throw new ClassifierError(`OpenAI Decisions refused to answer '${name}'`);
    }
    if (question instanceof YesNoQuestion) {
      return new YesNoResult({ probability: this._number(answer, "probability") });
    }
    if (question instanceof ChoiceQuestion) {
      const choice = String(answer.choice ?? "");
      if (!Object.hasOwn(question.options, choice)) {
        throw new ClassifierError(`OpenAI Decisions chose '${choice}', which is not an option`);
      }
      const probabilities = this._probabilities(answer, Object.keys(question.options));
      return new ChoiceResult({
        choice,
        probabilities,
        confidence: this._number(answer, "confidence"),
      });
    }
    // The Decisions API keys level probabilities by position.
    const positions = question.levels.map((_level, index) => String(index));
    const probabilities = this._probabilities(answer, positions);
    return new ScoreResult({
      score: this._number(answer, "score"),
      levels: question.levels.map(
        (level, index) =>
          new ScoreLevel({ level, probability: probabilities[positions[index] as string] ?? 0 }),
      ),
      confidence: this._number(answer, "confidence"),
    });
  }

  /** Text for the Decisions API: a string as is, structured data as JSON. */
  protected _text(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  /** The number the API wrote under `key`, or a ClassifierError if it did not. */
  protected _number(answer: Record<string, unknown>, key: string): number {
    try {
      if (!Object.hasOwn(answer, key)) {
        throw new RangeError(key);
      }
      return toFloat(answer[key]);
    } catch (e) {
      rethrowIfCancelled(e);
      throw new ClassifierError(`OpenAI Decisions reply has no usable '${key}'`, { cause: e });
    }
  }

  /**
   * The probability the API gave for each key, 0 for the ones it left out.
   *
   * The API lists probabilities as `{"value", "probability"}` items, where
   * the value is a choice's option or a level's position.
   */
  protected _probabilities(
    answer: Record<string, unknown>,
    keys: string[],
  ): Record<string, number> {
    const given = answer.probabilities;
    const byValue = new Map<string, unknown>();
    for (const item of Array.isArray(given) ? given : []) {
      if (isDict(item)) {
        byValue.set(pyStr(item.value), item.probability ?? null);
      }
    }
    try {
      return Object.fromEntries(
        keys.map((key) => [key, toFloat(byValue.has(key) ? byValue.get(key) : 0.0)]),
      );
    } catch (e) {
      rethrowIfCancelled(e);
      throw new ClassifierError(
        `OpenAI Decisions reply has an unusable probability: ${(e as Error).message}`,
        { cause: e },
      );
    }
  }
}

/** Python's `str()` for a JSON value, so a missing value reads `None` as upstream's does. */
function pyStr(value: unknown): string {
  if (value === undefined || value === null) {
    return "None";
  }
  return String(value);
}
