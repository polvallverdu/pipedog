// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/tts/services/fish_adapter.py

/** Fish Audio expression adapter for Pipecat. */

import {
  BaseExpressionAdapter,
  deliveryTags,
} from "@pipedog/core/adapters/tts/base_expression_adapter";
import {
  EMPHASIS_DELIVERY,
  ExpressionCapabilities,
  ExpressionDelivery,
  ExpressionSound,
  ExpressionTerm,
  FAST_DELIVERY,
  SLOW_DELIVERY,
  SPEED_DELIVERY,
} from "@pipedog/core/expressive/expression";

/** The tag each speed delivery is written as. */
const _SPEED_TAGS: Readonly<Record<string, string>> = {
  [SLOW_DELIVERY]: "speaking slowly",
  [FAST_DELIVERY]: "speaking quickly",
};
/**
 * The tag that sets the pace back. A pace a tag sets lasts past the input it
 * is sent in, until another tag changes it.
 */
const _NORMAL_PACE_TAG = "[normal pace]";

// The tags in Fish Audio's S2 emotion reference, sorted into sounds made at one
// point and deliveries that last. Multi-word deliveries, such as "soft tone",
// aren't listed; written in a tag, they're passed on as free text.
const _S2_SOUNDS: readonly ExpressionTerm[] = [
  new ExpressionTerm({ name: "laughing" }),
  new ExpressionTerm({ name: "chuckling" }),
  new ExpressionTerm({ name: "sobbing" }),
  new ExpressionTerm({ name: "crying loudly" }),
  new ExpressionTerm({ name: "sighing" }),
  new ExpressionTerm({ name: "groaning" }),
  new ExpressionTerm({ name: "panting" }),
  new ExpressionTerm({ name: "gasping" }),
  new ExpressionTerm({ name: "yawning" }),
  new ExpressionTerm({ name: "snoring" }),
  new ExpressionTerm({ name: "clear throat" }),
  new ExpressionTerm({ name: "audience laughing", description: "sound effect" }),
  new ExpressionTerm({ name: "background laughter", description: "sound effect" }),
  new ExpressionTerm({ name: "crowd laughing", description: "sound effect" }),
];

const _S2_DELIVERY: readonly ExpressionTerm[] = (
  "happy sad angry excited calm nervous confident surprised satisfied delighted " +
  "scared worried upset frustrated depressed empathetic embarrassed disgusted moved " +
  "proud relaxed grateful curious sarcastic disdainful unhappy anxious hysterical " +
  "indifferent uncertain doubtful confused disappointed regretful guilty ashamed " +
  "jealous envious hopeful optimistic pessimistic nostalgic lonely bored contemptuous " +
  "sympathetic compassionate determined resigned shouting screaming whispering"
)
  .split(/\s+/)
  .filter((name) => name.length > 0)
  .map((name) => new ExpressionTerm({ name }));

/**
 * Formats expression tags as Fish Audio S2 bracket tags.
 *
 * Part of expressive conversation (alpha). Delivery and sounds are both tags,
 * such as `[excited]` or `[laughing]`, written in free text: the terms
 * listed are Fish Audio's S2 emotion reference, and others described in a
 * few words work too. A tag applies within the input it is sent in, so each
 * sentence states its delivery from its start. There is no tag for the voice's
 * baseline, so a return to it writes none. Slow and fast are written as
 * `[speaking slowly]` and `[speaking quickly]`, and since a pace lasts
 * until another tag changes it, a `[normal pace]` tag ends them, within a
 * sentence or at the end of one. Emphasis is an `[emphasis]` tag
 * before the stressed words, and a pause is a break or a long break, which
 * is approximate.
 */
export class FishAudioS2ExpressionAdapter extends BaseExpressionAdapter {
  /** Free-text tags, emphasis and approximate pauses. */
  override capabilities(): ExpressionCapabilities {
    return new ExpressionCapabilities({
      sounds: [..._S2_SOUNDS],
      delivery: [..._S2_DELIVERY, ...SPEED_DELIVERY],
      allowsFreeText: true,
      pauseRangeMs: [100, 1500],
      emphasis: true,
      serviceVocabulary: {
        [ExpressionDelivery.CALM]: ["calm", "relaxed"],
        [ExpressionDelivery.SYMPATHETIC]: ["sympathetic", "empathetic", "compassionate"],
        [ExpressionDelivery.APOLOGETIC]: ["regretful"],
        [ExpressionDelivery.WARM]: ["happy", "relaxed"],
        [ExpressionDelivery.EXCITED]: ["excited", "delighted"],
        [ExpressionSound.LAUGH]: ["laughing"],
        [ExpressionSound.CHUCKLE]: ["chuckling"],
        [ExpressionSound.SIGH]: ["sighing"],
        [ExpressionSound.BREATH]: ["inhaling"],
        [ExpressionSound.LIGHT_BREATH]: ["inhaling"],
        [ExpressionSound.EXHALE]: ["exhaling"],
        [ExpressionSound.SOB]: ["sobbing", "crying loudly"],
        [ExpressionSound.GROAN]: ["groaning"],
        [ExpressionSound.PANT]: ["panting"],
        [ExpressionSound.GASP]: ["gasping"],
        [ExpressionSound.YAWN]: ["yawning"],
        [ExpressionSound.SNORE]: ["snoring"],
      },
    });
  }

  /** Prefix tags where the delivery changes, and emphasis before stressed words. */
  override formatText(text: string, delivery: string[], previousDelivery: string[] | null): string {
    const tags = deliveryTags(delivery, _SPEED_TAGS);
    const previous = deliveryTags(previousDelivery, _SPEED_TAGS);
    let prefix =
      tags.length > 0 && !_sameTags(tags, previous) ? tags.map((tag) => `[${tag}]`).join("") : "";
    if (_hasSpeed(previousDelivery ?? []) && !_hasSpeed(delivery)) {
      prefix = _NORMAL_PACE_TAG + prefix;
    }
    if (delivery.includes(EMPHASIS_DELIVERY)) {
      prefix += "[emphasis]";
    }
    return prefix ? `${prefix} ${text}` : text;
  }

  /** Set the pace back after a request that ends in a speed delivery. */
  override formatEnd(delivery: string[]): string {
    return _hasSpeed(delivery) ? ` ${_NORMAL_PACE_TAG}` : "";
  }

  /** Format a tag. */
  override formatSound(name: string): string {
    return `[${name}]`;
  }

  /** Format a break under a second, otherwise a long break. */
  override formatPause(durationMs: number): string {
    return durationMs < 1000 ? "[break]" : "[long-break]";
  }
}

function _hasSpeed(delivery: readonly string[]): boolean {
  return delivery.some((name) => Object.hasOwn(_SPEED_TAGS, name));
}

/** Python list equality (`tags != previous`). */
function _sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}
