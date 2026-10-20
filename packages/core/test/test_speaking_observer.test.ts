// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_speaking_observer.py

import { beforeEach, describe, expect, test } from "bun:test";
import { sleep } from "@pipecat-ts/asyncio";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type Frame,
  InterruptionFrame,
  TextFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { FramePushed } from "../src/observers/base_observer.ts";
import {
  SpeakingObserver,
  type SpeechEvent,
  SpeechEventKind,
} from "../src/observers/speaking_observer.ts";
import { IdentityFilter } from "../src/processors/filters/identity_filter.ts";
import { FrameDirection } from "../src/processors/frame_processor.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";

/** The speaking lifecycle, reported moment by moment. */
describe("TestSpeakingObserver", () => {
  let clock: number;
  let observer: SpeakingObserver;
  let events: SpeechEvent[];

  beforeEach(async () => {
    clock = 1_000_000.0;
    observer = new SpeakingObserver({ timeSource: () => clock });
    // Event handlers run as tasks, so the observer needs a task manager.
    await observer.setup(new TaskManager());
    events = [];

    observer.eventHandler("on_speech_event", async (_observer: unknown, event: SpeechEvent) => {
      events.push(event);
    });
  });

  /** Advance the clock without sleeping. */
  function wait(seconds: number): void {
    clock += seconds;
  }

  async function settle(): Promise<void> {
    await sleep(0.01);
  }

  /** Feed one frame to the observer, as a pipeline push would. */
  async function push(frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM) {
    await observer.onPushFrame(
      new FramePushed({
        source: new IdentityFilter({ name: "source" }),
        destination: new IdentityFilter({ name: "destination" }),
        frame,
        direction,
        timestamp: 0,
      }),
    );
    await settle();
  }

  test("test_speech_is_timed_to_speech_not_to_the_detector", async () => {
    // A bar drawn from confirmation times is fat at both ends.
    await push(new VADUserStartedSpeakingFrame({ startSecs: 0.2, timestamp: clock }));
    wait(2.5);
    await push(new VADUserStoppedSpeakingFrame({ stopSecs: 0.8, timestamp: clock }));

    expect(events.length).toBe(2);
    const [started, stopped] = events as [SpeechEvent, SpeechEvent];
    expect(started.kind).toEqual(SpeechEventKind.USER_SPEECH_STARTED);
    // The detector confirmed 0.2s after speech began, and 0.8s after it ended.
    expect(started.timestamp).toBeCloseTo(1_000_000.0 - 0.2, 6);
    expect(stopped.timestamp).toBeCloseTo(1_000_002.5 - 0.8, 6);
    expect(stopped.timestamp - stopped.startedAt!).toBeCloseTo(2.5 - 0.8 + 0.2, 6);
  });

  test("test_a_closing_moment_names_the_stretch_it_ends", async () => {
    // So an interval reads whole from one record, without pairing.
    await push(new BotStartedSpeakingFrame());
    const startedAt = clock;
    wait(6.3);
    await push(new BotStoppedSpeakingFrame());

    const stopped = events[events.length - 1]!;
    expect(stopped.kind).toEqual(SpeechEventKind.BOT_SPEECH_STOPPED);
    expect(stopped.startedAt).toEqual(startedAt);
    expect(stopped.timestamp - stopped.startedAt!).toBeCloseTo(6.3, 6);
  });

  test("test_the_microphone_and_the_strategy_are_reported_apart", async () => {
    // The pipeline acts on one; only the other hears a false start.
    await push(new VADUserStartedSpeakingFrame({ startSecs: 0.0, timestamp: clock }));
    await push(new UserStartedSpeakingFrame());
    wait(1.0);
    await push(new VADUserStoppedSpeakingFrame({ stopSecs: 0.0, timestamp: clock }));
    wait(0.3); // the strategy deliberating
    await push(new UserStoppedSpeakingFrame());

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      SpeechEventKind.USER_SPEECH_STARTED,
      SpeechEventKind.USER_TURN_STARTED,
      SpeechEventKind.USER_SPEECH_STOPPED,
      SpeechEventKind.USER_TURN_STOPPED,
    ]);
    const vad = events.find((e) => e.kind === SpeechEventKind.USER_SPEECH_STOPPED)!;
    const turn = events.find((e) => e.kind === SpeechEventKind.USER_TURN_STOPPED)!;
    expect(turn.timestamp - vad.timestamp).toBeCloseTo(0.3, 6);
  });

  test("test_an_interruption_names_no_speech", async () => {
    // Any processor can call for one, and it ends no stretch.
    await push(new InterruptionFrame());
    const event = events[0]!;
    expect(event.kind).toEqual(SpeechEventKind.INTERRUPTION);
    expect(event.startedAt).toBeNull();
  });

  test("test_a_broadcast_interruption_is_reported_once", async () => {
    // It arrives as two frames with two IDs, so an ID alone cannot tell.
    const downstream = new InterruptionFrame();
    const upstream = new InterruptionFrame();
    downstream.broadcastSiblingId = upstream.id;
    upstream.broadcastSiblingId = downstream.id;

    await push(downstream, FrameDirection.DOWNSTREAM);
    await push(upstream, FrameDirection.UPSTREAM);

    expect(events.length).toEqual(1);
  });

  test("test_a_stretch_whose_start_was_missed_closes_without_one", async () => {
    // Rather than borrowing a start from another stretch.
    await push(new BotStoppedSpeakingFrame());
    expect(events[0]!.startedAt).toBeNull();
  });

  test("test_other_frames_are_left_alone", async () => {
    // Only the speaking lifecycle is reported.
    await push(new TextFrame({ text: "hello" }));
    expect(events).toEqual([]);
  });

  test("test_a_barge_in_reads_as_an_overlap", async () => {
    // Which is what makes a timeline show one voice cutting into another.
    await push(new BotStartedSpeakingFrame());
    wait(5.0);
    await push(new VADUserStartedSpeakingFrame({ startSecs: 0.0, timestamp: clock }));
    await push(new InterruptionFrame());
    wait(0.2);
    await push(new BotStoppedSpeakingFrame());

    const botStopped = events[events.length - 1]!;
    const userStarted = events.find((e) => e.kind === SpeechEventKind.USER_SPEECH_STARTED)!;
    // The user began while the bot still had the floor.
    expect(userStarted.timestamp).toBeLessThan(botStopped.timestamp);
    expect(userStarted.timestamp).toBeGreaterThan(botStopped.startedAt!);
  });

  test("test_speech_that_never_becomes_a_turn_is_still_reported", async () => {
    // A cough or a false start reaches the microphone and stops there.
    await push(new VADUserStartedSpeakingFrame({ startSecs: 0.0, timestamp: clock }));
    wait(0.3);
    await push(new VADUserStoppedSpeakingFrame({ stopSecs: 0.0, timestamp: clock }));

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      SpeechEventKind.USER_SPEECH_STARTED,
      SpeechEventKind.USER_SPEECH_STOPPED,
    ]);
    // The strategy never ruled, so the pipeline never took a turn from it.
    expect(kinds).not.toContain(SpeechEventKind.USER_TURN_STARTED);
  });
});
