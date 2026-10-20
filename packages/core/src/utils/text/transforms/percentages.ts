// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/transforms/percentages.py

/** Expand percentage expressions into spoken form for TTS. */

import { asFloat, num2words } from "num2words-ts";
import type { TextType } from "../../../frames/frames.ts";

const PERCENT_RE = /(\d+(?:\.\d+)?)\s*%/g;

function percentToWords(value: string): string {
  // Upstream converts with `float(value)`, so "50" reads as the float 50.0.
  const numberStr = num2words(asFloat(Number.parseFloat(value)), { lang: "en" });
  return `${numberStr} percent`;
}

/**
 * Expand percentage expressions to their spoken form.
 *
 * @param text Input text possibly containing percentage expressions.
 * @param _textType Text type of the text frame (unused).
 * @returns Text with percentages replaced by spoken equivalents.
 *
 * @example
 * ```ts
 * const result = await expandPercentages("50% off today", "*");
 * // "fifty percent off today"
 * ```
 */
export async function expandPercentages(
  text: string,
  _textType: string | TextType,
): Promise<string> {
  return text.replace(PERCENT_RE, (_match, value: string) => percentToWords(value));
}
