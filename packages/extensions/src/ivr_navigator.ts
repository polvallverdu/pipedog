// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/extensions/ivr/ivr_navigator.py

/**
 * Interactive Voice Response (IVR) navigation components.
 *
 * This module provides classes for automated navigation of IVR phone systems
 * using LLM-based decision making and DTMF tone generation.
 */

import { KeypadEntry } from "@pipedog/core/audio/dtmf/types";
import { VADParams } from "@pipedog/core/audio/vad/vad_analyzer";
import {
  AggregatedTextFrame,
  EndFrame,
  type Frame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMMessagesUpdateFrame,
  LLMTextFrame,
  OutputDTMFUrgentFrame,
  StartFrame,
  TextFrame,
  VADParamsUpdateFrame,
} from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import type { LLMContextMessage } from "@pipedog/core/processors/aggregators/llm_context";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "@pipedog/core/processors/frame_processor";
import type { LLMService } from "@pipedog/core/services/llm_service";
import { logger } from "@pipedog/core/utils/logger";
import {
  MatchAction,
  type PatternMatch,
  PatternPairAggregator,
} from "@pipedog/core/utils/text/pattern_pair_aggregator";

/**
 * IVR navigation status values.
 *
 * These statuses are used to communicate the current state of IVR navigation
 * between the LLM and the IVR processing system.
 */
export const IVRStatus = {
  DETECTED: "detected",
  COMPLETED: "completed",
  STUCK: "stuck",
  WAIT: "wait",
} as const;
export type IVRStatus = (typeof IVRStatus)[keyof typeof IVRStatus];

const IVR_STATUS_VALUES: readonly string[] = Object.values(IVRStatus);
const KEYPAD_VALUES: readonly string[] = Object.values(KeypadEntry);

export interface IVRProcessorOptions extends FrameProcessorOptions {
  /** System prompt for classifying IVR or conversation. */
  classifierPrompt: string;
  /** System prompt for IVR navigation mode. */
  ivrPrompt: string;
  /** VAD parameters for IVR navigation mode. Defaults to `new VADParams({ stopSecs: 2.0 })`. */
  ivrVadParams?: VADParams | null;
}

/**
 * Processes LLM responses for IVR navigation commands.
 *
 * Aggregates XML-tagged commands from LLM text streams and executes
 * corresponding actions like DTMF tone generation and mode switching.
 *
 * Supported features:
 *
 * - DTMF command processing (`<dtmf>1</dtmf>`)
 * - IVR state management (see `IVRStatus`: `<ivr>detected</ivr>`, `<ivr>completed</ivr>`,
 *   `<ivr>stuck</ivr>`, `<ivr>wait</ivr>`)
 * - Automatic prompt and VAD parameter switching
 * - Event emission via `on_ivr_status_changed` for detected, completed, and stuck states
 */
export class IVRProcessor extends FrameProcessor {
  #ivrPrompt: string;
  #ivrVadParams: VADParams;
  #classifierPrompt: string;
  // Saved context messages
  #savedMessages: LLMContextMessage[] = [];
  // XML pattern aggregation
  #aggregator: PatternPairAggregator;

  constructor(options: IVRProcessorOptions) {
    super(options);

    this.#ivrPrompt = options.ivrPrompt;
    this.#ivrVadParams = options.ivrVadParams ?? new VADParams({ stopSecs: 2.0 });
    this.#classifierPrompt = options.classifierPrompt;

    this.#aggregator = new PatternPairAggregator();
    this.#setupXmlPatterns();

    // Register IVR events
    this._registerEventHandler("on_conversation_detected");
    this._registerEventHandler("on_ivr_status_changed");
  }

  /**
   * Update the saved context messages.
   *
   * Sets the messages that are saved when switching between
   * conversation and IVR navigation modes.
   *
   * @param messages List of context messages to save.
   */
  updateSavedMessages(messages: LLMContextMessage[]): void {
    this.#savedMessages = messages;
  }

  /**
   * Get saved context messages without the system message.
   *
   * @returns The saved messages excluding the first system message.
   */
  #getConversationHistory(): LLMContextMessage[] {
    return this.#savedMessages.length > 0 ? this.#savedMessages.slice(1) : [];
  }

  /** Set up XML pattern detection and handlers. */
  #setupXmlPatterns(): void {
    // Register DTMF pattern
    this.#aggregator.addPattern("dtmf", "<dtmf>", "</dtmf>", MatchAction.REMOVE);
    this.#aggregator.onPatternMatch("dtmf", (match) => this.#handleDtmfAction(match));

    // Register mode pattern
    this.#aggregator.addPattern("mode", "<mode>", "</mode>", MatchAction.REMOVE);
    this.#aggregator.onPatternMatch("mode", (match) => this.#handleModeAction(match));

    // Register IVR pattern
    this.#aggregator.addPattern("ivr", "<ivr>", "</ivr>", MatchAction.REMOVE);
    this.#aggregator.onPatternMatch("ivr", (match) => this.#handleIvrAction(match));
  }

  /**
   * Process frames and aggregate XML tag content.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof StartFrame) {
      // Push the StartFrame right away
      await this.pushFrame(frame, direction);

      // Set the classifier prompt and push it upstream
      const messages: LLMContextMessage[] = [
        { role: "developer", content: this.#classifierPrompt },
      ];
      const llmUpdateFrame = new LLMMessagesUpdateFrame({ messages });
      await this.pushFrame(llmUpdateFrame, FrameDirection.UPSTREAM);
    } else if (frame instanceof LLMTextFrame) {
      // Process text through the pattern aggregator
      for await (const result of this.#aggregator.aggregate(frame.text)) {
        // Push aggregated text that doesn't contain XML patterns
        await this.pushFrame(
          new AggregatedTextFrame({ text: result.text, textType: result.type }),
          direction,
        );
      }
    } else if (frame instanceof LLMFullResponseEndFrame || frame instanceof EndFrame) {
      // Flush any remaining text from the aggregator
      const remaining = await this.#aggregator.flush();
      if (remaining) {
        await this.pushFrame(
          new AggregatedTextFrame({ text: remaining.text, textType: remaining.type }),
          direction,
        );
      }
      // Push the end frame
      await this.pushFrame(frame, direction);
    } else {
      await this.pushFrame(frame, direction);
    }
  }

  /**
   * Handle DTMF action by creating and pushing a DTMF frame.
   *
   * @param match The pattern match containing DTMF content.
   */
  async #handleDtmfAction(match: PatternMatch): Promise<void> {
    const value = match.text;
    logger.debug(`DTMF detected: ${value}`);

    // KeypadEntry(value) raises ValueError upstream for anything but a key.
    if (!KEYPAD_VALUES.includes(value)) {
      logger.warning(`Invalid DTMF value: ${value}. Must be 0-9, *, or #`);
      return;
    }
    const dtmfFrame = new OutputDTMFUrgentFrame({ button: value as KeypadEntry });
    await this.pushFrame(dtmfFrame);
    // Push a TextFrame to add DTMF message to the context
    const textFrame = new TextFrame({ text: `<dtmf>${value}</dtmf>` });
    textFrame.skipTts = true;
    await this.pushFrame(textFrame);
  }

  /**
   * Handle IVR status action.
   *
   * @param match The pattern match containing IVR status content.
   */
  async #handleIvrAction(match: PatternMatch): Promise<void> {
    const status = match.text;
    logger.trace(`IVR status detected: ${status}`);

    // Convert string to enum, with validation
    if (!IVR_STATUS_VALUES.includes(status)) {
      logger.warning(`Unknown IVR status: ${status}`);
      return;
    }

    switch (status as IVRStatus) {
      case IVRStatus.DETECTED:
        await this.#handleIvrDetected();
        break;
      case IVRStatus.COMPLETED:
        await this.#handleIvrCompleted();
        break;
      case IVRStatus.STUCK:
        await this.#handleIvrStuck();
        break;
      case IVRStatus.WAIT:
        await this.#handleIvrWait();
        break;
    }

    // Push a TextFrame to add the IVR detected signal to the context
    const ivrTextFrame = new TextFrame({ text: `<ivr>${status}</ivr>` });
    ivrTextFrame.skipTts = true;
    await this.pushFrame(ivrTextFrame);
  }

  /**
   * Handle mode action by switching to the appropriate mode.
   *
   * @param match The pattern match containing mode content.
   */
  async #handleModeAction(match: PatternMatch): Promise<void> {
    const mode = match.text;
    logger.debug(`Mode detected: ${mode}`);
    if (mode === "conversation") {
      await this.#handleConversation();
    } else if (mode === "ivr") {
      await this.#handleIvrDetected();
    }

    // No TextFrame is pushed for the mode selection, as the mode
    // selection conversation is ephemeral and the system message
    // is removed after the mode is detected.
  }

  /**
   * Handle conversation mode by switching to conversation mode.
   *
   * Emit an on_conversation_detected event with saved conversation history.
   */
  async #handleConversation(): Promise<void> {
    logger.debug("Conversation detected - emitting on_conversation_detected event");

    // Extract conversation history for the event handler
    const conversationHistory = this.#getConversationHistory();

    await this._callEventHandler("on_conversation_detected", conversationHistory);
  }

  /**
   * Handle IVR detection by switching to IVR mode.
   *
   * Allows bidirectional switching for error recovery and complex IVR flows.
   * Saves previous messages from the conversation context when available.
   */
  async #handleIvrDetected(): Promise<void> {
    logger.debug("IVR detected - switching to IVR navigation mode");

    // Create new context with IVR system prompt and saved messages
    const messages: LLMContextMessage[] = [{ role: "developer", content: this.#ivrPrompt }];

    // Add saved conversation history if available
    const conversationHistory = this.#getConversationHistory();
    if (conversationHistory.length > 0) {
      messages.push(...conversationHistory);
    }

    // Push the messages upstream and run the LLM with the new context
    const llmUpdateFrame = new LLMMessagesUpdateFrame({ messages, runLlm: true });
    await this.pushFrame(llmUpdateFrame, FrameDirection.UPSTREAM);

    // Update VAD parameters for IVR response timing
    const vadUpdateFrame = new VADParamsUpdateFrame({ params: this.#ivrVadParams });
    await this.pushFrame(vadUpdateFrame, FrameDirection.UPSTREAM);

    // Emit status changed event
    await this._callEventHandler("on_ivr_status_changed", IVRStatus.DETECTED);
  }

  /**
   * Handle IVR completion by triggering the status changed event.
   *
   * Emits on_ivr_status_changed with `IVRStatus.COMPLETED`.
   */
  async #handleIvrCompleted(): Promise<void> {
    logger.debug("IVR navigation completed - triggering status change event");

    await this._callEventHandler("on_ivr_status_changed", IVRStatus.COMPLETED);
  }

  /**
   * Handle IVR stuck state by triggering the status changed event.
   *
   * Emits on_ivr_status_changed with `IVRStatus.STUCK` for external handling of stuck scenarios.
   */
  async #handleIvrStuck(): Promise<void> {
    logger.debug("IVR navigation stuck - triggering status change event");

    await this._callEventHandler("on_ivr_status_changed", IVRStatus.STUCK);
  }

  /**
   * Handle IVR wait state when transcription is incomplete.
   *
   * The LLM is indicating it needs more information to make a decision.
   * This is a no-op since the system will continue to provide more transcription.
   */
  async #handleIvrWait(): Promise<void> {
    logger.debug("IVR waiting for more complete transcription");
  }
}

export interface IVRNavigatorOptions {
  /** LLM service for text generation and decision making. */
  llm: LLMService;
  /** Navigation goal prompt integrated with IVR navigation instructions. */
  ivrPrompt: string;
  /** VAD parameters for IVR navigation mode. Defaults to `new VADParams({ stopSecs: 2.0 })`. */
  ivrVadParams?: VADParams | null;
}

/**
 * Pipeline for automated IVR system navigation.
 *
 * Orchestrates LLM-based IVR navigation by combining an LLM service with
 * IVR processing capabilities. Starts with mode classification to classify input
 * as conversation or IVR system.
 *
 * Navigation behavior:
 *
 * - Detects conversation vs IVR systems automatically
 * - Navigates IVR menus using DTMF tones and verbal responses
 * - Provides event hooks for mode classification and status changes
 *   (on_conversation_detected, on_ivr_status_changed)
 * - Developers control conversation handling via the on_conversation_detected event
 */
export class IVRNavigator extends Pipeline {
  static readonly CLASSIFIER_PROMPT =
    `You are an IVR detection classifier. Analyze the transcribed text to determine if it's an automated IVR system or a live human conversation.

IVR SYSTEM (respond \`<mode>ivr</mode>\`):
- Menu options: "Press 1 for billing", "Press 2 for technical support", "Press 0 to speak to an agent"
- Automated instructions: "Please enter your account number", "Say or press your selection", "Enter your phone number followed by the pound key"
- System prompts: "Thank you for calling [company]", "Your call is important to us", "Please hold while we connect you"
- Scripted introductions: "Welcome to [company] customer service", "For faster service, have your account number ready"
- Navigation phrases: "To return to the main menu", "Press star to repeat", "Say 'agent' or press 0"
- Hold messages: "Please continue to hold", "Your estimated wait time is", "Thank you for your patience"
- Carrier messages: "All circuits are busy", "Due to high call volume"

HUMAN CONVERSATION (respond \`<mode>conversation</mode>\`):
- Personal greetings: "Hello, this is Sarah", "Good morning, how can I help you?", "Customer service, this is Mike"
- Interactive responses: "Who am I speaking with?", "What can I do for you today?", "How are you calling about?"
- Natural speech patterns: hesitations, informal language, conversational flow
- Direct engagement: "I see you're calling about...", "Let me look that up for you", "Can you spell that for me?"
- Spontaneous responses: "Oh, I can help with that", "Sure, no problem", "Hmm, let me check"

RESPOND ONLY with either:
- \`<mode>ivr</mode>\` for IVR system
- \`<mode>conversation</mode>\` for human conversation`;

  static readonly IVR_NAVIGATION_BASE =
    `You are navigating an Interactive Voice Response (IVR) system to accomplish a specific goal. You receive text transcriptions of the IVR system's audio prompts and menu options.

YOUR NAVIGATION GOAL:
{goal}

NAVIGATION RULES:
1. When you see menu options with keypress instructions (e.g., "Press 1 for...", "Press 2 for..."), ONLY respond with a keypress if one of the options aligns with your navigation goal
2. If an option closely matches your goal, respond with: \`<dtmf>NUMBER</dtmf>\` (e.g., \`<dtmf>1</dtmf>\`)
3. For sequences of numbers (dates, account numbers, phone numbers), enter each digit separately: \`<dtmf>1</dtmf><dtmf>2</dtmf><dtmf>3</dtmf>\` for "123"
4. When the system asks for verbal responses (e.g., "Say Yes or No", "Please state your name", "What department?"), respond with natural language text ending with punctuation
5. If multiple options seem relevant, choose the most specific or direct path
6. If NO options are relevant to your goal, respond with \`<ivr>wait</ivr>\` - the system may present more options
7. If the transcription is incomplete or unclear, respond with \`<ivr>wait</ivr>\` to indicate you need more information

COMPLETION CRITERIA - Respond with \`<ivr>completed</ivr>\` when:
- You see "Please hold while I transfer you" or similar transfer language
- You see "You're being connected to..." or "Connecting you to..."
- The system says "One moment please" after selecting your final option
- The system indicates you've reached the target department/service
- You've successfully navigated to your goal and are being transferred to a human

WAIT CRITERIA - Respond with \`<ivr>wait</ivr>\` when:
- NONE of the presented options are relevant to your navigation goal
- The transcription appears to be cut off mid-sentence
- You can see partial menu options but the list seems incomplete
- The transcription is unclear or garbled
- You suspect there are more options that weren't captured in the transcription
- The system presents options for specific user types that don't apply to your goal

IMPORTANT: Do NOT feel pressured to select an option if none match your goal. Waiting is often the correct response when the IVR system is presenting partial menus or options intended for different user types.

STUCK CRITERIA - Respond with \`<ivr>stuck</ivr>\` when:
- You've been through the same menu options 3+ times without progress
- No available options relate to your goal after careful consideration
- You encounter an error message or "invalid selection" repeatedly
- The system asks for information you don't have (account numbers, PINs, etc.)
- You reach a dead end with no relevant options and no way back

STRATEGY TIPS:
- Look for keywords in menu options that match your goal
- Try general options like "Customer Service" or "Other Services" if specific options aren't available
- Pay attention to sub-menus. Sometimes the path requires multiple steps through different menu layers
- If you see "For all other inquiries, press..." that's often a good fallback option
- Remember that reaching your goal may require navigating through several menu levels
- Be patient - IVR systems often present options in waves, and waiting for the right option is better than selecting the wrong one

SEQUENCE INPUT EXAMPLES:
- For date of birth "01/15/1990": \`<dtmf>0</dtmf><dtmf>1</dtmf><dtmf>1</dtmf><dtmf>5</dtmf><dtmf>1</dtmf><dtmf>9</dtmf><dtmf>9</dtmf><dtmf>0</dtmf>\`
- For account number "12345": \`<dtmf>1</dtmf><dtmf>2</dtmf><dtmf>3</dtmf><dtmf>4</dtmf><dtmf>5</dtmf>\`
- For phone number last 4 digits "6789": \`<dtmf>6</dtmf><dtmf>7</dtmf><dtmf>8</dtmf><dtmf>9</dtmf>\`

VERBAL RESPONSE EXAMPLES:
- "Is your date of birth 01/15/1990? Say Yes or No" → "Yes."
- "Please state your first and last name" → "John Smith."
- "What department are you trying to reach?" → "Billing."
- "Are you calling about an existing order? Please say Yes or No" → "No."
- "Did I hear that correctly? Please say Yes or No" → "Yes."

Remember: Respond with \`<dtmf>NUMBER</dtmf>\` (single or multiple for sequences), \`<ivr>completed</ivr>\`, \`<ivr>stuck</ivr>\`, \`<ivr>wait</ivr>\`, OR natural language text when verbal responses are requested. No other response types.`;

  #llm: LLMService;
  #ivrPrompt: string;
  #ivrVadParams: VADParams;
  #classifierPrompt: string;
  #ivrProcessor: IVRProcessor;

  /**
   * Initialize the IVR navigator.
   *
   * @param options.llm LLM service for text generation and decision making.
   * @param options.ivrPrompt Navigation goal prompt integrated with IVR navigation instructions.
   * @param options.ivrVadParams VAD parameters for IVR navigation mode.
   */
  constructor(options: IVRNavigatorOptions) {
    const ivrPrompt = IVRNavigator.IVR_NAVIGATION_BASE.replace("{goal}", () => options.ivrPrompt);
    const ivrVadParams = options.ivrVadParams ?? new VADParams({ stopSecs: 2.0 });
    const classifierPrompt = IVRNavigator.CLASSIFIER_PROMPT;

    const ivrProcessor = new IVRProcessor({ classifierPrompt, ivrPrompt, ivrVadParams });

    // Add the IVR processor to the pipeline
    super([options.llm, ivrProcessor]);

    this.#llm = options.llm;
    this.#ivrPrompt = ivrPrompt;
    this.#ivrVadParams = ivrVadParams;
    this.#classifierPrompt = classifierPrompt;
    this.#ivrProcessor = ivrProcessor;

    // Register IVR events
    this._registerEventHandler("on_conversation_detected");
    this._registerEventHandler("on_ivr_status_changed");
  }

  /** The LLM service the navigator drives. */
  get llm(): LLMService {
    return this.#llm;
  }

  /** The IVR processor that handles the LLM's commands. */
  get ivrProcessor(): IVRProcessor {
    return this.#ivrProcessor;
  }

  /** The full IVR navigation prompt, with the goal filled in. */
  get ivrPrompt(): string {
    return this.#ivrPrompt;
  }

  /** The VAD parameters used in IVR navigation mode. */
  get ivrVadParams(): VADParams {
    return this.#ivrVadParams;
  }

  /** The prompt that classifies IVR or conversation. */
  get classifierPrompt(): string {
    return this.#classifierPrompt;
  }

  /**
   * Process frames at the pipeline level to intercept context frames.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    if (frame instanceof LLMContextFrame) {
      // Extract messages and pass to IVR processor
      const allMessages = frame.context.getMessages();

      // Store messages in the IVR processor for mode switching
      this.#ivrProcessor.updateSavedMessages(allMessages);
    }

    // Let the pipeline handle normal frame processing
    await super.processFrame(frame, direction);
  }

  /**
   * Add event handler for IVR navigation events.
   *
   * The handlers of `on_conversation_detected` and `on_ivr_status_changed` are
   * registered on the IVR processor.
   *
   * - on_conversation_detected: receives the IVRProcessor and the conversation history list.
   * - on_ivr_status_changed: receives the IVRProcessor and the `IVRStatus` value.
   *
   * @param eventName Event name ("on_conversation_detected", "on_ivr_status_changed").
   * @param handler Async function called when the event occurs.
   */
  override addEventHandler(eventName: string, handler: (...args: any[]) => unknown): void {
    if (eventName === "on_conversation_detected" || eventName === "on_ivr_status_changed") {
      this.#ivrProcessor.addEventHandler(eventName, handler as never);
    } else {
      super.addEventHandler(eventName, handler as never);
    }
  }
}
