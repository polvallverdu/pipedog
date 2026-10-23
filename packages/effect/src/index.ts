// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

export {
  PipelineError,
  type PipelineHandle,
  type PipelineOptions,
  runPipeline,
  startPipeline,
} from "./pipeline.ts";
export {
  EffectFrameProcessor,
  makeProcessor,
  type ProcessFrameContext,
  type ProcessFrameEffect,
} from "./processor.ts";
