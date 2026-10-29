// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/nvidia/omni/llm.py

/**
 * NVIDIA Nemotron Omni LLM service implementation.
 *
 * Nemotron Omni models accept speech, images, and video as well as text, and
 * reply with text. This service extends `NvidiaLLMService`, so reasoning
 * frames and every OpenAI-compatible behavior come from there unchanged, and
 * adds audio turns: in audio input mode, Omni buffers the user's speech between
 * turn boundaries and transcribes and answers it in a single request,
 * replacing the STT stage of a cascaded pipeline.
 *
 * Media in the context, built with `LLMContext.createAudioMessage()`,
 * `createImageMessage()`, or `createFileMessage()` for audio and video files,
 * is converted by `NvidiaOmniLLMAdapter` to the shape Omni reads.
 *
 * Refer to the model card for supported inputs and deployment options:
 * https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
 *
 * Porting notes:
 * - Upstream keeps the turn's content parts in a `ContextVar`, set only inside
 *   the task running a turn. There are no context variables in JS; the parts
 *   are kept per asyncio task (`currentTask()`) instead.
 *   DIVERGENCE: tasks created from a turn task do not inherit its parts, as a
 *   copied Python context would. Upstream clears them for one-shot inferences
 *   anyway (`_withoutTurnParts()`), so only the turn's own request sees them.
 * - Upstream builds the client with an httpx client carrying connection
 *   limits; `fetch` has no such object, so the SDK's own fetch is used. The
 *   request timeout is passed to the SDK in milliseconds.
 * - Upstream also reads reasoning from pydantic's `model_extra`. The JS SDK
 *   keeps unknown response fields on the object itself, so reading the field
 *   directly covers both.
 */

import {
  abortable,
  currentSignal,
  currentTask,
  rethrowIfCancelled,
  type Task,
  time,
  wait,
} from "@pipedog/asyncio";
import { LLMContextConversionError } from "@pipedog/core/adapters/llm/base_llm_adapter";
import type { OpenAILLMInvocationParams } from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import { pcmToWav } from "@pipedog/core/audio/utils";
import {
  type CancelFrame,
  type EndFrame,
  type Frame,
  InputAudioRawFrame,
  InterruptionFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMRunFrame,
  LLMServiceMetadataFrame,
  type StartFrame,
  TranscriptionFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import {
  LLMContext,
  type LLMContextMessage,
  LLMSpecificMessage,
  type LLMStandardMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { LLMService } from "@pipedog/core/services/llm_service";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { isTimeoutException } from "@pipedog/core/utils/http";
import { logger } from "@pipedog/core/utils/logger";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import type { OpenAIClientOptions, OpenAILLMSettingsOptions } from "@pipedog/openai/base_llm";
import OpenAI, { APIError, BadRequestError, UnprocessableEntityError } from "openai";
import { NvidiaLLMService, type NvidiaLLMServiceOptions, NvidiaLLMSettings } from "../llm.ts";
import { NvidiaOmniLLMAdapter } from "../nvidia_omni_adapter.ts";

type Dict = Record<string, any>;

export const DEFAULT_AUDIO_RESPONSE_INSTRUCTION =
  "Listen to the user's speech in the attached audio. First write exactly what the user " +
  "said inside <transcript>...</transcript>, then write your spoken reply inside " +
  "<response>...</response>.";

const _TOOL_RESULT_IN_PROGRESS = "IN_PROGRESS";

type _CompletionTrigger = "user" | "tool";

const _TRANSCRIPT_OPEN = "<transcript>";
const _TRANSCRIPT_CLOSE = "</transcript>";
const _RESPONSE_OPEN = "<response>";
const _RESPONSE_CLOSE = "</response>";

export interface NvidiaOmniLLMSettingsOptions extends OpenAILLMSettingsOptions {
  /**
   * Instruction sent with the user's speech in audio input mode. `null` uses
   * `DEFAULT_AUDIO_RESPONSE_INSTRUCTION`.
   */
  audioResponseInstruction?: string | null | NotGiven;
  /** Shortest buffered utterance that starts a turn. */
  minUserAudioSecs?: number | NotGiven;
  /**
   * Audio retained from before the user started speaking, so the start of an
   * utterance is not clipped.
   */
  preSpeechBufferSecs?: number | NotGiven;
}

/**
 * Settings for NvidiaOmniLLMService.
 *
 * - `audioResponseInstruction`: Instruction sent with the user's speech in
 *   audio input mode. `null` uses `DEFAULT_AUDIO_RESPONSE_INSTRUCTION`. A
 *   custom instruction should keep asking for the `<transcript>` and
 *   `<response>` sections; a reply without them still reaches TTS, but the
 *   user's turn is then missing from the context.
 * - `minUserAudioSecs`: Shortest buffered utterance that starts a turn.
 * - `preSpeechBufferSecs`: Audio retained from before the user started
 *   speaking, so the start of an utterance is not clipped.
 */
export class NvidiaOmniLLMSettings extends NvidiaLLMSettings {
  audioResponseInstruction: string | null | NotGiven = NOT_GIVEN;
  minUserAudioSecs: number | NotGiven = NOT_GIVEN;
  preSpeechBufferSecs: number | NotGiven = NOT_GIVEN;

  constructor(options: NvidiaOmniLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface NvidiaOmniInferenceResultOptions {
  /** The response text. */
  text?: string;
  /** The reasoning the model produced before responding. */
  reasoning?: string;
  /** Why generation stopped (e.g. `"stop"` or `"length"`). */
  finishReason?: string;
}

/**
 * Result of `NvidiaOmniLLMService.runMultimodalInference()`.
 *
 * - `text`: The response text.
 * - `reasoning`: The reasoning the model produced before responding.
 * - `finishReason`: Why generation stopped (e.g. `"stop"` or `"length"`).
 */
export class NvidiaOmniInferenceResult {
  readonly text: string;
  readonly reasoning: string;
  readonly finishReason: string;

  constructor(options: NvidiaOmniInferenceResultOptions = {}) {
    this.text = options.text ?? "";
    this.reasoning = options.reasoning ?? "";
    this.finishReason = options.finishReason ?? "";
    Object.freeze(this);
  }
}

export interface NvidiaOmniLLMServiceOptions extends NvidiaLLMServiceOptions {
  /**
   * NVIDIA API key. Required for the cloud endpoint, not for local
   * deployments.
   */
  apiKey?: string | null;
  /**
   * OpenAI-compatible endpoint base URL. For local deployments, pass the
   * local address (e.g. `http://localhost:8000/v1`).
   */
  baseUrl?: string | null;
  /**
   * Whether Omni hears the user directly, with no STT service in the
   * pipeline. `false` makes it a text LLM for a cascaded pipeline. Defaults
   * to `true`.
   */
  audioInput?: boolean;
  /**
   * Context that audio turns are answered against until the first
   * `LLMContextFrame` supplies one.
   */
  context?: LLMContext | null;
  /** Runtime-updatable settings. */
  settings?: NvidiaOmniLLMSettings | null;
  /** HTTP request timeout, in seconds. Defaults to 120. */
  requestTimeoutSecs?: number;
}

/** The token `_TurnPartsVar.set()` returns, to restore the previous value. */
interface _TurnPartsToken {
  key: object;
  had: boolean;
  previous: Dict[] | null | undefined;
}

const _NO_TASK = {};

/**
 * Per-task storage for the content parts of the turn the task runs; the
 * stand-in for upstream's `ContextVar` (see the porting notes above).
 */
class _TurnPartsVar {
  #values = new WeakMap<object, Dict[] | null>();

  get(): Dict[] | null {
    return this.#values.get(currentTask() ?? _NO_TASK) ?? null;
  }

  set(value: Dict[] | null): _TurnPartsToken {
    const key = currentTask() ?? _NO_TASK;
    const token = { key, had: this.#values.has(key), previous: this.#values.get(key) };
    this.#values.set(key, value);
    return token;
  }

  reset(token: _TurnPartsToken): void {
    if (token.had) {
      this.#values.set(token.key, token.previous ?? null);
    } else {
      this.#values.delete(token.key);
    }
  }
}

/**
 * NVIDIA Nemotron Omni LLM service with text and speech input.
 *
 * `audioInput` decides the pipeline architecture. In audio input mode (the
 * default), Omni hears the user directly, replacing the STT stage:
 *
 *     transport.input() -> user_aggregator -> llm
 *     -> tts -> transport.output() -> assistant_aggregator
 *
 * With `audioInput: false`, it is a text LLM in a cascaded pipeline:
 *
 *     transport.input() -> stt -> user_aggregator -> llm
 *     -> tts -> transport.output() -> assistant_aggregator
 *
 * Every turn runs through the inherited completion path, so tool calling,
 * streaming, reasoning frames, and metrics behave as in `NvidiaLLMService`.
 * Media placed in the context is sent in either mode.
 *
 * In audio input mode the service behaves like a realtime service that still
 * needs a TTS. It:
 *
 * - announces itself as a realtime service, which switches the user
 *   aggregator into realtime mode
 * - buffers the user's audio between turn boundaries
 * - answers a spoken turn once it ends, after any turn still running
 * - answers the speech of a turn interrupted before Omni transcribed it
 *   together with the user's next utterance
 * - asks Omni for a transcript of the user's speech and pushes it upstream as
 *   a `TranscriptionFrame`, which the user aggregator writes to the context
 * - treats the late context frame carrying that transcript as bookkeeping
 *   rather than as a turn to answer
 *
 * Context frames that need an answer, such as tool results, developer
 * messages, and typed user input, still start a completion, so the
 * `LLMRunFrame` greeting pattern works in both modes.
 *
 * As with other realtime services, the user's text is only known once the
 * transcript arrives, so read it from `on_user_turn_message_added` rather
 * than `on_user_turn_stopped`.
 *
 * @example
 * ```ts
 * userAggregator.eventHandler("on_user_turn_message_added", async (aggregator, message) => {
 *   logger.info(`User said: ${message.content}`);
 * });
 * ```
 */
export class NvidiaOmniLLMService extends NvidiaLLMService {
  static override Settings: typeof NvidiaOmniLLMSettings = NvidiaOmniLLMSettings;
  declare protected _settings: NvidiaOmniLLMSettings;
  static override adapterClass = NvidiaOmniLLMAdapter;
  static override supportsDeveloperRole = false;

  protected _requestTimeoutSecs: number;
  protected _audioInput: boolean;
  protected _context: LLMContext | null;

  protected _sampleRate = 16000;
  protected _numChannels = 1;
  protected _audioBuffer: Uint8Array[] = [];
  protected _preSpeechBuffer: Uint8Array[] = [];
  protected _audioUserSpeaking = false;
  protected _userTurnStarted = false;
  protected _lastUserStoppedAt: number | null = null;

  protected _turnTasks: Task<unknown>[] = [];
  protected _untranscribedSpeech: Map<Task<unknown>, Uint8Array> = new Map();
  // Set only inside the task running a turn, so that one-shot inferences
  // running concurrently from other tasks never send the turn's audio.
  protected _turnPartsVar: _TurnPartsVar = new _TurnPartsVar();
  protected _transcriptExtractor: _TranscriptResponseExtractor | null = null;
  protected _transcriptEmitted = false;
  protected _lastTranscript = "";
  protected _completionTracker: _CompletionTracker = new _CompletionTracker();

  /**
   * Initialize the NvidiaOmniLLMService.
   *
   * @param options.apiKey NVIDIA API key. Required for the cloud endpoint, not
   *   for local deployments.
   * @param options.baseUrl OpenAI-compatible endpoint base URL. For local
   *   deployments, pass the local address (e.g. `http://localhost:8000/v1`).
   * @param options.audioInput Whether Omni hears the user directly, with no
   *   STT service in the pipeline. `false` makes it a text LLM for a cascaded
   *   pipeline.
   * @param options.context Context that audio turns are answered against
   *   until the first `LLMContextFrame` supplies one.
   * @param options.settings Runtime-updatable settings.
   * @param options.requestTimeoutSecs HTTP request timeout, in seconds.
   *   Other options are passed to NvidiaLLMService.
   */
  constructor(options: NvidiaOmniLLMServiceOptions = {}) {
    const cls = new.target as typeof NvidiaOmniLLMService;
    const defaultSettings = new cls.Settings({
      model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      temperature: 0.6,
      topP: 0.95,
      audioResponseInstruction: null,
      minUserAudioSecs: 0.3,
      preSpeechBufferSecs: 0.2,
    });
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    const requestTimeoutSecs = options.requestTimeoutSecs ?? 120.0;
    // `createClient()` runs inside the parent constructor, so it reads the
    // timeout from the options it is given (`options.requestTimeoutSecs`).
    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://integrate.api.nvidia.com/v1",
      settings: defaultSettings,
    });
    this._requestTimeoutSecs = requestTimeoutSecs;

    this._audioInput = options.audioInput ?? true;
    this._context = options.context ?? null;
  }

  /**
   * Create the AsyncOpenAI client with the configured request timeout.
   *
   * @param options.apiKey NVIDIA API key. May be omitted for local deployments.
   * @param options.baseUrl OpenAI-compatible endpoint base URL.
   * @param options.organization OpenAI organization ID.
   * @param options.project OpenAI project ID.
   * @param options.defaultHeaders Additional HTTP headers.
   * @param options.requestTimeoutSecs HTTP request timeout, in seconds.
   * @returns Configured AsyncOpenAI client instance.
   */
  override createClient(
    options: OpenAIClientOptions & { requestTimeoutSecs?: number | null } = {},
  ): OpenAI {
    const timeoutSecs = options.requestTimeoutSecs ?? this._requestTimeoutSecs ?? 120.0;
    return new OpenAI({
      // The client refuses to start without a key, which local deployments
      // don't need.
      apiKey: options.apiKey || "not-needed",
      baseURL: options.baseUrl ?? undefined,
      timeout: timeoutSecs * 1000,
      organization: options.organization ?? null,
      project: options.project ?? null,
      defaultHeaders: options.defaultHeaders ?? undefined,
    });
  }

  /**
   * Announce the service as realtime when it accepts audio input.
   *
   * With audio input, the user's turn is only known once the model has
   * transcribed it. Realtime mode makes the user aggregator write it when the
   * assistant response starts, by which point the transcript is known.
   *
   * @returns The metadata frame broadcast at pipeline start.
   */
  override serviceMetadataFrame(): LLMServiceMetadataFrame {
    if (!this._audioInput) {
      return super.serviceMetadataFrame();
    }
    return new LLMServiceMetadataFrame({ serviceName: this.name, isRealtimeService: true });
  }

  /**
   * Start the service.
   *
   * @param frame The start frame.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    this._resetSessionState();
  }

  /**
   * Stop the service once the queued turns finish.
   *
   * A response requested before the end frame, such as a goodbye, is
   * completed first, as it is when the base service completes context frames
   * inline.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    if (this._turnTasks.length > 0) {
      await wait(this._turnTasks);
      this._turnTasks = [];
    }
    await super.stop(frame);
  }

  /**
   * Cancel the service, cancelling the queued turns.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await this._cancelTurns();
    await super.cancel(frame);
  }

  /** Clean up the service, cancelling the queued turns. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._cancelTurns();
  }

  /**
   * Process frames, starting text and audio turns in audio input mode.
   *
   * As a text LLM, every frame is handled by `NvidiaLLMService`. In audio
   * input mode, completions run in background tasks, because an audio turn
   * starts on a speech boundary rather than on a context frame. Turns run in
   * order, as the base service completes context frames, and only an
   * `InterruptionFrame` cancels them. `LLMContextFrame` and `LLMRunFrame` are
   * consumed; every other frame is forwarded.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    if (!this._audioInput) {
      await super.processFrame(frame, direction);
      return;
    }

    // Skip BaseOpenAILLMService.processFrame, which completes every
    // LLMContextFrame inline.
    await LLMService.prototype.processFrame.call(this, frame, direction);

    if (frame instanceof InterruptionFrame) {
      await this.stopAllMetrics();
      const untranscribed = this._pendingUntranscribedSpeech();
      await this._cancelTurns();
      if (this._audioUserSpeaking) {
        this._audioBuffer = [...untranscribed, ...this._audioBuffer];
      } else {
        this._audioBuffer = [];
        this._preSpeechBuffer = [];
      }
    } else if (frame instanceof LLMContextFrame) {
      this._context = frame.context;
      await this._startTextTurn(frame.context);
      return;
    } else if (frame instanceof LLMRunFrame) {
      await this._startTextTurn(this._context, { force: true });
      return;
    } else if (frame instanceof InputAudioRawFrame) {
      this._handleInputAudio(frame);
    } else if (frame instanceof VADUserStartedSpeakingFrame) {
      this._startBufferingSpeech();
    } else if (frame instanceof UserStartedSpeakingFrame) {
      this._startBufferingSpeech();
      this._userTurnStarted = true;
    } else if (frame instanceof VADUserStoppedSpeakingFrame) {
      this._handleVadStopped();
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      await this._handleUserStoppedSpeaking();
    }

    await this.pushFrame(frame, direction);
  }

  /**
   * Build chat completion parameters, appending the current audio turn.
   *
   * The user's speech is appended as a trailing user message rather than
   * written to the context. Fields left unset are dropped, so only the
   * configured token limit is sent.
   *
   * @param paramsFromContext Parameters derived from the LLM context.
   * @returns Dictionary of parameters for the chat completion request.
   */
  override buildChatCompletionParams(
    paramsFromContext: OpenAILLMInvocationParams,
  ): Record<string, any> {
    const params: Record<string, any> = {};
    for (const [name, value] of Object.entries(
      super.buildChatCompletionParams(paramsFromContext),
    )) {
      if (value !== undefined && isGiven(value)) {
        params[name] = value;
      }
    }
    const turnParts = this._activeTurnParts;
    if (turnParts && turnParts.length > 0) {
      // `adapterClass` is NvidiaOmniLLMAdapter (Python resolves it dynamically), but the base
      // class fixes the adapter generic to the OpenAIAdapter intersection type.
      const adapter = this.getLlmAdapter() as unknown as NvidiaOmniLLMAdapter;
      const messages = [...(params.messages || [])];
      messages.push({ role: "user", content: adapter.toProviderContentParts(turnParts) });
      params.messages = messages;
    }
    return params;
  }

  /**
   * Run a one-shot, out-of-pipeline inference without the current audio turn.
   *
   * @param context The LLM context containing conversation history.
   * @param options.maxTokens Optional maximum number of tokens to generate.
   * @param options.systemInstruction Optional system instruction for this
   *   inference.
   * @param options.responseSchema Optional JSON schema the reply must follow.
   * @returns The LLM's response as a string, or null if no response is
   *   generated.
   */
  override async runInference(
    context: LLMContext,
    options: {
      maxTokens?: number | null;
      systemInstruction?: string | null;
      responseSchema?: Record<string, unknown> | null;
    } = {},
  ): Promise<string | null> {
    return await this._withoutTurnParts(() =>
      super.runInference(context, {
        maxTokens: options.maxTokens,
        systemInstruction: options.systemInstruction,
        responseSchema: options.responseSchema,
      }),
    );
  }

  /**
   * Run a one-shot, out-of-pipeline inference that also returns the reasoning.
   *
   * Extends `runInference()` with what a worker analyzing media outside the
   * pipeline needs: the model's reasoning, text and reasoning deltas as they
   * arrive, and a per-call reasoning budget. Media is passed in the context,
   * for example with `LLMContext.createFileMessage()`.
   *
   * @param context The LLM context, including any media.
   * @param options.maxTokens Overrides the configured token limit.
   * @param options.reasoningBudget NVIDIA `reasoning_budget` request field,
   *   limiting how many tokens the model may spend reasoning.
   * @param options.temperature Overrides the configured temperature.
   * @param options.stream Whether to stream the completion and call the delta
   *   callbacks.
   * @param options.onTextDelta Called with each response text delta while
   *   streaming.
   * @param options.onReasoningDelta Called with each reasoning delta while
   *   streaming.
   * @returns The generated text, reasoning, and finish reason.
   */
  async runMultimodalInference(
    context: LLMContext,
    options: {
      maxTokens?: number | null;
      reasoningBudget?: number | null;
      temperature?: number | null;
      stream?: boolean;
      onTextDelta?: ((text: string) => Promise<void>) | null;
      onReasoningDelta?: ((text: string) => Promise<void>) | null;
    } = {},
  ): Promise<NvidiaOmniInferenceResult> {
    const maxTokens = options.maxTokens ?? null;
    const reasoningBudget = options.reasoningBudget ?? null;
    const temperature = options.temperature ?? null;
    const stream = options.stream ?? false;
    const onTextDelta = options.onTextDelta ?? null;
    const onReasoningDelta = options.onReasoningDelta ?? null;

    const invocationParams = await this.getLlmAdapter().getLlmInvocationParams(context, {
      systemInstruction: assertGiven(this._settings.systemInstruction),
      convertDeveloperToUser: !this.supportsDeveloperRole,
    });
    const params = this._withoutTurnPartsSync(() =>
      this.buildChatCompletionParams(invocationParams),
    );
    if (maxTokens !== null) {
      delete params.max_completion_tokens;
      params.max_tokens = maxTokens;
    }
    if (reasoningBudget !== null) {
      params.extra_body = {
        ...(params.extra_body || {}),
        reasoning_budget: reasoningBudget,
      };
    }
    if (temperature !== null) {
      params.temperature = temperature;
    }

    if (!stream) {
      params.stream = false;
      delete params.stream_options;
      const completion = (await abortable(
        // Python passes an untyped params dict straight to the SDK, as BaseOpenAILLMService does.
        this._client.chat.completions.create(this._requestBody(params) as any, {
          signal: currentSignal(),
        }),
      )) as OpenAI.Chat.Completions.ChatCompletion;
      const choice =
        completion.choices && completion.choices.length > 0 ? completion.choices[0]! : null;
      const message = choice ? choice.message : null;
      return new NvidiaOmniInferenceResult({
        text: _messageText((message as Dict | null)?.content).trim(),
        reasoning: _reasoningText(message).trim(),
        finishReason: String(choice?.finish_reason || ""),
      });
    }

    let text = "";
    let reasoning = "";
    let finishReason = "";
    const responseStream = (await abortable(
      // Untyped params dict (Python is dynamic); the SDK overload cannot infer the stream type.
      this._client.chat.completions.create(this._requestBody(params) as any, {
        signal: currentSignal(),
      }),
    )) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> & {
      controller?: AbortController;
    };
    const iterator = responseStream[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await abortable(iterator.next());
        if (next.done) break;
        const chunk = next.value;
        if (!chunk.choices || chunk.choices.length === 0) {
          continue;
        }
        const choice = chunk.choices[0]!;
        if (choice.finish_reason) {
          finishReason = String(choice.finish_reason);
        }
        const reasoningDelta = _reasoningText(choice.delta);
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          if (onReasoningDelta) {
            await onReasoningDelta(reasoningDelta);
          }
        }
        const textDelta = _messageText((choice.delta as Dict | null)?.content);
        if (textDelta) {
          text += textDelta;
          if (onTextDelta) {
            await onTextDelta(textDelta);
          }
        }
      }
    } finally {
      // Release the HTTP connection if the stream ends early.
      try {
        await iterator.return?.();
      } catch (e) {
        rethrowIfCancelled(e);
      }
      responseStream.controller?.abort();
    }
    return new NvidiaOmniInferenceResult({
      text: text.trim(),
      reasoning: reasoning.trim(),
      finishReason,
    });
  }

  /**
   * Whether the completion in progress carries the user's speech.
   *
   * @returns True during an audio turn, false during a text turn or between
   *   turns.
   */
  currentTurnHasUserAudio(): boolean {
    return (this._activeTurnParts ?? []).some((part) => part.type === "input_audio");
  }

  /**
   * Content parts the turn running in the current task adds to its request.
   *
   * @returns The parts, or null outside a turn and during one-shot inferences.
   */
  protected get _activeTurnParts(): Dict[] | null {
    return this._turnPartsVar.get();
  }

  protected async _withoutTurnParts<T>(fn: () => Promise<T>): Promise<T> {
    const token = this._turnPartsVar.set(null);
    try {
      return await fn();
    } finally {
      this._turnPartsVar.reset(token);
    }
  }

  protected _withoutTurnPartsSync<T>(fn: () => T): T {
    const token = this._turnPartsVar.set(null);
    try {
      return fn();
    } finally {
      this._turnPartsVar.reset(token);
    }
  }

  /**
   * Split the transcript out of the model's text before it reaches TTS.
   *
   * @param text Visible content from the model, with reasoning removed.
   */
  protected override async _pushLlmText(text: string): Promise<void> {
    const extractor = this._transcriptExtractor;
    if (extractor === null) {
      await super._pushLlmText(text);
      return;
    }
    const responseText = extractor.feed(text);
    await this._maybePushTranscript(extractor);
    if (responseText) {
      await super._pushLlmText(responseText);
    }
  }

  /**
   * Finalize reasoning state, then flush text held by the transcript split.
   *
   * @param options.flushBufferedText Whether buffered text may still be
   *   forwarded. `false` when the stream ended early through interruption or
   *   cancellation.
   */
  protected override async _finalizeReasoningState(options: {
    flushBufferedText: boolean;
  }): Promise<void> {
    await super._finalizeReasoningState({ flushBufferedText: options.flushBufferedText });
    const extractor = this._transcriptExtractor;
    if (extractor === null) {
      return;
    }
    // The remainder is plain response text, so it must not pass through the
    // extractor again.
    this._transcriptExtractor = null;
    if (!options.flushBufferedText) {
      return;
    }
    const remainder = extractor.finalize();
    await this._maybePushTranscript(extractor);
    if (remainder) {
      await this._pushLlmText(remainder);
    }
  }

  protected _handleInputAudio(frame: InputAudioRawFrame): void {
    this._sampleRate = frame.sampleRate;
    this._numChannels = frame.numChannels;
    if (this._audioUserSpeaking) {
      this._audioBuffer.push(frame.audio);
      return;
    }
    this._preSpeechBuffer.push(frame.audio);
    const preSpeechSecs = assertGiven(this._settings.preSpeechBufferSecs);
    const maxBytes = Math.trunc(this._bytesPerSecond() * preSpeechSecs);
    let total = this._preSpeechBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
    while (this._preSpeechBuffer.length > 0 && total > maxBytes) {
      total -= this._preSpeechBuffer.shift()!.length;
    }
  }

  protected _startBufferingSpeech(): void {
    if (this._audioUserSpeaking) {
      return;
    }
    this._audioUserSpeaking = true;
    this._audioBuffer = this._preSpeechBuffer;
    this._preSpeechBuffer = [];
  }

  /** Drop speech that ended without starting a user turn, such as a noise. */
  protected _handleVadStopped(): void {
    if (!this._audioUserSpeaking || this._userTurnStarted) {
      return;
    }
    this._audioUserSpeaking = false;
    this._audioBuffer = [];
  }

  protected async _handleUserStoppedSpeaking(): Promise<void> {
    this._userTurnStarted = false;
    if (!this._audioUserSpeaking) {
      return;
    }
    this._audioUserSpeaking = false;
    this._lastUserStoppedAt = time();
    await this._startAudioTurn();
  }

  /** Answer the buffered utterance, letting Omni transcribe it. */
  protected async _startAudioTurn(): Promise<void> {
    const audio = _concatBytes(this._audioBuffer);
    this._audioBuffer = [];
    this._preSpeechBuffer = [];
    const minSecs = assertGiven(this._settings.minUserAudioSecs);
    if (audio.length < Math.trunc(this._bytesPerSecond() * minSecs)) {
      logger.debug(`${this}: ignoring utterance shorter than ${minSecs.toFixed(2)}s`);
      return;
    }

    const userStoppedAt = this._lastUserStoppedAt;
    this._lastUserStoppedAt = null;
    // An audio-only pipeline may never send a context frame, and the user is
    // still waiting for an answer.
    const context = this._context ?? new LLMContext();
    const turnParts: Dict[] = [
      _audioPart(audio, this._sampleRate, this._numChannels),
      { type: "text", text: this._audioResponseInstruction() },
    ];
    logger.debug(`${this}: audio turn of ${(audio.length / this._bytesPerSecond()).toFixed(2)}s`);
    this._completionTracker.markAnswered(context);
    const task = this._queueTurn(
      () =>
        this._runTurn(context, {
          turnParts,
          expectTranscript: true,
          metricsStartTime: userStoppedAt,
        }),
      "nvidia-omni-audio-turn",
    );
    this._untranscribedSpeech.set(task, audio);
  }

  /**
   * Complete a context, unless everything in it is already answered.
   *
   * @param context The context to complete.
   * @param options.force Whether a completion was requested outright, as with
   *   `LLMRunFrame`, rather than by a new user turn.
   */
  protected async _startTextTurn(
    context: LLMContext | null,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (context === null) {
      logger.warning(`${this}: completion requested before any context, ignoring`);
      return;
    }

    const tracker = this._completionTracker;
    let trigger: _CompletionTrigger | null;
    if (options.force ?? false) {
      trigger = "user";
    } else {
      trigger = tracker.trigger(context);
      const recordsTranscript = tracker.consumeTranscriptRecord(context);
      if (recordsTranscript && trigger === "user") {
        logger.debug(`${this}: context frame records an answered spoken turn, ignoring`);
        return;
      }
    }
    if (trigger === null) {
      return;
    }

    const turnParts = this._unwrittenSpokenTurn(trigger, context);
    tracker.markAnswered(context);
    this._queueTurn(() => this._runTurn(context, { turnParts }), "nvidia-omni-text-turn");
  }

  /** Run a turn once the turns queued before it finish. */
  protected _queueTurn(run: () => Promise<void>, name: string): Task<unknown> {
    this._turnTasks = this._turnTasks.filter((task) => !task.done());
    this._untranscribedSpeech = new Map(
      [...this._untranscribedSpeech].filter(([task]) => !task.done()),
    );
    const previous =
      this._turnTasks.length > 0 ? this._turnTasks[this._turnTasks.length - 1]! : null;

    const runAfterPrevious = async (): Promise<void> => {
      if (previous) {
        try {
          await previous;
        } catch (e) {
          rethrowIfCancelled(e);
        }
      }
      await run();
    };

    const task = this.createTask(() => runAfterPrevious(), name);
    this._turnTasks.push(task);
    return task;
  }

  /** The speech of unfinished audio turns that Omni has not transcribed yet. */
  protected _pendingUntranscribedSpeech(): Uint8Array[] {
    const speech: Uint8Array[] = [];
    for (const task of this._turnTasks) {
      const audio = this._untranscribedSpeech.get(task);
      if (audio !== undefined && !task.done()) {
        speech.push(audio);
      }
    }
    return speech;
  }

  /**
   * The transcribed spoken turn a tool follow-up needs, if the context lacks it.
   *
   * The user aggregator writes a spoken turn when the assistant response
   * starts, which can be after the follow-up a tool result asks for, so the
   * follow-up carries the transcript itself.
   */
  protected _unwrittenSpokenTurn(
    trigger: _CompletionTrigger | null,
    context: LLMContext,
  ): Dict[] | null {
    const transcript = this._lastTranscript;
    if (trigger !== "tool" || !transcript || _latestUserText(context) === transcript) {
      return null;
    }
    return [{ type: "text", text: transcript }];
  }

  /**
   * Run one turn through the inherited completion path.
   *
   * Follows the frame, metrics, and error contract of
   * `BaseOpenAILLMService.processFrame()`, adding `turnParts` to the request.
   */
  protected async _runTurn(
    context: LLMContext,
    options: {
      turnParts?: readonly Dict[] | null;
      expectTranscript?: boolean;
      metricsStartTime?: number | null;
    } = {},
  ): Promise<void> {
    const turnParts = options.turnParts ?? null;
    const expectTranscript = options.expectTranscript ?? false;
    const turnPartsToken = this._turnPartsVar.set(
      turnParts && turnParts.length > 0 ? [...turnParts] : null,
    );
    this._transcriptExtractor = expectTranscript ? new _TranscriptResponseExtractor() : null;
    this._transcriptEmitted = false;
    if (expectTranscript) {
      this._lastTranscript = "";
    }

    await this.pushFrame(new LLMFullResponseStartFrame());
    await this.startProcessingMetrics({ startTime: options.metricsStartTime ?? null });
    try {
      await this._processContext(context);
    } catch (e) {
      rethrowIfCancelled(e);
      if (isTimeoutException(e)) {
        await this._callEventHandler("on_completion_timeout");
        await this.pushError("LLM completion timeout", { exception: e });
      } else if (e instanceof LLMContextConversionError) {
        await this.pushError(e.message, { exception: e });
        context.removeInvalidFileMessage();
      } else {
        const removed =
          (e instanceof BadRequestError ||
            e instanceof UnprocessableEntityError ||
            (e instanceof APIError && e.status === 413)) &&
          context.removeInvalidFileMessage();
        await this.pushError(`Error during completion: ${_errorMessage(e)}`, {
          exception: e,
          category: removed ? ErrorCategory.APPLICATION : null,
        });
      }
    } finally {
      this._turnPartsVar.reset(turnPartsToken);
      this._transcriptExtractor = null;
      await this.stopProcessingMetrics();
      await this.pushFrame(new LLMFullResponseEndFrame());
    }
  }

  protected async _maybePushTranscript(extractor: _TranscriptResponseExtractor): Promise<void> {
    if (this._transcriptEmitted || !(extractor.transcriptDone && extractor.transcript)) {
      return;
    }
    this._transcriptEmitted = true;
    await this._emitUserTranscript(extractor.transcript);
  }

  /**
   * Report the user's spoken turn upstream.
   *
   * The user aggregator writes the transcript to the context, as it does for
   * an STT service. Subclasses that parse their own response format call this
   * with the transcript they extract.
   *
   * @param transcript What the user said.
   */
  protected async _emitUserTranscript(transcript: string): Promise<void> {
    this._lastTranscript = transcript;
    this._completionTracker.transcriptReported(transcript);
    const task = currentTask();
    if (task) {
      this._untranscribedSpeech.delete(task);
    }
    await this.pushFrame(
      new TranscriptionFrame({
        text: transcript,
        userId: "",
        timestamp: timeNowIso8601(),
        result: transcript,
      }),
      FrameDirection.UPSTREAM,
    );
  }

  protected _audioResponseInstruction(): string {
    const instruction = this._settings.audioResponseInstruction;
    return (isGiven(instruction) && instruction) || DEFAULT_AUDIO_RESPONSE_INSTRUCTION;
  }

  protected _bytesPerSecond(): number {
    return Math.max(this._sampleRate * this._numChannels * 2, 1);
  }

  protected _resetSessionState(): void {
    this._audioBuffer = [];
    this._preSpeechBuffer = [];
    this._audioUserSpeaking = false;
    this._userTurnStarted = false;
    this._lastUserStoppedAt = null;
    this._lastTranscript = "";
    this._completionTracker = new _CompletionTracker();
  }

  protected async _cancelTurns(): Promise<void> {
    const tasks = this._turnTasks;
    this._turnTasks = [];
    this._untranscribedSpeech = new Map();
    for (const task of [...tasks].reverse()) {
      await this.cancelTask(task);
    }
  }
}

function _errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function _concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Build a universal `input_audio` content part from 16-bit PCM audio. */
export function _audioPart(pcm: Uint8Array, sampleRate: number, numChannels: number): Dict {
  const wav = pcmToWav(pcm, sampleRate, numChannels);
  return {
    type: "input_audio",
    input_audio: { data: bytesToBase64(wav), format: "wav" },
  };
}

function _isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function _messageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => _isDict(part) && part.type === "text" && part.text)
      .map((part) => (part as Dict).text as string)
      .join("\n");
  }
  return "";
}

/** Reasoning from a completion message or delta, under either field name NIM uses. */
function _reasoningText(payload: unknown): string {
  if (!_isDict(payload)) {
    return "";
  }
  for (const name of ["reasoning_content", "reasoning"]) {
    const value = payload[name];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return "";
}

/** Whether a context message is a standard (dict) message. */
function _isStandardMessage(message: LLMContextMessage): message is LLMStandardMessage {
  return !(message instanceof LLMSpecificMessage) && _isDict(message);
}

function _latestUserText(context: LLMContext): string {
  const messages = context.getMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (_isStandardMessage(message) && message.role === "user") {
      return _messageText(message.content).trim();
    }
  }
  return "";
}

/** Python `==` on JSON-like values (tool result contents). */
function _pyEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => _pyEquals(item, b[i]));
  }
  if (_isDict(a) && _isDict(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && _pyEquals(a[key], b[key]))
    );
  }
  return false;
}

/**
 * Decides which context frames still need a completion.
 *
 * Context frames share one context, and some arrive after the turns they
 * record have been answered: the user aggregator writes a spoken turn once its
 * transcript arrives, and a tool result can be visible in more than one
 * context frame. This tracks what has been answered, so that each spoken turn
 * and each tool result is completed once.
 */
class _CompletionTracker {
  protected _answeredToolResults: Map<string, unknown> = new Map();
  protected _unrecordedTranscript = "";

  /**
   * Note a spoken turn that was answered before its context frame arrives.
   *
   * @param transcript What the user said.
   */
  transcriptReported(transcript: string): void {
    this._unrecordedTranscript = transcript;
  }

  /**
   * Why the context needs a completion.
   *
   * Only messages after the last assistant message count. A tool result needs
   * one until it has been completed, unless a tool is still running.
   *
   * @param context The context of the frame.
   * @returns `"tool"` for a new tool result, `"user"` for a user or developer
   *   message, or null when nothing is left to answer.
   */
  trigger(context: LLMContext): _CompletionTrigger | null {
    let newToolResult = false;
    let toolRunning = false;
    let userTurn = false;
    const messages = context.getMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (!_isStandardMessage(message)) {
        continue;
      }
      const role = message.role;
      if (role === "assistant") {
        break;
      }
      if (role === "tool") {
        const content = message.content;
        if (content === _TOOL_RESULT_IN_PROGRESS) {
          toolRunning = true;
        } else if (!this._isAnswered(message)) {
          newToolResult = true;
        }
      } else if ((role === "user" || role === "developer") && _isTruthy(message.content)) {
        userTurn = true;
      }
    }
    if (newToolResult && !toolRunning) {
      return "tool";
    }
    return userTurn ? "user" : null;
  }

  /**
   * Consume the reported spoken turn if the frame records it.
   *
   * The reported transcript is forgotten once a frame shows it, so later
   * frames that repeat it, such as a history update, are still answered.
   *
   * @param context The context of the frame.
   * @returns True when the transcript is the last message of the context.
   */
  consumeTranscriptRecord(context: LLMContext): boolean {
    const transcript = this._unrecordedTranscript;
    if (!transcript || _latestUserText(context) !== transcript) {
      return false;
    }
    this._unrecordedTranscript = "";
    const messages = context.getMessages().filter(_isStandardMessage);
    return messages[messages.length - 1]!.role === "user";
  }

  /**
   * Record the tool results a completion of the context answers.
   *
   * @param context The context being completed.
   */
  markAnswered(context: LLMContext): void {
    for (const message of context.getMessages()) {
      if (!_isStandardMessage(message) || message.role !== "tool") {
        continue;
      }
      const content = message.content;
      if (content !== _TOOL_RESULT_IN_PROGRESS) {
        this._answeredToolResults.set(message.tool_call_id ?? "", content);
      }
    }
  }

  protected _isAnswered(message: LLMStandardMessage): boolean {
    const toolCallId = message.tool_call_id ?? "";
    const answered = this._answeredToolResults;
    return answered.has(toolCallId) && _pyEquals(answered.get(toolCallId), message.content);
  }
}

/** Python truthiness for message content (a string or a list of parts). */
function _isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (_isDict(value)) return Object.keys(value).length > 0;
  return true;
}

const _ExtractorState = {
  DETECTING: "detecting",
  TRANSCRIPT: "transcript",
  BETWEEN: "between",
  RESPONSE: "response",
  PASSTHROUGH: "passthrough",
  DONE: "done",
} as const;
type _ExtractorState = (typeof _ExtractorState)[keyof typeof _ExtractorState];

function _matchTag(text: string, tag: string): "match" | "partial" | "none" {
  if (text.startsWith(tag)) {
    return "match";
  }
  if (text.length < tag.length && tag.startsWith(text)) {
    return "partial";
  }
  return "none";
}

/** Drop the start of `tag` from the end of `text`, left by a stream cut mid-tag. */
function _stripPartialTag(text: string, tag: string): string {
  const start = text.lastIndexOf("<");
  if (start !== -1 && _matchTag(text.slice(start), tag) === "partial") {
    return text.slice(0, start);
  }
  return text;
}

/**
 * Split `buffer` so the tail holds back what could be the start of `tag`.
 * Counted in code points, as Python's `len()`, so a surrogate pair is never
 * split.
 */
function _splitSafe(buffer: string, tag: string): [string, string] | null {
  const chars = Array.from(buffer);
  const safeEnd = chars.length - tag.length + 1;
  if (safeEnd <= 0) {
    return null;
  }
  return [chars.slice(0, safeEnd).join(""), chars.slice(safeEnd).join("")];
}

/**
 * Incrementally splits `<transcript>` and `<response>` sections.
 *
 * `feed()` returns response text that is ready to stream onward. The
 * transcript is exposed through `transcript` once `transcriptDone` is set.
 * Output that doesn't open with `<transcript>` is treated entirely as response
 * text, so an untagged reply still reaches TTS.
 */
export class _TranscriptResponseExtractor {
  protected _state: _ExtractorState = _ExtractorState.DETECTING;
  protected _buffer = "";
  protected _pendingTranscript = "";
  transcript = "";
  transcriptDone = false;

  feed(text: string): string {
    if (this._state === _ExtractorState.DONE) {
      return "";
    }
    this._buffer += text;
    const out: string[] = [];
    while (this._buffer) {
      if (this._state === _ExtractorState.DETECTING) {
        const stripped = this._buffer.trimStart();
        if (!stripped) {
          break;
        }
        const match = _matchTag(stripped, _TRANSCRIPT_OPEN);
        if (match === "partial") {
          break;
        }
        if (match === "match") {
          this._buffer = stripped.slice(_TRANSCRIPT_OPEN.length);
          this._state = _ExtractorState.TRANSCRIPT;
        } else {
          this._buffer = stripped;
          this._state = _ExtractorState.PASSTHROUGH;
        }
      } else if (this._state === _ExtractorState.TRANSCRIPT) {
        const idx = this._buffer.indexOf(_TRANSCRIPT_CLOSE);
        if (idx === -1) {
          const split = _splitSafe(this._buffer, _TRANSCRIPT_CLOSE);
          if (split !== null) {
            this._pendingTranscript += split[0];
            this._buffer = split[1];
          }
          break;
        }
        this._pendingTranscript += this._buffer.slice(0, idx);
        this.transcript = this._pendingTranscript.trim();
        this.transcriptDone = true;
        this._buffer = this._buffer.slice(idx + _TRANSCRIPT_CLOSE.length);
        this._state = _ExtractorState.BETWEEN;
      } else if (this._state === _ExtractorState.BETWEEN) {
        const stripped = this._buffer.trimStart();
        if (!stripped) {
          this._buffer = "";
          break;
        }
        const match = _matchTag(stripped, _RESPONSE_OPEN);
        if (match === "partial") {
          this._buffer = stripped;
          break;
        }
        if (match === "match") {
          this._buffer = stripped.slice(_RESPONSE_OPEN.length);
          this._state = _ExtractorState.RESPONSE;
        } else {
          this._buffer = stripped;
          this._state = _ExtractorState.PASSTHROUGH;
        }
      } else if (this._state === _ExtractorState.PASSTHROUGH) {
        out.push(this._buffer);
        this._buffer = "";
      } else {
        const idx = this._buffer.indexOf(_RESPONSE_CLOSE);
        if (idx !== -1) {
          out.push(this._buffer.slice(0, idx));
          this._buffer = "";
          this._state = _ExtractorState.DONE;
          break;
        }
        const split = _splitSafe(this._buffer, _RESPONSE_CLOSE);
        if (split !== null) {
          out.push(split[0]);
          this._buffer = split[1];
        }
        break;
      }
    }
    return out.join("");
  }

  /** Return response text still held back once the stream has ended. */
  finalize(): string {
    let remainder = this._buffer;
    this._buffer = "";
    if (this._state === _ExtractorState.TRANSCRIPT) {
      if (!this.transcriptDone) {
        remainder = _stripPartialTag(remainder, _TRANSCRIPT_CLOSE);
        this.transcript = (this._pendingTranscript + remainder).trim();
        this.transcriptDone = Boolean(this.transcript);
      }
      return "";
    }
    if (this._state === _ExtractorState.DONE) {
      return "";
    }
    return remainder;
  }
}
