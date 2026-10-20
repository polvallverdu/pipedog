// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_vad_controller.py

import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as asyncio from "@pipedog/asyncio";
import { sleep } from "@pipedog/asyncio";

import { VADAnalyzer, VADParams, VADState } from "../src/audio/vad/vad_analyzer.ts";
import { VADController } from "../src/audio/vad/vad_controller.ts";
import { SystemClock } from "../src/clocks/system_clock.ts";
import { type Frame, InputAudioRawFrame, SpeechControlParamsFrame } from "../src/frames/frames.ts";
import {
  FrameDirection,
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "../src/processors/frame_processor.ts";
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

/** A mock VAD analyzer that returns a configurable state. */
class MockVADAnalyzer extends VADAnalyzer {
  protected _nextState: VADState = VADState.QUIET;

  /** Initialize with default QUIET state. */
  constructor() {
    super({ sampleRate: 16000 });
    this._nextState = VADState.QUIET;
  }

  /** Set the state to return on the next analyzeAudio call. */
  setNextState(state: VADState): void {
    this._nextState = state;
  }

  numFramesRequired(): number {
    return 512;
  }

  voiceConfidence(_buffer: Uint8Array): number {
    return 0.9;
  }

  /** Return the configured state. */
  override async analyzeAudio(_buffer: Uint8Array): Promise<VADState> {
    return this._nextState;
  }
}

function audioFrame(): InputAudioRawFrame {
  return new InputAudioRawFrame({
    audio: new Uint8Array(1024),
    sampleRate: 16000,
    numChannels: 1,
  });
}

describe("TestVADController", () => {
  let taskManager: TaskManager;

  beforeEach(() => {
    taskManager = new TaskManager();
  });

  test("test_speech_started_event", async () => {
    const analyzer = new MockVADAnalyzer();
    const controller = new VADController(analyzer);

    let speechStarted = false;

    controller.eventHandler("on_speech_started", async (_controller) => {
      speechStarted = true;
    });

    await controller.setup(frameProcessorSetup(taskManager));

    const frame = audioFrame();

    // Process with QUIET state - no event should fire
    analyzer.setNextState(VADState.QUIET);
    await controller.processFrame(frame);
    expect(speechStarted).toBe(false);

    // Process with SPEAKING state - event should fire
    analyzer.setNextState(VADState.SPEAKING);
    await controller.processFrame(frame);
    expect(speechStarted).toBe(true);
    await controller.cleanup();
  });

  test("test_speech_stopped_event", async () => {
    const analyzer = new MockVADAnalyzer();
    const controller = new VADController(analyzer);

    let speechStopped = false;

    controller.eventHandler("on_speech_stopped", async (_controller) => {
      speechStopped = true;
    });

    await controller.setup(frameProcessorSetup(taskManager));

    const frame = audioFrame();

    // Start speaking
    analyzer.setNextState(VADState.SPEAKING);
    await controller.processFrame(frame);
    expect(speechStopped).toBe(false);

    // Stop speaking - event should fire
    analyzer.setNextState(VADState.QUIET);
    await controller.processFrame(frame);
    expect(speechStopped).toBe(true);
    await controller.cleanup();
  });

  test("test_speech_activity_event", async () => {
    const analyzer = new MockVADAnalyzer();
    const controller = new VADController(analyzer);

    let activityCount = 0;

    controller.eventHandler("on_speech_activity", async (_controller) => {
      activityCount += 1;
    });

    await controller.setup(frameProcessorSetup(taskManager));

    const frame = audioFrame();
    analyzer.setNextState(VADState.SPEAKING);

    const times = [1.0, 1.0];
    for (let i = 1; i < 10; i++) times.push(1.0 + i * 0.02);
    let index = 0;
    // Equivalent of patch("pipecat.audio.vad.vad_controller.time.time", side_effect=times):
    // throws (like StopIteration) once the values run out.
    const spy = spyOn(asyncio, "time").mockImplementation(() => {
      if (index >= times.length) throw new Error("StopIteration");
      return times[index++] as number;
    });
    try {
      for (let i = 0; i < 10; i++) {
        await controller.processFrame(frame);
      }
    } finally {
      spy.mockRestore();
    }

    expect(activityCount).toEqual(1);
    await controller.cleanup();
  });

  test("test_push_frame_event", async () => {
    const analyzer = new MockVADAnalyzer();
    const controller = new VADController(analyzer);

    const pushedFrames: [Frame, FrameDirection][] = [];

    controller.eventHandler(
      "on_push_frame",
      async (_controller, frame: Frame, direction: FrameDirection) => {
        pushedFrames.push([frame, direction]);
      },
    );

    const testFrame = audioFrame();
    await controller.pushFrame(testFrame, FrameDirection.DOWNSTREAM);

    expect(pushedFrames.length).toEqual(1);
    expect(pushedFrames[0]?.[0]).toBe(testFrame);
    expect(pushedFrames[0]?.[1]).toEqual(FrameDirection.DOWNSTREAM);
  });

  test("test_broadcast_frame_event", async () => {
    const analyzer = new MockVADAnalyzer();
    const controller = new VADController(analyzer);

    const broadcastCalls: [unknown, Record<string, unknown>][] = [];

    controller.eventHandler(
      "on_broadcast_frame",
      async (_controller, frameCls: unknown, options: Record<string, unknown>) => {
        broadcastCalls.push([frameCls, options]);
      },
    );

    await controller.broadcastFrame(InputAudioRawFrame, {
      audio: new Uint8Array(1),
      sampleRate: 16000,
      numChannels: 1,
    });

    expect(broadcastCalls.length).toEqual(1);
    expect(broadcastCalls[0]?.[0]).toBe(InputAudioRawFrame);
    expect(broadcastCalls[0]?.[1].sampleRate).toEqual(16000);
  });

  test("test_no_event_on_transitional_states", async () => {
    const analyzer = new MockVADAnalyzer();
    const controller = new VADController(analyzer);

    const eventsTriggered: string[] = [];

    controller.eventHandler("on_speech_started", async (_controller) => {
      eventsTriggered.push("started");
    });

    controller.eventHandler("on_speech_stopped", async (_controller) => {
      eventsTriggered.push("stopped");
    });

    await controller.setup(frameProcessorSetup(taskManager));

    const frame = audioFrame();

    // STARTING is a transitional state - no event
    analyzer.setNextState(VADState.STARTING);
    await controller.processFrame(frame);
    expect(eventsTriggered).toEqual([]);

    // STOPPING is a transitional state - no event
    analyzer.setNextState(VADState.STOPPING);
    await controller.processFrame(frame);
    expect(eventsTriggered).toEqual([]);
    await controller.cleanup();
  });

  test("test_start_broadcasts_vad_params", async () => {
    const analyzer = new MockVADAnalyzer();
    const controller = new VADController(analyzer);

    const broadcastCalls: [unknown, Record<string, unknown>][] = [];

    controller.eventHandler(
      "on_broadcast_frame",
      async (_controller, frameCls: unknown, options: Record<string, unknown>) => {
        broadcastCalls.push([frameCls, options]);
      },
    );

    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    // Should have broadcast SpeechControlParamsFrame with VAD params
    expect(broadcastCalls.length).toEqual(1);
    expect(broadcastCalls[0]?.[0]).toBe(SpeechControlParamsFrame);
    expect(broadcastCalls[0]?.[1]).toHaveProperty("vadParams");
    expect(broadcastCalls[0]?.[1].vadParams).toBeInstanceOf(VADParams);
    await controller.cleanup();
  });
});

const AUDIO_IDLE_TIMEOUT = 0.1;

describe("TestVADControllerAudioIdle", () => {
  let taskManager: TaskManager;

  beforeEach(() => {
    taskManager = new TaskManager();
  });

  test("test_audio_idle_forces_speech_stop", async () => {
    const analyzer = new MockVADAnalyzer();
    const controller = new VADController(analyzer, { audioIdleTimeout: AUDIO_IDLE_TIMEOUT });

    let speechStopped = false;

    controller.eventHandler("on_speech_stopped", async (_controller) => {
      speechStopped = true;
    });

    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    // Enter SPEAKING state
    const frame = audioFrame();
    analyzer.setNextState(VADState.SPEAKING);
    await controller.processFrame(frame);
    expect(speechStopped).toBe(false);

    // Stop sending audio, wait for idle timeout
    await sleep(AUDIO_IDLE_TIMEOUT + 0.1);
    expect(speechStopped).toBe(true);

    await controller.cleanup();
  });

  test("test_audio_idle_does_not_fire_when_quiet", async () => {
    const analyzer = new MockVADAnalyzer();
    const controller = new VADController(analyzer, { audioIdleTimeout: AUDIO_IDLE_TIMEOUT });

    let speechStopped = false;

    controller.eventHandler("on_speech_stopped", async (_controller) => {
      speechStopped = true;
    });

    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    // Stay in QUIET state, wait past idle timeout
    await sleep(AUDIO_IDLE_TIMEOUT + 0.1);
    expect(speechStopped).toBe(false);

    await controller.cleanup();
  });
});
