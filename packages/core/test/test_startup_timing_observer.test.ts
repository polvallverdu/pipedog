// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_startup_timing_observer.py

import { describe, expect, spyOn, test } from "bun:test";

import * as asyncio from "@pipecat-ts/asyncio";
import { Event, sleep, TimeoutError, waitFor } from "@pipecat-ts/asyncio";

import {
  BotConnectedFrame,
  ClientConnectedFrame,
  type Frame,
  StartFrame,
  TextFrame,
} from "../src/frames/frames.ts";
import { FrameProcessed, FramePushed, ProcessorSetUp } from "../src/observers/base_observer.ts";
import {
  StartupTimingObserver,
  StartupTimingReport,
  TransportTimingReport,
} from "../src/observers/startup_timing_observer.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "../src/processors/frame_processor.ts";
import { runTest } from "../src/tests/utils.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";

/** A processor that sleeps during start to simulate slow initialization. */
class SlowStartProcessor extends FrameProcessor {
  #delay: number;

  constructor(delay = 0.1, options: FrameProcessorOptions = {}) {
    super(options);
    this.#delay = delay;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof StartFrame) {
      await sleep(this.#delay);
    }
    await this.pushFrame(frame, direction);
  }
}

/** A processor that sleeps while being set up, as a connecting one does. */
class SlowSetupProcessor extends FrameProcessor {
  #delay: number;

  constructor(delay = 0.1, options: FrameProcessorOptions = {}) {
    super(options);
    this.#delay = delay;
  }

  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await sleep(this.#delay);
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);
  }
}

/**
 * Local stand-in for Python's `asyncio.Barrier`, which `@pipecat-ts/asyncio`
 * does not provide: `wait()` resolves once `parties` callers are waiting.
 */
class Barrier {
  #parties: number;
  #count = 0;
  #event = new Event();

  constructor(parties: number) {
    this.#parties = parties;
  }

  async wait(): Promise<void> {
    this.#count += 1;
    if (this.#count >= this.#parties) {
      this.#event.set();
    }
    await this.#event.wait();
  }
}

/**
 * A processor that records whether its setup overlapped with its peers'.
 *
 * The barrier releases only once every processor sharing it is inside
 * `setup()`, so setting up one at a time leaves each waiting for peers that
 * never arrive.
 */
class ConcurrentSetupProcessor extends FrameProcessor {
  static OVERLAP_TIMEOUT_SECS = 1.0;

  #barrier: Barrier;
  #timeout: number;
  overlapped = false;

  constructor(
    barrier: Barrier,
    timeout: number = ConcurrentSetupProcessor.OVERLAP_TIMEOUT_SECS,
    options: FrameProcessorOptions = {},
  ) {
    super(options);
    this.#barrier = barrier;
    this.#timeout = timeout;
  }

  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    try {
      await waitFor(this.#barrier.wait(), this.#timeout);
      this.overlapped = true;
    } catch (e) {
      // A setup that raises is reported as a processor error and the
      // pipeline carries on, so a missed overlap has to reach the test
      // as a value to be asserted on.
      if (!(e instanceof TimeoutError)) throw e;
      this.overlapped = false;
    }
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);
  }
}

/** Convert a point on a test timeline to the nanoseconds an event carries. */
function ns(seconds: number): number {
  return Math.trunc(seconds * 1_000_000_000);
}

/**
 * A clock the test moves by hand.
 *
 * The observer takes every timing it reports from the timestamps its events
 * carry, so standing in for the two readings it makes of its own leaves a
 * report that can be asserted exactly.
 */
class FakeClock {
  #nowNs = 0;

  set(seconds: number): void {
    this.#nowNs = ns(seconds);
  }

  /**
   * Stand in for the clock functions the observer reads. Equivalent of
   * `patch.object(startup_timing_observer, "time", clock.as_time_module())`.
   * Returns a function that restores them.
   */
  patch(): () => void {
    const monotonic = spyOn(asyncio, "monotonicNs").mockImplementation(() => this.#nowNs);
    const wall = spyOn(asyncio, "time").mockImplementation(() => 1_000.0);
    return () => {
      monotonic.mockRestore();
      wall.mockRestore();
    };
  }
}

/** A processor with no start delay. */
class FastProcessor extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);
  }
}

/** Send a StartFrame through the processors one after another. */
async function walkStartFrame(
  observer: StartupTimingObserver,
  processors: FrameProcessor[],
  { firstArrival, each }: { firstArrival: number; each: number },
): Promise<void> {
  const frame = new StartFrame();
  let arrival = firstArrival;
  for (const processor of processors) {
    await observer.onProcessFrame(
      new FrameProcessed({
        processor,
        frame,
        direction: FrameDirection.DOWNSTREAM,
        timestamp: ns(arrival),
      }),
    );
    arrival += each;
    await observer.onPushFrame(
      new FramePushed({
        source: processor,
        destination: processor,
        frame,
        direction: FrameDirection.DOWNSTREAM,
        timestamp: ns(arrival),
      }),
    );
  }
}

/** Tests for StartupTimingObserver. */
describe("TestStartupTimingObserver", () => {
  test("test_timing_reported", async () => {
    // Test that startup timing is measured and reported.
    const observer = new StartupTimingObserver();
    const processor = new SlowStartProcessor(0.1);

    const reports: StartupTimingReport[] = [];

    observer.eventHandler("on_startup_timing_report", async (_obs, report) => {
      reports.push(report as StartupTimingReport);
    });

    const framesToSend = [new TextFrame({ text: "hello" })];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames: [TextFrame],
      observers: [observer],
    });

    expect(reports.length).toEqual(1);
    const report = reports[0]!;
    expect(report.totalDurationSecs).toBeGreaterThan(0);
    expect(report.processorTimings.length).toBeGreaterThan(0);

    // Find our slow processor in the timings.
    const slowTimings = report.processorTimings.filter((t) =>
      t.processorName.includes("SlowStartProcessor"),
    );
    expect(slowTimings.length).toEqual(1);
    expect(slowTimings[0]!.durationSecs).toBeGreaterThanOrEqual(0.05);
  });

  test("test_setup_time_counts_towards_what_a_processor_cost", async () => {
    // A processor that connects while being set up is measured for it.
    //
    // Services connect during setup rather than while handling the
    // StartFrame, so a report that only measured start() would show a fast
    // startup for a pipeline that spent its time connecting.
    const observer = new StartupTimingObserver();
    const processor = new SlowSetupProcessor(0.1);

    const reports: StartupTimingReport[] = [];

    observer.eventHandler("on_startup_timing_report", async (_obs, report) => {
      reports.push(report as StartupTimingReport);
    });

    await runTest(processor, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: [TextFrame],
      observers: [observer],
    });

    const timings = reports[0]!.processorTimings.filter((t) =>
      t.processorName.includes("SlowSetupProcessor"),
    );
    expect(timings.length).toEqual(1);
    const timing = timings[0]!;

    expect(timing.setupDurationSecs).toBeGreaterThanOrEqual(0.05);
    // Setting up is what this processor cost, and start() added nothing.
    expect(timing.durationSecs).toBeGreaterThanOrEqual(timing.setupDurationSecs);
  });

  test("test_a_started_pipeline_reports_its_phases", async () => {
    // The report a real pipeline produces covers both startup phases.
    //
    // The barrier holds all three processors inside setup() together, so the
    // concurrency the setup phase is built on holds however slowly the
    // machine runs them.
    const observer = new StartupTimingObserver();
    const barrier = new Barrier(3);
    const processors = [0, 1, 2].map(() => new ConcurrentSetupProcessor(barrier));

    const reports: StartupTimingReport[] = [];

    observer.eventHandler("on_startup_timing_report", async (_obs, report) => {
      reports.push(report as StartupTimingReport);
    });

    await runTest(new Pipeline(processors), {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: [TextFrame],
      observers: [observer],
      // A setup that does not overlap spends a timeout per processor
      // before reaching the assertion below, which the default start
      // timeout would cut short and report as a failure to start.
      startTimeout: 5.0,
    });

    // "the three processors were not all inside setup() at once"
    expect(processors.every((p) => p.overlapped)).toBe(true);

    const report = reports[0]!;
    expect(
      report.processorTimings.filter((t) => t.processorName.includes("ConcurrentSetupProcessor"))
        .length,
    ).toEqual(3);
    // `warmup` is deprecated upstream (always None) and is not ported.
    expect((report as { warmup?: unknown }).warmup ?? null).toBeNull();
    expect(report.totalDurationSecs).toBeGreaterThanOrEqual(report.setupPhaseSecs);
  });

  test("test_phases_split_the_span_where_setting_up_ends", async () => {
    // Setting up ends with the last processor to finish connecting.
    //
    // Three processors connect together, so the concurrent phase runs to the
    // last of them and the StartFrame's trip through the pipeline is what
    // follows.
    const clock = new FakeClock();
    const reports: StartupTimingReport[] = [];
    const restore = clock.patch();
    try {
      const observer = new StartupTimingObserver();
      await observer.setup(new TaskManager());

      observer.eventHandler("on_startup_timing_report", async (_obs, report) => {
        reports.push(report as StartupTimingReport);
      });

      const processors = [0, 1, 2].map(() => new FastProcessor());
      for (const processor of processors) {
        await observer.onProcessorSetup(
          new ProcessorSetUp({ processor, startedAtNs: 0, finishedAtNs: ns(0.5) }),
        );
      }
      await walkStartFrame(observer, processors, { firstArrival: 0.5, each: 0.1 });

      clock.set(0.9);
      await observer.onPipelineStarted();
      await sleep(0);
    } finally {
      restore();
    }

    const report = reports[0]!;
    expect(report.totalDurationSecs).toBeCloseTo(0.9, 6);
    expect(report.setupPhaseSecs).toBeCloseTo(0.5, 6);
    // Everything after that is the frame's trip, the 0.3s the processors
    // spent on it and the 0.1s the pipeline spent carrying it between them.
    expect(report.startPhaseSecs).toBeCloseTo(0.4, 6);
    // `warmup` is deprecated upstream (always None) and is not ported.
    expect((report as { warmup?: unknown }).warmup ?? null).toBeNull();

    // The frame reached them one after another, so their offsets step.
    report.processorTimings.forEach((timing, index) => {
      expect(timing.setupDurationSecs).toBeCloseTo(0.5, 6);
      expect(timing.startDurationSecs).toBeCloseTo(0.1, 6);
      expect(timing.startOffsetSecs).toBeCloseTo(0.1 * index, 6);
    });
  });

  // Covers the deprecated `on_startup_warmup` / `StartupWarmup` API, which is not ported.
  test.skip("test_the_deprecated_warming_event_extends_the_setup_phase", () => {});

  // Covers the deprecated `on_startup_warmup` / `StartupWarmup` API, which is not ported.
  test.skip("test_the_deprecated_warming_event_inside_setup_costs_nothing", () => {});

  test("test_processor_types_filter", async () => {
    // Test that processor_types filter limits which processors appear.
    const observer = new StartupTimingObserver({ processorTypes: [SlowStartProcessor] });
    const processor = new SlowStartProcessor(0.05);

    const reports: StartupTimingReport[] = [];

    observer.eventHandler("on_startup_timing_report", async (_obs, report) => {
      reports.push(report as StartupTimingReport);
    });

    const framesToSend = [new TextFrame({ text: "hello" })];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames: [TextFrame],
      observers: [observer],
    });

    expect(reports.length).toEqual(1);
    const report = reports[0]!;

    // Only SlowStartProcessor should be in the timings.
    for (const t of report.processorTimings) {
      expect(t.processorName).toContain("SlowStartProcessor");
    }
  });

  test("test_report_emits_once", async () => {
    // Test that the report is emitted only once even with multiple frames.
    const observer = new StartupTimingObserver();
    const processor = new FastProcessor();

    const reports: StartupTimingReport[] = [];

    observer.eventHandler("on_startup_timing_report", async (_obs, report) => {
      reports.push(report as StartupTimingReport);
    });

    const framesToSend = [
      new TextFrame({ text: "first" }),
      new TextFrame({ text: "second" }),
      new TextFrame({ text: "third" }),
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames: [TextFrame, TextFrame, TextFrame],
      observers: [observer],
    });

    expect(reports.length).toEqual(1);
  });

  test("test_event_handler_receives_report", async () => {
    // Test that the event handler receives a proper StartupTimingReport.
    const observer = new StartupTimingObserver();
    const processor = new SlowStartProcessor(0.05);

    const reports: StartupTimingReport[] = [];

    observer.eventHandler("on_startup_timing_report", async (_obs, report) => {
      reports.push(report as StartupTimingReport);
    });

    const framesToSend = [new TextFrame({ text: "hello" })];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames: [TextFrame],
      observers: [observer],
    });

    expect(reports.length).toEqual(1);
    const report = reports[0]!;
    expect(report).toBeInstanceOf(StartupTimingReport);
    expect(typeof report.totalDurationSecs).toBe("number");
    expect(report.startTime).toBeGreaterThan(0);
    for (const timing of report.processorTimings) {
      expect(typeof timing.processorName).toBe("string");
      expect(typeof timing.durationSecs).toBe("number");
      expect(timing.startOffsetSecs).toBeGreaterThanOrEqual(0);
    }
  });

  test("test_excludes_internal_processors", async () => {
    // Test that internal pipeline processors are excluded by default.
    const observer = new StartupTimingObserver();
    const processor = new FastProcessor();

    const reports: StartupTimingReport[] = [];

    observer.eventHandler("on_startup_timing_report", async (_obs, report) => {
      reports.push(report as StartupTimingReport);
    });

    const framesToSend = [new TextFrame({ text: "hello" })];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames: [TextFrame],
      observers: [observer],
    });

    expect(reports.length).toEqual(1);
    const report = reports[0]!;

    // No internal processors (PipelineSource, PipelineSink, Pipeline) in the report.
    const internalNames = ["Pipeline#", "PipelineWorker#"];
    for (const t of report.processorTimings) {
      for (const prefix of internalNames) {
        // `Internal processor ${t.processorName} should be excluded by default`
        expect(t.processorName).not.toContain(prefix);
      }
    }
  });

  test("test_transport_timing_client_only", async () => {
    // Test that ClientConnectedFrame emits on_transport_timing_report.
    const observer = new StartupTimingObserver();
    const processor = new FastProcessor();

    const transportReports: TransportTimingReport[] = [];

    observer.eventHandler("on_transport_timing_report", async (_obs, report) => {
      transportReports.push(report as TransportTimingReport);
    });

    const framesToSend = [new ClientConnectedFrame(), new TextFrame({ text: "hello" })];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames: [ClientConnectedFrame, TextFrame],
      observers: [observer],
    });

    expect(transportReports.length).toEqual(1);
    const report = transportReports[0]!;
    expect(report).toBeInstanceOf(TransportTimingReport);
    expect(report.startTime).toBeGreaterThan(0);
    expect(report.clientConnectedSecs!).toBeGreaterThan(0);
    expect(report.botConnectedSecs).toBeNull();
  });

  test("test_transport_timing_only_first_client", async () => {
    // Test that only the first ClientConnectedFrame triggers the event.
    const observer = new StartupTimingObserver();
    const processor = new FastProcessor();

    const transportReports: TransportTimingReport[] = [];

    observer.eventHandler("on_transport_timing_report", async (_obs, report) => {
      transportReports.push(report as TransportTimingReport);
    });

    const framesToSend = [
      new ClientConnectedFrame(),
      new ClientConnectedFrame(),
      new TextFrame({ text: "hello" }),
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames: [ClientConnectedFrame, ClientConnectedFrame, TextFrame],
      observers: [observer],
    });

    expect(transportReports.length).toEqual(1);
  });

  test("test_transport_timing_before_the_start_frame", async () => {
    // A client that connects before the StartFrame is still measured.
    //
    // A transport connects while it is being set up, so it can report a
    // connection before the StartFrame is pushed. Timings run from the
    // pipeline starting to set up, so there is nothing to wait for.
    const observer = new StartupTimingObserver();
    await observer.setup(new TaskManager());

    const reports: TransportTimingReport[] = [];

    observer.eventHandler("on_transport_timing_report", async (_obs, report) => {
      reports.push(report as TransportTimingReport);
    });

    const processor = new FastProcessor();
    const data = new FramePushed({
      source: processor,
      destination: new FastProcessor(),
      frame: new ClientConnectedFrame(),
      direction: FrameDirection.DOWNSTREAM,
      timestamp: 250_000_000,
    });
    await observer.onPushFrame(data);
    await sleep(0);

    expect(
      (observer as unknown as { _transportTimingReported: boolean })._transportTimingReported,
    ).toBe(true);
    expect(reports.length).toEqual(1);
    expect(reports[0]!.clientConnectedSecs!).toBeCloseTo(0.25, 3);
  });

  test("test_bot_and_client_connected", async () => {
    // Test that BotConnectedFrame timing is included in the transport report.
    const observer = new StartupTimingObserver();
    const processor = new FastProcessor();

    const transportReports: TransportTimingReport[] = [];

    observer.eventHandler("on_transport_timing_report", async (_obs, report) => {
      transportReports.push(report as TransportTimingReport);
    });

    const framesToSend = [
      new BotConnectedFrame(),
      new ClientConnectedFrame(),
      new TextFrame({ text: "hello" }),
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames: [BotConnectedFrame, ClientConnectedFrame, TextFrame],
      observers: [observer],
    });

    expect(transportReports.length).toEqual(1);
    const report = transportReports[0]!;
    expect(report.clientConnectedSecs!).toBeGreaterThan(0);
    expect(report.botConnectedSecs).not.toBeNull();
    expect(report.botConnectedSecs!).toBeGreaterThan(0);

    // Client connected should be >= bot connected.
    expect(report.clientConnectedSecs!).toBeGreaterThanOrEqual(report.botConnectedSecs!);
  });

  test("test_bot_connected_only_first", async () => {
    // Test that only the first BotConnectedFrame is recorded.
    const observer = new StartupTimingObserver();
    const processor = new FastProcessor();

    const transportReports: TransportTimingReport[] = [];

    observer.eventHandler("on_transport_timing_report", async (_obs, report) => {
      transportReports.push(report as TransportTimingReport);
    });

    const framesToSend = [
      new BotConnectedFrame(),
      new BotConnectedFrame(),
      new ClientConnectedFrame(),
      new TextFrame({ text: "hello" }),
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames: [BotConnectedFrame, BotConnectedFrame, ClientConnectedFrame, TextFrame],
      observers: [observer],
    });

    // Only one transport report, with bot timing from first frame.
    expect(transportReports.length).toEqual(1);
    expect(transportReports[0]!.botConnectedSecs).not.toBeNull();
  });
});
