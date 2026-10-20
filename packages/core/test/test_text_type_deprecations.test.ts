// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_text_type_deprecations.py

/**
 * Tests for the deprecated names of `text_type`.
 *
 * Upstream, this file checks that the names deprecated since 1.13.0 in favour
 * of `text_type` (`aggregated_by` on the text frames, `skip_aggregator_types`
 * on `RTVIObserverParams` and `TTSService`, the `aggregation_type` argument of
 * the transformer helpers, and the `AggregationType` alias of `TextType`)
 * still work and warn. Deprecated upstream APIs are not ported (see
 * docs/CONVENTIONS.md), so those tests are skipped with the reason.
 *
 * Two tests still apply: the text type given to a frame (upstream passes it by
 * position; frames take an options object here), and the RTVI
 * `BotOutputMessageData` wire format, which still carries both `text_type` and
 * `aggregated_by` so v1 clients keep working.
 */

import { describe, expect, test } from "bun:test";

import { TTSTextFrame } from "../src/frames/frames.ts";
import * as RTVI from "../src/processors/frameworks/rtvi/models.ts";
import { TextType } from "../src/utils/text/base_text_aggregator.ts";

// Skipped: `aggregated_by=` on AggregatedTextFrame / TTSTextFrame is deprecated
// upstream (since 1.13.0) and not ported.
describe.each(["AggregatedTextFrame", "TTSTextFrame"])("%s", () => {
  test.skip("test_aggregated_by_keyword_sets_text_type", () => {});
});

// Skipped: `aggregated_by=` on subclasses of the text frames is deprecated
// upstream and not ported.
describe.each(["_AppTextFrame", "_AbstractAppTextFrame"])("%s", () => {
  test.skip("test_aggregated_by_keyword_on_a_subclass", () => {});
});

test("test_text_type_by_position", () => {
  const frame = new TTSTextFrame({ text: "Hello.", textType: TextType.WORD });
  expect(frame.textType).toEqual(TextType.WORD);
});

// Skipped: the `aggregated_by` property of AggregatedTextFrame is deprecated
// upstream and not ported.
test.skip("test_reading_aggregated_by_returns_text_type", () => {});

// Skipped: the `aggregated_by` property of AggregatedTextFrame is deprecated
// upstream and not ported.
test.skip("test_assigning_aggregated_by_sets_text_type", () => {});

// Skipped: `aggregated_by` on AggregatedTextProgressFrame is deprecated
// upstream and not ported.
test.skip("test_progress_frame_aggregated_by", () => {});

// Skipped: `RTVIObserverParams.skip_aggregator_types` is deprecated upstream
// and not ported.
test.skip("test_rtvi_observer_params_skip_aggregator_types", () => {});

// Skipped: the `aggregation_type` argument of
// `RTVIObserver.add/remove_bot_output_transformer` is deprecated upstream and
// not ported.
test.skip("test_rtvi_observer_transformer_aggregation_type", () => {});

// Skipped: `TTSService(skip_aggregator_types=)` is deprecated upstream and not
// ported.
test.skip("test_tts_service_skip_aggregator_types", () => {});

// Skipped: the `aggregation_type` argument of
// `TTSService.add/remove_text_transformer` is deprecated upstream and not
// ported.
test.skip("test_tts_service_transformer_aggregation_type", () => {});

describe.each(["textType", "aggregatedBy"])("[%s]", (field) => {
  test("test_bot_output_message_carries_both_fields", () => {
    const data = new RTVI.BotOutputMessageData({ text: "Hello.", [field]: "status" });
    expect(data.modelDump({ excludeNone: true })).toEqual({
      text: "Hello.",
      text_type: "status",
      aggregated_by: "status",
    });
  });
});

// Skipped: the `AggregationType` alias of `TextType` (in
// utils/text/base_text_aggregator and frames/frames) is deprecated upstream
// and not ported.
describe.each(["pipecat.utils.text.base_text_aggregator", "pipecat.frames.frames"])("%s", () => {
  test.skip("test_aggregation_type_is_text_type", () => {});
});
