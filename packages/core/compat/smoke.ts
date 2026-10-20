// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: imports the core pipeline modules and
// runs a one-processor pipeline end to end with runTest(), then resamples
// audio with the default (WASM) resampler engine.

import { createFileResampler, createStreamResampler } from "@pipedog/core/audio/utils";
import { type Frame, TextFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { runTest } from "@pipedog/core/tests/utils";
import { logger } from "@pipedog/core/utils/logger";
import { WorkerRunner } from "@pipedog/core/workers/runner";

class PassThrough extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);
  }
}

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
