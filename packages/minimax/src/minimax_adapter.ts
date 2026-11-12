// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/tts/services/minimax_adapter.py

/** MiniMax expression adapter for Pipecat. */

import { BaseExpressionAdapter } from "@pipedog/core/adapters/tts/base_expression_adapter";
import {
  DeliveryScope,
  ExpressionCapabilities,
  ExpressionDelivery,
  ExpressionSound,
  ExpressionTerm,
  FAST_DELIVERY,
  SLOW_DELIVERY,
  SPEED_DELIVERY,
} from "@pipedog/core/expressive/expression";

/** The speed each speed delivery asks for. */
export const MINIMAX_SPEEDS: Readonly<Record<string, number>> = {
  [SLOW_DELIVERY]: 0.75,
  [FAST_DELIVERY]: 1.25,
};

/**
 * Performs expression tags with MiniMax speech-2.8 models.
 *
 * Part of expressive conversation (alpha). Its deliveries are MiniMax's emotions and
 * speeds, sent with each request, so a delivery can change only between
 * sentences, and a sentence written in several emotions is spoken in the
 * first. Sounds are its
 * interjections, such as `(laughs)`, and pauses are `<#s#>` markers. Its
 * vocabulary is fixed: an interjection outside it is read aloud.
 */
export class MiniMaxExpressionAdapter extends BaseExpressionAdapter {
  /** MiniMax's emotions, interjections and pauses. */
  override capabilities(): ExpressionCapabilities {
    return new ExpressionCapabilities({
      sounds: (
        "laughs chuckle coughs clear-throat groans breath pant inhale exhale gasps " +
        "sniffs sighs snorts burps lip-smacking humming hissing emm sneezes"
      )
        .split(/\s+/)
        .filter((name) => name.length > 0)
        .map((name) => new ExpressionTerm({ name })),
      delivery: [
        ...["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm"].map(
          (name) => new ExpressionTerm({ name }),
        ),
        ...SPEED_DELIVERY,
      ],
      pauseRangeMs: [10, 99990],
      deliveryScope: DeliveryScope.SENTENCE,
      serviceVocabulary: {
        [ExpressionDelivery.WARM]: ["happy"],
        [ExpressionDelivery.EXCITED]: ["happy"],
        [ExpressionSound.LAUGH]: ["laughs"],
        [ExpressionSound.SIGH]: ["sighs"],
        [ExpressionSound.BREATH]: ["breath", "inhale"],
        [ExpressionSound.LIGHT_BREATH]: ["breath"],
        [ExpressionSound.DEEP_BREATH]: ["inhale"],
        [ExpressionSound.COUGH]: ["coughs"],
        [ExpressionSound.CLEAR_THROAT]: ["clear-throat"],
        [ExpressionSound.GROAN]: ["groans"],
        [ExpressionSound.GASP]: ["gasps"],
        [ExpressionSound.SNIFF]: ["sniffs"],
        [ExpressionSound.SNORT]: ["snorts"],
        [ExpressionSound.BURP]: ["burps"],
        [ExpressionSound.LIP_SMACK]: ["lip-smacking"],
        [ExpressionSound.HUM]: ["humming"],
        [ExpressionSound.HISS]: ["hissing"],
        [ExpressionSound.UM]: ["emm"],
        [ExpressionSound.SNEEZE]: ["sneezes"],
      },
    });
  }

  /** The emotion and speed a request in this delivery asks for, merged into its `voice_setting`. */
  override requestSettings(delivery: string[]): Record<string, unknown> {
    const settings: Record<string, unknown> = {};
    const emotion = delivery.find((name) => !Object.hasOwn(MINIMAX_SPEEDS, name));
    if (emotion !== undefined) {
      settings.emotion = emotion;
    }
    const speedName = delivery.find((name) => Object.hasOwn(MINIMAX_SPEEDS, name));
    if (speedName !== undefined) {
      settings.speed = MINIMAX_SPEEDS[speedName];
    }
    return settings;
  }

  /** Format an interjection. */
  override formatSound(name: string): string {
    return `(${name})`;
  }

  /** Format a pause marker. */
  override formatPause(durationMs: number): string {
    return `<#${_formatG(durationMs / 1000)}#>`;
  }
}

/** Python's `format(x, "g")`: 6 significant digits, trailing zeros stripped. */
function _formatG(x: number): string {
  if (!Number.isFinite(x)) {
    return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  }
  if (x === 0) {
    return Object.is(x, -0) ? "-0" : "0";
  }
  const [mantissa, expPart] = x.toExponential(5).split("e");
  const exp = Number(expPart);
  if (exp < -4 || exp >= 6) {
    const m = (mantissa as string).replace(/\.?0+$/, "");
    const sign = exp < 0 ? "-" : "+";
    return `${m}e${sign}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  const fixed = x.toFixed(Math.max(0, 5 - exp));
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}
