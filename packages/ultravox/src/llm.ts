// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/ultravox/llm.py

/**
 * Ultravox Realtime API service implementation.
 *
 * This module provides real-time conversational AI capabilities using
 * Ultravox's Realtime API, supporting both text and audio modalities with
 * voice transcription, streaming responses, and tool usage.
 *
 * Porting notes:
 * - The pydantic params models (`AgentInputParams`, `OneShotInputParams`,
 *   `JoinUrlInputParams`) are classes with options constructors. Their range
 *   checks (`max_duration`, `temperature`) raise `RangeError`.
 * - `datetime.timedelta` durations are seconds (`maxDuration`), as everywhere
 *   in pipedog; `uuid.UUID` ids are strings.
 * - Calls are created with `fetch` (upstream: aiohttp) and joined with core's
 *   `websocketConnect` (the global `WebSocket`, or `fetch` on Workers), so the
 *   service runs on every runtime.
 */

import { rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import type { DirectFunction } from "@pipedog/core/adapters/schemas/direct_function";
import type { FunctionSchema } from "@pipedog/core/adapters/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import { createStreamResampler } from "@pipedog/core/audio/utils";
import {
  type CancelFrame,
  type EndFrame,
  type Frame,
  FunctionCallFromLLM,
  FunctionCallResultFrame,
  InputAudioRawFrame,
  InputTextRawFrame,
  InterruptionFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMServiceMetadataFrame,
  LLMTextFrame,
  type StartFrame,
  TextType,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
  UserAudioRawFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import * as asyncToolMessages from "@pipedog/core/processors/aggregators/async_tool_messages";
import { LLMContext, LLMSpecificMessage } from "@pipedog/core/processors/aggregators/llm_context";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import {
  LLMService,
  type LLMServiceOptions,
  type LLMWithBackendRole,
} from "@pipedog/core/services/llm_service";
import { LLMSettings, type LLMSettingsOptions } from "@pipedog/core/services/settings";
import {
  ConnectionClosed,
  type WebsocketClientConnection,
  websocketConnect,
} from "@pipedog/core/services/websocket_service";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

// Result shipped as the client_tool_result when we see an async-tool
// "started" message — i.e. when an async-registered function call
// (cancel_on_interruption=False) is invoked. Sending it immediately
// unfreezes the conversation so the model can keep talking while the
// real tool runs; the actual result is injected later as user-side text
// once the tool finishes.
export const _ASYNC_TOOL_STARTED_RESULT =
  "The actual result for this tool call is not yet ready. A follow-up " +
  "message will arrive shortly with the actual result. In the meantime, " +
  "keep the conversation going naturally.";

// Template for the user-side text we inject when the async-tool "final"
// message arrives. Bracketed framing helps the model treat this as a
// tool-result update rather than fresh user input.
export const _ASYNC_TOOL_FINAL_RESULT_TEMPLATE =
  "[Async tool result for tool_call_id={tool_call_id}] {result}";

// Template for the user-side text we inject when an intermediate result
// arrives: the same framing as the final one, saying the task is still running.
export const _ASYNC_TOOL_PROGRESS_TEMPLATE =
  "[Async tool progress for tool_call_id={tool_call_id}, still running] {result}";

const ULTRAVOX_API_BASE_URL = "https://api.ultravox.ai";

/** Python's `str.format` for the templates above. */
function formatTemplate(template: string, toolCallId: string, result: string): string {
  return template.replace("{tool_call_id}", toolCallId).replace("{result}", result);
}

/** Python truthiness, for `x if value else y`. */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value).length > 0;
  }
  return true;
}

/** `f"{seconds:3f}s"`: a duration string as the Ultravox API takes it. */
function formatDuration(seconds: number): string {
  return `${seconds.toFixed(6)}s`;
}

function checkMaxDuration(seconds: number, model: string): void {
  if (seconds < 10 || seconds > 3600) {
    throw new RangeError(`${model}: maxDuration must be between 10 seconds and 1 hour`);
  }
}

export interface UltravoxRealtimeLLMSettingsOptions extends LLMSettingsOptions {
  /** The output medium for the model ("voice" or "text"). */
  outputMedium?: string | null | NotGiven;
}

/**
 * Settings for UltravoxRealtimeLLMService.
 *
 * - `outputMedium`: the output medium for the model ("voice" or "text").
 */
export class UltravoxRealtimeLLMSettings extends LLMSettings {
  outputMedium: string | null | NotGiven = NOT_GIVEN;

  constructor(options: UltravoxRealtimeLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface AgentInputParamsOptions {
  /** Ultravox API key for authentication. */
  apiKey: string;
  /**
   * The ID of the Ultravox Realtime agent you'd like to use. Agents are
   * pre-configured to handle calls consistently. You can create and edit
   * agents in the Ultravox console (https://app.ultravox.ai/agents) or using
   * the Ultravox API (https://docs.ultravox.ai/api-reference/agents/agents-post).
   */
  agentId: string;
  /** Context variables to use when instantiating a call with the agent. Defaults to `{}`. */
  templateContext?: Record<string, unknown>;
  /** Metadata to attach to the call. Defaults to `{}`. */
  metadata?: Record<string, string>;
  /**
   * The initial output medium for the agent. Use "text" for text responses or
   * "voice" for audio responses. Defaults to null, which uses the agent's default.
   */
  outputMedium?: "text" | "voice" | null;
  /**
   * The maximum duration of the call, in seconds (10 s to 1 h). Defaults to
   * null, which uses the agent's default maximum duration.
   */
  maxDuration?: number | null;
  /**
   * Extra parameters to include in the agent call creation request. Defaults
   * to `{}`. See the Ultravox API documentation for valid arguments:
   * https://docs.ultravox.ai/api-reference/agents/agents-calls-post
   */
  extra?: Record<string, unknown>;
}

/** Input parameters for Ultravox Realtime generation using a pre-defined Agent. */
export class AgentInputParams {
  apiKey: string;
  agentId: string;
  templateContext: Record<string, unknown>;
  metadata: Record<string, string>;
  outputMedium: "text" | "voice" | null;
  maxDuration: number | null;
  extra: Record<string, unknown>;

  constructor(options: AgentInputParamsOptions) {
    this.apiKey = options.apiKey;
    this.agentId = options.agentId;
    this.templateContext = options.templateContext ?? {};
    this.metadata = options.metadata ?? {};
    this.outputMedium = options.outputMedium ?? null;
    this.maxDuration = options.maxDuration ?? null;
    if (this.maxDuration !== null) checkMaxDuration(this.maxDuration, "AgentInputParams");
    this.extra = options.extra ?? {};
  }
}

export interface OneShotInputParamsOptions {
  /** Ultravox API key for authentication. */
  apiKey: string;
  /** System prompt to guide the model's behavior. Defaults to null. */
  systemPrompt?: string | null;
  /** Sampling temperature for response generation (0 to 1). Defaults to 0. */
  temperature?: number;
  /**
   * Model identifier to use, e.g. "ultravox-v0.7". Defaults to null, which
   * lets Ultravox pick its current default model.
   */
  model?: string | null;
  /** Voice identifier for speech generation. Defaults to null. */
  voice?: string | null;
  /** Metadata to attach to the call. Defaults to `{}`. */
  metadata?: Record<string, string>;
  /**
   * The initial output medium for the agent. Use "text" for text responses or
   * "voice" for audio responses. Defaults to null (voice).
   */
  outputMedium?: "text" | "voice" | null;
  /** The maximum duration of the call, in seconds (10 s to 1 h). Defaults to one hour. */
  maxDuration?: number;
  /**
   * Extra parameters to include in the call creation request. Defaults to
   * `{}`. See the Ultravox API documentation for valid arguments:
   * https://docs.ultravox.ai/api-reference/calls/calls-post
   */
  extra?: Record<string, unknown>;
}

/** Input parameters for Ultravox Realtime generation using a one-off call. */
export class OneShotInputParams {
  apiKey: string;
  systemPrompt: string | null;
  temperature: number;
  model: string | null;
  voice: string | null;
  metadata: Record<string, string>;
  outputMedium: "text" | "voice" | null;
  maxDuration: number;
  extra: Record<string, unknown>;

  constructor(options: OneShotInputParamsOptions) {
    this.apiKey = options.apiKey;
    this.systemPrompt = options.systemPrompt ?? null;
    this.temperature = options.temperature ?? 0.0;
    if (this.temperature < 0 || this.temperature > 1) {
      throw new RangeError("OneShotInputParams: temperature must be between 0 and 1");
    }
    this.model = options.model ?? null;
    this.voice = options.voice ?? null;
    this.metadata = options.metadata ?? {};
    this.outputMedium = options.outputMedium ?? null;
    this.maxDuration = options.maxDuration ?? 3600;
    checkMaxDuration(this.maxDuration, "OneShotInputParams");
    this.extra = options.extra ?? {};
  }
}

export interface JoinUrlInputParamsOptions {
  /** The join URL for the existing Ultravox Realtime call. */
  joinUrl: string;
}

/** Input parameters for joining an existing Ultravox Realtime call via join URL. */
export class JoinUrlInputParams {
  joinUrl: string;

  constructor(options: JoinUrlInputParamsOptions) {
    this.joinUrl = options.joinUrl;
  }
}

export interface UltravoxRealtimeLLMServiceOptions extends LLMServiceOptions {
  /** Configuration parameters for the model. */
  params: AgentInputParams | OneShotInputParams | JoinUrlInputParams;
  /**
   * Ultravox Realtime LLM settings. If provided, the `settings` values take
   * precedence over default values.
   */
  settings?: UltravoxRealtimeLLMSettings | null;
  /**
   * Tools to use with this call: a `ToolsSchema` or a plain list of direct
   * functions and/or `FunctionSchema` objects (handlers auto-register). May
   * only be set with `OneShotInputParams`.
   */
  oneShotSelectedTools?: ToolsSchema | (FunctionSchema | DirectFunction)[] | null;
}

/**
 * Provides access to the Ultravox Realtime API.
 *
 * This service enables real-time conversations with Ultravox, supporting both
 * text and audio output. It handles voice transcription, streaming audio
 * responses, and tool usage.
 *
 * Note: Ultravox is an audio-native model, so voice transcriptions are not
 * used by the model and may not always align with its understanding of user
 * input.
 *
 * Does NOT emit `UserStartedSpeakingFrame` / `UserStoppedSpeakingFrame`, so
 * pipeline processors that depend on those frames — RTVI client speech
 * events, `TurnTrackingObserver`, `AudioBufferProcessor` turn recording,
 * `UserIdleController`, user mute strategies, voicemail detector — won't
 * activate with the default server-VAD-only setup. `LLMContextAggregatorPair`
 * auto-detects this realtime service so context writes are correct anyway.
 * To produce the turn frames locally, wire `vadAnalyzer: new
 * SileroVADAnalyzer()` (or similar) into `LLMUserAggregatorParams`;
 * locally-generated turn boundaries are a heuristic and may not match
 * Ultravox's server-side turn decisions.
 */
export class UltravoxRealtimeLLMService extends LLMService {
  static Settings = UltravoxRealtimeLLMSettings;
  declare protected _settings: UltravoxRealtimeLLMSettings;

  protected _params: AgentInputParams | OneShotInputParams | JoinUrlInputParams;
  protected _selectedTools: ToolsSchema | null = null;
  protected _socket: WebsocketClientConnection | null = null;
  protected _receiveTask: Task<unknown> | null = null;
  protected _disconnecting = false;
  protected _botResponding: "text" | "voice" | null = null;
  protected _lastUserId: string | null = null;
  protected _completedToolCalls = new Set<string>();
  // Tracks tool_call_ids for which we've already shipped the
  // async-tool placeholder client_tool_result that unfreezes the
  // conversation while the real tool runs. See _handleToolInvocation.
  protected _startedPlaceholderSent = new Set<string>();

  protected _sampleRate = 48000;
  protected _resampler = createStreamResampler();

  /** Realtime service; emits no server-side turn frames, so recommends no external strategies. */
  override serviceMetadataFrame(): LLMServiceMetadataFrame {
    this._warnIfRealtimeServiceEmitsNoTurnFrames(false);
    return new LLMServiceMetadataFrame({ serviceName: this.name, isRealtimeService: true });
  }

  /**
   * Initialize the Ultravox Realtime LLM service.
   *
   * @param options.params Configuration parameters for the model.
   * @param options.settings Ultravox Realtime LLM settings. If provided, the
   *   `settings` values take precedence over default values.
   * @param options.oneShotSelectedTools Tools to use with this call. May only
   *   be set with `OneShotInputParams`.
   *   Other options are passed to the parent LLMService.
   */
  constructor(options: UltravoxRealtimeLLMServiceOptions) {
    const cls = new.target as typeof UltravoxRealtimeLLMService;
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({
      model: null,
      systemInstruction: null,
      temperature: null,
      maxTokens: null,
      topP: null,
      topK: null,
      frequencyPenalty: null,
      presencePenalty: null,
      seed: null,
      filterIncompleteUserTurns: false,
      userTurnCompletionConfig: null,
      outputMedium: null,
    });

    // (No step 2/3 — params is required and not deprecated)

    // 4. Apply settings delta (canonical API, always wins)
    if (options.settings !== null && options.settings !== undefined) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, settings: defaultSettings });
    this._params = options.params;
    // Accept a plain list of standard tools as a convenience; normalize it to a
    // ToolsSchema so the rest of the service has a single form to handle.
    let oneShotSelectedTools: ToolsSchema | null | undefined = null;
    if (Array.isArray(options.oneShotSelectedTools)) {
      const normalized = LLMContext._normalizeAndValidateTools(options.oneShotSelectedTools);
      oneShotSelectedTools = normalized instanceof ToolsSchema ? normalized : null;
    } else {
      oneShotSelectedTools = options.oneShotSelectedTools;
    }
    if (oneShotSelectedTools) {
      if (!(this._params instanceof OneShotInputParams)) {
        logger.warning(
          "one_shot_selected_tools may only be set when using OneShotInputParams; ignoring.",
        );
      } else {
        this._selectedTools = oneShotSelectedTools;
      }
    }
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
  // standard AIService frame handling
  //

  /**
   * Start the service and establish connection.
   *
   * @param frame The start frame.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);

    try {
      let joinUrl: string;
      if (this._params instanceof JoinUrlInputParams) {
        joinUrl = this._params.joinUrl;
      } else if (this._params instanceof AgentInputParams) {
        joinUrl = await this._startAgentCall(this._params);
      } else {
        joinUrl = await this._startOneShotCall(this._params);
      }

      logger.info(`Joining Ultravox Realtime call via URL: ${joinUrl}`);
      this._socket = await websocketConnect(joinUrl);
      this._receiveTask = this.createTask(() => this._receiveMessages(), "_receive_messages");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError("Failed to connect to Ultravox", {
        exception: e,
        forceTreatAsPermanent: true,
      });
    }
  }

  static _outputMediumToApi(medium: "text" | "voice" | null): string | null {
    if (medium === "text") {
      return "MESSAGE_MEDIUM_TEXT";
    } else if (medium === "voice") {
      return "MESSAGE_MEDIUM_VOICE";
    }
    return null;
  }

  protected async _startAgentCall(params: AgentInputParams): Promise<string> {
    let requestBody: Record<string, unknown> = {
      templateContext: params.templateContext,
      metadata: params.metadata,
      medium: {
        serverWebSocket: {
          inputSampleRate: this._sampleRate,
        },
      },
    };
    const initialOutputMedium = UltravoxRealtimeLLMService._outputMediumToApi(params.outputMedium);
    if (initialOutputMedium) {
      requestBody.initialOutputMedium = initialOutputMedium;
    }
    if (params.maxDuration) {
      requestBody.maxDuration = formatDuration(params.maxDuration);
    }
    requestBody = { ...requestBody, ...params.extra };
    return await this._createCall(
      `${ULTRAVOX_API_BASE_URL}/api/agents/${params.agentId}/calls`,
      params.apiKey,
      requestBody,
    );
  }

  protected async _startOneShotCall(params: OneShotInputParams): Promise<string> {
    let requestBody: Record<string, unknown> = {
      systemPrompt: params.systemPrompt,
      temperature: params.temperature,
      model: params.model,
      voice: params.voice ? String(params.voice) : null,
      metadata: params.metadata,
      maxDuration: formatDuration(params.maxDuration),
      selectedTools: this._selectedTools ? this._toSelectedTools(this._selectedTools) : [],
      medium: {
        serverWebSocket: {
          inputSampleRate: this._sampleRate,
        },
      },
    };
    const initialOutputMedium = UltravoxRealtimeLLMService._outputMediumToApi(params.outputMedium);
    if (initialOutputMedium) {
      requestBody.initialOutputMedium = initialOutputMedium;
    }
    requestBody = { ...requestBody, ...params.extra };
    return await this._createCall(`${ULTRAVOX_API_BASE_URL}/api/calls`, params.apiKey, requestBody);
  }

  /** POST a call creation request and return the call's join URL. */
  protected async _createCall(
    url: string,
    apiKey: string,
    requestBody: Record<string, unknown>,
  ): Promise<string> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
      body: pyJsonDumps(requestBody),
    });
    if (response.status !== 201) {
      const errorText = await response.text();
      throw new Error(`Ultravox API error ${response.status}: ${errorText}`);
    }
    const data = pyJsonLoads(await response.text()) as Record<string, unknown>;
    return data.joinUrl as string;
  }

  _toSelectedTools(tool: ToolsSchema): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    for (const standardTool of tool.standardTools) {
      result.push({
        temporaryTool: {
          modelToolName: standardTool.name,
          description: standardTool.description,
          dynamicParameters: Object.entries(standardTool.properties).map(([k, v]) => ({
            name: k,
            location: "PARAMETER_LOCATION_BODY",
            schema: v,
            required: standardTool.required.includes(k),
          })),
          client: {},
        },
      });
    }
    return result;
  }

  /**
   * Stop the service and close connections.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the service and close connections.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /** Release resources held by the service. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._disconnect();
  }

  protected async _disconnect(): Promise<void> {
    this._disconnecting = true;
    if (this._socket) {
      await this._socket.close();
      this._socket = null;
    }
    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask, 1.0);
      this._receiveTask = null;
    }
    this._completedToolCalls = new Set();
    this._startedPlaceholderSent = new Set();
  }

  protected override async _updateSettings(delta: LLMSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if ("outputMedium" in changed) {
      await this._updateOutputMedium(assertGiven(this._settings.outputMedium));
    }
    this._warnUnhandledUpdatedSettings(Object.keys(changed).filter((k) => k !== "outputMedium"));
    return changed;
  }

  //
  // frame processing
  // StartFrame, StopFrame, CancelFrame implemented in base class
  //

  /** Return the `oneShotSelectedTools` configured at construction, if any. */
  protected override _serviceTools(): ToolsSchema | null {
    return this._selectedTools;
  }

  /** Decline the frontend role: built-in tools never reach an Ultravox session. */
  override llmWithBackendRoleObjection(role: LLMWithBackendRole): string | null {
    if (role === "frontend") {
      return (
        "UltravoxRealtimeLLMService cannot be an LLMWithBackend frontend: built-in " +
        "tools do not reach its session, so its model never sees the delegate tool"
      );
    }
    return null;
  }

  /**
   * Intermediate results reach the model as user-side text.
   *
   * A client tool takes one result, which Ultravox is given as soon as an
   * async call starts so the conversation isn't frozen; what the call
   * produces after that goes in as text (see `pushFrame`).
   */
  override get acceptsIntermediateFunctionCallResults(): boolean {
    return true;
  }

  /**
   * Push a frame, sending function call results to Ultravox on the way.
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
   * Send one result to Ultravox as it is produced.
   *
   * An intermediate result goes in as user-side text, urgent enough to speak
   * about when the result asks the model to run, and as context to draw on
   * otherwise. A final result settles the call — through the tool channel, or
   * as text when the call was already settled with the placeholder that
   * unfreezes an async one.
   */
  protected async _handleFunctionCallResult(frame: FunctionCallResultFrame): Promise<void> {
    const result = pyTruthy(frame.result)
      ? pyJsonDumps(frame.result, { ensureAscii: false })
      : "COMPLETED";
    const isFinal = frame.properties ? frame.properties.isFinal : true;

    if (!isFinal) {
      let runLlm = frame.properties ? frame.properties.runLlm : null;
      if (runLlm === null) {
        runLlm = frame.runLlm !== null ? frame.runLlm : true;
      }
      await this._sendUserText(
        formatTemplate(_ASYNC_TOOL_PROGRESS_TEMPLATE, frame.toolCallId, result),
        { urgency: runLlm ? "soon" : "later" },
      );
      return;
    }

    if (this._completedToolCalls.has(frame.toolCallId)) {
      return;
    }
    if (this._startedPlaceholderSent.has(frame.toolCallId)) {
      await this._sendAsyncToolResult(frame.toolCallId, result);
    } else {
      await this._sendToolResult(frame.toolCallId, result);
      this._completedToolCalls.add(frame.toolCallId);
    }
  }

  /**
   * Process incoming frames for the Ultravox Realtime service.
   *
   * @param frame The frame to process.
   * @param direction The frame processing direction.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof LLMContextFrame) {
      await this._handleContext(frame.context);
    } else if (frame instanceof InterruptionFrame) {
      await this.stopAllMetrics();
      await this.pushFrame(frame, direction);
    } else if (frame instanceof InputTextRawFrame) {
      await this._sendUserText(frame.text);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof InputAudioRawFrame) {
      await this._sendUserAudio(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof VADUserStoppedSpeakingFrame) {
      await this._handleVadUserStoppedSpeaking(frame);
      await this.pushFrame(frame, direction);
    } else {
      await this.pushFrame(frame, direction);
    }
  }

  protected async _handleContext(context: LLMContext): Promise<void> {
    // Ultravox handles all context server-side, so the only context we
    // need to handle here is function-call results.
    for (const message of context.getMessages()) {
      // LLMSpecificMessages are opaque provider-specific payloads, not
      // standard tool-result messages — skip them.
      if (message instanceof LLMSpecificMessage) {
        continue;
      }

      // Async-tool messages live alongside regular tool messages in the
      // context; detect and route them before the regular logic so we
      // don't try to send the async-tool envelope JSON as a tool result.
      const asyncPayload = asyncToolMessages.parseMessage(message);
      if (asyncPayload !== null) {
        if (asyncPayload.kind === "started") {
          // The placeholder client_tool_result that unfreezes the
          // conversation was already shipped from _handleToolInvocation
          // when the model issued the call. Nothing more to do here.
          continue;
        }
        if (asyncPayload.kind === "intermediate") {
          // Sent as text when it was produced.
          continue;
        }
        if (asyncPayload.kind === "final") {
          if (this._completedToolCalls.has(asyncPayload.toolCallId)) {
            continue;
          }
          await this._sendAsyncToolResult(asyncPayload.toolCallId, asyncPayload.result ?? "");
          continue;
        }
        // Defensive: any async-tool message must not fall through to the
        // regular tool-result block below, even if it carries a kind we
        // don't recognize.
        continue;
      }

      // Look for newly-completed "regular" (as opposed to async-tool) results
      const msg = message as unknown as Record<string, unknown>;
      if (msg.role === "tool" && msg.content !== "IN_PROGRESS") {
        const toolCallId = msg.tool_call_id as string | undefined;
        if (toolCallId && !this._completedToolCalls.has(toolCallId)) {
          const content = msg.content;
          const result =
            typeof content === "string"
              ? content
              : ((content as Record<string, unknown>[] | null | undefined) ?? [])
                  .map((t) => (t.text as string | undefined) ?? "")
                  .join("");
          if (this._startedPlaceholderSent.has(toolCallId)) {
            // An async call whose result arrived before the conversation
            // moved on settles in the context as an ordinary tool result,
            // but Ultravox has already been given the placeholder for it
            // and ignores a second client_tool_result, so the result still
            // has to go in as user-side text.
            await this._sendAsyncToolResult(toolCallId, result);
          } else {
            await this._sendToolResult(toolCallId, result);
            this._completedToolCalls.add(toolCallId);
          }
        }
      }
    }
  }

  /**
   * Deliver an async tool's actual result as user-side text.
   *
   * The placeholder client_tool_result has already completed the call from
   * Ultravox's perspective (see `_ASYNC_TOOL_FINAL_RESULT_TEMPLATE`).
   */
  protected async _sendAsyncToolResult(toolCallId: string, result: string): Promise<void> {
    await this._sendUserText(formatTemplate(_ASYNC_TOOL_FINAL_RESULT_TEMPLATE, toolCallId, result));
    this._completedToolCalls.add(toolCallId);
  }

  /** Send a tool call result to Ultravox. */
  protected async _sendToolResult(toolCallId: string, result: string): Promise<void> {
    logger.debug(`Sending tool result to Ultravox for tool_call_id=${toolCallId}`);
    await this._send({
      type: "client_tool_result",
      invocationId: toolCallId,
      result,
    });
  }

  /**
   * Handle VAD user stopped speaking frame.
   *
   * Calculates the actual speech end time and starts TTFB metrics from it,
   * to be stopped when the response starts.
   *
   * @param frame The VAD user stopped speaking frame.
   */
  protected async _handleVadUserStoppedSpeaking(frame: VADUserStoppedSpeakingFrame): Promise<void> {
    // Skip TTFB measurement if stop_secs is not set
    if (frame.stopSecs === 0.0) {
      return;
    }

    // Calculate the actual speech end time (current time minus VAD stop delay).
    // This approximates when the last user audio was sent to the Ultravox service,
    // which we use to measure against the eventual transcription response.
    const speechEndTime = frame.timestamp - frame.stopSecs;
    await this.startTtfbMetrics({ startTime: speechEndTime });
  }

  /** Send user audio frame to Ultravox Realtime. */
  protected async _sendUserAudio(frame: InputAudioRawFrame): Promise<void> {
    if (!this._socket) {
      return;
    }
    this._lastUserId = frame instanceof UserAudioRawFrame ? frame.userId : null;
    let audio = frame.audio;
    if (frame.sampleRate !== this._sampleRate) {
      audio = await this._resampler.resample(audio, frame.sampleRate, this._sampleRate);
    }
    await this._send(audio);
  }

  /**
   * Send user text via Ultravox Realtime.
   *
   * @param text The text to send as user input.
   * @param options.urgency When the agent should act on it — "soon" at the
   *   next opportunity, "later" on a reply it makes anyway, so the text is
   *   context rather than something to answer. Ultravox's own default
   *   applies when omitted.
   */
  protected async _sendUserText(
    text: string,
    options: { urgency?: string | null } = {},
  ): Promise<void> {
    if (!this._socket) {
      return;
    }
    const message: Record<string, unknown> = { type: "user_text_message", text };
    if (options.urgency) {
      message.urgency = options.urgency;
    }
    await this._send(message);
  }

  protected async _updateOutputMedium(outputMedium: string | null): Promise<void> {
    // Known quirk: null is the default but setting it back to null
    // doesn't actually take effect
    let medium = (outputMedium || "").toLowerCase();
    if (medium === "audio") {
      medium = "voice";
    }
    if (medium !== "voice" && medium !== "text") {
      logger.warning(`Unsupported Ultravox output medium: ${outputMedium}`);
      return;
    }
    await this._send({ type: "set_output_medium", medium });
  }

  /**
   * Send content via the WebSocket connection.
   *
   * @param content The content to send, either as bytes or a JSON-serializable object.
   */
  protected async _send(content: Uint8Array | Record<string, unknown>): Promise<void> {
    if (this._disconnecting || !this._socket) {
      return;
    }

    try {
      if (content instanceof Uint8Array) {
        await this._socket.send(content);
      } else {
        await this._socket.send(pyJsonDumps(content));
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (this._disconnecting || !this._socket) {
        return;
      }
      await this.pushError("Ultravox websocket send error", {
        exception: e,
        forceTreatAsPermanent: true,
      });
    }
  }

  //
  // response handling
  //

  /** Receive messages from the Ultravox Realtime WebSocket. */
  protected async _receiveMessages(): Promise<void> {
    if (!this._socket) {
      return;
    }
    try {
      for await (const message of this._socket) {
        try {
          if (message instanceof Uint8Array) {
            await this._handleAudio(message);
            continue;
          }

          const data = pyJsonLoads(message) as Record<string, any>;
          switch (data.type) {
            case "state":
              if (this._botResponding && data.state !== "speaking") {
                await this._handleResponseEnd();
              }
              break;
            case "playback_clear_buffer":
              // Server signals that the user interrupted the bot
              // mid-speech and any buffered output audio should be
              // dropped. Broadcast InterruptionFrame so the assistant
              // aggregator records the message interrupted=True
              // (upstream) and BaseOutputTransport clears its audio
              // buffer (downstream). The subsequent "state" message
              // transitioning off "speaking" is what closes the
              // response via _handleResponseEnd; firing the
              // interruption first ensures the aggregator handles
              // InterruptionFrame before LLMFullResponseEndFrame.
              await this.broadcastInterruption();
              break;
            case "client_tool_invocation":
              await this._handleToolInvocation(data.toolName, data.invocationId, data.parameters);
              break;
            case "transcript":
              switch (data.role) {
                case "user":
                  if (!data.final) {
                    logger.warning(
                      "Unexpected non-final user transcript from Ultravox Realtime; ignoring.",
                    );
                  } else {
                    await this._handleUserTranscript(data.text);
                  }
                  break;
                case "agent":
                  await this._handleAgentTranscript(
                    data.medium,
                    data.text ?? null,
                    data.delta ?? null,
                    data.final ?? false,
                  );
                  break;
                default:
                  logger.debug(
                    `Received transcript with unknown role from Ultravox Realtime: ${pyJsonDumps(data)}`,
                  );
              }
              break;
            default:
              logger.debug(`Received unhandled Ultravox message: ${pyJsonDumps(data)}`);
          }
        } catch (e) {
          rethrowIfCancelled(e);
          if (this._disconnecting || !this._socket) {
            return;
          }
          await this.pushError("Ultravox websocket receive error", {
            exception: e,
            forceTreatAsPermanent: true,
          });
        }
      }
    } catch (e) {
      if (e instanceof ConnectionClosed) {
        if (this._disconnecting || !this._socket) {
          return;
        }
      }
      throw e;
    }
  }

  /** Handle incoming audio bytes from Ultravox Realtime. */
  protected async _handleAudio(audio: Uint8Array): Promise<void> {
    if (audio.length === 0) {
      return;
    }
    if (!this._botResponding) {
      await this.startProcessingMetrics();
      await this.stopTtfbMetrics();
      await this.pushFrame(new LLMFullResponseStartFrame());
      await this.pushFrame(new TTSStartedFrame());
      this._botResponding = "voice";
    }
    await this.pushFrame(
      new TTSAudioRawFrame({ audio, sampleRate: this._sampleRate, numChannels: 1 }),
    );
  }

  protected async _handleResponseEnd(): Promise<void> {
    await this.stopProcessingMetrics();
    if (this._botResponding === "voice") {
      await this.pushFrame(new TTSStoppedFrame());
    }
    await this.pushFrame(new LLMFullResponseEndFrame());
    this._botResponding = null;
  }

  protected async _handleToolInvocation(
    toolName: string,
    invocationId: string,
    parameters: Record<string, unknown>,
  ): Promise<void> {
    // Ultravox freezes the conversation between client_tool_invocation
    // and the matching client_tool_result. For functions registered
    // with cancelOnInterruption=false the actual result won't be
    // available for some time, so ship a placeholder result now to
    // unfreeze the conversation. The real result will be injected
    // later as user-side text from _handleContext.
    if (this._functionIsAsync(toolName) && !this._startedPlaceholderSent.has(invocationId)) {
      await this._sendToolResult(invocationId, _ASYNC_TOOL_STARTED_RESULT);
      this._startedPlaceholderSent.add(invocationId);
    }

    await this.runFunctionCalls([
      new FunctionCallFromLLM({
        functionName: toolName,
        toolCallId: invocationId,
        arguments: parameters,
        context: null,
      }),
    ]);
  }

  protected async _handleUserTranscript(text: string): Promise<void> {
    await this.pushFrame(
      new TranscriptionFrame({
        userId: this._lastUserId || "",
        timestamp: timeNowIso8601(),
        result: text,
        text,
      }),
      FrameDirection.UPSTREAM,
    );
  }

  protected async _handleAgentTranscript(
    medium: string,
    text: string | null,
    delta: string | null,
    final: boolean,
  ): Promise<void> {
    const transcript = text || delta;
    if (medium === "voice") {
      // In voice mode, audio is handled by _handleAudio(). Here we push
      // text transcripts of the audio for downstream consumers.
      if (transcript && !final) {
        const frame = new LLMTextFrame({ text: transcript });
        frame.appendToContext = false;
        await this.pushFrame(frame);
      }
      if (delta) {
        const ttsFrame = new TTSTextFrame({ text: delta, textType: TextType.WORD });
        ttsFrame.includesInterFrameSpaces = true;
        await this.pushFrame(ttsFrame);
      }
    } else if (medium === "text") {
      if (final) {
        await this.stopProcessingMetrics();
        await this.pushFrame(new LLMFullResponseEndFrame());
        this._botResponding = null;
      } else if (transcript) {
        if (!this._botResponding) {
          await this.startProcessingMetrics();
          await this.stopTtfbMetrics();
          await this.pushFrame(new LLMFullResponseStartFrame());
          this._botResponding = "text";
        }
        await this.pushFrame(new LLMTextFrame({ text: transcript }));
      }
    }
  }
}
