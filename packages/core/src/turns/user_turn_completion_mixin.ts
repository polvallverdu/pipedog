// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_turn_completion_mixin.py

/**
 * Mixin for adding turn completion detection to LLM services.
 *
 * This mixin lets LLM services read the turn completion markers (●, ◐, ○) an
 * LLM starts each response with, and report them so a user turn stop strategy
 * can decide whether the user was done.
 */

import {
  type Frame,
  FunctionCallsStartedFrame,
  InterruptionFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMMarkerFrame,
  LLMMarkerResponseFrame,
  LLMTextFrame,
  UserTurnCompletionFrame,
  UserTurnInferenceCompletedFrame,
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
 * - `INCOMPLETE`: ◐/○ detected, the rest of the response is dropped.
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
  _filterIncompleteUserTurns: boolean;
  _contextFrameId: number | null;
  _turnCompletionReported: boolean;
  _turnTextBuffer: string;
  _responseRaw: string;
  _responseMarker: [string, string] | null;
  _turnMarker: TurnMarker | null;
  _userTurnCompletionConfig: UserTurnCompletionConfig;

  setUserTurnCompletionConfig(config: UserTurnCompletionConfig | null): void;
  _turnReset(): Promise<void>;
  _trackPushedFrame(frame: Frame): Promise<void>;
  _pushMarker(marker: string, kind: string): Promise<void>;
  _reportTurnCompletion(kind: string | null, marker: string | null): Promise<void>;
  _reportResponse(): Promise<void>;
  _pushTurnText(text: string): Promise<void>;
}

/**
 * Mixin that reads turn completion markers in LLM responses.
 *
 * Each response starts with a marker: ● (the turn is complete), ◐ (the user
 * will continue shortly) or ○ (the user needs more time). The mixin strips the
 * marker from the spoken text and reports it:
 *
 * - upstream, once per inference, as a `UserTurnCompletionFrame` for the
 *   `LLMTurnCompletionUserTurnStopStrategy` to decide on. A tool call before
 *   any marker reports a complete turn, and a response without a marker
 *   reports no kind (null);
 * - in both directions as a `UserTurnInferenceCompletedFrame` when the turn
 *   is complete;
 * - downstream as an `LLMMarkerFrame`, which the assistant aggregator writes
 *   to the context.
 *
 * Text after ◐ or ○ is not spoken: the marker is the whole response.
 *
 * The LLM service controls when to use turn completion by calling
 * `_pushTurnText` instead of `pushFrame`.
 *
 * The host calls `_trackPushedFrame` with every frame it pushes, before
 * anything decides whether the frame goes out, as `LLMService.pushFrame`
 * does.
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
    // Enabled by LLMTurnCompletionUserTurnStopStrategy over an
    // LLMUpdateSettingsFrame once the pipeline starts.
    _filterIncompleteUserTurns = false;
    // The LLMContextFrame that started the current inference, and whether its
    // turn-completion judgment has been reported upstream yet.
    _contextFrameId: number | null = null;
    _turnCompletionReported = false;
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
    _userTurnCompletionConfig = new UserTurnCompletionConfig();

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
     * Reset turn completion state between responses.
     *
     * Call this at the end of each LLM response to clear buffered text and
     * reset state. If no marker was found, pushes the buffered text to avoid
     * losing content.
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
    }

    /**
     * Process frames, handling turn completion state resets.
     *
     * @param frame The frame to process.
     * @param direction The direction of frame processing.
     */
    override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
      if (frame instanceof InterruptionFrame) {
        await this._turnReset();
      } else if (frame instanceof LLMContextFrame) {
        this._contextFrameId = frame.id;
        this._turnCompletionReported = false;
      }

      // Pass frame to parent
      await super.processFrame(frame, direction);
    }

    /**
     * Follow the response the service is pushing, resetting at its end.
     *
     * The service calls this for every frame it pushes, before anything
     * decides whether the frame goes out: a speculative response the gate
     * drops still ends here, and its marker is reported while the turn waits
     * for it.
     *
     * @param frame The frame the service is about to push.
     */
    async _trackPushedFrame(frame: Frame): Promise<void> {
      if (frame instanceof FunctionCallsStartedFrame) {
        // A tool call is the LLM judging the turn complete. Reported before
        // the function dispatches, so the turn can end before its result
        // reaches the assistant aggregator.
        if (this._filterIncompleteUserTurns) {
          await this._reportTurnCompletion(TurnMarker.COMPLETE, null);
        }
      } else if (frame instanceof LLMFullResponseStartFrame) {
        this._responseRaw = "";
        this._responseMarker = null;
      } else if (frame instanceof LLMFullResponseEndFrame) {
        // A response that ends without a marker or a tool call carries no judgment.
        if (this._filterIncompleteUserTurns) {
          await this._reportTurnCompletion(null, null);
        }
        await this._reportResponse();
        await this._turnReset();
      }
    }

    /** Report the marker read from the response, and push it for the context. */
    async _pushMarker(marker: string, kind: string): Promise<void> {
      this._responseMarker = [marker, kind];
      await this._reportTurnCompletion(kind, marker);
      // Only a complete turn's marker belongs to the response that follows.
      await this.pushFrame(
        new LLMMarkerFrame({ marker, appendToContextImmediately: kind !== "complete" }),
      );
    }

    /**
     * Push the turn-completion judgment upstream, once per inference.
     *
     * A complete turn is also broadcast as a `UserTurnInferenceCompletedFrame`.
     */
    async _reportTurnCompletion(kind: string | null, marker: string | null): Promise<void> {
      if (this._turnCompletionReported) return;
      this._turnCompletionReported = true;
      await this.pushFrame(
        new UserTurnCompletionFrame({ kind, marker, contextFrameId: this._contextFrameId }),
        FrameDirection.UPSTREAM,
      );
      if (kind === TurnMarker.COMPLETE) {
        await this.broadcastFrame(UserTurnInferenceCompletedFrame);
      }
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
     * 1. Buffer text until a turn marker (●, ◐, or ○) appears
     * 2. When ◐ or ○ is found: report it, and drop the rest of the response
     * 3. When ● is found: report it, and push the text after it
     * 4. After ●: all subsequent text flows through immediately
     *
     * @param text The text content from the LLM to push.
     */
    async _pushTurnText(text: string): Promise<void> {
      this._responseRaw += text;

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

      // Check for incomplete markers (◐ short, ○ long): the user was cut off
      // or needs time, and the marker is the whole response.
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

        // Persist the marker to context as a stand-alone assistant message
        // via LLMMarkerFrame: the bot produces no spoken output for
        // incomplete turns, so the marker is the entire context entry.
        await this._pushMarker(marker, incompleteType);

        this._turnTextBuffer = "";
        return;
      }

      // Check for ● (COMPLETE) marker - user's turn was complete, respond normally
      if (this._turnTextBuffer.includes(config.completeMarker)) {
        logger.debug(`COMPLETE (${config.completeMarker}) detected, pushing buffered text`);

        // Push the marker as a sideband signal that the assistant aggregator
        // will prepend to the upcoming aggregated text, so the context message
        // ends up as "● <response>".
        await this._pushMarker(config.completeMarker, TurnMarker.COMPLETE);

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
