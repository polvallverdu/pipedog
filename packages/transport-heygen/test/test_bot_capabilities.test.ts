// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_bot_capabilities.py

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { BotCapabilities } from "@pipedog/core/pipeline/capabilities";
import { ParallelPipeline } from "@pipedog/core/pipeline/parallel_pipeline";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import * as RTVI from "@pipedog/core/processors/frameworks/rtvi/models";
import { RTVIProcessor } from "@pipedog/core/processors/frameworks/rtvi/processor";
import { BaseInputTransport } from "@pipedog/core/transports/base_input";
import { BaseOutputTransport } from "@pipedog/core/transports/base_output";
import {
  TransportParams,
  type TransportParamsOptions,
  VideoInSourceParams,
} from "@pipedog/core/transports/base_transport";
import { logger } from "@pipedog/core/utils/logger";
import type { HeyGenClient } from "@pipedog/heygen/client";
import { HeyGenOutputTransport } from "../src/transport.ts";

afterEach(() => {
  mock.restore();
});

describe("TestBotCapabilities", () => {
  test("test_combine_true_wins", () => {
    const a = new BotCapabilities({ audioIn: false, videoOut: true });
    const b = new BotCapabilities({ audioIn: true, videoOut: false });
    expect(a.combine(b)).toEqual(new BotCapabilities({ audioIn: true, videoOut: true }));
  });

  test("test_combine_keeps_false_and_unknown", () => {
    const a = new BotCapabilities({ videoIn: false });
    const b = new BotCapabilities();
    expect(a.combine(b)).toEqual(new BotCapabilities({ videoIn: false }));
  });

  test("test_override_applies_only_known_fields", () => {
    const base = new BotCapabilities({ audioIn: true, videoOut: false, metrics: true });
    const result = base.override(new BotCapabilities({ videoOut: true }));
    expect(result).toEqual(new BotCapabilities({ audioIn: true, videoOut: true, metrics: true }));
  });
});

/** An input transport that captures the camera and screen share from `videoInSources`. */
class _SourcesInputTransport extends BaseInputTransport {
  protected override _supportsVideoInSource(videoSource: string): boolean {
    return videoSource === "camera" || videoSource === "screenVideo";
  }
}

function _transport(
  params: TransportParamsOptions = {},
): [BaseInputTransport, BaseOutputTransport] {
  const transportParams = new TransportParams(params);
  return [new _SourcesInputTransport(transportParams), new BaseOutputTransport(transportParams)];
}

describe("TestPipelineWorkerCapabilities", () => {
  test("test_derived_from_transport_params", () => {
    const [input, output] = _transport({ audioInEnabled: true, audioOutEnabled: true });
    const worker = new PipelineWorker(new Pipeline([input, output]));
    expect(worker.capabilities).toEqual(
      new BotCapabilities({
        audioIn: true,
        audioOut: true,
        videoIn: false,
        screenIn: false,
        videoOut: false,
        metrics: false,
      }),
    );
  });

  test("test_screen_in_when_sources_include_screen_video", () => {
    const [input, output] = _transport({
      videoInEnabled: true,
      videoInSources: {
        camera: new VideoInSourceParams(),
        screenVideo: new VideoInSourceParams(),
      },
    });
    const worker = new PipelineWorker(new Pipeline([input, output]));
    expect(worker.capabilities.screenIn).toBe(true);
  });

  test("test_no_screen_in_when_sources_exclude_screen_video", () => {
    const [input, output] = _transport({
      videoInEnabled: true,
      videoInSources: { camera: new VideoInSourceParams() },
    });
    const worker = new PipelineWorker(new Pipeline([input, output]));
    expect(worker.capabilities.screenIn).toBe(false);
  });

  test("test_screen_in_unknown_without_sources", () => {
    const [input, output] = _transport({ videoInEnabled: true });
    const worker = new PipelineWorker(new Pipeline([input, output]));
    expect(worker.capabilities.videoIn).toBe(true);
    expect(worker.capabilities.screenIn).toBeNull();
  });

  test("test_unsupported_sources_warned_and_screen_in_unknown", () => {
    const params = new TransportParams({
      videoInEnabled: true,
      videoInSources: { screenVideo: new VideoInSourceParams() },
    });
    const warning = spyOn(logger, "warning").mockImplementation(() => {});
    const input = new BaseInputTransport(params);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(String(warning.mock.calls[0]![0])).toContain("screenVideo");

    const worker = new PipelineWorker(new Pipeline([input, new BaseOutputTransport(params)]));
    expect(worker.capabilities.screenIn).toBeNull();
  });

  test("test_supported_sources_not_warned", () => {
    const warning = spyOn(logger, "warning").mockImplementation(() => {});
    _transport({ videoInEnabled: true, videoInSources: { camera: new VideoInSourceParams() } });
    expect(warning).not.toHaveBeenCalled();
  });

  test("test_metrics_from_pipeline_params", () => {
    const [input, output] = _transport();
    const worker = new PipelineWorker(new Pipeline([input, output]), {
      params: new PipelineParams({ enableMetrics: true }),
    });
    expect(worker.capabilities.metrics).toBe(true);
  });

  test("test_transports_nested_in_parallel_pipeline", () => {
    const [input, output] = _transport({ videoInEnabled: true, videoOutEnabled: true });
    const worker = new PipelineWorker(new Pipeline([new ParallelPipeline([input], [output])]));
    expect(worker.capabilities.videoIn).toBe(true);
    expect(worker.capabilities.videoOut).toBe(true);
  });

  test("test_no_transport_leaves_media_unknown", () => {
    const worker = new PipelineWorker(new Pipeline([]));
    expect(worker.capabilities).toEqual(new BotCapabilities({ metrics: false }));
  });

  test("test_constructor_override", () => {
    const [input, output] = _transport({ audioInEnabled: true, audioOutEnabled: true });
    const worker = new PipelineWorker(new Pipeline([input, output]), {
      capabilities: new BotCapabilities({ videoOut: true }),
    });
    expect(worker.capabilities.audioIn).toBe(true);
    expect(worker.capabilities.videoOut).toBe(true);
  });

  test("test_avatar_output_reports_video_out", () => {
    const output = new HeyGenOutputTransport(
      {} as HeyGenClient,
      new TransportParams({ audioOutEnabled: true }),
    );
    const worker = new PipelineWorker(new Pipeline([output]));
    expect(worker.capabilities.audioOut).toBe(true);
    expect(worker.capabilities.videoOut).toBe(true);
  });
});

describe("TestBotReadyCapabilities", () => {
  test("test_bot_ready_carries_worker_capabilities", async () => {
    const capabilities = new BotCapabilities({ audioIn: true, audioOut: true, videoIn: false });
    const processor = new RTVIProcessor();
    (processor as unknown as { _setup: unknown })._setup = {
      pipelineWorker: { capabilities },
    };
    const pushTransportMessage = mock(async (_model: unknown, _excludeNone?: boolean) => {});
    processor.pushTransportMessage = pushTransportMessage;

    await processor.setBotReady();

    const message = pushTransportMessage.mock.calls[0]![0] as RTVI.BotReady;
    expect(message).toBeInstanceOf(RTVI.BotReady);
    expect(message.data.capabilities).toEqual(capabilities);
    // Unknown fields are left out of the wire message.
    const dumped = message.modelDump({ excludeNone: true }) as {
      data: { capabilities: unknown };
    };
    expect(dumped.data.capabilities).toEqual({ audio_in: true, audio_out: true, video_in: false });
    await processor.cleanup();
  });
});
