// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_turn_tracking_observer.py

import { describe, expect, test } from "bun:test";
import { sleep, type Task } from "@pipedog/asyncio";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  CancelFrame,
  type Frame,
  StartFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { FramePushed } from "../src/observers/base_observer.ts";
import { TurnTrackingObserver } from "../src/observers/turn_tracking_observer.ts";
import { IdentityFilter } from "../src/processors/filters/identity_filter.ts";
import { FrameDirection } from "../src/processors/frame_processor.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";

const internals = (o: TurnTrackingObserver): any => o;

/** Record start/end events with turn numbers. */
function recordTurnEvents(turnObserver: TurnTrackingObserver): string[] {
  const turnEvents: string[] = [];

  turnObserver.eventHandler("on_turn_started", async (_observer: unknown, turnNumber: number) => {
    turnEvents.push(`Turn ${turnNumber} started`);
  });

  turnObserver.eventHandler(
    "on_turn_ended",
    async (_observer: unknown, turnNumber: number, _duration: number, wasInterrupted: boolean) => {
      turnEvents.push(
        `Turn ${turnNumber} ended (interrupted: ${wasInterrupted ? "True" : "False"})`,
      );
    },
  );

  return turnEvents;
}

/** Tests for TurnTrackingObserver. */
describe("TestTurnTrackingObserver", () => {
  /** Test a normal conversation with two complete turns. */
  test("test_normal_conversation_flow", async () => {
    // Create observer with a short timeout
    const turnObserver = new TurnTrackingObserver({ turnEndTimeoutSecs: 0.2 });

    // Create identity filter (passes all frames through)
    const processor = new IdentityFilter();

    const turnEvents = recordTurnEvents(turnObserver);

    const framesToSend = [
      // Turn 1
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      new BotStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.05 }), // < 0.2 seconds turn_end_timeout
      // Turn 2
      new UserStartedSpeakingFrame(), // New turn starts
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      new BotStoppedSpeakingFrame(),
      // Add a sleep frame to allow turn timeout to occur
      new SleepFrame({ sleep: 0.4 }), // > 0.2 seconds turn_end_timeout
    ];

    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      BotStoppedSpeakingFrame,
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      BotStoppedSpeakingFrame,
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames,
      observers: [turnObserver],
    });

    // Verify turn events
    const expectedEvents = [
      "Turn 1 started",
      "Turn 1 ended (interrupted: False)",
      "Turn 2 started",
      "Turn 2 ended (interrupted: False)",
    ];
    expect(turnEvents).toEqual(expectedEvents);
    expect(internals(turnObserver)._turnCount).toEqual(2);
  });

  /** Test when user speaks twice before bot responds, should be same turn. */
  test("test_user_speaks_twice_before_bot", async () => {
    // Create observer with a short timeout
    const turnObserver = new TurnTrackingObserver({ turnEndTimeoutSecs: 0.2 });

    // Create identity filter (passes all frames through)
    const processor = new IdentityFilter();

    const turnEvents = recordTurnEvents(turnObserver);

    const framesToSend = [
      // Turn 1 - User speaks twice before bot responds
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new UserStartedSpeakingFrame(), // Second user speaking event should not start a new turn
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      new BotStoppedSpeakingFrame(),
      // Turn 2
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      new BotStoppedSpeakingFrame(),
      // Add a sleep frame to allow turn timeout to occur
      new SleepFrame({ sleep: 0.4 }), // > 0.2 seconds turn_end_timeout
    ];

    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      BotStoppedSpeakingFrame,
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      BotStoppedSpeakingFrame,
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames,
      observers: [turnObserver],
    });

    // Verify turn events - should only see two turns despite user speaking twice
    const expectedEvents = [
      "Turn 1 started",
      "Turn 1 ended (interrupted: False)",
      "Turn 2 started",
      "Turn 2 ended (interrupted: False)",
    ];
    expect(turnEvents).toEqual(expectedEvents);
    expect(internals(turnObserver)._turnCount).toEqual(2);
  });

  /**
   * Test when user interrupts bot speaking, should end current turn and start new one.
   *
   * Note: This test also verifies that the EndFrame ends the turn correctly.
   */
  test("test_user_interrupts_bot", async () => {
    // Create observer with a short timeout
    const turnObserver = new TurnTrackingObserver({ turnEndTimeoutSecs: 0.2 });

    // Create identity filter (passes all frames through)
    const processor = new IdentityFilter();

    const turnEvents = recordTurnEvents(turnObserver);

    const framesToSend = [
      // Turn 1
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      // Interruption here - user starts speaking while bot is still speaking
      new UserStartedSpeakingFrame(), // This should end Turn 1 and start Turn 2
      new SleepFrame({ sleep: 0.4 }), // > 0.2 seconds turn_end_timeout
    ];

    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      UserStartedSpeakingFrame,
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames,
      observers: [turnObserver],
    });

    // Verify turn events - should see Turn 1 interrupted
    const expectedEvents = [
      "Turn 1 started",
      "Turn 1 ended (interrupted: True)", // First turn was interrupted
      "Turn 2 started", // New turn started after interruption
      "Turn 2 ended (interrupted: True)", // Second turn ends due to EndFrame
    ];
    expect(turnEvents).toEqual(expectedEvents);
    expect(internals(turnObserver)._turnCount).toEqual(2);
  });

  /** Test that multiple bot start/stop frames in the same turn work correctly. */
  test("test_bot_starts_stops_multiple_times", async () => {
    // Create observer with a short timeout
    const turnObserver = new TurnTrackingObserver({ turnEndTimeoutSecs: 0.2 });

    // Create identity filter (passes all frames through)
    const processor = new IdentityFilter();

    const turnEvents = recordTurnEvents(turnObserver);

    const framesToSend = [
      // Start turn with user speaking
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      // Bot speaks, stops, speaks again (simulating HTTP TTS or function calls)
      new BotStartedSpeakingFrame(),
      new BotStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(), // Bot speaks again, should not end turn
      new BotStoppedSpeakingFrame(),
      // Add a sleep frame to allow turn timeout to occur
      new SleepFrame({ sleep: 0.4 }), // > 0.2 seconds turn_end_timeout
    ];

    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      BotStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      BotStoppedSpeakingFrame,
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames,
      observers: [turnObserver],
    });

    // Should only be one turn with a normal end
    const expectedEvents = ["Turn 1 started", "Turn 1 ended (interrupted: False)"];
    expect(turnEvents).toEqual(expectedEvents);
    expect(internals(turnObserver)._turnCount).toEqual(1);
  });

  /** Test that CancelFrame properly flushes an active turn. */
  test("test_cancel_frame_flushes_active_turn", async () => {
    // Create observer with a long timeout to ensure CancelFrame is what ends the turn
    const turnObserver = new TurnTrackingObserver({ turnEndTimeoutSecs: 5.0 });

    // Create identity filter (passes all frames through)
    const processor = new IdentityFilter();

    const turnEvents = recordTurnEvents(turnObserver);

    const framesToSend = [
      // Start a turn but don't complete it naturally
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      // Send CancelFrame while bot is still speaking
      new CancelFrame(),
    ];

    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      CancelFrame,
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames,
      observers: [turnObserver],
      sendEndFrame: false, // Don't send EndFrame since we're testing CancelFrame
    });

    // Verify that the turn was ended due to CancelFrame (marked as interrupted)
    const expectedEvents = [
      "Turn 1 started",
      "Turn 1 ended (interrupted: True)", // Should be interrupted due to CancelFrame
    ];
    expect(turnEvents).toEqual(expectedEvents);
    expect(internals(turnObserver)._turnCount).toEqual(1);
  });

  /** Test that EndFrame doesn't cause issues when no turn is active. */
  test("test_end_frame_with_no_active_turn", async () => {
    // Create observer
    const turnObserver = new TurnTrackingObserver({ turnEndTimeoutSecs: 0.2 });

    // Create identity filter (passes all frames through)
    const processor = new IdentityFilter();

    const turnEvents = recordTurnEvents(turnObserver);

    const framesToSend = [
      // Complete a turn normally
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      new BotStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.4 }), // Let turn end naturally due to timeout
      // EndFrame will be sent by runTest when no turn is active
    ];

    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      BotStoppedSpeakingFrame,
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames,
      observers: [turnObserver],
      sendEndFrame: true,
    });

    // Should only see one turn that ends naturally, EndFrame shouldn't create additional events
    const expectedEvents = [
      "Turn 1 started",
      "Turn 1 ended (interrupted: False)", // Ends due to timeout, not EndFrame
    ];
    expect(turnEvents).toEqual(expectedEvents);
    expect(internals(turnObserver)._turnCount).toEqual(1);
  });

  /**
   * Test that cleanup cancels the turn end timer and releases what it holds.
   *
   * The pipeline can be torn down before the observer receives its EndFrame
   * or CancelFrame, so cleanup is the last chance to cancel the timer.
   */
  test("test_cleanup_cancels_pending_turn_end_timer", async () => {
    const turnObserver = new TurnTrackingObserver({ turnEndTimeoutSecs: 10 });
    const processor = new IdentityFilter();

    const turnEnded: number[] = [];

    turnObserver.eventHandler(
      "on_turn_ended",
      async (
        _observer: unknown,
        turnNumber: number,
        _duration: number,
        _wasInterrupted: boolean,
      ) => {
        turnEnded.push(turnNumber);
      },
    );

    function pushed(frame: Frame): FramePushed {
      return new FramePushed({
        source: processor,
        destination: processor,
        frame,
        direction: FrameDirection.DOWNSTREAM,
        timestamp: 0,
      });
    }

    await turnObserver.onPushFrame(pushed(new StartFrame()));
    await turnObserver.onPushFrame(pushed(new BotStartedSpeakingFrame()));
    // Built in a separate function so no strong reference to the frame data
    // outlives it in this scope.
    const stoppedRef = await (async () => {
      const stopped = pushed(new BotStoppedSpeakingFrame());
      const ref = new WeakRef(stopped);
      await turnObserver.onPushFrame(stopped);
      return ref;
    })();

    const timer: Task<void> | null = internals(turnObserver)._endTurnTimer;
    expect(timer).not.toBeNull();

    await turnObserver.cleanup();

    // Unlike a `call_later` handle, a task settles as cancelled once it has
    // unwound, so let it finish before checking.
    await timer?.promise.catch(() => {});
    expect(timer?.cancelled()).toBe(true);
    expect(internals(turnObserver)._endTurnTimer).toBeNull();
    // The timer's callback no longer holds the frame data (and the pipeline).
    // A weak reference read in a job stays alive until that job ends, so
    // collect from a fresh one.
    await new Promise((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);
    expect(stoppedRef.deref()).toBeUndefined();
    await sleep(0);
    expect(turnEnded).toEqual([]);
  });
});
