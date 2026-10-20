// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Video for the SmallWebRTC transport.
 *
 * aiortc decodes and encodes VP8 and H.264 with PyAV (FFmpeg). There is no
 * portable, dependency-free video codec for JavaScript, so the codecs are
 * pluggable here: pass a `VideoDecoderFactory` to receive the user's camera
 * and screen share as frames, and a `VideoEncoderFactory` to send video. This
 * module does the RTP side (depayloading, frame assembly, packetization) and
 * the pixel format conversions upstream does with OpenCV.
 *
 * Without a decoder, incoming video is still negotiated and its packets are
 * received, but no video frames are produced (a warning is logged once).
 * Without an encoder, outgoing video frames are dropped (likewise).
 */

/** Pixel formats a `VideoFrame` can hold (FFmpeg's names). */
export type VideoPixelFormat = "rgb24" | "yuv420p" | "yuvj420p" | "nv12" | "gray" | (string & {});

/** The pixels of a frame with their dimensions (a numpy array's data and shape). */
export interface VideoFrameArray {
  data: Uint8Array;
  width: number;
  height: number;
}

/** A raw video frame (PyAV's `VideoFrame`). */
export class VideoFrame {
  width: number;
  height: number;
  format: { name: VideoPixelFormat };
  data: Uint8Array;
  /** Presentation timestamp, in `timeBase` units. */
  pts: number | null;
  /** Seconds per `pts` unit. */
  timeBase: number;

  constructor(options: {
    width: number;
    height: number;
    format?: VideoPixelFormat;
    data: Uint8Array;
    pts?: number | null;
    timeBase?: number;
  }) {
    this.width = options.width;
    this.height = options.height;
    this.format = { name: options.format ?? "rgb24" };
    this.data = options.data;
    this.pts = options.pts ?? null;
    this.timeBase = options.timeBase ?? 1 / 90000;
  }

  /** A frame of `format` pixels (`VideoFrame.from_ndarray`). */
  static fromNdarray(array: VideoFrameArray, format: VideoPixelFormat = "rgb24"): VideoFrame {
    return new VideoFrame({ width: array.width, height: array.height, format, data: array.data });
  }

  /** The frame's pixels, in its own format (`VideoFrame.to_ndarray`). */
  toNdarray(format?: VideoPixelFormat): VideoFrameArray {
    if (format && format !== this.format.name) {
      if (format !== "rgb24") throw new Error(`Cannot convert ${this.format.name} to ${format}`);
      const data = convertToRgb(this.toNdarray(), this.format.name);
      return { data, width: this.width, height: this.height };
    }
    return { data: this.data, width: this.width, height: this.height };
  }
}

/** An encoded frame from the peer. */
export interface EncodedVideoFrame {
  /** The codec's RTP name, e.g. `"VP8"` or `"H264"`. */
  codec: string;
  /** A VP8 frame, or an H.264 access unit in Annex B format. */
  data: Uint8Array;
  /** RTP timestamp (90 kHz), relative to the first frame. */
  timestamp: number;
  /** Whether the frame is a keyframe. */
  keyframe: boolean;
}

/** Decodes the peer's video. */
export interface VideoDecoder {
  /** Decode a frame into zero or more raw frames (any `VideoPixelFormat`). */
  decode(frame: EncodedVideoFrame): VideoFrame[] | Promise<VideoFrame[]>;
  close?(): void;
}

/** Creates a decoder for a codec (`"VP8"`, `"H264"`), or returns null if unsupported. */
export type VideoDecoderFactory = (
  codec: string,
) => VideoDecoder | null | Promise<VideoDecoder | null>;

/** Encodes video for the peer. */
export interface VideoEncoder {
  /**
   * Encode a frame: a VP8 frame, or an H.264 access unit in Annex B format.
   * Return null to skip the frame.
   */
  encode(
    frame: VideoFrame,
    options: { keyframe: boolean },
  ): Uint8Array | null | Promise<Uint8Array | null>;
  close?(): void;
}

/** Creates an encoder for a codec (`"VP8"`, `"H264"`), or returns null if unsupported. */
export type VideoEncoderFactory = (
  codec: string,
) => VideoEncoder | null | Promise<VideoEncoder | null>;

// ---------------------------------------------------------------------------
// Depayloading (RTP payload -> codec data)

const START_CODE = new Uint8Array([0, 0, 0, 1]);

function concat(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Strip the VP8 payload descriptor (RFC 7741 §4.2). */
export function vp8Depayload(payload: Uint8Array): Uint8Array {
  if (payload.length < 1) throw new Error("VP8 payload is too short");
  let pos = 1;
  if (payload[0]! & 0x80) {
    // X: extension byte
    const ext = payload[pos++]!;
    if (ext & 0x80) {
      // I: picture id, 7 or 15 bits
      pos += payload[pos]! & 0x80 ? 2 : 1;
    }
    if (ext & 0x40) pos += 1; // L: TL0PICIDX
    if (ext & 0x30) pos += 1; // T or K: TID/Y/KEYIDX
  }
  if (pos > payload.length) throw new Error("VP8 payload descriptor is truncated");
  return payload.subarray(pos);
}

/** Whether a VP8 frame (descriptor removed) is a keyframe. */
export function vp8IsKeyframe(frame: Uint8Array): boolean {
  return frame.length > 0 && (frame[0]! & 0x01) === 0;
}

/** Turn an H.264 RTP payload (RFC 6184) into Annex B NAL units. */
export function h264Depayload(payload: Uint8Array): Uint8Array {
  if (payload.length < 1) throw new Error("H264 payload is too short");
  const type = payload[0]! & 0x1f;
  if (type === 24) {
    // STAP-A: 16-bit sizes, each followed by a NAL unit.
    const out: Uint8Array[] = [];
    let pos = 1;
    while (pos + 2 <= payload.length) {
      const size = (payload[pos]! << 8) | payload[pos + 1]!;
      pos += 2;
      if (pos + size > payload.length) throw new Error("H264 STAP-A is truncated");
      out.push(START_CODE, payload.subarray(pos, pos + size));
      pos += size;
    }
    return concat(out);
  }
  if (type === 28) {
    // FU-A: the first fragment rebuilds the NAL header.
    if (payload.length < 2) throw new Error("H264 FU-A is too short");
    const header = payload[1]!;
    const body = payload.subarray(2);
    if (header & 0x80) {
      const nalHeader = (payload[0]! & 0xe0) | (header & 0x1f);
      return concat([START_CODE, new Uint8Array([nalHeader]), body]);
    }
    return body;
  }
  if (type >= 1 && type <= 23) return concat([START_CODE, payload]);
  throw new Error(`H264 NAL unit type ${type} is not supported`);
}

/** Whether an H.264 access unit (Annex B) holds an IDR picture or parameter sets. */
export function h264IsKeyframe(accessUnit: Uint8Array): boolean {
  for (const nal of splitAnnexB(accessUnit)) {
    const type = nal[0]! & 0x1f;
    if (type === 5 || type === 7) return true;
  }
  return false;
}

/** The NAL units of an Annex B byte stream, start codes removed. */
export function splitAnnexB(stream: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < stream.length) {
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        if (end > start && stream[end - 1] === 0) end -= 1;
        if (end > start) nals.push(stream.subarray(start, end));
      }
      i += 3;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start >= 0 && start < stream.length) nals.push(stream.subarray(start));
  if (start < 0 && stream.length > 0) nals.push(stream);
  return nals;
}

/** Depayload an RTP payload of `codec`, or throw if the codec is unknown. */
export function depayload(codec: string, payload: Uint8Array): Uint8Array {
  switch (codec.toUpperCase()) {
    case "VP8":
      return vp8Depayload(payload);
    case "H264":
      return h264Depayload(payload);
    default:
      throw new Error(`Cannot depayload ${codec}`);
  }
}

/** Whether an assembled frame of `codec` is a keyframe. */
export function isKeyframe(codec: string, frame: Uint8Array): boolean {
  switch (codec.toUpperCase()) {
    case "VP8":
      return vp8IsKeyframe(frame);
    case "H264":
      return h264IsKeyframe(frame);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Packetization (codec data -> RTP payloads)

/** The largest RTP payload we send (aiortc's PACKET_MAX). */
export const PACKET_MAX = 1300;

/** Split a VP8 frame into RTP payloads (RFC 7741), each with a minimal descriptor. */
export function vp8Packetize(frame: Uint8Array, maxPayload = PACKET_MAX): Uint8Array[] {
  const chunk = maxPayload - 1;
  const payloads: Uint8Array[] = [];
  for (let pos = 0; pos < frame.length || pos === 0; pos += chunk) {
    const part = frame.subarray(pos, pos + chunk);
    const payload = new Uint8Array(part.length + 1);
    payload[0] = pos === 0 ? 0x10 : 0x00; // S bit on the first packet, partition 0
    payload.set(part, 1);
    payloads.push(payload);
    if (frame.length === 0) break;
  }
  return payloads;
}

/** Split an H.264 access unit (Annex B) into RTP payloads (RFC 6184, FU-A for large NALs). */
export function h264Packetize(accessUnit: Uint8Array, maxPayload = PACKET_MAX): Uint8Array[] {
  const payloads: Uint8Array[] = [];
  for (const nal of splitAnnexB(accessUnit)) {
    if (nal.length <= maxPayload) {
      payloads.push(nal);
      continue;
    }
    const nalHeader = nal[0]!;
    const indicator = (nalHeader & 0xe0) | 28;
    const type = nalHeader & 0x1f;
    const body = nal.subarray(1);
    const chunk = maxPayload - 2;
    for (let pos = 0; pos < body.length; pos += chunk) {
      const part = body.subarray(pos, pos + chunk);
      const start = pos === 0 ? 0x80 : 0;
      const end = pos + chunk >= body.length ? 0x40 : 0;
      const payload = new Uint8Array(part.length + 2);
      payload[0] = indicator;
      payload[1] = start | end | type;
      payload.set(part, 2);
      payloads.push(payload);
    }
  }
  return payloads;
}

/** Packetize a frame of `codec`, or throw if the codec is unknown. */
export function packetize(codec: string, frame: Uint8Array): Uint8Array[] {
  switch (codec.toUpperCase()) {
    case "VP8":
      return vp8Packetize(frame);
    case "H264":
      return h264Packetize(frame);
    default:
      throw new Error(`Cannot packetize ${codec}`);
  }
}

// ---------------------------------------------------------------------------
// Pixel formats

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function yuvToRgb(
  out: Uint8Array,
  o: number,
  y: number,
  u: number,
  v: number,
  fullRange: boolean,
): void {
  // BT.601, as OpenCV's COLOR_YUV2RGB_* conversions.
  const c = fullRange ? y : 1.164 * (y - 16);
  const d = u - 128;
  const e = v - 128;
  out[o] = clamp8(Math.round(c + 1.596 * e));
  out[o + 1] = clamp8(Math.round(c - 0.392 * d - 0.813 * e));
  out[o + 2] = clamp8(Math.round(c + 2.017 * d));
}

/**
 * Convert a frame's pixels to packed RGB (what upstream does with OpenCV).
 *
 * @throws Error for a format with no conversion.
 */
export function convertToRgb(array: VideoFrameArray, formatName: string): Uint8Array {
  const { data, width, height } = array;
  if (formatName.startsWith("rgb")) return data;
  const out = new Uint8Array(width * height * 3);
  switch (formatName) {
    case "yuv420p":
    case "yuvj420p": {
      const full = formatName === "yuvj420p";
      const cw = width >> 1;
      const uOff = width * height;
      const vOff = uOff + cw * (height >> 1);
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          const ci = (row >> 1) * cw + (col >> 1);
          yuvToRgb(
            out,
            (row * width + col) * 3,
            data[row * width + col]!,
            data[uOff + ci]!,
            data[vOff + ci]!,
            full,
          );
        }
      }
      return out;
    }
    case "nv12": {
      const uvOff = width * height;
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          const ci = uvOff + (row >> 1) * width + (col & ~1);
          yuvToRgb(
            out,
            (row * width + col) * 3,
            data[row * width + col]!,
            data[ci]!,
            data[ci + 1]!,
            false,
          );
        }
      }
      return out;
    }
    case "gray": {
      for (let i = 0; i < width * height; i++) {
        out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = data[i]!;
      }
      return out;
    }
    default:
      throw new Error(`Unsupported format: ${formatName}`);
  }
}
