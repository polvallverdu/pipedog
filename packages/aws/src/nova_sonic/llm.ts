// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/aws/nova_sonic/llm.py

/**
 * AWS Nova Sonic LLM service implementation for Pipecat AI framework.
 *
 * This module provides a speech-to-speech LLM service using AWS Nova Sonic, which supports
 * bidirectional audio streaming, text generation, and function calling capabilities.
 *
 * Porting notes:
 * - DIVERGENCE (transport): upstream calls `InvokeModelWithBidirectionalStream`
 *   over HTTP/2 through the experimental `aws_sdk_bedrock_runtime`. HTTP/2
 *   full-duplex streaming is not available to `fetch`, nor at all on
 *   Cloudflare Workers, so the default client speaks the same API over
 *   Bedrock's WebSocket endpoint (`bidirectional_stream.ts`), the transport the
 *   AWS SDK for JavaScript uses in browsers; it runs on Bun, Node, Deno and
 *   Workers. `transport: "http2"` uses `@aws-sdk/client-bedrock-runtime`
 *   (an optional peer, loaded lazily) over HTTP/2 instead, as upstream does;
 *   that needs Node's `node:http2` (Node, Bun). Either way the JSON events on
 *   the wire are upstream's, character for character.
 * - DIVERGENCE (credentials): `secretAccessKey`, `accessKeyId` and `region`
 *   are optional. Missing keys fall back to `AWS_ACCESS_KEY_ID` /
 *   `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION` and then to
 *   `credentialsProvider`, which is called for every new session.
 * - The `ready.wav` trigger audio (older Nova Sonic model only) ships as
 *   base64 PCM in `ready_audio.ts`, so it loads on every runtime.
 * - Deprecated upstream APIs are not ported: the `Params` class, and the
 *   `model`, `voiceId`, `params` and `systemInstruction` constructor options
 *   (use `settings` and `audioConfig`).
 */

import { CancelledError, rethrowIfCancelled, sleep, type Task, time } from "@pipedog/asyncio";
import type { BaseLLMAdapter } from "@pipedog/core/adapters/base_llm_adapter";
import type { DirectFunction } from "@pipedog/core/adapters/schemas/direct_function";
import type { FunctionSchema } from "@pipedog/core/adapters/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import {
  AggregatedTextFrame,
  type CancelFrame,
  type EndFrame,
  type Frame,
  FunctionCallFromLLM,
  FunctionCallResultFrame,
  InputAudioRawFrame,
  InterruptionFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMMessagesAppendFrame,
  LLMServiceMetadataFrame,
  LLMTextFrame,
  TextType,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import * as asyncToolMessages from "@pipedog/core/processors/aggregators/async_tool_messages";
import {
  LLMContext,
  LLMSpecificMessage,
  type LLMStandardMessage,
  standardMessageText,
} from "@pipedog/core/processors/aggregators/llm_context";
import { FrameDirection, type FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { LLMService, type LLMServiceOptions } from "@pipedog/core/services/llm_service";
import { LLMSettings, type LLMSettingsOptions } from "@pipedog/core/services/settings";
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import {
  type AWSNovaSonicConversationHistoryMessage,
  AWSNovaSonicLLMAdapter,
  Role,
} from "../aws_nova_sonic_adapter.ts";
import { type AWSCredentialsProvider, AWSSession } from "../aws_session.ts";
import {
  type BidirectionalStream,
  openBedrockSdkStream,
  openBedrockWebSocketStream,
} from "../bidirectional_stream.ts";
import { READY_AUDIO_BASE64 } from "./ready_audio.ts";
import {
  type NovaSonicSessionSender,
  SessionContinuationHelper,
  SessionContinuationParams,
} from "./session_continuation.ts";

type Dict = Record<string, any>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Exception raised when the LLM attempts to call an unregistered function. */
export class AWSNovaSonicUnhandledFunctionException extends Error {
  override name = "AWSNovaSonicUnhandledFunctionException";
}

/**
 * Content types supported by AWS Nova Sonic.
 *
 * - `AUDIO`: Audio content type.
 * - `TEXT`: Text content type.
 * - `TOOL`: Tool content type.
 */
export const ContentType = {
  AUDIO: "AUDIO",
  TEXT: "TEXT",
  TOOL: "TOOL",
} as const;
export type ContentType = (typeof ContentType)[keyof typeof ContentType];

/**
 * Text generation stages in AWS Nova Sonic responses.
 *
 * - `FINAL`: Final text that has been fully generated.
 * - `SPECULATIVE`: Speculative text that is still being generated.
 */
export const TextStage = {
  FINAL: "FINAL", // what has been said
  SPECULATIVE: "SPECULATIVE", // what's planned to be said
} as const;
export type TextStage = (typeof TextStage)[keyof typeof TextStage];

export interface CurrentContentOptions {
  type: ContentType;
  role: Role;
  textStage: TextStage | null;
  textContent: string | null;
}

/**
 * Represents content currently being received from AWS Nova Sonic.
 *
 * - `type`: The type of content (audio, text, or tool).
 * - `role`: The role generating the content (user, assistant, etc.).
 * - `textStage`: The stage of text generation (final or speculative), or null
 *   for content that isn't text.
 * - `textContent`: The text content, filled in as it arrives, or null until then.
 */
export class CurrentContent {
  type: ContentType;
  role: Role;
  textStage: TextStage | null;
  textContent: string | null;

  constructor(options: CurrentContentOptions) {
    this.type = options.type;
    this.role = options.role;
    this.textStage = options.textStage;
    this.textContent = options.textContent;
  }

  /** String representation of the current content. */
  toString(): string {
    return (
      "CurrentContent(\n" +
      `  type=${this.type},\n` +
      `  role=${this.role},\n` +
      `  text_stage=${this.textStage ?? "None"}\n` +
      ")"
    );
  }
}

export interface AudioConfigOptions {
  inputSampleRate?: number;
  inputSampleSize?: number;
  inputChannelCount?: number;
  outputSampleRate?: number;
  outputSampleSize?: number;
  outputChannelCount?: number;
}

/**
 * Audio configuration for AWS Nova Sonic.
 *
 * - `inputSampleRate`: Audio input sample rate in Hz.
 * - `inputSampleSize`: Audio input sample size in bits.
 * - `inputChannelCount`: Number of input audio channels.
 * - `outputSampleRate`: Audio output sample rate in Hz.
 * - `outputSampleSize`: Audio output sample size in bits.
 * - `outputChannelCount`: Number of output audio channels.
 */
export class AudioConfig {
  // Input
  inputSampleRate: number;
  inputSampleSize: number;
  inputChannelCount: number;

  // Output
  outputSampleRate: number;
  outputSampleSize: number;
  outputChannelCount: number;

  constructor(options: AudioConfigOptions = {}) {
    this.inputSampleRate = options.inputSampleRate ?? 16000;
    this.inputSampleSize = options.inputSampleSize ?? 16;
    this.inputChannelCount = options.inputChannelCount ?? 1;
    this.outputSampleRate = options.outputSampleRate ?? 24000;
    this.outputSampleSize = options.outputSampleSize ?? 16;
    this.outputChannelCount = options.outputChannelCount ?? 1;
  }
}

export interface AWSNovaSonicLLMSettingsOptions extends LLMSettingsOptions {
  voice?: string | NotGiven;
  endpointingSensitivity?: string | null | NotGiven;
}

/**
 * Settings for AWSNovaSonicLLMService.
 *
 * - `voice`: Voice identifier for speech synthesis.
 * - `endpointingSensitivity`: Controls how quickly Nova Sonic decides the
 *   user has stopped speaking. Can be "LOW", "MEDIUM", or "HIGH".
 */
export class AWSNovaSonicLLMSettings extends LLMSettings {
  voice: string | NotGiven = NOT_GIVEN;
  endpointingSensitivity: string | null | NotGiven = NOT_GIVEN;

  constructor(options: AWSNovaSonicLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/**
 * A Bedrock runtime client, as far as Nova Sonic needs one: it opens
 * bidirectional streams.
 */
export interface NovaSonicStreamClient {
  /** Open `InvokeModelWithBidirectionalStream` for a model. */
  invokeModelWithBidirectionalStream(modelId: string): Promise<BidirectionalStream>;
}

/** How the default client reaches Bedrock. */
export type NovaSonicTransport = "websocket" | "http2";

export interface AWSNovaSonicLLMServiceOptions extends LLMServiceOptions {
  /** AWS secret access key for authentication. Falls back to `AWS_SECRET_ACCESS_KEY`. */
  secretAccessKey?: string | null;
  /** AWS access key ID for authentication. Falls back to `AWS_ACCESS_KEY_ID`. */
  accessKeyId?: string | null;
  /** AWS session token for authentication. Falls back to `AWS_SESSION_TOKEN`. */
  sessionToken?: string | null;
  /**
   * AWS region where the service is hosted. Supported regions: "us-east-1",
   * "us-west-2", "eu-north-1", "ap-northeast-1". Falls back to `AWS_REGION`.
   */
  region?: string | null;
  /** Keys to use when none are passed or set in the environment (pipedog addition). */
  credentialsProvider?: AWSCredentialsProvider | null;
  /**
   * Audio configuration (sample rates, sample sizes, channel counts). If not
   * provided, defaults are used.
   */
  audioConfig?: AudioConfig | null;
  /**
   * AWS Nova Sonic LLM settings.
   */
  settings?: AWSNovaSonicLLMSettings | null;
  /**
   * Available tools for the model: a `ToolsSchema` or a plain list of direct
   * functions and/or `FunctionSchema` objects (handlers auto-register).
   */
  tools?: ToolsSchema | (FunctionSchema | DirectFunction)[] | null;
  /**
   * Configuration for automatic session continuation. When enabled (the
   * default), sessions are seamlessly rotated before the AWS time limit
   * (~8 minutes) with no user-perceptible interruption.
   */
  sessionContinuation?: SessionContinuationParams | null;
  /**
   * Transport of the default client (pipedog addition): `"websocket"`
   * (default, every runtime) or `"http2"` (`@aws-sdk/client-bedrock-runtime`,
   * Node and Bun).
   */
  transport?: NovaSonicTransport;
  /** Endpoint override, `https://host[:port]` (pipedog addition). */
  endpointUrl?: string | null;
  /** Creates the Bedrock client (pipedog addition; replaces `createClient()`'s default). */
  clientFactory?: ((service: AWSNovaSonicLLMService) => NovaSonicStreamClient) | null;
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && (value as object).constructor === Object) {
    return Object.keys(value as object).length > 0;
  }
  return true;
}

/**
 * AWS Nova Sonic speech-to-speech LLM service.
 *
 * Provides bidirectional audio streaming, real-time transcription, text generation,
 * and function calling capabilities using AWS Nova Sonic model.
 *
 * Does NOT emit `UserStartedSpeakingFrame` / `UserStoppedSpeakingFrame`,
 * so pipeline processors that depend on those frames — RTVI client
 * speech events, `TurnTrackingObserver`, `AudioBufferProcessor` turn
 * recording, `UserIdleController`, user mute strategies, voicemail
 * detector — won't activate with the default server-VAD-only setup.
 * `LLMContextAggregatorPair` auto-detects this realtime service so context
 * writes are correct anyway. To produce the turn frames
 * locally, wire `vadAnalyzer: new SileroVADAnalyzer()` (or similar) into
 * `LLMUserAggregatorParams`; locally-generated turn boundaries are a
 * heuristic and may not match Nova Sonic's server-side turn decisions.
 */
export class AWSNovaSonicLLMService
  extends LLMService<AWSNovaSonicLLMAdapter & BaseLLMAdapter>
  implements NovaSonicSessionSender<NovaSonicStreamClient>
{
  static Settings = AWSNovaSonicLLMSettings;
  declare protected _settings: AWSNovaSonicLLMSettings;

  // Override the default adapter to use the AWSNovaSonicLLMAdapter one
  static override adapterClass = AWSNovaSonicLLMAdapter;

  // Class variable
  static AWAIT_TRIGGER_ASSISTANT_RESPONSE_INSTRUCTION =
    "Start speaking when you hear the user say 'ready', but don't consider that 'ready' to be " +
    "a meaningful part of the conversation other than as a trigger for you to start speaking.";

  protected _awsSession: AWSSession;
  protected _region: string;
  protected _transport: NovaSonicTransport;
  protected _endpointUrl: string | null;
  protected _clientFactory: ((service: AWSNovaSonicLLMService) => NovaSonicStreamClient) | null;
  protected _client: NovaSonicStreamClient | null = null;
  protected _audioConfig: AudioConfig;
  protected _tools: ToolsSchema | null;

  protected _context: LLMContext | null = null;
  protected _stream: BidirectionalStream | null = null;
  protected _receiveTask: Task<unknown> | null = null;
  protected _promptName: string | null = null;
  protected _inputAudioContentName: string | null = null;
  protected _contentBeingReceived: CurrentContent | null = null;
  protected _assistantIsResponding = false;
  protected _readyToSendContext = false;
  protected _triggeringAssistantResponse = false;
  protected _waitingForTriggerTranscription = false;
  protected _disconnecting = false;
  protected _connectedTime: number | null = null;
  protected _wantsConnection = false;
  protected _userTextBuffer = "";
  protected _completedToolCalls = new Set<string>();
  protected _audioInputStarted = false;

  protected _sc: SessionContinuationHelper<NovaSonicStreamClient>;
  protected _pendingSpeculativeText: string | null = null;
  protected _assistantResponseTriggerAudio: Uint8Array;

  /** Realtime service; emits no server-side turn frames, so recommends no external strategies. */
  override serviceMetadataFrame(): LLMServiceMetadataFrame {
    this._warnIfRealtimeServiceEmitsNoTurnFrames(false);
    return new LLMServiceMetadataFrame({ serviceName: this.name, isRealtimeService: true });
  }

  /**
   * Initializes the AWS Nova Sonic LLM service.
   *
   * @param options.secretAccessKey AWS secret access key for authentication.
   * @param options.accessKeyId AWS access key ID for authentication.
   * @param options.sessionToken AWS session token for authentication.
   * @param options.region AWS region where the service is hosted.
   * @param options.audioConfig Audio configuration (sample rates, sample sizes,
   *   channel counts). If not provided, defaults are used.
   * @param options.settings AWS Nova Sonic LLM settings.
   * @param options.tools Available tools for the model.
   * @param options.sessionContinuation Configuration for automatic session continuation.
   *   Other options are passed to the parent LLMService.
   */
  constructor(options: AWSNovaSonicLLMServiceOptions = {}) {
    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = new AWSNovaSonicLLMSettings({
      model: "amazon.nova-2-5-sonic",
      systemInstruction: null,
      voice: "matthew",
      temperature: 0.7,
      maxTokens: 1024,
      topP: 0.9,
      topK: null,
      frequencyPenalty: null,
      presencePenalty: null,
      seed: null,
      filterIncompleteUserTurns: false,
      userTurnCompletionConfig: null,
      endpointingSensitivity: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, settings: defaultSettings });

    this._awsSession = AWSSession.fromOptions({
      awsAccessKeyId: options.accessKeyId,
      awsSecretAccessKey: options.secretAccessKey,
      awsSessionToken: options.sessionToken,
      region: options.region,
      credentialsProvider: options.credentialsProvider,
    });
    this._region = this._awsSession.region;
    this._transport = options.transport ?? "websocket";
    this._endpointUrl = options.endpointUrl ?? null;
    this._clientFactory = options.clientFactory ?? null;

    // Audio I/O config (hardware settings, not runtime-tunable)
    this._audioConfig = options.audioConfig ?? new AudioConfig();
    // Accept a plain list of standard tools as a convenience; normalize it to a
    // ToolsSchema so the rest of the service has a single form to handle.
    let tools: ToolsSchema | null = (options.tools as ToolsSchema | null | undefined) ?? null;
    if (Array.isArray(options.tools)) {
      const normalized = LLMContext._normalizeAndValidateTools(options.tools);
      tools = normalized instanceof ToolsSchema ? normalized : null;
    }
    this._tools = tools;

    // Validate endpointingSensitivity parameter
    if (this._settings.endpointingSensitivity && !this._isEndpointingSensitivitySupported()) {
      logger.warning(
        `endpointing_sensitivity is not supported for model '${String(this._settings.model)}' and will be ignored. ` +
          "This parameter is supported starting with Nova 2 Sonic (amazon.nova-2-sonic-v1:0) and later models such as Nova 2.5 Sonic.",
      );
      this._settings.endpointingSensitivity = null;
    }

    // Session continuation helper. The service itself implements the
    // NovaSonicSessionSender protocol (see methods below) so the helper can
    // target either the current or next session without coupling to the
    // service's internal config.
    const scParams = options.sessionContinuation ?? new SessionContinuationParams();
    this._sc = new SessionContinuationHelper(scParams, {
      sender: this,
      createTask: (fn) => this.createTask(fn),
      cancelTask: (task, timeout) => this.cancelTask(task, timeout),
    });

    this._assistantResponseTriggerAudio = base64ToBytes(READY_AUDIO_BASE64);
  }

  //
  // settings
  //

  /**
   * Apply a settings delta.
   *
   * Settings are stored but not applied to the active connection.
   */
  protected override async _updateSettings(delta: LLMSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if (Object.keys(changed).length === 0) {
      return changed;
    }

    // TODO: someday we could reconnect here to apply updated settings.
    // Code might look something like the below:
    // await this._disconnect();
    // await this._startConnecting();

    this._warnUnhandledUpdatedSettings(changed);

    return changed;
  }

  //
  // standard AIService frame handling
  //

  /**
   * Set up the service.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._wantsConnection = true;
    await this._startConnecting();
  }

  /**
   * Stop the service and close connections.
   *
   * @param frame The end frame triggering service shutdown.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._teardown();
  }

  /**
   * Cancel the service and close connections.
   *
   * @param frame The cancel frame triggering service cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._teardown();
  }

  /** Release AWS Nova Sonic resources at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._teardown();
  }

  /**
   * Stop wanting a connection and disconnect (idempotent).
   *
   * Shared by `stop`/`cancel`/`cleanup`. Distinct from `_disconnect`, which
   * leaves `_wantsConnection` untouched so `resetConversation` can disconnect
   * and reconnect.
   */
  protected async _teardown(): Promise<void> {
    this._wantsConnection = false;
    await this._disconnect();
  }

  /**
   * Check if the service can generate usage metrics.
   *
   * @returns True if metrics generation is supported.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  //
  // conversation resetting
  //

  /**
   * Reset the conversation state while preserving context.
   *
   * Cleans up any in-progress assistant response, disconnects from the
   * service, and reconnects with the preserved context.
   */
  async resetConversation(): Promise<void> {
    logger.debug("Resetting conversation");

    // Grab context to carry through disconnect/reconnect
    const context = this._context;
    if (context === null) {
      logger.warning(
        "reset_conversation called before an initial context was received; nothing to reset",
      );
      return;
    }

    if (this._assistantIsResponding) {
      this._assistantIsResponding = false;
      await this._reportAssistantResponseEnded();
    }

    await this._disconnect();
    await this._startConnecting();
    await this._handleContext(context);
  }

  //
  // frame processing
  //

  /** Return the tools configured via `tools` at construction, if any. */
  protected override _serviceTools(): ToolsSchema | null {
    return this._tools;
  }

  /**
   * Intermediate results reach the model as text input.
   *
   * Nova Sonic takes one `toolResult` per call, so an intermediate result
   * goes in as text beside the call — which is what the docs suggest for
   * keeping a conversation going while an async tool runs.
   */
  override get acceptsIntermediateFunctionCallResults(): boolean {
    return true;
  }

  /**
   * Push a frame, sending function call results to the API on the way.
   *
   * Results are broadcast by the base service; the downstream copy is
   * observed here and sent as it is produced, so a tool that reports
   * progress reaches the model while it is still working.
   *
   * @param frame The frame to push.
   * @param direction The direction of frame pushing.
   */
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    if (direction === FrameDirection.DOWNSTREAM && frame instanceof FunctionCallResultFrame) {
      await this._handleFunctionCallResult(frame);
    }
    await super.pushFrame(frame, direction);
  }

  /**
   * Send one result to the API as it is produced.
   *
   * A final result goes through the tool-result channel, which Nova Sonic
   * always folds into what it says next. An intermediate one goes in as
   * text: interactive when the model should say something about it,
   * plain text for it to take in otherwise.
   */
  protected async _handleFunctionCallResult(frame: FunctionCallResultFrame): Promise<void> {
    const result = truthy(frame.result)
      ? pyJsonDumps(frame.result, { ensureAscii: false })
      : "COMPLETED";
    const isFinal = frame.properties ? frame.properties.isFinal : true;
    if (isFinal) {
      await this._sendToolResult(frame.toolCallId, result);
      this._completedToolCalls.add(frame.toolCallId);
      return;
    }
    let runLlm = frame.properties ? frame.properties.runLlm : null;
    if (runLlm === null || runLlm === undefined) {
      runLlm = frame.runLlm !== null ? frame.runLlm : true;
    }
    const message = asyncToolMessages.buildIntermediateResultMessage(frame.toolCallId, result);
    await this._sendTextEvent((message as Dict).content ?? "", Role.USER, Boolean(runLlm));
  }

  /**
   * Process incoming frames and handle service-specific logic.
   *
   * @param frame The frame to process.
   * @param direction The direction the frame is traveling.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof LLMContextFrame) {
      await this._handleContext(frame.context);
    } else if (frame instanceof InputAudioRawFrame) {
      await this._handleInputAudioFrame(frame);
    } else if (frame instanceof InterruptionFrame) {
      await this._handleInterruptionFrame();
    } else if (frame instanceof LLMMessagesAppendFrame) {
      await this._handleMessagesAppend(frame);
    }

    await this.pushFrame(frame, direction);
  }

  /**
   * Put appended messages into the session as text, for the model to take in.
   *
   * Interactive text when the append asks to run, which the model answers
   * as it would the user speaking; plain text otherwise, which it takes in
   * without answering.
   */
  protected async _handleMessagesAppend(frame: LLMMessagesAppendFrame): Promise<void> {
    for (const message of frame.messages) {
      const text = standardMessageText(message);
      if (text) {
        await this._sendTextEvent(text, Role.USER, Boolean(frame.runLlm));
      }
    }
  }

  protected async _handleContext(context: LLMContext): Promise<void> {
    if (this._disconnecting) {
      return;
    }

    if (!this._context) {
      // We got our initial context
      // Try to finish connecting
      this._context = context;
      await this._finishConnectingIfContextAvailable();
    } else {
      // We got an updated context
      // Send results for any newly-completed function calls
      await this._processCompletedFunctionCalls(true);
    }
  }

  protected async _handleInputAudioFrame(frame: InputAudioRawFrame): Promise<void> {
    // Wait until we're done sending the assistant response trigger audio before sending audio
    // from the user's mic
    if (this._triggeringAssistantResponse) {
      return;
    }

    // Session continuation: let the helper buffer audio during the transition window
    this._sc.onAudioInput(frame.audio);

    // Stop sending audio to the old stream once a handoff is in progress.
    // Audio is still being buffered above and will be replayed to the new
    // session. Matches reference: old session state set to CLOSING stops
    // audio routing before close events are sent.
    if (this._sc.handoffInProgress) {
      return;
    }

    await this._sendUserAudioEvent(frame.audio);
  }

  protected async _handleInterruptionFrame(): Promise<void> {}

  //
  // LLM communication: lifecycle
  //

  protected async _startConnecting(): Promise<void> {
    try {
      logger.info("Connecting...");

      if (this._client) {
        // Here we assume that if we have a client we are connected or connecting
        return;
      }

      // Set IDs for the connection
      this._promptName = crypto.randomUUID();
      this._inputAudioContentName = crypto.randomUUID();

      // Create the client
      this._client = this.createClient();

      // Start the bidirectional stream
      this._stream = await this._client.invokeModelWithBidirectionalStream(
        assertGiven(this._settings.model) as string,
      );

      // Send session start event
      await this._sendSessionStartEvent();

      // Finish connecting
      this._readyToSendContext = true;
      await this._finishConnectingIfContextAvailable();
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Initialization error: ${errorText(e)}`, { exception: e });
      await this._disconnect();
    }
  }

  protected async _processCompletedFunctionCalls(sendNewResults: boolean): Promise<void> {
    if (!this._context) {
      // should never happen
      return;
    }
    // Check for set of completed function calls in the context
    for (const message of this._context.getMessages()) {
      // LLMSpecificMessages are opaque provider-specific payloads, not
      // standard tool-result messages — skip them.
      if (message instanceof LLMSpecificMessage) {
        continue;
      }

      // Async-tool messages live alongside regular tool messages in the
      // context; detect and route them before the regular logic so we
      // don't try to send the async-tool envelope JSON as a tool result.
      const asyncPayload = asyncToolMessages.parseMessage(message as LLMStandardMessage);
      if (asyncPayload !== null) {
        if (this._completedToolCalls.has(asyncPayload.toolCallId)) {
          continue;
        }
        if (asyncPayload.kind === "started") {
          // The provider already issued the tool call and natively
          // awaits a result; nothing to send for the started marker.
          continue;
        }
        if (asyncPayload.kind === "intermediate") {
          // Sent as text when it was produced; the call stays open
          // for the result that settles it.
          continue;
        }
        if (asyncPayload.kind === "final") {
          // Deliver via the formal toolResult channel — same path
          // as a synchronous tool result, just delayed.
          if (sendNewResults) {
            await this._sendToolResult(asyncPayload.toolCallId, asyncPayload.result);
          }
          this._completedToolCalls.add(asyncPayload.toolCallId);
          continue;
        }
        // Defensive: any async-tool message must not fall through
        // to the regular tool-result block below, even if it
        // carries a kind we don't recognize.
        continue;
      }

      // Look for newly-completed "regular" (as opposed to async-tool) results
      const msg = message as Dict;
      if (msg.role === "tool" && msg.content !== "IN_PROGRESS" && msg.content !== "CANCELLED") {
        const toolCallId = msg.tool_call_id as string | undefined;
        if (toolCallId && !this._completedToolCalls.has(toolCallId)) {
          // Found a newly-completed function call - send the result to the service
          if (sendNewResults) {
            await this._sendToolResult(toolCallId, msg.content);
          }
          this._completedToolCalls.add(toolCallId);
        }
      }
    }
  }

  protected async _finishConnectingIfContextAvailable(): Promise<void> {
    // We can only finish connecting once we've gotten our initial context and we're ready to
    // send it
    if (!(this._context && this._readyToSendContext)) {
      return;
    }

    logger.info("Finishing connecting (setting up session)...");

    // Initialize our bookkeeping of already-completed tool calls in the
    // context
    await this._processCompletedFunctionCalls(false);

    // Read context
    const adapter = this.getLlmAdapter();
    const llmConnectionParams = await adapter.getLlmInvocationParams(this._context, {
      systemInstruction: assertGiven(this._settings.systemInstruction),
      serviceTools: this._tools,
    });

    // Send prompt start event, specifying tools: the context's own when it
    // has any, else the init-provided ones; built-in tools ride along either way.
    const tools = llmConnectionParams.tools;
    logger.debug(`Using tools: ${pyJsonDumps(tools)}`);
    await this._sendPromptStartEvent(tools);

    // Send system instruction.
    // The adapter resolves conflicts between init-provided and
    // context-provided system instructions (preferring init-provided).
    const systemInstruction = llmConnectionParams.system_instruction;
    logger.debug(`Using system instruction: ${systemInstruction}`);
    if (systemInstruction) {
      await this._sendTextEvent(systemInstruction, Role.SYSTEM);
    }

    // Send conversation history (except for the last message if it's from the
    // user, which we'll send as interactive after starting audio input)
    const messages = llmConnectionParams.messages;
    let lastUserMessage: AWSNovaSonicConversationHistoryMessage | null = null;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i] as AWSNovaSonicConversationHistoryMessage;
      const isLastMessage = i === messages.length - 1;
      if (isLastMessage && message.role === Role.USER) {
        // Save for sending after audio input starts
        lastUserMessage = message;
      } else {
        await this._sendTextEvent(message.text, message.role);
      }
    }

    // Start audio input
    await this._sendAudioInputStartEvent();

    // Now send the last user message as interactive to trigger bot response
    if (lastUserMessage) {
      await this._sendTextEvent(lastUserMessage.text, lastUserMessage.role, true);
    }

    // Start receiving events (bound to the current stream)
    const stream = this._stream;
    this._receiveTask = this.createTask(
      () => this._receiveTaskHandler(stream),
      "receive_task_handler",
    );

    // Record finished connecting time (must be done before sending assistant response trigger)
    this._connectedTime = time();

    logger.info("Finished connecting");

    // Notify session continuation helper of connection and start monitoring
    this._sc.setConnected(this._connectedTime);
    // Seed the helper's history with initial context messages (these wouldn't be
    // captured via real-time FINAL text events since they pre-date the session)
    for (const message of llmConnectionParams.messages) {
      this._sc.seedHistory(message.role, message.text);
    }
    this._sc.startMonitor();

    // If we need to, send assistant response trigger (depends on this._connectedTime)
    if (this._triggeringAssistantResponse) {
      await this._sendAssistantResponseTrigger();
    }
  }

  protected async _disconnect(): Promise<void> {
    try {
      logger.info("Disconnecting...");

      // NOTE: see explanation of HACK, below
      this._disconnecting = true;

      // Clean up client
      if (this._client) {
        await this._sendSessionEndEvents();
        this._client = null;
      }

      // Clean up context
      this._context = null;

      // Clean up stream
      if (this._stream) {
        await this._stream.close();
        this._stream = null;
      }

      // NOTE: see explanation of HACK, below
      await sleep(1);

      // Clean up receive task
      // HACK: we should ideally be able to cancel the receive task before stopping the input
      // stream, above (meaning we wouldn't need this._disconnecting). But for some reason if
      // we don't close the input stream and wait a second first, we're getting an error a lot
      // like this one: https://github.com/awslabs/amazon-transcribe-streaming-sdk/issues/61.
      if (this._receiveTask) {
        await this.cancelTask(this._receiveTask, 1.0);
        this._receiveTask = null;
      }

      // Reset remaining connection-specific state
      // Should be all private state except:
      // - _wantsConnection
      // - _assistantResponseTriggerAudio
      this._promptName = null;
      this._inputAudioContentName = null;
      this._contentBeingReceived = null;
      this._assistantIsResponding = false;
      this._readyToSendContext = false;
      this._triggeringAssistantResponse = false;
      this._waitingForTriggerTranscription = false;
      this._disconnecting = false;
      this._connectedTime = null;
      this._userTextBuffer = "";
      this._completedToolCalls = new Set();
      this._audioInputStarted = false;
      this._pendingSpeculativeText = null;

      // Stop session continuation monitor and notify of disconnect
      await this._sc.stopMonitor();
      await this._sc.cleanupNextSession();
      this._sc.setDisconnected();

      logger.info("Finished disconnecting");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error disconnecting: ${errorText(e)}`, { exception: e });
    }
  }

  /** Create a new Bedrock runtime client (NovaSonicSessionSender protocol). */
  createClient(): NovaSonicStreamClient {
    if (this._clientFactory) {
      return this._clientFactory(this);
    }
    const session = this._awsSession;
    const endpointUrl =
      this._endpointUrl ?? `https://bedrock-runtime.${this._region}.amazonaws.com`;
    if (this._transport === "http2") {
      return {
        invokeModelWithBidirectionalStream: (modelId) =>
          openBedrockSdkStream({ session, modelId, endpointUrl }),
      };
    }
    return {
      invokeModelWithBidirectionalStream: (modelId) =>
        openBedrockWebSocketStream({ session, modelId, endpointUrl }),
    };
  }

  /** The audio configuration (NovaSonicSessionSender protocol). */
  get audioConfig(): AudioConfig {
    return this._audioConfig;
  }

  protected _isFirstGenerationSonicModel(): boolean {
    // Nova Sonic (the older model) is identified by "amazon.nova-sonic-v1:0"
    return this._settings.model === "amazon.nova-sonic-v1:0";
  }

  protected _isEndpointingSensitivitySupported(): boolean {
    // endpointing_sensitivity is only supported with Nova 2 Sonic (and,
    // presumably, future models)
    return !this._isFirstGenerationSonicModel();
  }

  protected _isAssistantResponseTriggerNeeded(): boolean {
    // Assistant response trigger audio is only needed with the older model
    return this._isFirstGenerationSonicModel();
  }

  //
  // LLM communication: input events (pipecat -> LLM)
  //
  // These methods operate on the current session. They're thin wrappers over
  // the NovaSonicSessionSender protocol methods (which accept an explicit
  // stream/promptName), reusing the same Nova Sonic wire-format serialization
  // for both the current session and next-session setup during a handoff.
  //

  protected async _sendSessionStartEvent(): Promise<void> {
    await this._sendClientEvent(this.buildSessionStartJson());
  }

  protected async _sendPromptStartEvent(tools: unknown[]): Promise<void> {
    if (!this._promptName || !this._stream) {
      return;
    }
    await this.sendPromptStart(tools, this._promptName, this._stream);
  }

  protected async _sendAudioInputStartEvent(): Promise<void> {
    if (!this._promptName || !this._inputAudioContentName || !this._stream) {
      return;
    }
    await this.sendAudioInputStart(this._promptName, this._inputAudioContentName, this._stream);
    this._audioInputStarted = true;
  }

  /**
   * Send a text event to the LLM.
   *
   * @param text The text content to send.
   * @param role The role associated with the text (e.g., USER, ASSISTANT, SYSTEM).
   * @param interactive Whether the content is interactive. Defaults to false.
   *   False: conversation history or system instruction, sent prior to interactive audio.
   *   True: text input sent during (or at the start of) interactive audio.
   */
  protected async _sendTextEvent(text: string, role: Role, interactive = false): Promise<void> {
    if (!this._stream || !this._promptName || !text) {
      return;
    }
    await this.sendText(text, role, this._promptName, this._stream, interactive);
  }

  protected async _sendUserAudioEvent(audio: Uint8Array): Promise<void> {
    if (
      !this._stream ||
      !this._audioInputStarted ||
      !this._promptName ||
      !this._inputAudioContentName
    ) {
      return;
    }
    await this.sendAudio(audio, this._promptName, this._inputAudioContentName, this._stream);
  }

  protected async _sendSessionEndEvents(): Promise<void> {
    if (!this._stream || !this._promptName) {
      return;
    }

    const promptEnd = `
        {
            "event": {
                "promptEnd": {
                    "promptName": "${this._promptName}"
                }
            }
        }
        `;
    await this._sendClientEvent(promptEnd);

    const sessionEnd = `
        {
            "event": {
                "sessionEnd": {}
            }
        }
        `;
    await this._sendClientEvent(sessionEnd);
  }

  protected async _sendToolResult(toolCallId: string, result: unknown): Promise<void> {
    if (!this._stream || !this._promptName) {
      return;
    }

    logger.debug(`Sending tool result to Nova Sonic for tool_call_id=${toolCallId}`);

    const contentName = crypto.randomUUID();

    const resultContentStart = `
        {
            "event": {
                "contentStart": {
                    "promptName": "${this._promptName}",
                    "contentName": "${contentName}",
                    "interactive": false,
                    "type": "TOOL",
                    "role": "TOOL",
                    "toolResultInputConfiguration": {
                        "toolUseId": "${toolCallId}",
                        "type": "TEXT",
                        "textInputConfiguration": {
                            "mediaType": "text/plain"
                        }
                    }
                }
            }
        }
        `;
    await this._sendClientEvent(resultContentStart);

    const isDict =
      result !== null && typeof result === "object" && (result as object).constructor === Object;
    const resultContent = pyJsonDumps({
      event: {
        toolResult: {
          promptName: this._promptName,
          contentName,
          content: isDict ? pyJsonDumps(result, { ensureAscii: false }) : result,
        },
      },
    });
    await this._sendClientEvent(resultContent);

    const resultContentEnd = `
        {
            "event": {
                "contentEnd": {
                    "promptName": "${this._promptName}",
                    "contentName": "${contentName}"
                }
            }
        }
        `;
    await this._sendClientEvent(resultContentEnd);
  }

  protected async _sendClientEvent(eventJson: string): Promise<void> {
    if (!this._stream) {
      // should never happen
      return;
    }
    await this._stream.send(encoder.encode(eventJson));
  }

  //
  // NovaSonicSessionSender protocol implementation
  //
  // These methods expose the Nova Sonic wire protocol to the session
  // continuation helper. Each accepts an explicit `stream` / `promptName`
  // so the helper can target either the current session or a pre-created
  // next session during a handoff.
  //

  /**
   * Build the `sessionStart` event JSON.
   *
   * Shared between the current and next session setup.
   */
  buildSessionStartJson(): string {
    const turnDetectionConfig = this._settings.endpointingSensitivity
      ? `,
              "turnDetectionConfiguration": {
                "endpointingSensitivity": "${this._settings.endpointingSensitivity}"
              }`
      : "";
    return `
        {
          "event": {
            "sessionStart": {
              "inferenceConfiguration": {
                "maxTokens": ${pyValue(this._settings.maxTokens)},
                "topP": ${pyValue(this._settings.topP)},
                "temperature": ${pyValue(this._settings.temperature)}
              }${turnDetectionConfig}
            }
          }
        }
        `;
  }

  /** Open a bidirectional stream on the given client. */
  async openStream(client: NovaSonicStreamClient): Promise<BidirectionalStream> {
    return await client.invokeModelWithBidirectionalStream(
      assertGiven(this._settings.model) as string,
    );
  }

  /** Send a raw event JSON to the given stream. */
  async sendEvent(eventJson: string, stream: BidirectionalStream | null): Promise<void> {
    if (!stream) {
      return;
    }
    await stream.send(encoder.encode(eventJson));
  }

  /** Send a text content block (contentStart/textInput/contentEnd) to the given stream. */
  async sendText(
    text: string,
    role: string,
    promptName: string,
    stream: BidirectionalStream,
    interactive: boolean,
  ): Promise<void> {
    if (!text || !stream || !promptName) {
      return;
    }
    const contentName = crypto.randomUUID();
    const escapedText = pyJsonDumps(text);

    const contentStart = `
        {
            "event": {
                "contentStart": {
                    "promptName": "${promptName}",
                    "contentName": "${contentName}",
                    "type": "TEXT",
                    "interactive": ${pyJsonDumps(interactive)},
                    "role": "${role}",
                    "textInputConfiguration": {
                        "mediaType": "text/plain"
                    }
                }
            }
        }
        `;
    await this.sendEvent(contentStart, stream);

    const textInput = `
        {
            "event": {
                "textInput": {
                    "promptName": "${promptName}",
                    "contentName": "${contentName}",
                    "content": ${escapedText}
                }
            }
        }
        `;
    await this.sendEvent(textInput, stream);

    const contentEnd = `
        {
            "event": {
                "contentEnd": {
                    "promptName": "${promptName}",
                    "contentName": "${contentName}"
                }
            }
        }
        `;
    await this.sendEvent(contentEnd, stream);
  }

  /** Send an audio input `contentStart` to the given stream. */
  async sendAudioInputStart(
    promptName: string,
    contentName: string,
    stream: BidirectionalStream,
  ): Promise<void> {
    const eventJson = `
        {
            "event": {
                "contentStart": {
                    "promptName": "${promptName}",
                    "contentName": "${contentName}",
                    "type": "AUDIO",
                    "interactive": true,
                    "role": "USER",
                    "audioInputConfiguration": {
                        "mediaType": "audio/lpcm",
                        "sampleRateHertz": ${this._audioConfig.inputSampleRate},
                        "sampleSizeBits": ${this._audioConfig.inputSampleSize},
                        "channelCount": ${this._audioConfig.inputChannelCount},
                        "audioType": "SPEECH",
                        "encoding": "base64"
                    }
                }
            }
        }
        `;
    await this.sendEvent(eventJson, stream);
  }

  /** Send an `audioInput` event to the given stream. */
  async sendAudio(
    audio: Uint8Array,
    promptName: string,
    contentName: string,
    stream: BidirectionalStream,
  ): Promise<void> {
    const blob = bytesToBase64(audio);
    const eventJson = `
        {
            "event": {
                "audioInput": {
                    "promptName": "${promptName}",
                    "contentName": "${contentName}",
                    "content": "${blob}"
                }
            }
        }
        `;
    await this.sendEvent(eventJson, stream);
  }

  /** Send a `promptStart` event to the given stream. */
  async sendPromptStart(
    tools: unknown[],
    promptName: string,
    stream: BidirectionalStream,
  ): Promise<void> {
    const toolsConfig =
      tools && tools.length > 0
        ? `,
        "toolUseOutputConfiguration": {
          "mediaType": "application/json"
        },
        "toolConfiguration": {
          "tools": ${pyJsonDumps(tools)}
        }
        `
        : "";
    const eventJson = `
        {
          "event": {
            "promptStart": {
              "promptName": "${promptName}",
              "textOutputConfiguration": {
                "mediaType": "text/plain"
              },
              "audioOutputConfiguration": {
                "mediaType": "audio/lpcm",
                "sampleRateHertz": ${this._audioConfig.outputSampleRate},
                "sampleSizeBits": ${this._audioConfig.outputSampleSize},
                "channelCount": ${this._audioConfig.outputChannelCount},
                "voiceId": "${String(this._settings.voice)}",
                "encoding": "base64",
                "audioType": "SPEECH"
              }${toolsConfig}
            }
          }
        }
        `;
    await this.sendEvent(eventJson, stream);
  }

  /** Return `[systemInstruction, tools]` for the next session setup. */
  async getSetupParams(): Promise<[string | null, unknown[]]> {
    if (!this._context) {
      return [null, []];
    }
    const adapter = this.getLlmAdapter();
    const llmParams = await adapter.getLlmInvocationParams(this._context, {
      systemInstruction: assertGiven(this._settings.systemInstruction),
      serviceTools: this._tools,
    });
    return [llmParams.system_instruction, llmParams.tools];
  }

  /** Swap the current session with the pre-created next one. */
  protected async _runScHandoff(): Promise<void> {
    // Snapshot the old session's resources before the helper swaps them out
    const oldClient = this._client;
    const oldStream = this._stream;
    const oldReceiveTask = this._receiveTask;
    const oldPromptName = this._promptName;
    const oldInputAudioContentName = this._inputAudioContentName;

    const nextSession = await this._sc.executeHandoff();
    if (!nextSession) {
      return;
    }

    // Swap in the new session's stream and names. The helper already sent
    // sessionStart, promptStart, system instruction, conversation history,
    // audioInputStart, and buffered audio to the new stream.
    this._client = nextSession.client;
    this._stream = nextSession.stream;
    this._promptName = nextSession.promptName;
    this._inputAudioContentName = nextSession.inputAudioContentName;
    this._connectedTime = time();
    this._audioInputStarted = true;

    // Start the main receive loop on the new stream (bound to that stream)
    const stream = this._stream;
    this._receiveTask = this.createTask(
      () => this._receiveTaskHandler(stream),
      "receive_task_handler",
    );

    // Update the helper's connected time so the threshold timer restarts
    this._sc.setConnected(this._connectedTime);

    logger.info("Session continuation: swap complete, closing old session in background");

    // Close the old session in the background — do not block the pipeline
    this.createTask(
      () =>
        this._sc.closeOldSession(
          oldClient,
          oldStream,
          oldReceiveTask,
          oldPromptName,
          oldInputAudioContentName,
        ),
      "sc_close_old_session",
    );
  }

  //
  // LLM communication: output events (LLM -> pipecat)
  //

  // Receive events for the session.
  // A few different kinds of content can be delivered:
  // - Transcription of user audio
  // - Tool use
  // - Text preview of planned response speech before audio delivered
  // - User interruption notification
  // - Text of response speech that whose audio was actually delivered
  // - Audio of response speech
  // Each piece of content is wrapped by "contentStart" and "contentEnd" events. The content is
  // delivered sequentially: one piece of content will end before another starts.
  // The overall completion is wrapped by "completionStart" and "completionEnd" events.
  protected async _receiveTaskHandler(stream: BidirectionalStream | null = null): Promise<void> {
    // Bind to the specific stream given at creation time.
    // Do NOT re-read `this._stream` in the loop — during a session
    // continuation handoff, `this._stream` gets swapped to a new session,
    // and reading from the wrong stream here would cause two receive loops
    // to compete on the same stream.
    const boundStream = stream ?? this._stream;
    try {
      while (boundStream && !this._disconnecting) {
        const result = await boundStream.receive();

        // After a session continuation handoff, this receive task
        // is stale — stop processing events so closeOldSession
        // can drain the stream without interference.
        if (boundStream !== this._stream) {
          return;
        }

        if (result === null) {
          // The service has no more events to send. Our own disconnect
          // and a session-continuation handoff are both handled above,
          // so reaching here means the stream ended while we still
          // wanted it: reconnect via the handler below.
          throw new Error("AWS Bedrock ended the response stream");
        }

        if (result.length > 0) {
          const responseData = decoder.decode(result);
          const jsonData = JSON.parse(responseData) as Dict;

          if ("event" in jsonData) {
            const eventJson = jsonData.event as Dict;
            if ("completionStart" in eventJson) {
              // Handle the LLM completion starting
              await this._handleCompletionStartEvent(eventJson);
            } else if ("contentStart" in eventJson) {
              // Handle a piece of content starting
              await this._handleContentStartEvent(eventJson);
            } else if ("textOutput" in eventJson) {
              // Handle text output content
              await this._handleTextOutputEvent(eventJson);
            } else if ("audioOutput" in eventJson) {
              // Handle audio output content
              await this._handleAudioOutputEvent(eventJson);
            } else if ("toolUse" in eventJson) {
              // Handle tool use
              await this._handleToolUseEvent(eventJson);
            } else if ("contentEnd" in eventJson) {
              // Handle a piece of content ending
              await this._handleContentEndEvent(eventJson);
            } else if ("completionEnd" in eventJson) {
              // Handle the LLM completion ending
              await this._handleCompletionEndEvent(eventJson);
            } else if ("usageEvent" in eventJson) {
              // Handle token usage reporting
              await this._handleUsageEvent(eventJson);
            }
          }
        }
      }
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      if (this._disconnecting) {
        return;
      }
      // If this receive task is for a stale (old) stream that was replaced
      // by a session continuation handoff, don't reset the conversation —
      // the new session is already active on this._stream.
      if (boundStream !== this._stream) {
        logger.debug(`Session continuation: old receive task error (expected): ${errorText(e)}`);
        return;
      }
      await this.pushError(`Error processing responses: ${errorText(e)}`, { exception: e });
      if (this._wantsConnection) {
        await this.resetConversation();
      }
    }
  }

  protected async _handleCompletionStartEvent(_eventJson: Dict): Promise<void> {}

  protected async _handleContentStartEvent(eventJson: Dict): Promise<void> {
    const contentStart = eventJson.contentStart as Dict;
    const type = contentStart.type as ContentType;
    const role = contentStart.role as Role;
    let generationStage: TextStage | null = null;
    if ("additionalModelFields" in contentStart) {
      const additionalModelFields = JSON.parse(contentStart.additionalModelFields) as Dict;
      generationStage = (additionalModelFields.generationStage as TextStage | undefined) ?? null;
    }

    // Bookkeeping: track current content being received
    const content = new CurrentContent({
      type: checkEnum(ContentType, type, "ContentType"),
      role: checkEnum(Role, role, "Role"),
      textStage: generationStage ? checkEnum(TextStage, generationStage, "TextStage") : null,
      textContent: null,
    });
    this._contentBeingReceived = content;

    if (content.role === Role.ASSISTANT) {
      if (content.type === ContentType.TEXT) {
        if (content.textStage === TextStage.SPECULATIVE && !this._assistantIsResponding) {
          this._assistantIsResponding = true;
          await this._reportUserTranscriptionEnded(); // Consider user turn over
          await this._reportAssistantResponseStarted();
        }
      } else if (content.type === ContentType.AUDIO) {
        // Session continuation: AUDIO contentStart from assistant is the
        // trigger to start buffering user audio and creating the next session
        // (if we're past the threshold).
        await this._sc.onAssistantAudioStarted();
      }
    } else if (content.role === Role.USER) {
      // Session continuation: USER contentStart during a forced transition
      // (no assistant response yet) should complete the handoff immediately.
      if (this._sc.onUserContentStarted()) {
        this.createTask(() => this._runScHandoff(), "sc_handoff");
      }
    }
  }

  protected async _handleTextOutputEvent(eventJson: Dict): Promise<void> {
    if (!this._contentBeingReceived) {
      // should never happen
      return;
    }
    const content = this._contentBeingReceived;

    const textContent = eventJson.textOutput.content as string;

    // Bookkeeping: augment the current content being received with text
    // Assumption: only one text content per content block
    content.textContent = textContent;

    // Session continuation: track speculative/final text counts for completion signal
    this._sc.onTextOutput(content.role, content.textStage);
  }

  protected async _handleAudioOutputEvent(eventJson: Dict): Promise<void> {
    if (!this._contentBeingReceived) {
      // should never happen
      return;
    }

    // Get audio
    const audioContent = eventJson.audioOutput.content as string;

    // Push audio frame
    const audio = base64ToBytes(audioContent);
    const frame = new TTSAudioRawFrame({
      audio,
      sampleRate: this._audioConfig.outputSampleRate,
      numChannels: this._audioConfig.outputChannelCount,
    });
    await this.pushFrame(frame);
  }

  protected async _handleToolUseEvent(eventJson: Dict): Promise<void> {
    if (!this._contentBeingReceived || !this._context) {
      // should never happen
      return;
    }

    // Consider user turn over
    await this._reportUserTranscriptionEnded();

    // Get tool use details
    const toolUse = eventJson.toolUse as Dict;
    const functionName = toolUse.toolName as string;
    const toolCallId = toolUse.toolUseId as string;
    const args = JSON.parse(toolUse.content) as Record<string, unknown>;

    // Call tool function
    if (this.hasFunction(functionName)) {
      if (this._functions.has(functionName) || this._functions.has(null)) {
        const functionCallsLlm = [
          new FunctionCallFromLLM({
            context: this._context,
            toolCallId,
            functionName,
            arguments: args,
          }),
        ];

        await this.runFunctionCalls(functionCallsLlm);
      }
    } else {
      throw new AWSNovaSonicUnhandledFunctionException(
        `The LLM tried to call a function named '${functionName}', but there isn't a callback registered for that function.`,
      );
    }
  }

  protected async _handleContentEndEvent(eventJson: Dict): Promise<void> {
    if (!this._contentBeingReceived) {
      // should never happen
      return;
    }
    const content = this._contentBeingReceived;

    const contentEnd = eventJson.contentEnd as Dict;
    const stopReason = contentEnd.stopReason as string;

    // Bookkeeping: clear current content being received
    this._contentBeingReceived = null;

    if (content.role === Role.ASSISTANT) {
      if (content.type === ContentType.TEXT) {
        if (stopReason !== "INTERRUPTED") {
          if (content.textStage === TextStage.SPECULATIVE) {
            await this._reportLlmText(content.textContent);
          }
          // Session continuation: ASSISTANT FINAL text — add to history
          // and check for completion signal (speculative/final counts match)
          if (content.textStage === TextStage.FINAL) {
            if (this._sc.onContentEndAssistantFinalText(content.textContent)) {
              this.createTask(() => this._runScHandoff(), "sc_handoff");
            }
          }
        } else {
          // FINAL TEXT INTERRUPTED is the canonical barge-in
          // signal. The AUDIO branch usually closed the
          // response already (AUDIO contentEnd arrives with
          // END_TURN on barge-in, before this), but the
          // output transport's audio buffer is still draining
          // — broadcast unconditionally to clear it.
          await this.broadcastInterruption();
          if (this._assistantIsResponding) {
            // No AUDIO contentEnd will arrive — close here.
            this._assistantIsResponding = false;
            await this._reportAssistantResponseEnded();
          }
          // Session continuation: TEXT INTERRUPTED is a completion
          // signal regardless of audio state (reference lines 650-654)
          if (this._sc.onContentEndTextInterrupted()) {
            this.createTask(() => this._runScHandoff(), "sc_handoff");
          }
        }
      } else if (content.type === ContentType.AUDIO) {
        // Emit deferred TTSTextFrame after all audio chunks have been sent
        await this._reportTtsText();
        if (stopReason === "END_TURN" || stopReason === "INTERRUPTED") {
          // END_TURN: normal completion. INTERRUPTED: user interrupted
          // mid-audio. Both mean no more audio for this turn.
          if (stopReason === "INTERRUPTED") {
            // Emit InterruptionFrame upstream so the assistant
            // aggregator marks the message interrupted=True, and
            // downstream so BaseOutputTransport clears the audio
            // buffer (without this the bot keeps talking past the
            // interruption while the buffer drains, since Nova
            // Sonic doesn't surface server-side interruption any
            // other way). Must fire before
            // _reportAssistantResponseEnded so the aggregator
            // handles InterruptionFrame before LLMFullResponseEndFrame
            // closes the turn.
            await this.broadcastInterruption();
          }
          this._assistantIsResponding = false;
          await this._reportAssistantResponseEnded();
        }
      }
    } else if (content.role === Role.USER) {
      if (content.type === ContentType.TEXT) {
        if (content.textStage === TextStage.FINAL) {
          // User transcription text added
          await this._reportUserTranscriptionTextAdded(content.textContent);
          // Session continuation: add to real-time history
          this._sc.onContentEndUserFinalText(content.textContent);
        }
      }
    }
  }

  protected async _handleCompletionEndEvent(_eventJson: Dict): Promise<void> {
    // Session continuation: completionEnd is a fallback completion signal
    if (this._sc.onCompletionEnd()) {
      this.createTask(() => this._runScHandoff(), "sc_handoff");
    }
  }

  protected async _handleUsageEvent(eventJson: Dict): Promise<void> {
    // Nova Sonic reports incremental token usage in details.delta, split into
    // speech/text buckets for input and output. We report the delta (not the
    // cumulative details.total) so usage stays incremental per event, matching
    // the convention of the other speech-to-speech services. Pipecat's
    // LLMTokenUsage does not separate modalities, so collapse speech + text
    // into prompt/completion totals.
    const delta = (eventJson.usageEvent as Dict).details?.delta ?? {};
    const inputTokens = (delta.input ?? {}) as Dict;
    const outputTokens = (delta.output ?? {}) as Dict;
    const promptTokens = (inputTokens.speechTokens ?? 0) + (inputTokens.textTokens ?? 0);
    const completionTokens = (outputTokens.speechTokens ?? 0) + (outputTokens.textTokens ?? 0);
    if (promptTokens || completionTokens) {
      const tokens = new LLMTokenUsage({
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      });
      await this.startLlmUsageMetrics(tokens);
    }
  }

  //
  // assistant response reporting
  //
  // 1. Started
  // 2. Text added
  // 3. Ended
  //

  protected async _reportAssistantResponseStarted(): Promise<void> {
    logger.debug("Assistant response started");
    await this.pushFrame(new LLMFullResponseStartFrame());

    // Report that equivalent of TTS (this is a speech-to-speech model) started
    await this.pushFrame(new TTSStartedFrame());
  }

  /**
   * Push speculative assistant text and defer TTSTextFrame.
   *
   * Speculative text arrives before each audio chunk, providing real-time
   * text that is synchronized with what the bot is saying. LLMTextFrame and
   * AggregatedTextFrame are pushed immediately for real-time text display.
   * TTSTextFrame emission is deferred to audio contentEnd so it aligns with
   * audio playout timing.
   */
  protected async _reportLlmText(text: string | null): Promise<void> {
    logger.debug(`Assistant speculative text: ${text}`);

    const llmTextFrame = new LLMTextFrame({ text: text ?? "" });
    llmTextFrame.appendToContext = false;
    await this.pushFrame(llmTextFrame);

    const aggregatedTextFrame = new AggregatedTextFrame({
      text: text ?? "",
      textType: TextType.SENTENCE,
    });
    aggregatedTextFrame.appendToContext = false;
    await this.pushFrame(aggregatedTextFrame);

    this._pendingSpeculativeText = text;
  }

  protected async _reportTtsText(): Promise<void> {
    if (this._pendingSpeculativeText) {
      const ttsTextFrame = new TTSTextFrame({
        text: this._pendingSpeculativeText,
        textType: TextType.SENTENCE,
      });
      ttsTextFrame.includesInterFrameSpaces = true;
      await this.pushFrame(ttsTextFrame);
      this._pendingSpeculativeText = null;
    }
  }

  protected async _reportAssistantResponseEnded(): Promise<void> {
    if (!this._context) {
      // should never happen
      return;
    }

    logger.debug("Assistant response ended");

    // Report the end of the assistant response.
    await this.pushFrame(new LLMFullResponseEndFrame());

    // Report that equivalent of TTS (this is a speech-to-speech model) stopped.
    await this.pushFrame(new TTSStoppedFrame());
  }

  //
  // user transcription reporting
  //
  // 1. Text added
  // 2. Ended
  //
  // Note: "started" does not need to be reported
  //

  protected async _reportUserTranscriptionTextAdded(text: string | null): Promise<void> {
    if (!this._context) {
      // should never happen
      return;
    }

    logger.debug(`User transcription text added: ${text}`);

    // HACK: here we're buffering the user text ourselves rather than
    // relying on the upstream user context aggregator to do it, because the
    // text arrives in fairly large chunks spaced fairly far apart in time.
    // That means the user text would be split between different messages in
    // context. Even if we sent placeholder InterimTranscriptionFrames in
    // between each TranscriptionFrame to tell the aggregator to hold off on
    // finalizing the user message, the aggregator would likely get the last
    // chunk too late.
    this._userTextBuffer += this._userTextBuffer ? ` ${text}` : (text ?? "");
  }

  protected async _reportUserTranscriptionEnded(): Promise<void> {
    if (!this._context) {
      // should never happen
      return;
    }

    // Nothing to report if no user speech was transcribed (e.g. the prompt
    // was text-only, which is the case on the first user turn when the bot
    // starts the conversation).
    if (!this._userTextBuffer) {
      return;
    }

    logger.debug("User transcription ended");

    // Report to the upstream user context aggregator that some new user
    // transcription text is available.

    // HACK: Check if this transcription was triggered by our own
    // assistant response trigger. If so, we need to wrap it with
    // UserStarted/StoppedSpeakingFrames; otherwise the user aggregator
    // would trigger an interruption, which would prevent us from
    // writing the assistant response to context.
    const shouldWrapInUserStartedStoppedSpeakingFrames =
      this._waitingForTriggerTranscription && this._userTextBuffer.trim().toLowerCase() === "ready";

    // Start wrapping the upstream transcription in UserStarted/StoppedSpeakingFrames if needed
    if (shouldWrapInUserStartedStoppedSpeakingFrames) {
      logger.debug(
        "Wrapping assistant response trigger transcription with upstream UserStarted/StoppedSpeakingFrames",
      );
      await this.broadcastFrame(UserStartedSpeakingFrame);
    }

    // Send the transcription upstream for the user context aggregator
    const frame = new TranscriptionFrame({
      text: this._userTextBuffer,
      userId: "",
      timestamp: timeNowIso8601(),
    });
    await this.pushFrame(frame, FrameDirection.UPSTREAM);

    // Finish wrapping the upstream transcription in UserStarted/StoppedSpeakingFrames if needed
    if (shouldWrapInUserStartedStoppedSpeakingFrames) {
      await this.broadcastFrame(UserStoppedSpeakingFrame);
    }

    // Clear out the buffered user text
    this._userTextBuffer = "";

    // We're no longer waiting for a trigger transcription
    this._waitingForTriggerTranscription = false;
  }

  //
  // assistant response trigger
  // HACK: only needed for the older Nova Sonic (as opposed to Nova 2 Sonic) model
  //

  /**
   * Trigger an assistant response by sending audio cue.
   *
   * Sends a pre-recorded "ready" audio trigger to prompt the assistant
   * to start speaking. This is useful for controlling conversation flow.
   */
  async triggerAssistantResponse(): Promise<void> {
    if (!this._isAssistantResponseTriggerNeeded()) {
      logger.warning(
        `Assistant response trigger not needed for model '${String(this._settings.model)}'; skipping. ` +
          "An LLMRunFrame() should be sufficient to prompt the assistant to respond, " +
          "assuming the context ends in a user message.",
      );
      return;
    }

    if (this._triggeringAssistantResponse) {
      return;
    }

    this._triggeringAssistantResponse = true;

    // Send the trigger audio, if we're fully connected and set up
    if (this._connectedTime) {
      await this._sendAssistantResponseTrigger();
    }
  }

  protected async _sendAssistantResponseTrigger(): Promise<void> {
    if (!this._connectedTime) {
      // should never happen
      return;
    }

    try {
      logger.debug("Sending assistant response trigger...");

      this._waitingForTriggerTranscription = true;

      const chunkDuration = 0.02; // what we might get from InputAudioRawFrame
      const chunkSize = Math.trunc(
        chunkDuration *
          this._audioConfig.inputSampleRate *
          this._audioConfig.inputChannelCount *
          (this._audioConfig.inputSampleSize / 8),
      ); // e.g. 0.02 seconds of 16-bit (2-byte) PCM mono audio at 16kHz is 640 bytes

      // Lead with a bit of blank audio, if needed.
      // It seems like the LLM can't quite "hear" the first little bit of audio sent on a
      // connection.
      const currentTime = time();
      const maxBlankAudioDuration = 0.5;
      const blankAudioDuration =
        this._connectedTime !== null && currentTime - this._connectedTime < maxBlankAudioDuration
          ? maxBlankAudioDuration - (currentTime - this._connectedTime)
          : null;
      if (blankAudioDuration) {
        logger.debug(
          `Leading assistant response trigger with ${blankAudioDuration}s of blank audio`,
        );
        const blankAudioChunk = new Uint8Array(chunkSize);
        const numChunks = Math.trunc(blankAudioDuration / chunkDuration);
        for (let i = 0; i < numChunks; i++) {
          await this._sendUserAudioEvent(blankAudioChunk);
          await sleep(chunkDuration);
        }
      }

      // Send trigger audio
      // NOTE: this audio *will* be transcribed and eventually make it into the context. That's OK:
      // if we ever need to seed this service again with context it would make sense to include it
      // since the instruction (i.e. the "wait for the trigger" instruction) will be part of the
      // context as well.
      const audio = this._assistantResponseTriggerAudio;
      for (let i = 0; i < audio.length; i += chunkSize) {
        await this._sendUserAudioEvent(audio.subarray(i, i + chunkSize));
        await sleep(chunkDuration);
      }
    } finally {
      // We need to clean up in case sending the trigger was cancelled, e.g. in the case of a user interruption.
      // (A CancelledError would be raised in that case.)
      this._triggeringAssistantResponse = false;
    }
  }
}

/** Python's `str()` of a settings number (`0.7`, `1024`, `None`). */
function pyValue(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "number") return pyJsonDumps(value);
  return String(value);
}

function checkEnum<T extends Record<string, string>>(
  e: T,
  value: string,
  name: string,
): T[keyof T] {
  if (!Object.values(e).includes(value)) {
    throw new Error(`'${value}' is not a valid ${name}`);
  }
  return value as T[keyof T];
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
