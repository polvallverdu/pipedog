// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_pipeline.py

import { describe, expect, test } from "bun:test";
import {
  CancelledError,
  createTask,
  currentTask,
  Event,
  FIRST_COMPLETED,
  gather,
  monotonic,
  sleep,
  type Task,
  TimeoutError,
  time,
  wait,
  waitFor,
} from "@pipedog/asyncio";
import type { BusCancelWorkerMessage } from "../src/bus/messages.ts";
import {
  CancelFrame,
  EndFrame,
  ErrorFrame,
  type Frame,
  HeartbeatFrame,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  PipelineFlushFrame,
  StartFrame,
  StopFrame,
  TextFrame,
  TTSStoppedFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { BaseObserver, type FramePushed } from "../src/observers/base_observer.ts";
import { ParallelPipeline } from "../src/pipeline/parallel_pipeline.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { ServiceSwitcher } from "../src/pipeline/service_switcher.ts";
import { SyncParallelPipeline } from "../src/pipeline/sync_parallel_pipeline.ts";
import { PipelineParams, PipelineWorker } from "../src/pipeline/worker.ts";
import { FrameFilter } from "../src/processors/filters/frame_filter.ts";
import { IdentityFilter } from "../src/processors/filters/identity_filter.ts";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "../src/processors/frame_processor.ts";
import { TTSService, type TTSServiceOptions } from "../src/services/tts_service.ts";
import { HeartbeatsObserver, runTest } from "../src/tests/utils.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";
import { logger } from "../src/utils/logger.ts";
import { BaseWorker, WorkerParams } from "../src/workers/base_worker.ts";
import { WorkerRunner } from "../src/workers/runner.ts";

const workerParams = (): WorkerParams => new WorkerParams({ taskManager: new TaskManager() });

describe("TestPipeline", () => {
  test("test_pipeline_single", async () => {
    const pipeline = new Pipeline([new IdentityFilter()]);

    const framesToSend = [new TextFrame({ text: "Hello from Pipecat!" })];
    const expectedDownFrames = [TextFrame];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
  });

  test("test_pipeline_multiple", async () => {
    const identity1 = new IdentityFilter();
    const identity2 = new IdentityFilter();
    const identity3 = new IdentityFilter();

    const pipeline = new Pipeline([identity1, identity2, identity3]);

    const framesToSend = [new TextFrame({ text: "Hello from Pipecat!" })];
    const expectedDownFrames = [TextFrame];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
  });

  test("test_pipeline_start_metadata", async () => {
    const pipeline = new Pipeline([new IdentityFilter()]);

    const framesToSend: Frame[] = [];
    const expectedDownFrames = [StartFrame];
    const [receivedDown] = await runTest(pipeline, {
      framesToSend,
      expectedDownFrames,
      ignoreStart: false,
      pipelineParams: new PipelineParams({ startMetadata: { foo: "bar" } }),
    });
    expect("foo" in receivedDown[receivedDown.length - 1]!.metadata).toBe(true);
  });

  // Skipped: only exercises the deprecated StartFrame configuration fields
  // (audio_in_sample_rate, enable_metrics, ...), which are not ported.
  test.skip("test_start_frame_still_carries_the_deprecated_configuration", () => {});

  test("test_pipeline_setup_failures_are_reported", async () => {
    // A processor that fails to set up reports it as an error frame.
    //
    // Services connect during setup, so a failure there is as worth reporting
    // as one while handling a frame. Each failing processor reports its own,
    // so one failure never hides another.

    class FailingSetup extends FrameProcessor {
      protected _reason: string;

      constructor(reason: string) {
        super();
        this._reason = reason;
      }

      override async setup(setup: FrameProcessorSetup): Promise<void> {
        await super.setup(setup);
        throw new Error(this._reason);
      }

      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        await this.pushFrame(frame, direction);
      }
    }

    const errors: string[] = [];

    class ErrorWatcher extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        if (frame instanceof ErrorFrame) {
          errors.push(frame.error);
        }
        await this.pushFrame(frame, direction);
      }
    }

    const first = new FailingSetup("first failed");
    const second = new FailingSetup("second failed");
    const pipeline = new Pipeline([new ErrorWatcher(), first, second]);
    const worker = new PipelineWorker(pipeline);

    await worker.queueFrame(new EndFrame());
    await worker.run(workerParams());

    expect(errors.length).toEqual(2);
    expect(errors.some((e) => e.includes("first failed"))).toBe(true);
    expect(errors.some((e) => e.includes("second failed"))).toBe(true);

    // Setting up is not attempted again, so a processor that failed it can
    // no longer do its job and a switcher can move off it.
    expect(first.isUsable).toBe(false);
    expect(second.isUsable).toBe(false);
  });
});

describe("TestParallelPipeline", () => {
  test("test_parallel_single", async () => {
    const pipeline = new ParallelPipeline([new IdentityFilter()]);

    const framesToSend = [new TextFrame({ text: "Hello from Pipecat!" })];
    const expectedDownFrames = [TextFrame];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
  });

  test("test_parallel_multiple", async () => {
    // Should only passthrough one instance of TextFrame.
    const pipeline = new ParallelPipeline([new IdentityFilter()], [new IdentityFilter()]);

    const framesToSend = [new TextFrame({ text: "Hello from Pipecat!" })];
    const expectedDownFrames = [TextFrame];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
  });

  test("test_parallel_internal_frames_buffered_during_start", async () => {
    // Frames pushed by internal processors during StartFrame processing
    // should be buffered and only released after StartFrame synchronization
    // completes.

    /** Pushes a TextFrame when it receives a StartFrame. */
    class EmitOnStartProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        await this.pushFrame(frame, direction);
        if (frame instanceof StartFrame) {
          await this.pushFrame(new TextFrame({ text: "from start" }));
        }
      }
    }

    const pipeline = new ParallelPipeline([new EmitOnStartProcessor()], [new IdentityFilter()]);

    const framesToSend = [new TextFrame({ text: "Hello!" })];

    // StartFrame should come first, then the TextFrame emitted during
    // StartFrame processing, then the regular TextFrame.
    const expectedDownFrames = [StartFrame, TextFrame, TextFrame];
    await runTest(pipeline, { framesToSend, expectedDownFrames, ignoreStart: false });
  });
});

const FLUSH_LEGS: [FrameDirection, boolean][] = [
  [FrameDirection.DOWNSTREAM, false],
  [FrameDirection.UPSTREAM, false],
  [FrameDirection.DOWNSTREAM, true],
];

/** Records the legs of each flush that pass through it. */
class FlushRecorder extends FrameProcessor {
  legs: Map<number, [FrameDirection, boolean][]> = new Map();

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof PipelineFlushFrame) {
      let legs = this.legs.get(frame.flushId);
      if (legs === undefined) {
        legs = [];
        this.legs.set(frame.flushId, legs);
      }
      legs.push([direction, frame.returning]);
    }
    await this.pushFrame(frame, direction);
  }
}

describe("TestPipelineFlush", () => {
  const flush = async (processor: FrameProcessor, flushes = 1): Promise<boolean[]> => {
    const worker = new PipelineWorker(new Pipeline([processor]));
    const started = new Event();
    const results: boolean[] = [];

    worker.eventHandler("on_pipeline_started", async (_worker: PipelineWorker, _frame: Frame) => {
      started.set();
    });

    const drive = async (): Promise<void> => {
      await started.wait();
      const flushing = Array.from({ length: flushes }, () => () => worker.flushPipeline(1.0));
      results.push(...(await gather(...flushing)));
      await worker.queueFrame(new EndFrame());
    };

    await waitFor(
      () =>
        gather(
          () => worker.run(workerParams()),
          () => drive(),
        ),
      10.0,
    );
    return results;
  };

  test("test_flush_through_parallel_pipeline", async () => {
    // Every branch sees every leg of each flush.
    const branches = [new FlushRecorder(), new FlushRecorder()];

    const results = await flush(new ParallelPipeline(...branches.map((b) => [b])), 2);

    expect(results).toEqual([true, true]);
    for (const branch of branches) {
      expect([...branch.legs.values()]).toEqual([FLUSH_LEGS, FLUSH_LEGS]);
    }
  });

  test("test_flush_through_nested_service_switchers", async () => {
    // Only the active service sees the flush.
    const active = new FlushRecorder();
    const inactive = new FlushRecorder();
    const outer = new FlushRecorder();
    const switcher = new ServiceSwitcher([new ServiceSwitcher([active, inactive]), outer]);

    const results = await flush(switcher);

    expect(results).toEqual([true]);
    expect([...active.legs.values()]).toEqual([FLUSH_LEGS]);
    expect(inactive.legs.size).toEqual(0);
    expect(outer.legs.size).toEqual(0);
  });
});

describe("TestPipelineWorker", () => {
  test("test_task_single", async () => {
    const pipeline = new Pipeline([new IdentityFilter()]);
    const worker = new PipelineWorker(pipeline);

    await worker.queueFrame(new TextFrame({ text: "Hello!" }));
    await worker.queueFrames([new TextFrame({ text: "Bye!" }), new EndFrame()]);
    await worker.run(workerParams());
    expect(worker.hasFinished()).toBe(true);
  });

  test("test_task_observers", async () => {
    let frameReceived = false;

    class CustomObserver extends BaseObserver {
      override async onPushFrame(data: FramePushed): Promise<void> {
        if (data.frame instanceof TextFrame) {
          frameReceived = true;
        }
      }
    }

    const identity = new IdentityFilter();
    const pipeline = new Pipeline([identity]);
    const worker = new PipelineWorker(pipeline, { observers: [new CustomObserver()] });

    await worker.queueFrames([new TextFrame({ text: "Hello Downstream!" }), new EndFrame()]);
    await worker.run(workerParams());
    expect(frameReceived).toBe(true);
  });

  test("test_task_add_observer", async () => {
    let frameReceived = false;
    let frameCount1 = 0;
    let frameCount2 = 0;

    class CustomObserver extends BaseObserver {
      override async onPushFrame(data: FramePushed): Promise<void> {
        if (data.frame instanceof TextFrame) {
          frameReceived = true;
        }
      }
    }

    class CustomAddObserver1 extends BaseObserver {
      override async onPushFrame(data: FramePushed): Promise<void> {
        if (data.source instanceof IdentityFilter && data.frame instanceof TextFrame) {
          frameCount1 += 1;
        }
      }
    }

    class CustomAddObserver2 extends BaseObserver {
      override async onPushFrame(data: FramePushed): Promise<void> {
        if (data.source instanceof IdentityFilter && data.frame instanceof TextFrame) {
          frameCount2 += 1;
        }
      }
    }

    const identity = new IdentityFilter();
    const pipeline = new Pipeline([identity]);
    const worker = new PipelineWorker(pipeline, { observers: [new CustomObserver()] });

    // Add a new observer right away, before doing anything else with the worker.
    const observer1 = new CustomAddObserver1();
    worker.addObserver(observer1);

    const delayedAddObserver = async (): Promise<void> => {
      const observer2 = new CustomAddObserver2();
      // Wait after the pipeline is started and add another observer.
      await sleep(0.1);
      worker.addObserver(observer2);
      // Push a TextFrame and wait for the observer to pick it up.
      await worker.queueFrame(new TextFrame({ text: "Hello Downstream!" }));
      await sleep(0.1);
      // Remove both observers.
      await worker.removeObserver(observer1);
      await worker.removeObserver(observer2);
      // Push another TextFrame. This time the counter should not
      // increments since we have removed the observer.
      await worker.queueFrame(new TextFrame({ text: "Hello Downstream!" }));
      await sleep(0.1);
      // Finally end the pipeline.
      await worker.queueFrame(new EndFrame());
    };

    await gather(
      () => worker.run(workerParams()),
      () => delayedAddObserver(),
    );

    expect(frameReceived).toBe(true);
    expect(frameCount1).toEqual(1);
    expect(frameCount2).toEqual(1);
  });

  test("test_task_observer_can_remove_itself", async () => {
    let frameCount = 0;
    let proxyTask: Task<unknown> | undefined;
    const removed = new Event();

    class SelfRemovingObserver extends BaseObserver {
      override async onPushFrame(data: FramePushed): Promise<void> {
        if (data.source instanceof IdentityFilter && data.frame instanceof TextFrame) {
          frameCount += 1;
          proxyTask = currentTask();
          await worker.removeObserver(this);
          removed.set();
        }
      }
    }

    const identity = new IdentityFilter();
    const pipeline = new Pipeline([identity]);
    const worker = new PipelineWorker(pipeline);
    worker.addObserver(new SelfRemovingObserver());

    const pushFrames = async (): Promise<void> => {
      await worker.queueFrame(new TextFrame({ text: "First frame" }));
      await waitFor(() => removed.wait(), 1.0);
      await worker.queueFrames([new TextFrame({ text: "Second frame" }), new EndFrame()]);
    };

    await gather(
      () => worker.run(workerParams()),
      () => pushFrames(),
    );

    expect(frameCount).toEqual(1);
    // The observer was running on its own proxy task, which must still end.
    expect(proxyTask?.done()).toBe(true);
  });

  test("test_task_started_ended_event_handler", async () => {
    let startReceived = false;
    let endReceived = false;

    const identity = new IdentityFilter();
    const pipeline = new Pipeline([identity]);
    const worker = new PipelineWorker(pipeline);

    worker.eventHandler(
      "on_pipeline_started",
      async (_worker: PipelineWorker, _frame: StartFrame) => {
        startReceived = true;
      },
    );

    worker.eventHandler("on_pipeline_finished", async (_worker: PipelineWorker, frame: Frame) => {
      endReceived = frame instanceof EndFrame;
    });

    await worker.queueFrame(new EndFrame());
    await worker.run(workerParams());

    expect(startReceived).toBe(true);
    expect(endReceived).toBe(true);
  });

  test("test_task_stopped_event_handler", async () => {
    let stopReceived = false;

    const identity = new IdentityFilter();
    const pipeline = new Pipeline([identity]);
    const worker = new PipelineWorker(pipeline);

    worker.eventHandler("on_pipeline_finished", async (_worker: PipelineWorker, frame: Frame) => {
      stopReceived = frame instanceof StopFrame;
    });

    await worker.queueFrame(new StopFrame());
    await worker.run(workerParams());

    expect(stopReceived).toBe(true);
  });

  test("test_task_frame_reached_event_handlers", async () => {
    let upstreamReceived = false;
    let downstreamReceived = false;

    const identity = new IdentityFilter();
    const pipeline = new Pipeline([identity]);
    const worker = new PipelineWorker(pipeline, { cancelOnIdleTimeout: false });
    worker.setReachedUpstreamFilter([TextFrame]);
    worker.setReachedDownstreamFilter([TextFrame]);

    worker.eventHandler(
      "on_frame_reached_upstream",
      async (_worker: PipelineWorker, frame: Frame) => {
        if (frame instanceof TextFrame && frame.text === "Hello Upstream!") {
          upstreamReceived = true;
        }
      },
    );

    worker.eventHandler(
      "on_frame_reached_downstream",
      async (_worker: PipelineWorker, frame: Frame) => {
        if (frame instanceof TextFrame && frame.text === "Hello Downstream!") {
          downstreamReceived = true;
          await identity.pushFrame(
            new TextFrame({ text: "Hello Upstream!" }),
            FrameDirection.UPSTREAM,
          );
        }
      },
    );

    await worker.queueFrame(new TextFrame({ text: "Hello Downstream!" }));

    try {
      await waitFor(() => worker.run(workerParams()), 1.0);
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
    }

    expect(upstreamReceived).toBe(true);
    expect(downstreamReceived).toBe(true);
  });

  test("test_task_queue_frame_upstream", async () => {
    let upstreamReceived = false;

    const pipeline = new Pipeline([new IdentityFilter()]);
    const worker = new PipelineWorker(pipeline, { cancelOnIdleTimeout: false });
    worker.setReachedUpstreamFilter([TextFrame]);

    worker.eventHandler(
      "on_frame_reached_upstream",
      async (_worker: PipelineWorker, frame: Frame) => {
        if (frame instanceof TextFrame && frame.text === "Hello Upstream!") {
          upstreamReceived = true;
        }
      },
    );

    worker.eventHandler("on_pipeline_started", async (worker: PipelineWorker, _frame: Frame) => {
      await worker.queueFrame(new TextFrame({ text: "Hello Upstream!" }), FrameDirection.UPSTREAM);
    });

    try {
      await waitFor(() => worker.run(workerParams()), 1.0);
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
    }

    expect(upstreamReceived).toBe(true);
  });

  test("test_task_queue_frames_upstream", async () => {
    const upstreamTexts: string[] = [];

    const pipeline = new Pipeline([new IdentityFilter()]);
    const worker = new PipelineWorker(pipeline, { cancelOnIdleTimeout: false });
    worker.setReachedUpstreamFilter([TextFrame]);

    worker.eventHandler(
      "on_frame_reached_upstream",
      async (_worker: PipelineWorker, frame: Frame) => {
        if (frame instanceof TextFrame) {
          upstreamTexts.push(frame.text);
        }
      },
    );

    worker.eventHandler("on_pipeline_started", async (worker: PipelineWorker, _frame: Frame) => {
      await worker.queueFrames(
        [new TextFrame({ text: "First" }), new TextFrame({ text: "Second" })],
        FrameDirection.UPSTREAM,
      );
    });

    try {
      await waitFor(() => worker.run(workerParams()), 1.0);
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
    }

    expect(upstreamTexts).toContain("First");
    expect(upstreamTexts).toContain("Second");
  });

  test("test_task_heartbeats", async () => {
    const periodSecs = 0.2;
    const expectedHeartbeats = 5;
    let heartbeatsCounter = 0;
    const receivedExpected = new Event();

    const heartbeatReceived = async (
      _processor: FrameProcessor,
      _heartbeat: HeartbeatFrame,
    ): Promise<void> => {
      heartbeatsCounter += 1;
      if (heartbeatsCounter >= expectedHeartbeats) {
        receivedExpected.set();
      }
    };

    const identity = new IdentityFilter();
    const pipeline = new Pipeline([identity]);
    const heartbeatsObserver = new HeartbeatsObserver({
      target: identity,
      heartbeatCallback: heartbeatReceived,
    });
    const worker = new PipelineWorker(pipeline, {
      params: new PipelineParams({
        enableHeartbeats: true,
        heartbeatsPeriodSecs: periodSecs,
      }),
      observers: [heartbeatsObserver],
      cancelOnIdleTimeout: false,
    });

    const waitForHeartbeats = async (): Promise<void> => {
      // Wait until we've observed the expected number of heartbeats, then
      // stop the pipeline. We don't assert on the count observed within a
      // fixed wall-clock window: heartbeats are timer-driven, so the count
      // in any given window depends on event-loop scheduling precision and
      // is off-by-one under load (which made this test flaky in CI). The
      // generous timeout only guards against heartbeats never firing.
      try {
        await waitFor(() => receivedExpected.wait(), 5.0);
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
      }
      await worker.queueFrame(new EndFrame());
    };

    await worker.queueFrame(new TextFrame({ text: "Hello!" }));

    const startTime = time();
    await gather(
      () => worker.run(workerParams()),
      () => waitForHeartbeats(),
    );
    const elapsed = time() - startTime;

    // We observed the expected number of heartbeats...
    expect(heartbeatsCounter).toBeGreaterThanOrEqual(expectedHeartbeats);
    // ...and they were paced by the configured period: each heartbeat waits a
    // full period, so N heartbeats span at least (N - 1) periods. asyncio.sleep
    // is a guaranteed lower bound, so this is robust to scheduling jitter while
    // still catching heartbeats that fire too fast.
    expect(elapsed).toBeGreaterThanOrEqual((expectedHeartbeats - 1) * periodSecs);
  });

  test("test_heartbeat_monitor_respects_custom_timeout", async () => {
    // Verify the heartbeat monitor uses heartbeats_monitor_secs from params.

    class HeartbeatBlocker extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        if (!(frame instanceof HeartbeatFrame)) {
          await this.pushFrame(frame, direction);
        }
      }
    }

    const logOutput: string[] = [];
    const removeSink = logger.addSink((record) => {
      if (record.level === "WARNING" || record.level === "ERROR" || record.level === "CRITICAL") {
        logOutput.push(record.message);
      }
    });

    const customMonitorSecs = 0.3;

    try {
      const pipeline = new Pipeline([new HeartbeatBlocker()]);
      const worker = new PipelineWorker(pipeline, {
        params: new PipelineParams({
          enableHeartbeats: true,
          heartbeatsPeriodSecs: 0.1,
          heartbeatsMonitorSecs: customMonitorSecs,
        }),
        cancelOnIdleTimeout: false,
      });

      worker.eventHandler("on_heartbeat_timeout", async (worker: PipelineWorker) => {
        await worker.cancel();
      });

      await worker.run(workerParams());

      const logText = logOutput.join("\n");
      expect(logText).toContain(`more than ${customMonitorSecs} seconds`);
    } finally {
      removeSink();
    }
  });

  test("test_idle_task", async () => {
    const identity = new IdentityFilter();
    const pipeline = new Pipeline([identity]);
    const worker = new PipelineWorker(pipeline, { idleTimeoutSecs: 0.2 });
    // This shouldn't freeze, so nothing to check really.
    await worker.run(workerParams());
  });

  test("test_cancel_runner_on_idle_timeout_cancels_peers", async () => {
    // `cancel_runner_on_idle_timeout` brings down the whole runner, not just the worker.
    //
    // Build a runner with a forever-running peer `BaseWorker` and a
    // `PipelineWorker` set to time out quickly. Without the new flag the
    // runner would hang on the peer; with it, the idle timeout sends a
    // `BusCancelMessage` and the runner shuts everything down.

    /** Bus-only worker that exits on cancel so the runner can finish. */
    class PeerWorker extends BaseWorker {
      protected override async _handleWorkerCancel(message: BusCancelWorkerMessage): Promise<void> {
        await super._handleWorkerCancel(message);
        this._finishedEvent.set();
      }

      get finishedEvent(): Event {
        return this._finishedEvent;
      }
    }

    const identity = new IdentityFilter();
    const pipeline = new Pipeline([identity]);
    const mainWorker = new PipelineWorker(pipeline, {
      name: "main",
      idleTimeoutSecs: 0.2,
      cancelRunnerOnIdleTimeout: true,
    });
    const peer = new PeerWorker({ name: "peer" });

    const runner = new WorkerRunner({ handleSigint: false });
    await runner.addWorkers(peer, mainWorker);

    await waitFor(() => runner.run(), 5.0);

    // Runner finishes only when both root workers stop. If
    // `cancel_runner_on_idle_timeout` worked, the peer received a
    // BusCancelWorkerMessage and exited; otherwise this test times out.
    expect(peer.finishedEvent.isSet()).toBe(true);
  });

  test("test_cancel_on_idle_timeout_false_overrides_runner_flag", async () => {
    // `cancel_on_idle_timeout=False` keeps the worker alive even with the runner flag on.
    //
    // Opting out of local cancellation also opts out of the runner-wide
    // cancel — the worker keeps running past the idle timeout and the
    // `on_idle_timeout` event handler is responsible for the response.
    const identity = new IdentityFilter();
    const pipeline = new Pipeline([identity]);
    const worker = new PipelineWorker(pipeline, {
      idleTimeoutSecs: 0.2,
      cancelOnIdleTimeout: false,
      // Default-True; the gating by cancel_on_idle_timeout=False should win.
    });

    const idleFired = new Event();

    worker.eventHandler("on_idle_timeout", async (worker: PipelineWorker) => {
      idleFired.set();
      await worker.queueFrame(new EndFrame());
    });

    await waitFor(() => worker.run(workerParams()), 2.0);
    expect(idleFired.isSet()).toBe(true);
  });

  test("test_no_idle_task", async () => {
    const identity = new IdentityFilter();
    const pipeline = new Pipeline([identity]);
    const worker = new PipelineWorker(pipeline, {
      idleTimeoutSecs: 0.2,
      cancelOnIdleTimeout: false,
    });
    let timedOut = false;
    try {
      await waitFor(() => worker.run(workerParams()), 0.3);
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
      timedOut = true;
    }
    if (!timedOut) {
      throw new Error("worker.run() returned instead of running until cancelled");
    }
  });

  test("test_idle_task_heartbeats", async () => {
    const identity = new IdentityFilter();
    const pipeline = new Pipeline([identity]);
    const worker = new PipelineWorker(pipeline, {
      params: new PipelineParams({
        enableHeartbeats: true,
        heartbeatsPeriodSecs: 0.1,
      }),
      idleTimeoutSecs: 0.3,
    });
    await worker.run(workerParams());
  });

  test("test_idle_task_event_handler_no_frames", async () => {
    const identity = new IdentityFilter();
    const pipeline = new Pipeline([identity]);
    const worker = new PipelineWorker(pipeline, {
      idleTimeoutSecs: 0.2,
      cancelOnIdleTimeout: false,
    });

    let idleTimeout = false;

    worker.eventHandler("on_idle_timeout", async (worker: PipelineWorker) => {
      idleTimeout = true;
      await worker.cancel();
    });

    await worker.run(workerParams());
    expect(idleTimeout).toBe(true);
  });

  test("test_idle_task_event_handler_quiet_user", async () => {
    // Quiet user audio doesn't count as activity, and a timeout doesn't fire again at once.
    const idleTimeoutSecs = 0.2;
    const identity = new IdentityFilter();
    const pipeline = new Pipeline([identity]);
    const worker = new PipelineWorker(pipeline, {
      idleTimeoutSecs,
      cancelOnIdleTimeout: false,
    });

    const firedAt: number[] = [];
    const finished = new Event();

    worker.eventHandler("on_idle_timeout", async (worker: PipelineWorker) => {
      firedAt.push(monotonic());
      if (firedAt.length === 1) {
        // Wrap up while user audio keeps coming in, as a bot saying
        // goodbye would, then end the pipeline.
        await sleep(0.1);
        await worker.queueFrame(new EndFrame());
      }
    });

    const sendAudio = async (): Promise<void> => {
      while (!finished.isSet()) {
        await worker.queueFrame(
          new InputAudioRawFrame({
            audio: new Uint8Array([0x00]),
            sampleRate: 16000,
            numChannels: 1,
          }),
        );
        await sleep(0.01);
      }
    };

    const run = async (): Promise<void> => {
      try {
        await worker.run(workerParams());
      } finally {
        finished.set();
      }
    };

    await waitFor(
      () =>
        gather(
          () => sendAudio(),
          () => run(),
        ),
      5.0,
    );

    // The audio never stopped, so the timeout fired while it was coming in.
    expect(firedAt.length).toBeGreaterThanOrEqual(1);
    // A timeout waits a whole idle period before firing again, however long
    // the pipeline takes to end, instead of firing on the next frame.
    const gaps = firedAt.slice(1).map((later, i) => later - firedAt[i]!);
    expect(gaps.every((gap) => gap >= idleTimeoutSecs)).toBe(true);
  });

  test("test_idle_task_frames", async () => {
    const idleTimeoutSecs = 0.2;
    const sleepTimeSecs = idleTimeoutSecs / 2;

    // Use the identify filter so the frames just reach the end of the pipeline.
    const identity = new IdentityFilter();
    const pipeline = new Pipeline([identity]);
    const worker = new PipelineWorker(pipeline, {
      idleTimeoutSecs,
      idleTimeoutFrames: [TextFrame],
    });

    /**
     * Sending multiple text frames.
     *
     * The total amount of elapsed time in this function should be greater
     * than the worker idle timeout. If an idle timeout event is triggered it
     * means we haven't detected that the TextFrames have been pushed.
     */
    const delayedFrames = async (): Promise<void> => {
      await sleep(sleepTimeSecs);
      await worker.queueFrame(new TextFrame({ text: "Hello Pipecat!" }));
      await sleep(sleepTimeSecs);
      await worker.queueFrame(new TextFrame({ text: "Hello Pipecat!" }));
      await sleep(sleepTimeSecs);
      await worker.queueFrame(new TextFrame({ text: "Hello Pipecat!" }));
    };

    const startTime = time();

    const tasks: Task<void>[] = [
      createTask(() => worker.run(workerParams())),
      createTask(() => delayedFrames()),
    ];

    const [, pending] = await wait(tasks, { returnWhen: FIRST_COMPLETED });

    const diffTime = time() - startTime;

    expect(diffTime).toBeGreaterThan(sleepTimeSecs * 3);

    // Wait for the pending tasks to complete.
    await gather(...pending);
  });

  test("test_idle_task_external_user_activity", async () => {
    const idleTimeoutSecs = 0.4;
    const activityPeriodSecs = 0.1;

    // A pipeline whose turns are detected by a provider instead of local VAD
    // pushes no UserSpeakingFrame, so the default idle timeout frames have to
    // pick up the turn and transcription frames it does push.
    const identity = new IdentityFilter();
    const pipeline = new Pipeline([identity]);
    const worker = new PipelineWorker(pipeline, {
      idleTimeoutSecs,
      cancelOnIdleTimeout: false,
    });

    const started = new Event();
    let idleTimeouts = 0;
    let idleTimeoutsDuringTurn = 0;

    worker.eventHandler(
      "on_pipeline_started",
      async (_worker: PipelineWorker, _frame: StartFrame) => {
        started.set();
      },
    );

    worker.eventHandler("on_idle_timeout", async (_worker: PipelineWorker) => {
      idleTimeouts += 1;
    });

    /** Sending a single user turn that outlasts the idle timeout. */
    const externalUserTurn = async (): Promise<void> => {
      // The idle monitor only watches frames the running pipeline pushes,
      // so nothing sent before this point counts as activity.
      await waitFor(() => started.wait(), 5);

      await worker.queueFrame(new UserStartedSpeakingFrame());
      for (let i = 0; i < 6; i++) {
        await sleep(activityPeriodSecs);
        await worker.queueFrame(
          new InterimTranscriptionFrame({ text: "Hello Pipecat!", userId: "cat", timestamp: "" }),
        );
      }
      await worker.queueFrame(new UserStoppedSpeakingFrame());
      idleTimeoutsDuringTurn = idleTimeouts;

      // The timeout still fires once the user goes quiet.
      await sleep(idleTimeoutSecs * 2);
      await worker.queueFrame(new EndFrame());
    };

    await gather(
      () => worker.run(workerParams()),
      () => externalUserTurn(),
    );

    expect(idleTimeoutsDuringTurn).toEqual(0);
    expect(idleTimeouts).toBeGreaterThan(0);
  });

  test("test_idle_task_swallowed_frames", async () => {
    const idleTimeoutSecs = 0.2;
    const sleepTimeSecs = idleTimeoutSecs / 2;

    // Block all frames (except system frames). Here, we are testing that
    // generated frames don't trigger an idle timeout (they don't need to
    // reach the end of the pipeline).
    const filter = new FrameFilter({ types: [] });
    const pipeline = new Pipeline([filter]);
    const worker = new PipelineWorker(pipeline, {
      idleTimeoutSecs,
      idleTimeoutFrames: [TextFrame],
    });

    const startTime = time();

    /**
     * Sending multiple text frames.
     *
     * The total amount of elapsed time in this function should be greater
     * than the worker idle timeout. If an idle timeout event is triggered it
     * means we haven't detected that the TextFrames have been pushed.
     */
    const delayedFrames = async (): Promise<void> => {
      await sleep(sleepTimeSecs);
      await worker.queueFrame(new TextFrame({ text: "Hello Pipecat!" }));
      await sleep(sleepTimeSecs);
      await worker.queueFrame(new TextFrame({ text: "Hello Pipecat!" }));
      await sleep(sleepTimeSecs);
      await worker.queueFrame(new TextFrame({ text: "Hello Pipecat!" }));
    };

    const tasks: Task<void>[] = [
      createTask(() => worker.run(workerParams())),
      createTask(() => delayedFrames()),
    ];

    const [, pending] = await wait(tasks, { returnWhen: FIRST_COMPLETED });

    const diffTime = time() - startTime;

    expect(diffTime).toBeGreaterThan(sleepTimeSecs * 3);

    // Wait for the pending tasks to complete.
    await gather(...pending);
  });

  test("test_task_cancel_timeout", async () => {
    class CancelFilter extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);

        if (!(frame instanceof CancelFrame)) {
          await this.pushFrame(frame, direction);
        }
      }
    }

    const pipeline = new Pipeline([new CancelFilter()]);
    const worker = new PipelineWorker(pipeline, { cancelTimeoutSecs: 0.2 });

    let cancelled = false;

    worker.eventHandler(
      "on_pipeline_started",
      async (worker: PipelineWorker, _frame: StartFrame) => {
        await worker.cancel();
      },
    );

    worker.eventHandler("on_pipeline_finished", async (_worker: PipelineWorker, frame: Frame) => {
      cancelled = frame instanceof CancelFrame;
    });

    try {
      await worker.run(workerParams());
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
      expect(cancelled).toBe(true);
    }
  });

  test("test_task_cancel_before_start_reaches_sink", async () => {
    interface StartBlockerOptions extends FrameProcessorOptions {
      startReceived: Event;
    }

    class StartBlocker extends FrameProcessor {
      protected _startReceived: Event;
      protected _block = new Event();

      constructor(options: StartBlockerOptions) {
        super(options);
        this._startReceived = options.startReceived;
      }

      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);

        if (frame instanceof StartFrame) {
          this._startReceived.set();
          await this._block.wait();
        }

        await this.pushFrame(frame, direction);
      }
    }

    const startReceived = new Event();
    const pipeline = new Pipeline([new StartBlocker({ startReceived })]);
    const worker = new PipelineWorker(pipeline, { cancelTimeoutSecs: 0.1 });

    const timedOut: Frame[] = [];

    worker.eventHandler("on_pipeline_timeout", async (_worker: PipelineWorker, frame: Frame) => {
      timedOut.push(frame);
    });

    const runTask = createTask(() => worker.run(workerParams()));
    await startReceived.wait();
    await worker.cancel();
    await waitFor(runTask, 1.0);

    expect(worker.hasFinished()).toBe(true);

    // The pipeline never started, so it is only cleaned up: no CancelFrame
    // is pushed, so nothing waits for one to time out.
    expect(timedOut.length).toEqual(0);
  });

  test("test_task_start_frame_never_reaches_sink", async () => {
    class StartBlocker extends FrameProcessor {
      protected _block = new Event();

      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);

        if (frame instanceof StartFrame) {
          await this._block.wait();
        }

        await this.pushFrame(frame, direction);
      }
    }

    const pipeline = new Pipeline([new StartBlocker()]);
    const worker = new PipelineWorker(pipeline, {
      startTimeoutSecs: 0.1,
      cancelTimeoutSecs: 0.1,
    });

    const timedOut: Frame[] = [];

    worker.eventHandler("on_pipeline_timeout", async (_worker: PipelineWorker, frame: Frame) => {
      timedOut.push(frame);
    });

    await waitFor(() => worker.run(workerParams()), 2.0);

    expect(worker.hasFinished()).toBe(true);

    // Nothing else tells the application its pipeline never came up.
    expect(timedOut.length).toEqual(1);
    expect(timedOut[0]).toBeInstanceOf(StartFrame);
  });

  test("test_task_setup_never_finishes", async () => {
    // Processors connect while they are set up, so one that never connects
    // would otherwise leave run() waiting on it with nothing to time it out.

    class SetupBlocker extends FrameProcessor {
      protected _block = new Event();

      override async setup(setup: FrameProcessorSetup): Promise<void> {
        await super.setup(setup);
        await this._block.wait();
      }
    }

    const pipeline = new Pipeline([new SetupBlocker()]);
    const worker = new PipelineWorker(pipeline, {
      setupTimeoutSecs: 0.1,
      cancelTimeoutSecs: 0.1,
    });

    const timedOut: boolean[] = [];

    worker.eventHandler("on_setup_timeout", async (_worker: PipelineWorker) => {
      timedOut.push(true);
    });

    await waitFor(() => worker.run(workerParams()), 2.0);

    expect(worker.hasFinished()).toBe(true);

    // Nothing else tells the application its pipeline never came up.
    expect(timedOut.length).toEqual(1);
  });

  test("test_task_cancel_before_setup_never_finishes", async () => {
    // A cancel that arrives before processors are set up still stops a
    // processor that never finishes setting up.

    class SetupBlocker extends IdentityFilter {
      protected _block = new Event();

      override async setup(setup: FrameProcessorSetup): Promise<void> {
        await super.setup(setup);
        await this._block.wait();
      }
    }

    const pipeline = new Pipeline([new SetupBlocker()]);
    const worker = new PipelineWorker(pipeline, { setupTimeoutSecs: 0.1 });

    const timedOut: Frame[] = [];

    worker.eventHandler("on_pipeline_timeout", async (_worker: PipelineWorker, frame: Frame) => {
      timedOut.push(frame);
    });

    await worker.cancel();
    await waitFor(() => worker.run(workerParams()), 2.0);

    expect(worker.hasFinished()).toBe(true);
    expect(timedOut.length).toEqual(0);
  });

  test("test_task_cancel_from_setup", async () => {
    // A processor can cancel the worker from its own setup(), e.g. when
    // it can't connect.

    class SetupCanceller extends IdentityFilter {
      override async setup(setup: FrameProcessorSetup): Promise<void> {
        await super.setup(setup);
        await setup.pipelineWorker!.cancel({ reason: "cannot connect" });
      }
    }

    const pipeline = new Pipeline([new IdentityFilter(), new SetupCanceller()]);
    const worker = new PipelineWorker(pipeline);

    const timedOut: Frame[] = [];

    worker.eventHandler("on_pipeline_timeout", async (_worker: PipelineWorker, frame: Frame) => {
      timedOut.push(frame);
    });

    await waitFor(() => worker.run(workerParams()), 2.0);

    expect(worker.hasFinished()).toBe(true);
    expect(timedOut.length).toEqual(0);
  });

  test("test_task_setup_timeout_still_cleans_the_rest_up", async () => {
    // Setting up is abandoned part-way, so processors are cleaned up from
    // states they never finished reaching.

    class SetupBlocker extends FrameProcessor {
      protected _block = new Event();

      override async setup(setup: FrameProcessorSetup): Promise<void> {
        await super.setup(setup);
        await this._block.wait();
      }
    }

    class CleanupFailer extends FrameProcessor {
      override async cleanup(): Promise<void> {
        await super.cleanup();
        throw new Error("cannot clean up");
      }
    }

    const cleaned: string[] = [];

    class CleanupRecorder extends FrameProcessor {
      override async cleanup(): Promise<void> {
        await super.cleanup();
        cleaned.push(this.name);
      }
    }

    const pipeline = new Pipeline([new CleanupFailer(), new SetupBlocker(), new CleanupRecorder()]);
    const worker = new PipelineWorker(pipeline, {
      setupTimeoutSecs: 0.1,
      cancelTimeoutSecs: 0.1,
    });

    await waitFor(() => worker.run(workerParams()), 2.0);

    // The failing cleanup must not cost the others theirs.
    expect(cleaned.length).toEqual(1);
  });

  test("test_task_end_frame_blocked_by_paused_tts_service", async () => {
    // TTSService pauses its process queue while audio is in flight
    // (pause_frame_processing=True) and is normally unpaused by a
    // BotStoppedSpeakingFrame — a SystemFrame, so it bypasses the pause via
    // the input task instead of queuing behind it — sent by the output
    // transport once it confirms audio actually played.
    //
    // Here, a TTS context completes (isFinal) having produced zero
    // TTSAudioRawFrames, so the transport's BotStoppedSpeakingFrame gate
    // (`_tts_audio_received`) never opens and no resume signal arrives. This
    // test has no transport, so no BotStoppedSpeakingFrame or
    // BotStartedSpeakingFrame is ever sent, modeling that gap directly.
    //
    // The terminal EndFrame is a ControlFrame, so a pause left latched would
    // queue it behind the pause and it would never reach the sink —
    // _wait_for_pipeline_end's EndFrame branch has no timeout (unlike the
    // CancelFrame branch), so PipelineWorker.run() would never return.

    class TTSZeroAudioNoResume extends TTSService {
      constructor(options: TTSServiceOptions = {}) {
        super({
          pushStartFrame: true,
          pushTextFrames: false,
          pauseFrameProcessing: true,
          sampleRate: 16000,
          ...options,
        });
      }

      override canGenerateMetrics(): boolean {
        return false;
      }

      // biome-ignore lint/correctness/useYield: matches upstream (no audio, `if False: yield`)
      override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
        // Provider reports the context finished (isFinal) with no
        // audio — same as ElevenLabsTTSService against a
        // quota-exhausted key.
        await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
        await this.removeAudioContext(contextId);
      }
    }

    const pipeline = new Pipeline([new TTSZeroAudioNoResume()]);
    const worker = new PipelineWorker(pipeline, { cancelTimeoutSecs: 0.2 });

    await worker.queueFrames([
      new LLMFullResponseStartFrame(),
      new TextFrame({ text: "hi" }),
      new LLMFullResponseEndFrame(),
      new EndFrame(),
    ]);

    await waitFor(() => worker.run(workerParams()), 1.0);

    expect(worker.hasFinished()).toBe(true);
  });

  test("test_task_error", async () => {
    class ErrorProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);

        if (frame instanceof TextFrame) {
          // Upstream passes an ErrorFrame to push_error(); pushErrorFrame()
          // is the typed equivalent.
          await this.pushErrorFrame(new ErrorFrame({ error: "Boo!" }));
        }

        await this.pushFrame(frame, direction);
      }
    }

    let errorReceived = false;

    const pipeline = new Pipeline([new ErrorProcessor()]);
    const worker = new PipelineWorker(pipeline);

    worker.eventHandler("on_pipeline_error", async (worker: PipelineWorker, _frame: ErrorFrame) => {
      errorReceived = true;
      await worker.cancel();
    });

    await worker.queueFrame(new TextFrame({ text: "Hello from Pipecat!" }));

    try {
      await worker.run(workerParams());
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
      expect(errorReceived).toBe(true);
    }
  });

  test("test_heartbeat_timeout_event_handler", async () => {
    // on_heartbeat_timeout fires when heartbeat frames cannot reach the sink.
    const pipeline = new Pipeline([new FrameFilter({ types: [] })]);
    const worker = new PipelineWorker(pipeline, {
      params: new PipelineParams({
        enableHeartbeats: true,
        heartbeatsPeriodSecs: 0.05,
        heartbeatsMonitorSecs: 0.1,
      }),
    });

    let heartbeatTimeout = false;

    worker.eventHandler("on_heartbeat_timeout", async (worker: PipelineWorker) => {
      heartbeatTimeout = true;
      await worker.cancel();
    });

    await worker.run(workerParams());
    expect(heartbeatTimeout).toBe(true);
  });

  test("test_heartbeat_timeout_fires_repeatedly", async () => {
    // on_heartbeat_timeout keeps firing every heartbeats_monitor_secs while stalled.
    const pipeline = new Pipeline([new FrameFilter({ types: [] })]);
    const worker = new PipelineWorker(pipeline, {
      params: new PipelineParams({
        enableHeartbeats: true,
        heartbeatsPeriodSecs: 0.05,
        heartbeatsMonitorSecs: 0.1,
      }),
    });

    let timeoutCount = 0;

    worker.eventHandler("on_heartbeat_timeout", async (worker: PipelineWorker) => {
      timeoutCount += 1;
      if (timeoutCount >= 2) {
        await worker.cancel();
      }
    });

    await worker.run(workerParams());
    expect(timeoutCount).toBeGreaterThanOrEqual(2);
  });
});

interface StartRecorderOptions extends FrameProcessorOptions {
  setupSecs?: number;
  failSetup?: boolean;
  preSetupSecs?: number;
  setupWaitsFor?: readonly StartRecorder[];
}

/**
 * Takes `setupSecs` to set up, like a service connecting, and records when it
 * gets the StartFrame (seconds since `t0`), whether it gets a CancelFrame and
 * whether it is cleaned up. `preSetupSecs` are spent before
 * `FrameProcessor.setup()`, like a processor that connects first.
 * Setting up also waits until the `setupWaitsFor` processors have the
 * StartFrame: if this setup held it from them, the worker would never finish.
 */
class StartRecorder extends FrameProcessor {
  protected _t0: number;
  protected _setupSecs: number;
  protected _failSetup: boolean;
  protected _preSetupSecs: number;
  protected _setupWaitsFor: readonly StartRecorder[];
  startAt: number | null = null;
  started = new Event();
  gotCancel = false;
  cleanedUp = false;

  constructor(t0: number, options: StartRecorderOptions = {}) {
    super(options);
    this._t0 = t0;
    this._setupSecs = options.setupSecs ?? 0.0;
    this._failSetup = options.failSetup ?? false;
    this._preSetupSecs = options.preSetupSecs ?? 0.0;
    this._setupWaitsFor = options.setupWaitsFor ?? [];
  }

  override async setup(setup: FrameProcessorSetup): Promise<void> {
    if (this._preSetupSecs) {
      await sleep(this._preSetupSecs);
    }
    await super.setup(setup);
    await sleep(this._setupSecs);
    for (const processor of this._setupWaitsFor) {
      await processor.started.wait();
    }
    if (this._failSetup) {
      throw new Error("cannot connect");
    }
  }

  override async cleanup(): Promise<void> {
    await super.cleanup();
    this.cleanedUp = true;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof StartFrame) {
      this.startAt = monotonic() - this._t0;
      this.started.set();
    } else if (frame instanceof CancelFrame) {
      this.gotCancel = true;
    }
    await this.pushFrame(frame, direction);
  }
}

describe("TestPipelineWorkerStartup", () => {
  // Each processor holds the StartFrame only for its own setup.

  const runWorker = async (worker: PipelineWorker): Promise<void> => {
    await waitFor(() => worker.run(workerParams()), 5.0);
  };

  test("test_start_frame_not_held_by_unrelated_setup", async () => {
    // A slow service setup (e.g. an LLM connecting) must not delay the
    // StartFrame for processors before it. The input transport only starts
    // reading audio once it gets the StartFrame, so callers' first audio
    // would wait on the slowest connection (#5868).
    const sttSetupSecs = 0.2;
    const llmSetupSecs = 1.0;
    const t0 = monotonic();

    // The input transport starts while STT is still connecting, and STT
    // while the LLM is.
    const transportInput = new StartRecorder(t0, { name: "input" });
    const stt = new StartRecorder(t0, {
      setupSecs: sttSetupSecs,
      setupWaitsFor: [transportInput],
      name: "stt",
    });
    const llm = new StartRecorder(t0, {
      setupSecs: llmSetupSecs,
      setupWaitsFor: [stt],
      name: "llm",
    });

    const worker = new PipelineWorker(new Pipeline([transportInput, stt, llm]));

    const startedAt: number[] = [];

    worker.eventHandler("on_pipeline_started", async (_worker: PipelineWorker, _frame: Frame) => {
      startedAt.push(monotonic() - t0);
    });

    await worker.queueFrame(new EndFrame());
    await runWorker(worker);

    // STT still waits for its own connection.
    expect(stt.startAt!).toBeGreaterThanOrEqual(sttSetupSecs);
    // The pipeline still only counts as started once everything is set up.
    expect(llm.startAt!).toBeGreaterThanOrEqual(llmSetupSecs);
    expect(startedAt.length).toEqual(1);
    expect(startedAt[0]!).toBeGreaterThanOrEqual(llmSetupSecs);
  });

  test("test_slow_setup_in_parallel_branch", async () => {
    // A parallel pipeline doesn't hold the StartFrame for its branches.
    const t0 = monotonic();
    const first = new StartRecorder(t0);
    const fast = new StartRecorder(t0, { setupSecs: 0.1 });
    const slow = new StartRecorder(t0, { setupSecs: 1.0, setupWaitsFor: [first] });

    const worker = new PipelineWorker(new Pipeline([first, new ParallelPipeline([fast], [slow])]));
    await worker.queueFrame(new EndFrame());
    await runWorker(worker);

    expect(slow.startAt!).toBeGreaterThanOrEqual(1.0);
  });

  test("test_slow_setup_in_nested_pipeline", async () => {
    // A nested pipeline doesn't hold the StartFrame for its processors.
    const t0 = monotonic();
    const first = new StartRecorder(t0);
    const innerFast = new StartRecorder(t0, { setupSecs: 0.1 });
    const innerSlow = new StartRecorder(t0, { setupSecs: 1.0, setupWaitsFor: [first, innerFast] });

    const worker = new PipelineWorker(new Pipeline([first, new Pipeline([innerFast, innerSlow])]));
    await worker.queueFrame(new EndFrame());
    await runWorker(worker);

    expect(innerFast.startAt!).toBeGreaterThanOrEqual(0.1);
    expect(innerSlow.startAt!).toBeGreaterThanOrEqual(1.0);
  });

  test("test_failed_setup_still_starts", async () => {
    // A processor that fails to set up still lets the StartFrame through,
    // so the rest of the pipeline starts.
    const t0 = monotonic();
    const after = new StartRecorder(t0);
    const worker = new PipelineWorker(
      new Pipeline([
        new StartRecorder(t0),
        new StartRecorder(t0, { setupSecs: 0.1, failSetup: true }),
        after,
      ]),
    );

    const started: boolean[] = [];

    worker.eventHandler("on_pipeline_started", async (_worker: PipelineWorker, _frame: Frame) => {
      started.push(true);
    });

    await worker.queueFrame(new EndFrame());
    await runWorker(worker);

    expect(started.length).toEqual(1);
    expect(after.startAt).not.toBeNull();
  });

  test("test_start_timeout_counts_from_setup_done", async () => {
    // Setting up has its own timeout, so a setup that takes longer than
    // start_timeout_secs doesn't make the StartFrame time out.
    const t0 = monotonic();
    const llm = new StartRecorder(t0, { setupSecs: 0.5 });
    const worker = new PipelineWorker(new Pipeline([new StartRecorder(t0), llm]), {
      startTimeoutSecs: 0.2,
      setupTimeoutSecs: 5.0,
    });

    const timedOut: Frame[] = [];

    worker.eventHandler("on_pipeline_timeout", async (_worker: PipelineWorker, frame: Frame) => {
      timedOut.push(frame);
    });

    await worker.queueFrame(new EndFrame());
    await runWorker(worker);

    expect(timedOut.length).toEqual(0);
    expect(llm.startAt!).toBeGreaterThanOrEqual(0.5);
  });

  test("test_cancel_while_setting_up", async () => {
    // Cancelling doesn't wait for a processor that is still connecting,
    // e.g. when the caller hangs up first.
    const t0 = monotonic();
    const first = new StartRecorder(t0);
    const slow = new StartRecorder(t0, { setupSecs: 30.0 });
    const worker = new PipelineWorker(new Pipeline([first, slow]), { cancelTimeoutSecs: 3.0 });

    const cancelSoon = async (): Promise<void> => {
      await sleep(0.2);
      await worker.cancel();
    };

    await gather(
      () => runWorker(worker),
      () => cancelSoon(),
    );

    expect(worker.hasFinished()).toBe(true);
    expect(monotonic() - t0).toBeLessThan(3.0);
    // The cancelled setup is abandoned, so that processor never starts. The
    // pipeline never started either, so it is cleaned up, not cancelled.
    expect(first.startAt).not.toBeNull();
    expect(slow.startAt).toBeNull();
    expect(first.gotCancel).toBe(false);
    expect(first.cleanedUp && slow.cleanedUp).toBe(true);
  });

  test("test_cancel_at_any_point_of_starting_finishes", async () => {
    // A cancel can land at any point while the worker starts, even before
    // its processors begin setting up, and the worker still finishes.
    for (let ticks = 0; ticks < 25; ticks++) {
      const worker = new PipelineWorker(new Pipeline([new IdentityFilter()]));
      const runTask = createTask(() => worker.run(workerParams()));
      for (let i = 0; i < ticks; i++) {
        await sleep(0);
      }
      await worker.cancel();

      const [done] = await wait([runTask], { timeout: 2.0 });

      if (!done.has(runTask)) {
        throw new Error(`the worker hung when cancelled after ${ticks} ticks`);
      }
    }
  }, 60_000);

  test("test_setup_timeout_never_starts_the_pipeline", async () => {
    // A setup that times out is abandoned: its processor and the ones after
    // it never get the StartFrame, and the worker only cleans up.
    const t0 = monotonic();
    const first = new StartRecorder(t0);
    const blocked = new StartRecorder(t0, { setupSecs: 30.0 });
    const after = new StartRecorder(t0);
    const worker = new PipelineWorker(new Pipeline([first, blocked, after]), {
      setupTimeoutSecs: 0.2,
      cancelTimeoutSecs: 3.0,
    });

    const events: string[] = [];

    worker.eventHandler("on_setup_timeout", async (_worker: PipelineWorker) => {
      events.push("setup_timeout");
    });

    worker.eventHandler("on_pipeline_started", async (_worker: PipelineWorker, _frame: Frame) => {
      events.push("pipeline_started");
    });

    worker.eventHandler("on_pipeline_timeout", async (_worker: PipelineWorker, _frame: Frame) => {
      events.push("pipeline_timeout");
    });

    await runWorker(worker);

    expect(events).toEqual(["setup_timeout"]);
    expect(first.startAt).not.toBeNull();
    expect(blocked.startAt).toBeNull();
    expect(after.startAt).toBeNull();
    expect(first.gotCancel).toBe(false);
    expect(first.cleanedUp && blocked.cleanedUp && after.cleanedUp).toBe(true);
    // Nothing waits for a CancelFrame to drain.
    expect(monotonic() - t0).toBeLessThan(3.0);
  });

  test("test_setup_timeout_before_frame_processor_setup", async () => {
    // A processor that times out before calling FrameProcessor.setup()
    // has nothing to start with, and doesn't hold up the teardown.
    const t0 = monotonic();
    const blocked = new StartRecorder(t0, { preSetupSecs: 30.0 });
    const worker = new PipelineWorker(
      new Pipeline([new StartRecorder(t0), blocked, new StartRecorder(t0)]),
      {
        setupTimeoutSecs: 0.2,
        cancelTimeoutSecs: 3.0,
      },
    );

    const timedOut: Frame[] = [];

    worker.eventHandler("on_pipeline_timeout", async (_worker: PipelineWorker, frame: Frame) => {
      timedOut.push(frame);
    });

    await runWorker(worker);

    expect(timedOut.length).toEqual(0);
    expect(blocked.startAt).toBeNull();
    expect(monotonic() - t0).toBeLessThan(3.0);
  });

  test("test_idle_timeout_counts_from_start", async () => {
    // Setting up isn't idle time: the idle timeout only counts once the
    // pipeline has started.
    const t0 = monotonic();
    const llm = new StartRecorder(t0, { setupSecs: 0.5 });
    const worker = new PipelineWorker(new Pipeline([new StartRecorder(t0), llm]), {
      idleTimeoutSecs: 0.2,
    });

    const idleAt: number[] = [];

    worker.eventHandler("on_idle_timeout", async (_worker: PipelineWorker) => {
      idleAt.push(monotonic() - t0);
    });

    await runWorker(worker);

    expect(llm.startAt).not.toBeNull();
    expect(idleAt.length).toEqual(1);
    expect(idleAt[0]!).toBeGreaterThanOrEqual(llm.startAt!);
  });

  test("test_sync_parallel_pipeline_starts_after_its_branches", async () => {
    // A sync parallel pipeline passes the StartFrame on only once it is
    // through all its branches, so the pipeline counts as started only once
    // a slow branch is set up.
    const t0 = monotonic();
    const first = new StartRecorder(t0);
    const slow = new StartRecorder(t0, { setupSecs: 0.5, setupWaitsFor: [first] });
    const after = new StartRecorder(t0);
    const worker = new PipelineWorker(
      new Pipeline([first, new SyncParallelPipeline([slow]), after]),
    );

    const startedAt: number[] = [];

    worker.eventHandler("on_pipeline_started", async (_worker: PipelineWorker, _frame: Frame) => {
      startedAt.push(monotonic() - t0);
    });

    await worker.queueFrame(new EndFrame());
    await runWorker(worker);

    expect(slow.startAt!).toBeGreaterThanOrEqual(0.5);
    expect(after.startAt!).toBeGreaterThanOrEqual(slow.startAt!);
    expect(startedAt.length).toEqual(1);
    expect(startedAt[0]!).toBeGreaterThanOrEqual(slow.startAt!);
  });

  test("test_sync_parallel_pipeline_set_up_late_starts_its_branches", async () => {
    // The StartFrame can reach a sync parallel pipeline before its branches
    // begin setting up; their processors still hold it until they are set
    // up, so they start.

    class SlowToSetUp extends SyncParallelPipeline {
      override async setup(setup: FrameProcessorSetup): Promise<void> {
        await sleep(0.2);
        await super.setup(setup);
      }
    }

    const t0 = monotonic();
    const inner = new StartRecorder(t0);
    const after = new StartRecorder(t0);
    const worker = new PipelineWorker(
      new Pipeline([new StartRecorder(t0), new SlowToSetUp([inner]), after]),
    );
    await worker.queueFrame(new EndFrame());
    await runWorker(worker);

    expect(inner.startAt).not.toBeNull();
    expect(after.startAt).not.toBeNull();
  });
});
