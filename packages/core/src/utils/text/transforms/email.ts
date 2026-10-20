// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/transforms/email.py

/** Transform email addresses into spoken form for TTS. */

import type { TextType } from "../../../frames/frames.ts";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function emailToSpoken(email: string): string {
  const at = email.indexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const localSpoken = local
    .replaceAll(".", " dot ")
    .replaceAll("_", " underscore ")
    .replaceAll("-", " dash ")
    .replaceAll("+", " plus ");
  const domainSpoken = domain.replaceAll(".", " dot ").replaceAll("-", " dash ");
  return `${localSpoken} at ${domainSpoken}`;
}

/**
 * Transform email addresses into their spoken form.
 *
 * @param text Input text possibly containing email addresses.
 * @param _textType Text type of the text frame (unused).
 * @returns Text with email addresses replaced by spoken equivalents.
 *
 * @example
 * ```ts
 * const result = await emailToSpeech("Contact user@example.com today", "*");
 * // "Contact user at example dot com today"
 * ```
 */
export async function emailToSpeech(text: string, _textType: string | TextType): Promise<string> {
  return text.replace(EMAIL_RE, (match) => emailToSpoken(match));
}
