// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_evals_harness_shim.py

import { describe, test } from "bun:test";

// `pipecat.evals.harness` is a deprecated alias module (deprecated since 1.9.0,
// removed in 2.0.0) and is not ported: its exports live in `session.ts` and
// `script_session.ts`. This test only checks the alias, so it is skipped.
describe("TestHarnessShim", () => {
  test.skip("test_every_former_export_resolves_to_its_new_home", () => {});
});
