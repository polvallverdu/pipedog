// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/classifiers/typesafe/jev/client.py

/**
 * HTTP client for Jev, TypeSafe's hosted classification model.
 *
 * One `JevClient` holds one connection pool, adds the auth header, retries
 * when Jev is busy, and counts the tokens every request used. Several
 * `JevClassifier` instances can share one.
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

/** Jev answers a request with this status when the caller is rate limited. */
const TOO_MANY_REQUESTS = 429;
/** Jev answers a request with this status when it is temporarily overloaded. */
const OVERLOADED = 529;
/** Jev reads images only in requests that send this header. */
const IMAGES_HEADER = "TypeSafe-Danger-Zone-Images";

/** Where the API is served. */
export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
/** The Jev model to ask. Pinned so thresholds tuned against it hold. */
export const DEFAULT_MODEL = "jev-1.13.0";
/** Seconds to wait for a reply before giving up. */
export const DEFAULT_TIMEOUT = 10.0;

export interface JevUsageOptions {
  /** Tokens sent. */
  inputTokens?: number;
  /** Tokens received. */
  outputTokens?: number;
}

/** Tokens Jev used: for one request, or over every request in `JevClient.usage`. */
export class JevUsage {
  inputTokens: number;
  outputTokens: number;

  constructor(options: JevUsageOptions = {}) {
    this.inputTokens = options.inputTokens ?? 0;
    this.outputTokens = options.outputTokens ?? 0;
  }

  /** Build a usage from Jev's wire format (`input_tokens`, `output_tokens`). */
  static fromDict(data: Record<string, unknown>): JevUsage {
    return new JevUsage({
      inputTokens: (data.input_tokens as number | undefined) ?? 0,
      outputTokens: (data.output_tokens as number | undefined) ?? 0,
    });
  }
}

export interface JevClientOptions {
  /** Jev API key. */
  apiKey: string;
  /** Where the API is served. */
  baseUrl?: string;
  /**
   * The Jev model to ask. Pinned so thresholds tuned against it keep
   * holding; `jev-latest` follows TypeSafe's newest release.
   */
  model?: string;
  /** Seconds to wait for a reply before giving up. */
  timeout?: number;
  /** How many times to retry a request Jev refused because it was busy. */
  maxRetries?: number;
  /** The transport requests go through; the global `fetch` by default. */
  fetch?: typeof fetch;
}

/**
 * HTTP client for Jev's `systemone` endpoint.
 *
 * Many small requests can be in flight at the same time. Retries with
 * backoff when Jev answers 429 or 529. Counts the tokens every request used
 * in `usage`.
 *
 * `connect()` opens the connection ahead of the first question, and
 * `close()` releases it.
 */
export class JevClient {
  protected _model: string;
  protected _maxRetries: number;
  protected _usage = new JevUsage();
  protected _connected = false;
  protected _connectLock = new Lock();
  protected _http: HttpClient;

  constructor(options: JevClientOptions) {
    if (!options.apiKey) {
      throw new Error("JevClient needs an API key");
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

  /** The Jev model the questions go to. */
  get model(): string {
    return this._model;
  }

  /** Tokens used so far, over every request. */
  get usage(): JevUsage {
    return this._usage;
  }

  /**
   * Open the connection to Jev.
   *
   * Lists the models, the cheapest request there is, so the first question
   * finds the connection already open. Connects once: a client shared by
   * several classifiers is asked by each of them, and only the first call
   * sends anything.
   *
   * @throws ClassifierError If Jev could not be reached or refused the request.
   */
  async connect(): Promise<void> {
    await this._connectLock.run(async () => {
      if (this._connected) {
        return;
      }
      let response: HttpResponse;
      try {
        response = await this._http.get("/v1/models");
      } catch (e) {
        if (e instanceof HttpError) {
          throw new ClassifierError(`could not connect to Jev: ${e.message}`, { cause: e });
        }
        throw e;
      }
      if (response.statusCode !== 200) {
        throw new ClassifierError(`Jev refused the connection: HTTP ${response.statusCode}`);
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
   * Send questions about one state and return Jev's answers.
   *
   * @param state What the questions are about.
   * @param questions The questions by name, each in Jev's own format: a
   *   `type` of `noul`, `choice` or `score`, `instructions`, and `criteria`.
   * @param assets Images by reference, each in Jev's own format: a `format`
   *   and the `data_base64` bytes. Each reference must appear in the state or
   *   the questions, where Jev reads the image in its place.
   * @returns The answers by the same names, in Jev's own format, and the
   *   tokens the request used.
   * @throws ClassifierError If Jev rejected the request, kept refusing it
   *   because it was busy, could not be reached, or left a question
   *   unanswered.
   */
  async ask(
    state: unknown,
    questions: Readonly<Record<string, Record<string, unknown>>>,
    assets: Readonly<Record<string, Record<string, unknown>>> | null = null,
  ): Promise<[Record<string, Record<string, unknown>>, JevUsage]> {
    const body: Record<string, unknown> = {
      model: this._model,
      state,
      questions: { ...questions },
    };
    const headers: Record<string, string> = {};
    if (assets && Object.keys(assets).length > 0) {
      body.assets = { ...assets };
      headers[IMAGES_HEADER] = "true";
    }
    let attempt = 0;
    while (true) {
      attempt += 1;
      let response: HttpResponse;
      try {
        response = await this._http.post("/v1/systemone", { json: body, headers });
      } catch (e) {
        if (e instanceof HttpError) {
          // Some errors, such as a timeout, carry no useful message.
          throw new ClassifierError(`Jev request failed: ${errorRepr(e)}`, { cause: e });
        }
        throw e;
      }
      if (response.statusCode === TOO_MANY_REQUESTS || response.statusCode === OVERLOADED) {
        if (attempt > this._maxRetries) {
          throw new ClassifierError(
            `Jev is busy (HTTP ${response.statusCode}) after ${attempt} attempts`,
          );
        }
        const wait = exponentialBackoffTime(attempt, 0.25, 2.0, 0.25);
        logger.debug(`Jev answered ${response.statusCode}, retrying in ${wait}s`);
        await sleep(wait);
        continue;
      }
      if (response.statusCode !== 200) {
        let message = `Jev rejected the request: HTTP ${response.statusCode}`;
        const reason = this._errorMessage(response);
        if (reason) {
          message += `: ${reason}`;
        }
        throw new ClassifierError(message);
      }
      let data: unknown;
      try {
        data = response.json();
      } catch (e) {
        rethrowIfCancelled(e);
        throw new ClassifierError(`Jev reply is not valid JSON: ${(e as Error).message}`, {
          cause: e,
        });
      }
      if (!isDict(data)) {
        throw new ClassifierError("Jev reply is not a JSON object");
      }
      const usage = data.usage;
      const requestUsage = isDict(usage) ? JevUsage.fromDict(usage) : new JevUsage();
      this._usage.inputTokens += requestUsage.inputTokens;
      this._usage.outputTokens += requestUsage.outputTokens;
      const answers = data.answers;
      if (!isDict(answers)) {
        throw new ClassifierError("Jev reply has no answers");
      }
      const missing = Object.keys(questions).filter((name) => !isDict(answers[name]));
      if (missing.length > 0) {
        throw new ClassifierError(`Jev reply has no answer for ${missing.join(", ")}`);
      }
      const result: Record<string, Record<string, unknown>> = {};
      for (const name of Object.keys(questions)) {
        result[name] = answers[name] as Record<string, unknown>;
      }
      return [result, requestUsage];
    }
  }

  /** The reason Jev gave for rejecting a request, if it gave one. */
  protected _errorMessage(response: HttpResponse): string | null {
    let detail: unknown;
    try {
      const data = response.json();
      if (!isDict(data)) {
        return null;
      }
      detail = data.detail;
    } catch (e) {
      rethrowIfCancelled(e);
      return null;
    }
    if (isDict(detail)) {
      detail = detail.message;
    }
    return typeof detail === "string" && detail ? detail : null;
  }
}
