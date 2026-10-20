// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_resampy_resampler.py

/** Tests for the deprecated resampy resampler. */

import { test } from "bun:test";

// Skipped: `ResampyResampler` is deprecated upstream (since 1.2.0, removed in
// 2.0.0) and is not ported (see docs/CONVENTIONS.md, "Deprecated upstream APIs
// are not ported"). This test only checks that instantiating it emits a
// DeprecationWarning, so there is nothing to exercise.
test.skip("test_resampy_resampler_emits_deprecation_warning", () => {});
