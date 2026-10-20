// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/transforms/phone.py

/** Expand phone numbers into space-separated digit sequences for TTS. */

import type { TextType } from "../../../frames/frames.ts";

// Matches common phone formats: (123) 456-7890, 123-456-7890, 123.456.7890,
// +1 800 555 1234, etc.
const PHONE_RE = new RegExp(
  "(?<!\\d)" + // not preceded by a digit (no partial match inside a longer number)
    "(\\+?1[\\s.\\-]?)?" + // optional country code
    "(\\(?\\d{3}\\)?[\\s.\\-]?)" + // area code
    "(\\d{3}[\\s.\\-]?)" + // exchange
    "(\\d{4})" + // subscriber
    "(?!\\d)", // not followed by a digit
  "g",
);

function spaceDigits(match: string): string {
  const digits = match.replace(/\D/g, "");
  return [...digits].join(" ");
}

/**
 * Space out phone number digits so TTS reads them individually.
 *
 * This transformer is alphanumeric-preserving: digits are kept, only separators
 * change to spaces, so the `WordCompletionTracker` requires no segment-map
 * overhead.
 *
 * @param text Input text possibly containing phone numbers.
 * @param _textType Text type of the text frame (unused).
 * @returns Text with phone numbers replaced by space-separated digit sequences.
 *
 * @example
 * ```ts
 * const result = await expandPhoneNumbers("Call 123-456-7890 now", "*");
 * // "Call 1 2 3 4 5 6 7 8 9 0 now"
 * ```
 */
export async function expandPhoneNumbers(
  text: string,
  _textType: string | TextType,
): Promise<string> {
  return text.replace(PHONE_RE, (match) => spaceDigits(match));
}
