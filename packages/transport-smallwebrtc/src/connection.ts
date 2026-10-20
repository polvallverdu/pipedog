// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/smallwebrtc/connection.py

/**
 * Small WebRTC connection implementation for Pipecat.
 *
 * This module provides a WebRTC connection implementation using werift (in
 * place of aiortc, through the aiortc-shaped adapter in `rtc.ts`), with
 * support for audio/video tracks, data channels, and signaling for real-time
 * communication applications.
 */

import { createTask, rethrowIfCancelled, sleep, type Task, time } from "@pipedog/asyncio";
import { BaseObject } from "@pipedog/core/utils/base_object";
import { getEnv } from "@pipedog/core/utils/env";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";

import { JitterBuffer } from "./jitter_buffer.ts";
import { type AudioFrame, type MediaStreamTrack, RemoteStreamTrack } from "./media.ts";
import type { OpusCodec } from "./opus.ts";
import {
  type RTCDataChannel,
  type RTCIceCandidate,
  RTCIceServer,
  RTCPeerConnection,
  type RTCRtpReceiver,
  RTCSessionDescription,
} from "./rtc.ts";
import type { VideoDecoderFactory, VideoEncoderFactory, VideoFrame } from "./video.ts";

/**
 * Packets the screen share receiver's jitter buffer holds, which bounds the
 * size of a frame it can assemble. aiortc's 128 packets (about 150 KB) is
 * smaller than a keyframe of a detailed, high-resolution screen share, so such
 * a keyframe is dropped, the next keyframe requested is as large, and no frame
 * ever decodes. 512 packets, libwebrtc's initial packet buffer size, fit frames
 * of about 600 KB. The capacity doesn't delay frames, but it is how many packets
 * arrive before a lost one is given up on, so the camera keeps the default.
 */
export const SCREEN_VIDEO_JITTER_BUFFER_CAPACITY = 512;

/**
 * Clamp the SCTP DATA-chunk payload size so the on-wire UDP packet fits
 * inside the smallest-MTU path we're likely to see (IPv6 minimum 1280,
 * Tailscale overlays default to 1280, some consumer VPNs are lower).
 *
 * 1100 bytes brings the worst-case datagram (SCTP 28 + DTLS/GCM ~29 + UDP 8 +
 * IPv6 40 headers) to ~1205 bytes, ~75 bytes of slack. Throughput cost is
 * negligible: RTVI control frames fragment across one extra chunk at most, and
 * audio uses RTP (a separate path). Override with `PIPECAT_SCTP_MAX_CHUNK_SIZE`.
 *
 * Porting note: upstream patches aiortc's `USERDATA_MAX_LENGTH` (1200 by
 * default, which overflows a 1280 MTU). werift fragments at its configurable
 * SCTP MTU (1191 bytes of SCTP packet, which already fits); it is set so the
 * DATA chunk payload is this size, keeping upstream's margin.
 */
const _SCTP_MAX_CHUNK_SIZE_DEFAULT = 1100;
function sctpMaxChunkSize(): number {
  const value = getEnv("PIPECAT_SCTP_MAX_CHUNK_SIZE");
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : _SCTP_MAX_CHUNK_SIZE_DEFAULT;
}

export const SIGNALLING_TYPE = "signalling";
export const AUDIO_TRANSCEIVER_INDEX = 0;
export const VIDEO_TRANSCEIVER_INDEX = 1;
export const SCREEN_VIDEO_TRANSCEIVER_INDEX = 2;

/** Maximum number of messages to queue while the data channel is not yet open. */
export const MAX_MESSAGE_QUEUE_SIZE = 50;
/** Seconds to wait for the data channel to open after the peer connection is established. */
export const DATA_CHANNEL_TIMEOUT_SECS = 10;

/** Raised when a signalling message doesn't match its schema (pydantic's `ValidationError`). */
export class SignallingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignallingValidationError";
  }
}

/**
 * Message for updating track enabled/disabled status.
 *
 * - `type`: Message type identifier.
 * - `receiver_index`: Index of the track receiver to update.
 * - `enabled`: Whether the track should be enabled or disabled.
 */
export class TrackStatusMessage {
  readonly type = "trackStatus" as const;
  receiver_index: number;
  enabled: boolean;

  constructor(options: { receiver_index: number; enabled: boolean }) {
    this.receiver_index = options.receiver_index;
    this.enabled = options.enabled;
  }

  /** Validate a received message (pydantic's `model_validate`). */
  static validate(message: unknown): TrackStatusMessage {
    const m = message as Record<string, unknown> | null;
    if (typeof m !== "object" || m === null) {
      throw new SignallingValidationError("TrackStatusMessage: expected an object");
    }
    if (m.type !== "trackStatus") {
      throw new SignallingValidationError(
        `TrackStatusMessage: type must be 'trackStatus', got ${pyJsonDumps(m.type)}`,
      );
    }
    if (!Number.isInteger(m.receiver_index)) {
      throw new SignallingValidationError("TrackStatusMessage: receiver_index must be an integer");
    }
    if (typeof m.enabled !== "boolean") {
      throw new SignallingValidationError("TrackStatusMessage: enabled must be a boolean");
    }
    return new TrackStatusMessage({
      receiver_index: m.receiver_index as number,
      enabled: m.enabled,
    });
  }

  modelDump(): Record<string, unknown> {
    return { type: this.type, receiver_index: this.receiver_index, enabled: this.enabled };
  }
}

/** Message requesting WebRTC renegotiation. */
export class RenegotiateMessage {
  readonly type = "renegotiate" as const;

  modelDump(): Record<string, unknown> {
    return { type: this.type };
  }
}

/** Message indicating a peer has left the connection. */
export class PeerLeftMessage {
  readonly type = "peerLeft" as const;

  modelDump(): Record<string, unknown> {
    return { type: this.type };
  }
}

/**
 * Union types for signaling message handling.
 *
 * - `Inbound`: Types of messages that can be received from peers.
 * - `outbound`: Types of messages that can be sent to peers.
 */
export const SignallingMessage = {
  Inbound: TrackStatusMessage, // in case we need to add new messages in the future
  outbound: RenegotiateMessage,
} as const;

/**
 * Wrapper for WebRTC media tracks with enabled/disabled state management.
 *
 * Provides additional functionality on top of the remote MediaStreamTrack
 * including enable/disable control and frame discarding for audio and video
 * streams.
 */
export class SmallWebRTCTrack {
  protected _receiver: RTCRtpReceiver;
  protected _track: MediaStreamTrack;
  protected _enabled = true;
  protected _lastRecvTime = 0.0;
  protected _idleTask: Task<unknown> | null = null;
  protected _idleTimeout = 2.0; // seconds before discarding old frames

  /**
   * Initialize the WebRTC track wrapper.
   *
   * @param receiver The RTCRtpReceiver instance.
   * @param jitterBufferCapacity Packets the video receiver's jitter buffer
   *   holds, or null for the default.
   */
  constructor(receiver: RTCRtpReceiver, jitterBufferCapacity: number | null = null) {
    this._receiver = receiver;
    // Configuring the receiver for not consuming the track by default to prevent memory grow
    this._receiver._enabled = false;
    if (jitterBufferCapacity !== null) {
      receiver._jitterBuffer = new JitterBuffer({ capacity: jitterBufferCapacity, isVideo: true });
    }
    this._track = receiver.track;
  }

  /** The kind of the underlying track. */
  get kind(): "audio" | "video" {
    return this._track.kind;
  }

  /** The id of the underlying track. */
  get id(): string {
    return this._track.id;
  }

  /** The state of the underlying track. */
  get readyState(): "live" | "ended" {
    return this._track.readyState;
  }

  /**
   * Enable or disable the track.
   *
   * @param enabled Whether the track should be enabled for receiving frames.
   */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  /** Whether the track is currently enabled for receiving frames. */
  isEnabled(): boolean {
    return this._enabled;
  }

  /**
   * Decode audio at this rate and channel count, when Opus decodes to it
   * directly, so frames need no resampling.
   *
   * Porting note: aiortc always decodes to 48 kHz stereo; this lets the
   * transport decode straight to the pipeline's input format.
   */
  setAudioOutputFormat(sampleRate: number, channels: number): void {
    this._receiver.setAudioOutputFormat?.(sampleRate, channels);
  }

  /** Discard old frames from the track queue to reduce latency. */
  async discardOldFrames(): Promise<void> {
    const remoteTrack = this._track;
    if (remoteTrack instanceof RemoteStreamTrack) {
      logger.debug("Discarding old frames");
      while (!remoteTrack._queue.empty()) {
        remoteTrack._queue.getNowait(); // Remove the oldest frame
        remoteTrack._queue.taskDone();
      }
    }
  }

  /**
   * Receive the next frame from the track.
   *
   * Enables the internal receiving state and starts idle watcher.
   *
   * @returns The next frame, except for video tracks, where it returns the
   *   frame only if the track is enabled, otherwise null.
   */
  async recv(): Promise<AudioFrame | VideoFrame | null> {
    this._receiver._enabled = true;
    this._lastRecvTime = time();

    // start idle watcher if not already running
    if (!this._idleTask || this._idleTask.done()) {
      this._idleTask = createTask(() => this._idleWatcher(), "SmallWebRTCTrack::idle_watcher");
    }

    if (!this._enabled && this._track.kind === "video") {
      return null;
    }
    return await this._track.recv();
  }

  /** Disable receiving if idle for more than `_idleTimeout` and monitor queue size. */
  protected async _idleWatcher(): Promise<void> {
    while (this._receiver._enabled) {
      await sleep(this._idleTimeout);
      const idleDuration = time() - this._lastRecvTime;
      if (idleDuration >= this._idleTimeout) {
        // discard old frames to prevent memory growth
        logger.debug(
          `Disabling receiver for ${this._track.kind} track after ${idleDuration.toFixed(2)}s idle`,
        );
        await this.discardOldFrames();
        this._receiver._enabled = false;
      }
    }
  }

  /** Stop receiving frames from the track. */
  stop(): void {
    this._receiver._enabled = false;
    if (this._idleTask) {
      this._idleTask.cancel();
      this._idleTask = null;
    }
    if (this._track) {
      this._track.stop();
    }
  }
}

/**
 * An ICE server (aiortc's `RTCIceServer`, which upstream aliases as `IceServer`).
 *
 * @example
 * new IceServer({ urls: "turn:turn.example.com", username: "u", credential: "p" })
 */
export const IceServer = RTCIceServer;
export type IceServer = RTCIceServer;

export interface SmallWebRTCConnectionOptions {
  /** ICE servers as URLs or IceServer objects. */
  iceServers?: string[] | IceServer[] | null;
  /** Timeout in seconds for connecting to the peer. */
  connectionTimeoutSecs?: number;
  /** pipedog: decodes the peer's camera and screen share (none by default; see `video.ts`). */
  videoDecoderFactory?: VideoDecoderFactory | null;
  /** pipedog: encodes video sent to the peer (none by default; see `video.ts`). */
  videoEncoderFactory?: VideoEncoderFactory | null;
  /** pipedog: the Opus implementation (default: libopus-wasm). */
  opusCodec?: OpusCodec;
  /** pipedog: extra werift `PeerConfig` fields (e.g. `icePortRange`). */
  werift?: Record<string, unknown>;
}

type TrackGetter = () => SmallWebRTCTrack | null;

/**
 * WebRTC connection implementation using werift.
 *
 * Provides WebRTC peer connection functionality including ICE server
 * configuration, track management, data channel communication, and
 * connection state handling for real-time audio/video communication.
 *
 * Event handlers available: `app-message`, `track-started`, `track-ended`,
 * `track-status`, `connecting`, `connected`, `disconnected`, `closed`,
 * `failed`, `new`.
 */
export class SmallWebRTCConnection extends BaseObject {
  iceServers: IceServer[];
  connectionTimeoutSecs: number;
  protected _options: SmallWebRTCConnectionOptions;
  protected _connectInvoked = false;
  protected _trackMap = new Map<number, SmallWebRTCTrack | null>();
  protected _trackGetters: Record<number, TrackGetter>;

  _pc!: RTCPeerConnection;
  protected _pcId!: string;
  protected _answer: RTCSessionDescription | null = null;
  protected _dataChannel: RTCDataChannel | null = null;
  protected _renegotiationInProgress = false;
  protected _renegotiationTask: Task<unknown> | null = null;
  protected _lastReceivedTime: number | null = null;
  _outgoingMessagesQueue: string[] = [];
  protected _dataChannelEnabled = true;
  protected _pendingAppMessages: unknown[] = [];
  protected _connectingTimeoutTask: Task<unknown> | null = null;
  protected _dataChannelTimeoutTask: Task<unknown> | null = null;

  /**
   * Initialize the WebRTC connection.
   *
   * @throws TypeError If iceServers contains mixed types or unsupported types.
   */
  constructor(options: SmallWebRTCConnectionOptions = {}) {
    super();
    const iceServers = options.iceServers;
    if (!iceServers || iceServers.length === 0) {
      this.iceServers = [];
    } else if ((iceServers as unknown[]).every((s) => s instanceof IceServer)) {
      this.iceServers = iceServers as IceServer[];
    } else if ((iceServers as unknown[]).every((s) => typeof s === "string")) {
      this.iceServers = (iceServers as string[]).map((s) => new IceServer({ urls: s }));
    } else {
      throw new TypeError("ice_servers must be either List[str] or List[RTCIceServer]");
    }
    this._options = options;
    this._trackGetters = {
      [AUDIO_TRANSCEIVER_INDEX]: () => this.audioInputTrack(),
      [VIDEO_TRANSCEIVER_INDEX]: () => this.videoInputTrack(),
      [SCREEN_VIDEO_TRANSCEIVER_INDEX]: () => this.screenVideoInputTrack(),
    };
    this.connectionTimeoutSecs = options.connectionTimeoutSecs ?? 60;

    this._initialize();

    // Register supported handlers. The user will only be able to register
    // these handlers.
    this._registerEventHandler("app-message");
    this._registerEventHandler("track-started");
    this._registerEventHandler("track-ended");
    this._registerEventHandler("track-status");
    // connection states
    this._registerEventHandler("connecting");
    this._registerEventHandler("connected");
    this._registerEventHandler("disconnected");
    this._registerEventHandler("closed");
    this._registerEventHandler("failed");
    this._registerEventHandler("new");
  }

  /** The underlying RTCPeerConnection. */
  get pc(): RTCPeerConnection {
    return this._pc;
  }

  /** The unique identifier for this peer connection. */
  get pcId(): string {
    return this._pcId;
  }

  /** Initialize the peer connection and associated components. */
  protected _initialize(): void {
    logger.debug("Initializing new peer connection");
    // With the balanced policy, the screen share's transceiver is left off the
    // bundled transport, so its packets never reach it.
    this._answer = null;
    this._pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      bundlePolicy: "max-bundle",
      sctpMaxChunkSize: sctpMaxChunkSize(),
      videoDecoderFactory: this._options.videoDecoderFactory ?? null,
      videoEncoderFactory: this._options.videoEncoderFactory ?? null,
      opusCodec: this._options.opusCodec,
      werift: this._options.werift,
    });
    this._pcId = `${this.name}-${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
    this._setupListeners();
    this._dataChannel = null;
    this._renegotiationInProgress = false;
    this._lastReceivedTime = null;
    this._outgoingMessagesQueue = [];
    this._dataChannelEnabled = true;
    this._pendingAppMessages = [];
    this._connectingTimeoutTask = null;
    this._dataChannelTimeoutTask = null;
  }

  /** Set up event listeners for the peer connection. */
  protected _setupListeners(): void {
    this._pc.on("datachannel", (channel: RTCDataChannel) => {
      this._dataChannel = channel;

      // A channel created by the remote peer may already be open when
      // "datachannel" is emitted, so no "open" event will follow — flush
      // immediately in that case.
      if (channel.readyState === "open") {
        this._flushMessageQueue();
      }

      // Flush queued messages once the data channel is open
      channel.on("open", async () => {
        logger.debug("Data channel is open!");
        this._flushMessageQueue();
      });

      channel.on("message", async (message: string | Uint8Array) => {
        try {
          // There is no way to be aware when we are disconnected, so we are
          // using this keep alive message as a way to implement that
          if (typeof message === "string" && message.startsWith("ping")) {
            this._lastReceivedTime = time();
          } else {
            const text = typeof message === "string" ? message : new TextDecoder().decode(message);
            const jsonMessage = JSON.parse(text);
            if (jsonMessage.type === SIGNALLING_TYPE && jsonMessage.message) {
              await this._handleSignallingMessage(jsonMessage.message);
            } else if (this.isConnected()) {
              await this._callEventHandler("app-message", jsonMessage);
            } else {
              logger.debug("Client not connected. Queuing app-message.");
              this._pendingAppMessages.push(jsonMessage);
            }
          }
        } catch (e) {
          rethrowIfCancelled(e);
          logger.error(`Error parsing JSON message ${message}, ${e}`);
        }
      });
    });

    this._pc.on("connectionstatechange", async () => {
      await this._handleNewConnectionState();
    });

    this._pc.on("iceconnectionstatechange", async () => {
      logger.debug(
        `ICE connection state is ${this._pc.iceConnectionState}, connection is ${this._pc.connectionState}`,
      );
    });

    this._pc.on("icegatheringstatechange", async () => {
      logger.debug(`ICE gathering state is ${this._pc.iceGatheringState}`);
    });

    this._pc.on("track", async (track: MediaStreamTrack) => {
      logger.debug(`Track ${track.kind} received`);
      await this._callEventHandler("track-started", track);

      track.on("ended", async () => {
        logger.debug(`Track ${track.kind} ended`);
        await this._callEventHandler("track-ended", track);
      });
    });
  }

  /** Create an SDP answer for the given offer. */
  protected async _createAnswer(sdp: string, type: string): Promise<void> {
    const offer = new RTCSessionDescription({ sdp, type });
    await this._pc.setRemoteDescription(offer);

    // The answering side does not take the transceivers to sendrecv on its
    // own, so we are forcing it to act this way.
    this.forceTransceiversToSendRecv();

    // Gathering completes in setLocalDescription, so the answer carries the candidates.
    logger.debug("Creating answer");
    const localAnswer = await this._pc.createAnswer();
    await this._pc.setLocalDescription(localAnswer);
    logger.debug("Setting the answer after the local description is created");
    this._answer = this._pc.localDescription;
  }

  /**
   * Initialize the connection with an SDP offer.
   *
   * @param sdp The SDP offer string.
   * @param type The SDP type (usually "offer").
   */
  async initialize(sdp: string, type: string): Promise<void> {
    await this._createAnswer(sdp, type);
  }

  /** Connect the WebRTC peer connection and handle initial setup. */
  async connect(): Promise<void> {
    this._connectInvoked = true;
    // If we already connected, trigger again the connected event
    if (this.isConnected()) {
      await this._callEventHandler("connected");
      logger.debug("Flushing pending app-messages");
      for (const message of this._pendingAppMessages) {
        await this._callEventHandler("app-message", message);
      }
      // We are renegotiating here, because likely we have lost the first video frames.
      const videoInputTrack = this.videoInputTrack();
      if (videoInputTrack) {
        await videoInputTrack.discardOldFrames();
      }
      const screenVideoInputTrack = this.screenVideoInputTrack();
      if (screenVideoInputTrack) {
        await screenVideoInputTrack.discardOldFrames();
      }
      if (videoInputTrack || screenVideoInputTrack) {
        // This prevents an issue where sometimes the WebRTC connection can be established
        // before the bot is ready to receive video. When that happens, we can lose a couple
        // of seconds of video before we received a key frame to finally start displaying it.
        this.askToRenegotiate();
      }
    }
  }

  /**
   * Renegotiate the WebRTC connection with new parameters.
   *
   * @param options.sdp The new SDP offer string.
   * @param options.type The SDP type (usually "offer").
   * @param options.restartPc Whether to restart the peer connection entirely.
   */
  async renegotiate(options: { sdp: string; type: string; restartPc?: boolean }): Promise<void> {
    logger.debug(`Renegotiating ${this._pcId}`);

    if (options.restartPc) {
      await this._callEventHandler("disconnected");
      logger.debug("Closing old peer connection");
      // removing the listeners to prevent the bot from closing
      this._pc.removeAllListeners();
      await this._close();
      // we are initializing a new peer connection in this case.
      this._initialize();
    }

    await this._createAnswer(options.sdp, options.type);

    // Maybe we should refactor to receive a message from the client side when the renegotiation is completed.
    // or look at the peer connection listeners
    // but this is good enough for now for testing.
    const delayedTask = async (): Promise<void> => {
      await sleep(2);
      this._renegotiationInProgress = false;
      // A renegotiation arriving inside the two seconds replaces this task.
      if (this._renegotiationTask === task) {
        this._renegotiationTask = null;
      }
    };

    // Held on this so the flag is always cleared.
    const task = createTask(delayedTask, "SmallWebRTCConnection::renegotiation");
    this._renegotiationTask = task;
  }

  /** Force all transceivers to bidirectional send/receive mode. */
  forceTransceiversToSendRecv(): void {
    const transceivers = this._pc.getTransceivers();
    // For now, we only support sendrecv for camera audio and video (the first two transceivers)
    transceivers.forEach((transceiver, i) => {
      if (i < 2) {
        // First two transceivers (camera audio and video)
        transceiver.direction = "sendrecv";
      } else {
        transceiver.direction = "recvonly";
      }
    });
  }

  /**
   * Replace the audio track in the first transceiver.
   *
   * @param track The new audio track to use for sending.
   */
  replaceAudioTrack(track: MediaStreamTrack): void {
    logger.debug(`Replacing audio track ${track.kind}`);
    // Transceivers always appear in creation-order for both peers
    const transceivers = this._pc.getTransceivers();
    if (transceivers.length > 0 && transceivers[0]!.sender) {
      transceivers[0]!.sender.replaceTrack(track);
    } else {
      logger.warning("Audio transceiver not found. Cannot replace audio track.");
    }
  }

  /**
   * Replace the video track in the second transceiver.
   *
   * @param track The new video track to use for sending.
   */
  replaceVideoTrack(track: MediaStreamTrack): void {
    logger.debug(`Replacing video track ${track.kind}`);
    const transceivers = this._pc.getTransceivers();
    if (transceivers.length > 1 && transceivers[1]!.sender) {
      transceivers[1]!.sender.replaceTrack(track);
    } else {
      logger.warning("Video transceiver not found. Cannot replace video track.");
    }
  }

  /**
   * Replace the screen video track in the third transceiver.
   *
   * @param track The new screen video track to use for sending.
   */
  replaceScreenVideoTrack(track: MediaStreamTrack): void {
    logger.debug(`Replacing screen video track ${track.kind}`);
    const transceivers = this._pc.getTransceivers();
    if (transceivers.length > 2 && transceivers[2]!.sender) {
      transceivers[2]!.sender.replaceTrack(track);
    } else {
      logger.warning("Screen video transceiver not found. Cannot replace screen video track.");
    }
  }

  /** Disconnect from the WebRTC peer connection. */
  async disconnect(): Promise<void> {
    this.sendAppMessage({ type: SIGNALLING_TYPE, message: new PeerLeftMessage().modelDump() });
    await this._close();
  }

  /** Close the peer connection and cleanup resources. */
  protected async _close(): Promise<void> {
    for (const track of this._trackMap.values()) {
      if (track) track.stop();
    }
    this._trackMap.clear();
    if (this._pc) {
      await this._pc.close();
    }
    this._outgoingMessagesQueue.length = 0;
    this._dataChannelEnabled = true;
    this._pendingAppMessages.length = 0;
    this._trackMap = new Map();
    this._cancelMonitoringConnectingState();
    this._cancelDataChannelTimeout();
  }

  /**
   * Get the SDP answer for the current connection.
   *
   * @returns The SDP answer, type, and peer connection ID, or null if no
   *   answer is available.
   */
  getAnswer(): { sdp: string; type: string; pc_id: string } | null {
    if (!this._answer) return null;
    return { sdp: this._answer.sdp, type: this._answer.type, pc_id: this._pcId };
  }

  /**
   * Start monitoring the peer connection while it is in the *connecting* state.
   *
   * Schedules a timeout task that closes the connection if it remains in the
   * connecting state for more than `connectionTimeoutSecs` (60 by default).
   */
  protected _monitoringConnectingState(): void {
    logger.debug("Monitoring connecting state");

    const timeoutHandler = async (): Promise<void> => {
      // We will close the connection in case we have remained in the connecting state for too long
      await sleep(this.connectionTimeoutSecs);
      logger.warning("Timeout establishing the connection to the remote peer. Closing.");
      await this._close();
    };

    // Create and store the timeout task
    this._connectingTimeoutTask = createTask(
      timeoutHandler,
      "SmallWebRTCConnection::connecting_timeout",
    );
  }

  /** Cancel the ongoing connecting-state timeout task, if any. */
  protected _cancelMonitoringConnectingState(): void {
    if (this._connectingTimeoutTask && !this._connectingTimeoutTask.done()) {
      logger.debug("Cancelling the connecting timeout task");
      this._connectingTimeoutTask.cancel();
    }
    this._connectingTimeoutTask = null;
  }

  /**
   * Start a timeout to detect if the data channel fails to open after connection.
   *
   * If the data channel has not opened `DATA_CHANNEL_TIMEOUT_SECS` seconds
   * after the peer connection reaches the *connected* state, the queued
   * messages are discarded, a warning is logged, and future calls to
   * `sendAppMessage` will silently drop messages instead of queuing them.
   */
  protected _startDataChannelTimeout(): void {
    const timeoutHandler = async (): Promise<void> => {
      await sleep(DATA_CHANNEL_TIMEOUT_SECS);
      if (this._dataChannel?.readyState !== "open") {
        logger.warning(
          `Data channel not established within ${DATA_CHANNEL_TIMEOUT_SECS}s after ` +
            "connection. Clearing message queue and disabling future queueing.",
        );
        this._outgoingMessagesQueue.length = 0;
        this._dataChannelEnabled = false;
      }
    };

    this._dataChannelTimeoutTask = createTask(
      timeoutHandler,
      "SmallWebRTCConnection::data_channel_timeout",
    );
  }

  /** Cancel the data-channel open timeout task, if any. */
  protected _cancelDataChannelTimeout(): void {
    if (this._dataChannelTimeoutTask && !this._dataChannelTimeoutTask.done()) {
      logger.debug("Cancelling the data channel timeout task");
      this._dataChannelTimeoutTask.cancel();
    }
    this._dataChannelTimeoutTask = null;
  }

  /** Handle changes in the peer connection state. */
  protected async _handleNewConnectionState(): Promise<void> {
    const state = this._pc.connectionState;
    if (state === "connecting") {
      this._monitoringConnectingState();
    } else {
      this._cancelMonitoringConnectingState();
    }

    if (state === "connected" && !this._dataChannelTimeoutTask) {
      this._startDataChannelTimeout();
    }

    if (state === "connected" && !this._connectInvoked) {
      // We are going to wait until the pipeline is ready before triggering the event
      return;
    }
    logger.debug(`Connection state changed to: ${state}`);
    await this._callEventHandler(state);
    if (state === "failed") {
      logger.warning("Connection failed, closing peer connection.");
      await this._close();
    }
  }

  /**
   * Check if the WebRTC connection is currently active.
   *
   * @returns True if the connection is active and receiving data.
   */
  isConnected(): boolean {
    // If the small webrtc transport has never invoked to connect
    // we are acting like if we are not connected
    if (!this._connectInvoked) return false;

    if (this._lastReceivedTime === null) {
      // if we have never received a message, it is probably because the client has not created a data channel
      // so we are going to trust the peer connection in this case
      return this._pc.connectionState === "connected";
    }
    // Checks if the last received ping was within the last 3 seconds.
    return time() - this._lastReceivedTime < 3;
  }

  #inputTrack(
    index: number,
    minTransceivers: number,
    name: string,
    capacity: number | null,
  ): SmallWebRTCTrack | null {
    const existing = this._trackMap.get(index);
    if (existing) return existing;

    // Transceivers always appear in creation-order for both peers
    // For support 3 receivers in the following order:
    //   audio, video, screenVideo
    const transceivers = this._pc.getTransceivers();
    if (transceivers.length < minTransceivers || !transceivers[index]!.receiver) {
      logger.warning(`No ${name} transceiver is available`);
      return null;
    }

    const receiver = transceivers[index]!.receiver;
    const track = receiver ? new SmallWebRTCTrack(receiver, capacity) : null;
    this._trackMap.set(index, track);
    return track;
  }

  /** The audio input track wrapper, or null if unavailable. */
  audioInputTrack(): SmallWebRTCTrack | null {
    return this.#inputTrack(AUDIO_TRANSCEIVER_INDEX, 1, "audio", null);
  }

  /** The video input track wrapper, or null if unavailable. */
  videoInputTrack(): SmallWebRTCTrack | null {
    return this.#inputTrack(VIDEO_TRANSCEIVER_INDEX, 2, "video", null);
  }

  /** The screen video input track wrapper, or null if unavailable. */
  screenVideoInputTrack(): SmallWebRTCTrack | null {
    return this.#inputTrack(
      SCREEN_VIDEO_TRANSCEIVER_INDEX,
      3,
      "screen video",
      SCREEN_VIDEO_JITTER_BUFFER_CAPACITY,
    );
  }

  /**
   * Send an application message through the data channel.
   *
   * If the data channel is open the message is sent immediately. Otherwise,
   * the message is queued and flushed once the channel opens, unless queueing
   * has been disabled by the data-channel open timeout, or the queue already
   * holds `MAX_MESSAGE_QUEUE_SIZE` messages.
   *
   * @param message The message to send (will be JSON serialized).
   */
  sendAppMessage(message: unknown): void {
    const jsonMessage = pyJsonDumps(message);
    if (this._dataChannel && this._dataChannel.readyState === "open") {
      this._dataChannel.send(jsonMessage);
    } else if (this._dataChannelEnabled) {
      if (this._outgoingMessagesQueue.length < MAX_MESSAGE_QUEUE_SIZE) {
        logger.debug("Data channel not ready, queuing message");
        this._outgoingMessagesQueue.push(jsonMessage);
      } else {
        logger.warning(
          `Message queue is full (${MAX_MESSAGE_QUEUE_SIZE} messages). Discarding message.`,
        );
      }
    } else {
      // The client might choose never to create a data channel.
      logger.trace("Data channel unavailable and queueing disabled. Discarding message.");
    }
  }

  /** Flush all queued messages through the now-open data channel. */
  protected _flushMessageQueue(): void {
    this._cancelDataChannelTimeout();
    if (!this._dataChannel) return;
    logger.debug("Data channel is open, flushing queued messages");
    while (this._outgoingMessagesQueue.length > 0) {
      const message = this._outgoingMessagesQueue.shift()!;
      this._dataChannel.send(message);
    }
  }

  /** Request renegotiation of the WebRTC connection. */
  askToRenegotiate(): void {
    if (this._renegotiationInProgress) return;

    this._renegotiationInProgress = true;
    this.sendAppMessage({ type: SIGNALLING_TYPE, message: new RenegotiateMessage().modelDump() });
  }

  /** Handle incoming signaling messages. */
  async _handleSignallingMessage(message: unknown): Promise<void> {
    logger.debug(`Signalling message received: ${pyJsonDumps(message)}`);
    const signallingMessage = SignallingMessage.Inbound.validate(message);
    if (signallingMessage instanceof TrackStatusMessage) {
      const getter = this._trackGetters[signallingMessage.receiver_index] ?? (() => null);
      const track = getter();
      if (track) {
        track.setEnabled(signallingMessage.enabled);
      }
      await this._callEventHandler(
        "track-status",
        signallingMessage.receiver_index,
        signallingMessage.enabled,
      );
    }
  }

  /** Handle incoming ICE candidates (`null` marks the end of candidates). */
  async addIceCandidate(candidate: RTCIceCandidate | null): Promise<void> {
    logger.debug(`Adding remote candidate: ${candidate ? candidate.ip : candidate}`);
    await this.pc.addIceCandidate(candidate);
  }
}
