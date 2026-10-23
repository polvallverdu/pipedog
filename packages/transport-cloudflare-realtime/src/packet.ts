// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The Realtime SFU WebSocket adapter's wire format, and the PCM conversions around it.
 *
 * Each binary WebSocket message carries one Protocol Buffers packet:
 *
 * ```proto
 * message Packet {
 *   uint32 sequenceNumber = 1;
 *   uint32 timestamp = 2;
 *   bytes payload = 5;
 * }
 * ```
 *
 * Audio payloads are signed 16-bit little-endian PCM at 48 kHz, stereo, with left and right
 * samples interleaved, in both directions. A serialized message must stay within 32 KB.
 *
 * The codec is hand-written (three fields) so the package needs no protobuf library.
 */

/** The SFU adapter's PCM sample rate, in both directions. */
export const SFU_SAMPLE_RATE = 48000;

/** The SFU adapter's PCM channel count, in both directions. */
export const SFU_CHANNELS = 2;

/** The largest serialized WebSocket message the adapter accepts, in bytes. */
export const MAX_MESSAGE_BYTES = 32 * 1024;

/**
 * The largest PCM payload this package puts in one packet, in bytes: a multiple of a stereo
 * frame (4 bytes) that leaves room for the protobuf overhead under `MAX_MESSAGE_BYTES`.
 */
export const MAX_PAYLOAD_BYTES = 32000;

/** One adapter packet. */
export interface AdapterPacket {
  /** Sequence number (unsigned 32-bit). Ingest ignores it; egress audio sets it. */
  sequenceNumber: number;
  /** Timestamp (unsigned 32-bit). Ingest ignores it; egress sets it. */
  timestamp: number;
  /** PCM (or, for video egress, a JPEG image). */
  payload: Uint8Array;
}

function varintLength(value: number): number {
  let n = 1;
  let v = value >>> 0;
  while (v > 127) {
    v >>>= 7;
    n++;
  }
  return n;
}

function writeVarint(out: Uint8Array, offset: number, value: number): number {
  let v = value >>> 0;
  while (v > 127) {
    out[offset++] = (v & 127) | 128;
    v >>>= 7;
  }
  out[offset++] = v;
  return offset;
}

/**
 * Serialize a packet.
 *
 * @param packet The packet. `sequenceNumber` and `timestamp` wrap to 32 bits.
 * @returns The protobuf bytes.
 */
export function encodePacket(packet: AdapterPacket): Uint8Array {
  const seq = packet.sequenceNumber >>> 0;
  const ts = packet.timestamp >>> 0;
  const payload = packet.payload;
  const size =
    1 +
    varintLength(seq) +
    1 +
    varintLength(ts) +
    1 +
    varintLength(payload.length) +
    payload.length;
  const out = new Uint8Array(size);
  let offset = 0;
  out[offset++] = 0x08; // field 1, varint
  offset = writeVarint(out, offset, seq);
  out[offset++] = 0x10; // field 2, varint
  offset = writeVarint(out, offset, ts);
  out[offset++] = 0x2a; // field 5, length-delimited
  offset = writeVarint(out, offset, payload.length);
  out.set(payload, offset);
  return out;
}

/** Raised for a message that isn't a valid adapter packet. */
export class PacketError extends Error {
  override name = "PacketError";
}

/**
 * Parse a packet. Unknown fields are skipped, as protobuf requires.
 *
 * @param data A binary WebSocket message from the adapter.
 * @returns The packet; the payload is a view into `data`.
 * @throws PacketError if `data` isn't a valid packet.
 */
export function decodePacket(data: Uint8Array): AdapterPacket {
  let offset = 0;
  const result: AdapterPacket = {
    sequenceNumber: 0,
    timestamp: 0,
    payload: new Uint8Array(0),
  };

  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= data.length) throw new PacketError("truncated varint");
      const byte = data[offset++] as number;
      if (shift < 32) value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
      if (shift > 63) throw new PacketError("varint too long");
    }
  };

  while (offset < data.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 0) throw new PacketError("field number 0");
    if (wire === 0) {
      const value = varint();
      if (field === 1) result.sequenceNumber = value >>> 0;
      else if (field === 2) result.timestamp = value >>> 0;
    } else if (wire === 1 || wire === 2 || wire === 5) {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (offset + length > data.length) throw new PacketError("truncated field");
      if (field === 5 && wire === 2) result.payload = data.subarray(offset, offset + length);
      offset += length;
    } else {
      throw new PacketError(`unsupported wire type ${wire}`);
    }
  }
  return result;
}

function int16View(pcm: Uint8Array): Int16Array {
  // Int16Array needs an even byte offset; copy when the view is misaligned.
  const bytes = pcm.byteOffset % 2 === 0 ? pcm : pcm.slice();
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
}

/**
 * Mix interleaved stereo PCM16 down to mono, averaging the two channels.
 *
 * @param stereo Interleaved stereo PCM16 (a multiple of 4 bytes).
 * @returns Mono PCM16.
 */
export function stereoToMono(stereo: Uint8Array): Uint8Array {
  const input = int16View(stereo);
  const frames = Math.floor(input.length / 2);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    out[i] = ((input[2 * i] as number) + (input[2 * i + 1] as number)) >> 1;
  }
  return new Uint8Array(out.buffer);
}

/**
 * Duplicate mono PCM16 into both channels of interleaved stereo PCM16.
 *
 * @param mono Mono PCM16.
 * @returns Interleaved stereo PCM16, twice as long.
 */
export function monoToStereo(mono: Uint8Array): Uint8Array {
  const input = int16View(mono);
  const out = new Int16Array(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    const s = input[i] as number;
    out[2 * i] = s;
    out[2 * i + 1] = s;
  }
  return new Uint8Array(out.buffer);
}
