// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/classifiers/base_classifier.py

/**
 * Classifiers answer typed questions about some state.
 *
 * A classifier is a plain object. Whoever needs answers creates one, keeps
 * it, and calls it. It does not sit in a pipeline and no frames flow into it.
 * A question is one of `YesNoQuestion`, `ChoiceQuestion` or `ScoreQuestion`.
 * Questions are asked by name, several about one state at once:
 * `BaseClassifier.ask()` takes any mix of kinds, and
 * `BaseClassifier.yesNo()`, `BaseClassifier.choice()` and
 * `BaseClassifier.score()` take questions of one kind and return typed
 * results. Classifiers that can see images take `ClassifierImage` alongside
 * the state.
 */

import { monotonic } from "@pipecat-ts/asyncio";
import type { ImageRawFrame } from "../frames/frames.ts";
import {
  type LLMTokenUsage,
  LLMUsageMetricsData,
  type MetricsData,
  ProcessingMetricsData,
} from "../metrics/metrics.ts";
import { BaseObject, type BaseObjectOptions } from "../utils/base_object.ts";
import { encodeImage } from "../utils/image.ts";

/** A classifier could not answer a question. */
export class ClassifierError extends Error {
  override name = "ClassifierError";
}

/** What a question, or the state it is about, can be: text or structured data. */
export type ClassifierValue = string | Record<string, unknown> | unknown[];

export interface YesNoQuestionOptions {
  /**
   * What is being checked for, as a yes or no question. Text, or structured
   * data holding the question in one field and what it refers to in others.
   */
  instructions: ClassifierValue;
  /** What counts as a yes, when the question alone leaves it open. */
  yes?: ClassifierValue | null;
  /** What counts as a no. */
  no?: ClassifierValue | null;
}

/** Whether the state meets a condition. */
export class YesNoQuestion {
  instructions: ClassifierValue;
  yes: ClassifierValue | null;
  no: ClassifierValue | null;

  constructor(options: YesNoQuestionOptions) {
    this.instructions = options.instructions;
    this.yes = options.yes ?? null;
    this.no = options.no ?? null;
  }
}

export interface ChoiceQuestionOptions {
  /** What is being decided. */
  instructions: ClassifierValue;
  /**
   * The options to choose from, each mapped to a description of when it
   * applies, or `null` when the option itself says enough.
   */
  options: Record<string, ClassifierValue | null>;
}

/** Which of several options fits the state. */
export class ChoiceQuestion {
  instructions: ClassifierValue;
  options: Record<string, ClassifierValue | null>;

  constructor(options: ChoiceQuestionOptions) {
    this.instructions = options.instructions;
    this.options = options.options;
  }
}

export interface ScoreQuestionOptions {
  /** What is being rated. */
  instructions: ClassifierValue;
  /**
   * The levels of the scale in order, lowest first, each described in a few
   * words or as structured data. At least two.
   */
  levels: ClassifierValue[];
}

/** Where the state falls on an ordered scale. */
export class ScoreQuestion {
  instructions: ClassifierValue;
  levels: ClassifierValue[];

  constructor(options: ScoreQuestionOptions) {
    if (options.levels.length < 2) {
      throw new Error("ScoreQuestion levels should have at least 2 items");
    }
    this.instructions = options.instructions;
    this.levels = options.levels;
  }
}

export type ClassifierQuestion = YesNoQuestion | ChoiceQuestion | ScoreQuestion;

/** The image types every classifier that sees images accepts. */
export type ClassifierImageType = "image/png" | "image/jpeg" | "image/webp";

export interface ClassifierImageOptions {
  /** The encoded image: PNG, JPEG or WebP. */
  data: Uint8Array;
  /** The image's MIME type, read from `data` when not given. */
  contentType?: ClassifierImageType;
}

/** An encoded image the questions can look at, alongside the state. */
export class ClassifierImage {
  data: Uint8Array;
  contentType: ClassifierImageType;

  constructor(options: ClassifierImageOptions) {
    const contentType = options.contentType;
    // Upstream's pydantic Literal rejects any other given type.
    if (
      contentType != null &&
      contentType !== "image/png" &&
      contentType !== "image/jpeg" &&
      contentType !== "image/webp"
    ) {
      throw new Error(`ClassifierImage takes PNG, JPEG or WebP, got ${contentType}`);
    }
    this.data = options.data;
    this.contentType = contentType ?? ClassifierImage._contentType(options.data);
  }

  /**
   * Build an image from an image frame, such as a frame from the user's camera.
   *
   * Raw pixels are encoded as a JPEG. A frame whose format is already a MIME
   * type keeps its bytes.
   *
   * @param frame The image frame.
   * @returns The image.
   */
  static async fromFrame(frame: ImageRawFrame): Promise<ClassifierImage> {
    const [data, contentType] = await encodeImage(frame.image, frame.size, frame.format);
    return new ClassifierImage({ data, contentType: contentType as ClassifierImageType });
  }

  /**
   * The MIME type of the encoded image, or an error if it is not one
   * classifiers take.
   *
   * PORTING NOTE: upstream opens the image with Pillow; this reads the
   * format's signature bytes instead.
   */
  protected static _contentType(data: Uint8Array): ClassifierImageType {
    const contentType = sniffImageType(data);
    if (contentType === null) {
      throw new Error("ClassifierImage data is not an image");
    }
    if (
      contentType !== "image/png" &&
      contentType !== "image/jpeg" &&
      contentType !== "image/webp"
    ) {
      throw new Error(`ClassifierImage takes PNG, JPEG or WebP, got ${contentType}`);
    }
    return contentType;
  }

  toString(): string {
    return `ClassifierImage(content_type='${this.contentType}')`;
  }
}

function startsWith(data: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (data.length < offset + signature.length) {
    return false;
  }
  return signature.every((b, i) => data[offset + i] === b);
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** The MIME type of an encoded image read from its signature, or null if unknown. */
function sniffImageType(data: Uint8Array): string | null {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(data, ascii("RIFF")) && startsWith(data, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(data, ascii("GIF87a")) || startsWith(data, ascii("GIF89a"))) return "image/gif";
  if (startsWith(data, ascii("BM"))) return "image/bmp";
  if (startsWith(data, [0x49, 0x49, 0x2a, 0x00]) || startsWith(data, [0x4d, 0x4d, 0x00, 0x2a])) {
    return "image/tiff";
  }
  if (startsWith(data, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  return null;
}

export interface YesNoResultOptions {
  /** How likely the answer is yes, from 0 to 1. */
  probability: number;
}

/** Answer to a `YesNoQuestion`. */
export class YesNoResult {
  probability: number;

  constructor(options: YesNoResultOptions) {
    this.probability = options.probability;
  }

  /**
   * Whether yes is the likelier answer.
   *
   * Callers that need more certainty than that compare `probability` with a
   * threshold of their own.
   */
  get isYes(): boolean {
    return this.probability >= 0.5;
  }
}

export interface ChoiceResultOptions {
  /** The option that fits best. */
  choice: string;
  /** How likely each option is, keyed by option. */
  probabilities: Record<string, number>;
  /** How sure the classifier is of `choice`, from 0 to 1. */
  confidence: number;
}

/** Answer to a `ChoiceQuestion`. */
export class ChoiceResult {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;

  constructor(options: ChoiceResultOptions) {
    this.choice = options.choice;
    this.probabilities = options.probabilities;
    this.confidence = options.confidence;
  }
}

export interface ScoreLevelOptions {
  /** The level as the question gave it. */
  level: ClassifierValue;
  /** How likely the state is at this level, from 0 to 1. */
  probability: number;
}

/** One level of a `ScoreQuestion`'s scale and how likely it is. */
export class ScoreLevel {
  level: ClassifierValue;
  probability: number;

  constructor(options: ScoreLevelOptions) {
    this.level = options.level;
    this.probability = options.probability;
  }
}

export interface ScoreResultOptions {
  /**
   * Where the state falls on the scale, as a position from 0 (the first
   * level) to one less than the number of levels. It is the
   * probability-weighted position, so it may fall between two levels.
   */
  score: number;
  /** How likely each level is, in the question's order. */
  levels: ScoreLevel[];
  /** How sure the classifier is of `score`, from 0 to 1. */
  confidence: number;
}

/** Answer to a `ScoreQuestion`. */
export class ScoreResult {
  score: number;
  levels: ScoreLevel[];
  confidence: number;

  constructor(options: ScoreResultOptions) {
    this.score = options.score;
    this.levels = options.levels;
    this.confidence = options.confidence;
  }

  /**
   * How likely one level is.
   *
   * @param level The level as the question gave it.
   * @returns The level's probability.
   * @throws Error If the scale has no such level (upstream's KeyError).
   */
  probability(level: ClassifierValue): number {
    for (const item of this.levels) {
      if (deepEqual(item.level, level)) {
        return item.probability;
      }
    }
    throw new Error(`not a level of this scale: ${JSON.stringify(level)}`);
  }
}

/** Python `==` on JSON-like values: dicts compare regardless of key order. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => deepEqual(v, b[i]))
    );
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every(
        (k) =>
          Object.hasOwn(b, k) &&
          deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return false;
}

export type ClassifierResult = YesNoResult | ChoiceResult | ScoreResult;

/** Options for the questions-asking methods. */
export interface ClassifierAskOptions {
  /** Images the questions can look at, for a classifier that supports them. */
  images?: readonly ClassifierImage[] | null;
}

export type BaseClassifierOptions = BaseObjectOptions;

/**
 * Answers typed questions about a state.
 *
 * Every question is about a `state`: plain text, or structured data such as
 * a transcript with speaker labels or a trimmed screen snapshot. `ask()`
 * answers any number of questions about one state, by name; the three typed
 * methods are built on it and take questions of one kind. Subclasses
 * implement `_ask()`.
 *
 * Classifiers that can see images say so in `supportsImages`, and then take
 * `images` with the state. The others refuse them.
 *
 * An owner that runs inside a worker calls `setup()` with its task manager
 * before the first question, and `cleanup()` when it is done.
 *
 * Event handlers available:
 *
 * - on_metrics: Called after every call with its metrics, the time it took
 *   and, when the classifier knows it, the tokens it used. A classifier
 *   cannot push frames, so the owner is the one to put them in a
 *   `MetricsFrame`.
 *
 * @example
 * await this._classifier.setup(this.taskManager);
 *
 * this._classifier.eventHandler("on_metrics", async (classifier, data: MetricsData[]) => {
 *   await this.pushFrame(new MetricsFrame({ data }));
 * });
 */
export abstract class BaseClassifier extends BaseObject {
  constructor(options: BaseClassifierOptions = {}) {
    super(options);

    this._registerEventHandler("on_metrics");
  }

  /** The model that answers, named in the metrics. */
  get model(): string | null {
    return null;
  }

  /** Whether questions can come with images. */
  get supportsImages(): boolean {
    return false;
  }

  /**
   * Answer several questions about one state.
   *
   * @param state What the questions are about.
   * @param questions The questions, by name.
   * @param options Images the questions can look at, for a classifier that
   *   supports them.
   * @returns One result per question, by the same names, each of the type
   *   its question calls for.
   * @throws ClassifierError If the answers could not be produced, or not in
   *   time: every classifier answers or raises within a bound of its own, so
   *   a caller waiting on it is never left hanging. Also if images come to a
   *   classifier that cannot see them.
   */
  async ask(
    state: ClassifierValue,
    questions: Readonly<Record<string, ClassifierQuestion>>,
    options: ClassifierAskOptions = {},
  ): Promise<Record<string, ClassifierResult>> {
    const images = options.images;
    if (images && images.length > 0 && !this.supportsImages) {
      throw new ClassifierError(`${this} cannot see images`);
    }
    const started = monotonic();
    const [results, usage] = await this._ask(state, questions, [...(images ?? [])]);
    await this._callEventHandler("on_metrics", this._metrics(monotonic() - started, usage));
    return results;
  }

  /**
   * Ask whether the state meets each condition.
   *
   * @param state What the questions are about.
   * @param questions The questions, by name.
   * @param options Images the questions can look at, for a classifier that
   *   supports them.
   * @returns How likely each answer is yes, by the same names.
   * @throws ClassifierError If the answers could not be produced.
   */
  async yesNo(
    state: ClassifierValue,
    questions: Readonly<Record<string, YesNoQuestion>>,
    options: ClassifierAskOptions = {},
  ): Promise<Record<string, YesNoResult>> {
    return this._typed(await this.ask(state, questions, options), YesNoResult);
  }

  /**
   * Ask which option fits the state, for each question.
   *
   * @param state What the questions are about.
   * @param questions The questions, by name.
   * @param options Images the questions can look at, for a classifier that
   *   supports them.
   * @returns The option that fits and how likely each one is, by the same
   *   names.
   * @throws ClassifierError If the answers could not be produced.
   */
  async choice(
    state: ClassifierValue,
    questions: Readonly<Record<string, ChoiceQuestion>>,
    options: ClassifierAskOptions = {},
  ): Promise<Record<string, ChoiceResult>> {
    return this._typed(await this.ask(state, questions, options), ChoiceResult);
  }

  /**
   * Ask where the state falls on each scale.
   *
   * @param state What the questions are about.
   * @param questions The questions, by name.
   * @param options Images the questions can look at, for a classifier that
   *   supports them.
   * @returns The position on each scale and how likely each level is, by
   *   the same names.
   * @throws ClassifierError If the answers could not be produced.
   */
  async score(
    state: ClassifierValue,
    questions: Readonly<Record<string, ScoreQuestion>>,
    options: ClassifierAskOptions = {},
  ): Promise<Record<string, ScoreResult>> {
    return this._typed(await this.ask(state, questions, options), ScoreResult);
  }

  /**
   * Answer the questions, and say what tokens the call used if that is known.
   *
   * `images` is always empty for a classifier that does not support images.
   */
  protected abstract _ask(
    state: ClassifierValue,
    questions: Readonly<Record<string, ClassifierQuestion>>,
    images?: readonly ClassifierImage[],
  ): Promise<[Record<string, ClassifierResult>, LLMTokenUsage | null]>;

  protected _metrics(seconds: number, usage: LLMTokenUsage | null): MetricsData[] {
    const data: MetricsData[] = [
      new ProcessingMetricsData({ processor: this.name, model: this.model, value: seconds }),
    ];
    if (usage) {
      data.push(new LLMUsageMetricsData({ processor: this.name, model: this.model, value: usage }));
    }
    return data;
  }

  protected _typed<R extends ClassifierResult>(
    results: Record<string, ClassifierResult>,
    resultType: new (...args: never[]) => R,
  ): Record<string, R> {
    const typed: Record<string, R> = {};
    for (const [name, result] of Object.entries(results)) {
      if (!(result instanceof resultType)) {
        throw new ClassifierError(
          `expected a ${resultType.name} for '${name}', got ${(result as object).constructor.name}`,
        );
      }
      typed[name] = result;
    }
    return typed;
  }
}
