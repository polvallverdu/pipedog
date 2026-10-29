// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/expressive/expression.py

/**
 * Expression capabilities: what a TTS service can perform.
 *
 * Part of expressive conversation, which lets an agent hear how something was
 * said and answer in kind. An LLM writes expression into its reply as inline
 * tags: `[[name]]` for a sound or silence at one point, `<<name>>` for the
 * delivery of the words after it, `<<name: words>>` for the delivery of just
 * those words, and `^^word^^` to stress a word. A delivery lasts until the next
 * delivery tag or the end of the response, and `<<neutral>>` returns to the
 * voice's baseline.
 *
 * For example:
 *
 * ```
 * <<warm>> It's [[laugh]] ^^back^^ up. [[pause 300]] Your code is <<slow: A B 7>>.
 * ```
 *
 * A TTS service declares which of these it can perform with
 * `ExpressionCapabilities`, and broadcasts them at start in a
 * `TTSMetadataFrame`, so the LLM can be told which tags to write.
 *
 * Pipecat names every delivery and sound the services perform the same way on
 * each, the universal names: `ExpressionDelivery` and `ExpressionSound`. A
 * universal name in a tag, such as `<<warm>>` or `[[laugh]]`, is sent to each
 * service by its own name for it, such as ElevenLabs' `warmly` or Cartesia's
 * `laughter`, while everything Pipecat reports keeps the name as written.
 *
 * **Alpha.** The tag syntax and these types are likely to change between releases.
 */

/**
 * The delivery that returns to the voice's baseline. Part of the protocol, so it is
 * a delivery whatever a service declares.
 */
export const NEUTRAL_DELIVERY = "neutral";

/** The delivery of stressed words, written ^^words^^. */
export const EMPHASIS_DELIVERY = "emphasis";

// The deliveries that slow the words down and speed them up. Part of the protocol,
// so every service that performs speed names them the same.
export const SLOW_DELIVERY = "slow";
export const FAST_DELIVERY = "fast";

/**
 * A delivery by its universal name, the same on every TTS service.
 *
 * With `ExpressionSound`, these name everything the services with an
 * expression adapter perform, each in one spelling, an adjective for a
 * delivery. A tag that names one is sent by each service's own name for it
 * (`ExpressionCapabilities.serviceVocabulary`), and reported as written. A
 * member is a string, so `ExpressionDelivery.WARM` is `"warm"`.
 */
export const ExpressionDelivery = {
  AFFECTIONATE: "affectionate",
  AGITATED: "agitated",
  ALARMED: "alarmed",
  AMAZED: "amazed",
  ANGRY: "angry",
  ANNOYED: "annoyed",
  ANTICIPATING: "anticipating",
  ANXIOUS: "anxious",
  APOLOGETIC: "apologetic",
  APPALLED: "appalled",
  ASHAMED: "ashamed",
  BORED: "bored",
  CALM: "calm",
  CAUTIOUS: "cautious",
  COMPASSIONATE: "compassionate",
  CONFIDENT: "confident",
  CONFUSED: "confused",
  CONTEMPLATIVE: "contemplative",
  CONTEMPTUOUS: "contemptuous",
  CONTENT: "content",
  CRYING: "crying",
  CURIOUS: "curious",
  CUTE: "cute",
  DEADPAN: "deadpan",
  DEJECTED: "dejected",
  DELIGHTED: "delighted",
  DEPRESSED: "depressed",
  DESPERATE: "desperate",
  DETERMINED: "determined",
  DISAPPOINTED: "disappointed",
  DISDAINFUL: "disdainful",
  DISGUSTED: "disgusted",
  DISMISSIVE: "dismissive",
  DISTANT: "distant",
  DOUBTFUL: "doubtful",
  DRAMATIC: "dramatic",
  ELATED: "elated",
  EMBARRASSED: "embarrassed",
  EMPATHETIC: "empathetic",
  ENTHUSIASTIC: "enthusiastic",
  ENVIOUS: "envious",
  EUPHORIC: "euphoric",
  EXCITED: "excited",
  FAST: "fast",
  FEARFUL: "fearful",
  FLIRTATIOUS: "flirtatious",
  FRUSTRATED: "frustrated",
  GRATEFUL: "grateful",
  GUILTY: "guilty",
  HAPPY: "happy",
  HESITANT: "hesitant",
  HOPEFUL: "hopeful",
  HURT: "hurt",
  HYSTERICAL: "hysterical",
  IMPRESSED: "impressed",
  INDIFFERENT: "indifferent",
  INSECURE: "insecure",
  IRONIC: "ironic",
  JEALOUS: "jealous",
  LONELY: "lonely",
  MAD: "mad",
  MELANCHOLIC: "melancholic",
  MISCHIEVOUS: "mischievous",
  MOVED: "moved",
  MUTTERING: "muttering",
  MYSTERIOUS: "mysterious",
  NERVOUS: "nervous",
  NOSTALGIC: "nostalgic",
  OPTIMISTIC: "optimistic",
  OUTRAGED: "outraged",
  PANICKED: "panicked",
  PEACEFUL: "peaceful",
  PESSIMISTIC: "pessimistic",
  PROFESSIONAL: "professional",
  PROUD: "proud",
  QUESTIONING: "questioning",
  REASSURING: "reassuring",
  REGRETFUL: "regretful",
  REJECTED: "rejected",
  RELAXED: "relaxed",
  RESIGNED: "resigned",
  SAD: "sad",
  SARCASTIC: "sarcastic",
  SATISFIED: "satisfied",
  SCARED: "scared",
  SCREAMING: "screaming",
  SERENE: "serene",
  SHEEPISH: "sheepish",
  SHOUTING: "shouting",
  SINGING: "singing",
  SKEPTICAL: "skeptical",
  SLOW: "slow",
  SURPRISED: "surprised",
  SYMPATHETIC: "sympathetic",
  THOUGHTFUL: "thoughtful",
  THREATENED: "threatened",
  TIRED: "tired",
  TRIUMPHANT: "triumphant",
  TRUSTING: "trusting",
  UNCERTAIN: "uncertain",
  UNHAPPY: "unhappy",
  UPSET: "upset",
  WARM: "warm",
  WHISPERING: "whispering",
  WISTFUL: "wistful",
  WORRIED: "worried",
} as const;
export type ExpressionDelivery = (typeof ExpressionDelivery)[keyof typeof ExpressionDelivery];

/**
 * A sound by its universal name, the same on every TTS service.
 *
 * Named as `ExpressionDelivery` names a delivery, in a base word, such
 * as `laugh`.
 */
export const ExpressionSound = {
  BREATH: "breath",
  BURP: "burp",
  CHUCKLE: "chuckle",
  CLEAR_THROAT: "clear throat",
  COUGH: "cough",
  DEEP_BREATH: "deep breath",
  EXHALE: "exhale",
  GASP: "gasp",
  GIGGLE: "giggle",
  GROAN: "groan",
  GULP: "gulp",
  HISS: "hiss",
  HUM: "hum",
  INHALE: "inhale",
  LAUGH: "laugh",
  LAUGH_HARDER: "laugh harder",
  LIGHT_BREATH: "light breath",
  LIP_SMACK: "lip smack",
  PANT: "pant",
  SHARP_EXHALE: "sharp exhale",
  SIGH: "sigh",
  SNEEZE: "sneeze",
  SNIFF: "sniff",
  SNORE: "snore",
  SNORT: "snort",
  SOB: "sob",
  START_LAUGHING: "start laughing",
  SWALLOW: "swallow",
  UM: "um",
  WHEEZE: "wheeze",
  WOO: "woo",
  YAWN: "yawn",
} as const;
export type ExpressionSound = (typeof ExpressionSound)[keyof typeof ExpressionSound];

const EXPRESSION_DELIVERY_VALUES: ReadonlySet<string> = new Set(Object.values(ExpressionDelivery));
const EXPRESSION_SOUND_VALUES: ReadonlySet<string> = new Set(Object.values(ExpressionSound));

// The universal deliveries and sounds an LLM is taught when its policy names none, and
// that Pipecat Tone's tagger writes.
export const CORE_DELIVERY: readonly ExpressionDelivery[] = [
  ExpressionDelivery.CALM,
  ExpressionDelivery.SYMPATHETIC,
  ExpressionDelivery.APOLOGETIC,
  ExpressionDelivery.WARM,
  ExpressionDelivery.EXCITED,
  ExpressionDelivery.SURPRISED,
  ExpressionDelivery.SAD,
  ExpressionDelivery.GRATEFUL,
  ExpressionDelivery.CURIOUS,
  ExpressionDelivery.CONFIDENT,
  ExpressionDelivery.SLOW,
  ExpressionDelivery.FAST,
];
export const CORE_SOUNDS: readonly ExpressionSound[] = [
  ExpressionSound.LAUGH,
  ExpressionSound.CHUCKLE,
  ExpressionSound.SIGH,
  ExpressionSound.BREATH,
];

/**
 * Where in a response a TTS service can change delivery.
 *
 * In `"<<calm>> Sure, <<excited>> it worked!"`, a service with `ANYWHERE`
 * speaks "it worked!" excited. One with `SENTENCE` speaks the whole sentence
 * calm, the delivery its words start in, and the next sentence excited. A
 * span's delivery is the exception: `SENTENCE` speaks the whole of
 * `"Your code is <<slow: A B 7>>."` slowly, so the span's words still are.
 *
 * - `ANYWHERE`: A delivery takes effect where its tag appears.
 * - `SENTENCE`: A delivery can change only between requests, for a service
 *   that takes delivery as a setting of each request, such as MiniMax, or that
 *   changes it reliably only between generations, such as Cartesia. A sentence
 *   is one request; when the service streams tokens, a request is a token, so a
 *   change can take effect within a sentence.
 */
export const DeliveryScope = {
  ANYWHERE: "anywhere",
  SENTENCE: "sentence",
} as const;
export type DeliveryScope = (typeof DeliveryScope)[keyof typeof DeliveryScope];

export interface ExpressionTermOptions {
  /** The name the service performs it by, such as `"laughter"` or `"cheerful"`. */
  name: string;
  /** A short line on when to use it, or empty. */
  description?: string;
}

/** One sound or delivery a TTS service can perform. */
export class ExpressionTerm {
  /** The name the service performs it by, such as `"laughter"` or `"cheerful"`. */
  name: string;
  /** A short line on when to use it, or empty. */
  description: string;

  constructor(options: ExpressionTermOptions) {
    this.name = options.name;
    this.description = options.description ?? "";
  }
}

export interface ExpressionCapabilitiesOptions {
  /** Sounds the service can make at one point, by its own names. */
  sounds?: ExpressionTerm[];
  /** Deliveries the service can apply to the words that follow, by its own names. */
  delivery?: ExpressionTerm[];
  /**
   * Whether the service also accepts sounds and deliveries outside `sounds`
   * and `delivery`, described in a few words.
   */
  allowsFreeText?: boolean;
  /**
   * The shortest and longest pause the service can make, in milliseconds, or
   * null when it can't pause.
   */
  pauseRangeMs?: readonly [number, number] | null;
  /** Whether the service can stress words marked `^^word^^`. */
  emphasis?: boolean;
  /** Where in a response the service can change delivery. */
  deliveryScope?: DeliveryScope;
  /**
   * The names the service performs universal deliveries and sounds by
   * (`ExpressionDelivery`, `ExpressionSound`), best first, where they differ
   * from the universal names, such as `{ [ExpressionDelivery.WARM]: ["content", "happy"] }`.
   * A universal name written in a tag is sent by the first of these the service
   * performs. A universal name left out is performed by its own, when the
   * service declares it or accepts free text.
   */
  serviceVocabulary?: Partial<Record<ExpressionDelivery | ExpressionSound, string[]>>;
}

/**
 * The expression tags a TTS service can perform.
 *
 * The LLM is taught these by their universal names, and tags outside them are
 * left out of the service's speech. A service that can laugh, speak in two
 * moods, pause and stress words declares:
 *
 * @example
 * new ExpressionCapabilities({
 *   sounds: [new ExpressionTerm({ name: "laughs" })],
 *   delivery: [
 *     new ExpressionTerm({ name: "warmly" }),
 *     new ExpressionTerm({ name: "calm", description: "to reassure a worried caller" }),
 *   ],
 *   pauseRangeMs: [100, 3000],
 *   emphasis: true,
 *   serviceVocabulary: {
 *     [ExpressionSound.LAUGH]: ["laughs"],
 *     [ExpressionDelivery.WARM]: ["warmly"],
 *   },
 * });
 */
export class ExpressionCapabilities {
  /** Sounds the service can make at one point, by its own names. */
  sounds: ExpressionTerm[];
  /** Deliveries the service can apply to the words that follow, by its own names. */
  delivery: ExpressionTerm[];
  /** Whether the service also accepts sounds and deliveries outside `sounds` and `delivery`. */
  allowsFreeText: boolean;
  /** The shortest and longest pause the service can make, in milliseconds, or null. */
  pauseRangeMs: readonly [number, number] | null;
  /** Whether the service can stress words marked `^^word^^`. */
  emphasis: boolean;
  /** Where in a response the service can change delivery. */
  deliveryScope: DeliveryScope;
  /** The names the service performs universal deliveries and sounds by, best first. */
  serviceVocabulary: Partial<Record<ExpressionDelivery | ExpressionSound, string[]>>;

  constructor(options: ExpressionCapabilitiesOptions = {}) {
    this.sounds = options.sounds ?? [];
    this.delivery = options.delivery ?? [];
    this.allowsFreeText = options.allowsFreeText ?? false;
    this.pauseRangeMs = options.pauseRangeMs ?? null;
    this.emphasis = options.emphasis ?? false;
    this.deliveryScope = options.deliveryScope ?? DeliveryScope.ANYWHERE;
    this.serviceVocabulary = options.serviceVocabulary ?? {};
  }

  /**
   * The name the service performs a delivery by, or null when it can't.
   *
   * A universal delivery is performed by its first name in `serviceVocabulary`
   * the service performs, else by its own; any other name by itself. The service
   * performs a name it declares, or any name when it accepts free text.
   *
   * @param name The delivery, as written in its tag.
   * @returns The name to send the service.
   */
  deliveryName(name: string): string | null {
    return this._performedName(name, this.delivery, EXPRESSION_DELIVERY_VALUES);
  }

  /**
   * The name the service performs a sound by, or null when it can't.
   *
   * Read as `deliveryName` reads a delivery.
   *
   * @param name The sound, as written in its tag.
   * @returns The name to send the service.
   */
  soundName(name: string): string | null {
    return this._performedName(name, this.sounds, EXPRESSION_SOUND_VALUES);
  }

  protected _performedName(
    name: string,
    terms: ExpressionTerm[],
    universal: ReadonlySet<string>,
  ): string | null {
    const declared = new Set(terms.map((term) => term.name));
    let names: string[] = [];
    // A name that isn't universal, such as an accent, has no service vocabulary.
    if (universal.has(name) && Object.hasOwn(this.serviceVocabulary, name)) {
      names = this.serviceVocabulary[name as ExpressionDelivery | ExpressionSound] ?? [];
    }
    for (const candidate of [...names, name]) {
      if (this.allowsFreeText || declared.has(candidate)) {
        return candidate;
      }
    }
    return null;
  }
}

/** Slow and fast, as a service that performs them declares them. */
export const SPEED_DELIVERY: ExpressionTerm[] = [
  new ExpressionTerm({
    name: SLOW_DELIVERY,
    description: "to say something carefully, such as a number, a code or an address",
  }),
  new ExpressionTerm({ name: FAST_DELIVERY, description: "to say something in passing" }),
];
