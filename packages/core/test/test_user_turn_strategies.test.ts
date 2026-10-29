// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_user_turn_strategies.py

import { describe, expect, test } from "bun:test";

import {
  ExternalUserTurnStartStrategy,
  TranscriptionUserTurnStartStrategy,
  VADUserTurnStartStrategy,
} from "../src/turns/user_start/index.ts";
import {
  ExternalUserTurnStopStrategy,
  LLMTurnCompletionUserTurnStopStrategy,
  SpeechTimeoutUserTurnStopStrategy,
  TurnAnalyzerUserTurnStopStrategy,
} from "../src/turns/user_stop/index.ts";
import {
  ExternalUserTurnStrategies,
  FilterIncompleteUserTurnStrategies,
  MergeMode,
  UserTurnStrategies,
  UserTurnStrategiesParams,
} from "../src/turns/user_turn_strategies.ts";

const EXTEND_STOP = new UserTurnStrategiesParams({ stopMergeMode: MergeMode.EXTEND });

/** Python's `[type(s) for s in strategies]`. */
function types(strategies: readonly object[]): unknown[] {
  return strategies.map((s) => s.constructor);
}

describe("TestMergeWithRecommendation", () => {
  // A bot's user turn strategies merge with a service's, list by list.

  test("test_a_bots_lists_replace_the_services_by_default", () => {
    const stop = new SpeechTimeoutUserTurnStopStrategy();
    const strategies = new UserTurnStrategies({ stop: [stop] });

    const merged = strategies.mergeWith(
      new ExternalUserTurnStrategies(),
      new UserTurnStrategiesParams(),
    );

    expect(merged.stop).toEqual([stop]);
    expect(merged.start).toEqual(strategies.start);
  });

  test("test_an_extending_list_joins_the_services", () => {
    const stop = new SpeechTimeoutUserTurnStopStrategy();
    const recommended = new ExternalUserTurnStrategies();

    const merged = new UserTurnStrategies({ stop: [stop] }).mergeWith(recommended, EXTEND_STOP);

    expect(merged.stop).toEqual([...(recommended.stop ?? []), stop]);
  });

  test("test_extending_a_list_left_out_keeps_the_services", () => {
    const recommended = new ExternalUserTurnStrategies();
    const params = new UserTurnStrategiesParams({ startMergeMode: MergeMode.EXTEND });

    const merged = new UserTurnStrategies({
      stop: [new SpeechTimeoutUserTurnStopStrategy()],
    }).mergeWith(recommended, params);

    expect(merged.start).toEqual(recommended.start);
  });

  test("test_without_a_recommendation_an_extending_list_joins_the_defaults", () => {
    const start = new ExternalUserTurnStartStrategy();
    const strategies = new UserTurnStrategies({
      start: [start],
      stop: [new SpeechTimeoutUserTurnStopStrategy()],
    });
    const params = new UserTurnStrategiesParams({ startMergeMode: MergeMode.EXTEND });

    const merged = strategies.mergeWith(null, params);

    expect(types(merged.start ?? [])).toEqual([
      VADUserTurnStartStrategy,
      TranscriptionUserTurnStartStrategy,
      ExternalUserTurnStartStrategy,
    ]);
    expect((merged.start ?? []).at(-1)).toBe(start);
  });

  test("test_only_two_replacing_lists_leave_a_recommendation_unused", () => {
    expect(new UserTurnStrategiesParams().replacesServiceStrategies).toBe(true);
    expect(EXTEND_STOP.replacesServiceStrategies).toBe(false);
    expect(
      new UserTurnStrategiesParams({ startMergeMode: MergeMode.EXTEND }).replacesServiceStrategies,
    ).toBe(false);
  });
});

describe("TestFilterIncompleteMerge", () => {
  // Filtering incomplete turns replaces a service's stop strategies, or joins them.

  test("test_replacing_filters_with_the_default_stop_strategy", () => {
    const merged = new FilterIncompleteUserTurnStrategies().mergeWith(
      new ExternalUserTurnStrategies(),
      new UserTurnStrategiesParams(),
    );

    expect(types(merged.stop ?? [])).toEqual([
      TurnAnalyzerUserTurnStopStrategy,
      LLMTurnCompletionUserTurnStopStrategy,
    ]);
  });

  test("test_extending_adds_only_the_llm_gate", () => {
    const merged = new FilterIncompleteUserTurnStrategies().mergeWith(
      new ExternalUserTurnStrategies(),
      EXTEND_STOP,
    );

    expect(types(merged.stop ?? [])).toEqual([
      ExternalUserTurnStopStrategy,
      LLMTurnCompletionUserTurnStopStrategy,
    ]);
  });

  test("test_extending_adds_the_stop_strategies_given_with_the_llm_gate", () => {
    const strategies = new FilterIncompleteUserTurnStrategies({
      stop: [new SpeechTimeoutUserTurnStopStrategy()],
    });

    const merged = strategies.mergeWith(new ExternalUserTurnStrategies(), EXTEND_STOP);

    expect(types(merged.stop ?? [])).toEqual([
      ExternalUserTurnStopStrategy,
      SpeechTimeoutUserTurnStopStrategy,
      LLMTurnCompletionUserTurnStopStrategy,
    ]);
  });
});
