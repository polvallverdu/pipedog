// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/runner/utils.py

/**
 * Transport utility functions.
 *
 * `parseTelephonyWebsocket` detects the telephony provider (Twilio, Telnyx,
 * Plivo, Exotel), or an eval harness's `eval-connect`, from its first
 * WebSocket messages; `telephonyHandshake` (a
 * pipedog addition) reports the same parse as a typed outcome, including a
 * call that hung up before its handshake completed. `createTransport` builds
 * the transport the runner arguments ask for, and `smallwebrtcSdpMunging`
 * adapts SDP for ESP32 peers. Not ported: the Daily dial-in helper and the
 * Daily, LiveKit, Vonage and MOQ transports (not ported), and the deprecated
 * `get_transport_client_id` and `maybe_capture_participant_*`.
 *
 * Nothing here depends on a runtime or a web framework: the socket is
 * anything with Starlette's `receive()` (a `WebsocketConnection` from
 * `@pipedog/transport-websocket`, as a fetch handler or any of its server
 * adapters hands you), so it works from fetch handlers on Bun, Node, Deno and
 * Cloudflare Workers.
 *
 * @example
 * import { parseTelephonyWebsocket } from "@pipedog/runner/utils";
 *
 * const handler = websocketFetchHandler(async (websocket) => {
 *   const [transportType, callData] = await parseTelephonyWebsocket(websocket);
 * });
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import type { BaseTransport } from "@pipedog/core/transports/base_transport";
import { getEnv } from "@pipedog/core/utils/env";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";

import type { FastAPIWebsocketParams } from "@pipedog/transport-websocket/fastapi";

import {
  CallData,
  DailyRunnerArguments,
  ExotelCallData,
  type JsonDict,
  LiveKitRunnerArguments,
  MOQRunnerArguments,
  type RunnerArguments,
  type RunnerWebSocket,
  SmallWebRTCRunnerArguments,
  TelnyxCallData,
  VonageRunnerArguments,
  WebSocketRunnerArguments,
} from "./types.ts";

/** A telephony provider `parseTelephonyWebsocket` can detect, or `"unknown"`. */
export type TelephonyTransportType = "twilio" | "telnyx" | "plivo" | "exotel" | "eval" | "unknown";

/** A message from `receive()`, shaped like Starlette's (ASGI) WebSocket messages. */
export interface TelephonyWebsocketMessage {
  type: string;
  text?: string | null;
  bytes?: Uint8Array | null;
}

/**
 * The socket `parseTelephonyWebsocket` reads from: anything with Starlette's
 * `receive()`. `WebsocketConnection` from `@pipedog/transport-websocket`
 * satisfies it.
 */
export interface TelephonyWebsocket {
  receive(): Promise<TelephonyWebsocketMessage>;
}

function isRecord(value: unknown): value is JsonDict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "str";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "boolean") return "bool";
  return typeof value;
}

/**
 * Python `obj.get(key, default)`: raises when `obj` is not a dict. Returns `any` because the
 * provider's websocket handshake JSON is untyped (genuinely dynamic in upstream).
 */
function dictGet(obj: unknown, key: string, defaultValue: unknown = null): any {
  if (!isRecord(obj)) {
    throw new TypeError(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return key in obj ? obj[key] : defaultValue;
}

/** Python `key in obj`: raises when `obj` is not a container. */
function pyIn(key: string, obj: unknown): boolean {
  if (isRecord(obj)) return key in obj;
  if (Array.isArray(obj)) return obj.includes(key);
  if (typeof obj === "string") return obj.includes(key);
  throw new TypeError(`argument of type '${pyTypeName(obj)}' is not iterable`);
}

/** Attempt to auto-detect transport type from WebSocket message structure. */
export function _detectTransportTypeFromMessage(messageData: JsonDict): TelephonyTransportType {
  logger.trace("=== Auto-Detection Analysis ===");

  // Twilio detection
  if (
    dictGet(messageData, "event") === "start" &&
    "start" in messageData &&
    pyIn("streamSid", dictGet(messageData, "start", {})) &&
    pyIn("callSid", dictGet(messageData, "start", {}))
  ) {
    logger.trace("Auto-detected: TWILIO");
    return "twilio";
  }

  // Telnyx detection
  if (
    "stream_id" in messageData &&
    "start" in messageData &&
    pyIn("call_control_id", dictGet(messageData, "start", {}))
  ) {
    logger.trace("Auto-detected: TELNYX");
    return "telnyx";
  }

  // Plivo detection
  if (
    "start" in messageData &&
    pyIn("streamId", dictGet(messageData, "start", {})) &&
    pyIn("callId", dictGet(messageData, "start", {}))
  ) {
    logger.trace("Auto-detected: PLIVO");
    return "plivo";
  }

  // Exotel detection
  if (
    dictGet(messageData, "event") === "start" &&
    "start" in messageData &&
    pyIn("stream_sid", dictGet(messageData, "start", {})) &&
    pyIn("call_sid", dictGet(messageData, "start", {})) &&
    pyIn("account_sid", dictGet(messageData, "start", {}))
  ) {
    logger.trace("Auto-detected: EXOTEL");
    return "exotel";
  }

  logger.trace("Auto-detection failed - unknown format");
  return "unknown";
}

/** The eval flags of an `eval-connect` message, or `null` for any other message. */
async function _parseEvalConnect(
  message: unknown,
): Promise<import("@pipedog/evals/serializer").EvalConnectionFlags | null> {
  // A cheap check first, so non-eval connections don't import the evals package.
  if (!isRecord(message) || message.type !== "client-message") {
    return null;
  }
  const { parseEvalConnect } = await import("@pipedog/evals/serializer");
  return parseEvalConnect(message);
}

/** Raised when the socket closes before the first message. */
export class TelephonyHandshakeError extends Error {
  override name = "ValueError";
}

/** The end of Starlette's `iter_text()`. */
const STOP = Symbol("StopAsyncIteration");

/** One step of Starlette's `websocket.iter_text()`: the next text message, or STOP on disconnect. */
async function nextText(websocket: TelephonyWebsocket): Promise<string | typeof STOP> {
  const message = await websocket.receive();
  if (message.type === "websocket.disconnect") return STOP;
  if (typeof message.text !== "string") {
    // Starlette's `receive_text()` reads `message["text"]`, a KeyError for a
    // binary message.
    throw new TypeError("KeyError: 'text' (expected a text WebSocket message)");
  }
  return message.text;
}

/** `json.loads(raw) if raw else {}`, with JSONDecodeError leaving `{}`. */
function parseMessage(raw: string): unknown {
  if (!raw) return {};
  try {
    return pyJsonLoads(raw);
  } catch (e) {
    rethrowIfCancelled(e);
    // json.JSONDecodeError: pass
    return {};
  }
}

/** The parse of each socket, so the single-use message stream is read once. */
const parsedTelephony = new WeakMap<object, [TelephonyTransportType, CallData]>();

/** Sockets that closed after their first message, before a second one. */
const closedAfterOneMessage = new WeakSet<object>();

/**
 * Parse telephony WebSocket messages and return transport type and call data.
 *
 * `callData` is a `CallData` model with typed attribute access
 * (`callData.toNumber`) that is also dict-compatible with the provider's keys
 * (`callData.getItem("call_id")`, `callData.get("body", {})`). Fields populated
 * per provider:
 *
 * - Twilio: `stream_id`, `call_id`, `body` (the TwiML stream's custom
 *   parameters), and `from`/`to` promoted from the `from_number`/`to_number`
 *   custom parameters.
 * - Telnyx (`TelnyxCallData`): `stream_id`, `call_id` (normalized from Telnyx's
 *   `call_control_id`), `outbound_encoding`, `from`, `to`.
 * - Plivo: `stream_id`, `call_id`.
 * - Exotel (`ExotelCallData`): `stream_id`, `call_id`, `account_sid`, `from`,
 *   `to`, `custom_parameters`.
 * - Eval (the harness's `eval-connect` message, sent first): `body` (the
 *   connection's eval flags).
 *
 * An eval is recognized from the first message alone; no second message is
 * read, so the harness's next message reaches the eval transport.
 *
 * The parsed result is cached per socket, so this is idempotent: the
 * underlying message stream is single-use, but calling this function again
 * (e.g. once in a helper and once in bot code) returns the same
 * `[transportType, callData]` without reading more messages.
 *
 * @param websocket The WebSocket connection from the telephony provider.
 * @returns `[transportType, callData]`.
 * @throws TelephonyHandshakeError (upstream's `ValueError`) If the WebSocket
 *   closes before sending any messages.
 *
 * @example
 * const [transportType, callData] = await parseTelephonyWebsocket(websocket);
 * const caller = callData.fromNumber; // typed attribute access
 * const userId = callData.body.user_id; // custom params are still a dict
 * // dict-style access also works: callData.getItem("call_id")
 */
export async function parseTelephonyWebsocket(
  websocket: TelephonyWebsocket,
): Promise<[TelephonyTransportType, CallData]> {
  // Return the cached parse if this websocket has already been parsed — the
  // message stream below can only be consumed once.
  const cached = parsedTelephony.get(websocket);
  if (cached) return cached;

  // Read first two messages
  let firstMessage: unknown = {};
  let secondMessage: unknown = {};

  // First message - required
  const firstMessageRaw = await nextText(websocket);
  if (firstMessageRaw === STOP) {
    throw new TelephonyHandshakeError(
      "WebSocket closed before receiving telephony handshake messages",
    );
  }
  logger.trace(`First message: ${firstMessageRaw}`);
  firstMessage = parseMessage(firstMessageRaw);

  const evalFlags = await _parseEvalConnect(firstMessage);
  if (evalFlags !== null) {
    logger.debug("Detected transport: eval (from first message)");
    const result: [TelephonyTransportType, CallData] = [
      "eval",
      new CallData({ body: evalFlags.modelDump() }),
    ];
    parsedTelephony.set(websocket, result);
    return result;
  }

  // Second message - optional, some providers may only send one
  const secondMessageRaw = await nextText(websocket);
  if (secondMessageRaw === STOP) {
    closedAfterOneMessage.add(websocket);
    logger.warning("Only received one WebSocket message, expected two");
  } else {
    logger.trace(`Second message: ${secondMessageRaw}`);
    secondMessage = parseMessage(secondMessageRaw);
  }

  try {
    // Try auto-detection on both messages
    const detectedTypeFirst = _detectTransportTypeFromMessage(firstMessage as JsonDict);
    const detectedTypeSecond = _detectTransportTypeFromMessage(secondMessage as JsonDict);

    // Use the successful detection
    let transportType: TelephonyTransportType;
    let callDataRaw: unknown;
    if (detectedTypeFirst !== "unknown") {
      transportType = detectedTypeFirst;
      callDataRaw = firstMessage;
      logger.debug(`Detected transport: ${transportType} (from first message)`);
    } else if (detectedTypeSecond !== "unknown") {
      transportType = detectedTypeSecond;
      callDataRaw = secondMessage;
      logger.debug(`Detected transport: ${transportType} (from second message)`);
    } else {
      transportType = "unknown";
      callDataRaw = secondMessage;
      logger.warning("Could not auto-detect transport type");
    }

    // Extract provider-specific data
    let callData: JsonDict;
    if (transportType === "twilio") {
      const startData = dictGet(callDataRaw, "start", {});
      const bodyData = dictGet(startData, "customParameters", {});
      callData = {
        stream_id: dictGet(startData, "streamSid"),
        call_id: dictGet(startData, "callSid"),
        // All custom parameters
        body: bodyData,
        // Promote common custom params so the typed API is uniform across
        // providers (Twilio carries from/to as TwiML stream parameters).
        from: dictGet(bodyData, "from_number"),
        to: dictGet(bodyData, "to_number"),
      };
    } else if (transportType === "telnyx") {
      callData = {
        stream_id: dictGet(callDataRaw, "stream_id"),
        // Telnyx's call identifier is its call_control_id; normalize it onto
        // the common `call_id` field.
        call_id: dictGet(dictGet(callDataRaw, "start", {}), "call_control_id"),
        outbound_encoding: dictGet(
          dictGet(dictGet(callDataRaw, "start", {}), "media_format", {}),
          "encoding",
        ),
        from: dictGet(dictGet(callDataRaw, "start", {}), "from", ""),
        to: dictGet(dictGet(callDataRaw, "start", {}), "to", ""),
      };
    } else if (transportType === "plivo") {
      const startData = dictGet(callDataRaw, "start", {});
      callData = {
        stream_id: dictGet(startData, "streamId"),
        call_id: dictGet(startData, "callId"),
      };
    } else if (transportType === "exotel") {
      const startData = dictGet(callDataRaw, "start", {});
      callData = {
        stream_id: dictGet(startData, "stream_sid"),
        call_id: dictGet(startData, "call_sid"),
        account_sid: dictGet(startData, "account_sid"),
        from: dictGet(startData, "from", ""),
        to: dictGet(startData, "to", ""),
        custom_parameters: dictGet(startData, "custom_parameters", ""),
      };
    } else {
      callData = {};
    }

    logger.debug(
      `Parsed - Type: ${transportType}, Data: ${pyJsonDumps(callData, { ensureAscii: false })}`,
    );
    // Return a typed, dict-compatible CallData model. modelValidate maps the
    // wire keys (e.g. "from"/"to") onto the aliased fields. Providers with
    // extra fields get a specific subclass so those fields are typed, not
    // just extras.
    const callDataType =
      transportType === "telnyx"
        ? TelnyxCallData
        : transportType === "exotel"
          ? ExotelCallData
          : CallData;
    const result: [TelephonyTransportType, CallData] = [
      transportType,
      callDataType.modelValidate(callData),
    ];
    // Cache per socket so subsequent calls don't re-consume the stream. Only
    // successful parses are cached; the raising paths stay retryable.
    parsedTelephony.set(websocket, result);
    return result;
  } catch (e) {
    rethrowIfCancelled(e);
    logger.error(`Error parsing telephony WebSocket: ${e instanceof Error ? e.message : e}`);
    throw e;
  }
}

/**
 * The outcome of a telephony handshake, as `telephonyHandshake` reports it.
 *
 * - `started`: the provider was detected and its call data parsed.
 * - `closed`: the socket closed before the provider's `start` message, e.g.
 *   the caller hung up while the call was connecting. `messagesReceived` is
 *   how many messages arrived first (0, or 1 such as Telnyx's `connected`).
 * - `unrecognized`: two messages arrived, but neither is a known provider's
 *   handshake.
 */
export type TelephonyHandshake =
  | {
      status: "started";
      transportType: Exclude<TelephonyTransportType, "unknown">;
      callData: CallData;
    }
  | { status: "closed"; messagesReceived: 0 | 1 }
  | { status: "unrecognized"; callData: CallData };

/**
 * `parseTelephonyWebsocket` as a typed outcome instead of an exception or an
 * `"unknown"` transport type, so a call that hangs up before its handshake
 * completes is an ordinary result. A pipedog addition, not in upstream Pipecat.
 *
 * Shares `parseTelephonyWebsocket`'s per-socket cache, so either can be called
 * first, and both return the same parse. Malformed messages (JSON that is not
 * an object) still throw, as they do there.
 *
 * @example
 * const handshake = await telephonyHandshake(websocket);
 * if (handshake.status !== "started") return; // hung up early, or not a phone call
 * const { transportType, callData } = handshake;
 */
export async function telephonyHandshake(
  websocket: TelephonyWebsocket,
): Promise<TelephonyHandshake> {
  let transportType: TelephonyTransportType;
  let callData: CallData;
  try {
    [transportType, callData] = await parseTelephonyWebsocket(websocket);
  } catch (e) {
    rethrowIfCancelled(e);
    if (e instanceof TelephonyHandshakeError) return { status: "closed", messagesReceived: 0 };
    throw e;
  }
  if (transportType !== "unknown") return { status: "started", transportType, callData };
  if (closedAfterOneMessage.has(websocket)) return { status: "closed", messagesReceived: 1 };
  return { status: "unrecognized", callData };
}

// ---------------------------------------------------------------------------
// Transport creation from runner arguments.
// ---------------------------------------------------------------------------

/**
 * Raised by `createTransport` when the caller hangs up before the telephony
 * provider's handshake completes (the socket closes before its `start`
 * message). A pipedog addition: upstream raises a `ValueError` when no message
 * arrived, and fails to find transport params for `"unknown"` when only a
 * first message (such as Telnyx's `connected`) did. `handshake` is the typed
 * outcome, also set on `runnerArgs.handshake`.
 *
 * It extends `TelephonyHandshakeError` (upstream's `ValueError`), so code that
 * catches that keeps working.
 *
 * @example
 * try {
 *   transport = await createTransport(runnerArgs, transportParams);
 * } catch (e) {
 *   if (e instanceof TelephonyCallEndedError) return; // the caller hung up
 *   throw e;
 * }
 */
export class TelephonyCallEndedError extends TelephonyHandshakeError {
  /** The handshake's outcome. */
  readonly handshake: Extract<TelephonyHandshake, { status: "closed" }>;

  constructor(handshake: Extract<TelephonyHandshake, { status: "closed" }>) {
    super(
      handshake.messagesReceived === 0
        ? "WebSocket closed before receiving telephony handshake messages"
        : "WebSocket closed after the provider's first message, before its start message",
    );
    this.handshake = handshake;
  }
}

/**
 * Raised when the runner arguments select a transport pipedog has not ported
 * (Daily, Vonage Video Connector, MOQ). Plays the part of the
 * `ImportError` upstream raises when the transport's extra isn't installed.
 */
export class TransportNotPortedError extends Error {
  override name = "TransportNotPortedError";
  /** The transport key (`"daily"`, `"livekit"`, `"vonage"`, `"moq"`...). */
  readonly transport: string;

  constructor(transport: string, upstreamModule: string) {
    super(
      `The ${transport} transport (${upstreamModule}) is not ported to pipedog yet. ` +
        "Use webrtc, websocket or a telephony transport (twilio, telnyx, plivo, exotel). " +
        "See https://polvallverdu.github.io/pipedog/docs/roadmap.",
    );
    this.transport = transport;
  }
}

/**
 * A function returning the transport params for one transport. Returns `any` because upstream's
 * `transport_params` is `Dict[str, Callable]`: each factory returns a different params class.
 */
export type TransportParamsFactory = () => any;

/**
 * Transport params factories by transport name: `"webrtc"`, `"websocket"`,
 * `"twilio"`, `"telnyx"`, `"plivo"`, `"exotel"`, `"eval"` (and, for API parity,
 * `"daily"`, `"livekit"`, `"vonage"`, `"moq"`).
 */
export type TransportParamsMap = Record<string, TransportParamsFactory>;

/**
 * Get transport parameters from factory function.
 *
 * @param transportKey The transport key to look up.
 * @param transportParams Transport names mapped to parameter factory functions.
 * @returns Transport parameters from the factory function.
 * @throws Error (upstream's `ValueError`) If the key is missing from `transportParams`.
 */
export function _getTransportParams(
  transportKey: string,
  transportParams: TransportParamsMap,
): any {
  if (!Object.hasOwn(transportParams, transportKey)) {
    throw new TransportParamsError(
      `Missing transport params for '${transportKey}'. ` +
        `Please add '${transportKey}' key to your transport_params dict.`,
    );
  }
  const params = transportParams[transportKey]!();
  logger.debug(`Using transport params for ${transportKey}`);
  return params;
}

/**
 * Get the eval transport's parameters, with its serializer defaulted.
 *
 * Defaulting the serializer to `EvalSerializer` means a bot only has to opt
 * into audio input.
 *
 * @throws TransportParamsError (upstream's `ValueError`) If the `"eval"` entry
 *   is missing or doesn't build an `EvalTransportParams`.
 */
export async function _getEvalTransportParams(
  transportParams: TransportParamsMap,
): Promise<import("@pipedog/evals/transport").EvalTransportParams> {
  const { EvalSerializer } = await import("@pipedog/evals/serializer");
  const { EvalTransportParams } = await import("@pipedog/evals/transport");

  const params = _getTransportParams("eval", transportParams);
  if (!(params instanceof EvalTransportParams)) {
    throw new TransportParamsError(
      "Eval transport params must be an EvalTransportParams instance. " +
        "Set transportParams.eval to a function returning " +
        "new EvalTransportParams({ audioInEnabled: true }).",
    );
  }
  if (params.serializer === null) {
    params.serializer = new EvalSerializer();
  }
  return params;
}

/** Upstream's `ValueError` for missing transport params or unsupported runner arguments. */
export class TransportParamsError extends Error {
  override name = "ValueError";
}

/**
 * Create a telephony transport with pre-parsed WebSocket data.
 *
 * @param websocket The WebSocket connection from the telephony provider.
 * @param params `FastAPIWebsocketParams` (required).
 * @param transportType Pre-detected provider type ("twilio", "telnyx", "plivo", "exotel").
 * @param callData Pre-parsed `CallData` with provider-specific fields.
 * @returns A `FastAPIWebsocketTransport` ready for telephony use.
 */
export async function _createTelephonyTransport(
  websocket: RunnerWebSocket,
  params: FastAPIWebsocketParams,
  transportType: string,
  callData: CallData,
): Promise<BaseTransport> {
  const { FastAPIWebsocketTransport } = await import("@pipedog/transport-websocket/fastapi");

  // Always set add_wav_header to False for telephony
  params.addWavHeader = false;

  logger.info(`Using pre-detected telephony provider: ${transportType}`);

  // Build serializers from the raw wire values via subscript access (the
  // detected provider guarantees these identifier fields are present). Bots use
  // the typed attribute API instead: callData.fromNumber, callData.callId, etc.
  const wire = (key: string) => callData.getItem(key) as string;
  if (transportType === "twilio") {
    const { TwilioFrameSerializer } = await import("@pipedog/serializer-twilio/twilio");
    params.serializer = new TwilioFrameSerializer({
      streamSid: wire("stream_id"),
      callSid: wire("call_id"),
      accountSid: getEnv("TWILIO_ACCOUNT_SID") ?? "",
      authToken: getEnv("TWILIO_AUTH_TOKEN") ?? "",
      apiKeySid: getEnv("TWILIO_API_KEY") || undefined,
      apiKeySecret: getEnv("TWILIO_API_SECRET") || undefined,
      region: getEnv("TWILIO_REGION") || undefined,
      edge: getEnv("TWILIO_EDGE") || undefined,
    });
  } else if (transportType === "telnyx") {
    const { TelnyxFrameSerializer } = await import("@pipedog/serializer-telnyx/telnyx");
    params.serializer = new TelnyxFrameSerializer({
      streamId: wire("stream_id"),
      callControlId: wire("call_id"),
      outboundEncoding: wire("outbound_encoding"),
      inboundEncoding: "PCMU", // Standard default
      apiKey: getEnv("TELNYX_API_KEY") ?? "",
    });
  } else if (transportType === "plivo") {
    const { PlivoFrameSerializer } = await import("@pipedog/serializer-plivo/plivo");
    params.serializer = new PlivoFrameSerializer({
      streamId: wire("stream_id"),
      callId: wire("call_id"),
      authId: getEnv("PLIVO_AUTH_ID") ?? "",
      authToken: getEnv("PLIVO_AUTH_TOKEN") ?? "",
    });
  } else if (transportType === "exotel") {
    const { ExotelFrameSerializer } = await import("@pipedog/serializer-exotel/exotel");
    params.serializer = new ExotelFrameSerializer({
      streamSid: wire("stream_id"),
      callSid: wire("call_id"),
    });
  } else {
    throw new TransportParamsError(
      `Unsupported telephony provider: ${transportType}. ` +
        "Supported providers: twilio, telnyx, plivo, exotel",
    );
  }

  return new FastAPIWebsocketTransport(websocket, params);
}

/**
 * Create a transport from runner arguments using factory functions.
 *
 * This function uses the clean `transportParams` factory pattern where users
 * define an object mapping transport names to parameter factory functions.
 *
 * For a telephony connection (`WebSocketRunnerArguments` without
 * `transportType: "websocket"`) it reads the provider's handshake, exposes it
 * on `runnerArgs` (`transportType`, `callData`, and pipedog's `handshake`) and
 * builds the provider's serializer. A caller who hangs up before the handshake
 * completes is reported as `TelephonyCallEndedError`.
 *
 * @param runnerArgs Arguments from the runner.
 * @param transportParams Transport names mapped to parameter factory functions.
 * @returns Configured transport instance.
 * @throws TransportParamsError If the transport key is missing from `transportParams`
 *   or the runner arguments type is unsupported.
 * @throws TelephonyCallEndedError If the caller hung up before the telephony handshake.
 * @throws TransportNotPortedError For Daily, Vonage and MOQ arguments.
 *
 * @example
 * const transportParams = {
 *   webrtc: () => new TransportParams({ audioInEnabled: true, audioOutEnabled: true }),
 *   telnyx: () =>
 *     new FastAPIWebsocketParams({
 *       audioInEnabled: true,
 *       audioOutEnabled: true,
 *       // addWavHeader and serializer will be set automatically
 *     }),
 * };
 *
 * const transport = await createTransport(runnerArgs, transportParams);
 */
export async function createTransport(
  runnerArgs: RunnerArguments,
  transportParams: TransportParamsMap,
): Promise<BaseTransport> {
  // Create transport based on runner args type
  if (runnerArgs instanceof DailyRunnerArguments) {
    _getTransportParams("daily", transportParams);
    throw new TransportNotPortedError("daily", "pipecat.transports.daily");
  }
  if (runnerArgs instanceof SmallWebRTCRunnerArguments) {
    const params = _getTransportParams("webrtc", transportParams);
    // Loaded by name, so bundles for Cloudflare Workers (where WebRTC can't run)
    // don't pull in the WebRTC stack.
    const moduleName = "@pipedog/transport-smallwebrtc/transport";
    const { SmallWebRTCTransport } = (await import(
      moduleName
    )) as typeof import("@pipedog/transport-smallwebrtc/transport");
    return new SmallWebRTCTransport(runnerArgs.webrtcConnection, params);
  }
  if (runnerArgs instanceof WebSocketRunnerArguments) {
    if (runnerArgs.transportType === "websocket") {
      const params = _getTransportParams("websocket", transportParams);
      const { FastAPIWebsocketTransport } = await import("@pipedog/transport-websocket/fastapi");
      return new FastAPIWebsocketTransport(runnerArgs.websocket, params);
    }

    // Parse once to determine the provider and get data. pipedog reads it as a
    // typed outcome, so a caller who hung up mid-handshake is told apart from a
    // provider that isn't recognized.
    const handshake = await telephonyHandshake(runnerArgs.websocket);
    runnerArgs.handshake = handshake;
    if (handshake.status === "closed") {
      // DIVERGENCE: upstream raises ValueError("WebSocket closed before receiving
      // telephony handshake messages") with no message, and "Missing transport
      // params for 'unknown'" after one. Both are a hang-up, reported as such.
      throw new TelephonyCallEndedError(handshake);
    }
    const [transportType, callData] = await parseTelephonyWebsocket(runnerArgs.websocket);

    // Expose the parsed handshake to the bot so it can personalize the call
    // (caller lookup, routing, etc.) without re-parsing the single-use stream.
    runnerArgs.transportType = transportType;
    runnerArgs.callData = callData;

    if (transportType === "eval") {
      const { EvalFastAPIWebsocketTransport } = await import("@pipedog/evals/fastapi_transport");
      const { EvalConnectionFlags } = await import("@pipedog/evals/serializer");

      return new EvalFastAPIWebsocketTransport(
        runnerArgs.websocket,
        await _getEvalTransportParams(transportParams),
        EvalConnectionFlags.modelValidate(callData.body),
      );
    }

    const params = _getTransportParams(transportType, transportParams);

    // Create telephony transport with pre-parsed data
    return await _createTelephonyTransport(runnerArgs.websocket, params, transportType, callData);
  }
  if (runnerArgs instanceof LiveKitRunnerArguments) {
    const params = _getTransportParams("livekit", transportParams);
    // Loaded by name: @pipedog/transport-livekit is an optional peer, and its
    // media SDK is a native addon that doesn't run everywhere.
    const moduleName = "@pipedog/transport-livekit/transport";
    const { LiveKitTransport } = (await import(
      moduleName
    )) as typeof import("@pipedog/transport-livekit/transport");
    return new LiveKitTransport({
      url: runnerArgs.url,
      token: runnerArgs.token,
      roomName: runnerArgs.roomName,
      params,
    });
  }
  if (runnerArgs instanceof VonageRunnerArguments) {
    throw new TransportNotPortedError("vonage", "pipecat.transports.vonage.video_connector");
  }
  if (runnerArgs instanceof MOQRunnerArguments) {
    _getTransportParams("moq", transportParams);
    throw new TransportNotPortedError("moq", "pipecat.transports.moq");
  }
  throw new TransportParamsError(
    `Unsupported runner arguments type: ${(runnerArgs as object)?.constructor?.name ?? typeof runnerArgs}`,
  );
}

// ---------------------------------------------------------------------------
// SmallWebRTC SDP munging.
// ---------------------------------------------------------------------------

/** Python's `str.splitlines()`: no trailing empty line. */
function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Clean up ICE candidates in SDP text for SmallWebRTC.
 *
 * @param text SDP text to clean up.
 * @param pattern Pattern to match for candidate filtering.
 * @returns Cleaned SDP text with filtered ICE candidates.
 */
export function _smallwebrtcSdpCleanupIceCandidates(text: string, pattern: string): string {
  logger.debug("Removing unsupported ICE candidates from SDP");
  const result: string[] = [];
  for (const line of splitlines(text)) {
    if (/a=candidate/.test(line)) {
      if (new RegExp(pattern).test(line) && !/raddr/.test(line)) result.push(line);
    } else {
      result.push(line);
    }
  }
  return `${result.join("\r\n")}\r\n`;
}

/**
 * Remove unsupported fingerprint algorithms from SDP text.
 *
 * @returns SDP text with sha-384 and sha-512 fingerprints removed.
 */
export function _smallwebrtcSdpCleanupFingerprints(text: string): string {
  logger.debug("Removing unsupported fingerprints from SDP");
  const result = splitlines(text).filter((line) => !/sha-384/.test(line) && !/sha-512/.test(line));
  return `${result.join("\r\n")}\r\n`;
}

/**
 * Apply SDP modifications for SmallWebRTC compatibility.
 *
 * @param sdp Original SDP string.
 * @param host Host address for ICE candidate filtering.
 * @returns Modified SDP string with fingerprint and ICE candidate cleanup.
 */
export function smallwebrtcSdpMunging(sdp: string, host: string | null): string {
  let result = _smallwebrtcSdpCleanupFingerprints(sdp);
  if (host) {
    result = _smallwebrtcSdpCleanupIceCandidates(result, host);
  }
  return result;
}
