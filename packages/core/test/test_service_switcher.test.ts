// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_service_switcher.py

/** Unit tests for ServiceSwitcher and related components. */

import { beforeEach, describe, expect, test } from "bun:test";

import { Event, sleep, waitFor } from "@pipedog/asyncio";

import {
  ErrorFrame,
  type Frame,
  LLMUpdateSettingsFrame,
  ManuallySwitchServiceFrame,
  ServiceMetadataFrame,
  ServiceSwitcherRequestMetadataFrame,
  ServiceUpdateSettingsFrame,
  StartFrame,
  SystemFrame,
  TextFrame,
} from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import {
  ServiceSwitcher,
  ServiceSwitcherStrategy,
  ServiceSwitcherStrategyFailover,
  ServiceSwitcherStrategyManual,
} from "../src/pipeline/service_switcher.ts";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "../src/processors/frame_processor.ts";
import { LLMSettings } from "../src/services/settings.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import { ErrorCategory } from "../src/utils/errors.ts";
import { LOG_LEVELS, type LogLevel, logger } from "../src/utils/logger.ts";

/** A test frame processor that tracks which frames it has processed. */
class MockFrameProcessor extends FrameProcessor {
  testName: string;
  processedFrames: Frame[] = [];
  frameCount = 0;

  /**
   * Initialize the test processor with a name.
   *
   * @param testName A unique name for this processor instance.
   */
  constructor(testName: string, options: FrameProcessorOptions = {}) {
    super({ ...options, name: testName });
    this.testName = testName;
  }

  /** Process an incoming frame and track it. */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    this.processedFrames.push(frame);
    this.frameCount += 1;
    await this.pushFrame(frame, direction);
  }

  /** Reset the frame tracking counters. */
  resetCounters(): void {
    this.processedFrames = [];
    this.frameCount = 0;
  }
}

/** A mock metadata frame for testing ServiceMetadataFrame handling. */
class MockMetadataFrame extends ServiceMetadataFrame {}

/**
 * A mock service that emits ServiceMetadataFrame like STT services.
 *
 * Pushes MockMetadataFrame on StartFrame and ServiceSwitcherRequestMetadataFrame.
 */
class MockMetadataService extends FrameProcessor {
  testName: string;
  processedFrames: Frame[] = [];
  metadataPushCount = 0;

  constructor(testName: string, options: FrameProcessorOptions = {}) {
    super({ ...options, name: testName });
    this.testName = testName;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    this.processedFrames.push(frame);

    if (frame instanceof StartFrame) {
      await this.pushFrame(frame, direction);
      await this._pushMetadata();
    } else if (frame instanceof ServiceSwitcherRequestMetadataFrame) {
      await this._pushMetadata();
      await this.pushFrame(frame, direction);
    } else {
      await this.pushFrame(frame, direction);
    }
  }

  private async _pushMetadata(): Promise<void> {
    this.metadataPushCount += 1;
    await this.pushFrame(new MockMetadataFrame({ serviceName: this.testName }));
  }

  resetCounters(): void {
    this.processedFrames = [];
    this.metadataPushCount = 0;
  }
}

/**
 * A downstream processor that pushes an ErrorFrame upstream on receiving a TextFrame.
 *
 * Simulates an error from a service outside the ServiceSwitcher (e.g. TTS
 * erroring while propagating upstream through an LLM switcher).
 */
class ErrorInjectorProcessor extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof TextFrame && direction === FrameDirection.DOWNSTREAM) {
      await this.pushError("downstream service error");
    }
    await this.pushFrame(frame, direction);
  }
}

interface ErrorOnTextServiceOptions extends FrameProcessorOptions {
  becomesUnusable?: boolean;
  category?: ErrorCategory | null;
}

/**
 * A mock service that pushes an error on the first TextFrame it receives.
 *
 * Simulates a managed service inside a ServiceSwitcher that encounters an
 * error. `becomesUnusable` chooses between an error the service can carry on
 * from and one that ends its usefulness.
 */
class ErrorOnTextService extends FrameProcessor {
  #becomesUnusable: boolean;
  #category: ErrorCategory | null;
  #errored = false;

  constructor(testName: string, options: ErrorOnTextServiceOptions = {}) {
    const { becomesUnusable, category, ...rest } = options;
    super({ ...rest, name: testName });
    this.#becomesUnusable = becomesUnusable ?? true;
    this.#category = category ?? null;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof TextFrame && !this.#errored) {
      this.#errored = true;
      await this.pushError("service connection lost", {
        category: this.#category,
        forceTreatAsPermanent: this.#becomesUnusable,
      });
    }
    await this.pushFrame(frame, direction);
  }
}

interface RepeatedlyErroringServiceOptions extends FrameProcessorOptions {
  followUpErrors?: number;
}

/**
 * A mock service that goes on erroring after the switcher has moved off it.
 *
 * Simulates a websocket service whose reconnect loop keeps reporting: the
 * errors after the first come from a background task rather than from frame
 * processing, so they arrive once the service is no longer the active one.
 */
class RepeatedlyErroringService extends FrameProcessor {
  #followUpErrors: number;
  errors = 0;

  constructor(testName: string, options: RepeatedlyErroringServiceOptions = {}) {
    const { followUpErrors, ...rest } = options;
    super({ ...rest, name: testName });
    this.#followUpErrors = followUpErrors ?? 2;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof TextFrame && this.errors === 0) {
      this.errors += 1;
      await this.pushError("service connection lost", { forceTreatAsPermanent: true });
      this.createTask(() => this._retryLoop(), "retry");
    }
    await this.pushFrame(frame, direction);
  }

  private async _retryLoop(): Promise<void> {
    for (let attempt = 0; attempt < this.#followUpErrors; attempt++) {
      await sleep(0.02);
      this.errors += 1;
      await this.pushError(`reconnection attempt ${attempt + 1} failed`, {
        forceTreatAsPermanent: true,
      });
    }
  }
}

interface SlowMockSettingsServiceOptions extends FrameProcessorOptions {
  textDelay?: number;
}

/**
 * A settings-aware service that blocks on a TextFrame, like an LLM mid-inference.
 *
 * Frames queued behind the text wait for it, which is what makes the ordering
 * of a settings update passing through the switcher observable.
 */
class SlowMockSettingsService extends FrameProcessor {
  #textDelay: number;

  constructor(testName: string, options: SlowMockSettingsServiceOptions = {}) {
    const { textDelay, ...rest } = options;
    super({ ...rest, name: testName });
    this.#textDelay = textDelay ?? 0.0;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof TextFrame) {
      await sleep(this.#textDelay);
    }
    await this.pushFrame(frame, direction);
  }
}

/**
 * A mock service that records the settings updates it receives and applies.
 *
 * It applies an update the way a real service does — unless the update is
 * addressed to a different service — but forwards every frame either way, so
 * that tests can see what leaves the switcher.
 */
class MockSettingsService extends FrameProcessor {
  testName: string;
  receivedSettings: ServiceUpdateSettingsFrame[] = [];
  appliedSettings: ServiceUpdateSettingsFrame[] = [];

  constructor(testName: string, options: FrameProcessorOptions = {}) {
    super({ ...options, name: testName });
    this.testName = testName;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof ServiceUpdateSettingsFrame) {
      this.receivedSettings.push(frame);
      if (frame.service === null || frame.service === this) {
        this.appliedSettings.push(frame);
      }
    }
    await this.pushFrame(frame, direction);
  }

  /** The models carried by the settings updates this service applied. */
  get appliedModels(): unknown[] {
    return this.appliedSettings.filter((f) => f.delta).map((f) => f.delta?.model);
  }
}

/** A dummy system frame for testing purposes. */
class DummySystemFrame extends SystemFrame {
  text: string;

  constructor(options: { text?: string } = {}) {
    super();
    this.text = options.text ?? "";
  }
}

describe("TestServiceSwitcherStrategy", () => {
  let service1: MockFrameProcessor;
  let service2: MockFrameProcessor;
  let service3: MockFrameProcessor;
  let services: MockFrameProcessor[];

  beforeEach(() => {
    service1 = new MockFrameProcessor("service1");
    service2 = new MockFrameProcessor("service2");
    service3 = new MockFrameProcessor("service3");
    services = [service1, service2, service3];
  });

  test("test_init_with_services", () => {
    const strategy = new ServiceSwitcherStrategy(services);

    expect(strategy.services).toBe(services);
    expect(strategy.activeService).toBe(service1);
  });

  test("test_handle_frame_returns_none_for_manual_switch", async () => {
    const strategy = new ServiceSwitcherStrategy(services);

    const switchFrame = new ManuallySwitchServiceFrame({ service: service2 });
    const result = await strategy.handleFrame(switchFrame, FrameDirection.DOWNSTREAM);

    expect(result).toBeNull();
    expect(strategy.activeService).toBe(service1);
  });

  test("test_handle_frame_returns_none_for_unsupported_frame", async () => {
    const strategy = new ServiceSwitcherStrategy(services);
    const unsupportedFrame = new TextFrame({ text: "test" });

    const result = await strategy.handleFrame(unsupportedFrame as never, FrameDirection.DOWNSTREAM);

    expect(result).toBeNull();
  });

  test("test_handle_error_returns_none", async () => {
    const strategy = new ServiceSwitcherStrategy(services);

    const result = await strategy.handleError(new ErrorFrame({ error: "error" }));

    expect(result).toBeNull();
    expect(strategy.activeService).toBe(service1);
  });
});

describe("TestServiceSwitcherStrategyManual", () => {
  let service1: MockFrameProcessor;
  let service2: MockFrameProcessor;
  let service3: MockFrameProcessor;
  let services: MockFrameProcessor[];

  beforeEach(() => {
    service1 = new MockFrameProcessor("service1");
    service2 = new MockFrameProcessor("service2");
    service3 = new MockFrameProcessor("service3");
    services = [service1, service2, service3];
  });

  test("test_is_subclass_of_base_strategy", () => {
    const strategy = new ServiceSwitcherStrategyManual(services);
    expect(strategy).toBeInstanceOf(ServiceSwitcherStrategy);
  });

  test("test_handle_manually_switch_service_frame", async () => {
    const strategy = new ServiceSwitcherStrategyManual(services);

    // Initially service1 should be active
    expect(strategy.activeService).toBe(service1);

    // Switch to service2
    let switchFrame = new ManuallySwitchServiceFrame({ service: service2 });
    await strategy.handleFrame(switchFrame, FrameDirection.DOWNSTREAM);
    expect(strategy.activeService).toBe(service2);

    // Switch to service3
    switchFrame = new ManuallySwitchServiceFrame({ service: service3 });
    await strategy.handleFrame(switchFrame, FrameDirection.DOWNSTREAM);
    expect(strategy.activeService).toBe(service3);
  });

  test("test_on_service_switched_event", async () => {
    const strategy = new ServiceSwitcherStrategyManual(services);

    const switchedEvents: [unknown, FrameProcessor][] = [];

    strategy.eventHandler(
      "on_service_switched",
      async (strategy: unknown, service: FrameProcessor) => {
        switchedEvents.push([strategy, service]);
      },
    );

    const switchFrame = new ManuallySwitchServiceFrame({ service: service2 });
    await strategy.handleFrame(switchFrame, FrameDirection.DOWNSTREAM);
    await sleep(0);

    expect(switchedEvents.length).toBe(1);
    expect(switchedEvents[0]?.[0]).toBeInstanceOf(ServiceSwitcherStrategyManual);
    expect(switchedEvents[0]?.[1]).toBe(service2);
  });

  test("test_unknown_service_ignored", async () => {
    const strategy = new ServiceSwitcherStrategyManual(services);

    const switchedEvents: FrameProcessor[] = [];

    strategy.eventHandler(
      "on_service_switched",
      async (_strategy: unknown, service: FrameProcessor) => {
        switchedEvents.push(service);
      },
    );

    const unknownService = new MockFrameProcessor("unknown");
    const switchFrame = new ManuallySwitchServiceFrame({ service: unknownService });
    const result = await strategy.handleFrame(switchFrame, FrameDirection.DOWNSTREAM);
    await sleep(0);

    expect(result).toBeNull();
    expect(switchedEvents.length).toBe(0);
    expect(strategy.activeService).toBe(service1);
  });
});

describe("TestServiceSwitcher", () => {
  let service1: MockFrameProcessor;
  let service2: MockFrameProcessor;
  let service3: MockFrameProcessor;
  let services: MockFrameProcessor[];

  beforeEach(() => {
    service1 = new MockFrameProcessor("service1");
    service2 = new MockFrameProcessor("service2");
    service3 = new MockFrameProcessor("service3");
    services = [service1, service2, service3];
  });

  test("test_init_with_default_strategy", () => {
    const switcher = new ServiceSwitcher(services);

    expect(switcher.services).toBe(services);
    expect(switcher.strategy).toBeInstanceOf(ServiceSwitcherStrategyManual);
    expect(switcher.strategy.services).toBe(services);
  });

  test("test_default_active_service", async () => {
    const switcher = new ServiceSwitcher(services);

    // Reset counters
    for (const service of services) {
      service.resetCounters();
    }

    // Send some test frames
    const framesToSend = [
      new TextFrame({ text: "Hello 1" }),
      new DummySystemFrame({ text: "System Message 1" }),
      new TextFrame({ text: "Hello 2" }),
      new DummySystemFrame({ text: "System Message 2" }),
      new TextFrame({ text: "Hello 3" }),
    ];

    await runTest(switcher, {
      framesToSend,
      expectedDownFrames: [DummySystemFrame, DummySystemFrame, TextFrame, TextFrame, TextFrame],
      expectedUpFrames: [], // Expect no error frames
    });

    // Only service1 should have processed the text frames
    // Note: The service also receives StartFrame and EndFrame, so count those too
    const textFrames = service1.processedFrames.filter(
      (f): f is TextFrame => f instanceof TextFrame,
    );
    expect(textFrames.length).toBe(3);

    // Only service1 should have processed the system frames
    const systemFrames = service1.processedFrames.filter(
      (f): f is DummySystemFrame => f instanceof DummySystemFrame,
    );
    expect(systemFrames.length).toBe(2);

    // Check that other services don't receive text frames (they still get StartFrame/EndFrame)
    const service2TextFrames = service2.processedFrames.filter((f) => f instanceof TextFrame);
    const service3TextFrames = service3.processedFrames.filter((f) => f instanceof TextFrame);
    expect(service2TextFrames.length).toBe(0);
    expect(service3TextFrames.length).toBe(0);

    // Check that other services don't receive dummy system frames (they still get StartFrame/EndFrame)
    const service2SystemFrames = service2.processedFrames.filter(
      (f) => f instanceof DummySystemFrame,
    );
    const service3SystemFrames = service3.processedFrames.filter(
      (f) => f instanceof DummySystemFrame,
    );
    expect(service2SystemFrames.length).toBe(0);
    expect(service3SystemFrames.length).toBe(0);

    // Verify the actual text frames processed
    textFrames.forEach((frame, i) => {
      expect(frame.text).toBe(`Hello ${i + 1}`);
    });

    // Verify the actual system frames processed
    systemFrames.forEach((frame, i) => {
      expect(frame.text).toBe(`System Message ${i + 1}`);
    });
  });

  test("test_service_switching", async () => {
    const switcher = new ServiceSwitcher(services);

    // Reset counters
    for (const service of services) {
      service.resetCounters();
    }

    // Send a test frame, a switch frame, and another test frame
    await runTest(switcher, {
      framesToSend: [
        new TextFrame({ text: "Hello 1" }),
        new ManuallySwitchServiceFrame({ service: service2 }),
        new TextFrame({ text: "Hello 2" }),
      ],
      expectedDownFrames: [TextFrame, TextFrame],
      expectedUpFrames: [], // Expect no error frames
    });

    // Verify service2 received the frame
    const texts = (s: MockFrameProcessor) =>
      s.processedFrames.filter((f): f is TextFrame => f instanceof TextFrame);
    const service1TextFrames = texts(service1);
    const service2TextFrames = texts(service2);
    const service3TextFrames = texts(service3);

    expect(service1TextFrames.length).toBe(1);
    expect(service2TextFrames.length).toBe(1);
    expect(service3TextFrames.length).toBe(0);

    expect(service1TextFrames[0]?.text).toBe("Hello 1");
    expect(service2TextFrames[0]?.text).toBe("Hello 2");
  });

  test("test_multi_service_switcher_targeting", async () => {
    // Create services for first switcher
    const switcher1Service1 = new MockFrameProcessor("switcher1_service1");
    const switcher1Service2 = new MockFrameProcessor("switcher1_service2");
    const switcher1Services = [switcher1Service1, switcher1Service2];

    // Create services for second switcher
    const switcher2Service1 = new MockFrameProcessor("switcher2_service1");
    const switcher2Service2 = new MockFrameProcessor("switcher2_service2");
    const switcher2Services = [switcher2Service1, switcher2Service2];

    // Create two service switchers
    const switcher1 = new ServiceSwitcher(switcher1Services);
    const switcher2 = new ServiceSwitcher(switcher2Services);

    // Create a pipeline with both switchers: switcher1 -> switcher2
    const pipeline = new Pipeline([switcher1, switcher2]);

    // Reset counters
    for (const service of [...switcher1Services, ...switcher2Services]) {
      service.resetCounters();
    }

    // Initially, both switchers should use their first services
    expect(switcher1.strategy.activeService).toBe(switcher1Service1);
    expect(switcher2.strategy.activeService).toBe(switcher2Service1);

    // Send frames to test the pipeline:
    // 1. Text frame (should go through both switchers' active services)
    // 2. Switch frame targeting switcher1's second service
    // 3. Text frame (should go through switcher1's new service and switcher2's original service)
    // 4. Switch frame targeting switcher2's second service
    // 5. Text frame (should go through switcher1's current service and switcher2's new service)
    await runTest(pipeline, {
      framesToSend: [
        new TextFrame({ text: "Before any switches" }),
        new ManuallySwitchServiceFrame({ service: switcher1Service2 }), // Switch first switcher
        new TextFrame({ text: "After switching first switcher" }),
        new ManuallySwitchServiceFrame({ service: switcher2Service2 }), // Switch second switcher
        new TextFrame({ text: "After switching second switcher" }),
      ],
      expectedDownFrames: [TextFrame, TextFrame, TextFrame],
      expectedUpFrames: [], // Expect no error frames
    });

    // Verify the active services changed correctly
    expect(switcher1.strategy.activeService).toBe(switcher1Service2);
    expect(switcher2.strategy.activeService).toBe(switcher2Service2);

    const texts = (s: MockFrameProcessor) =>
      s.processedFrames.filter((f): f is TextFrame => f instanceof TextFrame);

    // Verify frame distribution:
    // First text frame should go through switcher1_service1 and switcher2_service1
    const switcher1Service1Texts = texts(switcher1Service1);
    const switcher2Service1Texts = texts(switcher2Service1);

    // Second text frame should go through switcher1_service2 and switcher2_service1
    const switcher1Service2Texts = texts(switcher1Service2);

    // Third text frame should go through switcher1_service2 and switcher2_service2
    const switcher2Service2Texts = texts(switcher2Service2);

    // Verify frame counts and content
    expect(switcher1Service1Texts.length).toBe(1);
    expect(switcher1Service1Texts[0]?.text).toBe("Before any switches");

    expect(switcher1Service2Texts.length).toBe(2);
    expect(switcher1Service2Texts[0]?.text).toBe("After switching first switcher");
    expect(switcher1Service2Texts[1]?.text).toBe("After switching second switcher");

    expect(switcher2Service1Texts.length).toBe(2);
    expect(switcher2Service1Texts[0]?.text).toBe("Before any switches");
    expect(switcher2Service1Texts[1]?.text).toBe("After switching first switcher");

    expect(switcher2Service2Texts.length).toBe(1);
    expect(switcher2Service2Texts[0]?.text).toBe("After switching second switcher");
  });
});

describe("TestServiceSwitcherMetadata", () => {
  let service1: MockMetadataService;
  let service2: MockMetadataService;
  let services: MockMetadataService[];

  beforeEach(() => {
    service1 = new MockMetadataService("service1");
    service2 = new MockMetadataService("service2");
    services = [service1, service2];
  });

  test("test_only_active_service_metadata_at_startup", async () => {
    const switcher = new ServiceSwitcher(services);

    // Run the pipeline (StartFrame triggers metadata emission)
    await runTest(switcher, {
      framesToSend: [new TextFrame({ text: "test" })],
      expectedDownFrames: [MockMetadataFrame, TextFrame],
      expectedUpFrames: [],
    });

    // Both services push metadata internally on StartFrame, but only the
    // active service's metadata passes through the filter
    expect(service1.metadataPushCount).toBe(1); // StartFrame (passes filter)
    expect(service2.metadataPushCount).toBe(1); // StartFrame (blocked by filter)
  });

  test("test_metadata_emitted_on_service_switch", async () => {
    const switcher = new ServiceSwitcher(services);

    // Reset counters after startup
    service1.resetCounters();
    service2.resetCounters();

    await runTest(switcher, {
      framesToSend: [
        new TextFrame({ text: "before switch" }),
        new ManuallySwitchServiceFrame({ service: service2 }),
        new TextFrame({ text: "after switch" }),
      ],
      expectedDownFrames: [
        MockMetadataFrame, // From startup (service1)
        TextFrame,
        MockMetadataFrame, // From service2 after switch
        TextFrame,
      ],
      expectedUpFrames: [],
    });

    // service2 should have received ServiceSwitcherRequestMetadataFrame after becoming active
    const requestFrames = service2.processedFrames.filter(
      (f) => f instanceof ServiceSwitcherRequestMetadataFrame,
    );
    expect(requestFrames.length).toBe(1);
  });

  test("test_inactive_service_metadata_blocked", async () => {
    const switcher = new ServiceSwitcher(services);

    // Run and collect output frames
    await runTest(switcher, {
      framesToSend: [new TextFrame({ text: "test" })],
      expectedDownFrames: [MockMetadataFrame, TextFrame],
      expectedUpFrames: [],
    });

    // service2 pushed metadata on StartFrame, but it should have been blocked
    expect(service2.metadataPushCount).toBeGreaterThanOrEqual(1);
    // Only one MockMetadataFrame should have left (from service1)
  });

  /**
   * Metadata from a service outside the switcher reaches the inactive services too.
   *
   * A member that reads another service's metadata then has it when it
   * becomes active. It arrives once at each member, and travels on once,
   * from the active member, as it would through that service alone.
   */
  test("test_metadata_from_outside_reaches_every_service", async () => {
    for (const direction of [FrameDirection.DOWNSTREAM, FrameDirection.UPSTREAM]) {
      const services = [new MockFrameProcessor("service1"), new MockFrameProcessor("service2")];
      const switcher = new ServiceSwitcher(services);
      const passedOn = [MockMetadataFrame];

      await runTest(switcher, {
        framesToSend: [new MockMetadataFrame({ serviceName: "tts" })],
        framesToSendDirection: direction,
        expectedDownFrames: direction === FrameDirection.DOWNSTREAM ? passedOn : [],
        expectedUpFrames: direction === FrameDirection.UPSTREAM ? passedOn : [],
      });

      for (const service of services) {
        const metadata = service.processedFrames.filter(
          (f): f is MockMetadataFrame => f instanceof MockMetadataFrame,
        );
        expect(metadata.map((f) => f.serviceName)).toEqual(["tts"]);
      }
    }
  });
});

describe("TestServiceSwitcherSettingsUpdates", () => {
  let service1: MockSettingsService;
  let service2: MockSettingsService;
  let service3: MockSettingsService;
  let services: MockSettingsService[];

  beforeEach(() => {
    service1 = new MockSettingsService("service1");
    service2 = new MockSettingsService("service2");
    service3 = new MockSettingsService("service3");
    services = [service1, service2, service3];
  });

  test("test_settings_update_applies_to_the_active_service_alone_by_default", async () => {
    // Settings values are often specific to one provider: a voice id for one
    // TTS service means nothing to the next.
    const switcher = new ServiceSwitcher(services);

    await runTest(switcher, {
      framesToSend: [
        new LLMUpdateSettingsFrame({ delta: new LLMSettings({ model: "new-model" }) }),
      ],
      expectedDownFrames: [LLMUpdateSettingsFrame],
      expectedUpFrames: [],
    });

    expect(service1.appliedModels).toEqual(["new-model"]);
    expect(service2.receivedSettings).toEqual([]);
    expect(service3.receivedSettings).toEqual([]);
  });

  test("test_settings_update_reaches_every_service", async () => {
    // Their branch filters otherwise gate the update, leaving them to take
    // over a session without a setting the rest of the pipeline assumes is in
    // place.
    const switcher = new ServiceSwitcher(services);

    await runTest(switcher, {
      framesToSend: [
        new LLMUpdateSettingsFrame({
          delta: new LLMSettings({ model: "new-model" }),
          reachInactiveServices: true,
        }),
      ],
      // A single copy leaves the switcher, not one per service.
      expectedDownFrames: [LLMUpdateSettingsFrame],
      expectedUpFrames: [],
    });

    for (const service of services) {
      expect(service.appliedModels).toEqual(["new-model"]);
      // An untargeted update stays untargeted for every service it reaches:
      // the inactive ones aren't handed an update addressed to them.
      expect(service.receivedSettings.map((f) => f.service)).toEqual([null]);
    }
  });

  test("test_settings_update_travelling_upstream_reaches_every_service", async () => {
    const switcher = new ServiceSwitcher(services);

    await runTest(switcher, {
      framesToSend: [
        new LLMUpdateSettingsFrame({
          delta: new LLMSettings({ model: "new-model" }),
          reachInactiveServices: true,
        }),
      ],
      framesToSendDirection: FrameDirection.UPSTREAM,
      expectedDownFrames: [],
      expectedUpFrames: [LLMUpdateSettingsFrame],
    });

    for (const service of services) {
      expect(service.appliedModels).toEqual(["new-model"]);
    }
  });

  test("test_settings_update_addressed_to_inactive_service", async () => {
    // The `service` field is the way to configure one specific service, so it
    // has to work for a service that isn't the active one.
    const switcher = new ServiceSwitcher(services);

    await runTest(switcher, {
      framesToSend: [
        new LLMUpdateSettingsFrame({
          service: service3,
          delta: new LLMSettings({ model: "new-model" }),
        }),
      ],
      expectedDownFrames: [LLMUpdateSettingsFrame],
      expectedUpFrames: [],
    });

    expect(service3.appliedModels).toEqual(["new-model"]);
    expect(service1.appliedModels).toEqual([]);
    expect(service2.appliedModels).toEqual([]);
  });

  test("test_settings_update_addressed_to_active_service", async () => {
    const switcher = new ServiceSwitcher(services);

    await runTest(switcher, {
      framesToSend: [
        new LLMUpdateSettingsFrame({
          service: service1,
          delta: new LLMSettings({ model: "new-model" }),
        }),
      ],
      expectedDownFrames: [LLMUpdateSettingsFrame],
      expectedUpFrames: [],
    });

    expect(service1.appliedModels).toEqual(["new-model"]);
    expect(service2.appliedModels).toEqual([]);
    expect(service3.appliedModels).toEqual([]);
  });

  test("test_settings_update_for_another_switcher_passes_through_unchanged", async () => {
    const switcher1Service1 = new MockSettingsService("switcher1_service1");
    const switcher1Service2 = new MockSettingsService("switcher1_service2");
    const switcher2Service1 = new MockSettingsService("switcher2_service1");
    const switcher2Service2 = new MockSettingsService("switcher2_service2");

    const switcher1 = new ServiceSwitcher([switcher1Service1, switcher1Service2]);
    const switcher2 = new ServiceSwitcher([switcher2Service1, switcher2Service2]);
    const pipeline = new Pipeline([switcher1, switcher2]);

    await runTest(pipeline, {
      framesToSend: [
        new LLMUpdateSettingsFrame({
          service: switcher2Service2,
          delta: new LLMSettings({ model: "new-model" }),
        }),
      ],
      expectedDownFrames: [LLMUpdateSettingsFrame],
      expectedUpFrames: [],
    });

    expect(switcher2Service2.appliedModels).toEqual(["new-model"]);
    expect(switcher2Service1.appliedModels).toEqual([]);
    // The first switcher passes the update along still addressed to its
    // recipient, and leaves its own inactive services out of it.
    expect(switcher1Service1.appliedModels).toEqual([]);
    const received = switcher1Service1.receivedSettings.map((f) => f.service);
    expect(received.length).toBe(1);
    expect(received[0]).toBe(switcher2Service2);
    expect(switcher1Service2.receivedSettings).toEqual([]);
  });

  test("test_settings_update_keeps_its_place_in_the_stream", async () => {
    // An idle service is free to handle its copy of the update at once, while
    // the active service still has earlier frames in flight.
    const active = new SlowMockSettingsService("active", { textDelay: 0.2 });
    const inactive = new SlowMockSettingsService("inactive");
    const switcher = new ServiceSwitcher([active, inactive]);

    await runTest(switcher, {
      framesToSend: [
        new TextFrame({ text: "turn text" }),
        new LLMUpdateSettingsFrame({
          delta: new LLMSettings({ model: "new-model" }),
          reachInactiveServices: true,
        }),
      ],
      expectedDownFrames: [TextFrame, LLMUpdateSettingsFrame],
      expectedUpFrames: [],
    });
  });

  test("test_inactive_service_is_configured_before_failover", async () => {
    const switcher = new ServiceSwitcher(services, {
      strategyType: ServiceSwitcherStrategyFailover,
    });

    await runTest(switcher, {
      framesToSend: [
        new LLMUpdateSettingsFrame({
          delta: new LLMSettings({ model: "new-model" }),
          reachInactiveServices: true,
        }),
        new ManuallySwitchServiceFrame({ service: service2 }),
      ],
      expectedDownFrames: [LLMUpdateSettingsFrame],
      expectedUpFrames: [],
    });

    expect(switcher.strategy.activeService).toBe(service2);
    expect(service2.appliedModels).toEqual(["new-model"]);
  });
});

describe("TestServiceSwitcherStrategyFailover", () => {
  let service1: MockFrameProcessor;
  let service2: MockFrameProcessor;
  let service3: MockFrameProcessor;
  let services: MockFrameProcessor[];

  beforeEach(() => {
    service1 = new MockFrameProcessor("service1");
    service2 = new MockFrameProcessor("service2");
    service3 = new MockFrameProcessor("service3");
    services = [service1, service2, service3];
  });

  test("test_init_defaults", () => {
    const strategy = new ServiceSwitcherStrategyFailover(services);
    expect(strategy.activeService).toBe(service1);
  });

  test("test_error_switches_to_next_service", async () => {
    const strategy = new ServiceSwitcherStrategyFailover(services);

    await service1.setUsable(false);
    const error = new ErrorFrame({ error: "connection lost" });
    const result = await strategy.handleError(error);

    expect(result).toBe(service2);
    expect(strategy.activeService).toBe(service2);
  });

  test("test_recoverable_error_does_not_switch", async () => {
    const strategy = new ServiceSwitcherStrategyFailover(services);

    const result = await strategy.handleError(new ErrorFrame({ error: "transient failure" }));

    expect(result).toBeNull();
    expect(strategy.activeService).toBe(service1);
  });

  test("test_consecutive_errors_cycle_through_services", async () => {
    const strategy = new ServiceSwitcherStrategyFailover(services);

    // First error: service1 -> service2
    await service1.setUsable(false);
    await strategy.handleError(new ErrorFrame({ error: "error 1" }));
    expect(strategy.activeService).toBe(service2);

    // Second error: service2 -> service3
    await service2.setUsable(false);
    await strategy.handleError(new ErrorFrame({ error: "error 2" }));
    expect(strategy.activeService).toBe(service3);

    // Third error: service3 -> service1 (wraps around), service1 having
    // been brought back in the meantime.
    await service1.setUsable(true);
    await service3.setUsable(false);
    await strategy.handleError(new ErrorFrame({ error: "error 3" }));
    expect(strategy.activeService).toBe(service1);
  });

  test("test_single_service_returns_none", async () => {
    const strategy = new ServiceSwitcherStrategyFailover([service1]);

    await service1.setUsable(false);
    const result = await strategy.handleError(new ErrorFrame({ error: "error" }));
    expect(result).toBeNull();
  });

  test("test_manual_switch_still_works", async () => {
    const strategy = new ServiceSwitcherStrategyFailover(services);

    const frame = new ManuallySwitchServiceFrame({ service: service3 });
    const result = await strategy.handleFrame(frame, FrameDirection.DOWNSTREAM);

    expect(result).toBe(service3);
    expect(strategy.activeService).toBe(service3);
  });

  test("test_passthrough_error_does_not_trigger_failover", async () => {
    // This reproduces the bug where an ErrorFrame from e.g. TTS propagates
    // upstream through an LLM ServiceSwitcher and incorrectly triggers
    // failover even though neither LLM service produced the error.
    const switcher = new ServiceSwitcher([service1, service2], {
      strategyType: ServiceSwitcherStrategyFailover,
    });
    const errorInjector = new ErrorInjectorProcessor();
    const pipeline = new Pipeline([switcher, errorInjector]);

    await runTest(pipeline, {
      framesToSend: [new TextFrame({ text: "test" })],
      expectedDownFrames: [TextFrame],
      expectedUpFrames: [ErrorFrame],
    });

    // Active service should NOT have changed — the error came from outside
    expect(switcher.strategy.activeService).toBe(service1);
  });

  test("test_managed_service_error_triggers_failover", async () => {
    const errorService = new ErrorOnTextService("error_service");
    const backupService = new MockFrameProcessor("backup_service");
    const switcher = new ServiceSwitcher([errorService, backupService], {
      strategyType: ServiceSwitcherStrategyFailover,
    });

    await runTest(switcher, {
      framesToSend: [new TextFrame({ text: "test" })],
      expectedDownFrames: [TextFrame],
      expectedUpFrames: [],
    });

    // Active service SHOULD have changed — the error came from a managed service
    expect(switcher.strategy.activeService).toBe(backupService);
  });

  test("test_failover_absorbs_the_error", async () => {
    // The switcher went on doing its job by moving work to another service,
    // so there is nothing left for the rest of the pipeline to act on.
    const errorService = new ErrorOnTextService("error_service");
    const backupService = new MockFrameProcessor("backup_service");
    const switcher = new ServiceSwitcher([errorService, backupService], {
      strategyType: ServiceSwitcherStrategyFailover,
    });

    await runTest(switcher, {
      framesToSend: [new TextFrame({ text: "test" })],
      expectedDownFrames: [TextFrame],
      expectedUpFrames: [],
    });

    expect(switcher.isUsable).toBe(true);
  });

  test("test_a_failed_service_that_keeps_erroring_is_answered_for_once", async () => {
    // The rest of the pipeline deals with the switcher, and judges it by the
    // processor an error names. A service the switcher has already recovered
    // from would have the pipeline write the switcher off for a failure it
    // survived.
    const errorService = new RepeatedlyErroringService("error_service");
    const backupService = new MockFrameProcessor("backup_service");
    const switcher = new ServiceSwitcher([errorService, backupService], {
      strategyType: ServiceSwitcherStrategyFailover,
    });

    await runTest(switcher, {
      framesToSend: [new TextFrame({ text: "test" }), new SleepFrame({ sleep: 0.2 })],
      expectedDownFrames: [TextFrame],
      expectedUpFrames: [],
    });

    expect(errorService.errors).toBe(3);
    expect(switcher.strategy.activeService).toBe(backupService);
    expect(switcher.isUsable).toBe(true);
  });

  test("test_an_error_from_a_service_in_reserve_goes_no_further", async () => {
    // It isn't being given work, so nothing about it bears on whether the
    // switcher can do its job.
    const activeService = new MockFrameProcessor("active_service");
    const reserveService = new ErrorOnTextService("reserve_service", { becomesUnusable: false });
    const switcher = new ServiceSwitcher([activeService, reserveService], {
      strategyType: ServiceSwitcherStrategyFailover,
    });

    await runTest(switcher, {
      framesToSend: [new TextFrame({ text: "test" })],
      expectedDownFrames: [TextFrame],
      expectedUpFrames: [],
    });

    await reserveService.pushError("service connection lost");

    expect(switcher.strategy.activeService).toBe(activeService);
  });

  test("test_a_switcher_with_nothing_left_answers_for_every_error", async () => {
    // With nowhere to move the work, the failed service stays active and goes
    // on erroring, and each of those errors is the switcher's to report.
    const errorService = new RepeatedlyErroringService("error_service");
    const switcher = new ServiceSwitcher([errorService], {
      strategyType: ServiceSwitcherStrategyFailover,
    });

    const [, upFrames] = await runTest(switcher, {
      framesToSend: [new TextFrame({ text: "test" }), new SleepFrame({ sleep: 0.2 })],
      expectedDownFrames: [TextFrame],
      expectedUpFrames: [ErrorFrame, ErrorFrame, ErrorFrame],
    });

    expect(errorService.errors).toBe(3);
    expect(switcher.isUsable).toBe(false);
    expect(upFrames.every((frame) => (frame as ErrorFrame).processor === switcher)).toBe(true);
  });

  test("test_recoverable_error_does_not_trigger_failover", async () => {
    const errorService = new ErrorOnTextService("error_service", { becomesUnusable: false });
    const backupService = new MockFrameProcessor("backup_service");
    const switcher = new ServiceSwitcher([errorService, backupService], {
      strategyType: ServiceSwitcherStrategyFailover,
    });

    await runTest(switcher, {
      framesToSend: [new TextFrame({ text: "test" })],
      expectedDownFrames: [TextFrame],
      expectedUpFrames: [ErrorFrame],
    });

    expect(switcher.strategy.activeService).toBe(errorService);
  });

  test("test_strategy_sees_every_error_from_the_active_service", async () => {
    // Which errors are worth switching away from is the strategy's decision,
    // so it hears about them all, not only the ones that end a service.
    const seen: ErrorFrame[] = [];

    class RecordingStrategy extends ServiceSwitcherStrategyManual {
      override async handleError(error: ErrorFrame): Promise<FrameProcessor | null> {
        seen.push(error);
        return null;
      }
    }

    const errorService = new ErrorOnTextService("error_service", { becomesUnusable: false });
    const backupService = new MockFrameProcessor("backup_service");
    const switcher = new ServiceSwitcher([errorService, backupService], {
      strategyType: RecordingStrategy,
    });

    await runTest(switcher, {
      framesToSend: [new TextFrame({ text: "test" })],
      expectedDownFrames: [TextFrame],
      expectedUpFrames: [ErrorFrame],
    });

    expect(seen.length).toBe(1);
    expect(seen[0]?.processor).toBe(errorService);
    expect(errorService.isUsable).toBe(true);
  });

  test("test_error_with_no_service_left_is_reported", async () => {
    const errorService = new ErrorOnTextService("error_service");
    const switcher = new ServiceSwitcher([errorService], {
      strategyType: ServiceSwitcherStrategyFailover,
    });

    const [, up] = await runTest(switcher, {
      framesToSend: [new TextFrame({ text: "test" })],
      expectedDownFrames: [TextFrame],
      expectedUpFrames: [ErrorFrame],
    });

    const error = up[0] as ErrorFrame;
    expect(error.processor).toBe(switcher);
    expect(error.error).toContain("service connection lost");
    expect(switcher.isUsable).toBe(false);
  });

  test("test_a_lost_service_does_not_write_off_the_switcher", async () => {
    // The pipeline deals with the switcher, not with the services inside it,
    // so an error that costs one service must not read as the switcher being
    // spent while it still has somewhere to send work. A manual strategy never
    // switches on its own, which is what leaves the pair in this state.
    const errorService = new ErrorOnTextService("error_service");
    const backupService = new MockFrameProcessor("backup_service");
    const switcher = new ServiceSwitcher([errorService, backupService], {
      strategyType: ServiceSwitcherStrategyManual,
    });

    const [, up] = await runTest(switcher, {
      framesToSend: [new TextFrame({ text: "test" })],
      expectedDownFrames: [TextFrame],
      expectedUpFrames: [ErrorFrame],
    });

    const error = up[0] as ErrorFrame;
    expect(error.processor).toBe(switcher);
    expect(error.processor?.isUsable).toBe(true);
    // The failing service is named, so the report still leads somewhere.
    expect(error.error).toContain("error_service");
  });

  test("test_a_rejected_service_does_not_misconfigure_the_switcher", async () => {
    // Inheriting the category would write the switcher off for good, taking
    // its remaining services with it.
    const errorService = new ErrorOnTextService("error_service", {
      category: ErrorCategory.AUTHENTICATION,
    });
    const backupService = new MockFrameProcessor("backup_service");
    const switcher = new ServiceSwitcher([errorService, backupService], {
      strategyType: ServiceSwitcherStrategyManual,
    });

    const [, up] = await runTest(switcher, {
      framesToSend: [new TextFrame({ text: "test" })],
      expectedDownFrames: [TextFrame],
      expectedUpFrames: [ErrorFrame],
    });

    expect((up[0] as ErrorFrame).category).toBe(ErrorCategory.UNKNOWN);
    expect(switcher.isUsable).toBe(true);
  });

  test("test_failover_skips_services_that_cannot_work", async () => {
    const errorService = new ErrorOnTextService("error_service");
    const spentService = new MockFrameProcessor("spent_service");
    const backupService = new MockFrameProcessor("backup_service");
    await spentService.setUsable(false);

    const switcher = new ServiceSwitcher([errorService, spentService, backupService], {
      strategyType: ServiceSwitcherStrategyFailover,
    });

    await runTest(switcher, {
      framesToSend: [new TextFrame({ text: "test" })],
      expectedDownFrames: [TextFrame],
      expectedUpFrames: [],
    });

    expect(switcher.strategy.activeService).toBe(backupService);
  });

  test("test_switcher_is_usable_while_any_service_is", async () => {
    const first = new MockFrameProcessor("first");
    const second = new MockFrameProcessor("second");
    const switcher = new ServiceSwitcher([first, second]);

    await first.setUsable(false);
    expect(switcher.isUsable).toBe(true);

    await second.setUsable(false);
    expect(switcher.isUsable).toBe(false);

    // Bringing one back brings the switcher back with it.
    await second.setUsable(true);
    expect(switcher.isUsable).toBe(true);
  });

  test("test_switcher_announces_its_own_usability", async () => {
    const first = new MockFrameProcessor("first");
    const second = new MockFrameProcessor("second");
    const switcher = new ServiceSwitcher([first, second]);

    const announced: boolean[] = [];
    const heard = new Event();

    switcher.eventHandler("on_usable_changed", async (_switcher: unknown, isUsable: boolean) => {
      announced.push(isUsable);
      heard.set();
    });

    const waitForAnnouncement = async (): Promise<void> => {
      await waitFor(() => heard.wait(), 5);
      heard.clear();
    };

    // Losing one service of two changes nothing the switcher can't absorb.
    await first.setUsable(false);
    // Losing the last one does.
    await second.setUsable(false);
    await waitForAnnouncement();
    expect(announced).toEqual([false]);

    // And getting one back brings the switcher back with it.
    await first.setUsable(true);
    await waitForAnnouncement();
    expect(announced).toEqual([false, true]);
  });

  test("test_setting_the_switcher_usable_is_ignored", async () => {
    // The switcher reports a reading of its services, so setting it directly
    // would claim something the services don't say.
    const first = new MockFrameProcessor("first");
    const switcher = new ServiceSwitcher([first]);

    const announced: boolean[] = [];

    switcher.eventHandler("on_usable_changed", async (_switcher: unknown, isUsable: boolean) => {
      announced.push(isUsable);
    });

    // loguru's `logger.add(..., level="DEBUG")` captures DEBUG whatever the
    // other sinks are set to, so lower the threshold while the sink is added.
    const previousLevel = (Object.keys(LOG_LEVELS) as LogLevel[]).find((level) =>
      logger.isEnabledFor(level),
    );
    const messages: string[] = [];
    logger.setLevel("DEBUG");
    const removeSink = logger.addSink((record) => {
      if (logger.isEnabledFor(record.level)) messages.push(record.message);
    });
    try {
      await switcher.setUsable(false);
      await sleep(0.1);
    } finally {
      removeSink();
      logger.setLevel(previousLevel ?? "CRITICAL");
    }

    expect(switcher.isUsable).toBe(true);
    expect(announced).toEqual([]);
    // Silently doing nothing would leave the caller to work that out.
    expect(messages.some((message) => message.includes("ignoring set_usable"))).toBe(true);

    // And a service that can't be given work isn't overridden either.
    await first.setUsable(false);
    await switcher.setUsable(true);
    expect(switcher.isUsable).toBe(false);
  });

  test("test_manual_switch_refuses_a_service_that_cannot_work", async () => {
    const first = new MockFrameProcessor("first");
    const second = new MockFrameProcessor("second");
    const strategy = new ServiceSwitcherStrategyManual([first, second]);
    await second.setUsable(false);

    const switched = await strategy.handleFrame(
      new ManuallySwitchServiceFrame({ service: second }),
      FrameDirection.DOWNSTREAM,
    );

    expect(switched).toBeNull();
    expect(strategy.activeService).toBe(first);
  });

  test("test_on_service_switched_event_fires_on_error", async () => {
    const strategy = new ServiceSwitcherStrategyFailover(services);

    const switchedEvents: FrameProcessor[] = [];

    strategy.eventHandler(
      "on_service_switched",
      async (_strategy: unknown, service: FrameProcessor) => {
        switchedEvents.push(service);
      },
    );

    await service1.setUsable(false);
    await strategy.handleError(new ErrorFrame({ error: "error" }));
    await sleep(0);

    expect(switchedEvents.length).toBe(1);
    expect(switchedEvents[0]).toBe(service2);
  });
});

describe("TestServiceSwitcherSetupFailure", () => {
  /** A service whose connection attempt fails while it is set up. */
  class FailsToConnectService extends MockFrameProcessor {
    override async setup(setup: FrameProcessorSetup): Promise<void> {
      await super.setup(setup);
      await sleep(0.01);
      throw new Error(`${this.name} could not connect`);
    }
  }

  test("test_failover_moves_off_a_service_that_cannot_be_set_up", async () => {
    // Services connect while the pipeline is setting up, so a service can fail
    // before a single frame has been pushed. Setting up is not attempted
    // again, so the service is finished rather than having a bad moment, and
    // the switcher settles on the backup before the pipeline starts.
    const failingService = new FailsToConnectService("failing_service");
    const backupService = new MockFrameProcessor("backup_service");
    const switcher = new ServiceSwitcher([failingService, backupService], {
      strategyType: ServiceSwitcherStrategyFailover,
    });

    await runTest(switcher, {
      framesToSend: [new TextFrame({ text: "test" })],
      expectedDownFrames: [TextFrame],
      // The switcher recovered on its own, so the error goes no further.
      expectedUpFrames: [],
    });

    expect(failingService.isUsable).toBe(false);
    expect(switcher.strategy.activeService).toBe(backupService);
    expect(switcher.isUsable).toBe(true);

    // The work reached the backup, never the service that failed.
    expect(backupService.processedFrames.map((f) => f.constructor)).toContain(TextFrame);
    expect(failingService.processedFrames.map((f) => f.constructor)).not.toContain(TextFrame);
  });
});
