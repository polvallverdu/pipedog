// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Bedrock bidirectional event streams over WebSocket, on every runtime.
 *
 * `InvokeModelWithBidirectionalStream` is an HTTP/2 full-duplex call, which
 * Cloudflare Workers (and `fetch` everywhere) cannot make. Bedrock also serves
 * it over WebSocket, which is how the AWS SDK for JavaScript runs it in
 * browsers (`@aws-sdk/middleware-websocket`). This module speaks that
 * protocol directly:
 *
 * - The URL is `wss://bedrock-runtime.<region>.amazonaws.com/model/<id>/invoke-with-bidirectional-stream-websocket`,
 *   presigned with SigV4 query parameters (service `bedrock`, 60 s expiry).
 * - Each client event is an event stream message (`:event-type: chunk`,
 *   `:message-type: event`, `:content-type: application/json`) whose body is
 *   `{"bytes": "<base64 payload>"}`. It is sent wrapped in a signed envelope:
 *   a message with `:date` and `:chunk-signature` headers whose body is the
 *   inner message. Signatures chain, starting from the URL's signature. An
 *   envelope with an empty body ends the input stream.
 * - Server events arrive as unsigned event stream messages in binary frames:
 *   `chunk` events with the same JSON body, or `:message-type: exception`.
 */

import { abortable, Lock, rethrowIfCancelled } from "@pipedog/asyncio";
import {
  type WebsocketClientConnection,
  type WebsocketConnectOptions,
  websocketConnect,
} from "@pipedog/core/services/websocket_service";
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import type { AWSSession } from "./aws_session.ts";
import {
  decodeEventStreamMessage,
  type EventStreamHeaders,
  encodeEventStreamMessage,
  headerString,
} from "./event_stream.ts";
import {
  type AWSCredentialIdentity,
  amzDate,
  getSigningKey,
  sha256Hex,
  signHex,
  uriEscape,
  uriEscapePath,
} from "./sigv4.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Options for `presignUrl`. */
export interface PresignUrlOptions {
  /** URL to presign (its existing query parameters are signed too). */
  url: string;
  service: string;
  region: string;
  credentials: AWSCredentialIdentity;
  /** Seconds the URL stays valid. */
  expiresIn: number;
  /** Signing time (defaults to now). */
  date?: Date;
}

/**
 * Presign a GET URL with SigV4 query parameters, signing only the `host`
 * header. Same output as `@smithy/signature-v4`'s `presign`.
 *
 * @returns The presigned URL and its signature (the seed of an event stream's
 *   signature chain).
 */
export async function presignUrl(
  options: PresignUrlOptions,
): Promise<{ url: string; signature: string }> {
  const url = new URL(options.url);
  const date = options.date ?? new Date();
  const stamp = amzDate(date);
  const dateStamp = stamp.slice(0, 8);
  const scope = `${dateStamp}/${options.region}/${options.service}/aws4_request`;
  const params: [string, string][] = [...url.searchParams];
  params.push(["X-Amz-Algorithm", "AWS4-HMAC-SHA256"]);
  params.push(["X-Amz-Credential", `${options.credentials.accessKeyId}/${scope}`]);
  params.push(["X-Amz-Date", stamp]);
  params.push(["X-Amz-Expires", String(options.expiresIn)]);
  if (options.credentials.sessionToken) {
    params.push(["X-Amz-Security-Token", options.credentials.sessionToken]);
  }
  params.push(["X-Amz-SignedHeaders", "host"]);
  const encoded = params.map(([k, v]) => [uriEscape(k), uriEscape(v)] as [string, string]);
  encoded.sort(([ak, av], [bk, bv]) =>
    ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
  );
  const query = encoded.map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalRequest = [
    "GET",
    uriEscapePath(url.pathname || "/"),
    query,
    `host:${url.host}\n`,
    "host",
    await sha256Hex(""),
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonicalRequest)].join(
    "\n",
  );
  const key = await getSigningKey(
    options.credentials.secretAccessKey,
    dateStamp,
    options.region,
    options.service,
  );
  const signature = await signHex(key, stringToSign);
  return {
    url: `${url.protocol}//${url.host}${url.pathname}?${query}&X-Amz-Signature=${signature}`,
    signature,
  };
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Signs event stream messages with SigV4 event signing
 * (`AWS4-HMAC-SHA256-PAYLOAD`), chaining each signature to the previous one.
 * Same output as `@smithy/signature-v4`'s `signMessage` plus the envelope the
 * AWS SDK's event signing stream builds.
 */
export class EventStreamMessageSigner {
  #priorSignature: string;
  readonly #credentials: AWSCredentialIdentity;
  readonly #region: string;
  readonly #service: string;

  constructor(options: {
    seedSignature: string;
    credentials: AWSCredentialIdentity;
    region: string;
    service: string;
  }) {
    this.#priorSignature = options.seedSignature;
    this.#credentials = options.credentials;
    this.#region = options.region;
    this.#service = options.service;
  }

  /** The signature of the last message signed (or the seed). */
  get priorSignature(): string {
    return this.#priorSignature;
  }

  /** Wrap `payload` (an encoded inner message, or empty to end the stream) in a signed envelope. */
  async sign(payload: Uint8Array, date: Date = new Date()): Promise<Uint8Array> {
    // The `:date` header carries whole milliseconds; the scope uses seconds.
    const signingDate = new Date(date.getTime());
    const stamp = amzDate(signingDate);
    const dateStamp = stamp.slice(0, 8);
    const scope = `${dateStamp}/${this.#region}/${this.#service}/aws4_request`;
    const dateHeader: EventStreamHeaders = { ":date": { type: "timestamp", value: signingDate } };
    const encodedDateHeader = encodeEventStreamMessage({
      headers: dateHeader,
      body: new Uint8Array(0),
    });
    // Headers only: strip the prelude (12 bytes) and trailing CRC (4 bytes).
    const headerBytes = encodedDateHeader.subarray(12, encodedDateHeader.length - 4);
    const stringToSign = [
      "AWS4-HMAC-SHA256-PAYLOAD",
      stamp,
      scope,
      this.#priorSignature,
      await sha256Hex(headerBytes),
      await sha256Hex(payload),
    ].join("\n");
    const key = await getSigningKey(
      this.#credentials.secretAccessKey,
      dateStamp,
      this.#region,
      this.#service,
    );
    const signature = await signHex(key, stringToSign);
    this.#priorSignature = signature;
    return encodeEventStreamMessage({
      headers: {
        ...dateHeader,
        ":chunk-signature": { type: "binary", value: fromHex(signature) },
      },
      body: payload,
    });
  }
}

/** An inner `chunk` event carrying `payload`, as Bedrock's bidirectional APIs expect. */
export function encodeChunkEvent(payload: Uint8Array): Uint8Array {
  return encodeEventStreamMessage({
    headers: {
      ":event-type": "chunk",
      ":message-type": "event",
      ":content-type": "application/json",
    },
    body: encoder.encode(JSON.stringify({ bytes: bytesToBase64(payload) })),
  });
}

/** An error event from the service (`:message-type: exception` or `error`). */
export class BidirectionalStreamError extends Error {
  override name = "BidirectionalStreamError";
  /** The exception type, e.g. `validationException`. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/**
 * Decode one server message: the `chunk` payload bytes, or null for an event
 * that carries none.
 *
 * @throws BidirectionalStreamError For an exception or error message.
 */
export function decodeChunkEvent(message: Uint8Array): Uint8Array | null {
  const decoded = decodeEventStreamMessage(message);
  const messageType = headerString(decoded, ":message-type");
  if (messageType === "exception") {
    const code = headerString(decoded, ":exception-type") ?? "exception";
    let text = decoder.decode(decoded.body);
    try {
      text = String((JSON.parse(text) as { message?: unknown }).message ?? text);
    } catch {
      // Not JSON: keep the raw body.
    }
    throw new BidirectionalStreamError(code, text);
  }
  if (messageType === "error") {
    throw new BidirectionalStreamError(
      headerString(decoded, ":error-code") ?? "error",
      headerString(decoded, ":error-message") ?? "",
    );
  }
  if (headerString(decoded, ":event-type") !== "chunk") return null;
  const body = JSON.parse(decoder.decode(decoded.body)) as { bytes?: string };
  return body.bytes ? base64ToBytes(body.bytes) : new Uint8Array(0);
}

/**
 * One open bidirectional stream: send payloads, receive payloads.
 *
 * Mirrors the parts of smithy's `DuplexEventStream` the services use:
 * `send` (`input_stream.send`), `receive` (`await_output` + `receive`),
 * `closeInput` (`input_stream.close`) and `close`.
 */
export interface BidirectionalStream {
  /** Send one payload (the bytes of a `chunk` event). */
  send(payload: Uint8Array): Promise<void>;
  /**
   * The next payload from the service, or null once the service has ended
   * the stream.
   *
   * @throws BidirectionalStreamError When the service reports an error.
   */
  receive(): Promise<Uint8Array | null>;
  /** End the input side (the service then finishes and ends the output). */
  closeInput(): Promise<void>;
  /** Close the whole stream. */
  close(): Promise<void>;
}

/** Options for `openBedrockWebSocketStream`. */
export interface OpenBedrockWebSocketStreamOptions {
  /** Region, credentials. */
  session: AWSSession;
  /** Model ID (or ARN). */
  modelId: string;
  /** Endpoint override, `https://host[:port]` (sent as `wss://`). */
  endpointUrl?: string | null;
  /** Creates the `WebSocket` (see `websocketConnect`); for tests and custom runtimes. */
  webSocketFactory?: WebsocketConnectOptions["webSocketFactory"];
}

/**
 * Open `InvokeModelWithBidirectionalStream` over WebSocket.
 */
export async function openBedrockWebSocketStream(
  options: OpenBedrockWebSocketStreamOptions,
): Promise<BidirectionalStream> {
  const region = options.session.region;
  const base = (options.endpointUrl ?? `https://bedrock-runtime.${region}.amazonaws.com`)
    .replace(/\/+$/, "")
    .replace(/^http/, "ws");
  const credentials = await options.session.getCredentials();
  const path = `/model/${uriEscape(options.modelId)}/invoke-with-bidirectional-stream-websocket`;
  const { url, signature } = await presignUrl({
    url: `${base}${path}`,
    service: "bedrock",
    region,
    credentials,
    expiresIn: 60,
  });
  const connection = await websocketConnect(url, {
    webSocketFactory: options.webSocketFactory ?? null,
  });
  const signer = new EventStreamMessageSigner({
    seedSignature: signature,
    credentials,
    region,
    service: "bedrock",
  });
  return new WebSocketBidirectionalStream(connection, signer);
}

class WebSocketBidirectionalStream implements BidirectionalStream {
  readonly #connection: WebsocketClientConnection;
  readonly #signer: EventStreamMessageSigner;
  #inputClosed = false;
  #ended = false;
  // Signing is async; the lock keeps envelopes in send order so the chain holds.
  readonly #sendLock = new Lock();

  constructor(connection: WebsocketClientConnection, signer: EventStreamMessageSigner) {
    this.#connection = connection;
    this.#signer = signer;
  }

  async send(payload: Uint8Array): Promise<void> {
    if (this.#inputClosed) throw new Error("Bidirectional stream input is closed");
    await this.#sendSigned(encodeChunkEvent(payload));
  }

  async #sendSigned(inner: Uint8Array): Promise<void> {
    await this.#sendLock.run(async () => {
      const envelope = await this.#signer.sign(inner);
      await this.#connection.send(envelope);
    });
  }

  async receive(): Promise<Uint8Array | null> {
    if (this.#ended) return null;
    while (true) {
      let data: string | Uint8Array;
      try {
        data = await this.#connection.recv();
      } catch (e) {
        if ((e as { name?: string }).name === "ConnectionClosedOK") {
          this.#ended = true;
          return null;
        }
        throw e;
      }
      const bytes = typeof data === "string" ? base64ToBytes(data) : data;
      const payload = decodeChunkEvent(bytes);
      if (payload !== null) return payload;
    }
  }

  async closeInput(): Promise<void> {
    if (this.#inputClosed) return;
    this.#inputClosed = true;
    try {
      await this.#sendSigned(new Uint8Array(0));
    } catch (e) {
      logger.debug(`Bidirectional stream: error ending input: ${e}`);
    }
  }

  async close(): Promise<void> {
    await this.closeInput();
    await this.#connection.close();
  }
}

const BEDROCK_RUNTIME_SDK = "@aws-sdk/client-bedrock-runtime";

/**
 * A minimal async iterable fed by `push()`, consumed by the AWS SDK (which
 * reads it outside any pipedog task, so it uses plain promises).
 */
class InputChannel<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiter: ((r: IteratorResult<T>) => void) | null = null;
  #ended = false;

  push(item: T): void {
    if (this.#ended) throw new Error("Bidirectional stream input is closed");
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = null;
      w({ done: false, value: item });
    } else {
      this.#items.push(item);
    }
  }

  end(): void {
    this.#ended = true;
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = null;
      w({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ done: false, value: item });
        if (this.#ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.#waiter = resolve;
        });
      },
    };
  }
}

/** Options for `openBedrockSdkStream`. */
export interface OpenBedrockSdkStreamOptions {
  /** Region, credentials. */
  session: AWSSession;
  /** Model ID (or ARN). */
  modelId: string;
  /** Endpoint override, `https://host[:port]`. */
  endpointUrl?: string | null;
}

type SdkOutputEvent = Record<string, { bytes?: Uint8Array; message?: string } | undefined>;

/**
 * Open `InvokeModelWithBidirectionalStream` over HTTP/2 with the AWS SDK
 * (`@aws-sdk/client-bedrock-runtime`, an optional peer loaded on first use).
 * Needs Node's `node:http2` (Node, Bun); not available on Workers.
 */
export async function openBedrockSdkStream(
  options: OpenBedrockSdkStreamOptions,
): Promise<BidirectionalStream> {
  let sdk: any;
  try {
    sdk = await import(BEDROCK_RUNTIME_SDK);
  } catch (e) {
    rethrowIfCancelled(e);
    throw new Error(`The "http2" transport needs ${BEDROCK_RUNTIME_SDK}; install it.`, {
      cause: e,
    });
  }
  const session = options.session;
  const client = new sdk.BedrockRuntimeClient({
    region: session.region,
    ...(options.endpointUrl ? { endpoint: options.endpointUrl } : {}),
    credentials: async () => {
      const c = await session.getCredentials();
      return {
        accessKeyId: c.accessKeyId,
        secretAccessKey: c.secretAccessKey,
        ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
      };
    },
  });
  const input = new InputChannel<{ chunk: { bytes: Uint8Array } }>();
  let response: { body: AsyncIterable<SdkOutputEvent> };
  try {
    response = await abortable(
      client.send(
        new sdk.InvokeModelWithBidirectionalStreamCommand({
          modelId: options.modelId,
          body: input,
        }),
      ) as Promise<{ body: AsyncIterable<SdkOutputEvent> }>,
    );
  } catch (e) {
    input.end();
    client.destroy();
    throw e;
  }
  const iterator = response.body[Symbol.asyncIterator]();
  return {
    send: async (payload) => input.push({ chunk: { bytes: payload } }),
    receive: async () => {
      const next = await abortable(iterator.next());
      if (next.done) return null;
      const event = next.value;
      if (event.chunk) return event.chunk.bytes ?? new Uint8Array(0);
      const [code, detail] = Object.entries(event)[0] ?? ["unknown", undefined];
      throw new BidirectionalStreamError(code, detail?.message ?? "");
    },
    closeInput: async () => input.end(),
    close: async () => {
      input.end();
      client.destroy();
    },
  };
}
