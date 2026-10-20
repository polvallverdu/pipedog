// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/concepts/metrics-and-tracing.mdx. Type-checked on every docs build.

import { type Frame, MetricsFrame } from "@pipecat-ts/core/frames/frames";
import {
  LLMUsageMetricsData,
  ProcessingMetricsData,
  TTFAMetricsData,
  TTFBMetricsData,
  TTSUsageMetricsData,
} from "@pipecat-ts/core/metrics/metrics";
import { MetricsLogObserver } from "@pipecat-ts/core/observers/loggers/metrics_log_observer";
import { Pipeline } from "@pipecat-ts/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipecat-ts/core/pipeline/worker";
import { type FrameDirection, FrameProcessor } from "@pipecat-ts/core/processors/frame_processor";

const pipeline = new Pipeline([]);

// #region enable
const worker = new PipelineWorker(pipeline, {
  params: new PipelineParams({
    enableMetrics: true, // TTFB, processing time, ...
    enableUsageMetrics: true, // LLM tokens, TTS characters, ...
    reportOnlyInitialTtfb: true, // only the first TTFB per service
    sendInitialEmptyMetrics: false,
  }),
  observers: [
    // Log only LLM and TTS usage.
    new MetricsLogObserver({
      includeMetrics: new Set([LLMUsageMetricsData, TTSUsageMetricsData]),
    }),
  ],
});
// #endregion enable
void worker;

// #region capture
export class MetricsCollector extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof MetricsFrame) {
      for (const data of frame.data) {
        if (data instanceof TTFBMetricsData) {
          console.log(`${data.processor} TTFB: ${data.value}s`);
        } else if (data instanceof ProcessingMetricsData) {
          console.log(`${data.processor} processing: ${data.value}s`);
        } else if (data instanceof TTFAMetricsData) {
          console.log(
            `${data.processor} TTFA: ${data.ttfa}s (leading silence ${data.leadingSilence}s)`,
          );
        } else if (data instanceof LLMUsageMetricsData) {
          const { promptTokens, completionTokens } = data.value;
          console.log(`${data.processor} prompt: ${promptTokens}, completion: ${completionTokens}`);
        } else if (data instanceof TTSUsageMetricsData) {
          console.log(`${data.processor} characters: ${data.value}`);
        }
      }
    }

    await this.pushFrame(frame, direction);
  }
}
// #endregion capture
