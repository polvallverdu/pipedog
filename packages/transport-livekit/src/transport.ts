// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/livekit/transport.py

/**
 * LiveKit transport implementation for Pipecat.
 *
 * This module provides comprehensive LiveKit real-time communication integration
 * including audio streaming, data messaging, participant management, and room
 * event handling for conversational AI applications.
 *
 * Media runs on LiveKit's native Node SDK, `@livekit/rtc-node` (Python:
 * `livekit.rtc`), loaded when the transport is set up (see `rtc.ts`). It runs
 * on Bun, Node and Deno on the platforms the SDK ships prebuilt binaries for,
 * and not on Cloudflare Workers.
 */

// The SDK's types, from the optional peer dependency. Type-only: nothing here
// loads the native addon.
import type {
  AudioFrame as RtcAudioFrame,
  AudioSource as RtcAudioSource,
  LocalAudioTrack as RtcLocalAudioTrack,
  LocalVideoTrack as RtcLocalVideoTrack,
  Room as RtcRoom,
  Track as RtcTrack,
  TrackPublication as RtcTrackPublication,
  TrackPublishOptions as RtcTrackPublishOptions,
  VideoFrame as RtcVideoFrame,
  VideoFrameEvent as RtcVideoFrameEvent,
  VideoSource as RtcVideoSource,
} from "@livekit/rtc-node";
import {
  abortable,
  Lock,
  Queue,
  rethrowIfCancelled,
  sleep,
  type Task,
  waitFor,
} from "@pipedog/asyncio";
import { KeypadEntry } from "@pipedog/core/audio/dtmf/types";
import type { BaseAudioResampler } from "@pipedog/core/audio/resamplers/base_audio_resampler";
import { createStreamResampler, mixAudio } from "@pipedog/core/audio/utils";
import {
  BotConnectedFrame,
  type CancelFrame,
  ClientConnectedFrame,
  type EndFrame,
  type Frame,
  InputAudioRawFrame,
  InputDTMFFrame,
  InputTransportMessageFrame,
  type InputTransportMessageFrameOptions,
  InterruptionFrame,
  type OutputAudioRawFrame,
  type OutputDTMFFrame,
  type OutputDTMFUrgentFrame,
  type OutputImageRawFrame,
  OutputTransportMessageFrame,
  type OutputTransportMessageFrameOptions,
  OutputTransportMessageUrgentFrame,
  type OutputTransportMessageUrgentFrameOptions,
  type StartFrame,
  UserAudioRawFrame,
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
import {
  BaseTransport,
  TransportParams,
  type TransportParamsOptions,
} from "@pipedog/core/transports/base_transport";
import { _captureFramerate, _VideoInSamplers } from "@pipedog/core/transports/video_in_sampler";
import type { BaseTaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { loadRtc, rtc } from "./rtc.ts";

/** DTMF mapping according to RFC 4733. */
export const DTMF_CODE_MAP: Record<string, number> = {
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "*": 10,
  "#": 11,
};

/**
 * Maps Pipecat's PIL-style color format strings (`OutputImageRawFrame.format`,
 * configured via `TransportParams.videoOutColorFormat`) to the name of LiveKit's
 * `VideoBufferType` used by `rtc.VideoFrame` and its bytes per pixel.
 *
 * DIVERGENCE: holds the enum member's name, not its value, because the SDK
 * (and its enums) is loaded lazily; `_livekitVideoBufferType()` resolves it.
 */
export const LIVEKIT_VIDEO_BUFFER_TYPES: Record<
  string,
  ["RGB24" | "RGBA" | "BGRA" | "ARGB", number]
> = {
  RGB: ["RGB24", 3],
  RGBA: ["RGBA", 4],
  BGRA: ["BGRA", 4],
  ARGB: ["ARGB", 4],
};

export const CAM_VIDEO_SOURCE = "camera";
export const SCREEN_VIDEO_SOURCE = "screenVideo";

/**
 * The Pipecat video source of a published video track.
 *
 * A screen share is `"screenVideo"`. Any other video, including a track
 * published without a source, is `"camera"`.
 */
export function _videoSource(publication: { source?: unknown }): string {
  if (publication.source === rtc.TrackSource.SOURCE_SCREENSHARE) {
    return SCREEN_VIDEO_SOURCE;
  }
  return CAM_VIDEO_SOURCE;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A participant as the room's events pass it (only the fields used here). */
export interface LiveKitParticipantLike {
  readonly identity: string;
}

/**
 * An audio frame received from a participant.
 *
 * DIVERGENCE: `@livekit/rtc-node`'s `AudioStream` yields the frames
 * themselves; they are wrapped so the queue carries Python's
 * `rtc.AudioFrameEvent` shape.
 */
export interface AudioFrameEvent {
  frame: RtcAudioFrame;
}

/** A data packet received from the room, as Python's `rtc.DataPacket`. */
export interface DataPacket {
  data: Uint8Array;
  /** The sender, or null for packets sent by a server SDK. */
  participant: LiveKitParticipantLike | null;
}

/** A SIP DTMF tone received from the room, as Python's `rtc.SipDTMF`. */
export interface SipDTMF {
  code: number;
  digit: string;
  participant?: LiveKitParticipantLike | null;
}

/**
 * A participant's media stream, owned by the client.
 *
 * DIVERGENCE: `@livekit/rtc-node`'s `AudioStream`/`VideoStream` are
 * `ReadableStream`s, which have no `aclose()` and cannot be cancelled while a
 * reader holds them. This keeps the reader, so `aclose()` ends the stream
 * whether or not it is being read.
 */
export class LiveKitMediaStream<T> {
  readonly stream: ReadableStream<T>;
  #reader: ReadableStreamDefaultReader<T> | null = null;
  #closed = false;

  constructor(stream: ReadableStream<T>) {
    this.stream = stream;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    if (this.#closed) return;
    const reader = this.stream.getReader();
    this.#reader = reader;
    try {
      while (true) {
        const { done, value } = await abortable(reader.read());
        if (done) return;
        yield value;
      }
    } finally {
      this.#reader = null;
      try {
        reader.releaseLock();
      } catch (e) {
        rethrowIfCancelled(e);
      }
    }
  }

  /** Close the stream, releasing its native handle. */
  async aclose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#reader) await this.#reader.cancel();
    else await this.stream.cancel();
  }
}

export interface LiveKitInputTransportMessageFrameOptions
  extends InputTransportMessageFrameOptions {
  /** ID of the participant this message is from. */
  participantId?: string | null;
}

/**
 * Frame for incoming transport messages from LiveKit rooms.
 *
 * - `participantId`: ID of the participant this message is from.
 */
export class LiveKitInputTransportMessageFrame extends InputTransportMessageFrame {
  participantId: string | null;

  constructor(options: LiveKitInputTransportMessageFrameOptions) {
    super(options);
    this.participantId = options.participantId ?? null;
  }
}

export interface LiveKitOutputTransportMessageFrameOptions
  extends OutputTransportMessageFrameOptions {
  /** Optional ID of the participant this message is for/from. */
  participantId?: string | null;
}

/**
 * Frame for transport messages in LiveKit rooms.
 *
 * - `participantId`: Optional ID of the participant this message is for/from.
 */
export class LiveKitOutputTransportMessageFrame extends OutputTransportMessageFrame {
  participantId: string | null;

  constructor(options: LiveKitOutputTransportMessageFrameOptions) {
    super(options);
    this.participantId = options.participantId ?? null;
  }
}

export interface LiveKitOutputTransportMessageUrgentFrameOptions
  extends OutputTransportMessageUrgentFrameOptions {
  /** Optional ID of the participant this message is for/from. */
  participantId?: string | null;
}

/**
 * Frame for urgent transport messages in LiveKit rooms.
 *
 * - `participantId`: Optional ID of the participant this message is for/from.
 */
export class LiveKitOutputTransportMessageUrgentFrame extends OutputTransportMessageUrgentFrame {
  participantId: string | null;

  constructor(options: LiveKitOutputTransportMessageUrgentFrameOptions) {
    super(options);
    this.participantId = options.participantId ?? null;
  }
}

export interface LiveKitParamsOptions extends TransportParamsOptions {
  /**
   * Receive each participant's audio as its own stream of `UserAudioRawFrame`s
   * tagged with their identity (the default). All of these streams enter the
   * pipeline through the one input transport, so a pipeline that runs a single
   * STT and VAD should only receive one of them. When false, the participants'
   * audio is mixed into a single stream of `InputAudioRawFrame`s.
   */
  audioInUserTracks?: boolean;
  /** Buffer size of the outgoing audio source, in milliseconds (LiveKit's default is 1000). */
  audioOutQueueSizeMs?: number;
  /**
   * Maximum bitrate of the published video track, in bits per second, capped
   * at `videoOutFramerate`. LiveKit chooses the encoding from the track
   * resolution when unset.
   */
  videoOutMaxBitrate?: number | null;
}

/**
 * Configuration parameters for LiveKit transport.
 *
 * Video output publishes a single `"pipecat-video"` camera track (mirroring how
 * audio output always publishes one `"pipecat-audio"` microphone track) when
 * `videoOutEnabled` is set. The track is sized using
 * `videoOutWidth`/`videoOutHeight` and encodes frames according to
 * `videoOutColorFormat` (default `"RGB"`); `videoOutFramerate` governs how
 * often `BaseOutputTransport` draws frames. Per-destination video routing
 * (multiple named output tracks, as supported by Daily's
 * `cameraOutEnabled`/`registerVideoDestination`) is not yet implemented for
 * LiveKit.
 *
 * `videoOutCodec` selects the published video codec (`"VP8"`, `"H264"`,
 * `"VP9"`, `"AV1"` or `"H265"`); LiveKit picks one when it is unset.
 *
 * With `videoInEnabled`, a user's camera (`"camera"`) and screen share
 * (`"screenVideo"`) are received separately. Without `videoInSources`, every
 * frame of every video track is passed on. With it, only the listed sources
 * are, each at its own framerate, plus any source captured with
 * `LiveKitTransport.captureParticipantVideo()`.
 */
export class LiveKitParams extends TransportParams {
  audioInUserTracks: boolean;
  audioOutQueueSizeMs: number;
  videoOutMaxBitrate: number | null;

  constructor(options: LiveKitParamsOptions = {}) {
    super(options);
    this.audioInUserTracks = options.audioInUserTracks ?? true;
    this.audioOutQueueSizeMs = options.audioOutQueueSizeMs ?? 1000;
    this.videoOutMaxBitrate = options.videoOutMaxBitrate ?? null;
  }
}

export interface LiveKitCallbacksOptions {
  /** Called when connected to the LiveKit room. */
  onConnected: () => Promise<void>;
  /** Called when disconnected from the LiveKit room. */
  onDisconnected: () => Promise<void>;
  /** Called just before disconnecting from the LiveKit room. */
  onBeforeDisconnect: () => Promise<void>;
  /** Called when a participant joins the room. */
  onParticipantConnected: (participantId: string) => Promise<void>;
  /** Called when a participant leaves the room. */
  onParticipantDisconnected: (participantId: string) => Promise<void>;
  /** Called when an audio track is subscribed. */
  onAudioTrackSubscribed: (participantId: string) => Promise<void>;
  /** Called when an audio track is unsubscribed. */
  onAudioTrackUnsubscribed: (participantId: string) => Promise<void>;
  /** Called when a video track is subscribed. */
  onVideoTrackSubscribed: (participantId: string) => Promise<void>;
  /** Called with the participant and video source when a video track is unsubscribed. */
  onVideoTrackUnsubscribed: (participantId: string, videoSource: string) => Promise<void>;
  /**
   * Called when data is received. The sender is null for packets sent by a
   * server SDK, which LiveKit delivers unattributed.
   */
  onDataReceived: (data: Uint8Array, participantId: string | null) => Promise<void>;
  /** Called when the first participant joins. */
  onFirstParticipantJoined: (participantId: string) => Promise<void>;
  /** Called when a SIP DTMF tone is received. */
  onDtmfEvent: (data: Record<string, unknown>) => Promise<void>;
  /**
   * Called with the identity of the room's loudest speaker when it changes.
   * The bot can be the speaker while it talks.
   */
  onActiveSpeakerChanged: (participantId: string) => Promise<void>;
  /**
   * Called with the participant and video source when a participant mutes a
   * video track, e.g. turns their camera off.
   */
  onVideoTrackMuted: (participantId: string, videoSource: string) => Promise<void>;
}

/** Callback handlers for LiveKit events. */
export class LiveKitCallbacks {
  /** The callback names (Python: `LiveKitCallbacks.model_fields`). */
  static readonly fields = [
    "onConnected",
    "onDisconnected",
    "onBeforeDisconnect",
    "onParticipantConnected",
    "onParticipantDisconnected",
    "onAudioTrackSubscribed",
    "onAudioTrackUnsubscribed",
    "onVideoTrackSubscribed",
    "onVideoTrackUnsubscribed",
    "onDataReceived",
    "onFirstParticipantJoined",
    "onDtmfEvent",
    "onActiveSpeakerChanged",
    "onVideoTrackMuted",
  ] as const;

  onConnected: LiveKitCallbacksOptions["onConnected"];
  onDisconnected: LiveKitCallbacksOptions["onDisconnected"];
  onBeforeDisconnect: LiveKitCallbacksOptions["onBeforeDisconnect"];
  onParticipantConnected: LiveKitCallbacksOptions["onParticipantConnected"];
  onParticipantDisconnected: LiveKitCallbacksOptions["onParticipantDisconnected"];
  onAudioTrackSubscribed: LiveKitCallbacksOptions["onAudioTrackSubscribed"];
  onAudioTrackUnsubscribed: LiveKitCallbacksOptions["onAudioTrackUnsubscribed"];
  onVideoTrackSubscribed: LiveKitCallbacksOptions["onVideoTrackSubscribed"];
  onVideoTrackUnsubscribed: LiveKitCallbacksOptions["onVideoTrackUnsubscribed"];
  onDataReceived: LiveKitCallbacksOptions["onDataReceived"];
  onFirstParticipantJoined: LiveKitCallbacksOptions["onFirstParticipantJoined"];
  onDtmfEvent: LiveKitCallbacksOptions["onDtmfEvent"];
  onActiveSpeakerChanged: LiveKitCallbacksOptions["onActiveSpeakerChanged"];
  onVideoTrackMuted: LiveKitCallbacksOptions["onVideoTrackMuted"];

  constructor(options: LiveKitCallbacksOptions) {
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    this.onBeforeDisconnect = options.onBeforeDisconnect;
    this.onParticipantConnected = options.onParticipantConnected;
    this.onParticipantDisconnected = options.onParticipantDisconnected;
    this.onAudioTrackSubscribed = options.onAudioTrackSubscribed;
    this.onAudioTrackUnsubscribed = options.onAudioTrackUnsubscribed;
    this.onVideoTrackSubscribed = options.onVideoTrackSubscribed;
    this.onVideoTrackUnsubscribed = options.onVideoTrackUnsubscribed;
    this.onDataReceived = options.onDataReceived;
    this.onFirstParticipantJoined = options.onFirstParticipantJoined;
    this.onDtmfEvent = options.onDtmfEvent;
    this.onActiveSpeakerChanged = options.onActiveSpeakerChanged;
    this.onVideoTrackMuted = options.onVideoTrackMuted;
  }
}

/** The task manager methods the client uses. */
export type LiveKitTaskManager = Pick<BaseTaskManager, "createTask">;

export interface LiveKitTransportClientOptions {
  /** LiveKit server URL to connect to. */
  url: string;
  /** Authentication token for the room. */
  token: string;
  /** Name of the LiveKit room to join. */
  roomName: string;
  /** Configuration parameters for the transport. */
  params: LiveKitParams;
  /** Event callback handlers. */
  callbacks: LiveKitCallbacks;
  /** Name identifier for the transport. */
  transportName: string;
}

// tenacity's @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=4, max=10)).
const CONNECT_ATTEMPTS = 3;
function connectRetryWait(attempt: number): number {
  return Math.min(Math.max(2 ** (attempt - 1), 4), 10);
}

/**
 * Core client for interacting with LiveKit rooms.
 *
 * Manages the connection to LiveKit rooms and handles all low-level API interactions
 * including room management, audio streaming, data messaging, and event handling.
 */
export class LiveKitTransportClient {
  _url: string;
  _token: string;
  _roomName: string;
  _params: LiveKitParams;
  _callbacks: LiveKitCallbacks;
  _transportName: string;
  _room: RtcRoom | null = null;
  _participantId = "";
  _connected = false;
  _disconnectCounter = 0;
  _outSampleRate = 0;
  _audioSource: RtcAudioSource | null = null;
  _audioTrack: RtcLocalAudioTrack | null = null;
  _audioTracks = new Map<string, RtcTrack>();
  _audioQueue = new Queue<[AudioFrameEvent, string]>();
  // Per-participant [stream, task] so unsubscribe can close the owned native
  // stream and cancel its producer task instead of leaking both on every
  // track republish.
  _audioStreams = new Map<
    string,
    [LiveKitMediaStream<RtcAudioFrame>, Task<unknown | undefined> | null]
  >();
  _videoSource: RtcVideoSource | null = null;
  _videoTrack: RtcLocalVideoTrack | null = null;
  // Video tracks and streams by participant and video source (keyed
  // `${participantId}\u0000${videoSource}`), so a user's camera and screen
  // share are received side by side.
  _videoTracks = new Map<string, RtcTrack>();
  _videoPublications = new Map<string, RtcTrackPublication>();
  _videoQueue = new Queue<[RtcVideoFrameEvent, string, string]>();
  _videoStreams = new Map<
    string,
    [LiveKitMediaStream<RtcVideoFrameEvent>, Task<unknown | undefined> | null]
  >();
  _otherParticipantHasJoined = false;
  _taskManager: LiveKitTaskManager | null = null;
  _activeSpeakerId: string | null = null;
  _asyncLock = new Lock();

  /**
   * Initialize the LiveKit transport client.
   *
   * @param options.url LiveKit server URL to connect to.
   * @param options.token Authentication token for the room.
   * @param options.roomName Name of the LiveKit room to join.
   * @param options.params Configuration parameters for the transport.
   * @param options.callbacks Event callback handlers.
   * @param options.transportName Name identifier for the transport.
   */
  constructor(options: LiveKitTransportClientOptions) {
    this._url = options.url;
    this._token = options.token;
    this._roomName = options.roomName;
    this._params = options.params;
    this._callbacks = options.callbacks;
    this._transportName = options.transportName;
  }

  /**
   * The key of a participant's video source in the video maps.
   *
   * DIVERGENCE: Python keys these dicts by `(participant_id, video_source)` tuples.
   */
  static videoKey(participantId: string, videoSource: string): string {
    return `${participantId}\u0000${videoSource}`;
  }

  /** Split a video map key back into `[participantId, videoSource]`. */
  static splitVideoKey(key: string): [string, string] {
    const i = key.indexOf("\u0000");
    return [key.slice(0, i), key.slice(i + 1)];
  }

  /** The participant ID assigned by LiveKit. */
  get participantId(): string {
    return this._participantId;
  }

  /**
   * The LiveKit room instance.
   *
   * @throws Error If room object is not available.
   */
  get room(): RtcRoom {
    if (!this._room) {
      throw new Error(`${this}: missing room object (pipeline not started?)`);
    }
    return this._room;
  }

  /**
   * Setup the client with task manager and room initialization.
   *
   * Loads `@livekit/rtc-node` the first time.
   *
   * @param setup The frame processor setup configuration.
   */
  async setup(setup: FrameProcessorSetup): Promise<void> {
    if (this._taskManager) return;

    await loadRtc();
    this._taskManager = setup.taskManager;
    this._room = new rtc.Room();

    this._outSampleRate = this._params.audioOutSampleRate || setup.audioOutSampleRate;

    // Set up room event handlers. The JS SDK's event names are camelCase, its
    // trackMuted passes (publication, participant), its dataReceived passes
    // the payload and sender, and SIP DTMF arrives as dtmfReceived.
    const room = this.room;
    room.on("participantConnected", (p) => this._onParticipantConnectedWrapper(p));
    room.on("participantDisconnected", (p) => this._onParticipantDisconnectedWrapper(p));
    room.on("trackSubscribed", (t, pub, p) => this._onTrackSubscribedWrapper(t, pub, p));
    room.on("trackUnsubscribed", (t, pub, p) => this._onTrackUnsubscribedWrapper(t, pub, p));
    room.on("trackMuted", (pub, p) => this._onTrackMutedWrapper(p, pub));
    room.on("dataReceived", (payload, p) =>
      this._onDataReceivedWrapper({ data: payload, participant: p ?? null }),
    );
    room.on("connected", () => this._onConnectedWrapper());
    room.on("disconnected", (reason) => this._onDisconnectedWrapper(reason));
    room.on("dtmfReceived", (code, digit, p) =>
      this._onSipDtmfReceivedWrapper({ code, digit, participant: p }),
    );
    room.on("activeSpeakersChanged", (speakers) => this._onActiveSpeakersChangedWrapper(speakers));
  }

  /** Cleanup client resources. */
  async cleanup(): Promise<void> {
    await this.disconnect();
  }

  /**
   * Connect to the LiveKit room with retry logic.
   *
   * Tries 3 times, waiting 4 seconds between attempts (upstream's tenacity
   * policy). DIVERGENCE: the last attempt's error is thrown, where tenacity
   * throws a `RetryError` wrapping it.
   */
  async connect(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this._connectOnce();
        return;
      } catch (e) {
        rethrowIfCancelled(e);
        if (attempt >= CONNECT_ATTEMPTS) throw e;
        await sleep(connectRetryWait(attempt));
      }
    }
  }

  /** One connection attempt (Python: `connect.__wrapped__`). */
  async _connectOnce(): Promise<void> {
    await this._asyncLock.run(async () => {
      if (this._connected) {
        // Increment disconnect counter if already connected.
        this._disconnectCounter += 1;
        return;
      }

      logger.info(`Connecting to ${this._roomName}`);
      this._activeSpeakerId = null;

      try {
        await abortable(
          this.room.connect(this._url, this._token, { autoSubscribe: true, dynacast: false }),
        );
        this._participantId = this.room.localParticipant!.identity;
        logger.info(`Connected to ${this._roomName} as ${this._participantId}`);

        // Set up audio source and track
        this._audioSource = new rtc.AudioSource(
          this._outSampleRate,
          this._params.audioOutChannels,
          this._params.audioOutQueueSizeMs,
        );
        this._audioTrack = rtc.LocalAudioTrack.createAudioTrack("pipecat-audio", this._audioSource);
        const options = new rtc.TrackPublishOptions();
        options.source = rtc.TrackSource.SOURCE_MICROPHONE;
        await abortable(this.room.localParticipant!.publishTrack(this._audioTrack, options));

        // Set up video source and track (only if video output is enabled;
        // unlike audio, which is always published).
        if (this._params.videoOutEnabled) {
          this._videoSource = new rtc.VideoSource(
            this._params.videoOutWidth,
            this._params.videoOutHeight,
          );
          this._videoTrack = rtc.LocalVideoTrack.createVideoTrack(
            "pipecat-video",
            this._videoSource,
          );
          const videoOptions = this._videoPublishOptions();
          await abortable(this.room.localParticipant!.publishTrack(this._videoTrack, videoOptions));
        }

        // Only mark the client connected once its tracks are published, so a
        // retry after a failed publish starts over instead of returning early
        // without tracks.
        this._connected = true;
        // Increment disconnect counter if we successfully connected.
        this._disconnectCounter += 1;

        await this._callbacks.onConnected();

        // Participants already in the room raise the same events as those who
        // join later.
        for (const participantId of this.getParticipants()) {
          await this._participantConnected(participantId);
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`Error connecting to ${this._roomName}: ${errorMessage(e)}`);
        if (!this._connected) await this._rollbackPartialConnect();
        throw e;
      }
    });
  }

  /** Build the publish options for the video track from the params. */
  _videoPublishOptions(): RtcTrackPublishOptions {
    // Built from an init object, so the SDK's protobuf message makes a
    // VideoEncoding message of the encoding fields.
    const init: Record<string, unknown> = { source: rtc.TrackSource.SOURCE_CAMERA };

    // LiveKit requires both fields of a video encoding, so the framerate is
    // only sent along with a bitrate.
    if (this._params.videoOutMaxBitrate !== null) {
      init.videoEncoding = {
        maxBitrate: BigInt(this._params.videoOutMaxBitrate),
        maxFramerate: this._params.videoOutFramerate,
      };
    }

    const codec = this._params.videoOutCodec;
    if (codec) {
      const value = (rtc.VideoCodec as unknown as Record<string, unknown>)[codec.toUpperCase()];
      if (typeof value === "number") {
        init.videoCodec = value;
      } else {
        const names = Object.keys(rtc.VideoCodec).filter((k) => Number.isNaN(Number(k)));
        logger.warning(
          `${this} unsupported video codec for LiveKit output: '${codec}', expected one of [${names.map((n) => `'${n}'`).join(", ")}]`,
        );
      }
    }

    return new rtc.TrackPublishOptions(init);
  }

  /** Undo a connection attempt that failed before it completed. */
  async _rollbackPartialConnect(): Promise<void> {
    await this._closeOutputSources();
    try {
      await abortable(this.room.disconnect());
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`${this} error disconnecting after failed connect: ${errorMessage(e)}`);
    }
  }

  /** Disconnect from the LiveKit room. */
  async disconnect(): Promise<void> {
    await this._asyncLock.run(async () => {
      // Decrement leave counter when leaving.
      this._disconnectCounter -= 1;

      if (!this._connected || this._disconnectCounter > 0) return;

      logger.info(`Disconnecting from ${this._roomName}`);
      await this._callbacks.onBeforeDisconnect();
      // Mark the client disconnected before the room disconnects, so the
      // room's own "disconnected" event does not report it a second time.
      this._connected = false;
      await abortable(this.room.disconnect());
      await this._closeOutputSources();
      // Close any remaining per-participant streams and cancel their producer
      // tasks so they do not outlive the connection.
      await this._closeAllStreams();
      logger.info(`Disconnected from ${this._roomName}`);
      await this._callbacks.onDisconnected();
    });
  }

  /**
   * Close the published audio and video sources.
   *
   * `room.disconnect()` does not release the native source handles, so each
   * connection would otherwise leave them behind.
   */
  async _closeOutputSources(): Promise<void> {
    const audioSource = this._audioSource;
    const videoSource = this._videoSource;
    this._audioSource = null;
    this._audioTrack = null;
    this._videoSource = null;
    this._videoTrack = null;
    for (const source of [audioSource, videoSource]) {
      if (source === null) continue;
      try {
        await abortable(source.close());
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this} error closing output source: ${errorMessage(e)}`);
      }
    }
  }

  /**
   * Send data to participants in the room.
   *
   * @param data The data bytes to send.
   * @param participantId Optional specific participant to send to.
   */
  async sendData(data: Uint8Array, participantId: string | null = null): Promise<void> {
    if (!this._connected) return;

    try {
      if (participantId) {
        await abortable(
          this.room.localParticipant!.publishData(data, {
            reliable: true,
            destination_identities: [participantId],
          }),
        );
      } else {
        await abortable(this.room.localParticipant!.publishData(data, { reliable: true }));
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Error sending data: ${errorMessage(e)}`);
    }
  }

  /**
   * Send DTMF tone to the room.
   *
   * @param digit The DTMF digit to send (0-9, *, #).
   */
  async sendDtmf(digit: string): Promise<void> {
    if (!this._connected) return;

    if (!(digit in DTMF_CODE_MAP)) {
      logger.warning(`Invalid DTMF digit: ${digit}`);
      return;
    }

    const code = DTMF_CODE_MAP[digit]!;

    try {
      await abortable(this.room.localParticipant!.publishDtmf(code, digit));
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Error sending DTMF tone ${digit}: ${errorMessage(e)}`);
    }
  }

  /**
   * Publish an audio frame to the room.
   *
   * @param audioFrame The LiveKit audio frame to publish.
   * @returns True if the frame was published.
   */
  async publishAudio(audioFrame: RtcAudioFrame): Promise<boolean> {
    if (!this._connected || !this._audioSource) return false;

    try {
      await abortable(this._audioSource.captureFrame(audioFrame));
      return true;
    } catch (e) {
      rethrowIfCancelled(e);
      // When using an audio mixer, the base output transport's withMixer()
      // generator continuously yields frames (mixed with background audio)
      // even when no TTS audio is queued. During interruptions, the audio task
      // is cancelled and recreated, but there is a brief window where the
      // native LiveKit AudioSource rejects captureFrame() with an InvalidState
      // error. This is a transient condition — the mixer will produce a new
      // frame within milliseconds, so we silently drop these frames.
      if (!String(e).includes("InvalidState")) {
        logger.error(`Error publishing audio: ${errorMessage(e)}`);
      }
      return false;
    }
  }

  /**
   * Publish a video frame to the room.
   *
   * @param videoFrame The LiveKit video frame to publish.
   * @returns True if the video frame was published successfully, False otherwise.
   */
  async publishVideo(videoFrame: RtcVideoFrame): Promise<boolean> {
    if (!this._connected || !this._videoSource) return false;

    try {
      // Unlike `AudioSource.captureFrame`, `VideoSource.captureFrame` is
      // synchronous in LiveKit's SDK.
      this._videoSource.captureFrame(videoFrame);
      return true;
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Error publishing video: ${errorMessage(e)}`);
      return false;
    }
  }

  /**
   * Get list of participant IDs in the room.
   *
   * @returns List of participant LiveKit identities.
   */
  getParticipants(): string[] {
    return [...this.room.remoteParticipants.values()].map((p) => p.identity);
  }

  /**
   * Get metadata for a specific participant.
   *
   * @param participantId LiveKit identity of the participant to get metadata for.
   * @returns Object containing participant metadata.
   */
  async getParticipantMetadata(participantId: string): Promise<Record<string, unknown>> {
    const participant = this.room.remoteParticipants.get(participantId);
    if (participant) {
      return {
        id: participant.identity,
        name: participant.name,
        metadata: participant.metadata,
      };
    }
    return {};
  }

  /**
   * Set metadata for the local participant.
   *
   * @param metadata Metadata string to set.
   */
  async setParticipantMetadata(metadata: string): Promise<void> {
    await abortable(this.room.localParticipant!.updateMetadata(metadata));
  }

  /**
   * Stop receiving a specific participant's audio.
   *
   * LiveKit doesn't let one participant force-mute another's microphone; this
   * unsubscribes the bot from their audio track instead.
   *
   * @param participantId LiveKit identity of the participant to stop receiving audio from.
   */
  async muteParticipant(participantId: string): Promise<void> {
    const participant = this.room.remoteParticipants.get(participantId);
    if (participant) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.kind === rtc.TrackKind.KIND_AUDIO) publication.setSubscribed(false);
      }
    }
  }

  /**
   * Resume receiving a specific participant's audio.
   *
   * @param participantId LiveKit identity of the participant to resume receiving audio from.
   */
  async unmuteParticipant(participantId: string): Promise<void> {
    const participant = this.room.remoteParticipants.get(participantId);
    if (participant) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.kind === rtc.TrackKind.KIND_AUDIO) publication.setSubscribed(true);
      }
    }
  }

  // Wrapper methods for event handlers

  /** Wrapper for participant connected events. */
  _onParticipantConnectedWrapper(participant: LiveKitParticipantLike): void {
    this._taskManager!.createTask(
      () => this._asyncOnParticipantConnected(participant),
      `${this}::_async_on_participant_connected`,
    );
  }

  /** Wrapper for participant disconnected events. */
  _onParticipantDisconnectedWrapper(participant: LiveKitParticipantLike): void {
    this._taskManager!.createTask(
      () => this._asyncOnParticipantDisconnected(participant),
      `${this}::_async_on_participant_disconnected`,
    );
  }

  /** Wrapper for track subscribed events. */
  _onTrackSubscribedWrapper(
    track: RtcTrack,
    publication: RtcTrackPublication,
    participant: LiveKitParticipantLike,
  ): void {
    this._taskManager!.createTask(
      () => this._asyncOnTrackSubscribed(track, publication, participant),
      `${this}::_async_on_track_subscribed`,
    );
  }

  /** Wrapper for track unsubscribed events. */
  _onTrackUnsubscribedWrapper(
    track: RtcTrack,
    publication: RtcTrackPublication,
    participant: LiveKitParticipantLike,
  ): void {
    this._taskManager!.createTask(
      () => this._asyncOnTrackUnsubscribed(track, publication, participant),
      `${this}::_async_on_track_unsubscribed`,
    );
  }

  /** Wrapper for track muted events. */
  _onTrackMutedWrapper(
    participant: LiveKitParticipantLike,
    publication: RtcTrackPublication,
  ): void {
    this._taskManager!.createTask(
      () => this._asyncOnTrackMuted(participant, publication),
      `${this}::_async_on_track_muted`,
    );
  }

  /** Handle track muted events. */
  async _asyncOnTrackMuted(
    participant: LiveKitParticipantLike,
    publication: RtcTrackPublication,
  ): Promise<void> {
    if (publication.kind === rtc.TrackKind.KIND_VIDEO) {
      const videoSource = _videoSource(publication);
      logger.info(`Video track muted: ${videoSource} from ${participant.identity}`);
      await this._callbacks.onVideoTrackMuted(participant.identity, videoSource);
    }
  }

  /** Wrapper for data received events. */
  _onDataReceivedWrapper(data: DataPacket): void {
    this._taskManager!.createTask(
      () => this._asyncOnDataReceived(data),
      `${this}::_async_on_data_received`,
    );
  }

  /** Wrapper for connected events. */
  _onConnectedWrapper(): void {
    this._taskManager!.createTask(() => this._asyncOnConnected(), `${this}::_async_on_connected`);
  }

  /** Wrapper for disconnected events. */
  _onDisconnectedWrapper(reason: unknown = null): void {
    this._taskManager!.createTask(
      () => this._asyncOnDisconnected(reason),
      `${this}::_async_on_disconnected`,
    );
  }

  /** Wrapper for inbound SIP DTMF events. */
  _onSipDtmfReceivedWrapper(dtmf: SipDTMF): void {
    this._taskManager!.createTask(
      () => this._asyncOnSipDtmfReceived(dtmf),
      `${this}::_async_on_sip_dtmf_received`,
    );
  }

  /**
   * Wrapper for active speakers changed events.
   *
   * LiveKit lists only the speakers whose level changed, quietest first, so
   * the last entry is the loudest and an empty list doesn't mean silence:
   * report the loudest speaker only when it changes, and keep the current one
   * through empty updates.
   */
  _onActiveSpeakersChangedWrapper(speakers: LiveKitParticipantLike[]): void {
    if (speakers.length === 0) return;
    const speakerId = speakers[speakers.length - 1]!.identity;
    if (speakerId === this._activeSpeakerId) return;
    this._activeSpeakerId = speakerId;
    this._taskManager!.createTask(
      () => this._asyncOnActiveSpeakerChanged(speakerId),
      `${this}::_async_on_active_speaker_changed`,
    );
  }

  // Async methods for event handling

  /** Handle participant connected events. */
  async _asyncOnParticipantConnected(participant: LiveKitParticipantLike): Promise<void> {
    await this._participantConnected(participant.identity);
  }

  /** Report a participant in the room, and whether they're the first. */
  async _participantConnected(participantId: string): Promise<void> {
    logger.info(`Participant connected: ${participantId}`);
    await this._callbacks.onParticipantConnected(participantId);
    if (!this._otherParticipantHasJoined) {
      this._otherParticipantHasJoined = true;
      await this._callbacks.onFirstParticipantJoined(participantId);
    }
  }

  /** Handle participant disconnected events. */
  async _asyncOnParticipantDisconnected(participant: LiveKitParticipantLike): Promise<void> {
    logger.info(`Participant disconnected: ${participant.identity}`);
    await this._callbacks.onParticipantDisconnected(participant.identity);
    if (this.getParticipants().length === 0) this._otherParticipantHasJoined = false;
  }

  /** Handle track subscribed events. */
  async _asyncOnTrackSubscribed(
    track: RtcTrack,
    publication: RtcTrackPublication,
    participant: LiveKitParticipantLike,
  ): Promise<void> {
    if (track.kind === rtc.TrackKind.KIND_AUDIO) {
      logger.info(`Audio track subscribed: ${track.sid} from participant ${participant.identity}`);
      // If the participant is re-publishing (e.g. mute/unmute cycle), close +
      // cancel the previous stream/task before replacing the registry entry,
      // so two producers never feed `_audioQueue` for the same participant.
      await this._closeAudioStream(participant.identity);
      this._audioTracks.set(participant.identity, track);
      const audioStream = new LiveKitMediaStream<RtcAudioFrame>(new rtc.AudioStream(track));
      const task = this._taskManager!.createTask(
        () => this._processAudioStream(audioStream, participant.identity),
        `${this}::_process_audio_stream`,
      );
      this._audioStreams.set(participant.identity, [audioStream, task ?? null]);
      await this._callbacks.onAudioTrackSubscribed(participant.identity);
    } else if (track.kind === rtc.TrackKind.KIND_VIDEO) {
      const videoSource = _videoSource(publication);
      logger.info(
        `Video track subscribed: ${track.sid} (${videoSource}) from participant ${participant.identity}`,
      );
      const key = LiveKitTransportClient.videoKey(participant.identity, videoSource);
      // Clean up any prior video stream/task for the same participant and
      // source before replacing.
      await this._closeVideoStream(participant.identity, videoSource);
      this._videoTracks.set(key, track);
      this._videoPublications.set(key, publication);
      // Only process video stream if video input is enabled to prevent
      // unbounded queue growth when there is no consumer for video frames.
      if (this._params.videoInEnabled) {
        const videoStream = new LiveKitMediaStream<RtcVideoFrameEvent>(new rtc.VideoStream(track));
        const task = this._taskManager!.createTask(
          () => this._processVideoStream(videoStream, participant.identity, videoSource),
          `${this}::_process_video_stream`,
        );
        this._videoStreams.set(key, [videoStream, task ?? null]);
      }
      await this._callbacks.onVideoTrackSubscribed(participant.identity);
    }
  }

  /** Handle track unsubscribed events. */
  async _asyncOnTrackUnsubscribed(
    track: RtcTrack,
    publication: RtcTrackPublication,
    participant: LiveKitParticipantLike,
  ): Promise<void> {
    logger.info(`Track unsubscribed: ${publication.sid} from ${participant.identity}`);
    if (track.kind === rtc.TrackKind.KIND_AUDIO) {
      await this._closeAudioStream(participant.identity);
      await this._callbacks.onAudioTrackUnsubscribed(participant.identity);
    } else if (track.kind === rtc.TrackKind.KIND_VIDEO) {
      const videoSource = _videoSource(publication);
      const key = LiveKitTransportClient.videoKey(participant.identity, videoSource);
      this._videoTracks.delete(key);
      this._videoPublications.delete(key);
      await this._closeVideoStream(participant.identity, videoSource);
      await this._callbacks.onVideoTrackUnsubscribed(participant.identity, videoSource);
    }
  }

  /**
   * Close a participant's owned audio stream and cancel its producer task.
   *
   * Idempotent: no-op when there is no registered stream for the participant.
   */
  async _closeAudioStream(participantId: string): Promise<void> {
    const entry = this._audioStreams.get(participantId);
    if (entry === undefined) return;
    this._audioStreams.delete(participantId);
    const [stream, task] = entry;
    try {
      await waitFor(() => abortable(stream.aclose()), 2.0);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`AudioStream.aclose failed for ${participantId}: ${errorMessage(e)}`);
    }
    if (task && !task.done()) task.cancel();
  }

  /**
   * Close a participant's owned video stream and cancel its producer task.
   *
   * Idempotent: no-op when there is no registered stream for the participant
   * and video source.
   */
  async _closeVideoStream(participantId: string, videoSource: string): Promise<void> {
    const key = LiveKitTransportClient.videoKey(participantId, videoSource);
    const entry = this._videoStreams.get(key);
    if (entry === undefined) return;
    this._videoStreams.delete(key);
    const [stream, task] = entry;
    try {
      await waitFor(() => abortable(stream.aclose()), 2.0);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(
        `VideoStream.aclose failed for ${participantId} (${videoSource}): ${errorMessage(e)}`,
      );
    }
    if (task && !task.done()) task.cancel();
  }

  /**
   * Close every per-participant audio/video stream and cancel its task.
   *
   * Idempotent: no-op when no streams are registered.
   */
  async _closeAllStreams(): Promise<void> {
    for (const participantId of [...this._audioStreams.keys()]) {
      await this._closeAudioStream(participantId);
    }
    for (const key of [...this._videoStreams.keys()]) {
      const [participantId, videoSource] = LiveKitTransportClient.splitVideoKey(key);
      await this._closeVideoStream(participantId, videoSource);
    }
  }

  /** Handle data received events. */
  async _asyncOnDataReceived(data: DataPacket): Promise<void> {
    // LiveKit delivers packets sent by a server SDK with no participant.
    const sender = data.participant ? data.participant.identity : null;
    await this._callbacks.onDataReceived(data.data, sender);
  }

  /** Handle connected events. */
  async _asyncOnConnected(): Promise<void> {
    await this._callbacks.onConnected();
  }

  /**
   * Handle disconnected events.
   *
   * Only a disconnect of a connected client is reported. `disconnect()` and a
   * failed `connect()` clear the connected flag before disconnecting the room,
   * so the room's event for those is ignored.
   */
  async _asyncOnDisconnected(reason: unknown = null): Promise<void> {
    if (!this._connected) return;
    this._connected = false;
    logger.info(`Disconnected from ${this._roomName}. Reason: ${reason}`);
    await this._callbacks.onDisconnected();
  }

  /** Handle inbound SIP DTMF events from LiveKit telephony. */
  async _asyncOnSipDtmfReceived(dtmf: SipDTMF): Promise<void> {
    const participant = dtmf.participant ?? null;
    const participantId = participant ? (participant.identity ?? null) : null;
    const data = {
      tone: dtmf.digit,
      digit: dtmf.digit,
      code: dtmf.code,
      participant_id: participantId,
    };
    logger.debug(`${this} SIP DTMF event: ${pyJsonDumps(data)}`);
    await this._callbacks.onDtmfEvent(data);
  }

  /** Handle a change of the room's loudest speaker. */
  async _asyncOnActiveSpeakerChanged(speakerId: string): Promise<void> {
    await this._callbacks.onActiveSpeakerChanged(speakerId);
  }

  /** Process incoming audio stream from a participant. */
  async _processAudioStream(
    audioStream: AsyncIterable<RtcAudioFrame>,
    participantId: string,
  ): Promise<void> {
    logger.info(`Started processing audio stream for participant ${participantId}`);
    for await (const frame of audioStream) {
      await this._audioQueue.put([{ frame }, participantId]);
    }
  }

  /** Get the next audio frame from the queue. */
  async *getNextAudioFrame(): AsyncGenerator<[AudioFrameEvent, string] | null> {
    while (true) {
      const item = await this._audioQueue.get();
      yield item;
    }
  }

  /**
   * Whether a participant is sending a video source.
   *
   * A participant who turns their camera off usually mutes the track rather
   * than unpublishing it, so a subscribed track can still send nothing.
   *
   * @param participantId The participant's identity.
   * @param videoSource The video source, `"camera"` or `"screenVideo"`.
   * @returns Whether the source's track is subscribed and not muted.
   */
  videoSourceEnabled(participantId: string, videoSource: string): boolean {
    const publication = this._videoPublications.get(
      LiveKitTransportClient.videoKey(participantId, videoSource),
    );
    return publication !== undefined && !publication.muted;
  }

  /** Process incoming video stream from a participant. */
  async _processVideoStream(
    videoStream: AsyncIterable<RtcVideoFrameEvent>,
    participantId: string,
    videoSource: string,
  ): Promise<void> {
    logger.info(`Started processing ${videoSource} video stream for participant ${participantId}`);
    for await (const event of videoStream) {
      await this._videoQueue.put([event, participantId, videoSource]);
    }
  }

  /** Get the next video frame from the queue. */
  async *getNextVideoFrame(): AsyncGenerator<[RtcVideoFrameEvent, string, string] | null> {
    while (true) {
      const item = await this._videoQueue.get();
      yield item;
    }
  }

  toString(): string {
    return `${this._transportName}::LiveKitTransportClient`;
  }
}

/** Concatenate two byte arrays. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export interface ParticipantAudioMixerOptions {
  /** Sample rate of the participants' audio. */
  sampleRate: number;
  /** Number of channels of the participants' audio. */
  numChannels: number;
  /** Duration of each mixed chunk, in milliseconds. */
  chunkMs?: number;
  /**
   * How much audio another participant buffers before the mix stops waiting
   * for a participant with no audio buffered.
   */
  maxWaitMs?: number;
}

/**
 * Mixes participants' audio, as it arrives, into a single stream.
 *
 * Each participant's audio is buffered and mixed in fixed-size chunks once
 * every participant has a chunk buffered, so the output keeps the pace of the
 * participants' streams. A participant who stops sending audio holds the mix
 * back until another participant has `maxWaitMs` buffered; then they are left
 * out of the mix until their audio arrives again.
 */
export class _ParticipantAudioMixer {
  protected _chunkBytes: number;
  protected _maxWaitBytes: number;
  protected _buffers = new Map<string, Uint8Array>();

  constructor(options: ParticipantAudioMixerOptions) {
    const bytesPerMs = Math.floor((options.sampleRate * options.numChannels * 2) / 1000);
    this._chunkBytes = (options.chunkMs ?? 10) * bytesPerMs;
    this._maxWaitBytes = (options.maxWaitMs ?? 50) * bytesPerMs;
  }

  /**
   * Add a participant's audio and return the chunks it completes.
   *
   * @param participantId The participant the audio belongs to.
   * @param audio 16-bit PCM audio.
   * @returns The mixed chunks that are ready, oldest first.
   */
  add(participantId: string, audio: Uint8Array): Uint8Array[] {
    this._buffers.set(
      participantId,
      concat(this._buffers.get(participantId) ?? new Uint8Array(0), audio),
    );
    const chunks: Uint8Array[] = [];
    while (true) {
      const buffers = [...this._buffers.values()];
      if (buffers.some((buffer) => buffer.length < this._chunkBytes)) {
        if (buffers.every((buffer) => buffer.length < this._maxWaitBytes)) break;
        for (const [id, buffer] of [...this._buffers]) {
          if (buffer.length === 0) this._buffers.delete(id);
        }
      }
      chunks.push(this._mixChunk());
    }
    return chunks;
  }

  protected _mixChunk(): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const [id, buffer] of this._buffers) {
      parts.push(buffer.slice(0, this._chunkBytes));
      this._buffers.set(id, buffer.subarray(this._chunkBytes));
    }
    return parts.reduce((a, b) => mixAudio(a, b));
  }
}

/** The bytes of an `Int16Array` (no copy). */
function int16Bytes(data: Int16Array): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Handles incoming media streams and events from LiveKit rooms.
 *
 * Processes incoming audio streams from room participants and forwards them
 * as Pipecat frames, including audio resampling and VAD integration.
 */
export class LiveKitInputTransport extends BaseInputTransport {
  _transport: BaseTransport;
  _client: LiveKitTransportClient;
  declare _params: LiveKitParams;
  _audioInTask: Task<unknown> | null = null;
  _videoInTask: Task<unknown> | null = null;
  // One resampler per participant: a stream resampler keeps state between
  // calls, so sharing one would mix the audio of participants who talk at once.
  _resamplers = new Map<string, BaseAudioResampler>();
  _videoSamplers = new _VideoInSamplers();
  _audioInUserTracks: boolean;
  _mixer: _ParticipantAudioMixer | null = null;
  _mixedResampler = createStreamResampler();

  /**
   * Initialize the LiveKit input transport.
   *
   * @param transport The parent transport instance.
   * @param client LiveKitTransportClient instance.
   * @param params Configuration parameters.
   * @param options Additional options passed to the parent class.
   */
  constructor(
    transport: BaseTransport,
    client: LiveKitTransportClient,
    params: LiveKitParams,
    options: FrameProcessorOptions = {},
  ) {
    super(params, options);
    this._transport = transport;
    this._client = client;
    this._params = params;
    this._audioInUserTracks = params.audioInUserTracks;
  }

  /** Whether this transport captures a video source listed in `videoInSources`. */
  protected override _supportsVideoInSource(videoSource: string): boolean {
    return videoSource === CAM_VIDEO_SOURCE || videoSource === SCREEN_VIDEO_SOURCE;
  }

  /** Setup the input transport with shared client setup. */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);

    await this._client.setup(setup);

    await this._client.connect();

    logger.info("LiveKitInputTransport connected");
  }

  /** Release input transport resources at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._teardown();
    await this._transport.cleanup();
  }

  /** Start receiving media from the LiveKit room. */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);

    if (!this._audioInTask && this._params.audioInEnabled) {
      this._audioInTask = this.createTask(
        () => this._audioInTaskHandler(),
        "_audio_in_task_handler",
      );
    }
    if (!this._videoInTask && this._params.videoInEnabled) {
      this._videoInTask = this.createTask(
        () => this._videoInTaskHandler(),
        "_video_in_task_handler",
      );
    }

    await this.setTransportReady(frame);
  }

  /** Stop the input transport and disconnect from LiveKit room. */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._teardown();
    logger.info("LiveKitInputTransport stopped");
  }

  /** Cancel the input transport and disconnect from LiveKit room. */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._teardown();
  }

  /**
   * Disconnect the client and cancel the media input tasks.
   *
   * Single idempotent teardown body shared by `stop`, `cancel` and `cleanup`.
   */
  protected async _teardown(): Promise<void> {
    await this._client.disconnect();
    if (this._audioInTask) {
      await this.cancelTask(this._audioInTask);
      this._audioInTask = null;
    }
    if (this._videoInTask) {
      await this.cancelTask(this._videoInTask);
      this._videoInTask = null;
    }
    this._videoSamplers.clear();
  }

  /**
   * Push an application message as an urgent transport frame.
   *
   * Broadcast both upstream and downstream so it reaches `RTVIProcessor`
   * regardless of where it sits relative to the transport in the pipeline.
   *
   * @param message The message data to send.
   * @param sender ID of the message sender, or null if it was sent
   *   unattributed by a server SDK.
   */
  async pushAppMessage(message: unknown, sender: string | null): Promise<void> {
    await this.broadcastFrame(LiveKitInputTransportMessageFrame, {
      message,
      participantId: sender,
    });
  }

  /** Drop a participant's resampler once their audio track is gone. */
  releaseParticipant(participantId: string): void {
    this._resamplers.delete(participantId);
  }

  /** Process incoming frames, answering user image requests. */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof UserImageRequestFrame) {
      await this.requestParticipantImage(frame);
    }
  }

  /**
   * Capture a participant's video source at a framerate.
   *
   * This takes precedence over `videoInSources` for the source.
   *
   * @param participantId The participant's identity.
   * @param framerate Frames per second to pass on, or `null` for every frame.
   *   It doesn't apply with `onRequestOnly`.
   * @param videoSource The video source, `"camera"` or `"screenVideo"`.
   * @param options.onRequestOnly Pass on only the frames that answer image requests.
   */
  async captureParticipantVideo(
    participantId: string,
    framerate: number | null = 30,
    videoSource: string = CAM_VIDEO_SOURCE,
    options: { onRequestOnly?: boolean } = {},
  ): Promise<void> {
    const rate = _captureFramerate(
      framerate,
      options.onRequestOnly ?? false,
      "LiveKitTransport.capture_participant_video",
    );
    this._videoSamplers.capture(participantId, videoSource, rate);
  }

  /**
   * Request a video frame from a specific participant.
   *
   * @param frame The user image request frame.
   */
  async requestParticipantImage(frame: UserImageRequestFrame): Promise<void> {
    const videoSource = frame.videoSource || CAM_VIDEO_SOURCE;
    const userId = frame.userId ?? "";
    if (!this._client.videoSourceEnabled(userId, videoSource)) {
      const error = `${frame.userId} isn't sending ${videoSource} video.`;
      await this._answerImageRequests([frame], error);
      return;
    }

    this._captureConfiguredVideo(userId, videoSource);
    if (!this._videoSamplers.addRequest(userId, videoSource, frame)) {
      const error = `No ${videoSource} video is being captured from ${frame.userId}.`;
      await this._answerImageRequests([frame], error);
    }
  }

  /**
   * Answer the image requests waiting on a video source that stopped.
   *
   * The source stays captured, so its frames are sampled again if it restarts.
   *
   * @param participantId The participant's identity.
   * @param videoSource The video source that stopped.
   */
  async stopParticipantVideo(participantId: string, videoSource: string): Promise<void> {
    const requests = this._videoSamplers.takeRequests(participantId, videoSource);
    const error = `${participantId} stopped sending ${videoSource} video.`;
    await this._answerImageRequests(requests, error);
  }

  /**
   * Stop sampling video from a participant who left.
   *
   * @param participantId The participant's identity.
   */
  async removeParticipantVideo(participantId: string): Promise<void> {
    const requests = this._videoSamplers.removeParticipant(participantId);
    await this._answerImageRequests(requests, `${participantId} left.`);
  }

  /** Stop sampling video from every participant, e.g. after leaving the room. */
  async removeAllVideo(): Promise<void> {
    const requests = this._videoSamplers.clear();
    await this._answerImageRequests(requests, "The bot left the room.");
  }

  /**
   * Capture a source as `videoInSources` configures it, unless it already is.
   *
   * Without `videoInSources`, every source is captured at every frame. With
   * it, only the listed sources are, each at its own framerate.
   */
  _captureConfiguredVideo(participantId: string, videoSource: string): void {
    if (this._videoSamplers.isCapturing(participantId, videoSource)) return;
    const sources = this._params.videoInSources;
    if (Object.keys(sources).length === 0) {
      this._videoSamplers.capture(participantId, videoSource, null);
    } else {
      const sourceParams = sources[videoSource];
      if (sourceParams) {
        const framerate = sourceParams.onRequestOnly ? 0 : sourceParams.framerate;
        this._videoSamplers.capture(participantId, videoSource, framerate);
      }
    }
  }

  /** Handle incoming audio frames from participants. */
  async _audioInTaskHandler(): Promise<void> {
    logger.info("Audio input task started");
    const audioIterator = this._client.getNextAudioFrame();
    for await (const audioData of audioIterator) {
      if (!audioData) continue;
      const [audioFrameEvent, participantId] = audioData;

      if (!this._audioInUserTracks) {
        await this._pushMixedAudio(audioFrameEvent.frame, participantId);
        continue;
      }

      const pipecatAudioFrame = await this._convertLivekitAudioToPipecat(
        audioFrameEvent,
        participantId,
      );

      // Skip frames with no audio data
      if (pipecatAudioFrame.audio.length === 0) continue;

      const inputAudioFrame = new UserAudioRawFrame({
        userId: participantId,
        audio: pipecatAudioFrame.audio,
        sampleRate: pipecatAudioFrame.sampleRate,
        numChannels: pipecatAudioFrame.numChannels,
      });
      await this.pushAudioFrame(inputAudioFrame);
    }
  }

  /** Mix a participant's audio into the room's stream and push what is ready. */
  async _pushMixedAudio(audioFrame: RtcAudioFrame, participantId: string): Promise<void> {
    if (!this._mixer) {
      this._mixer = new _ParticipantAudioMixer({
        sampleRate: audioFrame.sampleRate,
        numChannels: audioFrame.channels,
      });
    }
    for (const chunk of this._mixer.add(participantId, int16Bytes(audioFrame.data))) {
      const audio = await this._mixedResampler.resample(
        chunk,
        audioFrame.sampleRate,
        this.sampleRate,
      );
      if (audio.length === 0) continue;
      await this.pushAudioFrame(
        new InputAudioRawFrame({
          audio,
          sampleRate: this.sampleRate,
          numChannels: audioFrame.channels,
        }),
      );
    }
  }

  /** Handle incoming video frames from participants. */
  async _videoInTaskHandler(): Promise<void> {
    logger.info("Video input task started");
    const videoIterator = this._client.getNextVideoFrame();
    for await (const videoData of videoIterator) {
      if (!videoData) continue;
      const [videoFrameEvent, participantId, videoSource] = videoData;
      this._captureConfiguredVideo(participantId, videoSource);
      const [due, request] = this._videoSamplers.sample(participantId, videoSource);
      if (!due) continue;

      const pipecatVideoFrame = await this._convertLivekitVideoToPipecat(videoFrameEvent);

      // Skip frames with no video data
      if (pipecatVideoFrame.image.length === 0) continue;

      const inputVideoFrame = new UserImageRawFrame({
        userId: participantId,
        image: pipecatVideoFrame.image,
        size: pipecatVideoFrame.size,
        format: pipecatVideoFrame.format,
        text: request ? request.text : null,
        appendToContext: request ? request.appendToContext : null,
        request,
      });
      inputVideoFrame.transportSource = videoSource;
      await this.pushVideoFrame(inputVideoFrame);
    }
  }

  /** Convert a participant's LiveKit audio frame to a Pipecat audio frame. */
  async _convertLivekitAudioToPipecat(
    audioFrameEvent: AudioFrameEvent,
    participantId: string,
  ): Promise<{ audio: Uint8Array; sampleRate: number; numChannels: number }> {
    const audioFrame = audioFrameEvent.frame;

    let resampler = this._resamplers.get(participantId);
    if (!resampler) {
      resampler = createStreamResampler();
      this._resamplers.set(participantId, resampler);
    }
    const audioData = await resampler.resample(
      int16Bytes(audioFrame.data),
      audioFrame.sampleRate,
      this.sampleRate,
    );

    // DIVERGENCE: a plain object; `AudioRawFrame` is a mixin in pipedog.
    return { audio: audioData, sampleRate: this.sampleRate, numChannels: audioFrame.channels };
  }

  /** Convert LiveKit video frame to Pipecat video frame. */
  async _convertLivekitVideoToPipecat(
    videoFrameEvent: RtcVideoFrameEvent,
  ): Promise<{ image: Uint8Array; size: [number, number]; format: string }> {
    const rgbFrame = videoFrameEvent.frame.convert(rtc.VideoBufferType.RGB24);
    // DIVERGENCE: a plain object; `ImageRawFrame` is a mixin in pipedog.
    return { image: rgbFrame.data.slice(), size: [rgbFrame.width, rgbFrame.height], format: "RGB" };
  }
}

/**
 * Handles outgoing media streams and events to LiveKit rooms.
 *
 * Manages sending audio and video frames and data messages to LiveKit room
 * participants, including audio/video format conversion for LiveKit
 * compatibility. Video output publishes to a single default camera track when
 * `LiveKitParams.videoOutEnabled` is set.
 */
export class LiveKitOutputTransport extends BaseOutputTransport {
  _transport: BaseTransport;
  _client: LiveKitTransportClient;
  declare _params: LiveKitParams;
  // Formats already reported as unsupported, so the error is logged once per
  // format instead of once per frame.
  _unsupportedVideoFormats = new Set<string | null>();

  /**
   * Initialize the LiveKit output transport.
   *
   * @param transport The parent transport instance.
   * @param client LiveKitTransportClient instance.
   * @param params Configuration parameters.
   * @param options Additional options passed to the parent class.
   */
  constructor(
    transport: BaseTransport,
    client: LiveKitTransportClient,
    params: LiveKitParams,
    options: FrameProcessorOptions = {},
  ) {
    super(params, options);
    this._transport = transport;
    this._client = client;
    this._params = params;
  }

  /** Setup the output transport with shared client setup. */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);

    await this._client.setup(setup);

    await this._client.connect();

    logger.info("LiveKitOutputTransport connected");
  }

  /** Release output transport resources at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._client.disconnect();
    await this._transport.cleanup();
  }

  /** Start the output transport. */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);

    await this.setTransportReady(frame);
  }

  /** Stop the output transport and disconnect from LiveKit room. */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._client.disconnect();
    logger.info("LiveKitOutputTransport stopped");
  }

  /** Cancel the output transport and disconnect from LiveKit room. */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._client.disconnect();
  }

  /**
   * Process frames, clearing the LiveKit AudioSource buffer on interruption.
   *
   * When an InterruptionFrame arrives, any audio already submitted to the
   * LiveKit AudioSource (but not yet played out) is cleared immediately so the
   * bot stops speaking without delay.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof InterruptionFrame && this._client._audioSource !== null) {
      this._client._audioSource.clearQueue();
    }
  }

  /**
   * Send a transport message to participants.
   *
   * @param frame The transport message frame to send.
   */
  override async sendMessage(
    frame: OutputTransportMessageFrame | OutputTransportMessageUrgentFrame,
  ): Promise<void> {
    let message = frame.message;
    if (message !== null && typeof message === "object" && !Array.isArray(message)) {
      // fix message encoding for dict-like messages, e.g. RTVI messages.
      message = pyJsonDumps(message, { ensureAscii: false });
    }
    const data = new TextEncoder().encode(String(message));
    if (
      frame instanceof LiveKitOutputTransportMessageFrame ||
      frame instanceof LiveKitOutputTransportMessageUrgentFrame
    ) {
      await this._client.sendData(data, frame.participantId);
    } else {
      await this._client.sendData(data);
    }
  }

  /**
   * Write an audio frame to the LiveKit room.
   *
   * @param frame The audio frame to write.
   * @returns True if the audio frame was written successfully, False otherwise.
   */
  override async writeAudioFrame(frame: OutputAudioRawFrame): Promise<boolean> {
    const livekitAudio = this._convertPipecatAudioToLivekit(frame.audio);
    return await this._client.publishAudio(livekitAudio);
  }

  /**
   * Write a video frame to the LiveKit room's published camera track.
   *
   * Publishes to the single default video track set up in
   * `LiveKitTransportClient.connect` (mirroring how audio always publishes to
   * one microphone track). Per-destination routing to multiple named video
   * tracks is not supported yet, so `frame.transportDestination` is ignored.
   *
   * @param frame The video frame to write.
   * @returns True if the video frame was written successfully, False otherwise.
   */
  override async writeVideoFrame(frame: OutputImageRawFrame): Promise<boolean> {
    const livekitVideo = this._convertPipecatVideoToLivekit(frame);
    if (livekitVideo === null) return false;
    return await this._client.publishVideo(livekitVideo);
  }

  /** LiveKit supports native DTMF via telephone events. */
  protected override _supportsNativeDtmf(): boolean {
    return true;
  }

  /**
   * Use LiveKit's native publishDtmf method for telephone events.
   *
   * LiveKit's DTMF API sends a single tone per call, so when `frame.buttons`
   * contains multiple entries only the first one is sent.
   */
  protected override async _writeDtmfNative(
    frame: OutputDTMFFrame | OutputDTMFUrgentFrame,
  ): Promise<void> {
    if (!frame.buttons || frame.buttons.length === 0) return;
    await this._client.sendDtmf(frame.buttons[0]!);
  }

  /** Convert Pipecat audio data to LiveKit audio frame. */
  _convertPipecatAudioToLivekit(pipecatAudio: Uint8Array): RtcAudioFrame {
    const bytesPerSample = 2; // Assuming 16-bit audio
    const totalSamples = Math.floor(pipecatAudio.length / bytesPerSample);
    const samplesPerChannel = Math.floor(totalSamples / this._params.audioOutChannels);

    // Int16Array needs an even byte offset.
    const bytes = pipecatAudio.byteOffset % 2 === 0 ? pipecatAudio : pipecatAudio.slice();
    const data = new Int16Array(bytes.buffer, bytes.byteOffset, totalSamples);
    return new rtc.AudioFrame(
      data,
      this.sampleRate,
      this._params.audioOutChannels,
      samplesPerChannel,
    );
  }

  /**
   * Convert a Pipecat output video frame to a LiveKit video frame.
   *
   * @returns The converted `rtc.VideoFrame`, or null if `frame.format` has no
   *   known LiveKit `VideoBufferType` mapping or the image length does not
   *   match its size.
   */
  _convertPipecatVideoToLivekit(frame: OutputImageRawFrame): RtcVideoFrame | null {
    const bufferInfo = frame.format ? LIVEKIT_VIDEO_BUFFER_TYPES[frame.format] : undefined;
    if (bufferInfo === undefined) {
      if (!this._unsupportedVideoFormats.has(frame.format)) {
        this._unsupportedVideoFormats.add(frame.format);
        logger.error(
          `${this} unsupported video color format for LiveKit output: '${frame.format}'`,
        );
      }
      return null;
    }

    const [bufferTypeName, bytesPerPixel] = bufferInfo;
    const [width, height] = frame.size;
    // LiveKit reads `width * height * bytesPerPixel` bytes from the buffer
    // without checking its length, so a short buffer crashes the process.
    const expectedLength = width * height * bytesPerPixel;
    if (frame.image.length !== expectedLength) {
      logger.error(
        `${this} video frame of size ${width}x${height} and format '${frame.format}' ` +
          `has ${frame.image.length} bytes, expected ${expectedLength}`,
      );
      return null;
    }

    return new rtc.VideoFrame(frame.image, width, height, rtc.VideoBufferType[bufferTypeName]);
  }
}

export interface LiveKitTransportOptions {
  /** LiveKit server URL to connect to. */
  url: string;
  /** Authentication token for the room. */
  token: string;
  /** Name of the LiveKit room to join. */
  roomName: string;
  /** Configuration parameters for the transport. */
  params?: LiveKitParams | null;
  /** Optional name for the input transport. */
  inputName?: string | null;
  /** Optional name for the output transport. */
  outputName?: string | null;
}

/**
 * Transport implementation for LiveKit real-time communication.
 *
 * Provides comprehensive LiveKit integration including audio streaming, data
 * messaging, participant management, and room event handling for
 * conversational AI applications.
 *
 * Every `participantId` surfaced by this transport (event args, frame fields,
 * `getParticipants()`, and the `getParticipantMetadata`/`muteParticipant`/
 * `unmuteParticipant` methods) is the participant's LiveKit *identity*
 * (`Participant.identity`) — the value set when minting its access token, and
 * what LiveKit itself keys `room.remoteParticipants` by and expects in
 * `destination_identities`. It is not the participant's *SID*
 * (`Participant.sid`), a per-connection session id that changes on every
 * reconnect.
 *
 * Event handlers available:
 *
 * - on_connected: Called when the bot connects to the room.
 * - on_disconnected: Called when the bot disconnects from the room.
 * - on_before_disconnect: [sync] Called just before the bot disconnects.
 * - on_call_state_updated: Called when the call state changes. Args: (state: string)
 * - on_first_participant_joined: Called when the first participant joins. Args: (participantId)
 * - on_participant_connected: Called when a participant connects. Args: (participantId)
 * - on_participant_disconnected: Called when a participant disconnects. Args: (participantId)
 * - on_participant_left: Called when a participant leaves. Args: (participantId, reason)
 * - on_client_connected: Called when a participant connects (alias for
 *   on_participant_connected). Args: (participant: { id })
 * - on_client_disconnected: Called when a participant disconnects (alias for
 *   on_participant_disconnected). Args: (participant: { id })
 * - on_audio_track_subscribed: Called when an audio track is subscribed. Args: (participantId)
 * - on_audio_track_unsubscribed: Called when an audio track is unsubscribed. Args: (participantId)
 * - on_video_track_subscribed: Called when a video track is subscribed. Args: (participantId)
 * - on_video_track_unsubscribed: Called when a video track is unsubscribed. Args: (participantId)
 * - on_app_message: Called when data is received from a participant.
 *   RTVI-compatible version of on_data_received. Args: (message, sender)
 * - on_data_received: Called when data is received. The participant ID is null
 *   for packets sent by a server SDK, which LiveKit delivers unattributed.
 *   Args: (data: Uint8Array, participantId: string | null)
 * - on_dtmf_event: Called when a SIP DTMF tone is received from a participant.
 *   Args: (data) with keys `tone`/`digit`, `code`, and `participant_id`. Also
 *   pushes an `InputDTMFFrame` so `DTMFAggregator` works on LiveKit SIP calls.
 * - on_active_speaker_changed: Called when the room's loudest speaker changes,
 *   as on Daily. The bot can be the speaker while it talks.
 *   Args: (participant: { id }), the speaker's identity.
 *
 * @example
 * transport.eventHandler("on_first_participant_joined", async (transport, participantId) => {
 *   await worker.queueFrame(new TTSSpeakFrame({ text: "Hello!" }));
 * });
 */
export class LiveKitTransport extends BaseTransport {
  _params: LiveKitParams;
  _client: LiveKitTransportClient;
  _input: LiveKitInputTransport | null = null;
  _output: LiveKitOutputTransport | null = null;

  /**
   * Initialize the LiveKit transport.
   *
   * @param options.url LiveKit server URL to connect to.
   * @param options.token Authentication token for the room.
   * @param options.roomName Name of the LiveKit room to join.
   * @param options.params Configuration parameters for the transport.
   * @param options.inputName Optional name for the input transport.
   * @param options.outputName Optional name for the output transport.
   */
  constructor(options: LiveKitTransportOptions) {
    super({ inputName: options.inputName ?? null, outputName: options.outputName ?? null });

    const callbacks = new LiveKitCallbacks({
      onConnected: () => this._onConnected(),
      onDisconnected: () => this._onDisconnected(),
      onBeforeDisconnect: () => this._onBeforeDisconnect(),
      onParticipantConnected: (id) => this._onParticipantConnected(id),
      onParticipantDisconnected: (id) => this._onParticipantDisconnected(id),
      onAudioTrackSubscribed: (id) => this._onAudioTrackSubscribed(id),
      onAudioTrackUnsubscribed: (id) => this._onAudioTrackUnsubscribed(id),
      onVideoTrackSubscribed: (id) => this._onVideoTrackSubscribed(id),
      onVideoTrackUnsubscribed: (id, source) => this._onVideoTrackUnsubscribed(id, source),
      onVideoTrackMuted: (id, source) => this._onVideoTrackMuted(id, source),
      onDataReceived: (data, id) => this._onDataReceived(data, id),
      onFirstParticipantJoined: (id) => this._onFirstParticipantJoined(id),
      onDtmfEvent: (data) => this._onDtmfEvent(data),
      onActiveSpeakerChanged: (id) => this._onActiveSpeakerChanged(id),
    });
    this._params = options.params ?? new LiveKitParams();

    this._client = new LiveKitTransportClient({
      url: options.url,
      token: options.token,
      roomName: options.roomName,
      params: this._params,
      callbacks,
      transportName: this.name,
    });

    this._registerEventHandler("on_connected");
    this._registerEventHandler("on_disconnected");
    this._registerEventHandler("on_participant_connected");
    this._registerEventHandler("on_participant_disconnected");
    this._registerEventHandler("on_client_connected");
    this._registerEventHandler("on_client_disconnected");
    this._registerEventHandler("on_audio_track_subscribed");
    this._registerEventHandler("on_audio_track_unsubscribed");
    this._registerEventHandler("on_video_track_subscribed");
    this._registerEventHandler("on_video_track_unsubscribed");
    this._registerEventHandler("on_app_message");
    this._registerEventHandler("on_data_received");
    this._registerEventHandler("on_first_participant_joined");
    this._registerEventHandler("on_participant_left");
    this._registerEventHandler("on_call_state_updated");
    this._registerEventHandler("on_before_disconnect", true);
    this._registerEventHandler("on_dtmf_event");
    this._registerEventHandler("on_active_speaker_changed");
  }

  /**
   * The id of a client, as passed to `on_client_connected`.
   *
   * @returns The participant's identity.
   */
  override getClientId(client: unknown): string {
    return (client as { id: string }).id;
  }

  /** Get the input transport for receiving media and events. */
  input(): LiveKitInputTransport {
    if (!this._input) {
      this._input = new LiveKitInputTransport(this, this._client, this._params, {
        name: this._inputName,
      });
    }
    return this._input;
  }

  /** Get the output transport for sending media and events. */
  output(): LiveKitOutputTransport {
    if (!this._output) {
      this._output = new LiveKitOutputTransport(this, this._client, this._params, {
        name: this._outputName,
      });
    }
    return this._output;
  }

  /** The participant ID assigned by LiveKit. */
  get participantId(): string {
    return this._client.participantId;
  }

  /**
   * Send an audio frame to the LiveKit room.
   *
   * @param frame The audio frame to send.
   */
  async sendAudio(frame: OutputAudioRawFrame): Promise<void> {
    if (this._output) await this._output.queueFrame(frame, FrameDirection.DOWNSTREAM);
  }

  /**
   * Get list of participant IDs in the room.
   *
   * @returns List of participant LiveKit identities.
   */
  getParticipants(): string[] {
    return this._client.getParticipants();
  }

  /**
   * Get metadata for a specific participant.
   *
   * @param participantId LiveKit identity of the participant to get metadata for.
   * @returns Object containing participant metadata.
   */
  async getParticipantMetadata(participantId: string): Promise<Record<string, unknown>> {
    return await this._client.getParticipantMetadata(participantId);
  }

  /**
   * Set metadata for the local participant.
   *
   * @param metadata Metadata string to set.
   */
  async setMetadata(metadata: string): Promise<void> {
    await this._client.setParticipantMetadata(metadata);
  }

  /**
   * Capture a participant's video source at a framerate.
   *
   * This takes precedence over `videoInSources` for the source.
   *
   * @param participantId The participant's identity.
   * @param framerate Frames per second to pass on, or `null` for every frame.
   *   It doesn't apply with `onRequestOnly`.
   * @param videoSource The video source, `"camera"` or `"screenVideo"`.
   * @param options.onRequestOnly Pass on only the frames that answer image requests.
   */
  override async captureParticipantVideo(
    participantId: string,
    framerate: number | null = 30,
    videoSource: string = CAM_VIDEO_SOURCE,
    options: { onRequestOnly?: boolean } = {},
  ): Promise<void> {
    const rate = _captureFramerate(
      framerate,
      options.onRequestOnly ?? false,
      "LiveKitTransport.capture_participant_video",
    );
    if (this._input) {
      await this._input.captureParticipantVideo(participantId, rate, videoSource, {
        onRequestOnly: rate === 0,
      });
    }
  }

  /**
   * Stop receiving a specific participant's audio.
   *
   * @param participantId LiveKit identity of the participant to stop receiving audio from.
   */
  async muteParticipant(participantId: string): Promise<void> {
    await this._client.muteParticipant(participantId);
  }

  /**
   * Resume receiving a specific participant's audio.
   *
   * @param participantId LiveKit identity of the participant to resume receiving audio from.
   */
  async unmuteParticipant(participantId: string): Promise<void> {
    await this._client.unmuteParticipant(participantId);
  }

  /** Handle room connected events. */
  async _onConnected(): Promise<void> {
    await this._callEventHandler("on_connected");
    if (this._input) await this._input.pushFrame(new BotConnectedFrame());
  }

  /** Handle room disconnected events. */
  async _onDisconnected(): Promise<void> {
    if (this._input) await this._input.removeAllVideo();
    await this._callEventHandler("on_disconnected");
  }

  /** Handle before disconnection room events. */
  async _onBeforeDisconnect(): Promise<void> {
    await this._callEventHandler("on_before_disconnect");
  }

  /** Handle participant connected events. */
  async _onParticipantConnected(participantId: string): Promise<void> {
    await this._callEventHandler("on_participant_connected", participantId);
    // Also call on_client_connected for compatibility with other transports.
    // Wrapped as an object (matching Daily's shape) so drop-in bot templates
    // reading client.id work across transports.
    await this._callEventHandler("on_client_connected", { id: participantId });
    if (this._input) await this._input.pushFrame(new ClientConnectedFrame());
  }

  /** Handle participant disconnected events. */
  async _onParticipantDisconnected(participantId: string): Promise<void> {
    if (this._input) await this._input.removeParticipantVideo(participantId);
    await this._callEventHandler("on_participant_disconnected", participantId);
    await this._callEventHandler("on_participant_left", participantId, "disconnected");
    // Also call on_client_disconnected for compatibility with other transports
    await this._callEventHandler("on_client_disconnected", { id: participantId });
  }

  /** Handle audio track subscribed events. */
  async _onAudioTrackSubscribed(participantId: string): Promise<void> {
    await this._callEventHandler("on_audio_track_subscribed", participantId);
  }

  /** Handle audio track unsubscribed events. */
  async _onAudioTrackUnsubscribed(participantId: string): Promise<void> {
    if (this._input) this._input.releaseParticipant(participantId);
    await this._callEventHandler("on_audio_track_unsubscribed", participantId);
  }

  /** Handle video track subscribed events. */
  async _onVideoTrackSubscribed(participantId: string): Promise<void> {
    await this._callEventHandler("on_video_track_subscribed", participantId);
  }

  /** Handle video track muted events. */
  async _onVideoTrackMuted(participantId: string, videoSource: string): Promise<void> {
    if (this._input) await this._input.stopParticipantVideo(participantId, videoSource);
  }

  /** Handle video track unsubscribed events. */
  async _onVideoTrackUnsubscribed(participantId: string, videoSource: string): Promise<void> {
    if (this._input) await this._input.stopParticipantVideo(participantId, videoSource);
    await this._callEventHandler("on_video_track_unsubscribed", participantId);
  }

  /** Handle data received events. */
  async _onDataReceived(data: Uint8Array, participantId: string | null): Promise<void> {
    let message: unknown;
    try {
      message = pyJsonLoads(new TextDecoder("utf-8", { fatal: true }).decode(data));
      if (message === null || typeof message !== "object" || Array.isArray(message)) {
        logger.debug(`${this} Ignoring non-object JSON data: ${pyJsonDumps(message)}`);
        message = null;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      // UnicodeDecodeError / json.JSONDecodeError
      if (!(e instanceof TypeError || e instanceof SyntaxError)) throw e;
      logger.debug(`${this} Ignoring non-JSON data from ${participantId}: ${errorMessage(e)}`);
      message = null;
    }

    if (message !== null) {
      if (this._input) await this._input.pushAppMessage(message, participantId);
      // RTVI compatibility:
      await this._callEventHandler("on_app_message", message, participantId);
    }
    // Backwards compatibility with older transports that used on_data_received for app messages
    await this._callEventHandler("on_data_received", data, participantId);
  }

  /**
   * Handle a change of the room's loudest speaker.
   *
   * Wrapped as an object, matching Daily's event and LiveKit's on_client_connected.
   */
  async _onActiveSpeakerChanged(participantId: string): Promise<void> {
    await this._callEventHandler("on_active_speaker_changed", { id: participantId });
  }

  /**
   * Handle inbound SIP DTMF events.
   *
   * Mirrors Daily transport behavior: expose `on_dtmf_event` to user code and
   * push `InputDTMFFrame` so `DTMFAggregator` can consume digits.
   */
  async _onDtmfEvent(data: Record<string, unknown>): Promise<void> {
    logger.debug(`${this} DTMF event: ${pyJsonDumps(data)}`);
    await this._callEventHandler("on_dtmf_event", data);

    const tone = data !== null && typeof data === "object" ? data.tone : undefined;
    if (tone === undefined || tone === null || this._input === null) return;

    if (!(Object.values(KeypadEntry) as unknown[]).includes(tone)) {
      logger.warning(`${this} Ignoring unsupported DTMF tone: '${tone}'`);
      return;
    }

    await this._input.pushFrame(new InputDTMFFrame({ button: tone as KeypadEntry }));
  }

  /**
   * Send a message to participants in the room.
   *
   * @param message The message string to send.
   * @param participantId Optional specific participant to send to.
   */
  async sendMessage(message: string, participantId: string | null = null): Promise<void> {
    if (this._output) {
      const frame = new LiveKitOutputTransportMessageFrame({ message, participantId });
      await this._output.sendMessage(frame);
    }
  }

  /**
   * Send an urgent message to participants in the room.
   *
   * @param message The urgent message string to send.
   * @param participantId Optional specific participant to send to.
   */
  async sendMessageUrgent(message: string, participantId: string | null = null): Promise<void> {
    if (this._output) {
      const frame = new LiveKitOutputTransportMessageUrgentFrame({ message, participantId });
      await this._output.sendMessage(frame);
    }
  }

  /** Handle room events. */
  async onRoomEvent(_event: unknown): Promise<void> {
    // Handle room events
  }

  /** Handle participant events. */
  async onParticipantEvent(_event: unknown): Promise<void> {
    // Handle participant events
  }

  /** Handle track events. */
  async onTrackEvent(_event: unknown): Promise<void> {
    // Handle track events
  }

  /** Handle call state update events. */
  async _onCallStateUpdated(state: string): Promise<void> {
    await this._callEventHandler("on_call_state_updated", state);
  }

  /** Handle first participant joined events. */
  async _onFirstParticipantJoined(participantId: string): Promise<void> {
    await this._callEventHandler("on_first_participant_joined", participantId);
  }
}
