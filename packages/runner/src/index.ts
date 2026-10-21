// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/runner/__init__.py

/**
 * Pipecat runner package for local and cloud bot execution.
 *
 * PARTIAL PORT: only the telephony helpers are ported so far
 * (`parseTelephonyWebsocket` and the `CallData` types). The development
 * runner itself (`run.py`) and the Daily, LiveKit, MOQ and Vonage helpers are
 * not.
 */

export * from "./types.ts";
export * from "./utils.ts";
