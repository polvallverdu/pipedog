// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/heygen/video.py

/**
 * HeyGen implementation for Pipecat.
 *
 * This module provides integration with the HeyGen platform for creating
 * conversational AI applications with avatars. It manages conversation
 * sessions and provides real-time audio/video streaming capabilities through
 * the HeyGen API.
 */

import { Queue, type Task, TimeoutError, waitFor } from "@pipedog/asyncio";
import { createStreamResampler } from "@pipedog/core/audio/utils";
import {
  BotStartedSpeakingFrame,
  type CancelFrame,
  type EndFrame,
  type Frame,
  type OutputAudioRawFrame,
  OutputImageRawFrame,
  OutputTransportReadyFrame,
  SpeechOutputAudioRawFrame,
  type StartFrame,
  TTSAudioRawFrame,
  TTSStartedFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import type { FrameDirection, FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { AIService, type AIServiceOptions } from "@pipedog/core/services/ai_service";
import { ServiceSettings } from "@pipedog/core/services/settings";
import { TransportParams } from "@pipedog/core/transports/base_transport";
import { logger } from "@pipedog/core/utils/logger";
import type { NewSessionRequest } from "./api_interactive_avatar.ts";
import type { LiveAvatarNewSessionRequest } from "./api_liveavatar.ts";
import {
  HEY_GEN_SAMPLE_RATE,
  type HeyGenAudioData,
  HeyGenCallbacks,
  HeyGenClient,
  type HeyGenClientOptions,
  type HeyGenImageData,
  type ServiceType,
} from "./client.ts";

// Using the same values that we do in the BaseOutputTransport
export const AVATAR_VAD_STOP_SECS = 0.35;

/** Settings for the HeyGen video service. */
export class HeyGenVideoSettings extends ServiceSettings {}

export interface HeyGenVideoServiceOptions extends AIServiceOptions {
  /** HeyGen API key for authentication. */
  apiKey: string;
  /**
   * `fetch` used for API requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: replaces upstream's required aiohttp `session`.
   */
  fetch?: typeof fetch | null;
  /** Configuration for the HeyGen session. */
  sessionRequest?: LiveAvatarNewSessionRequest | NewSessionRequest | null;
  /** Service type for the avatar session. */
  serviceType?: ServiceType | null;
  /**
   * Runtime-updatable settings. HeyGen has no model concept, so this is
   * primarily used for the `extra` dict.
   */
  settings?: HeyGenVideoSettings | null;
  /**
   * Extra `HeyGenClient` options (e.g. `websocketOptions`, `api`). pipedog
   * addition.
   */
  clientOptions?: Partial<HeyGenClientOptions> | null;
}

/**
 * A service that integrates HeyGen's interactive avatar capabilities into the
 * pipeline.
 *
 * This service manages the lifecycle of a HeyGen avatar session by handling
 * bidirectional audio/video streaming, avatar animations, and user
 * interactions. It processes various frame types to coordinate the avatar's
 * behavior and maintains synchronization between audio and video streams.
 *
 * The service supports:
 *
 * - Real-time avatar animation based on audio input
 * - Voice activity detection for natural interactions
 * - Interrupt handling for more natural conversations
 * - Audio resampling for optimal quality
 * - Automatic session management
 */
export class HeyGenVideoService extends AIService {
  static Settings = HeyGenVideoSettings;

  protected _apiKey: string;
  protected _fetch: typeof fetch | null;
  protected _client: HeyGenClient | null = null;
  protected _sendTask: Task<unknown> | null = null;
  protected _resampler = createStreamResampler();
  protected _isInterrupting = false;
  protected _sessionRequest: LiveAvatarNewSessionRequest | NewSessionRequest | null;
  protected _serviceType: ServiceType | null;
  protected _otherParticipantHasJoined = false;
  protected _eventId: string | null = null;
  protected _audioChunkSize = 0;
  protected _firstChunkSize = 0;
  protected _chunkSize = 0;
  protected _queue: Queue<Frame> = new Queue();
  protected _clientOptions: Partial<HeyGenClientOptions>;

  /**
   * Initialize the HeyGen video service.
   *
   * @param options.apiKey HeyGen API key for authentication.
   * @param options.fetch `fetch` for API requests (upstream: an aiohttp session).
   * @param options.sessionRequest Configuration for the HeyGen session.
   * @param options.serviceType Service type for the avatar session.
   * @param options.settings Runtime-updatable settings. HeyGen has no model
   *   concept, so this is primarily used for the `extra` dict.
   */
  constructor(options: HeyGenVideoServiceOptions) {
    const defaultSettings = new ServiceSettings({ model: null });
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, settings: defaultSettings });
    this._apiKey = options.apiKey;
    this._fetch = options.fetch ?? null;
    this._sessionRequest = options.sessionRequest ?? null;
    this._serviceType = options.serviceType ?? null;
    this._clientOptions = options.clientOptions ?? {};
  }

  /**
   * Set up the HeyGen video service with necessary configuration.
   *
   * Initializes the HeyGen client, establishes connections, and prepares the
   * service for audio/video processing.
   *
   * @param setup Configuration parameters for the frame processor.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);

    // First chunk: 400ms for faster initial response
    this._firstChunkSize = Math.trunc(HEY_GEN_SAMPLE_RATE * 2 * 0.4); // 19200 bytes
    // Subsequent chunks: 1000ms for efficient streaming
    this._chunkSize = Math.trunc(HEY_GEN_SAMPLE_RATE * 2 * 1.0); // 48000 bytes

    this._client = new HeyGenClient({
      ...this._clientOptions,
      apiKey: this._apiKey,
      fetch: this._fetch,
      params: new TransportParams({
        audioInSampleRate: 48000,
        audioInEnabled: true,
        videoInEnabled: true,
        audioOutEnabled: true,
        audioOutSampleRate: HEY_GEN_SAMPLE_RATE,
      }),
      sessionRequest: this._sessionRequest,
      serviceType: this._serviceType,
      callbacks: new HeyGenCallbacks({
        onConnected: () => this._onConnected(),
        onParticipantConnected: (id) => this._onParticipantConnected(id),
        onParticipantDisconnected: (id) => this._onParticipantDisconnected(id),
      }),
      connectAsUser: true,
    });
    await this._client.setup(setup);
  }

  /** Clean up the service and release resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._teardown();
    if (this._client) {
      await this._client.cleanup();
      this._client = null;
    }
  }

  /** Handle bot connected to LiveKit room. */
  protected async _onConnected(): Promise<void> {
    logger.info("HeyGen bot connected to LiveKit room");
  }

  /** Handle participant connected events. */
  protected async _onParticipantConnected(participantId: string): Promise<void> {
    logger.info(`Participant connected ${participantId}`);
    if (!this._client) {
      return;
    }

    if (!this._otherParticipantHasJoined) {
      this._otherParticipantHasJoined = true;
      await this._client.captureParticipantVideo(participantId, (f) =>
        this._onParticipantVideoFrame(f),
      );
      await this._client.captureParticipantAudio(participantId, (f) =>
        this._onParticipantAudioData(f),
      );
    }
  }

  /** Handle participant disconnected events. */
  protected async _onParticipantDisconnected(participantId: string): Promise<void> {
    logger.info(`Participant disconnected ${participantId}`);
  }

  /** Handle incoming video frames from participants. */
  protected async _onParticipantVideoFrame(videoFrame: HeyGenImageData): Promise<void> {
    const frame = new OutputImageRawFrame({
      image: videoFrame.image,
      size: videoFrame.size,
      format: videoFrame.format,
    });
    await this.pushFrame(frame);
  }

  /** Handle incoming audio data from participants. */
  protected async _onParticipantAudioData(audioFrame: HeyGenAudioData): Promise<void> {
    const frame = new SpeechOutputAudioRawFrame({
      audio: audioFrame.audio,
      sampleRate: audioFrame.sampleRate,
      numChannels: audioFrame.numChannels,
    });
    await this.pushFrame(frame);
  }

  /**
   * Start the HeyGen video service and initialize the avatar session.
   *
   * @param frame The start frame containing initialization parameters.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    if (!this._client) {
      return;
    }

    await this._createSendTask();
  }

  /**
   * Stop the HeyGen video service gracefully.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._teardown();
  }

  /**
   * Cancel the HeyGen video service.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._teardown();
  }

  /**
   * Process incoming frames and coordinate avatar behavior.
   *
   * - UserStartedSpeakingFrame: Activates avatar's listening animation
   * - UserStoppedSpeakingFrame: Deactivates avatar's listening state
   * - TTSAudioRawFrame: Processes audio for avatar speech
   * - Other frames: Forwards them through the pipeline
   *
   * @param frame The frame to be processed.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof UserStartedSpeakingFrame) {
      await this._handleUserStartedSpeaking();
      await this.pushFrame(frame, direction);
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      if (this._client) {
        await this._client.stopAgentListening();
      }
      await this.pushFrame(frame, direction);
    } else if (frame instanceof OutputTransportReadyFrame) {
      if (this._client) {
        this._client.transportReady();
      }
      await this.pushFrame(frame, direction);
    } else if (frame instanceof TTSAudioRawFrame) {
      await this._handleAudioFrame(frame);
    } else if (frame instanceof TTSStartedFrame) {
      await this.startTtfbMetrics();
    } else if (frame instanceof BotStartedSpeakingFrame) {
      // We constantly receive audio through WebRTC, but most of the time it is
      // silence. As soon as we receive actual audio, the base output transport
      // will create a BotStartedSpeakingFrame, which we can use as a signal for
      // the TTFB metrics.
      await this.stopTtfbMetrics();
      await this.pushFrame(frame, direction);
    } else {
      await this.pushFrame(frame, direction);
    }
  }

  /**
   * Check if the service can generate metrics.
   *
   * @returns True if metrics generation is supported.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Handle the event when a user starts speaking.
   *
   * Manages the interruption flow by:
   * 1. Setting the interruption flag
   * 2. Signaling the client to interrupt current speech
   * 3. Cancelling ongoing audio sending tasks
   * 4. Creating a new send task
   * 5. Activating the avatar's listening animation
   */
  protected async _handleUserStartedSpeaking(): Promise<void> {
    if (!this._client) {
      return;
    }

    this._isInterrupting = true;
    await this._client.interrupt(this._eventId);
    await this._cancelSendTask();
    this._isInterrupting = false;
    await this._createSendTask();
    await this._client.startAgentListening();
  }

  /**
   * Idempotent teardown shared by stop(), cancel(), and cleanup().
   *
   * Ends the conversation (stopping the client's websocket/LiveKit producer
   * loops) and cancels the send task.
   */
  protected async _teardown(): Promise<void> {
    await this._endConversation();
    await this._cancelSendTask();
  }

  /**
   * End the current conversation and reset state.
   *
   * Stops the HeyGen client and cleans up conversation-specific resources.
   */
  protected async _endConversation(): Promise<void> {
    this._otherParticipantHasJoined = false;
    if (this._client) {
      await this._client.stop();
    }
  }

  /** Create the audio sending task if it doesn't exist. */
  protected async _createSendTask(): Promise<void> {
    if (!this._sendTask) {
      this._queue = new Queue();
      this._sendTask = this.createTask(() => this._sendTaskHandler());
    }
  }

  /** Cancel the audio sending task if it exists. */
  protected async _cancelSendTask(): Promise<void> {
    if (this._sendTask) {
      await this.cancelTask(this._sendTask);
      this._sendTask = null;
    }
  }

  /**
   * Queue an audio frame for processing.
   *
   * @param frame The audio frame to process.
   */
  protected async _handleAudioFrame(frame: OutputAudioRawFrame): Promise<void> {
    await this._queue.put(frame);
  }

  /**
   * Handle sending audio frames to the HeyGen client.
   *
   * Continuously processes audio frames from the queue and sends them to the
   * HeyGen client. Uses 400ms for the first chunk of each utterance for faster
   * initial response, then 1000ms chunks for efficient streaming. Handles
   * timeouts and silence detection for proper audio streaming management.
   */
  protected async _sendTaskHandler(): Promise<void> {
    const client = this._client;
    if (!client) {
      return;
    }

    const sampleRate = client.outSampleRate;
    let audioBuffer: Uint8Array = new Uint8Array(0);
    this._eventId = null;
    let isFirstChunk = true;
    const queue = this._queue;

    for (;;) {
      try {
        const frame = await waitFor(() => queue.get(), AVATAR_VAD_STOP_SECS);
        if (this._isInterrupting) {
          break;
        }
        if (frame instanceof TTSAudioRawFrame) {
          // starting the new inference
          if (this._eventId === null) {
            this._eventId = String(frame.id);
            isFirstChunk = true;
          }

          const audio = await this._resampler.resample(frame.audio, frame.sampleRate, sampleRate);
          audioBuffer = concat(audioBuffer, audio);

          let currentChunkSize = isFirstChunk ? this._firstChunkSize : this._chunkSize;
          while (audioBuffer.length >= currentChunkSize) {
            const chunk = audioBuffer.slice(0, currentChunkSize);
            audioBuffer = audioBuffer.slice(currentChunkSize);
            await client.agentSpeak(chunk, this._eventId);
            if (isFirstChunk) {
              isFirstChunk = false;
              currentChunkSize = this._chunkSize;
            }
          }
        }
        queue.taskDone();
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        // Bot has stopped speaking
        if (this._eventId !== null) {
          // Flush any remaining buffered audio
          if (audioBuffer.length > 0) {
            await client.agentSpeak(audioBuffer, this._eventId);
            audioBuffer = new Uint8Array(0);
          }
          await client.agentSpeakEnd(this._eventId);
          this._eventId = null;
        }
      }
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
