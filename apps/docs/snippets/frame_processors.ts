// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/concepts/frame-processors.mdx. Type-checked on every docs build.

import { Event } from "@pipecat-ts/asyncio";
import {
  type ErrorFrame,
  type Frame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  MetricsFrame,
  TextFrame,
  TranscriptionFrame,
  UserStartedSpeakingFrame,
} from "@pipecat-ts/core/frames/frames";
import type { MetricsData } from "@pipecat-ts/core/metrics/metrics";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "@pipecat-ts/core/processors/frame_processor";
import { logger } from "@pipecat-ts/core/utils/logger";

// #region metrics-logger
function formatMetrics(metrics: MetricsData[]): string {
  return metrics
    .map((metric) => {
      const fields = Object.entries(metric)
        .map(([key, value]) => `\t${key}=${JSON.stringify(value)}`)
        .join("\n");
      return `${metric.constructor.name}\n${fields}`;
    })
    .join("\n");
}

/** Formats and logs every MetricsFrame. */
export class MetricsFrameLogger extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof MetricsFrame) {
      logger.info(`${frame.name}\n${formatMetrics(frame.data)}`);
    }

    // SUPER IMPORTANT: always push every frame!
    await this.pushFrame(frame, direction);
  }
}
// #endregion metrics-logger

// #region skeleton
export interface MyCustomProcessorOptions extends FrameProcessorOptions {
  greeting?: string;
}

export class MyCustomProcessor extends FrameProcessor {
  protected _greeting: string;

  constructor(options: MyCustomProcessorOptions = {}) {
    super(options); // ✅ Required: forwards name, enableDirectMode, metrics...
    this._greeting = options.greeting ?? "hello";
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction); // ✅ Required

    if (frame instanceof TranscriptionFrame) {
      console.log(`${this._greeting}, user ${frame.userId} said: ${frame.text}`);
    }

    await this.pushFrame(frame, direction); // ✅ Required: pass the frame through
  }
}
// #endregion skeleton

interface Client {
  close(): Promise<void>;
}
async function connect(): Promise<Client> {
  return { close: async () => {} };
}

// #region setup-cleanup
export class ConnectedProcessor extends FrameProcessor {
  protected _sampleRate = 0;
  protected _client: Client | null = null;

  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup); // ✅ Required
    this._sampleRate = setup.audioOutSampleRate;
    this._client = await connect();
  }

  override async cleanup(): Promise<void> {
    await super.cleanup(); // ✅ Required
    await this._client?.close();
  }
}
// #endregion setup-cleanup

// #region pause-until
export class SlowToConnect extends FrameProcessor {
  protected _ready = new Event();

  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    // Hold every frame until connected, for at most 10 seconds.
    await this.pauseProcessingAllFramesUntil(() => this._ready.wait(), { timeout: 10 });
    this.createTask(async () => {
      await connect();
      this._ready.set();
    }, "connect");
  }
}
// #endregion pause-until

// #region response-logger
export class ResponseLogger extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof LLMFullResponseStartFrame) {
      logger.info("LLM response started");
    } else if (frame instanceof LLMFullResponseEndFrame) {
      logger.info("LLM response finished");
    }

    await this.pushFrame(frame, direction);
  }
}
// #endregion response-logger

export class DirectionExamples extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    // #region directions
    // Push downstream (the default)
    await this.pushFrame(frame, FrameDirection.DOWNSTREAM);

    // Push upstream, back towards the start of the pipeline
    await this.pushFrame(new TextFrame({ text: "hi" }), FrameDirection.UPSTREAM);

    // Create two instances, push one each way, linked by `broadcastSiblingId`
    await this.broadcastFrame(UserStartedSpeakingFrame);

    // Copy a frame you didn't create and push it both ways
    await this.broadcastFrameInstance(frame);
    // #endregion directions

    // #region push-error
    try {
      await riskyOperation();
    } catch (e) {
      // A recoverable error: report it and keep going.
      await this.pushError("Failed to process audio chunk, skipping", { exception: e });
    }

    // An error that leaves this processor unable to do any more work.
    await this.pushError("Critical operation failed", { forceTreatAsPermanent: true });
    // #endregion push-error
  }
}

async function riskyOperation(): Promise<void> {}

// #region event-handlers
const tts = new MyCustomProcessor({ name: "tts" });

// Like Python's `@tts.event_handler("on_error")` decorator.
tts.eventHandler("on_error", async (processor: FrameProcessor, error: ErrorFrame) => {
  console.log(`Error in ${processor}: ${error.error}`);
  if (error.exception) {
    console.log("Exception:", error.exception);
  }
  if (error.processor && !error.processor.isUsable) {
    console.log("This processor can no longer do its job");
  }
});

tts.eventHandler("on_usable_changed", async (processor: FrameProcessor, isUsable: boolean) => {
  if (!isUsable) console.warn(`${processor} is down`);
});

// The same handler on several processors.
async function handleServiceError(processor: FrameProcessor, error: ErrorFrame): Promise<void> {
  logger.error(`Service error in ${processor.name}: ${error.error}`);
}
const stt = new MyCustomProcessor({ name: "stt" });
const llm = new MyCustomProcessor({ name: "llm" });
for (const service of [stt, llm, tts]) {
  service.addEventHandler("on_error", handleServiceError);
}

// Frame hooks run inline: keep them fast.
llm.eventHandler("on_before_push_frame", async (processor: FrameProcessor, frame: Frame) => {
  console.log(`${processor} is about to push: ${frame}`);
});
// #endregion event-handlers
