// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/heygen/transport.py

/**
 * HeyGen implementation for Pipecat.
 *
 * This module provides integration with the HeyGen platform for creating
 * conversational AI applications with avatars. It manages conversation
 * sessions and provides real-time audio/video streaming capabilities through
 * the HeyGen API.
 *
 * The module consists of three main components:
 * - HeyGenInputTransport: Handles incoming audio and events from HeyGen conversations
 * - HeyGenOutputTransport: Manages outgoing audio and events to HeyGen conversations
 * - HeyGenTransport: Main transport implementation that coordinates input/output transports
 *
 * Porting notes: the avatar's room is a LiveKit room, joined with
 * `@livekit/rtc-node` (an optional peer dependency with a native addon),
 * loaded when the transport sets up. Importing this module works everywhere;
 * running it needs Bun, Node or Deno on a platform with a prebuilt addon.
 */

import { createStreamResampler } from "@pipedog/core/audio/utils";
import {
  BotConnectedFrame,
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type CancelFrame,
  ClientConnectedFrame,
  type EndFrame,
  type Frame,
  InputAudioRawFrame,
  InterruptionFrame,
  type OutputAudioRawFrame,
  type StartFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { BotCapabilities } from "@pipedog/core/pipeline/capabilities";
import {
  FrameDirection,
  type FrameProcessor,
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
import { logger } from "@pipedog/core/utils/logger";
import type { NewSessionRequest } from "@pipedog/heygen/api_interactive_avatar";
import type { LiveAvatarNewSessionRequest } from "@pipedog/heygen/api_liveavatar";
import {
  HEY_GEN_SAMPLE_RATE,
  type HeyGenAudioData,
  HeyGenCallbacks,
  HeyGenClient,
  type HeyGenClientOptions,
  type ServiceType,
} from "@pipedog/heygen/client";

/**
 * Input transport for receiving audio and events from HeyGen conversations.
 *
 * Handles incoming audio streams from participants and manages audio capture
 * from the room connected to the HeyGen conversation.
 */
export class HeyGenInputTransport extends BaseInputTransport {
  protected _client: HeyGenClient;

  /**
   * Initialize the HeyGen input transport.
   *
   * @param client The HeyGen transport client instance.
   * @param params Transport configuration parameters.
   * @param options Additional options passed to the parent class.
   */
  constructor(client: HeyGenClient, params: TransportParams, options: FrameProcessorOptions = {}) {
    super(params, options);
    this._client = client;
    this._params = params;
  }

  /**
   * Setup the input transport.
   *
   * @param setup The frame processor setup configuration.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._client.setup(setup);
  }

  /** Release input transport resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._client.stop();
  }

  /**
   * Start the input transport.
   *
   * @param frame The start frame containing initialization parameters.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);

    await this.setTransportReady(frame);
  }

  /**
   * Stop the input transport.
   *
   * @param frame The end frame signaling transport shutdown.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._client.stop();
  }

  /**
   * Cancel the input transport.
   *
   * @param frame The cancel frame signaling immediate cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._client.stop();
  }

  /**
   * Start capturing audio from a participant.
   *
   * @param participantId The participant to capture audio from.
   */
  async startCapturingAudio(participantId: string): Promise<void> {
    if (this._params.audioInEnabled) {
      logger.info(`HeyGenTransport start capturing audio for participant ${participantId}`);
      await this._client.captureParticipantAudio(participantId, (f) =>
        this._onParticipantAudioData(f),
      );
    }
  }

  /** Handle received participant audio data. */
  protected async _onParticipantAudioData(audioFrame: HeyGenAudioData): Promise<void> {
    const frame = new InputAudioRawFrame({
      audio: audioFrame.audio,
      sampleRate: audioFrame.sampleRate,
      numChannels: audioFrame.numChannels,
    });
    await this.pushAudioFrame(frame);
  }
}

/**
 * Output transport for sending audio and events to HeyGen conversations.
 *
 * Handles outgoing audio streams to participants and manages the custom
 * audio track expected by the HeyGen platform.
 */
export class HeyGenOutputTransport extends BaseOutputTransport {
  protected _client: HeyGenClient;
  protected _resampler = createStreamResampler();
  protected _eventId: string | null = null;

  /**
   * Initialize the HeyGen output transport.
   *
   * @param client The HeyGen transport client instance.
   * @param params Transport configuration parameters.
   * @param options Additional options passed to the parent class.
   */
  constructor(client: HeyGenClient, params: TransportParams, options: FrameProcessorOptions = {}) {
    super(params, options);
    this._client = client;
    this._params = params;
  }

  /**
   * The media this transport sends to the user.
   *
   * The HeyGen avatar publishes its video to the room itself, so the user
   * receives bot video even though this transport sends none.
   *
   * @returns The `audioOut` capability, with `videoOut` set.
   */
  override get capabilities(): BotCapabilities {
    return super.capabilities.override(new BotCapabilities({ videoOut: true }));
  }

  /**
   * Setup the output transport.
   *
   * @param setup The frame processor setup configuration.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);

    await this._client.setup(setup);
  }

  /** Release output transport resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._client.stop();
  }

  /**
   * Start the output transport.
   *
   * @param frame The start frame containing initialization parameters.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    await this.setTransportReady(frame);
    this._client.transportReady();
  }

  /**
   * Stop the output transport.
   *
   * @param frame The end frame signaling transport shutdown.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._client.stop();
  }

  /**
   * Cancel the output transport.
   *
   * @param frame The cancel frame signaling immediate cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._client.stop();
  }

  /**
   * Push a frame to the next processor in the pipeline.
   *
   * @param frame The frame to push.
   * @param direction The direction to push the frame.
   */
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    // The BotStartedSpeakingFrame and BotStoppedSpeakingFrame are created
    // inside BaseOutputTransport. This is a workaround, so we can more
    // reliably be aware when the bot has started or stopped speaking.
    if (direction === FrameDirection.DOWNSTREAM) {
      if (frame instanceof BotStartedSpeakingFrame) {
        if (this._eventId !== null) {
          logger.warning("self._event_id is already defined!");
        }
        this._eventId = String(frame.id);
      } else if (frame instanceof BotStoppedSpeakingFrame) {
        if (this._eventId !== null) {
          await this._client.agentSpeakEnd(this._eventId);
          this._eventId = null;
        }
      }
    }
    await super.pushFrame(frame, direction);
  }

  /**
   * Process frames and handle interruptions.
   *
   * Special handling is implemented for:
   * - InterruptionFrame: Triggers interruption of current speech
   * - UserStartedSpeakingFrame: Initiates agent listening mode
   * - UserStoppedSpeakingFrame: Stops agent listening mode
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof InterruptionFrame) {
      if (this._eventId !== null) {
        await this._client.interrupt(this._eventId);
      }
      await this.pushFrame(frame, direction);
    }
    if (frame instanceof UserStartedSpeakingFrame) {
      await this._client.startAgentListening();
      await this.pushFrame(frame, direction);
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      await this._client.stopAgentListening();
      await this.pushFrame(frame, direction);
    }
  }

  /**
   * Write an audio frame to the HeyGen transport.
   *
   * Resamples audio to 24kHz if needed before sending.
   *
   * @param frame The audio frame to write.
   */
  override async writeAudioFrame(frame: OutputAudioRawFrame): Promise<boolean> {
    let audio = frame.audio;
    if (frame.sampleRate !== HEY_GEN_SAMPLE_RATE) {
      audio = await this._resampler.resample(audio, frame.sampleRate, HEY_GEN_SAMPLE_RATE);
    }
    if (this._eventId === null) {
      // No active bot-speech event — drop the chunk rather than send a
      // message the HeyGen API will reject.
      logger.warning(`${this}: dropping audio frame because no event_id is set`);
      return false;
    }
    await this._client.agentSpeak(audio, this._eventId);
    return true;
  }
}

export interface HeyGenParamsOptions extends TransportParamsOptions {}

/**
 * Configuration parameters for the HeyGen transport.
 *
 * Audio input and output are enabled by default (`audioInEnabled` and
 * `audioOutEnabled`).
 */
export class HeyGenParams extends TransportParams {
  constructor(options: HeyGenParamsOptions = {}) {
    super({
      ...options,
      audioInEnabled: options.audioInEnabled ?? true,
      audioOutEnabled: options.audioOutEnabled ?? true,
    });
  }
}

export interface HeyGenTransportOptions {
  /**
   * `fetch` used for API requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: replaces upstream's required aiohttp `session`.
   */
  fetch?: typeof fetch | null;
  /** HeyGen API key for authentication. */
  apiKey: string;
  /** HeyGen-specific configuration parameters (default: new HeyGenParams()). */
  params?: HeyGenParams | null;
  /** Optional custom name for the input transport. */
  inputName?: string | null;
  /** Optional custom name for the output transport. */
  outputName?: string | null;
  /** Configuration for the HeyGen session. */
  sessionRequest?: LiveAvatarNewSessionRequest | NewSessionRequest | null;
  /** Service type for the avatar session. */
  serviceType?: ServiceType | null;
  /**
   * Extra `HeyGenClient` options (e.g. `websocketOptions`, `api`). pipedog
   * addition.
   */
  clientOptions?: Partial<HeyGenClientOptions> | null;
}

/**
 * Transport implementation for HeyGen video calls.
 *
 * When used, the Pipecat bot joins the same virtual room as the HeyGen Avatar
 * and the user. This is achieved by using `HeyGenTransport`, which initiates
 * the conversation via `HeyGenApi` and obtains a room URL that all
 * participants connect to.
 *
 * Event handlers available:
 *
 * - on_connected(transport): The bot joined the room
 * - on_client_connected(transport, participant): Participant connected to the session
 * - on_client_disconnected(transport, participant): Participant disconnected from the session
 *
 * @example
 * transport.eventHandler("on_client_connected", async (transport, participant) => {
 *   ...
 * });
 */
export class HeyGenTransport extends BaseTransport {
  protected _params: HeyGenParams;
  protected _client: HeyGenClient;
  protected _input: HeyGenInputTransport | null = null;
  protected _output: HeyGenOutputTransport | null = null;
  protected _HeyGenParticipantId: string | null = null;

  /**
   * Initialize the HeyGen transport.
   *
   * The transport will automatically join the same virtual room as the
   * HeyGen Avatar and user through the HeyGenClient, which handles session
   * initialization via HeyGenApi.
   *
   * @param options.fetch `fetch` for API requests (upstream: an aiohttp session).
   * @param options.apiKey HeyGen API key for authentication.
   * @param options.params HeyGen-specific configuration parameters (default: new HeyGenParams()).
   * @param options.inputName Optional custom name for the input transport.
   * @param options.outputName Optional custom name for the output transport.
   * @param options.sessionRequest Configuration for the HeyGen session.
   * @param options.serviceType Service type for the avatar session.
   */
  constructor(options: HeyGenTransportOptions) {
    const params = options.params ?? new HeyGenParams();
    super({ inputName: options.inputName, outputName: options.outputName });
    this._params = params;
    this._client = new HeyGenClient({
      ...(options.clientOptions ?? {}),
      apiKey: options.apiKey,
      fetch: options.fetch,
      params,
      sessionRequest: options.sessionRequest,
      serviceType: options.serviceType,
      callbacks: new HeyGenCallbacks({
        onConnected: () => this._onConnected(),
        onParticipantConnected: (id) => this._onParticipantConnected(id),
        onParticipantDisconnected: (id) => this._onParticipantDisconnected(id),
      }),
    });

    // Register supported handlers. The user will only be able to register
    // these handlers.
    this._registerEventHandler("on_connected");
    this._registerEventHandler("on_client_connected");
    this._registerEventHandler("on_client_disconnected");
  }

  /** Handle bot connected to LiveKit room. */
  protected async _onConnected(): Promise<void> {
    await this._callEventHandler("on_connected");
    if (this._input) {
      await this._input.pushFrame(new BotConnectedFrame());
    }
  }

  protected async _onParticipantDisconnected(participantId: string): Promise<void> {
    logger.debug(`HeyGen participant ${participantId} disconnected`);
    if (participantId !== "heygen") {
      await this._onClientDisconnected(participantId);
    }
  }

  protected async _onParticipantConnected(participantId: string): Promise<void> {
    logger.debug(`HeyGen participant ${participantId} connected`);
    if (participantId !== "heygen") {
      await this._onClientConnected(participantId);
      if (this._input) {
        await this._input.startCapturingAudio(participantId);
      }
    }
  }

  /**
   * Get the input transport for receiving media and events.
   *
   * @returns The HeyGen input transport instance.
   */
  input(): FrameProcessor {
    if (!this._input) {
      this._input = new HeyGenInputTransport(this._client, this._params);
    }
    return this._input;
  }

  /**
   * Get the output transport for sending media and events.
   *
   * @returns The HeyGen output transport instance.
   */
  output(): FrameProcessor {
    if (!this._output) {
      this._output = new HeyGenOutputTransport(this._client, this._params);
    }
    return this._output;
  }

  /** Handle client connected events. */
  protected async _onClientConnected(participant: unknown): Promise<void> {
    await this._callEventHandler("on_client_connected", participant);
    if (this._input) {
      await this._input.pushFrame(new ClientConnectedFrame());
    }
  }

  /** Handle client disconnected events. */
  protected async _onClientDisconnected(participant: unknown): Promise<void> {
    await this._callEventHandler("on_client_disconnected", participant);
  }
}
