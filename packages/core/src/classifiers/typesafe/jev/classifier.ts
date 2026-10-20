// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/classifiers/typesafe/jev/classifier.py

/**
 * Classifier backed by Jev, TypeSafe's hosted classification model.
 *
 * `JevClassifier` turns each question into a request and each reply into a
 * result, through a `JevClient`.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
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
import { bytesToBase64, isDict, orEmpty, toFloat } from "../../http_client.ts";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_TIMEOUT, JevClient } from "./client.ts";

/** The most options Jev takes in one choice question. */
export const JEV_MAX_CHOICE_OPTIONS = 255;

/** Jev's name for each image type it reads. */
const JEV_IMAGE_FORMATS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg" };

export interface JevClassifierOptions extends BaseClassifierOptions {
  /** Jev API key, when the classifier should have a client of its own. */
  apiKey?: string | null;
  /** A client to share. One of `apiKey` and `client` is required. */
  client?: JevClient | null;
  /** The Jev model a client of its own asks. */
  model?: string;
  /** Where a client of its own sends its questions. */
  baseUrl?: string;
  /** Seconds a client of its own waits for an answer. */
  timeout?: number;
}

/**
 * Answers questions by asking Jev.
 *
 * Jev's probabilities are calibrated. Build one with an API key to get a
 * client of its own, or pass a `JevClient` to share one between several
 * classifiers. A client the classifier created is closed in `cleanup()`; a
 * shared one is left to whoever made it.
 *
 * Jev can see PNG and JPEG images, 256 to 1568 pixels on each side. It reads
 * them as part of the state. TypeSafe offers images as a preview, so their
 * limits may change between Jev releases.
 *
 * @example
 * const client = new JevClient({ apiKey: process.env.TYPESAFE_API_KEY! });
 * const turnClassifier = new JevClassifier({ client });
 * const voicemailClassifier = new JevClassifier({ client });
 */
export class JevClassifier extends BaseClassifier {
  protected _ownsClient: boolean;
  protected _client: JevClient;

  constructor(options: JevClassifierOptions = {}) {
    super(options);
    this._ownsClient = options.client == null;
    let client = options.client ?? null;
    if (!client) {
      if (!options.apiKey) {
        throw new Error("JevClassifier needs an API key or a JevClient");
      }
      client = new JevClient({
        apiKey: options.apiKey,
        model: options.model ?? DEFAULT_MODEL,
        baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
        timeout: options.timeout ?? DEFAULT_TIMEOUT,
      });
    }
    this._client = client;
  }

  /** The client this classifier asks through. */
  get client(): JevClient {
    return this._client;
  }

  /**
   * Open the connection to Jev ahead of the first question.
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

  /** The Jev model the questions go to. */
  override get model(): string {
    return this._client.model;
  }

  /** Jev can see images. */
  override get supportsImages(): boolean {
    return true;
  }

  /** Answer the questions in one request. */
  protected async _ask(
    state: ClassifierValue,
    questions: Readonly<Record<string, ClassifierQuestion>>,
    images: readonly ClassifierImage[] = [],
  ): Promise<[Record<string, ClassifierResult>, LLMTokenUsage]> {
    const assets: Record<string, Record<string, unknown>> = {};
    for (const image of images) {
      assets[crypto.randomUUID()] = this._asset(image);
    }
    let requestState: unknown = state;
    if (Object.keys(assets).length > 0) {
      // Jev reads an image wherever its reference appears, so the references
      // go ahead of the state they come with.
      requestState = { images: Object.keys(assets), state };
    }
    const jevQuestions: Record<string, Record<string, unknown>> = {};
    for (const [name, q] of Object.entries(questions)) {
      jevQuestions[name] = this._toJev(q);
    }
    const [answers, usage] = await this._client.ask(requestState, jevQuestions, assets);
    const results: Record<string, ClassifierResult> = {};
    for (const [name, question] of Object.entries(questions)) {
      results[name] = this._fromJev(question, answers[name] as Record<string, unknown>);
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

  /** An image in Jev's own format. */
  protected _asset(image: ClassifierImage): Record<string, unknown> {
    const format = JEV_IMAGE_FORMATS[image.contentType];
    if (!format) {
      throw new ClassifierError(`Jev takes PNG or JPEG images, got ${image.contentType}`);
    }
    return {
      type: "image",
      format,
      data_base64: bytesToBase64(image.data),
    };
  }

  /** A question in Jev's own format. */
  protected _toJev(question: ClassifierQuestion): Record<string, unknown> {
    if (question instanceof YesNoQuestion) {
      const jev: Record<string, unknown> = { type: "noul", instructions: question.instructions };
      if (question.yes !== null || question.no !== null) {
        jev.criteria = { true: orEmpty(question.yes), false: orEmpty(question.no) };
      }
      return jev;
    }
    if (question instanceof ChoiceQuestion) {
      const count = Object.keys(question.options).length;
      if (count > JEV_MAX_CHOICE_OPTIONS) {
        throw new ClassifierError(
          `Jev takes at most ${JEV_MAX_CHOICE_OPTIONS} options, got ${count}`,
        );
      }
      return {
        type: "choice",
        instructions: question.instructions,
        criteria: question.options,
      };
    }
    return { type: "score", instructions: question.instructions, criteria: question.levels };
  }

  /** A result built from Jev's answer to the question. */
  protected _fromJev(
    question: ClassifierQuestion,
    answer: Record<string, unknown>,
  ): ClassifierResult {
    if (question instanceof YesNoQuestion) {
      return new YesNoResult({ probability: this._number(answer, "noul") });
    }
    if (question instanceof ChoiceQuestion) {
      const choice = String(answer.choice ?? "");
      if (!Object.hasOwn(question.options, choice)) {
        throw new ClassifierError(`Jev chose '${choice}', which is not an option`);
      }
      const probabilities = this._probabilities(answer, Object.keys(question.options));
      return new ChoiceResult({
        choice,
        probabilities,
        confidence: this._number(answer, "confidence"),
      });
    }
    // Jev keys level probabilities by position.
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

  /** The number Jev wrote under `key`, or a ClassifierError if it did not. */
  protected _number(answer: Record<string, unknown>, key: string): number {
    try {
      if (!Object.hasOwn(answer, key)) {
        throw new RangeError(key);
      }
      return toFloat(answer[key]);
    } catch (e) {
      rethrowIfCancelled(e);
      throw new ClassifierError(`Jev reply has no usable '${key}'`, { cause: e });
    }
  }

  /** The probability Jev wrote for each key, 0 for the ones it left out. */
  protected _probabilities(
    answer: Record<string, unknown>,
    keys: string[],
  ): Record<string, number> {
    // Python's `answer.get("probabilities") or {}`: an empty list is falsy too.
    const raw = answer.probabilities;
    const given = !raw || (Array.isArray(raw) && raw.length === 0) ? {} : raw;
    try {
      if (!isDict(given)) {
        throw new TypeError("probabilities is not an object");
      }
      return Object.fromEntries(
        keys.map((key) => [key, toFloat(Object.hasOwn(given, key) ? given[key] : 0.0)]),
      );
    } catch (e) {
      rethrowIfCancelled(e);
      throw new ClassifierError(`Jev reply has an unusable probability: ${(e as Error).message}`, {
        cause: e,
      });
    }
  }
}
