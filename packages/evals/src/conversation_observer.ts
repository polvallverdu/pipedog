// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/conversation_observer.py

/**
 * Observer that records a bot's conversation as a conversation file holds it.
 *
 * It lets a call the harness didn't drive, such as a production one, be judged
 * with `pipedog-eval judge` against a simulation's `success` and metrics.
 */

import {
  ExternalFunctionCallCancelFrame,
  ExternalFunctionCallInProgressFrame,
  FunctionCallCancelFrame,
  FunctionCallInProgressFrame,
  LLMContextAssistantTurnFrame,
  LLMContextUserTurnFrame,
} from "@pipedog/core/frames/frames";
import {
  BaseObserver,
  type BaseObserverOptions,
  type FramePushed,
} from "@pipedog/core/observers/base_observer";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { RTVISendTextFrame } from "@pipedog/core/processors/frameworks/rtvi/frames";
import { EvalConversation, type EvalConversationMessage } from "./conversation.ts";

export interface EvalConversationEndedMessageOptions {
  /**
   * The conversation's messages, as a conversation file holds them (see
   * `conversation.ts`).
   */
  conversation: EvalConversationMessage[];
}

/** A message accompanying `on_conversation_ended`. */
export class EvalConversationEndedMessage {
  conversation: EvalConversationMessage[];

  constructor(options: EvalConversationEndedMessageOptions) {
    this.conversation = options.conversation;
  }
}

export interface EvalConversationObserverOptions
  extends Omit<BaseObserverOptions, "observeEveryPush"> {}

/**
 * Records a bot's conversation, and reports it once the pipeline is done.
 *
 * Each side's turn is what the context aggregators write to the LLM context,
 * so the user's turns are what the bot heard and the bot's turns are what it
 * said, cut where the user interrupted it. Text a client sends with RTVI's
 * `send-text` is a user turn too, since it goes to the context as is. Each
 * turn is recorded as it is written, so summarizing the context later doesn't
 * lose it, and the context's other messages, such as Flows' tool changes, stay
 * out.
 *
 * It records what passes through the worker it is attached to: in a bot with
 * several workers, that is the one holding the conversation's context, and
 * calls made in other workers are not in it.
 *
 * Events:
 * - `on_conversation_ended(observer, message)`: emitted once the pipeline is
 *   done, with an `EvalConversationEndedMessage` holding the conversation.
 *
 * @example
 * ```ts
 * const observer = new EvalConversationObserver();
 * observer.eventHandler("on_conversation_ended", async (_observer, message) => {
 *   await writeFile("call.conversation.json", pyJsonDumps(message.conversation, { indent: 2 }));
 * });
 * const worker = new PipelineWorker(pipeline, { observers: [observer] });
 * ```
 */
export class EvalConversationObserver extends BaseObserver {
  protected _conversation: EvalConversation;

  constructor(options: EvalConversationObserverOptions = {}) {
    super({ ...options, observeEveryPush: false });
    this._conversation = new EvalConversation();

    this._registerEventHandler("on_conversation_ended");
  }

  /**
   * Add what a frame says about the conversation to it.
   *
   * @param data The frame push event data.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    const frame = data.frame;

    // These frames are broadcast, arriving as two frames, each pushed for
    // the first time once. Read the downstream one.
    if (frame.broadcastSiblingId !== null && data.direction !== FrameDirection.DOWNSTREAM) {
      return;
    }

    if (frame instanceof LLMContextUserTurnFrame && frame.speculation) {
      // The turn is added once it ends, as written to the context.
      return;
    }
    if (frame instanceof LLMContextUserTurnFrame || frame instanceof RTVISendTextFrame) {
      this._conversation.addUserMessage(frame.text);
    } else if (frame instanceof LLMContextAssistantTurnFrame) {
      this._conversation.addAssistantMessage(frame.text);
    } else if (
      frame instanceof FunctionCallInProgressFrame ||
      frame instanceof ExternalFunctionCallInProgressFrame
    ) {
      this._conversation.addToolCall(
        frame.functionName,
        (frame.arguments as Record<string, unknown> | null | undefined) || {},
      );
    } else if (
      frame instanceof FunctionCallCancelFrame ||
      frame instanceof ExternalFunctionCallCancelFrame
    ) {
      this._conversation.cancelToolCall(frame.functionName);
    }
  }

  /** Report the conversation: the pipeline is done, and so is the bot's last turn. */
  override async cleanup(): Promise<void> {
    this._conversation.endBotTurn();
    const message = new EvalConversationEndedMessage({
      conversation: this._conversation.messages,
    });
    await this._callEventHandler("on_conversation_ended", message);
    await super.cleanup();
  }
}
