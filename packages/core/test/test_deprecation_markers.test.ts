// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_deprecation_markers.py

/**
 * Audit of deprecation conventions.
 *
 * Upstream, this file audits the `.. deprecated::` docstring directives across
 * `src/pipecat` through the Python build tooling in `scripts/deprecations/`
 * (`scan.py`, `generate.py`, `generate_removals.py`), and checks that the
 * deprecated runtime shims still warn. Neither carries over to pipedog:
 *
 * - the scanner, the registry generator and the removals diff are Python build
 *   tooling over the Python source tree, not part of the shipped library, and
 *   are not ported;
 * - deprecated upstream APIs (`PipelineTask`, `PipelineTaskParams`,
 *   `PipelineRunner`, the task frame aliases, `StartFrame.enable_metrics`,
 *   `warn_deprecated_read`, `renamed_init_field`) are not ported
 *   (see docs/CONVENTIONS.md), so there is nothing to warn.
 *
 * Those tests are skipped with the reason. The import-time check still applies:
 * importing the modules that upstream keeps shims in must not emit a
 * deprecation warning.
 */

import { expect, test } from "bun:test";

// --- Directive enforcement (the registry source of truth) --------------------

// DIVERGENCE: Python build tooling (scripts/deprecations/scan.py) over the Python source
// tree; not ported.
test.skip("test_directives_parse", () => {});
test.skip("test_directives_state_removal_version", () => {});
test.skip("test_no_replacement_directive_extracts_no_replacement", () => {});
test.skip("test_directives_are_attributed_to_the_entry_they_sit_under", () => {});
test.skip("test_top_level_directive_deprecates_the_symbol", () => {});

// --- @deprecated decorator message consistency -------------------------------

// DIVERGENCE: Python build tooling (scripts/deprecations/scan.py) auditing Python
// `@deprecated` / `warnings.warn` call sites; not ported.
test.skip("test_deprecated_messages_follow_template", () => {});
test.skip("test_warn_messages_follow_template", () => {});
test.skip("test_deprecation_warnings_use_the_helper", () => {});
test.skip("test_deprecated_subject_names_decorated_symbol", () => {});
test.skip("test_deprecated_version_matches_docstring_directive", () => {});
test.skip("test_deprecated_replacement_targets_exist", () => {});

// --- Generated registry ------------------------------------------------------

// DIVERGENCE: Python build tooling (scripts/deprecations/generate.py and the committed
// deprecations.json); not ported.
test.skip("test_deprecations_registry_is_up_to_date", () => {});

// --- Runtime behavior --------------------------------------------------------

// Deprecated upstream API (`PipelineTask` alias) is not ported; see docs/CONVENTIONS.md.
test.skip("test_pipeline_task_warns", () => {});
// Deprecated upstream API (`PipelineTaskParams`) is not ported; see docs/CONVENTIONS.md.
test.skip("test_pipeline_task_params_warns", () => {});
// Deprecated upstream API (`PipelineRunner`) is not ported; see docs/CONVENTIONS.md.
test.skip("test_pipeline_runner_warns", () => {});
// Deprecated upstream API (`EndTaskFrame`, `StopTaskFrame`, `CancelTaskFrame`,
// `InterruptionTaskFrame` aliases) is not ported; see docs/CONVENTIONS.md.
for (const name of ["EndTaskFrame", "StopTaskFrame", "CancelTaskFrame", "InterruptionTaskFrame"]) {
  test.skip(`test_task_frame_aliases_warn[${name}]`, () => {});
}

test("test_no_deprecation_warnings_at_import_time", () => {
  // Importing the modules with deprecated shims upstream must not emit a
  // pipecat deprecation warning. Done in a subprocess for a fresh import, and
  // filtered to pipecat's own deprecations (the canonical "... is deprecated
  // since X.Y.Z ..." message). `pipecat.pipeline.runner` only holds the
  // deprecated `PipelineRunner` alias, which is not ported.
  const src = new URL("../src/", import.meta.url).pathname;
  const script = `
    const { logger } = await import(${JSON.stringify(`${src}utils/logger.ts`)});
    const caught = [];
    logger.addSink((record) => caught.push(record.message));
    await import(${JSON.stringify(`${src}frames/frames.ts`)});
    await import(${JSON.stringify(`${src}pipeline/worker.ts`)});
    const bad = caught.filter((m) => m.includes(" is deprecated since "));
    if (bad.length > 0) {
      process.stderr.write("pipecat import-time deprecation warnings:\\n" + bad.join("\\n"));
      process.exit(1);
    }
  `;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

// --- Intercepted field reads (warn_deprecated) --------------------------------

// Deprecated upstream API (`StartFrame.enable_metrics` intercepted read) is not
// ported; see docs/CONVENTIONS.md.
test.skip("test_intercepted_read_warns_once_per_call_site", () => {});
test.skip("test_intercepted_read_warns_for_every_call_site", () => {});
test.skip("test_intercepted_read_reports_the_reading_line", () => {});
// Deprecated upstream API (`warn_deprecated_read`) is not ported; see docs/CONVENTIONS.md.
test.skip("test_deprecated_warn_deprecated_read_still_names_the_reading_line", () => {});
// Deprecated upstream API (`StartFrame.enable_metrics`) is not ported, and
// Python's `-W ignore::DeprecationWarning` filter has no counterpart.
test.skip("test_intercepted_read_warns_through_an_ignore_filter", () => {});

// --- Renamed dataclass fields (renamed_init_field) ----------------------------

// `renamed_init_field` (a constructor rewriter for deprecated renamed fields) is
// not ported; see packages/core/src/utils/deprecation.ts.
test.skip("test_renamed_field_reaches_a_constructor_that_passes_it_to_super", () => {});

// --- Removal history (removals.json) ------------------------------------------

// DIVERGENCE: Python build tooling (scripts/deprecations/generate_removals.py and the
// committed removals.json); not ported.
test.skip("test_removals_registry_schema_is_valid", () => {});
test.skip("test_compute_removals_detects_disappeared_symbol", () => {});
test.skip("test_compute_removals_no_change_when_nothing_removed", () => {});
test.skip("test_compute_removals_ignores_subject_recorded_by_member", () => {});
test.skip("test_compute_removals_is_idempotent", () => {});
test.skip("test_compute_removals_bootstrap_has_no_previous", () => {});
test.skip("test_compute_removals_records_actual_vs_announced_version", () => {});
