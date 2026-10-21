// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/runner/utils.py

/**
 * Transport utility functions.
 *
 * PARTIAL PORT: only the telephony WebSocket helpers are ported:
 * `parseTelephonyWebsocket`, which detects the provider (Twilio, Telnyx,
 * Plivo, Exotel) from its first WebSocket messages and extracts the stream and
 * call IDs, and the detection it uses. `telephonyHandshake` (a pipedog
 * addition) reports the same parse as a typed outcome, including a call that
 * hung up before its handshake completed. Not ported yet: the eval-connect
 * detection (needs `pipecat.evals`), `create_transport` and
 * `_create_telephony_transport` (need the development runner's
 * `RunnerArguments`), the SmallWebRTC SDP munging, and the Daily, LiveKit and
 * Vonage Video helpers.
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
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";

import { CallData, ExotelCallData, type JsonDict, TelnyxCallData } from "./types.ts";

/** A telephony provider `parseTelephonyWebsocket` can detect, or `"unknown"`. */
export type TelephonyTransportType = "twilio" | "telnyx" | "plivo" | "exotel" | "unknown";

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

/** Python `obj.get(key, default)`: raises when `obj` is not a dict. */
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

  // DIVERGENCE: upstream first checks for an eval harness's `eval-connect`
  // message here (pipecat.evals). Evals are not ported, so it is not detected.

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
