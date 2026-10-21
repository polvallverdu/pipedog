// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/heygen/client.py

/**
 * HeyGen implementation for Pipecat.
 *
 * This module provides integration with the HeyGen platform for creating
 * conversational AI applications with avatars. It manages conversation
 * sessions and provides real-time audio/video streaming capabilities through
 * the HeyGen API.
 *
 * Porting notes:
 * - The control channel uses the global `WebSocket` (through core's
 *   `websocketConnect`) and the session APIs use `fetch`; both run on every
 *   runtime.
 * - Avatar media goes through a LiveKit room, joined with `@livekit/rtc-node`
 *   (an optional peer dependency with a native addon). It is loaded lazily,
 *   when the client sets up, so importing this module works everywhere; using
 *   the client needs Bun, Node or Deno on a platform with a prebuilt addon.
 */

import {
  abortable,
  monotonic,
  Queue,
  rethrowIfCancelled,
  sleep,
  type Task,
} from "@pipedog/asyncio";
import type { AudioRawFrameOptions, ImageRawFrameOptions } from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import {
  ConnectionClosedOK,
  type WebsocketClientConnection,
  type WebsocketConnectOptions,
  websocketConnect,
} from "@pipedog/core/services/websocket_service";
import type { TransportParams } from "@pipedog/core/transports/base_transport";
import type { BaseTaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { acquires, releases } from "@pipedog/core/utils/shared";
import { loadRtc, type Rtc, rtc } from "@pipedog/transport-livekit/rtc";
import { HeyGenApi, NewSessionRequest } from "./api_interactive_avatar.ts";
import { LiveAvatarApi, LiveAvatarNewSessionRequest } from "./api_liveavatar.ts";
import type { BaseAvatarApi, StandardSessionResponse } from "./base_api.ts";

type Room = InstanceType<Rtc["Room"]>;
type RemoteParticipant = InstanceType<Rtc["RemoteParticipant"]>;
type RemoteTrack = InstanceType<Rtc["RemoteAudioTrack"]> | InstanceType<Rtc["RemoteVideoTrack"]>;
type RemoteTrackPublication = InstanceType<Rtc["RemoteTrackPublication"]>;
type Track = InstanceType<Rtc["Track"]>;

export const HEY_GEN_SAMPLE_RATE = 24000;

/** Enum for HeyGen service types. */
export const ServiceType = {
  INTERACTIVE_AVATAR: "INTERACTIVE_AVATAR",
  LIVE_AVATAR: "LIVE_AVATAR",
} as const;
export type ServiceType = (typeof ServiceType)[keyof typeof ServiceType];

export interface HeyGenCallbacksOptions {
  /** Called when the bot connects to the LiveKit room. */
  onConnected: () => Promise<void>;
  /** Called when a participant connects. */
  onParticipantConnected: (participantId: string) => Promise<void>;
  /** Called when a participant disconnects. */
  onParticipantDisconnected: (participantId: string) => Promise<void>;
}

/** Callback handlers for HeyGen events. */
export class HeyGenCallbacks {
  onConnected: () => Promise<void>;
  onParticipantConnected: (participantId: string) => Promise<void>;
  onParticipantDisconnected: (participantId: string) => Promise<void>;

  constructor(options: HeyGenCallbacksOptions) {
    this.onConnected = options.onConnected;
    this.onParticipantConnected = options.onParticipantConnected;
    this.onParticipantDisconnected = options.onParticipantDisconnected;
  }
}

/**
 * Audio received from the room.
 *
 * DIVERGENCE: upstream hands callbacks an `AudioRawFrame` instance. Here
 * `AudioRawFrame` is a mixin that can't be instantiated on its own, so
 * callbacks receive its fields.
 */
export type HeyGenAudioData = AudioRawFrameOptions;

/**
 * Video received from the room (see `HeyGenAudioData`): an `ImageRawFrame`'s
 * fields.
 */
export type HeyGenImageData = ImageRawFrameOptions;

export type AudioFrameCallback = (frame: HeyGenAudioData) => Promise<void>;
export type VideoFrameCallback = (frame: HeyGenImageData) => Promise<void>;

type EventCallback = (...args: string[]) => Promise<void>;

export interface HeyGenClientOptions {
  /** HeyGen API key for authentication. */
  apiKey: string;
  /**
   * `fetch` used for API requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: replaces upstream's required aiohttp `session`.
   */
  fetch?: typeof fetch | null;
  /** Transport configuration parameters. */
  params: TransportParams;
  /** Configuration for the HeyGen session (optional). */
  sessionRequest?: LiveAvatarNewSessionRequest | NewSessionRequest | null;
  /** Type of service to use. */
  serviceType?: ServiceType | null;
  /** Callback handlers for HeyGen events. */
  callbacks: HeyGenCallbacks;
  /** Whether to connect using the user token or not (default: false). */
  connectAsUser?: boolean;
  /**
   * Options for the control websocket (e.g. a `webSocketFactory`). pipedog
   * addition.
   */
  websocketOptions?: WebsocketConnectOptions | null;
  /**
   * The avatar session API to use instead of the one `serviceType` selects.
   * pipedog addition, for tests and custom endpoints.
   */
  api?: BaseAvatarApi | null;
}

/**
 * A client for interacting with HeyGen's Interactive Avatar Realtime API.
 *
 * This client manages both WebSocket and LiveKit connections for real-time
 * avatar streaming, handling bi-directional audio/video communication and
 * avatar control. It implements the API defined in
 * https://docs.heygen.com/docs/interactive-avatar-realtime-api
 *
 * The client manages the following connections:
 * 1. WebSocket connection for avatar control and audio streaming
 * 2. LiveKit connection for receiving avatar video and audio
 *
 * `HEY_GEN_SAMPLE_RATE` is the required sample rate for HeyGen's audio
 * processing (24000 Hz).
 */
export class HeyGenClient {
  protected _serviceType: ServiceType;
  protected _api: BaseAvatarApi;
  protected _heyGenSession: StandardSessionResponse | null = null;
  protected _websocket: WebsocketClientConnection | null = null;
  protected _receiveTask: Task<unknown> | null = null;
  protected _livekitRoom: Room | null = null;
  protected _taskManager: BaseTaskManager | null = null;
  protected _params: TransportParams;
  protected _inSampleRate = 0;
  protected _outSampleRate = 0;
  protected _connected = false;
  protected _keepAliveTask: Task<unknown> | null = null;
  protected _sessionRequest: LiveAvatarNewSessionRequest | NewSessionRequest;
  protected _callbacks: HeyGenCallbacks;
  protected _eventQueue: Queue<[EventCallback, ...string[]]> | null = null;
  protected _eventTask: Task<unknown> | null = null;
  // Currently supporting to capture the audio and video from a single participant
  protected _videoTask: Task<unknown> | null = null;
  protected _audioTask: Task<unknown> | null = null;
  protected _videoFrameCallback: VideoFrameCallback | null = null;
  protected _audioFrameCallback: AudioFrameCallback | null = null;
  // writeAudioFrame() is called quickly, as soon as we get audio (e.g. from
  // the TTS), and since this is just a network connection we would be
  // sending it to quickly. Instead, we want to block to emulate an audio
  // device, this is what the send interval is. It will be computed during
  // setup.
  protected _nextSendTime = 0;
  protected _audioSecondsSent = 0.0;
  protected _transportReady = false;
  // HeyGen enforces a protection mechanism that will automatically
  // disconnect the avatar if a user does not join within 5 minutes,
  // regardless of whether the Pipecat agent remains present in the room. To
  // prevent unexpected disconnections in HeyGenVideoService, we ensure that a
  // user connection is established using the user's token. This keeps the
  // avatar session active and avoids forced logouts due to inactivity from
  // the user side.
  protected _connectAsUser: boolean;
  protected _websocketOptions: WebsocketConnectOptions;

  /**
   * Initialize the HeyGen client.
   *
   * @param options.apiKey HeyGen API key for authentication.
   * @param options.fetch `fetch` for API requests (upstream: an aiohttp session).
   * @param options.params Transport configuration parameters.
   * @param options.sessionRequest Configuration for the HeyGen session (optional).
   * @param options.serviceType Type of service to use.
   * @param options.callbacks Callback handlers for HeyGen events.
   * @param options.connectAsUser Whether to connect using the user token or not (default: false).
   */
  constructor(options: HeyGenClientOptions) {
    const serviceType = options.serviceType ?? null;
    let sessionRequest = options.sessionRequest ?? null;
    // Set default service type for backwards compatibility
    this._serviceType = serviceType !== null ? serviceType : ServiceType.INTERACTIVE_AVATAR;

    // Validate session_request matches service_type if both are provided
    if (sessionRequest !== null && serviceType !== null) {
      if (
        serviceType === ServiceType.LIVE_AVATAR &&
        !(sessionRequest instanceof LiveAvatarNewSessionRequest)
      ) {
        logger.warning(
          "Service type is LIVE_AVATAR but session_request is not SessionTokenRequest. Ignoring session_request.",
        );
        sessionRequest = null;
      } else if (
        serviceType === ServiceType.INTERACTIVE_AVATAR &&
        !(sessionRequest instanceof NewSessionRequest)
      ) {
        logger.warning(
          "Service type is INTERACTIVE_AVATAR but session_request is not NewSessionRequest. Ignoring session_request.",
        );
        sessionRequest = null;
      }
    }

    // Create default session_request based on service_type if not provided
    if (sessionRequest === null) {
      if (this._serviceType === ServiceType.INTERACTIVE_AVATAR) {
        sessionRequest = new NewSessionRequest({
          avatarId: "Shawn_Therapist_public",
          version: "v2",
        });
      } else {
        // LIVE_AVATAR
        sessionRequest = new LiveAvatarNewSessionRequest({
          avatarId: "1c690fe7-23e0-49f9-bfba-14344450285b",
        });
      }
    }

    // Initialize API based on service type
    if (options.api) {
      this._api = options.api;
    } else if (this._serviceType === ServiceType.INTERACTIVE_AVATAR) {
      this._api = new HeyGenApi(options.apiKey, { fetch: options.fetch });
    } else {
      this._api = new LiveAvatarApi(options.apiKey, { fetch: options.fetch });
    }

    this._params = options.params;
    this._sessionRequest = sessionRequest;
    this._callbacks = options.callbacks;
    this._connectAsUser = options.connectAsUser ?? false;
    this._websocketOptions = options.websocketOptions ?? {};
  }

  toString(): string {
    return this.constructor.name;
  }

  protected async _initialize(): Promise<void> {
    this._heyGenSession = await this._api.newSession(this._sessionRequest);
    logger.debug(`HeyGen sessionId: ${this._heyGenSession.sessionId}`);
    logger.debug(`HeyGen realtime_endpoint: ${this._heyGenSession.wsUrl}`);
    logger.debug(`HeyGen livekit URL: ${this._heyGenSession.livekitUrl}`);
    logger.debug(`HeyGen livekit token: ${this._heyGenSession.accessToken}`);
    logger.info(
      `Full Link: https://meet.livekit.io/custom?liveKitUrl=${this._heyGenSession.livekitUrl}&token=${this._heyGenSession.accessToken}`,
    );
    logger.info("HeyGen session started");
  }

  /**
   * Setup the client and initialize the conversation.
   *
   * Establishes a new session with HeyGen's API if one doesn't exist. Shared
   * by the input and output transports: only the first owner runs it.
   *
   * @param setup The frame processor setup configuration.
   */
  async setup(setup: FrameProcessorSetup): Promise<void> {
    this._taskManager = setup.taskManager;
    try {
      await this._initialize();

      const queue = new Queue<[EventCallback, ...string[]]>();
      this._eventQueue = queue;
      this._eventTask = this._taskManager.createTask(
        () => this._callbackTaskHandler(queue),
        `${this}::event_callback_task`,
      );

      this._inSampleRate = this._params.audioInSampleRate || setup.audioInSampleRate;
      this._outSampleRate = this._params.audioOutSampleRate || setup.audioOutSampleRate;
      await this._wsConnect();
      await this._livekitConnect();

      this._keepAliveTask = this._taskManager.createTask(
        () => this._keepAliveHandler(),
        "HeyGenClient_KeepAlive",
      );
      this._callEventCallback(this._callbacks.onConnected);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Failed to setup HeyGenClient: ${errorText(e)}`);
      await this._teardown();
    }
  }

  /** Cleanup client resources once the last processor is done with them. */
  async cleanup(): Promise<void> {
    await this._teardown();
  }

  static {
    HeyGenClient.prototype.setup = acquires("client")(HeyGenClient.prototype.setup) as (
      setup: FrameProcessorSetup,
    ) => Promise<void>;
    HeyGenClient.prototype.cleanup = releases("client")(
      HeyGenClient.prototype.cleanup,
    ) as () => Promise<void>;
  }

  /** Close every connection and cancel every task, and can run again. */
  protected async _teardown(): Promise<void> {
    try {
      if (this._keepAliveTask && this._taskManager) {
        await this._taskManager.cancelTask(this._keepAliveTask);
        this._keepAliveTask = null;
      }

      await this._wsDisconnect();
      await this._livekitDisconnect();

      if (this._eventTask && this._taskManager) {
        await this._taskManager.cancelTask(this._eventTask);
        this._eventTask = null;
      }

      if (this._heyGenSession !== null) {
        await this._api.closeSession(this._heyGenSession.sessionId);
        this._heyGenSession = null;
        this._connected = false;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Exception during cleanup: ${errorText(e)}`);
    }
  }

  /**
   * Stop the client and terminate all connections.
   *
   * Tears the connections down there and then, however many processors
   * still hold the client, since the session is ending for all of them.
   */
  async stop(): Promise<void> {
    logger.debug("HeyGenVideoService stopping");
    await this._teardown();
  }

  // websocket connection methods

  /** Connect to HeyGen websocket endpoint. */
  protected async _wsConnect(): Promise<void> {
    try {
      if (this._websocket) {
        logger.debug("HeyGenClient ws already connected!");
        return;
      }
      if (this._heyGenSession === null) throw new Error("no HeyGen session");
      if (this._taskManager === null) throw new Error("no task manager");
      if (this._heyGenSession.wsUrl === null) {
        // DIVERGENCE: LiveAvatar documents ws_url as optional; upstream's
        // model rejects a session without one.
        logger.warning(`${this} session has no websocket URL; avatar control is unavailable`);
        return;
      }
      logger.debug("HeyGenClient ws connecting");

      this._websocket = await websocketConnect(this._heyGenSession.wsUrl, this._websocketOptions);
      this._connected = true;
      this._receiveTask = this._taskManager.createTask(
        () => this._wsReceiveTaskHandler(),
        "HeyGenClient_Websocket",
      );
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} initialization error: ${errorText(e)}`);
      this._websocket = null;
    }
  }

  /** Handle incoming WebSocket messages. */
  protected async _wsReceiveTaskHandler(): Promise<void> {
    try {
      while (this._connected) {
        if (this._websocket === null) {
          // should never happen while _connected is true
          break;
        }
        try {
          const message = await this._websocket.recv();
          const parsedMessage = pyJsonLoads(
            typeof message === "string" ? message : new TextDecoder().decode(message),
          ) as Record<string, unknown>;
          await this._handleWsServerEvent(parsedMessage);
        } catch (e) {
          if (e instanceof ConnectionClosedOK) {
            logger.debug("HeyGenClient: WebSocket closed normally");
            break;
          }
          rethrowIfCancelled(e);
          logger.error(`Error processing WebSocket message: ${errorText(e)}`);
          break;
        }
      }
    } finally {
      this._connected = false;
      logger.debug("HeyGenClient: WS receive handler exited, state cleaned up");
    }
  }

  /** Handle an event from HeyGen websocket. */
  protected async _handleWsServerEvent(event: Record<string, unknown>): Promise<void> {
    const eventType = event.type;
    if (eventType === "session.state_updated") {
      const state = event.state;
      logger.debug(`HeyGenClient ws session state updated: ${state}`);
    } else if (eventType === "agent.state_updated") {
      logger.debug(
        `HeyGenClient ws agent state updated: ${event.previous_state} -> ${event.new_state}`,
      );
    } else {
      logger.trace(`HeyGenClient ws received unknown event: ${eventType}`);
    }
  }

  /** Disconnect from HeyGen websocket endpoint. */
  protected async _wsDisconnect(): Promise<void> {
    try {
      this._connected = false;
      if (this._receiveTask && this._taskManager) {
        await this._taskManager.cancelTask(this._receiveTask);
        this._receiveTask = null;
      }
      if (this._websocket) {
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} disconnect error: ${errorText(e)}`);
    } finally {
      this._websocket = null;
    }
  }

  /** Send a message to HeyGen websocket. */
  protected async _wsSend(message: Record<string, unknown>): Promise<void> {
    if (!this._connected) {
      logger.debug(`${this} websocket is not connected anymore.`);
      return;
    }
    try {
      if (this._websocket) {
        await this._websocket.send(pyJsonDumps(message));
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Error sending message to HeyGen websocket: ${errorText(e)}`);
      throw e;
    }
  }

  /** Periodically send keep-alive to prevent session timeout (5 min inactivity limit). */
  protected async _keepAliveHandler(): Promise<void> {
    while (this._connected) {
      await sleep(150); // 2.5 minutes
      if (this._connected) {
        try {
          await this._wsSend({
            type: "session.keep_alive",
            event_id: crypto.randomUUID(),
          });
          logger.debug("HeyGenClient: Sent keep-alive");
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`HeyGenClient: Keep-alive failed: ${errorText(e)}`);
        }
      }
    }
  }

  /**
   * Interrupt the avatar's current action.
   *
   * Stops the current animation/speech and returns the avatar to idle state.
   * Useful for handling user interruptions during avatar speech.
   *
   * @param eventId The event to interrupt, or null when the avatar is not
   *   mid-utterance.
   */
  async interrupt(eventId: string | null): Promise<void> {
    logger.debug("HeyGenClient interrupt");
    this._resetAudioTiming();
    await this._wsSend({
      type: "agent.interrupt",
      event_id: eventId,
    });
  }

  /**
   * Start the avatar's listening animation.
   *
   * Triggers visual cues indicating the avatar is listening to user input.
   */
  async startAgentListening(): Promise<void> {
    logger.debug("HeyGenClient start_agent_listening");
    await this._wsSend({
      type: "agent.start_listening",
      event_id: crypto.randomUUID(),
    });
  }

  /**
   * Stop the avatar's listening animation.
   *
   * Returns the avatar to idle state from listening state.
   */
  async stopAgentListening(): Promise<void> {
    await this._wsSend({
      type: "agent.stop_listening",
      event_id: crypto.randomUUID(),
    });
  }

  /** Indicates that the output transport is ready and able to receive frames. */
  transportReady(): void {
    this._transportReady = true;
  }

  /** The output sample rate in Hz. */
  get outSampleRate(): number {
    return this._outSampleRate;
  }

  /** The input sample rate in Hz. */
  get inSampleRate(): number {
    return this._inSampleRate;
  }

  /**
   * Send audio data to the agent speak.
   *
   * @param audio Audio data as raw bytes (will be base64 encoded).
   * @param eventId Unique identifier for the event.
   */
  async agentSpeak(audio: Uint8Array, eventId: string): Promise<void> {
    const audioBase64 = bytesToBase64(audio);
    await this._wsSend({
      type: "agent.speak",
      audio: audioBase64,
      event_id: eventId,
    });
    // Simulate audio playback with a sleep.
    await this._writeAudioSleep(audio.length);
  }

  /** Reset audio timing control variables. */
  protected _resetAudioTiming(): void {
    this._audioSecondsSent = 0.0;
    this._nextSendTime = 0;
  }

  /**
   * Simulate audio playback timing with appropriate delays.
   *
   * @param audioBytes Number of raw audio bytes sent (24kHz, 16-bit mono).
   */
  protected async _writeAudioSleep(audioBytes: number): Promise<void> {
    // Compute actual audio duration from bytes (24kHz, 16-bit mono = 2 bytes/sample)
    const chunkDuration = audioBytes / (HEY_GEN_SAMPLE_RATE * 2);

    // Skip sleeping for the first 3 seconds of audio to reduce initial latency
    if (this._audioSecondsSent < 3.0) {
      this._audioSecondsSent += chunkDuration;
      this._nextSendTime = monotonic() + chunkDuration;
      return;
    }

    // After first 3 seconds, pace sends to match real-time playback
    const currentTime = monotonic();
    const sleepDuration = Math.max(0, this._nextSendTime - currentTime);
    if (sleepDuration > 0) {
      await sleep(sleepDuration);
      this._nextSendTime += chunkDuration;
    } else {
      this._nextSendTime = monotonic() + chunkDuration;
    }
  }

  /**
   * Send signaling that the agent has finished speaking.
   *
   * @param eventId Unique identifier for the event.
   */
  async agentSpeakEnd(eventId: string): Promise<void> {
    this._resetAudioTiming();
    await this._wsSend({
      type: "agent.speak_end",
      event_id: eventId,
    });
  }

  /**
   * Capture audio frames from the HeyGen avatar.
   *
   * @param participantId Identifier of the participant to capture audio from.
   * @param callback Async function to handle received audio frames.
   */
  async captureParticipantAudio(
    participantId: string,
    callback: AudioFrameCallback,
  ): Promise<void> {
    const taskManager = this._requireTaskManager();

    logger.debug(`capture_participant_audio: ${participantId}, sample_rate: ${this._inSampleRate}`);
    this._audioFrameCallback = callback;
    if (this._audioTask !== null) {
      logger.warning(
        "Trying to capture more than one audio stream. It is currently not supported.",
      );
      return;
    }

    // Check if we already have audio tracks and participant is connected
    const participant = this._livekitRoom?.remoteParticipants.get(participantId);
    if (participant) {
      for (const trackPub of participant.trackPublications.values()) {
        if (trackPub.kind === rtc.TrackKind.KIND_AUDIO && trackPub.track) {
          logger.debug(`Starting audio capture for existing track: ${trackPub.sid}`);
          const audioStream = new rtc.AudioStream(trackPub.track, {
            sampleRate: this._inSampleRate,
          });
          this._audioTask = taskManager.createTask(
            () => this._processAudioFrames(audioStream),
            "HeyGenClient_Receive_Audio",
          );
          break;
        }
      }
    }
  }

  /**
   * Capture video frames from the HeyGen avatar.
   *
   * @param participantId Identifier of the participant to capture video from.
   * @param callback Async function to handle received video frames.
   */
  async captureParticipantVideo(
    participantId: string,
    callback: VideoFrameCallback,
  ): Promise<void> {
    const taskManager = this._requireTaskManager();

    logger.debug(`capture_participant_video: ${participantId}`);
    this._videoFrameCallback = callback;
    if (this._videoTask !== null) {
      logger.warning(
        "Trying to capture more than one audio stream. It is currently not supported.",
      );
      return;
    }

    // Check if we already have video tracks and participant is connected
    const participant = this._livekitRoom?.remoteParticipants.get(participantId);
    if (participant) {
      for (const trackPub of participant.trackPublications.values()) {
        if (trackPub.kind === rtc.TrackKind.KIND_VIDEO && trackPub.track) {
          logger.debug(`Starting video capture for existing track: ${trackPub.sid}`);
          const videoStream = new rtc.VideoStream(trackPub.track);
          this._videoTask = taskManager.createTask(
            () => this._processVideoFrames(videoStream),
            "HeyGenClient_Receive_Video",
          );
          break;
        }
      }
    }
  }

  protected _requireTaskManager(): BaseTaskManager {
    if (this._taskManager === null) throw new Error(`${this} is not set up`);
    return this._taskManager;
  }

  // Livekit integration to receive audio and video

  /** Process audio frames from LiveKit stream. */
  protected async _processAudioFrames(stream: InstanceType<Rtc["AudioStream"]>): Promise<void> {
    // The JS SDK's streams are ReadableStreams. Reading through a reader
    // (wrapped in abortable(), so cancelling the task stops the read) lets
    // us cancel the stream on the way out.
    const reader = stream.getReader();
    try {
      logger.debug("Starting audio frame processing...");
      for (;;) {
        const { done, value: audioFrame } = await abortable(reader.read());
        if (done) break;
        try {
          // Convert audio to raw bytes
          const data = audioFrame.data;
          const audioData = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();

          const frame: HeyGenAudioData = {
            audio: audioData,
            sampleRate: audioFrame.sampleRate,
            numChannels: 1, // HeyGen uses mono audio
          };
          if (this._transportReady && this._audioFrameCallback) {
            await this._audioFrameCallback(frame);
          }
        } catch (e) {
          rethrowIfCancelled(e);
          logger.error(`Error processing audio frame: ${errorText(e)}`);
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Error processing audio frames: ${errorText(e)}`);
    } finally {
      await cancelReader(reader);
      logger.debug("Audio frame processing ended.");
    }
  }

  /** Process video frames from LiveKit stream. */
  protected async _processVideoFrames(stream: InstanceType<Rtc["VideoStream"]>): Promise<void> {
    const reader = stream.getReader();
    try {
      logger.debug("Starting video frame processing...");
      for (;;) {
        const { done, value: frameEvent } = await abortable(reader.read());
        if (done) break;
        try {
          let videoFrame = frameEvent.frame;

          // Convert to RGB24 if not already
          if (videoFrame.type !== rtc.VideoBufferType.RGB24) {
            videoFrame = videoFrame.convert(rtc.VideoBufferType.RGB24);
          }

          // Create frame with original dimensions
          const imageFrame: HeyGenImageData = {
            image: videoFrame.data.slice(),
            size: [videoFrame.width, videoFrame.height],
            format: "RGB",
          };
          if (this._transportReady && this._videoFrameCallback) {
            await this._videoFrameCallback(imageFrame);
          }
        } catch (e) {
          rethrowIfCancelled(e);
          logger.error(`Error processing individual video frame: ${errorText(e)}`);
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Error processing video frames: ${errorText(e)}`);
    } finally {
      await cancelReader(reader);
      logger.debug("Video frame processing ended.");
    }
  }

  /** Connect to LiveKit room. */
  protected async _livekitConnect(): Promise<void> {
    const session = this._heyGenSession;
    if (session === null) throw new Error("no HeyGen session");
    const taskManager = this._requireTaskManager();

    try {
      logger.debug(`HeyGenClient livekit connecting to room URL: ${session.livekitUrl}`);
      // Loaded here, not at import, because it loads a native addon.
      await loadRtc();
      const room = new rtc.Room();
      this._livekitRoom = room;

      room.on("participantConnected", (participant: RemoteParticipant) => {
        logger.debug(
          `Participant connected - SID: ${participant.sid}, Identity: ${participant.identity}`,
        );
        for (const trackPub of participant.trackPublications.values()) {
          logger.debug(
            `Available track - SID: ${trackPub.sid}, Kind: ${trackPub.kind}, Name: ${trackPub.name}`,
          );
        }
        this._callEventCallback(this._callbacks.onParticipantConnected, participant.identity);
      });

      room.on(
        "trackSubscribed",
        (track: RemoteTrack, publication: RemoteTrackPublication, _p: RemoteParticipant) => {
          if (
            track.kind === rtc.TrackKind.KIND_VIDEO &&
            this._videoFrameCallback !== null &&
            this._videoTask === null
          ) {
            logger.debug(`Creating video stream processor for track: ${publication.sid}`);
            const videoStream = new rtc.VideoStream(track as Track);
            this._videoTask = taskManager.createTask(
              () => this._processVideoFrames(videoStream),
              "HeyGenClient_Receive_Video",
            );
          } else if (
            track.kind === rtc.TrackKind.KIND_AUDIO &&
            this._audioFrameCallback !== null &&
            this._audioTask === null
          ) {
            logger.debug(`Creating audio stream processor for track: ${publication.sid}`);
            const audioStream = new rtc.AudioStream(track as Track, {
              sampleRate: this._inSampleRate,
            });
            this._audioTask = taskManager.createTask(
              () => this._processAudioFrames(audioStream),
              "HeyGenClient_Receive_Audio",
            );
          }
        },
      );

      room.on(
        "trackUnsubscribed",
        (track: RemoteTrack, publication: RemoteTrackPublication, _p: RemoteParticipant) => {
          logger.debug(`Track unsubscribed - SID: ${publication.sid}, Kind: ${track.kind}`);
        },
      );

      room.on("participantDisconnected", (participant: RemoteParticipant) => {
        logger.debug(
          `Participant disconnected - SID: ${participant.sid}, Identity: ${participant.identity}`,
        );
        this._callEventCallback(this._callbacks.onParticipantDisconnected, participant.identity);
      });

      let accessToken = !this._connectAsUser ? session.livekitAgentToken : session.accessToken;
      if (accessToken === null) {
        // DIVERGENCE: LiveAvatar documents livekit_agent_token as optional;
        // without one we join with the session's client token.
        logger.warning(`${this} session has no LiveKit agent token; joining with the client token`);
        accessToken = session.accessToken;
      }

      await abortable(room.connect(session.livekitUrl, accessToken));
      logger.debug(`Successfully connected to LiveKit room: ${room.name}`);
      logger.debug(`Local participant SID: ${room.localParticipant?.sid}`);
      logger.debug(`Number of remote participants: ${room.remoteParticipants.size}`);

      // Log existing participants and their tracks
      for (const participant of room.remoteParticipants.values()) {
        logger.debug(
          `Existing participant - SID: ${participant.sid}, Identity: ${participant.identity}`,
        );
        this._callEventCallback(this._callbacks.onParticipantConnected, participant.identity);
        for (const trackPub of participant.trackPublications.values()) {
          logger.debug(
            `Existing track - SID: ${trackPub.sid}, Kind: ${trackPub.kind}, Name: ${trackPub.name}`,
          );
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`LiveKit initialization error: ${errorText(e)}`);
      this._livekitRoom = null;
    }
  }

  /** Disconnect from LiveKit room. */
  protected async _livekitDisconnect(): Promise<void> {
    try {
      logger.debug("Starting LiveKit disconnect...");
      if (this._videoTask) {
        await this._requireTaskManager().cancelTask(this._videoTask);
        this._videoTask = null;
      }

      if (this._audioTask) {
        await this._requireTaskManager().cancelTask(this._audioTask);
        this._audioTask = null;
      }

      if (this._livekitRoom) {
        logger.debug("Disconnecting from LiveKit room");
        await abortable(this._livekitRoom.disconnect());
        this._livekitRoom = null;
        logger.debug("Successfully disconnected from LiveKit room");
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`LiveKit disconnect error: ${errorText(e)}`);
    }
  }

  //
  // Queue callback handling
  //

  /** Queue an event callback for async execution. */
  protected _callEventCallback(callback: EventCallback, ...args: string[]): void {
    if (this._eventQueue !== null) {
      this._eventQueue.putNowait([callback, ...args]);
    }
  }

  /** Handle queued callbacks from the specified queue. */
  protected async _callbackTaskHandler(queue: Queue<[EventCallback, ...string[]]>): Promise<void> {
    for (;;) {
      const [callback, ...args] = await queue.get();
      await callback(...args);
      queue.taskDone();
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Cancel a stream reader on the way out of a reading loop, ignoring failures. */
async function cancelReader(reader: ReadableStreamDefaultReader<unknown>): Promise<void> {
  try {
    await reader.cancel();
  } catch (e) {
    rethrowIfCancelled(e);
    // The stream is already closed or errored.
  }
}
