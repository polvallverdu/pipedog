// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/classifiers/openai/decisions/client.py

/**
 * HTTP client for OpenAI's Decisions API.
 *
 * One `OpenAIDecisionsClient` holds one connection pool, adds the auth
 * header, retries when OpenAI is busy, and counts the tokens every request
 * used. Several `OpenAIDecisionsClassifier` instances can share one.
 *
 * PORTING NOTE: upstream uses `httpx` with HTTP/2 and a 240 s keep-alive;
 * here requests go through `fetch` (see `../../http_client.ts`), and
 * connection reuse is left to the runtime.
 */

import { Lock, rethrowIfCancelled, sleep } from "@pipedog/asyncio";
import { logger } from "../../../utils/logger.ts";
import { exponentialBackoffTime } from "../../../utils/network.ts";
import { ClassifierError } from "../../base_classifier.ts";
import { errorRepr, HttpClient, HttpError, type HttpResponse, isDict } from "../../http_client.ts";

/** OpenAI answers a request with this status when the caller is rate limited. */
const TOO_MANY_REQUESTS = 429;
/** OpenAI answers a request with this status when it is temporarily overloaded. */
const OVERLOADED = 503;

/** Where the API is served. */
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** The decision model to ask. */
export const DEFAULT_MODEL = "gpt-6-luna";
/** Seconds to wait for a reply before giving up. */
export const DEFAULT_TIMEOUT = 10.0;

export interface OpenAIDecisionsUsageOptions {
  /** Tokens sent. */
  inputTokens?: number;
  /** Tokens received. */
  outputTokens?: number;
}

/**
 * Tokens the Decisions API used: for one request, or over every request.
 *
 * `OpenAIDecisionsClient.usage` holds the total over every request.
 */
export class OpenAIDecisionsUsage {
  inputTokens: number;
  outputTokens: number;

  constructor(options: OpenAIDecisionsUsageOptions = {}) {
    this.inputTokens = options.inputTokens ?? 0;
    this.outputTokens = options.outputTokens ?? 0;
  }

  /** Build a usage from the API's wire format (`input_tokens`, `output_tokens`). */
  static fromDict(data: Record<string, unknown>): OpenAIDecisionsUsage {
    return new OpenAIDecisionsUsage({
      inputTokens: (data.input_tokens as number | undefined) ?? 0,
      outputTokens: (data.output_tokens as number | undefined) ?? 0,
    });
  }
}

export interface OpenAIDecisionsClientOptions {
  /** OpenAI API key. */
  apiKey: string;
  /**
   * Where the API is served, such as `https://eu.api.openai.com/v1` for data
   * residency in Europe.
   */
  baseUrl?: string;
  /** The decision model to ask. */
  model?: string;
  /** Seconds to wait for a reply before giving up. */
  timeout?: number;
  /** How many times to retry a request OpenAI refused because it was busy. */
  maxRetries?: number;
  /** The transport requests go through; the global `fetch` by default. */
  fetch?: typeof fetch;
}

/**
 * HTTP client for OpenAI's `decisions` endpoint.
 *
 * Many small requests can be in flight at the same time. Retries with
 * backoff when OpenAI answers 429 or 503. Counts the tokens every request
 * used in `usage`. Errors carry the reason OpenAI gave.
 *
 * `connect()` opens the connection ahead of the first question, and
 * `close()` releases it.
 */
export class OpenAIDecisionsClient {
  protected _model: string;
  protected _maxRetries: number;
  protected _usage = new OpenAIDecisionsUsage();
  protected _connected = false;
  protected _connectLock = new Lock();
  protected _http: HttpClient;

  constructor(options: OpenAIDecisionsClientOptions) {
    if (!options.apiKey) {
      throw new Error("OpenAIDecisionsClient needs an API key");
    }
    this._model = options.model ?? DEFAULT_MODEL;
    this._maxRetries = options.maxRetries ?? 3;
    this._http = new HttpClient({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      headers: { Authorization: `Bearer ${options.apiKey}` },
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      fetch: options.fetch,
    });
  }

  /** The decision model the questions go to. */
  get model(): string {
    return this._model;
  }

  /** Tokens used so far, over every request. */
  get usage(): OpenAIDecisionsUsage {
    return this._usage;
  }

  /**
   * Open the connection to OpenAI.
   *
   * Looks up the model, a cheap request that also checks the key and whether
   * it has access to the model. Connects once: a client shared by several
   * classifiers is asked by each of them, and only the first call sends
   * anything.
   *
   * @throws ClassifierError If OpenAI could not be reached or refused the request.
   */
  async connect(): Promise<void> {
    await this._connectLock.run(async () => {
      if (this._connected) {
        return;
      }
      let response: HttpResponse;
      try {
        response = await this._http.get(`/models/${this._model}`);
      } catch (e) {
        if (e instanceof HttpError) {
          throw new ClassifierError(`could not connect to OpenAI Decisions: ${e.message}`, {
            cause: e,
          });
        }
        throw e;
      }
      if (response.statusCode !== 200) {
        throw new ClassifierError(
          `OpenAI Decisions refused the connection: ${this._failure(response)}`,
        );
      }
      this._connected = true;
    });
  }

  /** Close the connection pool. */
  async close(): Promise<void> {
    this._connected = false;
    await this._http.aclose();
  }

  /**
   * Send questions about one state and return OpenAI's answers.
   *
   * @param state What the questions are about, as the request's `input`:
   *   text, or user messages.
   * @param questions The questions by name, each in OpenAI's own format: a
   *   `type` of `predicate`, `choice` or `score`, `instructions`, and
   *   `choices` or `levels`.
   * @returns The answers by the same names, in OpenAI's own format, and the
   *   tokens the request used.
   * @throws ClassifierError If OpenAI rejected the request, kept refusing it
   *   because it was busy, could not be reached, or left a question
   *   unanswered.
   */
  async ask(
    state: string | Record<string, unknown>[],
    questions: Readonly<Record<string, Record<string, unknown>>>,
  ): Promise<[Record<string, Record<string, unknown>>, OpenAIDecisionsUsage]> {
    const body = {
      model: this._model,
      input: state,
      questions: Object.entries(questions).map(([name, question]) => ({ name, ...question })),
    };
    let attempt = 0;
    while (true) {
      attempt += 1;
      let response: HttpResponse;
      try {
        response = await this._http.post("/decisions", { json: body });
      } catch (e) {
        if (e instanceof HttpError) {
          // Some errors, such as a timeout, carry no useful message.
          throw new ClassifierError(`OpenAI Decisions request failed: ${errorRepr(e)}`, {
            cause: e,
          });
        }
        throw e;
      }
      if (response.statusCode === TOO_MANY_REQUESTS || response.statusCode === OVERLOADED) {
        if (attempt > this._maxRetries) {
          throw new ClassifierError(
            `OpenAI Decisions is busy (${this._failure(response)}) after ${attempt} attempts`,
          );
        }
        const wait = exponentialBackoffTime(attempt, 0.25, 2.0, 0.25);
        logger.debug(`OpenAI Decisions answered ${response.statusCode}, retrying in ${wait}s`);
        await sleep(wait);
        continue;
      }
      if (response.statusCode !== 200) {
        throw new ClassifierError(
          `OpenAI Decisions rejected the request: ${this._failure(response)}`,
        );
      }
      let data: unknown;
      try {
        data = response.json();
      } catch (e) {
        rethrowIfCancelled(e);
        throw new ClassifierError(
          `OpenAI Decisions reply is not valid JSON: ${(e as Error).message}`,
          { cause: e },
        );
      }
      if (!isDict(data)) {
        throw new ClassifierError("OpenAI Decisions reply is not a JSON object");
      }
      const usage = data.usage;
      const requestUsage = isDict(usage)
        ? OpenAIDecisionsUsage.fromDict(usage)
        : new OpenAIDecisionsUsage();
      this._usage.inputTokens += requestUsage.inputTokens;
      this._usage.outputTokens += requestUsage.outputTokens;
      const answers = data.answers;
      if (!Array.isArray(answers)) {
        throw new ClassifierError("OpenAI Decisions reply has no answers");
      }
      // Answers come back as a list, each carrying its question's name.
      const byName = new Map<string, Record<string, unknown>>();
      for (const answer of answers) {
        if (isDict(answer) && typeof answer.name === "string") {
          byName.set(answer.name, answer);
        }
      }
      const missing = Object.keys(questions).filter((name) => !byName.has(name));
      if (missing.length > 0) {
        throw new ClassifierError(`OpenAI Decisions reply has no answer for ${missing.join(", ")}`);
      }
      const result: Record<string, Record<string, unknown>> = {};
      for (const name of Object.keys(questions)) {
        result[name] = byName.get(name) as Record<string, unknown>;
      }
      return [result, requestUsage];
    }
  }

  /** A failed response's HTTP status and the reason OpenAI gave. */
  protected _failure(response: HttpResponse): string {
    const status = `HTTP ${response.statusCode}`;
    let message: unknown;
    try {
      const data = response.json() as { error?: { message?: unknown } } | null;
      const error = isDict(data) ? data.error : undefined;
      if (!isDict(error) || !("message" in error)) {
        return status;
      }
      message = error.message;
    } catch (e) {
      rethrowIfCancelled(e);
      return status;
    }
    return message ? `${status}: ${message}` : status;
  }
}
