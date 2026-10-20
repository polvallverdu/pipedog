// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/classifiers/llm/classifier.py

/**
 * Classifier backed by any Pipecat LLM service.
 *
 * Every question about a state goes to the LLM in one out-of-pipeline call,
 * through the service's `runInference()`. The LLM is asked for one JSON
 * object with an answer per question, and the object is parsed into results.
 */

import { rethrowIfCancelled, TimeoutError, waitFor } from "@pipedog/asyncio";
import { LLMContext, type LLMContextMessage } from "../../processors/aggregators/llm_context.ts";
import { type LLMService, NotImplementedError } from "../../services/llm_service.ts";
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
} from "../base_classifier.ts";
import { bytesToBase64, isDict, toFloat } from "../http_client.ts";

export const DEFAULT_INSTRUCTIONS =
  "You are a classifier. Each message describes some input and asks one or " +
  "more questions about it. Every question has a name and says the shape its " +
  "answer must have. Reply with a single JSON object, and nothing else: one " +
  "key per question name, each holding that question's answer in the shape " +
  "asked for. Probabilities and confidences are numbers from 0 to 1. For " +
  'example, a yes or no question named "voicemail" is answered ' +
  '{"voicemail": {"probability": 0.97}}. A choice question named "department" ' +
  "with the options billing, support and sales is answered " +
  '{"department": {"choice": "billing", "probabilities": {"billing": 0.92, ' +
  '"support": 0.06, "sales": 0.02}}}. A score question named "mood" on a ' +
  "scale of three levels is answered with a probability per level, by position, " +
  '{"mood": {"probabilities": {"0": 0.1, "1": 0.7, "2": 0.2}}}. ' +
  "Several questions about one input get one object with an answer for each " +
  "of them.";

export interface LLMClassifierOptions extends BaseClassifierOptions {
  /** The LLM that answers the questions. */
  llm: LLMService;
  /**
   * System instructions for the LLM. The default asks for one JSON object
   * with an answer per question.
   */
  instructions?: string | null;
  /** Cap on the reply's length, for services that take one. */
  maxTokens?: number | null;
  /** Seconds to wait for the LLM's reply before giving up. Defaults to 10. */
  timeout?: number;
}

/** Python's `repr()` of a string. */
function strRepr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
}

/**
 * Answers questions by asking an LLM for a JSON object.
 *
 * The probabilities are whatever the LLM wrote, so they are not calibrated.
 * Any service that implements `runInference()` can back a classifier;
 * realtime services cannot. The reply's shape is enforced by the provider
 * where the service supports a reply schema, and otherwise asked for in the
 * prompt and parsed from the reply. Images go to the LLM with the questions,
 * so they need an LLM that can see them.
 *
 * @example
 * const classifier = new LLMClassifier({ llm: new OpenAILLMService({ model: "gpt-4o-mini" }) });
 * const results = await classifier.yesNo("Hi, you've reached Dana. Leave a message.", {
 *   voicemail: new YesNoQuestion({ instructions: "is this a voicemail greeting?" }),
 * });
 * results.voicemail.probability;
 */
export class LLMClassifier extends BaseClassifier {
  protected _llm: LLMService;
  protected _instructions: string;
  protected _maxTokens: number | null;
  protected _timeout: number;

  constructor(options: LLMClassifierOptions) {
    super(options);
    this._llm = options.llm;
    this._instructions = options.instructions || DEFAULT_INSTRUCTIONS;
    this._maxTokens = options.maxTokens ?? null;
    this._timeout = options.timeout ?? 10.0;
  }

  /** The LLM that answers the questions. */
  get llm(): LLMService {
    return this._llm;
  }

  /** The LLM service's model. */
  override get model(): string | null {
    const model = this._llm.settings.model;
    return typeof model === "string" ? model : null;
  }

  /** Whether questions can come with images; the LLM must be able to see them. */
  override get supportsImages(): boolean {
    return true;
  }

  /** Answer the questions in one LLM call. The call reports no token usage. */
  protected async _ask(
    state: ClassifierValue,
    questions: Readonly<Record<string, ClassifierQuestion>>,
    images: readonly ClassifierImage[] = [],
  ): Promise<[Record<string, ClassifierResult>, null]> {
    const context = new LLMContext({ messages: [this._message(state, questions, images)] });
    let reply: string | null;
    try {
      reply = await waitFor(
        () =>
          this._llm.runInference(context, {
            maxTokens: this._maxTokens,
            systemInstruction: this._instructions,
            responseSchema: this._schema(questions),
          }),
        this._timeout,
      );
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof NotImplementedError) {
        throw new ClassifierError(`${this._llm} cannot run a one-shot inference`, { cause: e });
      }
      if (e instanceof TimeoutError) {
        throw new ClassifierError(`${this._llm} did not answer within ${this._timeout}s`, {
          cause: e,
        });
      }
      throw new ClassifierError(
        `${this._llm} failed to answer: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
    let answers = this._parse(reply || "");
    const names = Object.keys(questions);
    if (names.length === 1 && !names.some((name) => Object.hasOwn(answers, name))) {
      // A lone answer often comes back without its name around it.
      answers = { [names[0] as string]: answers };
    }
    const results: Record<string, ClassifierResult> = {};
    for (const [name, question] of Object.entries(questions)) {
      const answer = answers[name];
      if (!isDict(answer)) {
        throw new ClassifierError(`the LLM gave no answer for '${name}'`);
      }
      results[name] = this._result(question, answer);
    }
    return [results, null];
  }

  /** The message the LLM answers: any images, then the state and the questions. */
  protected _message(
    state: ClassifierValue,
    questions: Readonly<Record<string, ClassifierQuestion>>,
    images: readonly ClassifierImage[],
  ): LLMContextMessage {
    const text = this._render(state, questions);
    if (images.length === 0) {
      return { role: "user", content: text } as LLMContextMessage;
    }
    const content: Record<string, unknown>[] = images.map((image) => ({
      type: "image_url",
      image_url: { url: this._dataUrl(image) },
    }));
    content.push({ type: "text", text });
    return { role: "user", content } as unknown as LLMContextMessage;
  }

  /** The image as a base64 data URL. */
  protected _dataUrl(image: ClassifierImage): string {
    return `data:${image.contentType};base64,${bytesToBase64(image.data)}`;
  }

  /** Write the state and the questions as the message the LLM answers. */
  protected _render(
    state: ClassifierValue,
    questions: Readonly<Record<string, ClassifierQuestion>>,
  ): string {
    const parts = [`Input:\n${this._text(state)}`];
    for (const [name, question] of Object.entries(questions)) {
      const lines = [`Question "${name}": ${this._text(question.instructions)}`];
      if (question instanceof YesNoQuestion) {
        if (question.yes !== null) {
          lines.push(`Yes means: ${this._text(question.yes)}`);
        }
        if (question.no !== null) {
          lines.push(`No means: ${this._text(question.no)}`);
        }
        lines.push('Answer shape: {"probability": <probability that the answer is yes>}');
      } else if (question instanceof ChoiceQuestion) {
        lines.push("Options:");
        for (const [option, description] of Object.entries(question.options)) {
          lines.push(
            description !== null ? `- ${option}: ${this._text(description)}` : `- ${option}`,
          );
        }
        lines.push(
          'Answer shape: {"choice": <the option that fits best>, ' +
            '"probabilities": {<a probability per option, summing to 1>}}',
        );
      } else {
        lines.push("Scale, lowest first:");
        question.levels.forEach((level, index) => {
          lines.push(`${index}: ${this._text(level)}`);
        });
        const positions = question.levels.map((_l, i) => `"${i}": <probability>`).join(", ");
        lines.push(
          `Answer shape: {"probabilities": {${positions}}}, one per level by position, summing to 1`,
        );
      }
      parts.push(lines.join("\n"));
    }
    const names = Object.keys(questions)
      .map((name) => `"${name}": <answer to "${name}">`)
      .join(", ");
    parts.push(`Reply with one JSON object of this shape: {${names}}`);
    return parts.join("\n\n");
  }

  /** The JSON schema of the reply: one answer per question, in its shape. */
  protected _schema(
    questions: Readonly<Record<string, ClassifierQuestion>>,
  ): Record<string, unknown> {
    const answers: Record<string, unknown> = {};
    for (const [name, question] of Object.entries(questions)) {
      if (question instanceof YesNoQuestion) {
        answers[name] = this._object({ probability: { type: "number" } });
      } else if (question instanceof ChoiceQuestion) {
        const options = Object.keys(question.options);
        answers[name] = this._object({
          choice: { type: "string", enum: options },
          probabilities: this._object(
            Object.fromEntries(options.map((o) => [o, { type: "number" }])),
          ),
        });
      } else {
        const positions = question.levels.map((_l, i) => String(i));
        answers[name] = this._object({
          probabilities: this._object(
            Object.fromEntries(positions.map((i) => [i, { type: "number" }])),
          ),
        });
      }
    }
    return this._object(answers);
  }

  /** A schema for an object with exactly these properties, all required. */
  protected _object(properties: Record<string, unknown>): Record<string, unknown> {
    return {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    };
  }

  /** The JSON object in the LLM's reply, fences and prose around it ignored. */
  protected _parse(reply: string): Record<string, unknown> {
    let text = reply.trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    if (fenced) {
      text = (fenced[1] ?? "").trim();
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) {
      throw new ClassifierError(`the LLM did not answer with a JSON object: ${strRepr(reply)}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(text.slice(start, end + 1));
    } catch (e) {
      rethrowIfCancelled(e);
      throw new ClassifierError(`the LLM's answer is not valid JSON: ${(e as Error).message}`, {
        cause: e,
      });
    }
    if (!isDict(data)) {
      throw new ClassifierError("the LLM's answer is not a JSON object");
    }
    return data;
  }

  /** A result built from the LLM's answer to the question. */
  protected _result(
    question: ClassifierQuestion,
    answer: Record<string, unknown>,
  ): ClassifierResult {
    if (question instanceof YesNoQuestion) {
      return new YesNoResult({ probability: this._unit(answer, "probability") });
    }
    if (question instanceof ChoiceQuestion) {
      const choice = String(answer.choice ?? "");
      if (!Object.hasOwn(question.options, choice)) {
        throw new ClassifierError(`the LLM chose '${choice}', which is not an option`);
      }
      const rawGiven = answer.probabilities;
      const given = isDict(rawGiven) ? rawGiven : {};
      const probabilities: Record<string, number> = {};
      for (const o of Object.keys(question.options)) {
        probabilities[o] = this._clamp(Object.hasOwn(given, o) ? given[o] : 0.0);
      }
      return new ChoiceResult({
        choice,
        probabilities,
        confidence: probabilities[choice] as number,
      });
    }
    // The LLM gives a probability per level, by position. The score is the
    // probability-weighted position and the confidence the largest share, as
    // with Jev; a distribution that does not sum to 1 is scaled to.
    const rawGiven = answer.probabilities;
    const given = isDict(rawGiven) ? rawGiven : {};
    let probabilities = question.levels.map((_l, i) =>
      this._clamp(Object.hasOwn(given, String(i)) ? given[String(i)] : 0.0),
    );
    const total = probabilities.reduce((a, b) => a + b, 0);
    if (total <= 0) {
      throw new ClassifierError("the LLM gave no probability for any level");
    }
    probabilities = probabilities.map((p) => p / total);
    return new ScoreResult({
      score: probabilities.reduce((sum, p, i) => sum + i * p, 0),
      levels: question.levels.map(
        (level, i) => new ScoreLevel({ level, probability: probabilities[i] as number }),
      ),
      confidence: Math.max(...probabilities),
    });
  }

  /** Text for the LLM: a string as is, structured data as JSON. */
  protected _text(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  /** The number the LLM wrote under `key`, or a ClassifierError if it did not. */
  protected _number(answer: Record<string, unknown>, key: string): number {
    try {
      if (!Object.hasOwn(answer, key)) {
        throw new RangeError(key);
      }
      return toFloat(answer[key]);
    } catch (e) {
      rethrowIfCancelled(e);
      throw new ClassifierError(`the LLM's answer has no usable '${key}'`, { cause: e });
    }
  }

  /** The number under `key` kept between 0 and 1, for probabilities and confidences. */
  protected _unit(answer: Record<string, unknown>, key: string): number {
    return this._clamp(this._number(answer, key));
  }

  /** A number the LLM wrote, kept between 0 and 1. */
  protected _clamp(value: unknown): number {
    try {
      const number = toFloat(value);
      // Python's max(0.0, nan) keeps 0.0.
      return Number.isNaN(number) ? 0.0 : Math.min(1.0, Math.max(0.0, number));
    } catch (e) {
      rethrowIfCancelled(e);
      return 0.0;
    }
  }
}
