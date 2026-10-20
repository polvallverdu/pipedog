// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/smallwebrtc/transport.py

/**
 * Small WebRTC transport implementation for Pipecat.
 *
 * This module provides a WebRTC transport implementation (werift in place of
 * aiortc) for real-time audio and video communication. It supports
 * bidirectional media streaming, application messaging, and client connection
 * management.
 */

import {
  Future,
  rethrowIfCancelled,
  sleep,
  type Task,
  TimeoutError,
  time,
  waitFor,
} from "@pipedog/asyncio";
import {
  type CancelFrame,
  ClientConnectedFrame,
  type EndFrame,
  type Frame,
  InputAudioRawFrame,
  InputTransportMessageFrame,
  type OutputAudioRawFrame,
  type OutputImageRawFrame,
  type OutputTransportMessageFrame,
  type OutputTransportMessageUrgentFrame,
  type SpriteFrame,
  type StartFrame,
  UserImageRawFrame,
  UserImageRequestFrame,
} from "@pipedog/core/frames/frames";
import {
  FrameDirection,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "@pipedog/core/processors/frame_processor";
import { BaseInputTransport } from "@pipedog/core/transports/base_input";
import { BaseOutputTransport } from "@pipedog/core/transports/base_output";
import { BaseTransport, type TransportParams } from "@pipedog/core/transports/base_transport";
import { _captureFramerate, _VideoInSamplers } from "@pipedog/core/transports/video_in_sampler";
import { logger } from "@pipedog/core/utils/logger";
import { acquires, releases } from "@pipedog/core/utils/shared";

import {
  AUDIO_TRANSCEIVER_INDEX,
  SCREEN_VIDEO_TRANSCEIVER_INDEX,
  type SmallWebRTCConnection,
  type SmallWebRTCTrack,
  VIDEO_TRANSCEIVER_INDEX,
} from "./connection.ts";
import {
  AudioFrame,
  type AudioLayoutName,
  AudioResampler,
  AudioStreamTrack,
  MediaStreamError,
  VideoStreamTrack,
} from "./media.ts";
import { isOpusSampleRate } from "./opus.ts";
import { convertToRgb, VideoFrame, type VideoFrameArray } from "./video.ts";

export const CAM_VIDEO_SOURCE = "camera";
export const SCREEN_VIDEO_SOURCE = "screenVideo";
export const MIC_AUDIO_SOURCE = "microphone";

/** SmallWebRTC has one peer, so all its video samplers are kept under one id. */
export const _PEER_ID = "peer";

// The source each of the connection's receivers carries.
const _SOURCES_BY_RECEIVER: Record<number, string> = {
  [AUDIO_TRANSCEIVER_INDEX]: MIC_AUDIO_SOURCE,
  [VIDEO_TRANSCEIVER_INDEX]: CAM_VIDEO_SOURCE,
  [SCREEN_VIDEO_TRANSCEIVER_INDEX]: SCREEN_VIDEO_SOURCE,
};

function errorName(e: unknown): string {
  return e instanceof Error ? e.constructor.name : typeof e;
}

export interface SmallWebRTCCallbacksOptions {
  /** Called when an application message is received. */
  onAppMessage: (message: unknown, sender: string) => Promise<void>;
  /** Called when a client establishes connection. */
  onClientConnected: (connection: SmallWebRTCConnection) => Promise<void>;
  /** Called when a client disconnects. */
  onClientDisconnected: (connection: SmallWebRTCConnection) => Promise<void>;
  /**
   * Called with the source (`"microphone"`, `"camera"` or `"screenVideo"`)
   * and whether the peer is sending it, when the peer turns a source on or off.
   */
  onTrackStatus: (source: string, enabled: boolean) => Promise<void>;
}

/** Callback handlers for SmallWebRTC events. */
export class SmallWebRTCCallbacks {
  onAppMessage: SmallWebRTCCallbacksOptions["onAppMessage"];
  onClientConnected: SmallWebRTCCallbacksOptions["onClientConnected"];
  onClientDisconnected: SmallWebRTCCallbacksOptions["onClientDisconnected"];
  onTrackStatus: SmallWebRTCCallbacksOptions["onTrackStatus"];

  constructor(options: SmallWebRTCCallbacksOptions) {
    this.onAppMessage = options.onAppMessage;
    this.onClientConnected = options.onClientConnected;
    this.onClientDisconnected = options.onClientDisconnected;
    this.onTrackStatus = options.onTrackStatus;
  }
}

/**
 * Custom audio stream track for WebRTC output.
 *
 * Handles audio frame generation and timing for WebRTC transmission,
 * supporting queued audio data with proper synchronization: `recv()` returns
 * 10 ms frames on a clock tied to the first frame's time, so it never drifts.
 */
export class RawAudioTrack extends AudioStreamTrack {
  protected _sampleRate: number;
  protected _autoSilence: boolean;
  protected _samplesPer10ms: number;
  protected _bytesPer10ms: number;
  protected _rawTimestamp = 0;
  protected _rawStart = time();
  // Queue of [bytes, future], broken into 10ms sub chunks as needed
  protected _chunkQueue: [Uint8Array, Future<boolean> | null][] = [];

  /**
   * Initialize the raw audio track.
   *
   * @param sampleRate The audio sample rate in Hz.
   * @param autoSilence If true, emit silence when the queue is empty. If
   *   false, wait until audio data is available.
   */
  constructor(sampleRate: number, autoSilence = true) {
    super();
    this._sampleRate = sampleRate;
    this._autoSilence = autoSilence;
    this._samplesPer10ms = Math.trunc((sampleRate * 10) / 1000);
    this._bytesPer10ms = this._samplesPer10ms * 2; // 16-bit (2 bytes per sample)
  }

  /**
   * Add audio bytes to the buffer for transmission.
   *
   * @returns A Future that completes when the data is processed.
   * @throws Error If audio bytes are not a multiple of 10ms size.
   */
  addAudioBytes(audioBytes: Uint8Array): Future<boolean> {
    if (audioBytes.length % this._bytesPer10ms !== 0) {
      throw new Error("Audio bytes must be a multiple of 10ms size.");
    }
    const future = new Future<boolean>();

    // Break input into 10ms chunks
    for (let i = 0; i < audioBytes.length; i += this._bytesPer10ms) {
      const chunk = audioBytes.subarray(i, i + this._bytesPer10ms);
      // Only the last chunk carries the future to be resolved once fully consumed
      const fut = i + this._bytesPer10ms >= audioBytes.length ? future : null;
      this._chunkQueue.push([chunk, fut]);
    }

    return future;
  }

  /**
   * Stop the track, completing the writes still waiting in its queue.
   *
   * DIVERGENCE: upstream leaves them pending, so a write in progress when the
   * peer connection is replaced (`restart_pc`) waits until the output
   * transport's write timeout and the pipeline fails.
   */
  override stop(): void {
    for (const [, future] of this._chunkQueue) {
      if (future && !future.done()) future.setResult(false);
    }
    this._chunkQueue = [];
    super.stop();
  }

  /**
   * Return the next audio frame for WebRTC transmission.
   *
   * @returns The next 10 ms frame, or silence if the queue is empty and
   *   `autoSilence` is true.
   */
  override async recv(): Promise<AudioFrame> {
    // Compute required wait time for synchronization
    if (this._rawTimestamp > 0) {
      const wait = this._rawStart + this._rawTimestamp / this._sampleRate - time();
      if (wait > 0) await sleep(wait);
    }

    let chunk: Uint8Array;
    if (this._chunkQueue.length === 0) {
      if (this._autoSilence) {
        chunk = new Uint8Array(this._bytesPer10ms);
      } else {
        while (this._chunkQueue.length === 0) await sleep(0.005);
        const [c, future] = this._chunkQueue.shift()!;
        chunk = c;
        if (future && !future.done()) future.setResult(true);
      }
    } else {
      const [c, future] = this._chunkQueue.shift()!;
      chunk = c;
      if (future && !future.done()) future.setResult(true);
    }

    // Convert the byte data to int16 samples
    const samples =
      chunk.byteOffset % 2 === 0
        ? new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2)
        : new Int16Array(chunk.slice().buffer);

    const frame = AudioFrame.fromNdarray(samples, { layout: "mono", sampleRate: this._sampleRate });
    frame.pts = this._rawTimestamp;
    frame.timeBase = 1 / this._sampleRate;
    this._rawTimestamp += this._samplesPer10ms;
    return frame;
  }
}

/**
 * Custom video stream track for WebRTC output.
 *
 * Handles video frame queuing and conversion for WebRTC transmission. The
 * frames are encoded by the connection's `videoEncoderFactory`; without one
 * they are dropped (see `video.ts`).
 */
export class RawVideoTrack extends VideoStreamTrack {
  protected _width: number;
  protected _height: number;
  protected _videoBuffer: OutputImageRawFrame[] = [];
  protected _videoWaiter: Future<void> | null = null;

  constructor(width: number, height: number) {
    super();
    this._width = width;
    this._height = height;
  }

  /** Add a video frame to the transmission buffer. */
  addVideoFrame(frame: OutputImageRawFrame): void {
    this._videoBuffer.push(frame);
    if (this._videoWaiter && !this._videoWaiter.done()) this._videoWaiter.setResult(undefined);
  }

  /** Return the next video frame for WebRTC transmission. */
  override async recv(): Promise<VideoFrame> {
    while (this._videoBuffer.length === 0) {
      this._videoWaiter = new Future<void>();
      await this._videoWaiter;
    }
    const rawFrame = this._videoBuffer.shift()!;

    const frame = VideoFrame.fromNdarray(
      { data: rawFrame.image, width: this._width, height: this._height },
      "rgb24",
    );

    // Assign timestamp
    [frame.pts, frame.timeBase] = await this.nextTimestamp();

    return frame;
  }
}

/**
 * WebRTC client implementation for handling connections and media streams.
 *
 * Manages WebRTC peer connections, audio/video streaming, and application
 * messaging through the SmallWebRTCConnection interface.
 */
export class SmallWebRTCClient {
  protected _webrtcConnection: SmallWebRTCConnection;
  _closing = false;
  protected _callbacks: SmallWebRTCCallbacks;

  protected _audioOutputTrack: RawAudioTrack | null = null;
  protected _videoOutputTrack: RawVideoTrack | null = null;
  _audioInputTrack: SmallWebRTCTrack | null = null;
  _videoInputTrack: SmallWebRTCTrack | null = null;
  _screenVideoTrack: SmallWebRTCTrack | null = null;

  protected _params: TransportParams | null = null;
  protected _audioInChannels = 0;
  protected _inSampleRate = 0;
  protected _outSampleRate = 0;

  // Audio resampler - will be configured during setup with target sample rate/layout
  protected _audioInResampler: AudioResampler | null = null;
  protected _audioInLayout: AudioLayoutName | null = null;

  constructor(webrtcConnection: SmallWebRTCConnection, callbacks: SmallWebRTCCallbacks) {
    this._webrtcConnection = webrtcConnection;
    this._callbacks = callbacks;

    webrtcConnection.eventHandler("connected", async () => {
      logger.debug("Peer connection established.");
      await this._handleClientConnected();
    });

    webrtcConnection.eventHandler("disconnected", async () => {
      logger.debug("Peer connection lost.");
      await this._handlePeerDisconnected();
    });

    webrtcConnection.eventHandler("closed", async () => {
      logger.debug("Client connection closed.");
      await this._handleClientClosed();
    });

    webrtcConnection.eventHandler(
      "app-message",
      async (connection: SmallWebRTCConnection, message: unknown) => {
        await this._handleAppMessage(message, connection.pcId);
      },
    );

    webrtcConnection.eventHandler(
      "track-status",
      async (_connection: SmallWebRTCConnection, receiverIndex: number, enabled: boolean) => {
        const source = _SOURCES_BY_RECEIVER[receiverIndex];
        if (source) await this._callbacks.onTrackStatus(source, enabled);
      },
    );
  }

  /**
   * Convert a video frame to RGB format based on the input format.
   *
   * @throws Error If the format is unsupported.
   */
  _convertFrame(frameArray: VideoFrameArray, formatName: string): VideoFrameArray {
    if (formatName.startsWith("rgb")) return frameArray; // Already in RGB, no conversion needed
    return { ...frameArray, data: convertToRgb(frameArray, formatName) };
  }

  /**
   * Whether the peer is sending a video source.
   *
   * @param videoSource `"camera"` or `"screenVideo"`.
   */
  videoSourceEnabled(videoSource: string): boolean {
    const track = videoSource === CAM_VIDEO_SOURCE ? this._videoInputTrack : this._screenVideoTrack;
    return track?.isEnabled() ?? false;
  }

  /**
   * Read video frames from the WebRTC connection.
   *
   * Reads video frames from the track, converts them to RGB, and yields
   * `UserImageRawFrame`s.
   *
   * @param videoSource Video source to capture ("camera" or "screenVideo").
   */
  async *readVideoFrame(videoSource: string): AsyncGenerator<UserImageRawFrame> {
    for (;;) {
      const videoTrack =
        videoSource === CAM_VIDEO_SOURCE ? this._videoInputTrack : this._screenVideoTrack;
      if (videoTrack === null) {
        await sleep(0.01);
        continue;
      }

      let frame: unknown;
      try {
        frame = await waitFor(() => videoTrack.recv(), 2.0);
      } catch (e) {
        if (e instanceof TimeoutError) {
          if (this._webrtcConnection.isConnected() && videoTrack?.isEnabled()) {
            logger.warning("Timeout: No video frame received within the specified time.");
          }
          frame = null;
        } else if (e instanceof MediaStreamError) {
          // Track is dead — every subsequent `recv()` would raise the same
          // error and busy-loop the generator at ~100Hz. Clear the track
          // reference so the loop parks on the `null` gate above; a
          // renegotiation that repopulates the track will resume frames.
          logger.warning("Media stream error while reading the video; clearing track.");
          if (videoSource === CAM_VIDEO_SOURCE) this._videoInputTrack = null;
          else this._screenVideoTrack = null;
          frame = null;
        } else {
          throw e;
        }
      }

      if (frame === null || !(frame instanceof VideoFrame)) {
        // If no valid frame, sleep for a bit
        await sleep(0.01);
        continue;
      }

      const formatName = frame.format.name;
      // Convert frame to an array in its native format
      const frameArray = frame.toNdarray(formatName);
      const frameRgb = this._convertFrame(frameArray, formatName);

      const imageFrame = new UserImageRawFrame({
        userId: this._webrtcConnection.pcId,
        image: frameRgb.data,
        size: [frame.width, frame.height],
        format: "RGB",
      });
      imageFrame.transportSource = videoSource;
      imageFrame.pts = frame.pts;

      yield imageFrame;
    }
  }

  /**
   * Read audio frames from the WebRTC connection.
   *
   * Reads 20ms of audio from the track and creates `InputAudioRawFrame`s.
   */
  async *readAudioFrame(): AsyncGenerator<InputAudioRawFrame> {
    // setup() builds the resampler before the reader task is started.
    if (this._audioInResampler === null) throw new Error("readAudioFrame() called before setup()");

    for (;;) {
      if (this._audioInputTrack === null) {
        await sleep(0.01);
        continue;
      }

      const track = this._audioInputTrack;
      let frame: unknown;
      try {
        frame = await waitFor(() => track.recv(), 2.0);
      } catch (e) {
        if (e instanceof TimeoutError) {
          if (this._webrtcConnection.isConnected() && this._audioInputTrack?.isEnabled()) {
            logger.warning("Timeout: No audio frame received within the specified time.");
          }
          frame = null;
        } else if (e instanceof MediaStreamError) {
          // Track is dead — clear the track reference so the loop parks on
          // the `null` gate above; a renegotiation that repopulates the
          // track will resume frames.
          logger.warning("Media stream error while reading the audio; clearing track.");
          this._audioInputTrack = null;
          frame = null;
        } else {
          throw e;
        }
      }

      if (frame === null || !(frame instanceof AudioFrame)) {
        // If we don't read any audio let's sleep for a little bit (i.e. busy wait).
        await sleep(0.01);
        continue;
      }

      // Resample if needed, otherwise use the frame as-is. The resampler
      // also converts to the configured channel layout, so frames whose
      // layout doesn't already match must go through it even when the
      // rate already matches — otherwise interleaved bytes get labeled
      // with the wrong channel count.
      const framesToProcess =
        frame.sampleRate !== this._inSampleRate || frame.layout.name !== this._audioInLayout
          ? await this._audioInResampler.resample(frame)
          : [frame];

      for (const processedFrame of framesToProcess) {
        // Convert to 16-bit PCM bytes
        const pcmBytes = processedFrame.toBytes().slice();

        const audioFrame = new InputAudioRawFrame({
          audio: pcmBytes,
          sampleRate: this._inSampleRate,
          numChannels: this._audioInChannels,
        });
        audioFrame.pts = frame.pts;

        yield audioFrame;
      }
    }
  }

  /** Write an audio frame to the WebRTC connection. */
  async writeAudioFrame(frame: OutputAudioRawFrame): Promise<boolean> {
    if (this._canSend() && this._audioOutputTrack) {
      await this._audioOutputTrack.addAudioBytes(frame.audio);
      return true;
    }
    return false;
  }

  /** Write a video frame to the WebRTC connection. */
  async writeVideoFrame(frame: OutputImageRawFrame): Promise<boolean> {
    if (this._canSend() && this._videoOutputTrack) {
      this._videoOutputTrack.addVideoFrame(frame);
      return true;
    }
    return false;
  }

  /**
   * Set up the client with transport parameters.
   *
   * @param params Transport configuration parameters.
   * @param setup Configuration object containing setup parameters.
   */
  async setup(params: TransportParams, setup: FrameProcessorSetup): Promise<void> {
    this._audioInChannels = params.audioInChannels;
    this._inSampleRate = params.audioInSampleRate || setup.audioInSampleRate;
    this._outSampleRate = params.audioOutSampleRate || setup.audioOutSampleRate;
    this._params = params;
    this._audioInLayout = this._audioInChannels === 2 ? "stereo" : "mono";
    this._audioInResampler = new AudioResampler("s16", this._audioInLayout, this._inSampleRate);
  }

  /** Establish the WebRTC connection. */
  async connect(): Promise<void> {
    if (this._webrtcConnection.isConnected()) {
      // already initialized
      return;
    }

    logger.info("Connecting to Small WebRTC");
    await this._webrtcConnection.connect();
  }

  /** Disconnect from the WebRTC peer. */
  async disconnect(): Promise<void> {
    if (this.isConnected && !this.isClosing) {
      logger.info("Disconnecting to Small WebRTC");
      this._closing = true;
      await this._webrtcConnection.disconnect();
      await this._handlePeerDisconnected();
    }
  }

  static {
    SmallWebRTCClient.prototype.connect = acquires("connection")(
      SmallWebRTCClient.prototype.connect,
    ) as () => Promise<void>;
    SmallWebRTCClient.prototype.disconnect = releases("connection")(
      SmallWebRTCClient.prototype.disconnect,
    ) as () => Promise<void>;
  }

  /**
   * Send an application message through the WebRTC connection.
   *
   * Messages sent before the data channel is open are buffered by the
   * connection and flushed, in order, once the channel opens.
   */
  async sendMessage(
    frame: OutputTransportMessageFrame | OutputTransportMessageUrgentFrame,
  ): Promise<void> {
    if (this.isClosing) {
      const message = frame.message as any;
      const messageType =
        message !== null && typeof message === "object" && !Array.isArray(message)
          ? (message.type ?? "unknown")
          : (message?.constructor?.name ?? typeof message);
      logger.debug(`Discarding app message '${messageType}': peer connection is closing.`);
      return;
    }
    this._webrtcConnection.sendAppMessage(frame.message);
  }

  /** Handle client connection establishment. */
  protected async _handleClientConnected(): Promise<void> {
    // There is nothing to do here yet, the pipeline is still not ready
    if (!this._params) return;

    this._audioInputTrack = this._webrtcConnection.audioInputTrack();
    // pipedog: Opus decodes straight to the pipeline's input format when it can.
    if (isOpusSampleRate(this._inSampleRate)) {
      this._audioInputTrack?.setAudioOutputFormat(this._inSampleRate, this._audioInChannels);
    }
    this._videoInputTrack = this._webrtcConnection.videoInputTrack();
    this._screenVideoTrack = this._webrtcConnection.screenVideoInputTrack();
    if (this._params.audioOutEnabled) {
      this._audioOutputTrack = new RawAudioTrack(
        this._outSampleRate,
        this._params.audioOutAutoSilence,
      );
      this._webrtcConnection.replaceAudioTrack(this._audioOutputTrack);
    }

    if (this._params.videoOutEnabled) {
      this._videoOutputTrack = new RawVideoTrack(
        this._params.videoOutWidth,
        this._params.videoOutHeight,
      );
      this._webrtcConnection.replaceVideoTrack(this._videoOutputTrack);
    }

    await this._callbacks.onClientConnected(this._webrtcConnection);
  }

  /** Handle peer disconnection cleanup. */
  protected async _handlePeerDisconnected(): Promise<void> {
    this._audioOutputTrack?.stop();
    this._audioInputTrack = null;
    this._videoInputTrack = null;
    this._screenVideoTrack = null;
    this._audioOutputTrack = null;
    this._videoOutputTrack = null;
  }

  /** Handle client connection closure. */
  protected async _handleClientClosed(): Promise<void> {
    this._audioOutputTrack?.stop();
    this._audioInputTrack = null;
    this._videoInputTrack = null;
    this._screenVideoTrack = null;
    this._audioOutputTrack = null;
    this._videoOutputTrack = null;

    // Trigger `on_client_disconnected` if the client actually disconnects,
    // that is, we are not the ones disconnecting.
    if (!this._closing) {
      await this._callbacks.onClientDisconnected(this._webrtcConnection);
    }
  }

  /** Handle incoming application messages. */
  protected async _handleAppMessage(message: unknown, sender: string): Promise<void> {
    await this._callbacks.onAppMessage(message, sender);
  }

  /** Check if the connection is ready for sending data. */
  protected _canSend(): boolean {
    return this.isConnected && !this.isClosing;
  }

  /** Whether the WebRTC connection is established. */
  get isConnected(): boolean {
    return this._webrtcConnection.isConnected();
  }

  /** Whether the connection is in the process of closing. */
  get isClosing(): boolean {
    return this._closing;
  }
}

/**
 * Input transport implementation for SmallWebRTC.
 *
 * Handles incoming audio and video streams from WebRTC peers, including user
 * image requests and application message handling.
 */
export class SmallWebRTCInputTransport extends BaseInputTransport {
  protected _client: SmallWebRTCClient;
  _receiveAudioTask: Task<unknown> | null = null;
  _receiveVideoTask: Task<unknown> | null = null;
  _receiveScreenVideoTask: Task<unknown> | null = null;
  _videoSamplers = new _VideoInSamplers();

  constructor(
    client: SmallWebRTCClient,
    params: TransportParams,
    options: FrameProcessorOptions = {},
  ) {
    super(params, options);
    this._client = client;
    this._params = params;
  }

  /** Whether this transport captures a video source listed in `videoInSources`. */
  override _supportsVideoInSource(videoSource: string): boolean {
    return videoSource === CAM_VIDEO_SOURCE || videoSource === SCREEN_VIDEO_SOURCE;
  }

  /** Set up the transport and establish the WebRTC connection. */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);

    await this._client.setup(this._params, setup);
    await this._client.connect();
  }

  /** Release resources during teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._teardown();
  }

  /** Process incoming frames including user image requests. */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof UserImageRequestFrame) {
      await this.requestParticipantImage(frame);
    }
  }

  /** Stop all background tasks. */
  protected async _stopTasks(): Promise<void> {
    if (this._receiveAudioTask) {
      await this.cancelTask(this._receiveAudioTask);
      this._receiveAudioTask = null;
    }
    if (this._receiveVideoTask) {
      await this.cancelTask(this._receiveVideoTask);
      this._receiveVideoTask = null;
    }
    if (this._receiveScreenVideoTask) {
      await this.cancelTask(this._receiveScreenVideoTask);
      this._receiveScreenVideoTask = null;
    }
  }

  /**
   * Cancel receive tasks and disconnect the WebRTC client.
   *
   * Idempotent so it can run from `stop()`, `cancel()`, and `cleanup()`
   * without duplicating work.
   */
  protected async _teardown(): Promise<void> {
    await this._stopTasks();
    await this._client.disconnect();
  }

  /** Start receiving media from the WebRTC connection. */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);

    if (!this._receiveAudioTask && this._params.audioInEnabled) {
      this._receiveAudioTask = this.createTask(() => this._receiveAudio(), "_receive_audio");
    }
    if (!this._receiveVideoTask && this._params.videoInEnabled) {
      this._receiveVideoTask = this.createTask(
        () => this._receiveVideo(CAM_VIDEO_SOURCE),
        "_receive_video",
      );
    }

    await this.setTransportReady(frame);
  }

  /** Stop the input transport and disconnect from WebRTC. */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._teardown();
  }

  /** Cancel the input transport and disconnect immediately. */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._teardown();
  }

  /** Background task for receiving audio frames from WebRTC. */
  async _receiveAudio(): Promise<void> {
    try {
      for await (const audioFrame of this._client.readAudioFrame()) {
        if (audioFrame) await this.pushAudioFrame(audioFrame);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} exception receiving data: ${errorName(e)} (${e})`);
    }
  }

  /**
   * Background task for receiving video frames from WebRTC.
   *
   * @param videoSource Video source to capture ("camera" or "screenVideo").
   */
  async _receiveVideo(videoSource: string): Promise<void> {
    try {
      for await (const videoFrame of this._client.readVideoFrame(videoSource)) {
        if (!videoFrame) continue;
        const [due, requestFrame] = this._videoSamplers.sample(_PEER_ID, videoSource);
        if (!due) continue;
        if (requestFrame) {
          videoFrame.text = requestFrame.text;
          videoFrame.appendToContext = requestFrame.appendToContext;
          videoFrame.request = requestFrame;
        }
        await this.pushVideoFrame(videoFrame);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} exception receiving data: ${errorName(e)} (${e})`);
    }
  }

  /** Push an application message into the pipeline. */
  async pushAppMessage(message: unknown): Promise<void> {
    logger.trace(
      `Received app message inside SmallWebRTCInputTransport  ${JSON.stringify(message)}`,
    );
    await this.broadcastFrame(InputTransportMessageFrame, { message });
  }

  /**
   * Request an image frame from the participant's video stream.
   *
   * The request is stored and the next video frame received is converted to
   * a `UserImageRawFrame` that answers it.
   */
  async requestParticipantImage(frame: UserImageRequestFrame): Promise<void> {
    logger.debug(`Requesting image from participant: ${frame.userId}`);

    // Default to camera if no source specified
    if (frame.videoSource === null) frame.videoSource = CAM_VIDEO_SOURCE;

    if (!this._client.videoSourceEnabled(frame.videoSource)) {
      const error = `The peer isn't sending ${frame.videoSource} video.`;
      await this._answerImageRequests([frame], error);
      return;
    }

    // A request for a source that isn't being captured starts receiving it,
    // passing on every frame.
    if (!this._videoSamplers.isCapturing(_PEER_ID, frame.videoSource)) {
      this._videoSamplers.capture(_PEER_ID, frame.videoSource, null);
    }
    this._videoSamplers.addRequest(_PEER_ID, frame.videoSource, frame);
    // If we're not already receiving video, try to get a frame now
    if (
      frame.videoSource === CAM_VIDEO_SOURCE &&
      !this._receiveVideoTask &&
      this._params.videoInEnabled
    ) {
      // Start video reception if it's not already running
      this._receiveVideoTask = this.createTask(
        () => this._receiveVideo(CAM_VIDEO_SOURCE),
        "_receive_video",
      );
    } else if (
      frame.videoSource === SCREEN_VIDEO_SOURCE &&
      !this._receiveScreenVideoTask &&
      this._params.videoInEnabled
    ) {
      // Start screen video reception if it's not already running
      this._receiveScreenVideoTask = this.createTask(
        () => this._receiveVideo(SCREEN_VIDEO_SOURCE),
        "_receive_screen_video",
      );
    }
  }

  /**
   * Answer the image requests waiting on a video source the peer turned off.
   *
   * The source stays captured, so its frames are sampled again if it's turned
   * back on.
   */
  async stopVideo(videoSource: string): Promise<void> {
    const requests = this._videoSamplers.takeRequests(_PEER_ID, videoSource);
    const error = `The peer turned off its ${videoSource} video.`;
    await this._answerImageRequests(requests, error);
  }

  /** Stop sampling video and answer the waiting image requests, e.g. on disconnect. */
  async removeAllVideo(): Promise<void> {
    const requests = this._videoSamplers.clear();
    await this._answerImageRequests(requests, "The peer disconnected.");
  }

  /**
   * Capture media from a specific participant.
   *
   * @param options.source Media source to capture from ("camera", "microphone", or "screenVideo").
   * @param options.framerate For a video source, frames per second to pass
   *   on. `0` passes on only the frames that answer image requests, and
   *   `null` passes on every frame.
   */
  async captureParticipantMedia(
    options: { source?: string; framerate?: number | null } = {},
  ): Promise<void> {
    const source = options.source ?? CAM_VIDEO_SOURCE;
    const framerate = options.framerate ?? null;
    if (source === CAM_VIDEO_SOURCE || source === SCREEN_VIDEO_SOURCE) {
      this._videoSamplers.capture(_PEER_ID, source, framerate);
    }

    // If we're not already receiving, try to get media now
    if (source === MIC_AUDIO_SOURCE && !this._receiveAudioTask && this._params.audioInEnabled) {
      // Start audio reception if it's not already running
      this._receiveAudioTask = this.createTask(() => this._receiveAudio(), "_receive_audio");
    } else if (
      source === CAM_VIDEO_SOURCE &&
      !this._receiveVideoTask &&
      this._params.videoInEnabled
    ) {
      // Start video reception if it's not already running
      this._receiveVideoTask = this.createTask(
        () => this._receiveVideo(CAM_VIDEO_SOURCE),
        "_receive_video",
      );
    } else if (
      source === SCREEN_VIDEO_SOURCE &&
      !this._receiveScreenVideoTask &&
      this._params.videoInEnabled
    ) {
      // Start screen video reception if it's not already running
      this._receiveScreenVideoTask = this.createTask(
        () => this._receiveVideo(SCREEN_VIDEO_SOURCE),
        "_receive_screen_video",
      );
    }
  }
}

/**
 * Output transport implementation for SmallWebRTC.
 *
 * Handles outgoing audio and video streams to WebRTC peers, including
 * transport message sending.
 */
export class SmallWebRTCOutputTransport extends BaseOutputTransport {
  protected _client: SmallWebRTCClient;

  constructor(
    client: SmallWebRTCClient,
    params: TransportParams,
    options: FrameProcessorOptions = {},
  ) {
    super(params, options);
    this._client = client;
    this._params = params;
  }

  /** Set up the transport and establish the WebRTC connection. */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);

    await this._client.setup(this._params, setup);
    await this._client.connect();
  }

  /** Release resources during teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._teardown();
  }

  /** Start the output transport. */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);

    await this.setTransportReady(frame);
  }

  /** Disconnect the WebRTC client (idempotent). */
  protected async _teardown(): Promise<void> {
    await this._client.disconnect();
  }

  /** Stop the output transport and disconnect from WebRTC. */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._teardown();
  }

  /** Cancel the output transport and disconnect immediately. */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._teardown();
  }

  /** Send a transport message through the WebRTC connection. */
  override async sendMessage(
    frame: OutputTransportMessageFrame | OutputTransportMessageUrgentFrame,
  ): Promise<void> {
    await this._client.sendMessage(frame);
  }

  /** Write an audio frame to the WebRTC connection. */
  override async writeAudioFrame(frame: OutputAudioRawFrame): Promise<boolean> {
    return await this._client.writeAudioFrame(frame);
  }

  /** Write a video frame to the WebRTC connection. */
  override async writeVideoFrame(frame: OutputImageRawFrame): Promise<boolean> {
    return await this._client.writeVideoFrame(frame);
  }
}

export interface SmallWebRTCTransportOptions {
  /** Optional name for the input processor. */
  inputName?: string | null;
  /** Optional name for the output processor. */
  outputName?: string | null;
}

/**
 * WebRTC transport implementation for real-time communication.
 *
 * Provides bidirectional audio and video streaming over WebRTC connections
 * with support for application messaging and connection event handling.
 *
 * Event handlers available:
 *
 * - on_client_connected(transport, client): Client connected to WebRTC session
 * - on_client_disconnected(transport, client): Client disconnected from WebRTC session
 * - on_app_message(transport, message, sender): Received a data channel message
 *
 * @example
 * transport.eventHandler("on_client_connected", async (transport, client) => {
 *   ...
 * });
 */
export class SmallWebRTCTransport extends BaseTransport {
  protected _params: TransportParams;
  protected _callbacks: SmallWebRTCCallbacks;
  protected _client: SmallWebRTCClient;
  _input: SmallWebRTCInputTransport | null = null;
  _output: SmallWebRTCOutputTransport | null = null;

  /**
   * Initialize the WebRTC transport.
   *
   * @param webrtcConnection The underlying WebRTC connection handler.
   * @param params Transport configuration parameters.
   * @param options.inputName Optional name for the input processor.
   * @param options.outputName Optional name for the output processor.
   */
  constructor(
    webrtcConnection: SmallWebRTCConnection,
    params: TransportParams,
    options: SmallWebRTCTransportOptions = {},
  ) {
    super({ inputName: options.inputName ?? null, outputName: options.outputName ?? null });
    this._params = params;

    this._callbacks = new SmallWebRTCCallbacks({
      onAppMessage: (message, sender) => this._onAppMessage(message, sender),
      onClientConnected: (connection) => this._onClientConnected(connection),
      onClientDisconnected: (connection) => this._onClientDisconnected(connection),
      onTrackStatus: (source, enabled) => this._onTrackStatus(source, enabled),
    });

    this._client = new SmallWebRTCClient(webrtcConnection, this._callbacks);

    // Register supported handlers. The user will only be able to register
    // these handlers.
    this._registerEventHandler("on_app_message");
    this._registerEventHandler("on_client_connected");
    this._registerEventHandler("on_client_disconnected");
  }

  /**
   * The id of a client, as passed to `on_client_connected`.
   *
   * @returns The peer connection's id.
   */
  override getClientId(client: unknown): string {
    return (client as { pcId: string }).pcId;
  }

  /** The input transport for handling incoming media streams. */
  input(): SmallWebRTCInputTransport {
    if (!this._input) {
      this._input = new SmallWebRTCInputTransport(this._client, this._params, {
        name: this._inputName,
      });
    }
    return this._input;
  }

  /** The output transport for handling outgoing media streams. */
  output(): SmallWebRTCOutputTransport {
    if (!this._output) {
      this._output = new SmallWebRTCOutputTransport(this._client, this._params, {
        name: this._outputName,
      });
    }
    return this._output;
  }

  /** Send an image frame through the transport. */
  async sendImage(frame: OutputImageRawFrame | SpriteFrame): Promise<void> {
    if (this._output) await this._output.queueFrame(frame, FrameDirection.DOWNSTREAM);
  }

  /** Send an audio frame through the transport. */
  async sendAudio(frame: OutputAudioRawFrame): Promise<void> {
    if (this._output) await this._output.queueFrame(frame, FrameDirection.DOWNSTREAM);
  }

  /** Handle incoming application messages. */
  async _onAppMessage(message: unknown, sender: string): Promise<void> {
    if (this._input) await this._input.pushAppMessage(message);
    await this._callEventHandler("on_app_message", message, sender);
  }

  /** Handle client connection events. */
  async _onClientConnected(webrtcConnection: SmallWebRTCConnection): Promise<void> {
    // Capture the configured video sources before the event handlers run, so
    // a handler that captures a source itself takes precedence.
    if (this._input) {
      for (const [videoSource, sourceParams] of Object.entries(this._params.videoInSources)) {
        if (this._input._supportsVideoInSource(videoSource)) {
          const framerate = sourceParams.onRequestOnly ? 0 : sourceParams.framerate;
          await this._input.captureParticipantMedia({ source: videoSource, framerate });
        }
      }
    }

    await this._callEventHandler("on_client_connected", webrtcConnection);
    if (this._input) await this._input.pushFrame(new ClientConnectedFrame());
  }

  /** Handle client disconnection events. */
  async _onClientDisconnected(webrtcConnection: SmallWebRTCConnection): Promise<void> {
    if (this._input) await this._input.removeAllVideo();
    await this._callEventHandler("on_client_disconnected", webrtcConnection);
  }

  /** Handle the peer turning a source on or off. */
  async _onTrackStatus(source: string, enabled: boolean): Promise<void> {
    if (this._input && source !== MIC_AUDIO_SOURCE && !enabled) {
      await this._input.stopVideo(source);
    }
  }

  /**
   * Capture the peer's camera or screen share at a framerate.
   *
   * Upstream's deprecated forms (no `participantId`, or a video source as the
   * first argument) are not ported.
   *
   * @param _participantId The peer's id, as from `getClientId`. SmallWebRTC
   *   has one peer, so the id isn't used to select it.
   * @param framerate Frames per second to pass on, 30 by default, or `null`
   *   for every frame. It doesn't apply with `onRequestOnly`.
   * @param videoSource Video source to capture from ("camera" or "screenVideo").
   * @param options.onRequestOnly Pass on only the frames that answer image requests.
   */
  override async captureParticipantVideo(
    _participantId: string,
    framerate: number | null = 30,
    videoSource: string = CAM_VIDEO_SOURCE,
    options: { onRequestOnly?: boolean } = {},
  ): Promise<void> {
    const rate = _captureFramerate(
      framerate,
      options.onRequestOnly ?? false,
      "SmallWebRTCTransport.capture_participant_video",
    );

    if (this._input)
      await this._input.captureParticipantMedia({ source: videoSource, framerate: rate });
  }

  /**
   * Capture audio from a specific participant.
   *
   * @param audioSource Audio source to capture from (currently, "microphone" is the only supported option).
   */
  async captureParticipantAudio(audioSource: string = MIC_AUDIO_SOURCE): Promise<void> {
    if (this._input) await this._input.captureParticipantMedia({ source: audioSource });
  }
}
