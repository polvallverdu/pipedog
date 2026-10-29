// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/transforms/voice_formatter.py

/**
 * Configurable voice formatting bundle for TTS preprocessing.
 *
 * Porting notes: upstream imports each transform lazily inside `__init__`;
 * here they are imported statically (they have no optional dependencies).
 */

import type { TextType } from "../../../frames/frames.ts";
import { normalizeAcronyms } from "./acronyms.ts";
import { expandCurrency } from "./currency.ts";
import { normalizeDates } from "./dates.ts";
import { emailToSpeech } from "./email.ts";
import { expandNumbers } from "./numbers.ts";
import { expandPercentages } from "./percentages.ts";
import { expandPhoneNumbers } from "./phone.ts";
import { replaceText, type TextReplacement } from "./replacements.ts";
import { StripMarkdown } from "./strip_markdown.ts";
import { expandUnits } from "./units.ts";

type Transform = (text: string, textType: string | TextType) => Promise<string>;

export interface VoiceFormatterOptions {
  /**
   * Strip Markdown formatting symbols (bold, italic, headers, code spans).
   * Enabled by default.
   */
  stripMarkdown?: boolean;
  /**
   * Reduce a Markdown link or image to its label or alt text so the URL is
   * not spoken. Enabled by default; only used when `stripMarkdown` is true.
   */
  stripUrls?: boolean;
  /** Space out phone number digits for individual pronunciation. Enabled by default. */
  expandPhoneNumbers?: boolean;
  /** Space out uppercase acronyms (e.g. `"API"` → `"A P I"`). Enabled by default. */
  normalizeAcronyms?: boolean;
  /**
   * Expand currency amounts to spoken form (e.g. `"$42.50"` →
   * `"forty two dollars and fifty cents"`). Requires `num2words`.
   */
  expandCurrency?: boolean;
  /**
   * Expand numeric digits to spoken words. Disabled by default since it can
   * affect numbers that are better read as digits. Requires `num2words`.
   */
  expandNumbers?: boolean;
  /**
   * Numbers above this value are read digit-by-digit instead of as a
   * quantity. Defaults to null (expand all numbers as words). Only used when
   * `expandNumbers` is true.
   */
  numberDigitCutoff?: number | bigint | null;
  /** Expand percentage expressions (e.g. `"50%"` → `"fifty percent"`). Requires `num2words`. */
  expandPercentages?: boolean;
  /** Expand unit abbreviations (e.g. `"5km"` → `"5 kilometers"`). Enabled by default. */
  expandUnits?: boolean;
  /** Transform email addresses to spoken form. Enabled by default. */
  emailToSpeech?: boolean;
  /** Expand date expressions to spoken form. Requires `num2words`. */
  normalizeDates?: boolean;
  /** List of `(regexPattern, replacement)` pairs applied after all other transforms. */
  customReplacements?: readonly TextReplacement[] | null;
}

// Python's `VoiceFormatter` is a callable object (`__call__`). The interface
// merges a call signature into the class, and the constructor returns a
// function carrying the class prototype, so an instance is both callable
// (usable in `textTransforms`) and `instanceof VoiceFormatter`.
export interface VoiceFormatter {
  // biome-ignore lint/style/useShorthandFunctionType: an interface is needed to merge with the class.
  (text: string, textType: string | TextType): Promise<string>;
}

/**
 * Configurable bundle that applies a pipeline of voice-formatting transforms.
 *
 * Each option enables or disables one transform. Transforms are applied in a
 * deliberate order: structural cleanup first, language expansions second, user
 * replacements last.
 *
 * @example
 * ```ts
 * const formatter = new VoiceFormatter({
 *   stripMarkdown: true,
 *   expandCurrency: true,
 *   numberDigitCutoff: 2025,
 *   customReplacements: [[/\bDr\./, "Doctor"]],
 * });
 * const tts = new CartesiaTTSService({
 *   textTransforms: [["*", formatter]],
 * });
 * ```
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: adds Python's `__call__` signature to the class.
export class VoiceFormatter {
  protected _transforms!: Transform[];

  /** Initialize the voice formatter. */
  constructor(options: VoiceFormatterOptions = {}) {
    const call = async (text: string, textType: string | TextType): Promise<string> =>
      self.transform(text, textType);
    const self = Object.setPrototypeOf(call, new.target.prototype) as VoiceFormatter;
    self._transforms = [];

    if (options.stripMarkdown ?? true) {
      self._transforms.push(new StripMarkdown({ stripUrls: options.stripUrls ?? true }));
    }

    // emailToSpeech must run before expandPhoneNumbers (phone regex matches
    // digit-only domains) and before normalizeAcronyms (all-caps local parts get
    // letter-spaced, breaking the email pattern).
    if (options.emailToSpeech ?? true) {
      self._transforms.push(emailToSpeech);
    }

    if (options.expandPhoneNumbers ?? true) {
      self._transforms.push(expandPhoneNumbers);
    }

    if (options.normalizeDates ?? true) {
      self._transforms.push(normalizeDates);
    }

    if (options.expandCurrency ?? true) {
      self._transforms.push(expandCurrency);
    }

    if (options.expandPercentages ?? true) {
      self._transforms.push(expandPercentages);
    }

    // expandUnits must run before normalizeAcronyms: uppercase unit abbreviations
    // like "MB" or "MPH" would be letter-spaced first and then not recognized.
    if (options.expandUnits ?? true) {
      self._transforms.push(expandUnits);
    }

    if (options.normalizeAcronyms ?? true) {
      self._transforms.push(normalizeAcronyms);
    }

    if (options.expandNumbers ?? false) {
      self._transforms.push(expandNumbers(options.numberDigitCutoff ?? null));
    }

    if (options.customReplacements && options.customReplacements.length > 0) {
      self._transforms.push(replaceText(options.customReplacements));
    }

    // biome-ignore lint/correctness/noConstructorReturn: returning the callable is the point (see above).
    return self;
  }

  /**
   * Apply all configured transforms in order.
   *
   * Python's `__call__`; calling the instance runs this.
   *
   * @param text Input text to transform.
   * @param textType Text type passed through to each transform.
   * @returns Transformed text ready for TTS synthesis.
   */
  async transform(text: string, textType: string | TextType): Promise<string> {
    for (const transform of this._transforms) {
      text = await transform(text, textType);
    }
    return text;
  }
}
