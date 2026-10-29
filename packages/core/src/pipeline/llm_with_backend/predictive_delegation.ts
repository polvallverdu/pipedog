// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/llm_with_backend/predictive_delegation.py

/**
 * Predictive delegation, an optimization that can speed up responses that
 * need the backend.
 *
 * Pass a `PredictiveDelegation` as
 * `new LLMWithBackend({ predictiveDelegation })` to turn it on. Normally, a
 * text frontend spends a whole inference deciding to call `delegate` before
 * the backend can start. Predictive delegation uses a fast yes/no classifier
 * to determine whether it needs to wait for that inference or can go ahead
 * and trigger an early backend delegation.
 *
 * How it works: when a user's turn ends, the frontend runs in parallel (i.e.
 * in a race) with the classifier (see `classifiers`) that decides whether the
 * turn needs the backend.
 *
 * - If the classifier says "yes" before the frontend has produced output:
 *   - the frontend's inference is cancelled;
 *   - a `delegate` call to the backend is made right away, in its place.
 * - Otherwise, the frontend handles the turn as usual, having waited for
 *   nothing (note that it may still choose to `delegate`).
 */

import { currentTask, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import type { BaseClassifier, ClassifierValue } from "../../classifiers/base_classifier.ts";
import { YesNoQuestion } from "../../classifiers/base_classifier.ts";
import {
  type Frame,
  FunctionCallFromLLM,
  InterruptionFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  MetricsFrame,
  SystemFrame,
  UserStartedSpeakingFrame,
} from "../../frames/frames.ts";
import type { MetricsData } from "../../metrics/metrics.ts";
import type { LLMContextMessage } from "../../processors/aggregators/llm_context.ts";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "../../processors/frame_processor.ts";
import type { _OutputGate, LLMService } from "../../services/llm_service.ts";
import { LLMSettings } from "../../services/settings.ts";
import { logger } from "../../utils/logger.ts";
import { type BackendConnector, DELEGATE_TOOL_NAME } from "./connector.ts";
import {
  _isBackendMessage,
  _isStandardMessage,
  BACKEND_MESSAGE_RELAY_INSTRUCTION,
} from "./prompts.ts";

type AnyLLMService = LLMService<any>;

// ---------------------------------------------------------------------------
// _PredictiveDelegationRace tracks whether a classifier "yes" arrives before
// the frontend's first output, and so whether the turn is delegated early or
// handled by the frontend as usual. A classifier "no" plays no part. The
// frontend is normally idle when a turn ends (the user's speech interrupts
// it), so its inference starts at once; a "yes" that comes while it is still
// busy is held until it starts. The race is attached to the frontend as its
// output gate (`_OutputGate` in `services/llm_service`), which the frontend
// consults from its processFrame, pushFrame and runFunctionCalls.
// ---------------------------------------------------------------------------

/**
 * Where the predictive delegation race for a user's turn stands.
 *
 * - `PENDING`: the frontend has been asked to reply to the user's turn, but
 *   hasn't started its inference yet: normally for only a moment, longer if
 *   it's still busy with an earlier response. A classifier "yes" now is held
 *   until the inference starts.
 * - `RACING`: the frontend's inference is running and hasn't produced any
 *   output yet. A classifier "yes" now, or one held from `PENDING`, delegates
 *   the turn early.
 * - `FRONTEND_WON`: the frontend's inference produced output before any
 *   classifier "yes", or the turn was interrupted. The frontend handles the
 *   turn as usual.
 * - `CLASSIFIER_WON`: a classifier "yes" came first. The turn is delegated
 *   early, and the frontend's inference is cancelled.
 */
export const _PredictiveDelegationRaceState = {
  PENDING: "pending",
  RACING: "racing",
  FRONTEND_WON: "frontend won",
  CLASSIFIER_WON: "classifier won",
} as const;
export type _PredictiveDelegationRaceState =
  (typeof _PredictiveDelegationRaceState)[keyof typeof _PredictiveDelegationRaceState];

export interface _EarlyDelegationFrameOptions {
  /** The context frame of the user's turn. */
  turn?: LLMContextFrame | null;
  /** The calls made in place of the inference (the `delegate` call). */
  functionCalls?: FunctionCallFromLLM[];
}

/**
 * Asks the frontend to delegate a user's turn now, in place of its own
 * inference.
 *
 * Sent by PredictiveDelegation when its classifier says "yes". If the
 * frontend's inference for the turn hasn't produced anything yet, the
 * frontend makes the given calls and cancels the inference; otherwise the
 * frame does nothing. A system frame, so the frontend handles it at once,
 * while the inference runs on another task.
 *
 * - `turn`: the context frame of the user's turn.
 * - `functionCalls`: the calls made in place of the inference (the `delegate`
 *   call).
 */
export class _EarlyDelegationFrame extends SystemFrame {
  turn: LLMContextFrame | null;
  functionCalls: FunctionCallFromLLM[];

  constructor(options: _EarlyDelegationFrameOptions = {}) {
    super(options);
    this.turn = options.turn ?? null;
    this.functionCalls = options.functionCalls ?? [];
  }
}

/**
 * Tracks whether a classifier "yes" arrives before the frontend's first
 * output for a turn.
 *
 * See the module docstring and the comment above. Early delegation makes the
 * frame's calls, then cancels the frontend's inference with
 * `FrameProcessor._cancelFrameInProgress`, which keeps the frontend's queue,
 * including the acknowledgement run the call starts. Downstream sees an
 * ordinary response holding the call; any other output the inference pushes
 * before it's cancelled is dropped.
 *
 * The frontend's inference is recognized by the task its frames and calls
 * come from, the frontend's process task; everything else the frontend
 * pushes is left alone. All checks are synchronous, so the frontend's first
 * output and early delegation can't interleave.
 */
export class _PredictiveDelegationRace implements _OutputGate {
  protected _turn: LLMContextFrame | null = null;
  // The frontend's process task, which runs its inference for the turn and
  // goes on to process the frames after it.
  protected _frontendInferenceTask: Task<unknown> | null = null;
  // null until the first user turn starts a race; after that, the latest
  // race's state, which stays put once decided until the next turn.
  protected _state: _PredictiveDelegationRaceState | null = null;
  protected _frontend: AnyLLMService | null = null;
  // A "yes" that arrived while PENDING, held until the inference starts its
  // response.
  protected _heldEarlyDelegation: _EarlyDelegationFrame | null = null;

  /**
   * Start a race for a user's turn, just before the turn is passed to the
   * frontend.
   *
   * @param frame The context frame of the user's turn.
   */
  start(frame: LLMContextFrame): void {
    this._turn = frame;
    this._frontendInferenceTask = null;
    this._state = _PredictiveDelegationRaceState.PENDING;
    this._heldEarlyDelegation = null;
  }

  /**
   * Follow the race through the frames the frontend processes.
   *
   * Implements `_OutputGate.processFrame`. Racing starts when the frontend's
   * inference for the turn starts, an interruption leaves the turn to the
   * frontend, and an early delegation frame is carried out while racing.
   *
   * @param service The frontend service.
   * @param frame The frame it is processing.
   */
  async processFrame(service: AnyLLMService, frame: Frame): Promise<void> {
    if (frame instanceof LLMContextFrame) {
      if (frame === this._turn && this._state === _PredictiveDelegationRaceState.PENDING) {
        this._frontend = service;
        this._frontendInferenceTask = currentTask() ?? null;
        this._state = _PredictiveDelegationRaceState.RACING;
      }
    } else if (frame instanceof InterruptionFrame) {
      // The interruption cancels the inference: there is nothing left for
      // early delegation to replace.
      if (
        this._state === _PredictiveDelegationRaceState.PENDING ||
        this._state === _PredictiveDelegationRaceState.RACING
      ) {
        this._state = _PredictiveDelegationRaceState.FRONTEND_WON;
      }
    } else if (frame instanceof _EarlyDelegationFrame) {
      await this._delegateEarly(service, frame);
    }
  }

  /**
   * Whether the frontend may push a frame; notes its inference's first output.
   *
   * Implements `_OutputGate.allowPush`.
   *
   * @param frame The frame the frontend is about to push.
   * @returns Whether the frontend may push the frame: false only for what the
   *   inference pushes after the turn was delegated early and before its
   *   cancellation lands, other than the end of its response.
   */
  allowPush(frame: Frame): boolean {
    if (!this._calledFromFrontendInference()) {
      return true;
    }
    this._noteFrontendInferencePush(frame);
    if (this._state === _PredictiveDelegationRaceState.CLASSIFIER_WON) {
      return frame instanceof SystemFrame || frame instanceof LLMFullResponseEndFrame;
    }
    return true;
  }

  /**
   * Whether the frontend may run function calls; notes its inference's first
   * call.
   *
   * Implements `_OutputGate.allowFunctionCalls`.
   *
   * @returns Whether the frontend may run them: false only for calls the
   *   inference reaches after the turn was delegated early and before its
   *   cancellation lands.
   */
  allowFunctionCalls(): boolean {
    if (!this._calledFromFrontendInference()) {
      return true;
    }
    this._noteFrontendInferenceFunctionCalls();
    return this._state !== _PredictiveDelegationRaceState.CLASSIFIER_WON;
  }

  /** Whether the caller is the frontend's process task, running its inference for the turn. */
  protected _calledFromFrontendInference(): boolean {
    return this._frontendInferenceTask !== null && currentTask() === this._frontendInferenceTask;
  }

  /**
   * Note a frame the frontend's inference pushes while racing.
   *
   * The start of its response carries out an early delegation held from
   * `PENDING`. Any other output but a system frame is the inference's first,
   * and leaves the turn to the frontend.
   */
  protected _noteFrontendInferencePush(frame: Frame): void {
    if (this._state !== _PredictiveDelegationRaceState.RACING) {
      return;
    }
    if (frame instanceof LLMFullResponseStartFrame) {
      if (this._heldEarlyDelegation && this._frontend) {
        // Carried out on the frontend's input task, like any early delegation
        // frame, once this start frame is downstream.
        const held = this._heldEarlyDelegation;
        this._heldEarlyDelegation = null;
        const frontend = this._frontend;
        frontend.createTask(() => frontend.queueFrame(held));
      }
    } else if (!(frame instanceof SystemFrame)) {
      this._state = _PredictiveDelegationRaceState.FRONTEND_WON;
    }
  }

  /**
   * Note the frontend's inference reaching function calls.
   *
   * While racing, its first call leaves the turn to the frontend.
   */
  protected _noteFrontendInferenceFunctionCalls(): void {
    if (this._state === _PredictiveDelegationRaceState.RACING) {
      this._state = _PredictiveDelegationRaceState.FRONTEND_WON;
    }
  }

  /**
   * If the turn is racing, make the frame's calls and cancel the inference.
   *
   * A frame that arrives while the turn is pending is held until the
   * inference starts.
   */
  protected async _delegateEarly(
    frontend: AnyLLMService,
    frame: _EarlyDelegationFrame,
  ): Promise<void> {
    const turn = frame.turn;
    if (turn === null || turn !== this._turn) {
      return;
    }
    if (this._state === _PredictiveDelegationRaceState.PENDING) {
      logger.debug("Predictive delegation: turn pending; holding the early delegation");
      this._heldEarlyDelegation = frame;
      return;
    }
    if (this._state !== _PredictiveDelegationRaceState.RACING) {
      logger.debug("Predictive delegation: not delegating early (the race is decided)");
      return;
    }
    logger.debug("Predictive delegation: delegating early, cancelling the frontend's inference");
    this._state = _PredictiveDelegationRaceState.CLASSIFIER_WON;
    await frontend.runFunctionCalls(frame.functionCalls);
    // `_cancelFrameInProgress` is protected on FrameProcessor; upstream calls
    // it from outside the class too.
    await (
      frontend as unknown as { _cancelFrameInProgress(frame: Frame): Promise<boolean> }
    )._cancelFrameInProgress(turn);
  }
}

/** How likely a classifier "yes" must be for a turn to be delegated early. */
const _DELEGATION_PREDICTION_THRESHOLD = 0.6;

/** How many of the conversation's latest messages the classifier sees. */
const _DELEGATION_PREDICTION_HISTORY_LENGTH = 12;

/**
 * An optimization that can speed up responses that need backend involvement.
 *
 * **Alpha.** It uses a fast yes/no classifier to determine, after each user
 * request, whether it needs to wait for the frontend's inference or can go
 * ahead and trigger an early backend delegation. See
 * `pipeline/llm_with_backend/predictive_delegation` for how it works. Pass
 * one to `new LLMWithBackend({ predictiveDelegation })`, which puts it just
 * in front of the frontend; it needs a text frontend and a request strategy
 * whose `delegate` call needs no arguments, such as the default
 * `TranscriptBackendRequestStrategy`.
 *
 * It races every turn that ends with a new user message, spoken or typed, and
 * so also a user-role message the app appends and runs the frontend on. The
 * classifier is asked whether that message needs the backend, given the
 * frontend's system instruction (where the app says what the backend is for,
 * and the pairing instruction when to delegate), the `delegate` tool's
 * description, and the latest messages of the conversation, the backend's
 * included. A turn the frontend sees as speculative (eager end of turn), or
 * with incomplete-turn filtering on, is left to the frontend.
 *
 * @example
 * const llm = new LLMWithBackend({
 *   frontend: new OpenAILLMService({ ... }),
 *   backend: new BackendLLMWorker({ ... }),
 *   predictiveDelegation: new PredictiveDelegation(new JevClassifier({ apiKey })),
 * });
 */
export class PredictiveDelegation extends FrameProcessor {
  protected _classifier: BaseClassifier;
  protected _race = new _PredictiveDelegationRace();
  protected _frontend: AnyLLMService | null = null;
  protected _question: YesNoQuestion | null = null;
  protected _lastRaced: LLMContextMessage | null = null;
  protected _classifyTask: Task<unknown> | null = null;
  protected _warned = new Set<string>();

  /**
   * Initialize predictive delegation.
   *
   * @param classifier The yes/no classifier to ask. It answers within a bound
   *   of its own; an answer that comes after the frontend's first output is
   *   ignored.
   * @param options Additional options passed to the parent class.
   */
  constructor(classifier: BaseClassifier, options: FrameProcessorOptions = {}) {
    super(options);
    this._classifier = classifier;
  }

  /** Attach the race to the frontend and build the classifier's question. */
  _bind(frontend: AnyLLMService, connector: BackendConnector): void {
    this._frontend = frontend;
    frontend._outputGate = this._race;
    this._question = new YesNoQuestion({
      instructions:
        "Does the user's latest message need to be handed to the assistant's backend " +
        `now? The handoff works like this: ${connector.requestStrategy.toolDescription}`,
      no: "The assistant's instructions say not to hand this message to the backend.",
    });
  }

  /** Set up the classifier, reporting its metrics in the pipeline. */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._classifier.setup(this.taskManager);
    this._classifier.addEventHandler("on_metrics", (classifier: BaseClassifier, data) =>
      this._onClassifierMetrics(classifier, data as MetricsData[]),
    );
  }

  /** Stop any classification in progress and clean up the classifier. */
  override async cleanup(): Promise<void> {
    await this._cancelClassification();
    await this._classifier.cleanup();
    await super.cleanup();
  }

  /**
   * Race each new user turn; pass every frame on.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof InterruptionFrame || frame instanceof UserStartedSpeakingFrame) {
      await this._cancelClassification();
    }
    if (
      direction === FrameDirection.DOWNSTREAM &&
      frame instanceof LLMContextFrame &&
      this._shouldStartRace(frame)
    ) {
      await this._cancelClassification();
      this._race.start(frame);
      const state = this._classifierState(frame);
      await this.pushFrame(frame, direction);
      this._classifyTask = this.createTask(() => this._classify(frame, state), `${this}::classify`);
      return;
    }
    await this.pushFrame(frame, direction);
  }

  /**
   * Whether a context frame should start a race.
   *
   * It should when it asks for a reply to a user message that hasn't been
   * raced yet, unless the turn is speculative (eager end of turn) or the
   * frontend filters incomplete user turns.
   */
  protected _shouldStartRace(frame: LLMContextFrame): boolean {
    if (this._frontend === null) throw new Error("predictive delegation not bound");
    if (frame.speculation) {
      this._warnOnce(
        "speculation",
        "Predictive delegation: speculative turns (eager end of turn) are left to the frontend",
      );
      return false;
    }
    if (this._frontendSettings().filterIncompleteUserTurns) {
      this._warnOnce(
        "filtering",
        "Predictive delegation: turns are left to the frontend while it filters " +
          "incomplete user turns",
      );
      return false;
    }
    const messages = frame.context.getMessages();
    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    if (!last || !_isStandardMessage(last) || last.role !== "user") {
      return false;
    }
    if (last === this._lastRaced) {
      return false;
    }
    this._lastRaced = last;
    return true;
  }

  /** What the classifier is told about the turn. */
  protected _classifierState(frame: LLMContextFrame): Record<string, unknown> {
    // The instruction the frontend's model reads, the pairing instruction
    // included, so the classifier follows the same rules for delegating.
    const systemInstruction = this._frontendSettings().systemInstruction;
    return {
      assistant: typeof systemInstruction === "string" ? systemInstruction : "",
      conversation: _renderForClassifier(frame.context.getMessages()),
    };
  }

  /** Ask the classifier about a turn; on a "yes", ask the frontend to delegate it early. */
  protected async _classify(frame: LLMContextFrame, state: Record<string, unknown>): Promise<void> {
    if (this._question === null) throw new Error("predictive delegation not bound");
    let answers: Awaited<ReturnType<BaseClassifier["yesNo"]>>;
    try {
      answers = await this._classifier.yesNo(state as ClassifierValue, {
        needs_backend: this._question,
      });
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(
        `Predictive delegation: the classifier failed: ${e instanceof Error ? e.message : e}`,
      );
      return;
    }
    const probability = (answers.needs_backend as { probability: number }).probability;
    logger.debug(`Predictive delegation: classifier says ${probability.toFixed(2)}`);
    if (probability < _DELEGATION_PREDICTION_THRESHOLD) {
      return;
    }
    const call = new FunctionCallFromLLM({
      functionName: DELEGATE_TOOL_NAME,
      toolCallId: `early_delegation_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      arguments: {},
      context: frame.context,
    });
    await this.pushFrame(new _EarlyDelegationFrame({ turn: frame, functionCalls: [call] }));
  }

  protected _frontendSettings(): LLMSettings {
    if (this._frontend === null) throw new Error("predictive delegation not bound");
    const settings = this._frontend.settings;
    if (!(settings instanceof LLMSettings))
      throw new Error("frontend settings are not LLMSettings");
    return settings;
  }

  protected async _cancelClassification(): Promise<void> {
    if (this._classifyTask !== null) {
      await this.cancelTask(this._classifyTask);
      this._classifyTask = null;
    }
  }

  protected async _onClassifierMetrics(
    _classifier: BaseClassifier,
    data: MetricsData[],
  ): Promise<void> {
    await this.pushFrame(new MetricsFrame({ data }));
  }

  protected _warnOnce(key: string, message: string): void {
    if (!this._warned.has(key)) {
      this._warned.add(key);
      logger.warning(message);
    }
  }
}

/** The conversation's latest messages, as speaker and text, for the classifier. */
function _renderForClassifier(messages: readonly LLMContextMessage[]): Record<string, string>[] {
  const rendered: Record<string, string>[] = [];
  for (const message of messages) {
    if (!_isStandardMessage(message)) {
      continue;
    }
    const role = message.role;
    const content = message.content;
    if (role === "user" && typeof content === "string") {
      rendered.push({ speaker: "user", text: content });
    } else if (role === "assistant") {
      if (typeof content === "string" && content) {
        rendered.push({ speaker: "assistant", text: content });
      }
      for (const call of (message.tool_calls as Record<string, any>[] | undefined) || []) {
        if (call.function?.name === DELEGATE_TOOL_NAME) {
          rendered.push({ speaker: "assistant", action: "handed the request to the backend" });
        }
      }
    } else if (_isBackendMessage(message) && typeof content === "string") {
      const suffix = `\n\n${BACKEND_MESSAGE_RELAY_INSTRUCTION}`;
      rendered.push({
        speaker: "backend",
        text: content.endsWith(suffix) ? content.slice(0, -suffix.length) : content,
      });
    }
  }
  return rendered.slice(-_DELEGATION_PREDICTION_HISTORY_LENGTH);
}
