// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * AWS event stream framing (`application/vnd.amazon.eventstream`).
 *
 * Each message is:
 *
 * ```
 * [total length u32][headers length u32][prelude CRC32 u32]
 * [headers ...][payload ...][message CRC32 u32]
 * ```
 *
 * Headers are `[name length u8][name utf-8][type u8][value]`. This is the
 * framing Transcribe streaming, Bedrock `ConverseStream` and the bidirectional
 * streaming APIs use. Runtime-agnostic: `Uint8Array` and `DataView` only.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3, the one `zlib.crc32` / `binascii.crc32` compute). */
export function crc32(data: Uint8Array, previous = 0): number {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC_TABLE[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A header value with its wire type. Strings are the common case. */
export type EventStreamHeaderValue =
  | { type: "boolean"; value: boolean }
  | { type: "byte"; value: number }
  | { type: "short"; value: number }
  | { type: "integer"; value: number }
  | { type: "long"; value: bigint }
  | { type: "binary"; value: Uint8Array }
  | { type: "string"; value: string }
  | { type: "timestamp"; value: Date }
  | { type: "uuid"; value: string };

/** Headers of a message: a plain string is sent as a `string` header. */
export type EventStreamHeaders = Record<string, string | EventStreamHeaderValue>;

/** A decoded event stream message. */
export interface EventStreamMessage {
  headers: Record<string, EventStreamHeaderValue>;
  body: Uint8Array;
}

const PRELUDE_LENGTH = 12;
const MIN_MESSAGE_LENGTH = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Raised when an event stream message is malformed or fails its CRC check. */
export class EventStreamError extends Error {
  override name = "EventStreamError";
}

function encodeHeaders(headers: EventStreamHeaders): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, raw] of Object.entries(headers)) {
    const header: EventStreamHeaderValue =
      typeof raw === "string" ? { type: "string", value: raw } : raw;
    const nameBytes = encoder.encode(name);
    if (nameBytes.length > 255) throw new EventStreamError(`Header name too long: ${name}`);
    let value: Uint8Array;
    switch (header.type) {
      case "boolean":
        value = new Uint8Array([header.value ? 0 : 1]);
        break;
      case "byte":
        value = new Uint8Array([2, header.value & 0xff]);
        break;
      case "short": {
        value = new Uint8Array(3);
        value[0] = 3;
        new DataView(value.buffer).setInt16(1, header.value);
        break;
      }
      case "integer": {
        value = new Uint8Array(5);
        value[0] = 4;
        new DataView(value.buffer).setInt32(1, header.value);
        break;
      }
      case "long": {
        value = new Uint8Array(9);
        value[0] = 5;
        new DataView(value.buffer).setBigInt64(1, header.value);
        break;
      }
      case "binary": {
        value = new Uint8Array(3 + header.value.length);
        value[0] = 6;
        new DataView(value.buffer).setUint16(1, header.value.length);
        value.set(header.value, 3);
        break;
      }
      case "string": {
        const s = encoder.encode(header.value);
        value = new Uint8Array(3 + s.length);
        value[0] = 7;
        new DataView(value.buffer).setUint16(1, s.length);
        value.set(s, 3);
        break;
      }
      case "timestamp": {
        value = new Uint8Array(9);
        value[0] = 8;
        new DataView(value.buffer).setBigInt64(1, BigInt(header.value.getTime()));
        break;
      }
      case "uuid": {
        const hex = header.value.replace(/-/g, "");
        if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new EventStreamError(`Bad UUID: ${header.value}`);
        value = new Uint8Array(17);
        value[0] = 9;
        for (let i = 0; i < 16; i++)
          value[1 + i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        break;
      }
    }
    const out = new Uint8Array(1 + nameBytes.length + value.length);
    out[0] = nameBytes.length;
    out.set(nameBytes, 1);
    out.set(value, 1 + nameBytes.length);
    parts.push(out);
  }
  return concatBytes(parts);
}

function decodeHeaders(bytes: Uint8Array): Record<string, EventStreamHeaderValue> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record<string, EventStreamHeaderValue> = {};
  let pos = 0;
  while (pos < bytes.length) {
    const nameLength = bytes[pos] as number;
    pos += 1;
    const name = decoder.decode(bytes.subarray(pos, pos + nameLength));
    pos += nameLength;
    const type = bytes[pos];
    pos += 1;
    switch (type) {
      case 0:
        out[name] = { type: "boolean", value: true };
        break;
      case 1:
        out[name] = { type: "boolean", value: false };
        break;
      case 2:
        out[name] = { type: "byte", value: view.getInt8(pos) };
        pos += 1;
        break;
      case 3:
        out[name] = { type: "short", value: view.getInt16(pos) };
        pos += 2;
        break;
      case 4:
        out[name] = { type: "integer", value: view.getInt32(pos) };
        pos += 4;
        break;
      case 5:
        out[name] = { type: "long", value: view.getBigInt64(pos) };
        pos += 8;
        break;
      case 6: {
        const len = view.getUint16(pos);
        pos += 2;
        out[name] = { type: "binary", value: bytes.slice(pos, pos + len) };
        pos += len;
        break;
      }
      case 7: {
        const len = view.getUint16(pos);
        pos += 2;
        out[name] = { type: "string", value: decoder.decode(bytes.subarray(pos, pos + len)) };
        pos += len;
        break;
      }
      case 8:
        out[name] = { type: "timestamp", value: new Date(Number(view.getBigInt64(pos))) };
        pos += 8;
        break;
      case 9: {
        const hex = Array.from(bytes.subarray(pos, pos + 16), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        out[name] = {
          type: "uuid",
          value: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
        };
        pos += 16;
        break;
      }
      default:
        throw new EventStreamError(`Unknown header type ${type} for header ${name}`);
    }
  }
  return out;
}

/** Concatenate byte arrays. */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Encode one event stream message. */
export function encodeEventStreamMessage(message: {
  headers: EventStreamHeaders;
  body: Uint8Array;
}): Uint8Array {
  const headers = encodeHeaders(message.headers);
  const total = PRELUDE_LENGTH + headers.length + message.body.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headers.length);
  view.setUint32(8, crc32(out.subarray(0, 8)));
  out.set(headers, PRELUDE_LENGTH);
  out.set(message.body, PRELUDE_LENGTH + headers.length);
  view.setUint32(total - 4, crc32(out.subarray(0, total - 4)));
  return out;
}

/** Decode exactly one event stream message, verifying both CRCs. */
export function decodeEventStreamMessage(message: Uint8Array): EventStreamMessage {
  if (message.length < MIN_MESSAGE_LENGTH) {
    throw new EventStreamError("Event stream message too short");
  }
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const total = view.getUint32(0);
  const headersLength = view.getUint32(4);
  if (total !== message.length) {
    throw new EventStreamError(`Event stream length mismatch: ${total} != ${message.length}`);
  }
  if (view.getUint32(8) !== crc32(message.subarray(0, 8))) {
    throw new EventStreamError("Prelude CRC check failed");
  }
  if (view.getUint32(total - 4) !== crc32(message.subarray(0, total - 4))) {
    throw new EventStreamError("Message CRC check failed");
  }
  const headersEnd = PRELUDE_LENGTH + headersLength;
  if (headersEnd > total - 4) throw new EventStreamError("Event stream headers overflow");
  return {
    headers: decodeHeaders(message.subarray(PRELUDE_LENGTH, headersEnd)),
    body: message.slice(headersEnd, total - 4),
  };
}

/**
 * Incremental decoder: feed it chunks as they arrive (HTTP body chunks,
 * WebSocket frames) and it yields every complete message.
 */
export class EventStreamDecoder {
  #buffer: Uint8Array = new Uint8Array(0);

  /** Add bytes and return the messages they complete. */
  push(chunk: Uint8Array): EventStreamMessage[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : concatBytes([this.#buffer, chunk]);
    const out: EventStreamMessage[] = [];
    while (this.#buffer.length >= 4) {
      const total = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset,
        this.#buffer.byteLength,
      ).getUint32(0);
      if (total < MIN_MESSAGE_LENGTH) throw new EventStreamError("Bad event stream length");
      if (this.#buffer.length < total) break;
      out.push(decodeEventStreamMessage(this.#buffer.subarray(0, total)));
      this.#buffer = this.#buffer.subarray(total);
    }
    return out;
  }

  /** Bytes received that do not yet form a complete message. */
  get pending(): number {
    return this.#buffer.length;
  }
}

/** Decode every message of a streamed body (e.g. a `fetch` response body). */
export async function* decodeEventStream(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<EventStreamMessage> {
  const decoder = new EventStreamDecoder();
  const iterable: AsyncIterable<Uint8Array> =
    Symbol.asyncIterator in body
      ? (body as AsyncIterable<Uint8Array>)
      : readableToIterable(body as ReadableStream<Uint8Array>);
  for await (const chunk of iterable) {
    for (const message of decoder.push(chunk)) yield message;
  }
  if (decoder.pending > 0) throw new EventStreamError("Truncated event stream");
}

async function* readableToIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** The string value of a header, or `undefined`. */
export function headerString(message: EventStreamMessage, name: string): string | undefined {
  const h = message.headers[name];
  return h?.type === "string" ? h.value : undefined;
}
