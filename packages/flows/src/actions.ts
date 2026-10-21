// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/flows/actions.py

/**
 * Action management system for conversation flows.
 *
 * This module provides the ActionManager class which handles execution of
 * actions during conversation state transitions. It supports:
 *
 * - Built-in actions (TTS, conversation ending)
 * - Custom action registration
 * - Synchronous and asynchronous handlers
 * - Pre and post-transition actions
 * - Error handling and validation
 *
 * Actions are used to perform side effects during conversations, such as:
 *
 * - Text-to-speech output
 * - Database updates
 * - External API calls
 * - Custom integrations
 *
 * Porting notes: every handler is called as `handler(action, flowManager)`.
 * Upstream inspects the signature to call legacy one-parameter handlers with
 * the action alone (deprecated); in JavaScript a handler that declares one
 * parameter simply ignores the second argument.
 */

import { Event, rethrowIfCancelled } from "@pipedog/asyncio";
import {
  BotStoppedSpeakingFrame,
  ControlFrame,
  EndFrame,
  type Frame,
  TTSSpeakFrame,
} from "@pipedog/core/frames/frames";
import type { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { logger } from "@pipedog/core/utils/logger";
import { ActionError } from "./exceptions.ts";
import type { FlowManager } from "./manager.ts";
import type { ActionConfig, FlowActionHandler } from "./types.ts";

export interface FunctionActionFrameOptions {
  /** Action configuration. */
  action: ActionConfig;
  /** Function handler to execute. */
  function: FlowActionHandler;
}

/**
 * Frame containing a function action to be executed.
 *
 * - `action`: action configuration.
 * - `function`: function handler to execute.
 */
export class FunctionActionFrame extends ControlFrame {
  action: ActionConfig;
  function: FlowActionHandler;

  constructor(options: FunctionActionFrameOptions) {
    super(options);
    this.action = options.action;
    this.function = options.function;
  }
}

/** Frame indicating that an action has completed execution. */
export class ActionFinishedFrame extends ControlFrame {}

/** Any action handler: a `FlowActionHandler`, or a handler taking only the action. */
type AnyActionHandler = (action: ActionConfig, flowManager: FlowManager) => unknown;

/** The part of a `PipelineWorker` the action manager uses. */
export type ActionWorker = Pick<
  PipelineWorker,
  "queueFrame" | "queueFrames" | "setReachedDownstreamFilter" | "eventHandler"
>;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Manages the registration and execution of flow actions.
 *
 * Actions are executed during state transitions and can include:
 *
 * - Text-to-speech output
 * - Database updates
 * - External API calls
 * - Custom user-defined actions
 *
 * Built-in actions:
 *
 * - tts_say: Speak text using TTS
 * - end_conversation: End the current conversation
 * - function: Execute inline functions in the pipeline
 *
 * Custom actions can be registered using registerAction().
 */
export class ActionManager {
  _actionHandlers = new Map<string, AnyActionHandler>();
  protected _worker: ActionWorker;
  protected _flowManager: FlowManager;
  protected _ongoingActionsCount = 0;
  protected _ongoingActionsFinishedEvent = new Event();
  protected _deferredPostActions: ActionConfig[] = [];

  /**
   * Initialize the action manager.
   *
   * @param worker PipelineWorker instance used to queue frames.
   * @param flowManager FlowManager instance that this ActionManager is part of.
   */
  constructor(worker: ActionWorker, flowManager: FlowManager) {
    this._worker = worker;
    this._flowManager = flowManager;

    // Register built-in actions
    this._registerAction("tts_say", (action) => this._handleTtsAction(action));
    this._registerAction("end_conversation", (action) => this._handleEndAction(action));
    this._registerAction("function", (action) => this._handleFunctionAction(action));

    // Add pipeline observation
    worker.setReachedDownstreamFilter([
      ActionFinishedFrame,
      FunctionActionFrame,
      BotStoppedSpeakingFrame,
    ]);

    worker.eventHandler("on_frame_reached_downstream", async (_worker: unknown, frame: Frame) => {
      if (frame instanceof FunctionActionFrame) {
        // Run function action
        await frame.function(frame.action, flowManager);
        this._decrementOngoingActionsCount();
      } else if (frame instanceof BotStoppedSpeakingFrame) {
        // Execute deferred post-actions if the bot's turn is over.
        // A BotStoppedSpeakingFrame only indicates that the bot's turn is over if there are
        // no ongoing actions (otherwise one of those actions may have been responsible for it).
        if (this._ongoingActionsCount === 0) {
          await this._executeDeferredPostActions();
        }
      } else if (frame instanceof ActionFinishedFrame) {
        // Handle action finished
        this._decrementOngoingActionsCount();
      }
    });
  }

  /**
   * Register a handler for a specific action type.
   *
   * @param actionType String identifier for the action (e.g., "tts_say").
   * @param handler Async or sync function that handles the action.
   * @throws Error If handler is not callable.
   */
  _registerAction(actionType: string, handler: AnyActionHandler): void {
    if (typeof handler !== "function") {
      throw new Error("Action handler must be callable");
    }
    this._actionHandlers.set(actionType, handler);
    logger.debug(`Registered handler for action type: ${actionType}`);
  }

  /**
   * Execute a list of actions.
   *
   * Each action must have a `type` field matching a registered handler.
   *
   * @param actions List of action configurations to execute.
   * @throws ActionError If action execution fails.
   */
  async executeActions(actions: ActionConfig[] | null | undefined): Promise<void> {
    if (!actions || actions.length === 0) {
      return;
    }

    let previousActionType: string | null = null;
    for (const action of actions) {
      const actionType = action.type;
      if (!actionType) {
        throw new ActionError("Action missing required 'type' field");
      }

      const handler = this._actionHandlers.get(actionType);
      if (!handler) {
        throw new ActionError(`No handler registered for action type: ${actionType}`);
      }

      const ongoingActionsCount = this._ongoingActionsCount;
      try {
        // Based on the type of the previous action and the one coming up, we can determine
        // if we need to wait for ongoing actions to finish before proceeding with this next
        // one
        await this._maybeWaitForOngoingActionsToFinish(previousActionType, actionType);

        // Invoke the handler, awaiting it when it is async.
        const result = handler(action, this._flowManager);
        if (isPromiseLike(result)) {
          await result;
        }

        // Record the type of the action we just executed
        previousActionType = actionType;
        logger.debug(`Successfully executed action: ${actionType}`);

        // If action was end_conversation, break
        // (If we didn't, we could end up waiting for the next actions to finish, and...they
        // never would)
        if (actionType === "end_conversation") {
          break;
        }
      } catch (e) {
        rethrowIfCancelled(e);
        // Undo any increment of ongoing actions count that happened during this action
        if (this._ongoingActionsCount > ongoingActionsCount) {
          this._decrementOngoingActionsCount(); // Assumption: on increment per action
        }
        throw new ActionError(
          `Failed to execute action ${actionType}: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    }

    // Based on the type of the last action, we may need to wait for ongoing actions to finish
    // before considering this set of actions complete.
    await this._maybeWaitForOngoingActionsToFinish(previousActionType, null);
  }

  /**
   * Schedule "deferred" post-actions to be executed after next LLM completion.
   *
   * @param postActions List of actions to execute after LLM response.
   */
  scheduleDeferredPostActions(postActions: ActionConfig[]): void {
    this._deferredPostActions = postActions;
  }

  /** Clear any scheduled deferred post-actions. */
  clearDeferredPostActions(): void {
    this._deferredPostActions = [];
  }

  /** Execute deferred post-actions. */
  protected async _executeDeferredPostActions(): Promise<void> {
    const actions = this._deferredPostActions;
    this._deferredPostActions = [];
    if (actions.length > 0) {
      await this.executeActions(actions);
    }
  }

  /**
   * Wait for ongoing actions to finish before executing the next action if needed.
   *
   * This method determines whether to wait based on the types of the previous
   * and upcoming actions to avoid the upcoming action having an effect before
   * the previous one is done.
   *
   * @param previousActionType Type of the previously executed action, or null
   *   if this is the start of the action sequence.
   * @param upcomingActionType Type of the next action to execute, or null if
   *   this is the end of the action sequence.
   */
  protected async _maybeWaitForOngoingActionsToFinish(
    previousActionType: string | null,
    upcomingActionType: string | null,
  ): Promise<void> {
    let needsWait = false;
    if (previousActionType === "tts_say") {
      // "tts_say" enqueues a TTSSpeakFrame, which has an effect when it hits the TTS node in
      // the pipeline.
      // As long as the upcoming action enqueues a frame with an effect at the same point or
      // later in the pipeline, we don't need to wait.
      // If the upcoming action is:
      // - "tts_say": no need to wait (effect happens at the same point)
      // - "end_conversation": no need to wait (effect happens at the end of the pipeline)
      // - "function": no need to wait (effect happens at the end of the pipeline)
      // - null: wait (we're done with this set of actions; the next thing to occur may be a
      //   node change/LLM context update, which has an effect earlier in the pipeline)
      // - custom action: wait (we don't know what it will do)
      if (
        upcomingActionType === null ||
        !["tts_say", "end_conversation", "function"].includes(upcomingActionType)
      ) {
        needsWait = true; // null or custom action
      }
    } else if (previousActionType === "function") {
      // "function" enqueues a FunctionActionFrame, which has an effect at the end of the
      // pipeline.
      // Functions can take some time to execute (and don't hold up the pipeline as they're
      // doing so), so we need to wait for them to finish before proceeding with the next
      // action or moving on from the current set of actions.
      needsWait = true;
    }
    // Otherwise the previous action was either:
    // - null (the upcoming action is the first one), so there's nothing to wait for.
    // - A fully custom action, where we don't wait. Note that it should not be possible for
    //   the previous action to be "end_conversation", since we stop processing actions after
    //   that one.

    if (needsWait) {
      await this._ongoingActionsFinishedEvent.wait();
    }
  }

  /**
   * Built-in handler for TTS actions.
   *
   * @param action Action configuration. Required `text` key with the text to
   *   speak. Optional `appendTextToContext` key controlling whether the spoken
   *   text is appended to the LLM context. Defaults to true.
   */
  protected async _handleTtsAction(action: ActionConfig): Promise<void> {
    const text = action.text;
    if (!text) {
      logger.error("TTS action missing 'text' field");
      return;
    }

    try {
      // Mark that we're starting the action
      this._incrementOngoingActionsCount();

      // Queue the action frame. Default to appending the spoken text to the
      // context; callers opt out with appendTextToContext: false.
      await this._worker.queueFrame(
        new TTSSpeakFrame({ text, appendToContext: action.appendTextToContext ?? true }),
      );

      // Queue a frame marking the end of the action
      await this._worker.queueFrame(new ActionFinishedFrame());
    } catch (e) {
      rethrowIfCancelled(e);
      this._decrementOngoingActionsCount();
      logger.error(`TTS error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Built-in handler for ending the conversation.
   *
   * This handler queues an EndFrame to terminate the conversation. If the
   * action includes a `text` key, it will queue that text to be spoken before
   * ending.
   *
   * @param action Action configuration. Optional `text` key for a goodbye
   *   message. Optional `appendTextToContext` key controlling whether that
   *   goodbye text is appended to the LLM context. Defaults to true.
   */
  protected async _handleEndAction(action: ActionConfig): Promise<void> {
    // Mark that we're starting the action
    this._incrementOngoingActionsCount();

    // Queue the action frames
    if (action.text) {
      // Optional goodbye message. Default to appending the goodbye text to the
      // context; callers opt out with appendTextToContext: false.
      await this._worker.queueFrame(
        new TTSSpeakFrame({
          text: action.text,
          appendToContext: action.appendTextToContext ?? true,
        }),
      );
    }
    await this._worker.queueFrame(new EndFrame());

    // NOTE: there's no point queueing an ActionFinishedFrame here, since the previously-queued
    // EndFrame ensures that it'll never get delivered to our observer
  }

  /**
   * Built-in handler for queuing functions to run inline in the pipeline.
   *
   * This handler queues a FunctionActionFrame to be executed when the pipeline
   * is done with all the work queued before it. It expects a `handler` key in
   * the action containing the function to execute.
   *
   * @param action Action configuration. Required `handler` key containing the
   *   function to execute.
   */
  protected async _handleFunctionAction(action: ActionConfig): Promise<void> {
    const handler = action.handler;
    if (!handler) {
      logger.error("Function action missing 'handler' field");
      return;
    }

    // Mark that we're starting the action
    this._incrementOngoingActionsCount();

    // Queue the action frame (we're queueing rather than running it here to ensure it happens
    // at the appropriate time in the pipeline, like when the bot's turn is over, for example).
    await this._worker.queueFrame(new FunctionActionFrame({ action, function: handler }));

    // NOTE: we do NOT queue an ActionFinishedFrame here; instead, we will decrement the ongoing
    // actions count when the function has finished executing (the function may take some time)
  }

  /** Increment the count of ongoing actions and reset the finished event if this is the first action. */
  protected _incrementOngoingActionsCount(): void {
    this._ongoingActionsCount += 1;
    if (this._ongoingActionsCount === 1) {
      this._ongoingActionsFinishedEvent.clear();
    }
  }

  /** Decrement the count of ongoing actions and set the finished event if this was the last action. */
  protected _decrementOngoingActionsCount(): void {
    this._ongoingActionsCount = Math.max(0, this._ongoingActionsCount - 1);
    if (this._ongoingActionsCount === 0) {
      this._ongoingActionsFinishedEvent.set();
    }
  }
}
