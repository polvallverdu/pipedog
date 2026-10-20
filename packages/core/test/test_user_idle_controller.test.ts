// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_user_idle_controller.py

import { beforeEach, describe, expect, test } from "bun:test";

import { sleep } from "@pipecat-ts/asyncio";

import { SystemClock } from "../src/clocks/system_clock.ts";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type FunctionCallFromLLM,
  FunctionCallResultFrame,
  FunctionCallsStartedFrame,
  UserIdleTimeoutUpdateFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "../src/processors/frame_processor.ts";
import { UserIdleController } from "../src/turns/user_idle_controller.ts";
import { type BaseTaskManager, TaskManager } from "../src/utils/asyncio/task_manager.ts";

/**
 * Build a setup configuration for a processor used outside a pipeline.
 *
 * Local port of upstream tests/frame_processor_helpers.py `frame_processor_setup`.
 */
function frameProcessorSetup(
  taskManager: BaseTaskManager | null = null,
  options: Partial<FrameProcessorSetupOptions> = {},
): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    ...options,
    taskManager: taskManager as BaseTaskManager,
  });
}

/** Stand-in for upstream's `unittest.mock.Mock()` function call. */
function mockFunctionCall(): FunctionCallFromLLM {
  return {} as FunctionCallFromLLM;
}

const USER_IDLE_TIMEOUT = 0.2;

describe("TestUserIdleController", () => {
  let taskManager: TaskManager;

  beforeEach(() => {
    taskManager = new TaskManager();
  });

  test("test_idle_after_bot_stops_speaking", async () => {
    // Test that idle event fires after BotStoppedSpeakingFrame + timeout.
    const controller = new UserIdleController({ userIdleTimeout: USER_IDLE_TIMEOUT });
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    await controller.processFrame(new BotStoppedSpeakingFrame());

    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(true);

    await controller.cleanup();
  });

  test("test_user_speaking_cancels_timer", async () => {
    // Test that UserStartedSpeakingFrame cancels the idle timer.
    const controller = new UserIdleController({ userIdleTimeout: USER_IDLE_TIMEOUT });
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    await controller.processFrame(new BotStoppedSpeakingFrame());
    await sleep(USER_IDLE_TIMEOUT * 0.3);
    await controller.processFrame(new UserStartedSpeakingFrame());

    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(false);

    await controller.cleanup();
  });

  test("test_bot_speaking_cancels_timer", async () => {
    // Test that BotStartedSpeakingFrame cancels the idle timer.
    const controller = new UserIdleController({ userIdleTimeout: USER_IDLE_TIMEOUT });
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    await controller.processFrame(new BotStoppedSpeakingFrame());
    await sleep(USER_IDLE_TIMEOUT * 0.3);
    await controller.processFrame(new BotStartedSpeakingFrame());

    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(false);

    await controller.cleanup();
  });

  test("test_no_idle_before_bot_speaks", async () => {
    // Test that idle does not fire if no BotStoppedSpeakingFrame is received.
    const controller = new UserIdleController({ userIdleTimeout: USER_IDLE_TIMEOUT });
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    // Wait without any frames
    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(false);

    await controller.cleanup();
  });

  test("test_interruption_no_false_trigger", async () => {
    // Test that BotStoppedSpeakingFrame during a user turn does not start the timer.
    const controller = new UserIdleController({ userIdleTimeout: USER_IDLE_TIMEOUT });
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    // User starts speaking (interruption)
    await controller.processFrame(new UserStartedSpeakingFrame());
    // Bot stops speaking due to interruption
    await controller.processFrame(new BotStoppedSpeakingFrame());

    // Wait - timer should NOT have started because user turn is in progress
    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(false);

    await controller.cleanup();
  });

  test("test_idle_cycle", async () => {
    // Test that idle fires, then can fire again after another bot speaking cycle.
    const controller = new UserIdleController({ userIdleTimeout: USER_IDLE_TIMEOUT });
    await controller.setup(frameProcessorSetup(taskManager));

    let idleCount = 0;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleCount += 1;
    });

    // First cycle: bot stops → idle fires
    await controller.processFrame(new BotStoppedSpeakingFrame());
    await sleep(USER_IDLE_TIMEOUT + 0.1);
    expect(idleCount).toEqual(1);

    // Second cycle: bot starts → bot stops → idle fires again
    await controller.processFrame(new BotStartedSpeakingFrame());
    await controller.processFrame(new BotStoppedSpeakingFrame());
    await sleep(USER_IDLE_TIMEOUT + 0.1);
    expect(idleCount).toEqual(2);

    await controller.cleanup();
  });

  test("test_cleanup_cancels_timer", async () => {
    // Test that cleanup cancels a pending idle timer.
    const controller = new UserIdleController({ userIdleTimeout: USER_IDLE_TIMEOUT });
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    await controller.processFrame(new BotStoppedSpeakingFrame());
    await sleep(USER_IDLE_TIMEOUT * 0.3);
    await controller.cleanup();

    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(false);
  });

  test("test_function_call_cancels_timer", async () => {
    // Test normal ordering: BotStopped starts timer, FunctionCallsStarted cancels it.
    const controller = new UserIdleController({ userIdleTimeout: USER_IDLE_TIMEOUT });
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    // Bot finishes speaking, timer starts
    await controller.processFrame(new BotStoppedSpeakingFrame());
    // Function call starts shortly after, cancels the timer
    await sleep(USER_IDLE_TIMEOUT * 0.3);
    await controller.processFrame(
      new FunctionCallsStartedFrame({ functionCalls: [mockFunctionCall()] }),
    );

    // Wait longer than timeout — should not fire
    await sleep(USER_IDLE_TIMEOUT + 0.1);
    expect(idleTriggered).toBe(false);

    await controller.cleanup();
  });

  test("test_function_call_suppresses_timer", async () => {
    // Test race condition: FunctionCallsStarted arrives before BotStopped.
    //
    // A race condition can cause FunctionCallsStarted to arrive before
    // BotStoppedSpeaking. The counter guard prevents the timer from starting
    // while a function call is in progress.
    const controller = new UserIdleController({ userIdleTimeout: USER_IDLE_TIMEOUT });
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    // LLM emits function call and "let me check" concurrently
    await controller.processFrame(
      new FunctionCallsStartedFrame({ functionCalls: [mockFunctionCall()] }),
    );
    await controller.processFrame(new BotStartedSpeakingFrame());
    await controller.processFrame(new BotStoppedSpeakingFrame());

    // Wait longer than timeout — should not fire (function call in progress)
    await sleep(USER_IDLE_TIMEOUT + 0.1);
    expect(idleTriggered).toBe(false);

    // Function call completes, bot speaks result
    await controller.processFrame(
      new FunctionCallResultFrame({
        functionName: "test",
        toolCallId: "123",
        arguments: {},
        result: "ok",
      }),
    );
    await controller.processFrame(new BotStartedSpeakingFrame());
    await controller.processFrame(new BotStoppedSpeakingFrame());

    // Now the timer should start and fire
    await sleep(USER_IDLE_TIMEOUT + 0.1);
    expect(idleTriggered).toBe(true);

    await controller.cleanup();
  });

  test("test_disabled_by_default", async () => {
    // Test that timeout=0 means idle detection is disabled.
    const controller = new UserIdleController();
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    await controller.processFrame(new BotStoppedSpeakingFrame());
    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(false);

    await controller.cleanup();
  });

  test("test_enable_via_frame", async () => {
    // Test enabling idle detection at runtime via UserIdleTimeoutUpdateFrame.
    const controller = new UserIdleController();
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    // Initially disabled — no idle fires
    await controller.processFrame(new BotStoppedSpeakingFrame());
    await sleep(USER_IDLE_TIMEOUT + 0.1);
    expect(idleTriggered).toBe(false);

    // Enable idle detection
    await controller.processFrame(new UserIdleTimeoutUpdateFrame({ timeout: USER_IDLE_TIMEOUT }));
    await controller.processFrame(new BotStoppedSpeakingFrame());
    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(true);

    await controller.cleanup();
  });

  test("test_disable_via_frame", async () => {
    // Test disabling idle detection at runtime via UserIdleTimeoutUpdateFrame.
    const controller = new UserIdleController({ userIdleTimeout: USER_IDLE_TIMEOUT });
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    // Start the timer
    await controller.processFrame(new BotStoppedSpeakingFrame());
    await sleep(USER_IDLE_TIMEOUT * 0.3);

    // Disable — should cancel running timer
    await controller.processFrame(new UserIdleTimeoutUpdateFrame({ timeout: 0 }));

    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(false);

    await controller.cleanup();
  });

  test("test_update_applies_to_running_timer", async () => {
    // Test that a timeout update restarts a running timer with the new duration.
    const controller = new UserIdleController({ userIdleTimeout: 10 });
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    // Timer starts with the long timeout
    await controller.processFrame(new BotStoppedSpeakingFrame());
    // Retune to a short timeout while the timer is running
    await controller.processFrame(new UserIdleTimeoutUpdateFrame({ timeout: USER_IDLE_TIMEOUT }));

    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(true);

    await controller.cleanup();
  });

  test("test_enable_via_frame_arms_while_idle", async () => {
    // Test that enabling via frame arms the timer when everything is already idle.
    const controller = new UserIdleController();
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    // Bot finished speaking while idle detection was disabled
    await controller.processFrame(new BotStartedSpeakingFrame());
    await controller.processFrame(new BotStoppedSpeakingFrame());

    // Enable idle detection — no further speaking events will re-arm
    await controller.processFrame(new UserIdleTimeoutUpdateFrame({ timeout: USER_IDLE_TIMEOUT }));

    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(true);

    await controller.cleanup();
  });

  test("test_update_while_bot_speaking_does_not_arm", async () => {
    // Test that a timeout update while the bot is speaking does not arm the timer.
    const controller = new UserIdleController();
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    await controller.processFrame(new BotStartedSpeakingFrame());
    await controller.processFrame(new UserIdleTimeoutUpdateFrame({ timeout: USER_IDLE_TIMEOUT }));

    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(false);

    await controller.cleanup();
  });

  test("test_update_before_first_bot_turn_does_not_arm", async () => {
    // Test that a timeout update before the bot has spoken does not arm the timer.
    const controller = new UserIdleController();
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    await controller.processFrame(new UserIdleTimeoutUpdateFrame({ timeout: USER_IDLE_TIMEOUT }));

    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(false);

    await controller.cleanup();
  });

  test("test_update_while_user_turn_in_progress_does_not_arm", async () => {
    // Test that a timeout update during a user turn does not arm the timer.
    const controller = new UserIdleController();
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    await controller.processFrame(new BotStartedSpeakingFrame());
    await controller.processFrame(new UserStartedSpeakingFrame());
    await controller.processFrame(new BotStoppedSpeakingFrame());
    await controller.processFrame(new UserIdleTimeoutUpdateFrame({ timeout: USER_IDLE_TIMEOUT }));

    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(false);

    await controller.cleanup();
  });

  test("test_update_while_awaiting_bot_response_does_not_arm", async () => {
    // Test that a timeout update between a user turn and the bot's response does not arm.
    const controller = new UserIdleController();
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    // User finished a turn; the bot's response is still in flight.
    await controller.processFrame(new UserStartedSpeakingFrame());
    await controller.processFrame(new UserStoppedSpeakingFrame());
    await controller.processFrame(new UserIdleTimeoutUpdateFrame({ timeout: USER_IDLE_TIMEOUT }));

    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(false);

    await controller.cleanup();
  });

  test("test_update_while_function_call_in_progress_does_not_arm", async () => {
    // Test that a timeout update during a function call does not arm the timer.
    const controller = new UserIdleController();
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    await controller.processFrame(new BotStartedSpeakingFrame());
    await controller.processFrame(new BotStoppedSpeakingFrame());
    await controller.processFrame(
      new FunctionCallsStartedFrame({ functionCalls: [mockFunctionCall()] }),
    );
    await controller.processFrame(new UserIdleTimeoutUpdateFrame({ timeout: USER_IDLE_TIMEOUT }));

    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(false);

    await controller.cleanup();
  });

  test("test_wait_for_user_arms_timer", async () => {
    // Test that wait_for_user arms the timer after a user turn.
    const controller = new UserIdleController({ userIdleTimeout: USER_IDLE_TIMEOUT });
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    // The user speaks while the bot is idle: the timer is cancelled and
    // nothing else would restart it.
    await controller.processFrame(new BotStoppedSpeakingFrame());
    await controller.processFrame(new UserStartedSpeakingFrame());
    await controller.processFrame(new UserStoppedSpeakingFrame());
    await controller.waitForUser();

    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(true);

    await controller.cleanup();
  });

  test("test_wait_for_user_while_bot_speaking_does_not_arm", async () => {
    // Test that wait_for_user does nothing while the bot is speaking.
    const controller = new UserIdleController({ userIdleTimeout: USER_IDLE_TIMEOUT });
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    await controller.processFrame(new BotStartedSpeakingFrame());
    await controller.waitForUser();

    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(false);

    await controller.cleanup();
  });

  test("test_wait_for_user_during_function_call_does_not_arm", async () => {
    // Test that wait_for_user does nothing while a function call is pending.
    const controller = new UserIdleController({ userIdleTimeout: USER_IDLE_TIMEOUT });
    await controller.setup(frameProcessorSetup(taskManager));

    let idleTriggered = false;
    controller.eventHandler("on_user_turn_idle", async () => {
      idleTriggered = true;
    });

    await controller.processFrame(
      new FunctionCallsStartedFrame({ functionCalls: [mockFunctionCall()] }),
    );
    await controller.waitForUser();

    await sleep(USER_IDLE_TIMEOUT + 0.1);

    expect(idleTriggered).toBe(false);

    await controller.cleanup();
  });

  test("test_waiting_for_user", async () => {
    // Test that waiting_for_user follows the bot finishing and the user speaking.
    const controller = new UserIdleController({ userIdleTimeout: USER_IDLE_TIMEOUT });
    await controller.setup(frameProcessorSetup(taskManager));

    expect(controller.waitingForUser).toBe(false);
    await controller.processFrame(new BotStoppedSpeakingFrame());
    expect(controller.waitingForUser).toBe(true);
    await controller.processFrame(new UserStartedSpeakingFrame());
    expect(controller.waitingForUser).toBe(false);
    await controller.processFrame(new UserStoppedSpeakingFrame());
    expect(controller.waitingForUser).toBe(false);

    await controller.cleanup();
  });
});
