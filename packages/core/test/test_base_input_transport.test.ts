// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_base_input_transport.py

/** Tests for frame-based audio handling in `BaseInputTransport`. */

import { describe, expect, mock, test } from "bun:test";

import type { BaseAudioFilter } from "../src/audio/filters/base_audio_filter.ts";
import {
  FilterEnableFrame,
  FilterUpdateSettingsFrame,
  InputAudioRawFrame,
  InputTransportStartAudioStreamingFrame,
} from "../src/frames/frames.ts";
import { FrameDirection } from "../src/processors/frame_processor.ts";
import { BaseInputTransport } from "../src/transports/base_input.ts";
import { TransportParams } from "../src/transports/base_transport.ts";

// Lets tests replace methods (including protected ones) with mocks, as
// upstream does by assigning AsyncMock attributes.
type Patchable = any;

const asyncMock = () => mock(async (..._args: unknown[]) => {});

describe("TestBaseInputTransportFrameAudio", () => {
  const _transport = (): BaseInputTransport =>
    new BaseInputTransport(new TransportParams({ audioInEnabled: true }));

  test("test_incoming_audio_frame_routed_to_push_audio_frame", async () => {
    const transport: Patchable = _transport();
    transport.pushAudioFrame = asyncMock();
    transport.pushFrame = asyncMock();
    const frame = new InputAudioRawFrame({
      audio: new Uint8Array([0x00, 0x00]),
      sampleRate: 16000,
      numChannels: 1,
    });
    await transport.processFrame(frame, FrameDirection.DOWNSTREAM);
    // Fed into the VAD path, not forwarded as a plain frame.
    expect(transport.pushAudioFrame).toHaveBeenCalledTimes(1);
    expect(transport.pushAudioFrame).toHaveBeenCalledWith(frame);
  });

  test("test_start_audio_streaming_frame_triggers_streaming", async () => {
    const transport: Patchable = _transport();
    transport._startAudioInStreaming = asyncMock();
    await transport.processFrame(
      new InputTransportStartAudioStreamingFrame(),
      FrameDirection.DOWNSTREAM,
    );
    expect(transport._startAudioInStreaming).toHaveBeenCalledTimes(1);
  });

  // Skipped: `start_audio_in_streaming()` is a deprecated public alias of
  // `_start_audio_in_streaming()` upstream; deprecated APIs are not ported.
  test.skip("test_start_audio_in_streaming_method_is_deprecated", async () => {});
});

describe("TestBaseInputTransportFilterFrames", () => {
  const _transport = (): BaseInputTransport => {
    const audioInFilter = {
      start: asyncMock(),
      stop: asyncMock(),
      processFrame: asyncMock(),
      filter: mock(async (audio: Uint8Array) => audio),
    } as unknown as BaseAudioFilter;
    return new BaseInputTransport(new TransportParams({ audioInFilter }));
  };

  test("test_filter_control_frames_go_to_input_filter", async () => {
    for (const frame of [
      new FilterEnableFrame({ enable: false }),
      new FilterUpdateSettingsFrame({ settings: {} }),
    ]) {
      // subTest(frame=frame.name)
      const transport: Patchable = _transport();
      transport.pushFrame = asyncMock();
      await transport.processFrame(frame, FrameDirection.DOWNSTREAM);
      expect(transport._params.audioInFilter.processFrame).toHaveBeenCalledTimes(1);
      expect(transport._params.audioInFilter.processFrame).toHaveBeenCalledWith(frame);
      expect(transport.pushFrame).not.toHaveBeenCalled();
    }
  });
});
