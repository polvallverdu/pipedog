// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/classifiers/cloudflare/clef/client.py

/**
 * HTTP client for Clef, Cloudflare's decision model on Workers AI.
 *
 * One `ClefClient` holds one connection pool, adds the auth header, retries
 * when Workers AI is busy, and counts the tokens every request used. Several
 * `ClefClassifier` instances can share one.
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

/** Workers AI answers a request with this status when it is out of capacity. */
const TOO_MANY_REQUESTS = 429;

/** Where Cloudflare's API is served. */
export const CLOUDFLARE_API_URL = "https://api.cloudflare.com/client/v4";
/** The Clef model to ask. */
export const DEFAULT_MODEL = "clef";
/** Seconds to wait for a reply before giving up. */
export const DEFAULT_TIMEOUT = 10.0;

export interface ClefUsageOptions {
  /** Tokens sent. */
  inputTokens?: number;
  /** Tokens received. */
  outputTokens?: number;
}

/** Tokens Clef used: for one request, or over every request in `ClefClient.usage`. */
export class ClefUsage {
  inputTokens: number;
  outputTokens: number;

  constructor(options: ClefUsageOptions = {}) {
    this.inputTokens = options.inputTokens ?? 0;
    this.outputTokens = options.outputTokens ?? 0;
  }

  /** Build a usage from Clef's wire format (`input_tokens`, `output_tokens`). */
  static fromDict(data: Record<string, unknown>): ClefUsage {
    return new ClefUsage({
      inputTokens: (data.input_tokens as number | undefined) ?? 0,
      outputTokens: (data.output_tokens as number | undefined) ?? 0,
    });
  }
}

export interface ClefClientOptions {
  /** Cloudflare account ID. */
  accountId: string;
  /** Cloudflare API token with Workers AI access. */
  apiKey: string;
  /** The Clef model to ask: `clef`, or `clef-flash` for faster answers. */
  model?: string;
  /** Seconds to wait for a reply before giving up. */
  timeout?: number;
  /** How many times to retry a request Workers AI refused because it was busy. */
  maxRetries?: number;
  /** The transport requests go through; the global `fetch` by default. */
  fetch?: typeof fetch;
}

/**
 * HTTP client for Clef on Workers AI.
 *
 * Many small requests can be in flight at the same time. Retries with
 * backoff when Workers AI answers 429. Counts the tokens every request used
 * in `usage`. Errors carry the reasons Cloudflare gave.
 *
 * `connect()` opens the connection ahead of the first question, and
 * `close()` releases it.
 */
export class ClefClient {
  protected _model: string;
  protected _maxRetries: number;
  protected _usage = new ClefUsage();
  protected _connected = false;
  protected _connectLock = new Lock();
  protected _http: HttpClient;

  constructor(options: ClefClientOptions) {
    if (!options.accountId) {
      throw new Error("ClefClient needs a Cloudflare account ID");
    }
    if (!options.apiKey) {
      throw new Error("ClefClient needs a Cloudflare API token");
    }
    this._model = options.model ?? DEFAULT_MODEL;
    this._maxRetries = options.maxRetries ?? 3;
    this._http = new HttpClient({
      baseUrl: `${CLOUDFLARE_API_URL}/accounts/${options.accountId}/ai`,
      headers: { Authorization: `Bearer ${options.apiKey}` },
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      fetch: options.fetch,
    });
  }

  /** The Clef model the questions go to. */
  get model(): string {
    return this._model;
  }

  /** Tokens used so far, over every request. */
  get usage(): ClefUsage {
    return this._usage;
  }

  /**
   * Open the connection to Workers AI.
   *
   * Asks for the model's schema, a cheap request that also checks the token
   * and the model name. Connects once: a client shared by several
   * classifiers is asked by each of them, and only the first call sends
   * anything.
   *
   * @throws ClassifierError If Workers AI could not be reached or refused the
   *   request.
   */
  async connect(): Promise<void> {
    await this._connectLock.run(async () => {
      if (this._connected) {
        return;
      }
      let response: HttpResponse;
      try {
        response = await this._http.get("/models/schema", {
          params: { model: `@cf/cloudflare/${this._model}` },
        });
      } catch (e) {
        if (e instanceof HttpError) {
          throw new ClassifierError(`could not connect to Clef: ${e.message}`, { cause: e });
        }
        throw e;
      }
      if (response.statusCode !== 200) {
        throw new ClassifierError(`Clef refused the connection: ${this._failure(response)}`);
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
   * Send questions about one state and return Clef's answers.
   *
   * @param state What the questions are about.
   * @param questions The questions by name, each in Clef's own format: a
   *   `type` of `noul`, `choice` or `score`, `instructions`, and `criteria`.
   * @param images Images the questions can look at, each in Clef's own
   *   format: a `content_type` and the `base64` bytes.
   * @returns The answers by the same names, in Clef's own format, and the
   *   tokens the request used.
   * @throws ClassifierError If Clef rejected the request, kept refusing it
   *   because it was busy, could not be reached, or left a question
   *   unanswered.
   */
  async ask(
    state: unknown,
    questions: Readonly<Record<string, Record<string, unknown>>>,
    images: readonly Readonly<Record<string, string>>[] = [],
  ): Promise<[Record<string, Record<string, unknown>>, ClefUsage]> {
    const body: Record<string, unknown> = {
      model: this._model,
      state,
      questions: { ...questions },
    };
    if (images.length > 0) {
      body.images = images.map((image) => ({ ...image }));
    }
    let attempt = 0;
    while (true) {
      attempt += 1;
      let response: HttpResponse;
      try {
        response = await this._http.post(`/run/@cf/cloudflare/${this._model}`, { json: body });
      } catch (e) {
        if (e instanceof HttpError) {
          // Some errors, such as a timeout, carry no useful message.
          throw new ClassifierError(`Clef request failed: ${errorRepr(e)}`, { cause: e });
        }
        throw e;
      }
      if (response.statusCode === TOO_MANY_REQUESTS) {
        if (attempt > this._maxRetries) {
          throw new ClassifierError(
            `Clef is busy (${this._failure(response)}) after ${attempt} attempts`,
          );
        }
        const wait = exponentialBackoffTime(attempt, 0.25, 2.0, 0.25);
        logger.debug(`Clef answered ${response.statusCode}, retrying in ${wait}s`);
        await sleep(wait);
        continue;
      }
      if (response.statusCode !== 200) {
        throw new ClassifierError(`Clef rejected the request: ${this._failure(response)}`);
      }
      const result = this._result(response);
      const usage = result.usage;
      const requestUsage = isDict(usage) ? ClefUsage.fromDict(usage) : new ClefUsage();
      this._usage.inputTokens += requestUsage.inputTokens;
      this._usage.outputTokens += requestUsage.outputTokens;
      const answers = result.answers;
      if (!isDict(answers)) {
        throw new ClassifierError("Clef reply has no answers");
      }
      const missing = Object.keys(questions).filter((name) => !isDict(answers[name]));
      if (missing.length > 0) {
        throw new ClassifierError(`Clef reply has no answer for ${missing.join(", ")}`);
      }
      const answered: Record<string, Record<string, unknown>> = {};
      for (const name of Object.keys(questions)) {
        answered[name] = answers[name] as Record<string, unknown>;
      }
      return [answered, requestUsage];
    }
  }

  /** The reply inside Cloudflare's `result` envelope. */
  protected _result(response: HttpResponse): Record<string, unknown> {
    let data: unknown;
    try {
      data = response.json();
    } catch (e) {
      rethrowIfCancelled(e);
      throw new ClassifierError(`Clef reply is not valid JSON: ${(e as Error).message}`, {
        cause: e,
      });
    }
    const result = isDict(data) ? data.result : null;
    if (!isDict(result)) {
      throw new ClassifierError("Clef reply has no result");
    }
    return result;
  }

  /** A failed response's HTTP status and the reasons Cloudflare gave. */
  protected _failure(response: HttpResponse): string {
    const status = `HTTP ${response.statusCode}`;
    let errors: unknown;
    try {
      const data = response.json();
      if (!isDict(data)) {
        return status;
      }
      errors = data.errors;
    } catch (e) {
      rethrowIfCancelled(e);
      return status;
    }
    const reasons = (Array.isArray(errors) ? errors : [])
      .filter((error) => isDict(error) && error.message)
      .map((error) => String((error as Record<string, unknown>).message));
    return reasons.length > 0 ? `${status}: ${reasons.join("; ")}` : status;
  }
}
