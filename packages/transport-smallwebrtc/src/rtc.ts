// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause AND BSD-3-Clause
//
// `TimestampMapper` is a port of aiortc's, Copyright (c) Jeremy Lainé,
// BSD-3-Clause (see THIRD_PARTY_LICENSES.md).

/**
 * An aiortc-shaped peer connection over [werift](https://github.com/shinyoshiaki/werift-webrtc).
 *
 * Upstream's SmallWebRTC is written against aiortc. werift is a pure
 * TypeScript WebRTC stack (ICE, DTLS, SRTP, SCTP, RTP/RTCP) but leaves media
 * codecs to the application, and its API is the browser's rather than
 * aiortc's. This module wraps it in the subset of aiortc's API upstream uses:
 *
 * - `RTCPeerConnection` emits `"datachannel"`, `"track"`,
 *   `"connectionstatechange"`, `"iceconnectionstatechange"` and
 *   `"icegatheringstatechange"`, and `setLocalDescription()` returns once ICE
 *   gathering completes, so the local description carries every candidate.
 * - `RTCRtpReceiver.track` is a `RemoteStreamTrack` whose `recv()` returns
 *   decoded frames: Opus audio is decoded with `OpusCodec` (with packet loss
 *   concealment and in-band FEC), video with an injected `VideoDecoder`.
 *   `receiver._enabled = false` discards incoming packets, as aiortc does.
 * - `RTCRtpSender.replaceTrack(track)` pulls frames from a local
 *   `MediaStreamTrack` and sends them: audio encoded to Opus in 20 ms packets,
 *   video with an injected `VideoEncoder`.
 *
 * RTCP (receiver reports, NACK for video, PLI) and RTX are werift's.
 */

import { createTask, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";
import {
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
  useH264,
  useVP8,
  type RTCDataChannel as WeriftDataChannel,
  MediaStreamTrack as WeriftMediaStreamTrack,
  RTCPeerConnection as WeriftPeerConnection,
  type RTCRtpReceiver as WeriftReceiver,
  type RTCRtpSender as WeriftSender,
  type RTCRtpTransceiver as WeriftTransceiver,
} from "werift";

import { AudioJitterBuffer, JitterBuffer, type JitterPacket } from "./jitter_buffer.ts";
import {
  AudioFrame,
  AudioResampler,
  EventEmitter,
  type MediaStreamTrack,
  RemoteStreamTrack,
} from "./media.ts";
import {
  getOpusCodec,
  isOpusSampleRate,
  OPUS_RTP_CLOCK_RATE,
  type OpusCodec,
  type OpusDecoder,
  type OpusEncoder,
  opusPacketSamples,
} from "./opus.ts";
import {
  depayload,
  isKeyframe,
  packetize,
  type VideoDecoder,
  type VideoDecoderFactory,
  type VideoEncoder,
  type VideoEncoderFactory,
  VideoFrame,
} from "./video.ts";

// werift takes Node `Buffer`s (Bun and Deno provide the global too).
const NodeBuffer = (globalThis as any).Buffer as {
  from(buffer: ArrayBufferLike, byteOffset?: number, length?: number): any;
};

// ---------------------------------------------------------------------------
// Descriptions and candidates

/** An SDP offer or answer. */
export class RTCSessionDescription {
  sdp: string;
  type: string;

  constructor(options: { sdp: string; type: string }) {
    this.sdp = options.sdp;
    this.type = options.type;
  }
}

/** A remote ICE candidate (aiortc's `RTCIceCandidate`). */
export class RTCIceCandidate {
  component: number;
  foundation: string;
  ip: string;
  port: number;
  priority: number;
  protocol: string;
  type: string;
  relatedAddress: string | null;
  relatedPort: number | null;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  tcpType: string | null;

  constructor(options: {
    component: number;
    foundation: string;
    ip: string;
    port: number;
    priority: number;
    protocol: string;
    type: string;
    relatedAddress?: string | null;
    relatedPort?: number | null;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    tcpType?: string | null;
  }) {
    this.component = options.component;
    this.foundation = options.foundation;
    this.ip = options.ip;
    this.port = options.port;
    this.priority = options.priority;
    this.protocol = options.protocol;
    this.type = options.type;
    this.relatedAddress = options.relatedAddress ?? null;
    this.relatedPort = options.relatedPort ?? null;
    this.sdpMid = options.sdpMid ?? null;
    this.sdpMLineIndex = options.sdpMLineIndex ?? null;
    this.tcpType = options.tcpType ?? null;
  }
}

/** Parse an `a=candidate` value, with or without the `candidate:` prefix (aiortc's `candidate_from_sdp`). */
export function candidateFromSdp(sdp: string): RTCIceCandidate {
  const bits = sdp
    .replace(/^(a=)?candidate:/, "")
    .trim()
    .split(/\s+/);
  if (bits.length < 8) throw new Error("SDP does not have enough properties");
  const options: ConstructorParameters<typeof RTCIceCandidate>[0] = {
    foundation: bits[0]!,
    component: Number(bits[1]),
    protocol: bits[2]!,
    priority: Number(bits[3]),
    ip: bits[4]!,
    port: Number(bits[5]),
    type: bits[7]!,
  };
  for (let i = 8; i + 1 < bits.length; i += 2) {
    const [key, value] = [bits[i]!, bits[i + 1]!];
    if (key === "raddr") options.relatedAddress = value;
    else if (key === "rport") options.relatedPort = Number(value);
    else if (key === "tcptype") options.tcpType = value;
  }
  return new RTCIceCandidate(options);
}

/** The SDP of a candidate, without the `candidate:` prefix (aiortc's `candidate_to_sdp`). */
export function candidateToSdp(c: RTCIceCandidate): string {
  let sdp = `${c.foundation} ${c.component} ${c.protocol} ${c.priority} ${c.ip} ${c.port} typ ${c.type}`;
  if (c.relatedAddress !== null) sdp += ` raddr ${c.relatedAddress}`;
  if (c.relatedPort !== null) sdp += ` rport ${c.relatedPort}`;
  if (c.tcpType !== null) sdp += ` tcptype ${c.tcpType}`;
  return sdp;
}

// ---------------------------------------------------------------------------
// Data channels

/** A data channel. Emits `"open"`, `"close"` and `"message"` (a string or `Uint8Array`). */
export class RTCDataChannel extends EventEmitter {
  readonly #native: WeriftDataChannel;

  constructor(native: WeriftDataChannel) {
    super();
    this.#native = native;
    native.stateChanged.subscribe((state) => {
      if (state === "open") this.emit("open");
      else if (state === "closed") this.emit("close");
    });
    native.onMessage.subscribe((message) => {
      this.emit(
        "message",
        typeof message === "string"
          ? message
          : new Uint8Array(message.buffer, message.byteOffset, message.byteLength),
      );
    });
  }

  /** The werift channel. */
  get native(): WeriftDataChannel {
    return this.#native;
  }

  get label(): string {
    return this.#native.label;
  }

  get readyState(): "connecting" | "open" | "closing" | "closed" {
    return this.#native.readyState;
  }

  send(data: string | Uint8Array): void {
    this.#native.send(
      typeof data === "string"
        ? data
        : NodeBuffer.from(data.buffer, data.byteOffset, data.byteLength),
    );
  }

  close(): void {
    this.#native.close();
  }
}

// ---------------------------------------------------------------------------
// Receiving

/** A received RTP packet, with the depayloaded data the jitter buffers assemble. */
export class RtpPacketInfo implements JitterPacket {
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  marker: boolean;
  ssrc: number;
  payload: Uint8Array;
  _data?: Uint8Array;

  constructor(options: {
    payloadType?: number;
    sequenceNumber?: number;
    timestamp?: number;
    marker?: boolean;
    ssrc?: number;
    payload?: Uint8Array;
  }) {
    this.payloadType = options.payloadType ?? 0;
    this.sequenceNumber = options.sequenceNumber ?? 0;
    this.timestamp = options.timestamp ?? 0;
    this.marker = options.marker ?? false;
    this.ssrc = options.ssrc ?? 0;
    this.payload = options.payload ?? new Uint8Array(0);
  }
}

/** Maps RTP timestamps to a count from the first one, across wraparounds (aiortc's `TimestampMapper`). */
class TimestampMapper {
  #last: number | null = null;
  #origin: number | null = null;

  map(timestamp: number): number {
    if (this.#origin === null) {
      this.#origin = timestamp;
    } else if (timestamp < this.#last!) {
      // RTP timestamp wrapped
      this.#origin -= 2 ** 32;
    }
    this.#last = timestamp;
    return timestamp - this.#origin;
  }
}

// How long a gap in the audio may hold the packets after it, at 48 kHz.
const AUDIO_JITTER_LATENCY = 0.06 * OPUS_RTP_CLOCK_RATE;
// The longest gap concealed, in packets; longer gaps are skipped.
const MAX_CONCEALED_PACKETS = 10;
// Packets kept while the Opus decoder loads.
const MAX_PENDING_AUDIO_PACKETS = 50;

let warnedNoVideoDecoder = false;

/** Options shared by a peer connection's receivers and senders. */
export interface MediaCodecOptions {
  /** The Opus implementation (default: `getOpusCodec()`). */
  opusCodec?: OpusCodec;
  /** Decodes the peer's video; without one, no video frames are produced. */
  videoDecoderFactory?: VideoDecoderFactory | null;
  /** Encodes video for the peer; without one, outgoing video frames are dropped. */
  videoEncoderFactory?: VideoEncoderFactory | null;
}

/**
 * Receives one media section's RTP and turns it into frames on `track`
 * (aiortc's `RTCRtpReceiver`).
 */
export class RTCRtpReceiver {
  /** Whether incoming packets are processed; disabled receivers drop them. */
  _enabled = true;
  readonly track: RemoteStreamTrack;
  /** Reassembles video frames. */
  _jitterBuffer: JitterBuffer;

  readonly #native: WeriftReceiver;
  readonly #transceiver: WeriftTransceiver;
  readonly #options: MediaCodecOptions;
  readonly #subscribed = new WeakSet<WeriftMediaStreamTrack>();
  readonly #timestamps = new TimestampMapper();
  #stopped = false;

  // audio
  #audioJitter = new AudioJitterBuffer<RtpPacketInfo>(AUDIO_JITTER_LATENCY);
  #decoder: OpusDecoder | null = null;
  #decoderLoading: Promise<void> | null = null;
  #pendingAudio: { packet: RtpPacketInfo | null; lost: number }[] = [];
  #outputRate = OPUS_RTP_CLOCK_RATE;
  #outputChannels = 2;
  #lastSamples = 960;

  // video
  #videoDecoder: VideoDecoder | null = null;
  #videoDecoderCodec: string | null = null;
  #videoQueue: { codec: string; data: Uint8Array; timestamp: number }[] = [];
  #videoTask: Task<unknown> | null = null;

  constructor(
    native: WeriftReceiver,
    transceiver: WeriftTransceiver,
    options: MediaCodecOptions = {},
  ) {
    this.#native = native;
    this.#transceiver = transceiver;
    this.#options = options;
    this.track = new RemoteStreamTrack(transceiver.kind === "audio" ? "audio" : "video");
    this._jitterBuffer =
      this.track.kind === "audio"
        ? new JitterBuffer({ capacity: 16, prefetch: 4 })
        : new JitterBuffer({ capacity: 128, isVideo: true });
    this._subscribe(native.track);
    for (const track of native.tracks) this._subscribe(track);
    transceiver.onTrack.subscribe((track) => this._subscribe(track));
  }

  /** The werift receiver. */
  get native(): WeriftReceiver {
    return this.#native;
  }

  /** The DTLS transport the receiver's packets arrive on. */
  get transport(): unknown {
    return this.#native.dtlsTransport;
  }

  /** @internal Feed RTP from a werift track into this receiver. */
  _subscribe(track: WeriftMediaStreamTrack | undefined): void {
    if (!track || this.#subscribed.has(track)) return;
    this.#subscribed.add(track);
    track.onReceiveRtp.subscribe((rtp) => {
      try {
        this._handleRtpPacket(
          new RtpPacketInfo({
            payloadType: rtp.header.payloadType,
            sequenceNumber: rtp.header.sequenceNumber,
            timestamp: rtp.header.timestamp,
            marker: rtp.header.marker,
            ssrc: rtp.header.ssrc,
            payload: new Uint8Array(
              rtp.payload.buffer,
              rtp.payload.byteOffset,
              rtp.payload.byteLength,
            ),
          }),
        );
      } catch (e) {
        rethrowIfCancelled(e);
        logger.debug(`RTCRtpReceiver: error handling RTP packet: ${e}`);
      }
    });
  }

  /**
   * Decode audio at this rate and channel count from now on, instead of
   * aiortc's 48 kHz stereo. Rates Opus doesn't decode to are ignored.
   */
  setAudioOutputFormat(sampleRate: number, channels: number): void {
    if (!isOpusSampleRate(sampleRate) || (channels !== 1 && channels !== 2)) return;
    if (sampleRate === this.#outputRate && channels === this.#outputChannels) return;
    this.#outputRate = sampleRate;
    this.#outputChannels = channels;
    this.#decoder?.free();
    this.#decoder = null;
    this.#decoderLoading = null;
  }

  /** @internal Handle an incoming RTP packet. */
  _handleRtpPacket(packet: RtpPacketInfo): void {
    // If the receiver is disabled, discard the packet.
    if (!this._enabled || this.#stopped) return;
    if (this.track.kind === "audio") this.#handleAudio(packet);
    else this.#handleVideo(packet);
  }

  #codecName(payloadType: number): string | null {
    const codec = this.#transceiver.codecs.find((c) => c.payloadType === payloadType);
    return codec ? codec.name : null;
  }

  // -- audio

  #handleAudio(packet: RtpPacketInfo): void {
    for (const out of this.#audioJitter.add(packet)) {
      if (out.packet) this.#decodeAudio(out.packet, 0);
      else this.#decodeAudio(null, out.lost);
    }
  }

  #ensureDecoder(): boolean {
    if (this.#decoder) return true;
    if (!this.#decoderLoading) {
      const rate = this.#outputRate;
      const channels = this.#outputChannels;
      const loading = (this.#options.opusCodec ?? getOpusCodec())
        .createDecoder({ sampleRate: rate, channels })
        .then((decoder) => {
          if (this.#decoderLoading !== loading || this.#stopped) {
            decoder.free();
            return;
          }
          this.#decoder = decoder;
          const pending = this.#pendingAudio;
          this.#pendingAudio = [];
          for (const p of pending) this.#decodeAudio(p.packet, p.lost);
        })
        .catch((e) => logger.error(`RTCRtpReceiver: cannot create the Opus decoder: ${e}`));
      this.#decoderLoading = loading;
    }
    return false;
  }

  #decodeAudio(packet: RtpPacketInfo | null, lost: number): void {
    if (!this.#ensureDecoder()) {
      if (this.#pendingAudio.length < MAX_PENDING_AUDIO_PACKETS)
        this.#pendingAudio.push({ packet, lost });
      return;
    }
    const decoder = this.#decoder!;
    if (packet === null) {
      // A gap: wait for the packet after it, whose FEC data may recover the last lost one.
      this.#pendingLoss += lost;
      return;
    }
    const frameSamples = opusPacketSamples(packet.payload, decoder.sampleRate) || this.#lastSamples;
    if (this.#pendingLoss > 0) {
      const lostPackets = this.#pendingLoss;
      this.#pendingLoss = 0;
      if (lostPackets <= MAX_CONCEALED_PACKETS) {
        const ts48 =
          (packet.timestamp -
            (lostPackets * (this.#lastSamples * OPUS_RTP_CLOCK_RATE)) / decoder.sampleRate) >>>
          0;
        for (let i = 0; i < lostPackets; i++) {
          let pcm: Int16Array;
          try {
            pcm =
              i === lostPackets - 1
                ? decoder.decode(packet.payload, { fec: true, frameSize: this.#lastSamples })
                : decoder.decodePacketLoss(this.#lastSamples);
          } catch (e) {
            rethrowIfCancelled(e);
            continue;
          }
          const ts =
            (ts48 + (i * this.#lastSamples * OPUS_RTP_CLOCK_RATE) / decoder.sampleRate) >>> 0;
          this.#pushAudio(pcm, ts);
        }
      }
    }
    let pcm: Int16Array;
    try {
      pcm = decoder.decode(packet.payload);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.debug(`RTCRtpReceiver: cannot decode Opus packet: ${e}`);
      return;
    }
    this.#lastSamples = frameSamples;
    this.#pushAudio(pcm, packet.timestamp);
  }

  #pendingLoss = 0;

  #pushAudio(pcm: Int16Array, rtpTimestamp: number): void {
    if (pcm.length === 0) return;
    const decoder = this.#decoder!;
    const frame = new AudioFrame({
      data: pcm,
      sampleRate: decoder.sampleRate,
      layout: decoder.channels === 2 ? "stereo" : "mono",
    });
    frame.pts = this.#timestamps.map(rtpTimestamp);
    frame.timeBase = 1 / OPUS_RTP_CLOCK_RATE;
    this.track._queue.putNowait(frame);
  }

  // -- video

  #handleVideo(packet: RtpPacketInfo): void {
    const codec = this.#codecName(packet.payloadType);
    if (codec === null) return;
    try {
      packet._data =
        packet.payload.length > 0 ? depayload(codec, packet.payload) : new Uint8Array(0);
    } catch (e) {
      rethrowIfCancelled(e);
      return;
    }
    const [pli, frame] = this._jitterBuffer.add(packet);
    if (pli) this.#sendPli(packet.ssrc);
    if (frame === null) return;
    const factory = this.#options.videoDecoderFactory;
    if (!factory) {
      if (!warnedNoVideoDecoder) {
        warnedNoVideoDecoder = true;
        logger.warning(
          "SmallWebRTC: video is being received but no video decoder is configured " +
            "(videoDecoderFactory), so no video frames will be produced.",
        );
      }
      return;
    }
    this.#videoQueue.push({
      codec,
      data: frame.data,
      timestamp: this.#timestamps.map(frame.timestamp),
    });
    if (this.#videoQueue.length > 30) this.#videoQueue.shift();
    if (!this.#videoTask || this.#videoTask.done()) {
      this.#videoTask = createTask(
        () => this.#runVideoDecoder(factory),
        "RTCRtpReceiver::video_decoder",
      );
    }
  }

  #sendPli(ssrc: number): void {
    this.#native.sendRtcpPLI(ssrc).catch(() => {});
  }

  async #runVideoDecoder(factory: VideoDecoderFactory): Promise<void> {
    while (this.#videoQueue.length > 0 && !this.#stopped) {
      const encoded = this.#videoQueue.shift()!;
      try {
        if (!this.#videoDecoder || this.#videoDecoderCodec !== encoded.codec) {
          this.#videoDecoder?.close?.();
          this.#videoDecoder = await factory(encoded.codec);
          this.#videoDecoderCodec = encoded.codec;
          if (!this.#videoDecoder) {
            logger.warning(
              `SmallWebRTC: the video decoder factory doesn't support ${encoded.codec}.`,
            );
            return;
          }
        }
        const frames = await this.#videoDecoder.decode({
          codec: encoded.codec,
          data: encoded.data,
          timestamp: encoded.timestamp,
          keyframe: isKeyframe(encoded.codec, encoded.data),
        });
        for (const f of frames) {
          if (f.pts === null) f.pts = encoded.timestamp;
          this.track._queue.putNowait(f);
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.debug(`RTCRtpReceiver: video decoding failed: ${e}`);
      }
    }
  }

  /** @internal Stop receiving: the track ends once its queued frames are read. */
  _stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#decoder?.free();
    this.#decoder = null;
    this.#videoTask?.cancel();
    this.#videoDecoder?.close?.();
    this.track._queue.putNowait(null);
  }

  getStats(): Promise<unknown> {
    return this.#native.getStats();
  }
}

// ---------------------------------------------------------------------------
// Sending

const AUDIO_PACKET_SECS = 0.02;
const OPUS_BITRATE = 96000; // aiortc's
let warnedNoVideoEncoder = false;

/**
 * Sends a local track's frames (aiortc's `RTCRtpSender`): pulls frames with
 * `track.recv()`, encodes them and sends RTP.
 */
export class RTCRtpSender {
  readonly #native: WeriftSender;
  readonly #kind: "audio" | "video";
  readonly #options: MediaCodecOptions;
  #track: MediaStreamTrack | null = null;
  #task: Task<unknown> | null = null;
  #rtpTrack: WeriftMediaStreamTrack | null = null;
  #sequenceNumber = Math.floor(Math.random() * 0x10000);
  #timestampOffset = Math.floor(Math.random() * 2 ** 32);
  #forceKeyframe = true;

  constructor(native: WeriftSender, kind: "audio" | "video", options: MediaCodecOptions = {}) {
    this.#native = native;
    this.#kind = kind;
    this.#options = options;
    native.onPictureLossIndication.subscribe(() => {
      this.#forceKeyframe = true;
    });
  }

  /** The werift sender. */
  get native(): WeriftSender {
    return this.#native;
  }

  /** The track being sent. */
  get track(): MediaStreamTrack | null {
    return this.#track;
  }

  /** Send `track`'s frames instead of the current track's. */
  replaceTrack(track: MediaStreamTrack | null): void {
    if (this.#task) {
      this.#task.cancel();
      this.#task = null;
    }
    this.#track = track;
    if (!track) return;
    if (!this.#rtpTrack) {
      this.#rtpTrack = new WeriftMediaStreamTrack({ kind: this.#kind });
      this.#native.replaceTrack(this.#rtpTrack).catch((e) => {
        logger.error(`RTCRtpSender: cannot attach the RTP track: ${e}`);
      });
    }
    this.#task = createTask(
      () => (this.#kind === "audio" ? this.#runAudio(track) : this.#runVideo(track)),
      `RTCRtpSender::run_${this.#kind}`,
    );
  }

  #send(payload: Uint8Array, timestamp: number, marker: boolean): void {
    this.#sequenceNumber = (this.#sequenceNumber + 1) & 0xffff;
    const header = new RtpHeader({
      payloadType: this.#native.codec?.payloadType ?? 0,
      sequenceNumber: this.#sequenceNumber,
      timestamp: (timestamp + this.#timestampOffset) >>> 0,
      marker,
    });
    this.#rtpTrack?.writeRtp(
      new RtpPacket(
        header,
        NodeBuffer.from(payload.buffer, payload.byteOffset, payload.byteLength),
      ),
    );
  }

  async #runAudio(track: MediaStreamTrack): Promise<void> {
    const codec = this.#options.opusCodec ?? getOpusCodec();
    let encoder: OpusEncoder | null = null;
    let resampler: AudioResampler | null = null;
    let pending = new Int16Array(0);
    let samplesSent = 0;
    try {
      for (;;) {
        const frame = await track.recv();
        if (!(frame instanceof AudioFrame)) continue;
        let input = frame;
        const encRate = isOpusSampleRate(frame.sampleRate) ? frame.sampleRate : OPUS_RTP_CLOCK_RATE;
        if (encRate !== frame.sampleRate) {
          resampler ??= new AudioResampler("s16", frame.layout.name, encRate);
          const frames = await resampler.resample(frame);
          if (frames.length === 0) continue;
          input = frames[0]!;
        }
        const channels = input.layout.channels;
        if (!encoder || encoder.sampleRate !== encRate || encoder.channels !== channels) {
          encoder?.free();
          encoder = await codec.createEncoder({
            sampleRate: encRate,
            channels,
            bitrate: OPUS_BITRATE,
          });
          pending = new Int16Array(0);
        }
        const merged = new Int16Array(pending.length + input.data.length);
        merged.set(pending);
        merged.set(input.data, pending.length);
        pending = merged;
        const packetSamples = Math.round(encRate * AUDIO_PACKET_SECS) * channels;
        while (pending.length >= packetSamples) {
          const chunk = pending.subarray(0, packetSamples);
          const packet = encoder.encode(chunk.slice());
          pending = pending.slice(packetSamples);
          const timestamp = Math.round((samplesSent * OPUS_RTP_CLOCK_RATE) / encRate);
          samplesSent += packetSamples / channels;
          this.#send(packet, timestamp, true);
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if ((e as Error)?.name !== "MediaStreamError") {
        logger.error(`RTCRtpSender: error sending audio: ${e}`);
      }
    } finally {
      encoder?.free();
    }
  }

  async #runVideo(track: MediaStreamTrack): Promise<void> {
    let encoder: VideoEncoder | null = null;
    let encoderCodec: string | null = null;
    try {
      for (;;) {
        const frame = await track.recv();
        if (!(frame instanceof VideoFrame)) continue;
        const factory = this.#options.videoEncoderFactory;
        const codecName = this.#native.codec?.name;
        if (!factory || !codecName) {
          if (!factory && !warnedNoVideoEncoder) {
            warnedNoVideoEncoder = true;
            logger.warning(
              "SmallWebRTC: no video encoder is configured (videoEncoderFactory), " +
                "so outgoing video frames are dropped.",
            );
          }
          continue;
        }
        if (!encoder || encoderCodec !== codecName) {
          encoder?.close?.();
          encoder = await factory(codecName);
          encoderCodec = codecName;
          this.#forceKeyframe = true;
          if (!encoder) {
            logger.warning(`SmallWebRTC: the video encoder factory doesn't support ${codecName}.`);
            return;
          }
        }
        const keyframe = this.#forceKeyframe;
        this.#forceKeyframe = false;
        const data = await encoder.encode(frame, { keyframe });
        if (!data) continue;
        const payloads = packetize(codecName, data);
        const timestamp = Math.round((frame.pts ?? 0) * frame.timeBase * 90000);
        for (const [i, p] of payloads.entries())
          this.#send(p, timestamp, i === payloads.length - 1);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if ((e as Error)?.name !== "MediaStreamError") {
        logger.error(`RTCRtpSender: error sending video: ${e}`);
      }
    } finally {
      encoder?.close?.();
    }
  }

  /** @internal Stop sending. */
  _stop(): void {
    this.#task?.cancel();
    this.#task = null;
  }
}

// ---------------------------------------------------------------------------
// Transceivers

export type RTCRtpTransceiverDirection = "sendrecv" | "sendonly" | "recvonly" | "inactive";

/** A media section: a sender and a receiver (aiortc's `RTCRtpTransceiver`). */
export class RTCRtpTransceiver {
  readonly receiver: RTCRtpReceiver;
  readonly sender: RTCRtpSender;
  readonly #native: WeriftTransceiver;

  constructor(native: WeriftTransceiver, options: MediaCodecOptions = {}) {
    this.#native = native;
    const kind = native.kind === "audio" ? "audio" : "video";
    this.receiver = new RTCRtpReceiver(native.receiver, native, options);
    this.sender = new RTCRtpSender(native.sender, kind, options);
  }

  /** The werift transceiver. */
  get native(): WeriftTransceiver {
    return this.#native;
  }

  get kind(): "audio" | "video" {
    return this.#native.kind === "audio" ? "audio" : "video";
  }

  get mid(): string | null {
    return this.#native.mid;
  }

  get direction(): RTCRtpTransceiverDirection {
    return this.#native.direction as RTCRtpTransceiverDirection;
  }

  set direction(direction: RTCRtpTransceiverDirection) {
    this.#native.setDirection(direction);
  }

  get currentDirection(): string | null {
    return this.#native.currentDirection ?? null;
  }
}

// ---------------------------------------------------------------------------
// Peer connection

/** An ICE server (aiortc's `RTCIceServer`). */
export class RTCIceServer {
  urls: string | string[];
  username: string | null;
  credential: string | null;

  constructor(options: {
    urls: string | string[];
    username?: string | null;
    credential?: string | null;
  }) {
    this.urls = options.urls;
    this.username = options.username ?? null;
    this.credential = options.credential ?? null;
  }
}

/** The SCTP DATA chunk header plus the SCTP common header, in bytes. */
const SCTP_OVERHEAD = 12 + 16;

export interface RTCConfiguration extends MediaCodecOptions {
  iceServers?: RTCIceServer[];
  bundlePolicy?: "balanced" | "max-compat" | "max-bundle";
  /**
   * The largest SCTP DATA chunk payload, in bytes. Large data channel
   * messages are fragmented into chunks of at most this size.
   */
  sctpMaxChunkSize?: number;
  /** Extra werift `PeerConfig` fields (e.g. `icePortRange`, `iceAdditionalHostAddresses`). */
  werift?: Record<string, unknown>;
}

function isMdnsCandidate(candidate: RTCIceCandidate | null): boolean {
  return candidate?.ip.endsWith(".local") ?? false;
}

/** A peer connection with aiortc's API (see the module docs). */
export class RTCPeerConnection extends EventEmitter {
  readonly #native: WeriftPeerConnection;
  readonly #options: MediaCodecOptions;
  readonly #transceivers = new Map<WeriftTransceiver, RTCRtpTransceiver>();
  readonly #pendingCandidates = new Set<Promise<void>>();
  #closed = false;

  constructor(config: RTCConfiguration = {}) {
    super();
    this.#options = {
      opusCodec: config.opusCodec,
      videoDecoderFactory: config.videoDecoderFactory ?? null,
      videoEncoderFactory: config.videoEncoderFactory ?? null,
    };
    const iceServers = (config.iceServers ?? []).map((s) => ({
      urls: s.urls,
      ...(s.username !== null ? { username: s.username } : {}),
      ...(s.credential !== null ? { credential: s.credential } : {}),
    }));
    this.#native = new WeriftPeerConnection({
      iceServers,
      bundlePolicy: config.bundlePolicy ?? "max-bundle",
      codecs: {
        audio: [
          new RTCRtpCodecParameters({
            mimeType: "audio/opus",
            clockRate: OPUS_RTP_CLOCK_RATE,
            channels: 2,
            parameters: "minptime=10;useinbandfec=1",
          }),
        ],
        video: [useVP8(), useH264()],
      },
      ...(config.sctpMaxChunkSize
        ? { sctp: { mtu: config.sctpMaxChunkSize + SCTP_OVERHEAD } }
        : {}),
      ...(config.werift ?? {}),
    } as any);

    const native = this.#native;
    native.onTransceiverAdded.subscribe((t) => this.#wrap(t));
    native.onRemoteTransceiverAdded.subscribe((t) => this.#wrap(t));
    native.onDataChannel.subscribe((channel) =>
      this.emit("datachannel", new RTCDataChannel(channel)),
    );
    native.connectionStateChange.subscribe(() => this.emit("connectionstatechange"));
    native.iceConnectionStateChange.subscribe(() => this.emit("iceconnectionstatechange"));
    native.iceGatheringStateChange.subscribe(() => this.emit("icegatheringstatechange"));
    native.onTrack.subscribe((track) => {
      const transceiver = native
        .getTransceivers()
        .find((t) => t.receiver.tracks.includes(track) || t.receiver.track === track);
      if (!transceiver) return;
      const wrapper = this.#wrap(transceiver);
      wrapper.receiver._subscribe(track);
      this.emit("track", wrapper.receiver.track);
    });
  }

  #wrap(native: WeriftTransceiver): RTCRtpTransceiver {
    let wrapper = this.#transceivers.get(native);
    if (!wrapper) {
      wrapper = new RTCRtpTransceiver(native, this.#options);
      this.#transceivers.set(native, wrapper);
    }
    return wrapper;
  }

  /** The werift peer connection. */
  get native(): WeriftPeerConnection {
    return this.#native;
  }

  get connectionState(): string {
    return this.#native.connectionState;
  }

  get iceConnectionState(): string {
    return this.#native.iceConnectionState;
  }

  get iceGatheringState(): string {
    return this.#native.iceGatheringState;
  }

  get signalingState(): string {
    return this.#native.signalingState;
  }

  get localDescription(): RTCSessionDescription | null {
    const d = this.#native.localDescription;
    return d ? new RTCSessionDescription({ sdp: d.sdp, type: d.type }) : null;
  }

  get remoteDescription(): RTCSessionDescription | null {
    const d = this.#native.remoteDescription;
    return d ? new RTCSessionDescription({ sdp: d.sdp, type: d.type }) : null;
  }

  /** The transceivers, in media section order. */
  getTransceivers(): RTCRtpTransceiver[] {
    return this.#native.getTransceivers().map((t) => this.#wrap(t));
  }

  addTransceiver(
    kind: "audio" | "video",
    options: { direction?: RTCRtpTransceiverDirection } = {},
  ): RTCRtpTransceiver {
    return this.#wrap(
      this.#native.addTransceiver(kind, { direction: options.direction ?? "sendrecv" }),
    );
  }

  createDataChannel(
    label: string,
    options: { ordered?: boolean; protocol?: string } = {},
  ): RTCDataChannel {
    return new RTCDataChannel(this.#native.createDataChannel(label, options));
  }

  async createOffer(): Promise<RTCSessionDescription> {
    const d = await this.#native.createOffer();
    return new RTCSessionDescription({ sdp: d.sdp, type: d.type });
  }

  async createAnswer(): Promise<RTCSessionDescription> {
    const d = await this.#native.createAnswer();
    return new RTCSessionDescription({ sdp: d.sdp, type: d.type });
  }

  /** Apply a local description and wait for ICE gathering to complete, as aiortc does. */
  async setLocalDescription(description: RTCSessionDescription): Promise<void> {
    await this.#native.setLocalDescription({
      sdp: description.sdp,
      type: description.type as "offer",
    });
    if (this.#native.iceGatheringState !== "complete") {
      await new Promise<void>((resolve) => {
        const sub = this.#native.iceGatheringStateChange.subscribe((state) => {
          if (state === "complete") {
            sub.unSubscribe();
            resolve();
          }
        });
        if (this.#native.iceGatheringState === "complete") {
          sub.unSubscribe();
          resolve();
        }
      });
    }
  }

  async setRemoteDescription(description: RTCSessionDescription): Promise<void> {
    await this.#native.setRemoteDescription({
      sdp: description.sdp,
      type: description.type as "offer",
    });
  }

  /**
   * Add a remote candidate, or `null` for end-of-candidates.
   *
   * Resolving an mDNS (`.local`) host candidate can take about a second, so
   * those are added in the background, and an end-of-candidates marker waits
   * behind them; the call returns at once.
   */
  async addIceCandidate(candidate: RTCIceCandidate | null): Promise<void> {
    const add = (): Promise<void> =>
      this.#native.addIceCandidate(
        candidate === null
          ? null
          : {
              candidate: `candidate:${candidateToSdp(candidate)}`,
              sdpMid: candidate.sdpMid ?? undefined,
              sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
            },
      );
    const background = (run: () => Promise<void>): void => {
      const p = run()
        .catch((e) => logger.warning(`RTCPeerConnection: cannot add ICE candidate: ${e}`))
        .finally(() => this.#pendingCandidates.delete(p));
      this.#pendingCandidates.add(p);
    };
    if (isMdnsCandidate(candidate)) {
      background(add);
    } else if (candidate === null && this.#pendingCandidates.size > 0) {
      const pending = [...this.#pendingCandidates];
      background(async () => {
        await Promise.allSettled(pending);
        await add();
      });
    } else {
      await add();
    }
  }

  restartIce(): void {
    this.#native.restartIce();
  }

  getStats(): Promise<Map<string, any>> {
    return this.#native.getStats() as unknown as Promise<Map<string, any>>;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const t of this.#transceivers.values()) {
      t.sender._stop();
      t.receiver._stop();
    }
    await this.#native.close();
  }
}
