// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: imports the core pipeline modules and
// runs a one-processor pipeline end to end with runTest(), then resamples
// audio with the default (WASM) resampler engine, then checks that the
// optional OpenTelemetry peer is detected exactly when it is installed.

import { defineTool } from "@pipedog/core/adapters/llm/schemas/standard_tool";
import { createFileResampler, createStreamResampler } from "@pipedog/core/audio/utils";
import { EndFrame, type Frame, TextFrame } from "@pipedog/core/frames/frames";
import { TurnTrackingObserver } from "@pipedog/core/observers/turn_tracking_observer";
import { UserBotLatencyObserver } from "@pipedog/core/observers/user_bot_latency_observer";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { runTest } from "@pipedog/core/tests/utils";
import { logger } from "@pipedog/core/utils/logger";
import { isTracingAvailable, loadOpenTelemetry } from "@pipedog/core/utils/tracing/setup";
import { TurnTraceObserver } from "@pipedog/core/utils/tracing/turn_trace_observer";
import { WorkerRunner } from "@pipedog/core/workers/runner";

class PassThrough extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);
  }
}

// Built at module top level, before core's asynchronous import of
// @opentelemetry/api has finished: tracing must still turn on when it runs.
const topLevelWorker = new PipelineWorker(new Pipeline([new PassThrough()]), {
  enableTracing: true,
  cancelOnIdleTimeout: false,
});

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`core smoke: ${message}`);
}

export default async function smoke(): Promise<void> {
  // Constructing the building blocks must not need any runtime-specific API.
  const pipeline = new Pipeline([new PassThrough()]);
  const worker = new PipelineWorker(pipeline, { params: new PipelineParams() });
  check(worker instanceof PipelineWorker, "PipelineWorker");
  check(new WorkerRunner() instanceof WorkerRunner, "WorkerRunner");

  // And a frame must make it through a running pipeline.
  const [down] = await runTest(new PassThrough(), {
    framesToSend: [new TextFrame({ text: "hello" })],
    expectedDownFrames: [TextFrame],
  });
  const text = down[0];
  check(text instanceof TextFrame && text.text === "hello", "TextFrame did not pass through");

  await resampling();
  await tracing();
  await typedTools();
}

/**
 * `@opentelemetry/api` is an optional peer: core must load and run with or
 * without it, and detect it when it is there. The compat harness says which
 * case this run is (`--with-optional-peers` or not).
 */
async function tracing(): Promise<void> {
  const compat = (globalThis as { __PIPEDOG_COMPAT__?: { hiddenModules: string[] } })
    .__PIPEDOG_COMPAT__;
  const available = await loadOpenTelemetry();
  check(
    available === isTracingAvailable(),
    "loadOpenTelemetry() disagrees with isTracingAvailable()",
  );
  if (compat) {
    const expected = !compat.hiddenModules.includes("@opentelemetry/api");
    check(
      available === expected,
      `tracing available = ${available}, expected ${expected} (@opentelemetry/api ${expected ? "installed" : "not installed"})`,
    );
  }

  // Tracing is enabled only when OpenTelemetry is there; the worker builds either way.
  const worker = new PipelineWorker(new Pipeline([new PassThrough()]), { enableTracing: true });
  check(
    (worker as unknown as { _enableTracing: boolean })._enableTracing === available,
    "PipelineWorker enableTracing does not follow isTracingAvailable()",
  );

  // The worker built before OpenTelemetry loaded picks tracing up when it runs.
  topLevelWorker.eventHandler("on_pipeline_started", async () => {
    await topLevelWorker.queueFrame(new EndFrame());
  });
  const runner = new WorkerRunner({ handleSigint: false });
  await runner.addWorkers(topLevelWorker);
  await runner.run();
  check(
    (topLevelWorker.turnTraceObserver !== null) === available,
    `top-level PipelineWorker: turn tracing ${topLevelWorker.turnTraceObserver ? "on" : "off"}, OpenTelemetry ${available ? "available" : "unavailable"}`,
  );

  // Conversation and turn spans go to the API's no-op tracer without an SDK.
  const turnTracker = new TurnTrackingObserver();
  const observer = new TurnTraceObserver({
    turnTracker,
    latencyTracker: new UserBotLatencyObserver(),
  });
  observer.startConversationTracing("compat");
  observer.endConversationTracing();
}

/** Count rising zero crossings of 16-bit PCM. */
function risingZeroCrossings(audio: Uint8Array): number {
  const samples = new Int16Array(audio.slice().buffer);
  let count = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] as number) < 0 && (samples[i] as number) >= 0) count++;
  }
  return count;
}

async function resampling(): Promise<void> {
  // The WASM engine must load here: a fallback to the TypeScript engine logs
  // a warning, which counts as a failure on this runtime.
  const warnings: string[] = [];
  const original = logger.warning.bind(logger);
  logger.warning = (message: string) => {
    warnings.push(message);
    original(message);
  };
  try {
    const input = new Int16Array(8000); // 1 s of 440 Hz at 8 kHz
    for (let i = 0; i < input.length; i++) {
      input[i] = Math.round(10000 * Math.sin((2 * Math.PI * 440 * i) / 8000));
    }
    const pcm = new Uint8Array(input.buffer);

    const out = await createFileResampler().resample(pcm, 8000, 16000);
    check(out.length === 32000, `file resampler gave ${out.length} bytes, expected 32000`);
    const cycles = risingZeroCrossings(out);
    check(Math.abs(cycles - 440) <= 1, `440 Hz came out as ${cycles} Hz`);

    const stream = createStreamResampler();
    const head = await stream.resample(pcm.subarray(0, 8000), 8000, 48000);
    const rest = await stream.resample(pcm.subarray(8000), 8000, 48000);
    const tail = await stream.flush();
    const total = head.length + rest.length + tail.length;
    check(total === 96000, `stream resampler gave ${total} bytes, expected 96000`);

    check(warnings.length === 0, `resampler warning: ${warnings.join("; ")}`);
  } finally {
    logger.warning = original;
  }
}

/**
 * `defineTool` with a hand-written Standard Schema (no schema library needed):
 * the JSON schema, the validation failure path and the success path.
 */
async function typedTools(): Promise<void> {
  const parameters = {
    "~standard": {
      version: 1 as const,
      vendor: "compat",
      validate: (value: unknown) => {
        const v = value as { n?: unknown };
        return typeof v.n === "number"
          ? { value: { n: v.n } }
          : { issues: [{ message: "expected number", path: ["n"] }] };
      },
      jsonSchema: {
        input: () => ({ type: "object", properties: { n: { type: "number" } }, required: ["n"] }),
        output: () => ({ type: "object", properties: { n: { type: "number" } }, required: ["n"] }),
      },
    },
  };
  const tool = defineTool({
    name: "double",
    description: "Double a number.",
    parameters,
    handler: ({ n }: { n: number }) => n * 2,
  });
  check(tool.required.join() === "n", "defineTool required");

  const results: unknown[] = [];
  const call = (args: Record<string, unknown>) =>
    tool.handler({
      arguments: args,
      resultCallback: async (r: unknown) => {
        results.push(r);
      },
    } as never);
  const original = logger.warning.bind(logger);
  logger.warning = () => {};
  try {
    await call({ n: 4 });
    await call({ n: "x" });
  } finally {
    logger.warning = original;
  }
  check(results[0] === 8, "defineTool success result");
  check(
    (results[1] as { issues: { path: string }[] }).issues[0]?.path === "n",
    "defineTool validation failure result",
  );
}
