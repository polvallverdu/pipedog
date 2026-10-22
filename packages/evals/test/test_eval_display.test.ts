// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/cli/test_eval_display.py

// Tests for how `pipedog-eval` renders a run's outcome.
//
// DIVERGENCE: upstream renders with rich (a `Console` the tests capture, `Live` frames, a
// windowed table). The port prints plain ANSI, and only `_evalVerdict`, `_turnTally` and
// `_fmtDuration` are exported from `cli.ts`: the rest of upstream's file tests private helpers
// whose output is rich's (the dashboard, its spinner and window, the rate colors) or that this
// port doesn't have under those names (`_expand_scenario_paths`, `_build_scenario_runs`,
// `_group_outcome`, `_finalize_evals`, `_print_progress`). Those tests are skipped; the dashboard
// itself is exercised by `test_evals_suite.test.ts` and the end-to-end test.

import { describe, expect, test } from "bun:test";
import { _evalVerdict, _fmtDuration, _turnTally } from "../src/cli.ts";
import { EvalScriptResult, EvalScriptTurnResult, EvalSimulationResult } from "../src/results.ts";
import { EvalKind } from "../src/scenario.ts";
import { EvalRun } from "../src/suite.ts";

/** An EvalRun whose result has turns in the given statuses (null for no result). */
function run(statuses: string[] | null): EvalRun {
  let result: EvalScriptResult | null = null;
  if (statuses !== null) {
    const turns = statuses.map((status, i) => new EvalScriptTurnResult({ turnIndex: i, status }));
    result = new EvalScriptResult({
      scenarioName: "s",
      passed: turns.every((t) => t.status === "passed"),
      turns,
    });
  }
  return new EvalRun({ bot: "bot", scenario: "s", scenarioPath: "s.yaml", result });
}

describe("TestTurnTally", () => {
  test("test_fully_driven_run_is_counted", () => {
    expect(_turnTally(run(["passed", "failed", "passed"]))).toEqual("2/3 turns");
    // Nothing passing is still a rate worth printing: every turn was scored.
    expect(_turnTally(run(["failed", "failed"]))).toEqual("0/2 turns");
  });

  test("test_stopped_run_has_no_rate", () => {
    // The undriven turns were never attempted, so any fraction over them would read as turns
    // that failed. Where it stopped is in the failure listing.
    for (const statuses of [
      ["passed", "failed", "not_run"],
      ["failed", "not_run"],
    ]) {
      expect(_turnTally(run(statuses))).toEqual("");
    }
  });

  test("test_passing_run_says_nothing", () => {
    // The check mark already says it; a tally beside it would only add noise.
    expect(_turnTally(run(["passed", "passed"]))).toEqual("");
  });

  test("test_run_without_turns", () => {
    expect(_turnTally(run(null))).toEqual("");
    expect(_turnTally(run([]))).toEqual("");
  });
});

describe("TestScenarioPathExpansion", () => {
  test.skip("test_directory_arguments_expand_in_sorted_order", () => {});
  test.skip("test_both_yaml_suffixes_are_taken", () => {});
  test.skip("test_include_fragments_are_left_out", () => {});
  test.skip("test_file_arguments_are_preserved", () => {});
  test.skip("test_empty_directory_is_rejected", () => {});
});

describe("TestScenarioRuns", () => {
  test.skip("test_a_group_file_becomes_a_run_per_entry", () => {});
  test.skip("test_a_file_that_fails_to_load_is_one_failed_run", () => {});
});

/** A finished simulation run; `succeeded: null` is one that errored out. */
function simulationRun(
  succeeded: boolean | null,
  attempt = 1,
  attempts = 3,
  sweep = false,
): EvalRun {
  const result =
    succeeded === null
      ? new EvalSimulationResult({
          simulationName: "book",
          succeeded: false,
          error: "bot never answered",
        })
      : new EvalSimulationResult({
          simulationName: "book",
          succeeded,
          reason: "judged",
          endedBy: succeeded ? "end_call" : "max_turns",
        });
  return new EvalRun({
    bot: "bot",
    scenario: "book",
    scenarioPath: "book.yaml",
    kind: EvalKind.SIMULATION,
    attempt,
    attempts,
    sweep,
    status: "done",
    result,
  });
}

describe("TestSimulationProgress", () => {
  test.skip("test_lines_print_as_spoken_and_the_end_says_how", () => {});
});

describe("TestSimulationVerdicts", () => {
  test("test_a_simulation_run_reads_its_own_outcome", () => {
    expect(_evalVerdict(simulationRun(true))).toEqual("passed");
    expect(_evalVerdict(simulationRun(false))).toEqual("failed");
    expect(_evalVerdict(simulationRun(null))).toEqual("error");
  });

  test("test_detail_is_how_it_ended", () => {
    expect(_turnTally(simulationRun(true))).toEqual("end_call");
    expect(_turnTally(simulationRun(false))).toEqual("max_turns");
  });

  test.skip("test_errored_runs_stay_out_of_the_rate", () => {});
  test.skip("test_every_required_run_must_pass_and_a_sweep_only_measures", () => {});
});

describe("TestDurations", () => {
  test("test_tenths_then_minutes_with_no_sixty_seconds_in_between", () => {
    expect(_fmtDuration(5.04)).toEqual("5.0s");
    expect(_fmtDuration(59.94)).toEqual("59.9s");
    expect(_fmtDuration(59.96)).toEqual("1m 00s");
    expect(_fmtDuration(124.4)).toEqual("2m 04s");
  });
});

// The rich dashboard: its rows, tally, window, spinner and rate colors.
describe("TestDashboard", () => {
  test.skip("test_rows_and_the_tally_render", () => {});
  test.skip("test_a_long_run_is_windowed_to_the_terminal", () => {});
});
describe("TestRateLevel", () => {
  test.skip("test_levels", () => {});
});
describe("TestDashboardSpinner", () => {
  test.skip("test_the_spinner_animates_across_frames", () => {});
  test.skip("test_a_row_keeps_spinning_while_a_finished_attempts_bot_is_stopped", () => {});
});
describe("TestGroupedDashboard", () => {
  test.skip("test_a_row_still_running_shows_what_is_left_and_its_rate_so_far", () => {});
  test.skip("test_a_running_rows_rate_is_a_verdict_on_the_finished_attempts", () => {});
  test.skip("test_a_running_row_shows_the_attempts_clock", () => {});
  test.skip("test_what_is_left_and_the_clock_keep_their_columns", () => {});
  test.skip("test_the_progress_column_is_as_wide_as_a_rate_from_the_start", () => {});
  test.skip("test_a_finished_row_drops_what_was_left_and_keeps_its_rate_in_place", () => {});
  test.skip("test_a_finished_row_shows_the_rate_and_how_long_it_took", () => {});
  test.skip("test_a_row_that_ran_once_shows_its_duration", () => {});
  test.skip("test_a_long_sweep_is_windowed_with_the_tally_kept_on_screen", () => {});
  test.skip("test_the_window_follows_the_terminal_height_and_rows_never_wrap", () => {});
});
