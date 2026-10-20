// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/transforms/__init__.py

/**
 * Built-in text transformers for TTS voice formatting.
 *
 * Transformers are async callables with signature:
 *
 * ```ts
 * async function transform(text: string, textType: string): Promise<string>
 * ```
 *
 * They are registered with a TTS service via `textTransforms`:
 *
 * ```ts
 * const tts = new CartesiaTTSService({
 *   textTransforms: [["*", stripMarkdown], ["*", expandCurrency]],
 * });
 * ```
 *
 * Or use `VoiceFormatter` for a single configurable bundle:
 *
 * ```ts
 * const tts = new CartesiaTTSService({
 *   textTransforms: [["*", new VoiceFormatter({ expandCurrency: true })]],
 * });
 * ```
 */

export { normalizeAcronyms } from "./acronyms.ts";
export { expandCurrency } from "./currency.ts";
export { normalizeDates } from "./dates.ts";
export { emailToSpeech } from "./email.ts";
export { expandNumbers } from "./numbers.ts";
export { expandPercentages } from "./percentages.ts";
export { expandPhoneNumbers } from "./phone.ts";
export { replaceText } from "./replacements.ts";
export { stripMarkdown } from "./strip_markdown.ts";
export { expandUnits } from "./units.ts";
export { VoiceFormatter } from "./voice_formatter.ts";
