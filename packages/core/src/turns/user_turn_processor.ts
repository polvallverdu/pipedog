// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_turn_processor.py

/** Frame processor for managing the user turn lifecycle. */

import {
  CancelFrame,
  EagerEndOfTurnCancelFrame,
  EndFrame,
  type Frame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  StartFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "../frames/frames.ts";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "../processors/frame_processor.ts";
import { logger } from "../utils/logger.ts";
import type { UserTurnSpeculation } from "./types.ts";
import { UserIdleController } from "./user_idle_controller.ts";
import type { BaseUserTurnStartStrategy, UserTurnStartedParams } from "./user_start/index.ts";
import type { BaseUserTurnStopStrategy, UserTurnStoppedParams } from "./user_stop/index.ts";
import { UserTurnController } from "./user_turn_controller.ts";
import { UserTurnStrategies } from "./user_turn_strategies.ts";

export interface UserTurnProcessorOptions extends FrameProcessorOptions {
  /** Configured strategies for starting and stopping user turns. */
  userTurnStrategies?: UserTurnStrategies | null;
  /**
   * Timeout in seconds to automatically stop a user turn if no activity is
   * detected.
   */
  userTurnStopTimeout?: number;
  /**
   * Timeout in seconds for detecting user idle state. The processor will emit
   * an `on_user_turn_idle` event when the user has been idle (not speaking)
   * for this duration. Set to 0 to disable idle detection.
   */
  userIdleTimeout?: number;
}

/**
 * Frame processor for managing the user turn lifecycle.
 *
 * This processor uses a turn controller to determine when a user turn starts
 * or stops. The actual frames emitted (e.g., UserStartedSpeakingFrame,
 * UserStoppedSpeakingFrame) or interruptions depend on the configured
 * strategies.
 *
 * Event handlers available:
 *
 * - on_user_turn_started: Emitted when a user turn starts.
 * - on_user_turn_inference_triggered: Emitted when enough signal exists to
 *   start LLM inference. Fires together with `on_user_turn_stopped` for most
 *   strategies; fires alone when a downstream strategy gates finalization on
 *   the LLM's verdict.
 * - on_user_turn_stopped: Emitted when a user turn is semantically final.
 * - on_user_turn_stop_timeout: Emitted if no stop strategy triggers before timeout.
 * - on_user_turn_idle: Emitted when the user has been idle for the configured timeout.
 *
 * @example
 * processor.eventHandler("on_user_turn_started", async (processor, strategy) => { ... });
 * processor.eventHandler("on_user_turn_inference_triggered", async (processor, strategy) => { ... });
 * processor.eventHandler("on_user_turn_stopped", async (processor, strategy) => { ... });
 * processor.eventHandler("on_user_turn_stop_timeout", async (processor) => { ... });
 * processor.eventHandler("on_user_turn_idle", async (processor) => { ... });
 */
export class UserTurnProcessor extends FrameProcessor {
  protected _userTurnController: UserTurnController;
  protected _userIdleController: UserIdleController;

  constructor(options: UserTurnProcessorOptions = {}) {
    super(options);

    this._registerEventHandler("on_user_turn_started");
    this._registerEventHandler("on_user_turn_stopped");
    this._registerEventHandler("on_user_turn_stop_timeout");
    this._registerEventHandler("on_user_turn_idle");
    this._registerEventHandler("on_user_turn_inference_triggered");

    this._userTurnController = new UserTurnController({
      userTurnStrategies: options.userTurnStrategies ?? new UserTurnStrategies(),
      userTurnStopTimeout: options.userTurnStopTimeout ?? 5.0,
    });
    this._userTurnController.addEventHandler("on_push_frame", (_c, frame, direction) =>
      this._onPushFrame(frame, direction),
    );
    this._userTurnController.addEventHandler("on_broadcast_frame", (_c, frameCls, frameOptions) =>
      this._onBroadcastFrame(frameCls, frameOptions),
    );
    this._userTurnController.addEventHandler("on_user_turn_speculation_cancelled", (c) =>
      this._onUserTurnSpeculationCancelled(c),
    );
    this._userTurnController.addEventHandler("on_user_turn_started", (c, strategy, params) =>
      this._onUserTurnStarted(c, strategy, params),
    );
    this._userTurnController.addEventHandler("on_user_turn_stopped", (c, strategy, params) =>
      this._onUserTurnStopped(c, strategy, params),
    );
    this._userTurnController.addEventHandler("on_user_turn_stop_timeout", (c) =>
      this._onUserTurnStopTimeout(c),
    );
    this._userTurnController.addEventHandler(
      "on_user_turn_inference_triggered",
      (c, strategy, speculation) => this._onUserTurnInferenceTriggered(c, strategy, speculation),
    );

    this._userIdleController = new UserIdleController({
      userIdleTimeout: options.userIdleTimeout ?? 0,
    });
    this._userIdleController.addEventHandler("on_user_turn_idle", (c) => this._onUserTurnIdle(c));
  }

  /**
   * Set up the processor.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._userTurnController.setup(setup);
    await this._userIdleController.setup(setup);
  }

  /** Clean up processor resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._cleanup();
  }

  /**
   * Process an incoming frame to detect user turn start or stop.
   *
   * The frame is passed to the user turn controller which is responsible for
   * deciding when a user turn starts or stops and emitting the corresponding
   * events.
   *
   * @param frame The frame to be processed.
   * @param direction The direction of the incoming frame.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof StartFrame) {
      await this.pushFrame(frame, direction);
      await this._userTurnController.start();
    } else if (frame instanceof EndFrame) {
      // Push EndFrame before stop(), because stop() waits on the task to
      // finish and the task finishes when EndFrame is processed.
      await this.pushFrame(frame, direction);
      await this._stop(frame);
    } else if (frame instanceof CancelFrame) {
      await this._cancel(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof ProposedUserStartedSpeakingFrame) {
      // A proposal is resolved once. Forwarding one our own strategies
      // resolve would let a resolver further down the pipeline decide the
      // same turn a second time.
      if (!this._userTurnController.resolvesProposedTurnStartFrames) {
        await this.pushFrame(frame, direction);
      }
    } else if (frame instanceof ProposedUserStoppedSpeakingFrame) {
      if (!this._userTurnController.resolvesProposedTurnStopFrames) {
        await this.pushFrame(frame, direction);
      }
    } else {
      await this.pushFrame(frame, direction);
    }

    await this._userTurnController.processFrame(frame);

    await this._userIdleController.processFrame(frame);
  }

  protected async _stop(_frame: EndFrame): Promise<void> {
    await this._stopControllers();
  }

  protected async _cancel(_frame: CancelFrame): Promise<void> {
    await this._stopControllers();
  }

  protected async _stopControllers(): Promise<void> {
    // Session end stops the controllers' timers; what they hold may be
    // shared, so releasing it waits for cleanup().
    await this._userTurnController.stop();
    await this._userIdleController.stop();
  }

  protected async _cleanup(): Promise<void> {
    await this._userTurnController.cleanup();
    await this._userIdleController.cleanup();
  }

  protected async _onPushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    await this.pushFrame(frame, direction);
  }

  protected async _onBroadcastFrame(
    frameCls: new (options: unknown) => Frame,
    options?: unknown,
  ): Promise<void> {
    await this.broadcastFrame(frameCls, options);
  }

  protected async _onUserTurnSpeculationCancelled(_controller: UserTurnController): Promise<void> {
    await this.broadcastFrame(EagerEndOfTurnCancelFrame);
  }

  protected async _onUserTurnStarted(
    _controller: UserTurnController,
    strategy: BaseUserTurnStartStrategy,
    params: UserTurnStartedParams,
  ): Promise<void> {
    logger.debug(`${this}: User started speaking (strategy: ${strategy})`);

    if (params.enableUserSpeakingFrames) {
      await this.broadcastFrame(UserStartedSpeakingFrame);
    }

    await this._userIdleController.processFrame(new UserStartedSpeakingFrame());

    if (params.enableInterruptions) {
      await this.broadcastInterruption();
    }

    await this._callEventHandler("on_user_turn_started", strategy);
  }

  protected async _onUserTurnStopped(
    _controller: UserTurnController,
    strategy: BaseUserTurnStopStrategy,
    params: UserTurnStoppedParams,
  ): Promise<void> {
    logger.debug(`${this}: User stopped speaking (strategy: ${strategy})`);

    if (params.enableUserSpeakingFrames) {
      await this.broadcastFrame(UserStoppedSpeakingFrame);
    }

    await this._userIdleController.processFrame(new UserStoppedSpeakingFrame());

    await this._callEventHandler("on_user_turn_stopped", strategy);
  }

  protected async _onUserTurnStopTimeout(_controller: UserTurnController): Promise<void> {
    await this._callEventHandler("on_user_turn_stop_timeout");
  }

  protected async _onUserTurnIdle(_controller: UserIdleController): Promise<void> {
    await this._callEventHandler("on_user_turn_idle");
  }

  protected async _onUserTurnInferenceTriggered(
    _controller: UserTurnController,
    strategy: BaseUserTurnStopStrategy,
    _speculation: UserTurnSpeculation | null,
  ): Promise<void> {
    logger.debug(`${this}: User turn inference triggered (strategy: ${strategy})`);
    await this._callEventHandler("on_user_turn_inference_triggered", strategy);
  }
}
