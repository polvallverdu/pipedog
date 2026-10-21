// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/aws/sagemaker/bidi_client.py

/**
 * AWS SageMaker bidirectional streaming client.
 *
 * This module provides a client for streaming bidirectional communication with
 * SageMaker endpoints using the HTTP/2 protocol. Supports sending audio, text,
 * and JSON data to SageMaker model endpoints and receiving streaming responses.
 *
 * Porting notes:
 * - DIVERGENCE: `InvokeEndpointWithBidirectionalStream` needs full-duplex
 *   HTTP/2, which `fetch` and `WebSocket` cannot provide. The default client
 *   is `@aws-sdk/client-sagemaker-runtime-http2` (an optional peer
 *   dependency), loaded lazily with `import()` the first time a session
 *   starts, so importing this module needs no SDK. The SDK sends through
 *   Node's `http2` module: Node.js 22+ and Bun. Deno and Cloudflare Workers
 *   are not supported by the default client. Any runtime works with a
 *   `client` of your own that implements `SageMakerRuntimeHTTP2ClientLike`.
 * - The SDK seam keeps the shape of upstream's Python SDK client:
 *   `invokeEndpointWithBidirectionalStream(input)` returns a stream with an
 *   `inputStream` (`send`, `close`) and `awaitOutput()`, whose output stream
 *   has `receive()` (`null` once closed). `SdkSageMakerRuntimeHTTP2Client`
 *   adapts the JS SDK to it.
 * - DIVERGENCE: events use the JS SDK's shapes. A request event is
 *   `{ PayloadPart: { Bytes, DataType } }` (upstream:
 *   `RequestStreamEventPayloadPart(value=RequestPayloadPart(bytes_=, data_type=))`)
 *   and `receiveResponse()` returns the JS SDK's `ResponseStreamEvent`
 *   (`{ PayloadPart: { Bytes, DataType, CompletionState } }`, or an error
 *   member), not `ResponseStreamEventPayloadPart(value=...)`.
 * - DIVERGENCE: credentials. Upstream's `EnvironmentCredentialsResolver` reads
 *   the `AWS_*` environment variables. Here the client takes explicit keys
 *   (`awsAccessKeyId`, `awsSecretAccessKey`, `awsSessionToken`), then the
 *   environment, then a `credentialsProvider` (see `aws_session.ts`); these
 *   options are pipedog additions.
 * - The JS SDK raises an unmodeled AWS error (e.g. `ThrottlingException`) as
 *   a service exception whose `name` is the error id and whose
 *   `$metadata.httpStatusCode` is the status, rather than a message to parse.
 *   `classifySagemakerBidiError` reads both forms, and also the JS SDK's
 *   `$retryable.throttling` flag (upstream's `is_throttling_error`) and
 *   `OriginalStatusCode` (upstream's `original_status_code`).
 * - `client` (a pipedog addition) injects the SDK client, replacing
 *   upstream's module-level `SageMakerRuntimeHTTP2Client`; `_connectBackoff`
 *   holds upstream's `_CONNECT_BACKOFF_*` constants as a mutable object so
 *   tests can shorten the backoff, as upstream's tests patch the constants.
 */

import { abortable, currentSignal, rethrowIfCancelled, sleep } from "@pipedog/asyncio";
import { classifyHttpException, ErrorCategory } from "@pipedog/core/utils/errors";
import { logger } from "@pipedog/core/utils/logger";
import { exponentialBackoffTime } from "@pipedog/core/utils/network";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { type AWSClientOptions, AWSSession } from "../aws_session.ts";

const SAGEMAKER_RUNTIME_HTTP2 = "@aws-sdk/client-sagemaker-runtime-http2";

/** A request payload part (the JS SDK's `RequestPayloadPart`). */
export interface RequestPayloadPart {
  Bytes?: Uint8Array;
  DataType?: string;
  CompletionState?: string;
  P?: string;
}

/** A request stream event (the JS SDK's `RequestStreamEvent`). */
export interface RequestStreamEvent {
  PayloadPart: RequestPayloadPart;
}

/** A response payload part (the JS SDK's `ResponsePayloadPart`). */
export interface ResponsePayloadPart {
  Bytes?: Uint8Array;
  DataType?: string;
  CompletionState?: string;
  P?: string;
}

/**
 * A response stream event (the JS SDK's `ResponseStreamEvent`): a payload
 * part, or one of the error members.
 */
export interface ResponseStreamEvent {
  PayloadPart?: ResponsePayloadPart;
  ModelStreamError?: unknown;
  InternalStreamFailure?: unknown;
  [key: string]: unknown;
}

/** Input to start a bidirectional stream. */
export interface InvokeEndpointWithBidirectionalStreamInput {
  endpointName: string;
  modelInvocationPath?: string | null;
  modelQueryString?: string | null;
}

/** The sending side of a duplex stream. */
export interface SageMakerBidiInputStream {
  send(event: RequestStreamEvent): Promise<void>;
  close(): Promise<void>;
}

/** The receiving side of a duplex stream. */
export interface SageMakerBidiOutputStream {
  /** The next response event, or `null` once the stream is closed. */
  receive(): Promise<ResponseStreamEvent | null>;
}

/** A started duplex stream. */
export interface SageMakerBidiStream {
  inputStream: SageMakerBidiInputStream;
  /** Resolves with `[output, outputStream]` once the response has started. */
  awaitOutput(): Promise<[unknown, SageMakerBidiOutputStream]>;
}

/** What `SageMakerBidiClient` needs from the SDK client. */
export interface SageMakerRuntimeHTTP2ClientLike {
  invokeEndpointWithBidirectionalStream(
    input: InvokeEndpointWithBidirectionalStreamInput,
  ): Promise<SageMakerBidiStream>;
}

// The SDK reports an unmodeled error (ThrottlingException among them) as a
// generic error whose only record of the HTTP status and error id is its message.
const STATUS_PATTERN = /status: (\d{3})/;
const ERROR_ID_PATTERN = /id: (?:\S*#)?(\w+)/;

const SERVER_ERROR_IDS = new Set([
  "InternalServerError",
  "InternalStreamFailure",
  "ServiceUnavailableError",
]);
const INVALID_REQUEST_ERROR_IDS = new Set(["InputValidationError", "ValidationError"]);
const RETRYABLE_CATEGORIES = new Set([
  ErrorCategory.RATE_LIMIT,
  ErrorCategory.SERVER,
  ErrorCategory.CONNECTIVITY,
]);
const AUTH_STATUSES = new Set([401, 403]);

/** Connect backoff (upstream's `_CONNECT_BACKOFF_MULTIPLIER` / `_MAX_WAIT`). */
export const _connectBackoff = { multiplier: 0.5, maxWait: 2.0 };

export interface SageMakerBidiSessionErrorOptions {
  /** The AWS error id, if known. */
  errorId?: string | null;
  /** The HTTP status AWS returned, if known. */
  httpStatus?: number | null;
  /** How many times the session was attempted. */
  attempts?: number;
  /** The error that caused this one. */
  cause?: unknown;
}

/**
 * A bidirectional streaming session failed to start.
 *
 * - `errorId`: The AWS error id (e.g. `"ThrottlingException"`), if known.
 * - `httpStatus`: The HTTP status AWS returned, if known. SageMaker reports
 *   throttling with a 400, so the status alone does not say whether a
 *   failure is worth retrying; use `classifySagemakerBidiError`.
 * - `attempts`: How many times the session was attempted.
 */
export class SageMakerBidiSessionError extends Error {
  override name = "SageMakerBidiSessionError";
  errorId: string | null;
  httpStatus: number | null;
  attempts: number;

  constructor(message: string, options: SageMakerBidiSessionErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.errorId = options.errorId ?? null;
    this.httpStatus = options.httpStatus ?? null;
    this.attempts = options.attempts ?? 1;
  }
}

function getAttr(obj: unknown, name: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  return (obj as Record<string, unknown>)[name];
}

function errorIdAndStatus(exception: unknown): [string | null, number | null] {
  if (exception instanceof SageMakerBidiSessionError) {
    return [exception.errorId, exception.httpStatus];
  }
  const message = exception instanceof Error ? exception.message : String(exception);
  const statusMatch = STATUS_PATTERN.exec(message);
  const idMatch = ERROR_ID_PATTERN.exec(message);
  let status: number | null = statusMatch ? Number(statusMatch[1]) : null;
  if (status === null) {
    // A ModelError carries the status the model container itself returned.
    const original = getAttr(exception, "OriginalStatusCode");
    if (typeof original === "number") status = original;
  }
  if (status === null) {
    // The JS SDK puts the HTTP status of any service error in `$metadata`.
    const metaStatus = getAttr(getAttr(exception, "$metadata"), "httpStatusCode");
    if (typeof metaStatus === "number") status = metaStatus;
  }
  if (idMatch) {
    return [idMatch[1] as string, status];
  }
  // Modeled errors are raised as their own exception types.
  const name = exception instanceof Error ? exception.name : "";
  if (SERVER_ERROR_IDS.has(name) || INVALID_REQUEST_ERROR_IDS.has(name) || name === "ModelError") {
    return [name, status];
  }
  // The JS SDK raises an unmodeled service error with its error id as `name`.
  if (name && getAttr(exception, "$metadata") !== undefined) {
    return [name, status];
  }
  return [null, status];
}

/**
 * Classify a failure to start or use a SageMaker bidirectional stream.
 *
 * @param exception The exception to classify.
 * @returns The category, or null if the exception is not recognized.
 */
export function classifySagemakerBidiError(exception: unknown): ErrorCategory | null {
  if (
    getAttr(exception, "isThrottlingError") === true ||
    getAttr(getAttr(exception, "$retryable"), "throttling") === true
  ) {
    return ErrorCategory.RATE_LIMIT;
  }
  const [errorId, status] = errorIdAndStatus(exception);
  if (errorId === "ThrottlingException" || status === 429) {
    return ErrorCategory.RATE_LIMIT;
  }
  if (errorId === "ModelError") {
    // SageMaker reports any failure to open the stream to the model container
    // as a 424, whether the container is at capacity, shedding load, or
    // rejected the request's settings, so a 424 is treated as transient.
    if (status === 424 || (status !== null && status >= 500 && status < 600)) {
      return ErrorCategory.SERVER;
    }
    return ErrorCategory.INVALID_REQUEST;
  }
  if (
    (errorId !== null && SERVER_ERROR_IDS.has(errorId)) ||
    (status !== null && status >= 500 && status < 600)
  ) {
    return ErrorCategory.SERVER;
  }
  if (status !== null && AUTH_STATUSES.has(status)) {
    // Credentials are resolved when the session starts, so a rejection can be
    // an expired credential that a new session clears.
    return ErrorCategory.CONNECTIVITY;
  }
  if (errorId !== null && INVALID_REQUEST_ERROR_IDS.has(errorId)) {
    return ErrorCategory.INVALID_REQUEST;
  }
  // Python's `isinstance(exception, (ConnectionError, TimeoutError))`.
  if (status === null && classifyHttpException(exception) === ErrorCategory.CONNECTIVITY) {
    return ErrorCategory.CONNECTIVITY;
  }
  return null;
}

/** An async iterable fed by `send()`, consumed by the SDK as the request body. */
class RequestEventChannel implements AsyncIterable<RequestStreamEvent> {
  #items: RequestStreamEvent[] = [];
  #closed = false;
  #waiter: (() => void) | null = null;

  push(event: RequestStreamEvent): void {
    if (this.#closed) throw new Error("Input stream closed");
    this.#items.push(event);
    this.#wake();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<RequestStreamEvent> {
    while (true) {
      const item = this.#items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.#closed) return;
      // The SDK pulls this body from its own (non-task) code, so a plain
      // promise is the handoff here.
      await new Promise<void>((resolve) => {
        this.#waiter = resolve;
      });
    }
  }
}

/** The subset of the JS SDK client `SdkSageMakerRuntimeHTTP2Client` calls. */
export interface SageMakerRuntimeHTTP2SdkClient {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

/** The subset of the JS SDK module `SdkSageMakerRuntimeHTTP2Client` loads. */
export interface SageMakerRuntimeHTTP2SdkModule {
  SageMakerRuntimeHTTP2Client: new (
    config: Record<string, unknown>,
  ) => SageMakerRuntimeHTTP2SdkClient;
  InvokeEndpointWithBidirectionalStreamCommand: new (input: Record<string, unknown>) => unknown;
}

export interface SdkSageMakerRuntimeHTTP2ClientOptions {
  /** HTTPS endpoint, e.g. `https://runtime.sagemaker.us-east-2.amazonaws.com:8443`. */
  endpoint: string;
  /** AWS region. */
  region: string;
  /** Signs the stream: its keys are handed to the SDK. */
  session: AWSSession;
  /** The SDK module (loaded with `import()` when omitted). */
  sdk?: SageMakerRuntimeHTTP2SdkModule | null;
  /** An SDK client to use instead of building one (tests). */
  sdkClient?: SageMakerRuntimeHTTP2SdkClient | null;
}

/** Adapts `@aws-sdk/client-sagemaker-runtime-http2` to `SageMakerRuntimeHTTP2ClientLike`. */
export class SdkSageMakerRuntimeHTTP2Client implements SageMakerRuntimeHTTP2ClientLike {
  readonly endpoint: string;
  readonly region: string;
  #session: AWSSession;
  #sdk: SageMakerRuntimeHTTP2SdkModule | null;
  #client: SageMakerRuntimeHTTP2SdkClient | null;

  constructor(options: SdkSageMakerRuntimeHTTP2ClientOptions) {
    this.endpoint = options.endpoint;
    this.region = options.region;
    this.#session = options.session;
    this.#sdk = options.sdk ?? null;
    this.#client = options.sdkClient ?? null;
  }

  async #loadSdk(): Promise<SageMakerRuntimeHTTP2SdkModule> {
    if (this.#sdk) return this.#sdk;
    try {
      const mod = (await import(SAGEMAKER_RUNTIME_HTTP2)) as SageMakerRuntimeHTTP2SdkModule & {
        default?: SageMakerRuntimeHTTP2SdkModule;
      };
      this.#sdk = mod.SageMakerRuntimeHTTP2Client
        ? mod
        : (mod.default as SageMakerRuntimeHTTP2SdkModule);
      return this.#sdk;
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Exception: ${e instanceof Error ? e.message : String(e)}`);
      logger.error(
        `In order to use SageMaker BiDi client, you need to install \`${SAGEMAKER_RUNTIME_HTTP2}\`.`,
      );
      throw new Error(`Missing module: ${SAGEMAKER_RUNTIME_HTTP2}`, { cause: e });
    }
  }

  /** The SDK client, built on first use. */
  async getSdkClient(): Promise<SageMakerRuntimeHTTP2SdkClient> {
    if (this.#client) return this.#client;
    const sdk = await this.#loadSdk();
    const session = this.#session;
    // SigV4 auth for the sagemaker service is the SDK default.
    this.#client = new sdk.SageMakerRuntimeHTTP2Client({
      endpoint: this.endpoint,
      region: this.region,
      credentials: async () => {
        const c = await session.getCredentials();
        return {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
        };
      },
    });
    return this.#client;
  }

  async invokeEndpointWithBidirectionalStream(
    input: InvokeEndpointWithBidirectionalStreamInput,
  ): Promise<SageMakerBidiStream> {
    const client = await this.getSdkClient();
    const sdk = this.#sdk;
    const channel = new RequestEventChannel();
    const commandInput: Record<string, unknown> = {
      EndpointName: input.endpointName,
      Body: channel,
    };
    if (input.modelInvocationPath) commandInput.ModelInvocationPath = input.modelInvocationPath;
    if (input.modelQueryString) commandInput.ModelQueryString = input.modelQueryString;
    const command = sdk
      ? new sdk.InvokeEndpointWithBidirectionalStreamCommand(commandInput)
      : commandInput;
    // The SDK resolves once the response has started; the request body keeps
    // streaming from `channel` after that.
    let output: { Body?: AsyncIterable<ResponseStreamEvent> };
    try {
      output = (await abortable(
        client.send(command, { abortSignal: currentSignal() }),
      )) as typeof output;
    } catch (e) {
      channel.close();
      throw e;
    }
    const iterator = output.Body?.[Symbol.asyncIterator]();
    const outputStream: SageMakerBidiOutputStream = {
      async receive() {
        if (!iterator) return null;
        const result = await abortable(iterator.next());
        return result.done ? null : result.value;
      },
    };
    return {
      inputStream: {
        async send(event) {
          channel.push(event);
        },
        async close() {
          channel.close();
        },
      },
      async awaitOutput() {
        return [output, outputStream];
      },
    };
  }
}

export interface SageMakerBidiClientOptions extends AWSClientOptions {
  /** Name of the SageMaker endpoint to connect to. */
  endpointName: string;
  /** AWS region where the endpoint is deployed. */
  region: string;
  /** API path for the model invocation (e.g., "v1/listen"). */
  modelInvocationPath?: string | null;
  /** Query string parameters for the model (e.g., "model=nova-3"). */
  modelQueryString?: string | null;
  /**
   * How many times `startSession` attempts the session when SageMaker
   * throttles it or fails transiently. The AWS SDK does not retry
   * bidirectional streams itself.
   */
  maxConnectAttempts?: number;
  /** AWS access key ID (pipedog addition; defaults to `AWS_ACCESS_KEY_ID`). */
  awsAccessKeyId?: string | null;
  /** AWS secret access key (pipedog addition; defaults to `AWS_SECRET_ACCESS_KEY`). */
  awsSecretAccessKey?: string | null;
  /** AWS session token (pipedog addition; defaults to `AWS_SESSION_TOKEN`). */
  awsSessionToken?: string | null;
  /** SDK client to use (pipedog addition; defaults to `SdkSageMakerRuntimeHTTP2Client`). */
  client?: SageMakerRuntimeHTTP2ClientLike | null;
}

/**
 * Client for bidirectional streaming with AWS SageMaker endpoints.
 *
 * Handles low-level HTTP/2 bidirectional streaming protocol for communicating
 * with SageMaker model endpoints. Provides methods for sending various data
 * types (audio, text, JSON) and receiving streaming responses.
 *
 * This client uses AWS SigV4 authentication with keys from the options, the
 * environment, or a `credentialsProvider`.
 *
 * @example
 * ```ts
 * const client = new SageMakerBidiClient({
 *   endpointName: "my-deepgram-endpoint",
 *   region: "us-east-2",
 *   modelInvocationPath: "v1/listen",
 *   modelQueryString: "model=nova-3&language=en",
 * });
 * await client.startSession();
 * await client.sendAudioChunk(audioBytes);
 * const response = await client.receiveResponse();
 * await client.closeSession();
 * ```
 */
export class SageMakerBidiClient {
  endpointName: string;
  maxConnectAttempts: number;
  region: string;
  modelInvocationPath: string | null;
  modelQueryString: string | null;
  bidiEndpoint: string;
  _client: SageMakerRuntimeHTTP2ClientLike | null;
  _stream: SageMakerBidiStream | null = null;
  _outputStream: SageMakerBidiOutputStream | null = null;
  _isActive = false;
  #session: AWSSession;

  constructor(options: SageMakerBidiClientOptions) {
    this.endpointName = options.endpointName;
    this.maxConnectAttempts = Math.max(1, options.maxConnectAttempts ?? 4);
    this.region = options.region;
    this.modelInvocationPath = options.modelInvocationPath ?? "";
    this.modelQueryString = options.modelQueryString ?? "";
    this.bidiEndpoint =
      options.endpointUrl ?? `https://runtime.sagemaker.${options.region}.amazonaws.com:8443`;
    this._client = options.client ?? null;
    this.#session = AWSSession.fromOptions({
      awsAccessKeyId: options.awsAccessKeyId,
      awsSecretAccessKey: options.awsSecretAccessKey,
      awsSessionToken: options.awsSessionToken,
      region: options.region,
      credentialsProvider: options.credentialsProvider,
    });
  }

  /**
   * Initialize the SageMaker Runtime HTTP2 client with AWS credentials.
   *
   * @returns The initialized client, also stored on the instance.
   */
  _initializeClient(): SageMakerRuntimeHTTP2ClientLike {
    logger.debug(`Initializing SageMaker BiDi client for region: ${this.region}`);
    logger.debug(`Using endpoint URI: ${this.bidiEndpoint}`);

    if (!this.#session.hasConfiguredKeys) {
      logger.warning(
        "AWS credentials not found in the options or environment variables. " +
          "Using the credentialsProvider, if one was given.",
      );
    }

    this._client = new SdkSageMakerRuntimeHTTP2Client({
      endpoint: this.bidiEndpoint,
      region: this.region,
      session: this.#session,
    });
    return this._client;
  }

  /**
   * Start a bidirectional streaming session with the SageMaker endpoint.
   *
   * Initializes the client if needed, creates the bidirectional stream, and
   * establishes the connection to the SageMaker endpoint. Must be called
   * before sending or receiving data. A throttled or transiently failed
   * attempt is retried with jittered exponential backoff, up to
   * `maxConnectAttempts` attempts in total.
   *
   * @returns The output stream for receiving responses.
   * @throws SageMakerBidiSessionError If the session could not be started.
   */
  async startSession(): Promise<SageMakerBidiOutputStream> {
    const client = this._client ?? this._initializeClient();

    logger.debug(`Starting BiDi session with endpoint: ${this.endpointName}`);
    logger.debug(`Model invocation path: ${this.modelInvocationPath}`);
    logger.debug(`Model query string: ${this.modelQueryString}`);

    // Create the bidirectional stream
    const streamInput: InvokeEndpointWithBidirectionalStreamInput = {
      endpointName: this.endpointName,
      modelInvocationPath: this.modelInvocationPath,
      modelQueryString: this.modelQueryString,
    };

    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        this._stream = await client.invokeEndpointWithBidirectionalStream(streamInput);
        this._isActive = true;

        // Get output stream
        const output = await this._stream.awaitOutput();
        this._outputStream = output[1];

        logger.debug("BiDi session started successfully");
        return this._outputStream;
      } catch (e) {
        rethrowIfCancelled(e);
        this._isActive = false;
        const category = classifySagemakerBidiError(e);
        const [errorId, status] = errorIdAndStatus(e);
        // A rejected credential is rejected again on every attempt: the
        // client resolves its credentials once, so only a new session
        // (and client) can pick up refreshed ones.
        if (
          category !== null &&
          RETRYABLE_CATEGORIES.has(category) &&
          !(status !== null && AUTH_STATUSES.has(status)) &&
          attempt < this.maxConnectAttempts
        ) {
          const wait =
            Math.random() *
            exponentialBackoffTime(attempt, 0, _connectBackoff.maxWait, _connectBackoff.multiplier);
          logger.warning(
            `BiDi session attempt ${attempt}/${this.maxConnectAttempts} failed ` +
              `(${category.value}), retrying in ${wait.toFixed(2)}s: ${errorText(e)}`,
          );
          await sleep(wait);
          continue;
        }

        logger.error(`Failed to start BiDi session after ${attempt} attempt(s): ${errorText(e)}`);
        throw new SageMakerBidiSessionError(
          `Failed to start SageMaker BiDi session: ${errorText(e)}`,
          { errorId, httpStatus: status, attempts: attempt, cause: e },
        );
      }
    }
  }

  /**
   * Send a chunk of data to the stream.
   *
   * Generic method for sending any type of data to the SageMaker endpoint.
   * Use the convenience methods (sendAudioChunk, sendText, sendJson)
   * for common data types.
   *
   * @param dataBytes Raw bytes to send.
   * @param dataType Optional data type header. Common values are "BINARY" for
   *   audio/binary data and "UTF8" for text/JSON data.
   * @throws Error If session is not active or send fails.
   */
  async sendData(dataBytes: Uint8Array, dataType: string | null = null): Promise<void> {
    if (!this._isActive || !this._stream) {
      throw new Error("BiDi session not active");
    }

    try {
      const payload: RequestPayloadPart = { Bytes: dataBytes };
      if (dataType !== null) payload.DataType = dataType;
      await this._stream.inputStream.send({ PayloadPart: payload });
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Failed to send data: ${errorText(e)}`);
      throw e;
    }
  }

  /**
   * Send a chunk of audio data to the stream. Sets the data type to "BINARY".
   *
   * @param audioBytes Raw audio bytes to send (e.g., PCM audio data).
   */
  async sendAudioChunk(audioBytes: Uint8Array): Promise<void> {
    await this.sendData(audioBytes, "BINARY");
  }

  /**
   * Send text data to the stream, UTF-8 encoded, with data type "UTF8".
   *
   * @param text Text string to send.
   */
  async sendText(text: string): Promise<void> {
    await this.sendData(new TextEncoder().encode(text), "UTF8");
  }

  /**
   * Send JSON data to the stream.
   *
   * Useful for control messages like KeepAlive or CloseStream. Serializes the
   * object to JSON (Python's `json.dumps` format), encodes as UTF-8, and sets
   * the data type to "UTF8".
   *
   * @param data Object to send as JSON (e.g., `{ type: "KeepAlive" }`).
   */
  async sendJson(data: Record<string, unknown>): Promise<void> {
    await this.sendData(new TextEncoder().encode(pyJsonDumps(data)), "UTF8");
  }

  /**
   * Receive a response from the stream.
   *
   * Blocks until a response is available from the SageMaker endpoint. Returns
   * null when the stream is closed.
   *
   * @returns The response event containing payload data, or null if stream is closed.
   * @throws Error If session is not active.
   */
  async receiveResponse(): Promise<ResponseStreamEvent | null> {
    if (!this._isActive || !this._outputStream) {
      throw new Error("BiDi session not active");
    }

    try {
      return await this._outputStream.receive();
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Failed to receive response: ${errorText(e)}`);
      throw e;
    }
  }

  /**
   * Close the bidirectional streaming session.
   *
   * Gracefully closes the input stream and marks the session as inactive.
   * Safe to call multiple times.
   */
  async closeSession(): Promise<void> {
    if (!this._isActive) {
      return;
    }

    logger.debug("Closing BiDi session...");
    this._isActive = false;

    try {
      if (this._stream) {
        await this._stream.inputStream.close();
      }
      logger.debug("BiDi session closed successfully");
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`Error closing BiDi session: ${errorText(e)}`);
    }
  }

  /** Whether the session is currently active. */
  get isActive(): boolean {
    return this._isActive;
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
