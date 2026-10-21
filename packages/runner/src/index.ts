// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/runner/__init__.py

/**
 * Pipecat runner package for local and cloud bot execution.
 *
 * The root re-exports the runner arguments (`./types`) and `createTransport`
 * with the telephony helpers (`./utils`). The development server is
 * `@pipedog/runner/run` (`main`, `createRunnerApp`) and `@pipedog/runner/serve`,
 * as upstream's is `pipecat.runner.run`. The Daily, LiveKit, MOQ and Vonage
 * helper modules are not ported (their transports aren't).
 */

export * from "./types.ts";
export * from "./utils.ts";
