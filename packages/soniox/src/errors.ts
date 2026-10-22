// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/soniox/errors.py

/** Classification of the errors Soniox reports in-stream. */

import { classifyHttpStatusCode, type ErrorCategory } from "@pipedog/core/utils/errors";

/**
 * Classify the `error_code` of a Soniox error message.
 *
 * Soniox's STT and TTS websockets report an error as a message carrying an
 * HTTP status code: 402 when the account is out of credit, 401 for a
 * rejected key, and so on. Returns null when the code is missing or not a
 * number, which the error frame reports as unknown.
 *
 * @param errorCode The `error_code` field of the message.
 * @returns The matching category, or null when there is nothing to classify.
 */
export function classifyErrorCode(errorCode: unknown): ErrorCategory | null {
  // Python's `isinstance(x, int)` excludes bool; JS has no int type, so integral numbers.
  if (typeof errorCode === "number" && Number.isInteger(errorCode)) {
    return classifyHttpStatusCode(errorCode);
  }
  return null;
}
