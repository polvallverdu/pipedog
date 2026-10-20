// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_turn_completion_mixin.py

/**
 * Mixin for adding turn completion detection to LLM services.
 *
 * This mixin enables LLM services to detect and process turn completion
 * markers (COMPLETE/INCOMPLETE) in LLM responses, allowing for smarter
 * conversation flow where the LLM can indicate whether the user's input was
 * complete or if they were interrupted mid-thought.
 */

import { CancelledError, sleep, type Task } from "@pipecat-ts/asyncio";
import {
  type Frame,
  FunctionCallsStartedFrame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMMarkerFrame,
  LLMMarkerResponseFrame,
  LLMMessagesAppendFrame,
  LLMRunFrame,
  LLMTextFrame,
  UserStartedSpeakingFrame,
  UserTurnInferenceCompletedFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../frames/frames.ts";
import { FrameDirection, type FrameProcessor } from "../processors/frame_processor.ts";
import { logger } from "../utils/logger.ts";
import { type Ctor, defineMixin } from "../utils/mixin.ts";

// Turn completion markers. Fill level tracks how much of the user's turn has
// arrived: full is a finished turn, half is a turn cut off mid-thought, empty
// is a user who hasn't started answering. Each is a single token in every
// major tokenizer, which matters because the complete marker is generated
// before any speakable text.
export const USER_TURN_COMPLETE_MARKER = "●";
/** Short wait - user likely continues soon. */
export const USER_TURN_INCOMPLETE_SHORT_MARKER = "◐";
/** Long wait - user needs more time. */
export const USER_TURN_INCOMPLETE_LONG_MARKER = "○";

/**
 * Completion verdict detected in the current LLM response.
 *
 * - `COMPLETE`:   ● detected, response flows through as speech.
 * - `INCOMPLETE`: ◐/○ detected, response suppressed, timeout armed.
 */
export const TurnMarker = {
  COMPLETE: "complete",
  INCOMPLETE: "incomplete",
} as const;
export type TurnMarker = (typeof TurnMarker)[keyof typeof TurnMarker];

/**
 * How long to wait before re-prompting after an incomplete turn.
 *
 * - `SHORT`: ◐ detected, the user was cut off and likely continues soon.
 * - `LONG`:  ○ detected, the user needs more time to think.
 */
export const IncompleteType = {
  SHORT: "short",
  LONG: "long",
} as const;
export type IncompleteType = (typeof IncompleteType)[keyof typeof IncompleteType];

// Default prompts for incomplete timeouts

/**
 * Build the re-prompt sent when a short incomplete-turn timeout expires.
 *
 * @param complete Marker the LLM emits when the user turn is complete.
 * @param short Marker for a turn cut off mid-thought.
 * @param long Marker for a user who needs more time.
 * @returns The prompt text with the markers substituted in.
 */
function renderIncompleteShortPrompt(complete: string, short: string, long: string): string {
  return `The user paused briefly. Generate a brief, natural prompt to encourage them to continue.

IMPORTANT: You MUST respond with ${complete} followed by your message. Do NOT output ${short} or ${long} - the user has already been given time to continue.

Your response should:
- Be contextually relevant to what was just discussed
- Sound natural and conversational
- Be very concise (1 sentence max)
- Gently prompt them to continue

Example format: ${complete} Go ahead, I'm listening.

Generate your ${complete} response now.`;
}

export const DEFAULT_INCOMPLETE_SHORT_PROMPT = renderIncompleteShortPrompt(
  USER_TURN_COMPLETE_MARKER,
  USER_TURN_INCOMPLETE_SHORT_MARKER,
  USER_TURN_INCOMPLETE_LONG_MARKER,
);

/**
 * Build the re-prompt sent when a long incomplete-turn timeout expires.
 *
 * @param complete Marker the LLM emits when the user turn is complete.
 * @param short Marker for a turn cut off mid-thought.
 * @param long Marker for a user who needs more time.
 * @returns The prompt text with the markers substituted in.
 */
function renderIncompleteLongPrompt(complete: string, short: string, long: string): string {
  return `The user has been quiet for a while. Generate a friendly check-in message.

IMPORTANT: You MUST respond with ${complete} followed by your message. Do NOT output ${short} or ${long} - the user has already been given plenty of time.

Your response should:
- Acknowledge they might be thinking or busy
- Offer to help or continue when ready
- Be warm and understanding
- Be brief (1 sentence)

Example format: ${complete} No rush! Let me know when you're ready to continue.

Generate your ${complete} response now.`;
}

export const DEFAULT_INCOMPLETE_LONG_PROMPT = renderIncompleteLongPrompt(
  USER_TURN_COMPLETE_MARKER,
  USER_TURN_INCOMPLETE_SHORT_MARKER,
  USER_TURN_INCOMPLETE_LONG_MARKER,
);

// System prompt instructions for turn completion that can be appended to any
// base prompt.

/**
 * Build the turn completion instructions appended to the system prompt.
 *
 * @param complete Marker the LLM emits when the user turn is complete.
 * @param short Marker for a turn cut off mid-thought.
 * @param long Marker for a user who needs more time.
 * @returns The prompt text with the markers substituted in.
 */
function renderCompletionInstructions(complete: string, short: string, long: string): string {
  return `
TURN COMPLETION PROTOCOL (mandatory):
The user's words reach you from speech recognition, usually without punctuation, and sometimes before they have finished talking. Before you reply, decide whether their turn is complete, and start every response with exactly one of these markers as its very first character:

${complete}  the user's turn is complete: answer them. Write ${complete}, a space, then your full reply. Never write ${complete} on its own.
${short}  the user stopped mid-sentence and will continue in a few seconds. Write ${short} and nothing else.
${long}  the user needs time to think or asked you to wait. Write ${long} and nothing else.

Deciding:
- Complete means conversationally complete, not long. One word can be a complete answer to your question: "yes", "no thanks", "Tuesday", "Japan", "four". A question to you is complete. A correction, or a request to repeat yourself, is complete.
- Grammatically complete is not the same as conversationally complete. If the user has only acknowledged your question or reacted to what you said, without answering it ("that's a good question", "oh wow, okay", "that's interesting", "hmm", "well"), they have not taken their turn yet: ${long}.
- Cut off (${short}): the last words leave a phrase open, in whatever language the user speaks: a sentence that ends on a conjunction, a preposition, an article, or the word for "because"; a list that is still going; a number that is only partly said. A fragment like this is not a request for help. Do not answer it, do not ask what they need, and do not guess the rest: wait with ${short}.
- Needs time (${long}): "hold on", "let me think", "give me a second", "one moment". Filler followed by a real answer, such as "hmm, I'd go to Japan for the food", is complete.
- When the user's latest words continue an earlier fragment (your previous response was ${short} or ${long}), judge the fragments together as one turn. If the combined turn still ends open, ${short}; if it now answers your question, ${complete}.
- If a tool call is the right response, make the tool call; the turn is complete.

Format rules:
- The marker is the first character. No text, quotes, backticks or explanation before it.
- After ${short} or ${long}, output nothing: no words, no explanation, no nudge. The system waits and prompts you again later.
- Exactly one marker per response.

Examples:
- You asked where they would go and the user says "i'd go to japan because i love". Respond with only ${short}.
- The user says "i need help with". Respond with only ${short}.
- You asked for their phone number and the user says "it's five five five". Respond with only ${short}.
- You asked what they want to order and the user says "a large pepperoni pizza a garden salad and". Respond with only ${short}.
- You asked where they would go and the user says "that's a good question let me think". Respond with only ${long}.
- You asked where they would go and the user says "that's interesting". Respond with only ${long}.
- The user says "hold on a second". Respond with only ${long}.
- You asked where they would go and the user says "japan". Respond with ${complete} followed by your reply, for example "${complete} Japan is a wonderful choice. What draws you there?"
- You asked whether to book it and the user says "yes". Respond with ${complete} followed by your reply, for example "${complete} Done, I'll book it now."
- The user says "can you help me book a flight to new york next week". Respond with ${complete} followed by your reply, for example "${complete} Of course. What day would you like to leave, and from which city?"
- Your previous response was ${short} after the user said "i'd go to", and now the user says "japan because". Together that is still open: respond with only ${short}.`;
}

export const USER_TURN_COMPLETION_INSTRUCTIONS = renderCompletionInstructions(
  USER_TURN_COMPLETE_MARKER,
  USER_TURN_INCOMPLETE_SHORT_MARKER,
  USER_TURN_INCOMPLETE_LONG_MARKER,
);

export interface UserTurnCompletionConfigOptions {
  /**
   * Custom instructions for turn completion. If not provided, the default
   * instructions are rendered from the configured markers.
   */
  instructions?: string | null;
  /**
   * Marker the LLM emits when the user turn is complete. It is generated
   * before any speakable text, so prefer a character that is a single token
   * in the model's tokenizer.
   */
  completeMarker?: string;
  /** Marker for a turn cut off mid-thought. */
  incompleteShortMarker?: string;
  /** Marker for a user who needs more time. */
  incompleteLongMarker?: string;
  /** Seconds to wait after a short incomplete before prompting. */
  incompleteShortTimeout?: number;
  /** Seconds to wait after a long incomplete before prompting. */
  incompleteLongTimeout?: number;
  /** Custom prompt when short timeout expires. */
  incompleteShortPrompt?: string | null;
  /** Custom prompt when long timeout expires. */
  incompleteLongPrompt?: string | null;
}

/** Configuration for turn completion behavior. See UserTurnCompletionConfigOptions. */
export class UserTurnCompletionConfig {
  instructions: string | null;
  completeMarker: string;
  incompleteShortMarker: string;
  incompleteLongMarker: string;
  incompleteShortTimeout: number;
  incompleteLongTimeout: number;
  incompleteShortPrompt: string | null;
  incompleteLongPrompt: string | null;

  constructor(options: UserTurnCompletionConfigOptions = {}) {
    this.instructions = options.instructions ?? null;
    this.completeMarker = options.completeMarker ?? USER_TURN_COMPLETE_MARKER;
    this.incompleteShortMarker = options.incompleteShortMarker ?? USER_TURN_INCOMPLETE_SHORT_MARKER;
    this.incompleteLongMarker = options.incompleteLongMarker ?? USER_TURN_INCOMPLETE_LONG_MARKER;
    this.incompleteShortTimeout = options.incompleteShortTimeout ?? 5.0;
    this.incompleteLongTimeout = options.incompleteLongTimeout ?? 10.0;
    this.incompleteShortPrompt = options.incompleteShortPrompt ?? null;
    this.incompleteLongPrompt = options.incompleteLongPrompt ?? null;
  }

  /** The complete, short and long markers, in that order. */
  get markers(): [string, string, string] {
    return [this.completeMarker, this.incompleteShortMarker, this.incompleteLongMarker];
  }

  /** Turn completion instructions, using default if not set. */
  get completionInstructions(): string {
    return this.instructions || renderCompletionInstructions(...this.markers);
  }

  /** Short incomplete prompt, using default if not set. */
  get shortPrompt(): string {
    return this.incompleteShortPrompt || renderIncompleteShortPrompt(...this.markers);
  }

  /** Long incomplete prompt, using default if not set. */
  get longPrompt(): string {
    return this.incompleteLongPrompt || renderIncompleteLongPrompt(...this.markers);
  }
}

/**
 * Members the turn completion mixin adds to an LLM service.
 *
 * The underscore-prefixed members are protected upstream; they are public
 * here because a mixin's members have to appear on its interface.
 */
export interface UserTurnCompletionLLMServiceMixin {
  _turnTextBuffer: string;
  _responseRaw: string;
  _responseMarker: [string, string] | null;
  _turnMarker: TurnMarker | null;
  _turnCompletionBroadcasted: boolean;
  _userTurnCompletionVoiced: boolean;
  _userSpeaking: boolean;
  _userTurnCompletionConfig: UserTurnCompletionConfig;
  _incompleteTimeoutTask: Task<unknown> | null;

  setUserTurnCompletionConfig(config: UserTurnCompletionConfig | null): void;
  _broadcastTurnCompletion(): Promise<void>;
  _startIncompleteTimeout(incompleteType: IncompleteType): Promise<void>;
  _cancelIncompleteTimeout(): Promise<void>;
  _incompleteTimeoutHandler(incompleteType: IncompleteType, timeout: number): Promise<void>;
  _turnReset(): Promise<void>;
  _pushMarker(marker: string, kind: string, appendToContextImmediately?: boolean): Promise<void>;
  _reportResponse(): Promise<void>;
  _pushTurnText(text: string): Promise<void>;
}

/**
 * Mixin that adds turn completion detection to LLM services.
 *
 * This mixin provides methods to push LLM text with turn completion
 * detection. It processes turn completion markers to enable smarter
 * conversation flow:
 *
 * - ● (COMPLETE): Push response normally
 * - ◐ (INCOMPLETE SHORT): Suppress response, wait 5s, then prompt
 * - ○ (INCOMPLETE LONG): Suppress response, wait 10s, then prompt
 *
 * A ● that arrives while VAD still hears the user is stale (the user resumed
 * speaking after the inference was triggered) and is handled as ◐.
 *
 * When incomplete timeouts expire, the mixin automatically prompts the LLM
 * with a contextual follow-up message to re-engage the user.
 *
 * The LLM service controls when to use turn completion by calling
 * `_pushTurnText` instead of `pushFrame`.
 *
 * The mixin requires that the base class is a FrameProcessor (it relies on
 * `pushFrame` with FrameProcessor's signature).
 *
 * Upstream: `class LLMService(UserTurnCompletionLLMServiceMixin, AIService)`
 * → `class LLMService extends UserTurnCompletionLLMServiceMixin(AIService)`.
 *
 * @example
 * // With turn completion:
 * if (this._filterIncompleteUserTurns) {
 *   await this._pushTurnText(chunk.text);
 * } else {
 *   await this.pushFrame(new LLMTextFrame({ text: chunk.text }));
 * }
 */
export const UserTurnCompletionLLMServiceMixin = defineMixin<
  UserTurnCompletionLLMServiceMixin,
  <B extends Ctor>(base: B) => B & Ctor<UserTurnCompletionLLMServiceMixin>
>("UserTurnCompletionLLMServiceMixin", <B extends Ctor>(Base: B) => {
  // The base must be a FrameProcessor (upstream's mixin subclasses it).
  const FrameProcessorBase = Base as unknown as Ctor<FrameProcessor>;
  abstract class UserTurnCompletionLLMServiceMixinImpl
    extends FrameProcessorBase
    implements UserTurnCompletionLLMServiceMixin
  {
    _turnTextBuffer = "";
    // The current response as the LLM produced it, and the marker read from
    // it, reported together when the response ends.
    _responseRaw = "";
    _responseMarker: [string, string] | null = null;
    // Completion verdict for the current LLM response, set when a marker is
    // detected in the text stream. `null` means no marker yet, so keep
    // buffering text until one appears. `INCOMPLETE` also doubles as a safety
    // latch: the prompt tells the LLM to emit only the marker, but if it
    // disobeys and streams more text we keep suppressing it.
    _turnMarker: TurnMarker | null = null;
    // True once `UserTurnInferenceCompletedFrame` has been broadcast for this
    // turn. Prevents double-broadcast when ● and a tool call both occur in the
    // same turn.
    _turnCompletionBroadcasted = false;
    // True once a ● has been voiced since the user last started speaking.
    // Reset on UserStartedSpeakingFrame / InterruptionFrame (new turn) and on
    // VADUserStartedSpeakingFrame (resumed mid-turn), unlike the per-response
    // flags above (reset every LLMFullResponseEnd). The acoustic detector can
    // trigger several inferences within one user turn, each independently
    // producing a ●; this latch voices at most one per speaking segment, so
    // the bot does not immediately repeat itself. It is not a per-turn
    // guarantee: resetting on a mid-turn resume is required so a completion
    // stale-dropped by the controller (see
    // UserTurnController._triggerUserTurnStop) doesn't permanently silence the
    // turn.
    _userTurnCompletionVoiced = false;
    _userSpeaking = false;

    // Timeout handling
    _userTurnCompletionConfig = new UserTurnCompletionConfig();
    _incompleteTimeoutTask: Task<unknown> | null = null;

    /**
     * Set the turn completion configuration.
     *
     * @param config The turn completion configuration, or null to restore the
     *   default configuration.
     */
    setUserTurnCompletionConfig(config: UserTurnCompletionConfig | null): void {
      this._userTurnCompletionConfig = config ?? new UserTurnCompletionConfig();
    }

    /**
     * Broadcast `UserTurnInferenceCompletedFrame` at most once per turn.
     *
     * Called from the two places we know the LLM has committed to a response
     * for the current user turn:
     *
     * - the `●` marker is detected in the text stream
     * - a `FunctionCallsStartedFrame` is emitted — the LLM committed to a tool
     *   call before producing (or instead of) a marker.
     *
     * Broadcasting on the tool-call path matters for races: the downstream
     * `UserStoppedSpeakingFrame` needs to propagate before the function
     * actually executes and a `FunctionCallResultFrame` flows back to the
     * assistant aggregator.
     */
    async _broadcastTurnCompletion(): Promise<void> {
      if (this._turnCompletionBroadcasted) return;
      this._turnCompletionBroadcasted = true;
      await this.broadcastFrame(UserTurnInferenceCompletedFrame);
    }

    /**
     * Start a timeout task for incomplete turn handling.
     *
     * @param incompleteType Whether to use the short or long timeout duration.
     */
    async _startIncompleteTimeout(incompleteType: IncompleteType): Promise<void> {
      // Cancel any existing timeout
      await this._cancelIncompleteTimeout();

      const timeout =
        incompleteType === IncompleteType.SHORT
          ? this._userTurnCompletionConfig.incompleteShortTimeout
          : this._userTurnCompletionConfig.incompleteLongTimeout;

      logger.debug(`Starting ${incompleteType} incomplete timeout (${timeout}s)`);
      this._incompleteTimeoutTask = this.createTask(
        () => this._incompleteTimeoutHandler(incompleteType, timeout),
        `_incomplete_timeout_${incompleteType}`,
      );
    }

    /** Cancel any pending incomplete timeout task. */
    async _cancelIncompleteTimeout(): Promise<void> {
      if (this._incompleteTimeoutTask && !this._incompleteTimeoutTask.done()) {
        logger.debug("Cancelling incomplete timeout");
        await this.cancelTask(this._incompleteTimeoutTask);
      }
      this._incompleteTimeoutTask = null;
    }

    /**
     * Handle incomplete timeout expiration.
     *
     * @param incompleteType Whether this is the short or long timeout.
     * @param timeout The timeout duration in seconds.
     */
    async _incompleteTimeoutHandler(
      incompleteType: IncompleteType,
      timeout: number,
    ): Promise<void> {
      try {
        await sleep(timeout);

        // Timeout expired - reset state before prompting LLM
        logger.debug(`Incomplete ${incompleteType} timeout expired, prompting LLM`);
        await this._turnReset();
        this._incompleteTimeoutTask = null;

        // Get the appropriate prompt
        const prompt =
          incompleteType === IncompleteType.SHORT
            ? this._userTurnCompletionConfig.shortPrompt
            : this._userTurnCompletionConfig.longPrompt;

        // Push through pipeline to trigger LLM response
        await this.pushFrame(
          new LLMMessagesAppendFrame({ messages: [{ role: "developer", content: prompt }] }),
        );
        await this.pushFrame(new LLMRunFrame());
      } catch (e) {
        // Timeout was cancelled (user spoke or interruption). Upstream
        // swallows the CancelledError here; the task still ends as done.
        if (!(e instanceof CancelledError)) throw e;
      }
    }

    /**
     * Reset turn completion state between responses.
     *
     * Call this at the end of each LLM response to clear buffered text and
     * reset state. If no marker was found, pushes the buffered text to avoid
     * losing content.
     *
     * Note: This does NOT cancel pending incomplete timeouts. Timeouts are
     * cancelled on InterruptionFrame (when the user speaks) and on
     * LLMFullResponseStartFrame (when a new inference begins).
     */
    async _turnReset(): Promise<void> {
      // If no marker was found in this response, push the buffered text so
      // it's not lost.
      if (this._turnMarker === null && this._turnTextBuffer) {
        // Graceful degradation: push the buffered text so it's not lost
        logger.warning(
          `${this}: filter_incomplete_user_turns is enabled but LLM response did not ` +
            "contain turn completion markers (●/◐/○). Pushing text anyway. " +
            "The system prompt may be missing turn completion instructions.",
        );
        await this.pushFrame(new LLMTextFrame({ text: this._turnTextBuffer }));
      }

      this._turnTextBuffer = "";
      this._turnMarker = null;
      this._turnCompletionBroadcasted = false;
    }

    /**
     * Process frames, handling turn completion state resets.
     *
     * @param frame The frame to process.
     * @param direction The direction of frame processing.
     */
    override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
      // Handle interruptions by cancelling timeout and resetting state
      if (frame instanceof InterruptionFrame) {
        await this._cancelIncompleteTimeout();
        await this._turnReset();
        this._userTurnCompletionVoiced = false;
      } else if (frame instanceof UserStartedSpeakingFrame) {
        // A new user turn begins, so allow one fresh spoken completion.
        this._userTurnCompletionVoiced = false;
      } else if (frame instanceof LLMMessagesAppendFrame && frame.runLlm) {
        // An externally appended message that asks for a run (e.g. a
        // user-idle check-in) is an explicit request for fresh speech, and it
        // arrives precisely while the user is silent. Clear the voiced latch
        // so the ● guard in `_pushTurnText` does not drop its text.
        this._userTurnCompletionVoiced = false;
      } else if (frame instanceof VADUserStartedSpeakingFrame) {
        this._userSpeaking = true;
        // The user resumed speaking within the same open turn. A new turn's
        // InterruptionFrame does not fire for a resume inside an already-open
        // turn, so two things that normally reset on a fresh turn need
        // handling here instead:
        //
        // 1. An armed ◐/○ re-prompt timeout would otherwise expire and nudge
        //    (talking over) a user who is speaking again. Cancel it. The ◐/○
        //    response already ended and reset the per-response state; the
        //    next inference re-arms a fresh timer if needed.
        await this._cancelIncompleteTimeout();
        // 2. Allow one fresh spoken completion: resetting on a mid-turn
        //    resume is required so a completion stale-dropped by the
        //    controller (see UserTurnController._triggerUserTurnStop) doesn't
        //    permanently silence the turn.
        this._userTurnCompletionVoiced = false;
      } else if (frame instanceof VADUserStoppedSpeakingFrame) {
        this._userSpeaking = false;
      }

      // Pass frame to parent
      await super.processFrame(frame, direction);
    }

    /**
     * Push a frame downstream, resetting turn state at end of each LLM
     * response.
     *
     * `LLMFullResponseEndFrame` is generated by the LLM service itself
     * (pushed, not received), so it must be handled here rather than in
     * `processFrame`.
     *
     * @param frame The frame to push downstream.
     * @param direction The direction of frame flow. Defaults to downstream.
     */
    override async pushFrame(
      frame: Frame,
      direction: FrameDirection = FrameDirection.DOWNSTREAM,
    ): Promise<void> {
      if (frame instanceof FunctionCallsStartedFrame) {
        // Broadcast turn completion now, before the function dispatches —
        // gives `UserStoppedSpeakingFrame` maximum time to propagate so the
        // assistant aggregator's `_userSpeaking` is false by the time a
        // `FunctionCallResultFrame` arrives.
        await this._broadcastTurnCompletion();
        // A function call means a fresh post-tool inference is coming, and
        // that response is expected to speak. Clear the voiced latch so the ●
        // guard in `_pushTurnText` does not drop its text. The response that
        // voiced the ● keeps streaming: its `_turnMarker` is COMPLETE, so its
        // text takes the COMPLETE branch, not the latch guard.
        this._userTurnCompletionVoiced = false;
      } else if (frame instanceof LLMFullResponseStartFrame) {
        // A new LLM response is starting. If an incomplete timeout is still
        // pending from a prior ◐/○, the LLM is already re-engaging: either the
        // user's turn completed and this response carries the ●, or the
        // timeout already fired its own re-prompt. Either way the pending
        // re-prompt is now redundant, so cancel it to avoid running a second
        // inference. This is the single point that resolves the race between
        // the timeout firing and a ● arriving: whichever inference starts
        // first cancels the timeout before its text is parsed.
        await this._cancelIncompleteTimeout();
        this._responseRaw = "";
        this._responseMarker = null;
      } else if (frame instanceof LLMFullResponseEndFrame) {
        await this._reportResponse();
        await this._turnReset();
      }

      await super.pushFrame(frame, direction);
    }

    /** Push the marker read from the response, and remember it for the response's report. */
    async _pushMarker(
      marker: string,
      kind: string,
      appendToContextImmediately = true,
    ): Promise<void> {
      this._responseMarker = [marker, kind];
      await this.pushFrame(new LLMMarkerFrame({ marker, appendToContextImmediately }));
    }

    /** Push the response's raw text and marker, once there was a response to read. */
    async _reportResponse(): Promise<void> {
      if (!this._responseRaw && this._responseMarker === null) return;
      const config = this._userTurnCompletionConfig;
      const [marker, kind] = this._responseMarker ?? [null, null];
      await this.pushFrame(
        new LLMMarkerResponseFrame({
          raw: this._responseRaw,
          marker,
          kind,
          markers: [
            config.completeMarker,
            config.incompleteShortMarker,
            config.incompleteLongMarker,
          ],
        }),
      );
      this._responseRaw = "";
      this._responseMarker = null;
    }

    /**
     * Push LLM text with turn completion detection.
     *
     * This method should be used instead of
     * `pushFrame(new LLMTextFrame({ text }))` when turn completion is enabled.
     * It will:
     * 1. Detect turn markers (●, ◐, or ○)
     * 2. When ◐ (SHORT) is found: suppress text, start short timeout
     * 3. When ○ (LONG) is found: suppress text, start long timeout
     * 4. When ● (COMPLETE) is found: push all text with marker marked as skip_tts
     * 5. After marker detected: all subsequent text flows through immediately
     *
     * @param text The text content from the LLM to push.
     */
    async _pushTurnText(text: string): Promise<void> {
      this._responseRaw += text;

      // One spoken completion per user turn: once a ● has been voiced this
      // user turn, drop text from any later inference (the acoustic detector
      // can trigger several within one turn). `_turnMarker === null` scopes
      // this to *fresh* responses — the response that produced the voiced ●
      // keeps streaming, since by then its marker is COMPLETE.
      if (this._userTurnCompletionVoiced && this._turnMarker === null) return;

      // If we've already detected incomplete, suppress all remaining text.
      // This is a safety mechanism in case the LLM disobeys the prompt and
      // outputs additional text after the marker (e.g., "◐ Please continue...").
      if (this._turnMarker === TurnMarker.INCOMPLETE) return;

      // If ● (COMPLETE) was already found, push text immediately without buffering
      if (this._turnMarker === TurnMarker.COMPLETE) {
        await this.pushFrame(new LLMTextFrame({ text }));
        return;
      }

      const config = this._userTurnCompletionConfig;

      // Add text to buffer
      this._turnTextBuffer += text;

      // Check for incomplete markers (◐ short, ○ long). These indicate the
      // user was cut off or needs time - we suppress the bot's response and
      // start a timeout to re-prompt later.
      let incompleteType: IncompleteType | null = null;
      if (this._turnTextBuffer.includes(config.incompleteShortMarker)) {
        incompleteType = IncompleteType.SHORT;
      } else if (this._turnTextBuffer.includes(config.incompleteLongMarker)) {
        incompleteType = IncompleteType.LONG;
      }

      if (incompleteType) {
        const marker =
          incompleteType === IncompleteType.SHORT
            ? config.incompleteShortMarker
            : config.incompleteLongMarker;
        logger.debug(
          `INCOMPLETE ${incompleteType.toUpperCase()} (${marker}) detected, suppressing text`,
        );
        this._turnMarker = TurnMarker.INCOMPLETE;

        // No UserTurnInferenceCompletedFrame is broadcast here: the turn is
        // explicitly not complete. The re-prompt path is driven by this
        // mixin's own timeout.

        // Persist the marker to context as a stand-alone assistant message
        // via LLMMarkerFrame: the bot produces no spoken output for
        // incomplete turns, so the marker is the entire context entry.
        await this._pushMarker(marker, incompleteType);

        this._turnTextBuffer = "";
        await this._startIncompleteTimeout(incompleteType);
        return;
      }

      // Check for ● (COMPLETE) marker - user's turn was complete, respond normally
      if (this._turnTextBuffer.includes(config.completeMarker)) {
        if (this._userSpeaking) {
          // Stale: the user resumed speaking after this inference was
          // triggered, so the turn isn't over after all. Record it as ◐ and
          // re-arm the short timeout, exactly as if the LLM had said so; the
          // next inference re-evaluates the fuller turn.
          logger.debug(
            `COMPLETE (${config.completeMarker}) detected while user is speaking, ` +
              "treating as stale: suppressing text",
          );
          this._turnMarker = TurnMarker.INCOMPLETE;
          await this._pushMarker(config.incompleteShortMarker, IncompleteType.SHORT);
          this._turnTextBuffer = "";
          await this._startIncompleteTimeout(IncompleteType.SHORT);
          return;
        }

        logger.debug(`COMPLETE (${config.completeMarker}) detected, pushing buffered text`);

        // Latch: this user turn now has its one spoken completion. Later
        // duplicate inferences within the same turn are dropped by the guard
        // at the top of this method.
        this._userTurnCompletionVoiced = true;

        // Any pending incomplete timeout was already cancelled when this
        // response's LLMFullResponseStartFrame arrived (see `pushFrame`).

        // Broadcast that the user turn is complete so a stop strategy gating
        // finalization on this signal (e.g.
        // LLMTurnCompletionUserTurnStopStrategy) can fire
        // `on_user_turn_stopped`. Must fire before the marker so downstream
        // consumers see the signal before the response. Idempotent: a tool
        // call earlier in the turn may have already broadcast.
        await this._broadcastTurnCompletion();

        // Push the marker as a sideband signal that the assistant aggregator
        // will prepend to the upcoming aggregated text, so the context message
        // ends up as "● <response>".
        await this._pushMarker(config.completeMarker, TurnMarker.COMPLETE, false);

        // Split buffer at the marker to handle cases where marker and text
        // arrive in the same chunk (e.g., "● Hello!" from some LLMs)
        const markerPos = this._turnTextBuffer.indexOf(config.completeMarker);
        const markerEnd = markerPos + config.completeMarker.length;

        // Push remaining text after marker as normal speech
        let remainingText = this._turnTextBuffer.slice(markerEnd);
        if (remainingText) {
          // Strip leading space after marker if present (● Hello -> Hello)
          if (remainingText.startsWith(" ")) {
            remainingText = remainingText.slice(1);
          }
          if (remainingText) {
            await this.pushFrame(new LLMTextFrame({ text: remainingText }));
          }
        }

        // Mark complete - all subsequent text flows through immediately
        this._turnTextBuffer = "";
        this._turnMarker = TurnMarker.COMPLETE;
        return;
      }
    }
  }
  return UserTurnCompletionLLMServiceMixinImpl as unknown as B &
    Ctor<UserTurnCompletionLLMServiceMixin>;
});
