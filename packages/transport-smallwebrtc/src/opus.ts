// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Opus for the SmallWebRTC transport, behind a small interface.
 *
 * aiortc encodes and decodes Opus with PyAV (FFmpeg's libopus). Here the
 * default codec is [libopus-wasm](https://www.npmjs.com/package/libopus-wasm),
 * libopus compiled to WebAssembly, so no native code is needed. Pass your own
 * `OpusCodec` (e.g. a native binding) with `setOpusCodec()`.
 *
 * PCM is 16-bit signed, interleaved.
 */

import { Application, createDecoder, createEncoder, type SampleRate } from "libopus-wasm";

/** The sample rates libopus encodes from and decodes to directly. */
export const OPUS_SAMPLE_RATES: readonly number[] = [8000, 12000, 16000, 24000, 48000];

/** The RTP clock rate of Opus, whatever the audio's sample rate (RFC 7587). */
export const OPUS_RTP_CLOCK_RATE = 48000;

/** Whether libopus works at `sampleRate` without resampling. */
export function isOpusSampleRate(sampleRate: number): boolean {
  return OPUS_SAMPLE_RATES.includes(sampleRate);
}

/** An Opus encoder for one stream. */
export interface OpusEncoder {
  readonly sampleRate: number;
  readonly channels: number;
  /** Encode one frame (2.5 to 60 ms of interleaved PCM) into one Opus packet. */
  encode(pcm: Int16Array): Uint8Array;
  free(): void;
}

/** An Opus decoder for one stream. */
export interface OpusDecoder {
  readonly sampleRate: number;
  readonly channels: number;
  /**
   * Decode a packet into interleaved PCM.
   *
   * @param options.fec Decode the in-band forward error correction data the
   *   packet carries for the packet before it, instead of the packet itself.
   * @param options.frameSize Samples per channel to produce; required with `fec`.
   */
  decode(packet: Uint8Array, options?: { fec?: boolean; frameSize?: number }): Int16Array;
  /** Conceal a lost packet (packet loss concealment), `frameSize` samples per channel. */
  decodePacketLoss(frameSize: number): Int16Array;
  free(): void;
}

export interface OpusEncoderOptions {
  sampleRate: number;
  channels: number;
  /** Bits per second. */
  bitrate?: number;
}

export interface OpusDecoderOptions {
  sampleRate: number;
  channels: number;
}

/** Creates Opus encoders and decoders. */
export interface OpusCodec {
  createEncoder(options: OpusEncoderOptions): Promise<OpusEncoder>;
  createDecoder(options: OpusDecoderOptions): Promise<OpusDecoder>;
}

function asSampleRate(sampleRate: number): SampleRate {
  if (!isOpusSampleRate(sampleRate)) {
    throw new Error(`Opus does not support a sample rate of ${sampleRate} Hz`);
  }
  return sampleRate as SampleRate;
}

function asChannels(channels: number): 1 | 2 {
  if (channels !== 1 && channels !== 2) {
    throw new Error(`Opus supports 1 or 2 channels, not ${channels}`);
  }
  return channels;
}

/** The default `OpusCodec`: libopus compiled to WebAssembly (libopus-wasm). */
export const libopusWasmCodec: OpusCodec = {
  async createEncoder(options: OpusEncoderOptions): Promise<OpusEncoder> {
    const sampleRate = asSampleRate(options.sampleRate);
    const channels = asChannels(options.channels);
    const encoder = await createEncoder({
      sampleRate,
      channels,
      application: Application.Voip,
      bitrate: options.bitrate ?? "auto",
    });
    return {
      sampleRate,
      channels,
      encode: (pcm) => encoder.encode(pcm, { frameSize: pcm.length / channels }),
      free: () => encoder.free(),
    };
  },

  async createDecoder(options: OpusDecoderOptions): Promise<OpusDecoder> {
    const sampleRate = asSampleRate(options.sampleRate);
    const channels = asChannels(options.channels);
    const decoder = await createDecoder({ sampleRate, channels });
    return {
      sampleRate,
      channels,
      decode: (packet, opts = {}) =>
        opts.fec
          ? decoder.decode(packet, { decodeFec: true, frameSize: opts.frameSize })
          : decoder.decode(packet),
      decodePacketLoss: (frameSize) => decoder.decodePacketLoss(frameSize),
      free: () => decoder.free(),
    };
  },
};

let opusCodec: OpusCodec = libopusWasmCodec;

/** Use `codec` for every SmallWebRTC connection created from now on. */
export function setOpusCodec(codec: OpusCodec): void {
  opusCodec = codec;
}

/** The `OpusCodec` new connections use. */
export function getOpusCodec(): OpusCodec {
  return opusCodec;
}

// Frame durations, in 48 kHz samples, of the 32 TOC configurations (RFC 6716 §3.1).
const TOC_FRAME_SAMPLES_48K = [
  480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 480, 960, 120, 240,
  480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960,
];

/**
 * Samples per channel an Opus packet decodes to at `sampleRate`, read from
 * its TOC byte, or 0 for a malformed packet.
 */
export function opusPacketSamples(packet: Uint8Array, sampleRate: number): number {
  if (packet.length === 0) return 0;
  const toc = packet[0]!;
  const frameSamples = TOC_FRAME_SAMPLES_48K[toc >> 3]!;
  let frames: number;
  switch (toc & 0x3) {
    case 0:
      frames = 1;
      break;
    case 1:
    case 2:
      frames = 2;
      break;
    default:
      if (packet.length < 2) return 0;
      frames = packet[1]! & 0x3f;
  }
  return (frames * frameSamples * sampleRate) / OPUS_RTP_CLOCK_RATE;
}
