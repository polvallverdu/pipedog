// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/expressive/policy.py

/**
 * The developer's policy for expressive conversation.
 *
 * Part of expressive conversation (alpha). An LLM is taught expression tags by
 * their universal names, those the active TTS service can perform. The policy says
 * which it is offered and when to use them.
 *
 * **Alpha.** The tag syntax and these types are likely to change between releases.
 */

import { ValidationError } from "../processors/frameworks/rtvi/models.ts";
import type { ExpressionDelivery, ExpressionSound } from "./expression.ts";

/**
 * Guidance presets for `ExpressionPolicy`.
 *
 * Each preset is a short paragraph on one aspect of delivery, written to
 * combine with other presets and with the developer's own lines. A preset
 * is a string, so it joins with them as written, but stays a member of this
 * enum in a policy, apart from a line of the developer's with the same text.
 * Presets are about writing tags, so an LLM taught none, such as one whose
 * replies a tagger marks up, isn't given them.
 *
 * - `MATCH_STYLE`: Answer in the user's mood and energy, but stay calm with
 *   hostility.
 * - `SLOW_FOR_DETAILS`: Say just what the user may need to write down slowly,
 *   in a span. For a service that performs the `slow` delivery.
 * - `BREATHE`: Take an audible breath before a long or difficult sentence now
 *   and then, at most once a reply. For a service that performs a breath. A
 *   tagger reads it as a switch for breaths of its own choosing.
 */
// DIVERGENCE: upstream's StrEnum members are `str`s that `isinstance` still
// tells apart from a developer's line with the same text. A string `as const`
// enum can't, so this is a class whose instances are the presets: compare with
// `value` (or `String(preset)`) where upstream compares as a string.
export class ExpressionGuidance {
  static readonly MATCH_STYLE = new ExpressionGuidance(
    "Let your voice match the user's mood and energy: be excited for their good news, " +
      "sympathetic with their bad news, and laugh when they say something funny. If they " +
      "are hostile, stay calm instead of matching it. Most sentences need no tag.",
  );

  static readonly SLOW_FOR_DETAILS = new ExpressionGuidance(
    "When you give the user something to write down, such as a code, a phone number or an " +
      "email address, say just that slowly: Your code is <<slow: A B 7 4 9>>. Anything else?",
  );

  static readonly BREATHE = new ExpressionGuidance(
    "Now and then, take an audible breath before a sentence that is long, carries hard news " +
      "or starts a careful explanation, as a person on the phone does. At most one breath a " +
      "reply, and most replies need none: rarely before a short or routine sentence, never by " +
      "habit at the start of every reply, and never right after another sound.",
  );

  /** The preset's text. */
  readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  /** Every preset, in declaration order. */
  static values(): ExpressionGuidance[] {
    return [
      ExpressionGuidance.MATCH_STYLE,
      ExpressionGuidance.SLOW_FOR_DETAILS,
      ExpressionGuidance.BREATHE,
    ];
  }

  /** The preset with this text; throws if there is none. */
  static fromValue(value: string): ExpressionGuidance {
    const preset = ExpressionGuidance.values().find((g) => g.value === value);
    if (!preset) {
      throw new Error(`'${value}' is not a valid ExpressionGuidance`);
    }
    return preset;
  }

  toString(): string {
    return this.value;
  }
}

export interface ExpressionPolicyOptions {
  /**
   * Lines on when and how much to express, such as
   * `ExpressionGuidance.MATCH_STYLE` or the developer's own. They are joined in
   * order, so a later line can refine an earlier one. The developer's lines
   * reach the LLM whenever it has a part to play in expressive conversation:
   * tags to write, or a reading of the user to act on. The presets are about
   * writing tags, so they go to whoever writes them: the LLM, or a tagger in
   * its place.
   */
  guidance?: (ExpressionGuidance | string)[];
  /**
   * The deliveries to offer, by their universal names (`ExpressionDelivery`),
   * or null for the core ones. A name that isn't universal, such as an accent,
   * is offered as written. Those the TTS service can't perform are left out,
   * with a warning.
   */
  delivery?: (ExpressionDelivery | string)[] | null;
  /**
   * The sounds to offer, as `delivery` offers deliveries (`ExpressionSound`).
   * Null offers the core ones, and a breath only with `ExpressionGuidance.BREATHE`.
   */
  sounds?: (ExpressionSound | string)[] | null;
}

/** Which expression tags an LLM is offered, and when to use them. */
export class ExpressionPolicy {
  /** Lines on when and how much to express. */
  guidance: (ExpressionGuidance | string)[];
  /** The deliveries to offer, or null for the core ones. */
  delivery: (ExpressionDelivery | string)[] | null;
  /** The sounds to offer, or null for the core ones. */
  sounds: (ExpressionSound | string)[] | null;

  constructor(options: ExpressionPolicyOptions = {}) {
    // Validated as pydantic does: a bare string would otherwise be offered letter by letter.
    for (const field of ["guidance", "delivery", "sounds"] as const) {
      const value: unknown = options[field];
      if (
        value !== undefined &&
        (field === "guidance" || value !== null) &&
        !Array.isArray(value)
      ) {
        throw new ValidationError("ExpressionPolicy", [
          { loc: [field], msg: "Input should be a valid list" },
        ]);
      }
    }
    this.guidance = options.guidance ?? [];
    this.delivery = options.delivery ?? null;
    this.sounds = options.sounds ?? null;
  }
}
