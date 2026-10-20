// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/classifiers/cloudflare/clef/classifier.py

/**
 * Classifier backed by Clef, Cloudflare's decision model on Workers AI.
 *
 * `ClefClassifier` turns each question into a request and each reply into a
 * result, through a `ClefClient`.
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
import { ClefClient, DEFAULT_MODEL, DEFAULT_TIMEOUT } from "./client.ts";

/** The most options Clef takes in one choice question. */
export const CLEF_MAX_CHOICE_OPTIONS = 255;
/** The most images Clef takes in one request. */
export const CLEF_MAX_IMAGES = 4;

export interface ClefClassifierOptions extends BaseClassifierOptions {
  /** Cloudflare account ID, when the classifier should have a client of its own. */
  accountId?: string | null;
  /** Cloudflare API token, when the classifier should have a client of its own. */
  apiKey?: string | null;
  /** A client to share. Either `client`, or both `accountId` and `apiKey`, are required. */
  client?: ClefClient | null;
  /** The Clef model a client of its own asks: `clef`, or `clef-flash` for faster answers. */
  model?: string;
  /** Seconds a client of its own waits for an answer. */
  timeout?: number;
}

/**
 * Answers questions by asking Clef.
 *
 * Build one with a Cloudflare account ID and API token to get a client of
 * its own, or pass a `ClefClient` to share one between several classifiers.
 * A client the classifier created is closed in `cleanup()`; a shared one is
 * left to whoever made it.
 *
 * Clef can see images: up to `CLEF_MAX_IMAGES` per call, 4 MiB each and
 * 8 MiB in all.
 *
 * @example
 * const classifier = new ClefClassifier({
 *   accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
 *   apiKey: process.env.CLOUDFLARE_API_KEY,
 * });
 */
export class ClefClassifier extends BaseClassifier {
  protected _ownsClient: boolean;
  protected _client: ClefClient;

  constructor(options: ClefClassifierOptions = {}) {
    super(options);
    this._ownsClient = options.client == null;
    let client = options.client ?? null;
    if (!client) {
      if (!options.accountId || !options.apiKey) {
        throw new Error("ClefClassifier needs an account ID and API key, or a ClefClient");
      }
      client = new ClefClient({
        accountId: options.accountId,
        apiKey: options.apiKey,
        model: options.model ?? DEFAULT_MODEL,
        timeout: options.timeout ?? DEFAULT_TIMEOUT,
      });
    }
    this._client = client;
  }

  /** The client this classifier asks through. */
  get client(): ClefClient {
    return this._client;
  }

  /**
   * Open the connection to Workers AI ahead of the first question.
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

  /** The Clef model the questions go to. */
  override get model(): string {
    return this._client.model;
  }

  /** Clef can see images. */
  override get supportsImages(): boolean {
    return true;
  }

  /** Answer the questions in one request. */
  protected async _ask(
    state: ClassifierValue,
    questions: Readonly<Record<string, ClassifierQuestion>>,
    images: readonly ClassifierImage[] = [],
  ): Promise<[Record<string, ClassifierResult>, LLMTokenUsage]> {
    if (images.length > CLEF_MAX_IMAGES) {
      throw new ClassifierError(
        `Clef takes at most ${CLEF_MAX_IMAGES} images, got ${images.length}`,
      );
    }
    const clefQuestions: Record<string, Record<string, unknown>> = {};
    for (const [name, q] of Object.entries(questions)) {
      clefQuestions[name] = this._toClef(q);
    }
    const [answers, usage] = await this._client.ask(
      state,
      clefQuestions,
      images.map((image) => ({
        content_type: image.contentType,
        base64: bytesToBase64(image.data),
      })),
    );
    const results: Record<string, ClassifierResult> = {};
    for (const [name, question] of Object.entries(questions)) {
      results[name] = this._fromClef(question, answers[name] as Record<string, unknown>);
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

  /** A question in Clef's own format. */
  protected _toClef(question: ClassifierQuestion): Record<string, unknown> {
    if (question instanceof YesNoQuestion) {
      const clef: Record<string, unknown> = { type: "noul", instructions: question.instructions };
      if (question.yes !== null || question.no !== null) {
        clef.criteria = { true: orEmpty(question.yes), false: orEmpty(question.no) };
      }
      return clef;
    }
    if (question instanceof ChoiceQuestion) {
      const count = Object.keys(question.options).length;
      if (count > CLEF_MAX_CHOICE_OPTIONS) {
        throw new ClassifierError(
          `Clef takes at most ${CLEF_MAX_CHOICE_OPTIONS} options, got ${count}`,
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

  /** A result built from Clef's answer to the question. */
  protected _fromClef(
    question: ClassifierQuestion,
    answer: Record<string, unknown>,
  ): ClassifierResult {
    if (question instanceof YesNoQuestion) {
      return new YesNoResult({ probability: this._number(answer, "noul") });
    }
    if (question instanceof ChoiceQuestion) {
      const choice = String(answer.choice ?? "");
      if (!Object.hasOwn(question.options, choice)) {
        throw new ClassifierError(`Clef chose '${choice}', which is not an option`);
      }
      const probabilities = this._probabilities(answer, Object.keys(question.options));
      return new ChoiceResult({
        choice,
        probabilities,
        confidence: this._number(answer, "confidence"),
      });
    }
    // Clef keys level probabilities by position.
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

  /** The number Clef wrote under `key`, or a ClassifierError if it did not. */
  protected _number(answer: Record<string, unknown>, key: string): number {
    try {
      if (!Object.hasOwn(answer, key)) {
        throw new RangeError(key);
      }
      return toFloat(answer[key]);
    } catch (e) {
      rethrowIfCancelled(e);
      throw new ClassifierError(`Clef reply has no usable '${key}'`, { cause: e });
    }
  }

  /** The probability Clef wrote for each key, 0 for the ones it left out. */
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
      throw new ClassifierError(`Clef reply has an unusable probability: ${(e as Error).message}`, {
        cause: e,
      });
    }
  }
}
