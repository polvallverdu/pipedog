// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rtvi_observer_config.py

/** Tests for dynamic RTVIObserver reconfiguration via RTVIConfigureObserverFrame. */

import { describe, expect, mock, test } from "bun:test";
import type { Frame } from "../src/frames/frames.ts";
import { LLMMarkerFrame, LLMMarkerResponseFrame } from "../src/frames/frames.ts";
import { FramePushed } from "../src/observers/base_observer.ts";
import { FrameDirection, FrameProcessor } from "../src/processors/frame_processor.ts";
import { RTVIConfigureObserverFrame } from "../src/processors/frameworks/rtvi/frames.ts";
import {
  RTVIFunctionCallReportLevel,
  RTVIObserver,
  RTVIObserverParams,
} from "../src/processors/frameworks/rtvi/observer.ts";

// Access to the observer's protected members, as the Python test does.
type ObserverInternals = {
  _getFunctionCallReportLevel(functionName: string): RTVIFunctionCallReportLevel;
  _applyConfig(frame: RTVIConfigureObserverFrame): void;
  _params: RTVIObserverParams;
};

function internals(observer: RTVIObserver): ObserverInternals {
  return observer as unknown as ObserverInternals;
}

describe("TestRTVIConfigureObserver", () => {
  test("test_raises_report_level_at_runtime", () => {
    // Agents default to the secure NONE; a config frame elevates it live.
    const observer = internals(new RTVIObserver(null, { params: new RTVIObserverParams() }));
    expect(observer._getFunctionCallReportLevel("get_weather")).toEqual(
      RTVIFunctionCallReportLevel.NONE,
    );
    observer._applyConfig(
      new RTVIConfigureObserverFrame({
        functionCallReportLevel: { "*": RTVIFunctionCallReportLevel.FULL },
      }),
    );
    expect(observer._getFunctionCallReportLevel("get_weather")).toEqual(
      RTVIFunctionCallReportLevel.FULL,
    );
  });

  test("test_none_field_leaves_config_unchanged", () => {
    const observer = internals(
      new RTVIObserver(null, {
        params: new RTVIObserverParams({
          functionCallReportLevel: { "*": RTVIFunctionCallReportLevel.NAME },
        }),
      }),
    );
    observer._applyConfig(new RTVIConfigureObserverFrame({ functionCallReportLevel: null }));
    expect(observer._getFunctionCallReportLevel("get_weather")).toEqual(
      RTVIFunctionCallReportLevel.NAME,
    );
  });

  test("test_enables_vad_user_speaking_at_runtime", () => {
    // Off by default; a config frame enables raw VAD speaking events live.
    const observer = internals(new RTVIObserver(null, { params: new RTVIObserverParams() }));
    expect(observer._params.vadUserSpeakingEnabled).toBe(false);
    observer._applyConfig(new RTVIConfigureObserverFrame({ vadUserSpeakingEnabled: true }));
    expect(observer._params.vadUserSpeakingEnabled).toBe(true);
    // A None field leaves it unchanged.
    observer._applyConfig(new RTVIConfigureObserverFrame({ vadUserSpeakingEnabled: null }));
    expect(observer._params.vadUserSpeakingEnabled).toBe(true);
  });

  test("test_enables_llm_markers_at_runtime", () => {
    // Off by default; a config frame enables the LLM's sideband markers live.
    const observer = internals(new RTVIObserver(null, { params: new RTVIObserverParams() }));
    expect(observer._params.botLlmMarkerEnabled).toBe(false);
    observer._applyConfig(new RTVIConfigureObserverFrame({ botLlmMarkerEnabled: true }));
    expect(observer._params.botLlmMarkerEnabled).toBe(true);
    observer._applyConfig(new RTVIConfigureObserverFrame({ botLlmMarkerEnabled: null }));
    expect(observer._params.botLlmMarkerEnabled).toBe(true);
  });
});

describe("TestRTVIObserverLLMMarkers", () => {
  async function _push(observer: RTVIObserver, frame: Frame): Promise<any[]> {
    const sent: any[] = [];
    observer.sendRtviMessage = mock(async (m: unknown) => {
      sent.push(m);
    });
    const source = new FrameProcessor();
    await observer.onPushFrame(
      new FramePushed({
        source,
        destination: source,
        frame,
        direction: FrameDirection.DOWNSTREAM,
        timestamp: 0,
      }),
    );
    return sent;
  }

  test("test_markers_are_not_sent_by_default", async () => {
    const observer = new RTVIObserver(null, { params: new RTVIObserverParams() });
    const sent = await _push(observer, new LLMMarkerResponseFrame({ raw: "● Hi", marker: "●" }));
    expect(sent).toEqual([]);
  });

  test("test_marker_is_sent_when_enabled", async () => {
    const observer = new RTVIObserver(null, {
      params: new RTVIObserverParams({ botLlmMarkerEnabled: true }),
    });
    const frame = new LLMMarkerResponseFrame({
      raw: "● Hi there",
      marker: "●",
      kind: "complete",
      markers: ["●", "◐", "○"],
    });
    const sent = await _push(observer, frame);
    expect(sent.length).toEqual(1);
    expect(sent[0].type).toEqual("bot-llm-marker");
    expect(sent[0].data.text).toEqual("●");
    expect(sent[0].data.kind).toEqual("complete");
    expect(sent[0].data.raw).toEqual("● Hi there");
    expect(sent[0].data.markers).toEqual(["●", "◐", "○"]);
  });

  test("test_a_response_without_a_marker_is_reported_too", async () => {
    const observer = new RTVIObserver(null, {
      params: new RTVIObserverParams({ botLlmMarkerEnabled: true }),
    });
    const sent = await _push(observer, new LLMMarkerResponseFrame({ raw: "Hi there" }));
    expect([sent[0].data.text, sent[0].data.kind]).toEqual(["", null]);
  });

  test("test_the_marker_frame_itself_is_not_sent", async () => {
    // The context aggregator's marker frame is not the report; the report
    // comes once per response, when it ends.
    const observer = new RTVIObserver(null, {
      params: new RTVIObserverParams({ botLlmMarkerEnabled: true }),
    });
    const sent = await _push(observer, new LLMMarkerFrame({ marker: "●" }));
    expect(sent).toEqual([]);
  });
});
