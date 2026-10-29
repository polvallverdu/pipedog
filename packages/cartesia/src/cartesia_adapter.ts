// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/tts/services/cartesia_adapter.py

/** Cartesia expression adapter for Pipecat. */

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

/**
 * The speed each speed delivery asks for. Cartesia takes speed as guidance, so the
 * steps are large.
 */
export const CARTESIA_SPEEDS: Readonly<Record<string, number>> = {
  [SLOW_DELIVERY]: 0.7,
  [FAST_DELIVERY]: 1.3,
};

/** Predefined Emotions supported by Cartesia. */
export const CartesiaEmotion = {
  // Primary emotions supported by Cartesia
  NEUTRAL: "neutral",
  ANGRY: "angry",
  EXCITED: "excited",
  CONTENT: "content",
  SAD: "sad",
  SCARED: "scared",
  // Additional emotions supported by Cartesia
  HAPPY: "happy",
  ENTHUSIASTIC: "enthusiastic",
  ELATED: "elated",
  EUPHORIC: "euphoric",
  TRIUMPHANT: "triumphant",
  AMAZED: "amazed",
  SURPRISED: "surprised",
  FLIRTATIOUS: "flirtatious",
  JOKING_COMEDIC: "joking/comedic",
  CURIOUS: "curious",
  PEACEFUL: "peaceful",
  SERENE: "serene",
  CALM: "calm",
  GRATEFUL: "grateful",
  AFFECTIONATE: "affectionate",
  TRUST: "trust",
  SYMPATHETIC: "sympathetic",
  ANTICIPATION: "anticipation",
  MYSTERIOUS: "mysterious",
  MAD: "mad",
  OUTRAGED: "outraged",
  FRUSTRATED: "frustrated",
  AGITATED: "agitated",
  THREATENED: "threatened",
  DISGUSTED: "disgusted",
  CONTEMPT: "contempt",
  ENVIOUS: "envious",
  SARCASTIC: "sarcastic",
  IRONIC: "ironic",
  DEJECTED: "dejected",
  MELANCHOLIC: "melancholic",
  DISAPPOINTED: "disappointed",
  HURT: "hurt",
  GUILTY: "guilty",
  BORED: "bored",
  TIRED: "tired",
  REJECTED: "rejected",
  NOSTALGIC: "nostalgic",
  WISTFUL: "wistful",
  APOLOGETIC: "apologetic",
  HESITANT: "hesitant",
  INSECURE: "insecure",
  CONFUSED: "confused",
  RESIGNED: "resigned",
  ANXIOUS: "anxious",
  PANICKED: "panicked",
  ALARMED: "alarmed",
  PROUD: "proud",
  CONFIDENT: "confident",
  DISTANT: "distant",
  SKEPTICAL: "skeptical",
  CONTEMPLATIVE: "contemplative",
  DETERMINED: "determined",
} as const;
export type CartesiaEmotion = (typeof CartesiaEmotion)[keyof typeof CartesiaEmotion];

/**
 * Formats expression tags as Cartesia's inline markup.
 *
 * Part of expressive conversation (alpha). Its deliveries are Cartesia's emotions,
 * formatted as `<emotion>` tags; Cartesia supports them in English only.
 * Cartesia changes emotion reliably only between generations, so a delivery can
 * change only between sentences, and a sentence written in several emotions
 * is spoken in the first. Slow and fast set each request's speed (see
 * `CARTESIA_SPEEDS`). The one sound is `[laughter]`, and pauses are
 * `<break>` tags. Cartesia has no emphasis.
 */
export class CartesiaExpressionAdapter extends BaseExpressionAdapter {
  /** Cartesia's emotions, laughter and pauses. */
  override capabilities(): ExpressionCapabilities {
    return new ExpressionCapabilities({
      sounds: [new ExpressionTerm({ name: "laughter" })],
      delivery: [
        ...Object.values(CartesiaEmotion)
          .filter(
            (emotion) =>
              emotion !== CartesiaEmotion.NEUTRAL && emotion !== CartesiaEmotion.JOKING_COMEDIC,
          )
          .map((emotion) => new ExpressionTerm({ name: emotion })),
        ...SPEED_DELIVERY,
      ],
      pauseRangeMs: [100, 5000],
      deliveryScope: DeliveryScope.SENTENCE,
      serviceVocabulary: {
        [ExpressionDelivery.CALM]: ["calm", "peaceful", "serene"],
        [ExpressionDelivery.WARM]: ["content", "happy"],
        [ExpressionDelivery.EXCITED]: ["excited", "enthusiastic"],
        [ExpressionDelivery.SAD]: ["sad", "disappointed"],
        [ExpressionSound.LAUGH]: ["laughter"],
        [ExpressionSound.CHUCKLE]: ["laughter"],
        [ExpressionDelivery.TRUSTING]: ["trust"],
        [ExpressionDelivery.ANTICIPATING]: ["anticipation"],
        [ExpressionDelivery.CONTEMPTUOUS]: ["contempt"],
      },
    });
  }

  /** Prefix an emotion tag, set apart from the words, where the emotion changes. */
  override formatText(text: string, delivery: string[], previousDelivery: string[] | null): string {
    const emotion = _emotion(delivery);
    const previous = _emotion(previousDelivery ?? []);
    if (emotion === previous) {
      return text;
    }
    return `<emotion value="${emotion ?? CartesiaEmotion.NEUTRAL}"/> ${text}`;
  }

  /** The speed a request in this delivery asks for, merged into its `generation_config`. */
  override requestSettings(delivery: string[]): Record<string, unknown> {
    const name = delivery.find((n) => Object.hasOwn(CARTESIA_SPEEDS, n));
    const speed = name !== undefined ? CARTESIA_SPEEDS[name] : null;
    return speed != null ? { speed } : {};
  }

  /** Format laughter, set apart so Cartesia times it as a word of its own. */
  override formatSound(name: string): string {
    return ` [${name}] `;
  }

  /** Format a break, set apart from the words. */
  override formatPause(durationMs: number): string {
    return ` <break time="${durationMs}ms"/> `;
  }
}

/** The first name in the delivery that is an emotion, not a speed. */
function _emotion(delivery: string[]): string | null {
  return delivery.find((name) => !Object.hasOwn(CARTESIA_SPEEDS, name)) ?? null;
}
