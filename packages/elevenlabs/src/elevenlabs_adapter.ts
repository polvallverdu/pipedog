// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/tts/services/elevenlabs_adapter.py

/** ElevenLabs expression adapter for Pipecat. */

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

// The audio tag each speed delivery is written as.
const _SPEED_TAGS: Readonly<Record<string, string>> = {
  [SLOW_DELIVERY]: "slowly",
  [FAST_DELIVERY]: "quickly",
};

function term(name: string, description?: string): ExpressionTerm {
  return new ExpressionTerm({ name, description });
}

// The audio tags in ElevenLabs' prompting guide for Eleven v3 and v4, and a
// short breath, a light one beside the guide's deep one, sorted into sounds made
// at one point and deliveries that last. Their guide doesn't draw that line.
// Multi-word deliveries, such as accents, aren't listed; written in a tag,
// they're passed on as free text.
const _AUDIO_TAG_SOUNDS: ExpressionTerm[] = [
  term("laughs"),
  term("laughs harder"),
  term("starts laughing"),
  term("laughing"),
  term("wheezing", "a wheezing laugh"),
  term("giggles"),
  term("giggling"),
  term("chuckles"),
  term("snorts"),
  term("sighs"),
  term("sighing"),
  term("exhales"),
  term("exhales sharply"),
  term("inhales deeply"),
  term("short breath"),
  term("clears throat"),
  term("gulps"),
  term("swallows"),
  term("woo", "an excited whoop"),
  term("applause", "sound effect"),
  term("clapping", "sound effect"),
  term("gunshot", "sound effect"),
  term("explosion", "sound effect"),
  term("fart", "sound effect"),
];

const _AUDIO_TAG_DELIVERY: ExpressionTerm[] = [
  term("happy"),
  term("excited"),
  term("delighted"),
  term("amazed"),
  term("impressed"),
  term("surprised"),
  term("curious"),
  term("questioning"),
  term("thoughtful"),
  term("warmly"),
  term("sympathetic"),
  term("reassuring"),
  term("professional"),
  term("cautiously"),
  term("nervously"),
  term("sheepishly"),
  term("sad"),
  term("crying", "speaking while crying"),
  term("desperately"),
  term("panicking"),
  term("frustrated"),
  term("annoyed"),
  term("angry"),
  term("appalled"),
  term("dismissive"),
  term("sarcastic"),
  term("deadpan"),
  term("mischievously"),
  term("dramatically"),
  term("cute"),
  term("whispers", "speaking in a whisper"),
  term("muttering", "speaking under one's breath"),
  term("singing"),
];

/**
 * Formats expression tags as Eleven v3 and v4 audio tags.
 *
 * Part of expressive conversation (alpha). Delivery and sounds are both audio
 * tags, such as `[excited]` or `[laughs]`, written in free text: the terms
 * listed are the ones in ElevenLabs' prompting guide, and others described in
 * a few words work too. Emphasis is written in capitals. A delivery tag is
 * written where the delivery changes; Eleven v3 and v4 have no tag for the
 * voice's baseline, so a return to it writes none. Slow and fast are written
 * as `[slowly]` and `[quickly]`. They don't support `<break>`, so a pause is
 * written as a short or long pause cue, which is approximate.
 */
export class ElevenLabsAudioTagExpressionAdapter extends BaseExpressionAdapter {
  /** Free-text audio tags, emphasis and approximate pauses. */
  override capabilities(): ExpressionCapabilities {
    return new ExpressionCapabilities({
      sounds: [..._AUDIO_TAG_SOUNDS],
      delivery: [..._AUDIO_TAG_DELIVERY, ...SPEED_DELIVERY],
      allowsFreeText: true,
      pauseRangeMs: [100, 3000],
      emphasis: true,
      serviceVocabulary: {
        [ExpressionDelivery.CALM]: ["calm", "reassuring"],
        [ExpressionDelivery.APOLOGETIC]: ["apologetic", "sheepishly"],
        [ExpressionDelivery.WARM]: ["warmly"],
        [ExpressionDelivery.EXCITED]: ["excited", "delighted"],
        [ExpressionDelivery.GRATEFUL]: ["grateful", "warmly"],
        [ExpressionDelivery.CONFIDENT]: ["confident", "professional"],
        [ExpressionSound.LAUGH]: ["laughs", "laughing"],
        [ExpressionSound.CHUCKLE]: ["chuckles"],
        [ExpressionSound.SIGH]: ["sighs", "sighing"],
        [ExpressionSound.BREATH]: ["quick breath"],
        // A policy that leaves out a kind's own name gets its next best.
        [ExpressionSound.LIGHT_BREATH]: ["quick breath", "short breath"],
        [ExpressionSound.DEEP_BREATH]: ["deep breath", "inhales deeply"],
        [ExpressionSound.EXHALE]: ["exhales softly", "exhales"],
        [ExpressionDelivery.CAUTIOUS]: ["cautiously"],
        [ExpressionDelivery.NERVOUS]: ["nervously"],
        [ExpressionDelivery.SHEEPISH]: ["sheepishly"],
        [ExpressionDelivery.DESPERATE]: ["desperately"],
        [ExpressionDelivery.PANICKED]: ["panicking"],
        [ExpressionDelivery.MISCHIEVOUS]: ["mischievously"],
        [ExpressionDelivery.DRAMATIC]: ["dramatically"],
        [ExpressionDelivery.WHISPERING]: ["whispers"],
        [ExpressionSound.LAUGH_HARDER]: ["laughs harder"],
        [ExpressionSound.START_LAUGHING]: ["starts laughing"],
        [ExpressionSound.WHEEZE]: ["wheezing"],
        [ExpressionSound.GIGGLE]: ["giggles", "giggling"],
        [ExpressionSound.SNORT]: ["snorts"],
        [ExpressionSound.SHARP_EXHALE]: ["exhales sharply"],
        [ExpressionSound.CLEAR_THROAT]: ["clears throat"],
        [ExpressionSound.GULP]: ["gulps"],
        [ExpressionSound.SWALLOW]: ["swallows"],
      },
    });
  }

  /** Prefix audio tags where the delivery changes, and capitalize emphasis. */
  override formatText(text: string, delivery: string[], previousDelivery: string[] | null): string {
    if (delivery.includes(EMPHASIS_DELIVERY)) {
      text = text.toUpperCase();
    }
    const tags = deliveryTags(delivery, _SPEED_TAGS);
    const previous = deliveryTags(previousDelivery, _SPEED_TAGS);
    const changed = tags.length !== previous.length || tags.some((tag, i) => tag !== previous[i]);
    if (tags.length > 0 && changed) {
      text = `${tags.map((tag) => `[${tag}]`).join(" ")} ${text}`;
    }
    return text;
  }

  /** Format an audio tag, set apart so its alignment times it as a word of its own. */
  override formatSound(name: string): string {
    return ` [${name}] `;
  }

  /** Format a short pause under a second, otherwise a long one, set apart like a sound. */
  override formatPause(durationMs: number): string {
    return durationMs < 1000 ? " [short pause] " : " [long pause] ";
  }
}
