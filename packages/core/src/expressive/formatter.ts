// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/expressive/formatter.py

/**
 * Reads the expression tags an LLM writes, and formats them for a TTS service.
 *
 * Part of expressive conversation (alpha). A TTS service with expressive
 * conversation on is given its text a unit at a time: a sentence, or a token when
 * it streams tokens. `ExpressionFormatter` handles each unit in three steps:
 *
 * 1. `ExpressionFormatter.parse` splits the unit into segments: the words
 *    to speak, with the delivery they are spoken in, and the sounds and pauses
 *    between them.
 * 2. `ExpressionFormatter.shownText` gives the words without the tags,
 *    which clients are shown.
 * 3. `ExpressionFormatter.format` builds the request the service is sent,
 *    in its provider's markup, and says what each stretch of the unit performs,
 *    for `SpokenExpression` to report as the words are spoken.
 *
 * With ElevenLabs' audio tags, one sentence goes:
 *
 * ```
 * "<<warm>> It's [[laugh]] ^^back^^ up."            the unit, as the LLM wrote it
 * "It's back up."                                   shown to clients
 * "[warmly] It's [laughs] BACK up."                 sent to ElevenLabs
 * ```
 *
 * The tags are:
 *
 * - `<<name>>` sets the delivery the words after it are spoken in, until the
 *   next delivery tag replaces it or the response ends: `<<warm>>`. A name
 *   may be several words, as in `<<soft tone>>`. `<<neutral>>` returns to the
 *   voice's baseline. Delivery tags aren't segments of their own; the delivery
 *   travels with the `Text` it applies to.
 * - `<<name: words>>` is a span: it speaks just those words in its delivery,
 *   added to the delivery around them, then goes back to it, as in
 *   `<<slow: A B 7>>`. `<<neutral: words>>` speaks them in the baseline.
 *   A span holds words and emphasis, and doesn't nest.
 * - `^^words^^` stresses words. It is a span of emphasis, written short, and can
 *   stand within another span.
 * - `[[name]]` is a `Sound`, a sound at one point (`[[laugh]]`), or a
 *   `Pause`, `[[pause N]]` for N milliseconds.
 *
 * The brackets decide a tag's kind, except that a universal name, or one the TTS
 * service declares, keeps its kind in the other kind's brackets: `[[warm]]`
 * still sets a delivery. LLMs make that slip, so it is logged as a warning.
 *
 * The formatter reads whole units: an aggregator such as `SkipTagsAggregator`,
 * given `EXPRESSION_TAGS`, keeps each tag in one unit as text streams. A tag
 * left unfinished at the end of a unit is removed, never spoken.
 *
 * The service's `BaseExpressionAdapter` says what it can perform and formats
 * each piece in its provider's markup. A universal name, such as `warm` or
 * `laugh`, is sent as the name the service performs it by
 * (`ExpressionCapabilities.deliveryName`), such as ElevenLabs' `warmly`;
 * everything else about the unit keeps the names as written. What the service
 * can't perform is left out of the request, and kept in the unit's text for the
 * context.
 *
 * **Alpha.** The tag syntax and these types are likely to change between releases.
 */

// DIVERGENCE: offsets (`start`, `end`) are UTF-16 code unit offsets, as JS
// strings index, where upstream's are code points. They differ only after an
// astral character (such as an emoji), and stay consistent with the text the
// rest of pipedog indexes.

import { BaseExpressionAdapter } from "../adapters/tts/base_expression_adapter.ts";
import { TextType } from "../frames/frames.ts";
import { logger } from "../utils/logger.ts";
import { SENTENCE_ENDING_PUNCTUATION, type StartEndTags } from "../utils/string.ts";
import {
  DeliveryScope,
  EMPHASIS_DELIVERY,
  ExpressionCapabilities,
  ExpressionDelivery,
  ExpressionSound,
  NEUTRAL_DELIVERY,
} from "./expression.ts";

/**
 * The delimiters of the tags, for an aggregator such as SkipTagsAggregator to
 * keep each tag in one unit.
 */
export const EXPRESSION_TAGS: StartEndTags[] = [
  ["<<", ">>"],
  ["[[", "]]"],
  ["^^", "^^"],
];

// Python's `\w` is Unicode-aware: letters, digits and the underscore.
const W = "\\p{L}\\p{N}_";

/**
 * The delivery and sound tags in the LLM's text, which word tracking passes over so
 * their names aren't matched against spoken words: a span's opening and its
 * closing `>>`, not the words between them, then whole delivery and sound tags.
 * Emphasis has no letters in its delimiters, so it needs none.
 */
export const EXPRESSION_TAG_PATTERN = new RegExp(
  `<<[${W} '\\-/]+?:[ \\t]*(?=[^<>\\n]+?>>)|<<[^<>\\n]*>>|>>|\\[\\[[^\\[\\]\\n]*\\]\\]`,
  "gu",
);

// A tag holds words, digits and a little punctuation; anything else is text.
// A span names its delivery before its colon, then the words it delivers.
const TAG_SOURCE =
  `<<([${W} '\\-/]+?):[ \\t]*([^<>\\n]+?)>>` +
  `|<<([${W} '\\-:/]*)>>|\\[\\[([${W} '\\-:/]*)\\]\\]|\\^\\^([^\\n]+?)\\^\\^`;
const EMPHASIS_SOURCE = "\\^\\^([^\\n]+?)\\^\\^";
// What is left of a tag the unit ended in the middle of, and an emphasis that
// never closed. (Python's `$` also matches before a final newline.)
const UNFINISHED = new RegExp(
  `(?:<<|\\[\\[)(?:[${W}'\\-:/][${W} '\\-:/]*)?(?=\\n?$)|<<[${W} '\\-/]+:[^<>\\n]*(?=\\n?$)`,
  "u",
);
const UNCLOSED_EMPHASIS = "^^";
const PAUSE = /^pause ([0-9]+)$/;

// Spaces and tabs left side by side where a tag stood between two words.
const SPACES = /[ \t]{2,}/g;
// Punctuation that closes the words before a tag written ahead of it, as in
// "Hi [[laugh]], there.": what ends a sentence, and what ends a clause.
const CLOSING_PUNCTUATION = new RegExp(
  `^[${[...new Set([...SENTENCE_ENDING_PUNCTUATION, ",", ":", ")", "，", "、", "：", "）", "،"])]
    .sort()
    .map((c) => c.replace(/[\\\][^-]/g, "\\$&"))
    .join("")}]+`,
  "u",
);

const EXPRESSION_DELIVERY_VALUES: readonly string[] = Object.values(ExpressionDelivery);
const EXPRESSION_SOUND_VALUES: readonly string[] = Object.values(ExpressionSound);

/** Python's `repr()` of a string. */
function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out + quote;
}

export interface TextOptions {
  /** The words, with the spacing around them. */
  text: string;
  /** The delivery the words are spoken in, empty for the voice's baseline. */
  delivery: readonly string[];
  /** Where the words start in the unit. */
  start: number;
  /** Where they end. */
  end: number;
  /**
   * The delivery a span such as `<<slow: A B 7>>` or `^^B^^` adds for just
   * these words, empty for words outside one.
   */
  span?: readonly string[];
}

/**
 * Words to speak, and the delivery to speak them in.
 *
 * `start` and `end` are offsets into the unit as the LLM wrote it, tags
 * included. In `"<<calm>> Hi."`, the words are
 * `Text({ text: " Hi.", delivery: ["calm"], start: 8, end: 12 })`.
 */
export class Text {
  /** The words, with the spacing around them. */
  readonly text: string;
  /** The delivery the words are spoken in, empty for the voice's baseline. */
  readonly delivery: readonly string[];
  /** Where the words start in the unit. */
  readonly start: number;
  /** Where they end. */
  readonly end: number;
  /** The delivery a span adds for just these words, empty for words outside one. */
  readonly span: readonly string[];

  constructor(options: TextOptions) {
    this.text = options.text;
    this.delivery = options.delivery;
    this.start = options.start;
    this.end = options.end;
    this.span = options.span ?? [];
    Object.freeze(this);
  }
}

export interface SoundOptions {
  /** The sound, as written between the brackets. */
  name: string;
  /** Where its tag starts in the unit. */
  start: number;
  /** Where it ends. */
  end: number;
}

/**
 * A sound made at one point, such as a laugh.
 *
 * In `"Hi [[laugh]]"`, the sound is `Sound({ name: "laugh", start: 3, end: 12 })`.
 */
export class Sound {
  /** The sound, as written between the brackets. */
  readonly name: string;
  /** Where its tag starts in the unit. */
  readonly start: number;
  /** Where it ends. */
  readonly end: number;

  constructor(options: SoundOptions) {
    this.name = options.name;
    this.start = options.start;
    this.end = options.end;
    Object.freeze(this);
  }

  /** The sound written as a tag. */
  get tag(): string {
    return `[[${this.name}]]`;
  }

  /** Whether a service with these capabilities makes the sound. */
  performedBy(capabilities: ExpressionCapabilities | null): boolean {
    return capabilities !== null && capabilities.soundName(this.name) !== null;
  }

  /** The sound as reported to clients: its text type and its text. */
  reported(_capabilities: ExpressionCapabilities): [TextType, string] {
    return [TextType.EXPRESSION_SOUND, this.name];
  }
}

export interface PauseOptions {
  /** How long, in milliseconds. */
  durationMs: number;
  /** Where its tag starts in the unit. */
  start: number;
  /** Where it ends. */
  end: number;
}

/** A silence at one point, written `[[pause N]]` for N milliseconds. */
export class Pause {
  /** How long, in milliseconds. */
  readonly durationMs: number;
  /** Where its tag starts in the unit. */
  readonly start: number;
  /** Where it ends. */
  readonly end: number;

  constructor(options: PauseOptions) {
    this.durationMs = options.durationMs;
    this.start = options.start;
    this.end = options.end;
    Object.freeze(this);
  }

  /** The pause written as a tag. */
  get tag(): string {
    return `[[pause ${this.durationMs}]]`;
  }

  /** Whether a service with these capabilities pauses. */
  performedBy(capabilities: ExpressionCapabilities | null): boolean {
    return capabilities !== null && capabilities.pauseRangeMs !== null;
  }

  /** How long the pause is, in milliseconds, within the service's range. */
  durationWithin(capabilities: ExpressionCapabilities): number {
    if (!capabilities.pauseRangeMs) {
      throw new Error("AssertionError: the service has no pause range");
    }
    const [shortest, longest] = capabilities.pauseRangeMs;
    return Math.min(Math.max(this.durationMs, shortest), longest);
  }

  /** The pause as reported to clients: its text type and its milliseconds. */
  reported(capabilities: ExpressionCapabilities): [TextType, string] {
    return [TextType.EXPRESSION_PAUSE, String(this.durationWithin(capabilities))];
  }
}

export type Segment = Text | Sound | Pause;

export interface ExpressionSpanOptions {
  /** Where the stretch starts in the unit. */
  start: number;
  /** Where it ends. */
  end: number;
  /**
   * The delivery its words are spoken in, empty for the voice's baseline, or
   * null for a sound.
   */
  delivery?: string[] | null;
  /**
   * The sound or pause, as reported to clients: its text type,
   * `EXPRESSION_SOUND` or `EXPRESSION_PAUSE`, and its text, the sound's name or
   * the pause's milliseconds. Null for words.
   */
  sound?: [TextType, string] | null;
}

/**
 * What a stretch of a unit performs: words in their delivery, or a sound.
 *
 * `ExpressionFormatter.format` returns one for each segment the service
 * performs, with what it actually performs: a delivery or emphasis the
 * service can't perform is left out of `delivery`, and a sound it can't
 * perform has no span. Offsets are into the unit as the LLM wrote it, so
 * `SpokenExpression` can find which spans the text of each word the service
 * reports covers.
 *
 * For `"<<calm>> Hi [[laugh]]"` on a service that performs both:
 *
 * ```
 * ExpressionSpan({ start: 8, end: 12, delivery: ["calm"] })
 * ExpressionSpan({ start: 12, end: 21, sound: [TextType.EXPRESSION_SOUND, "laugh"] })
 * ```
 */
export class ExpressionSpan {
  /** Where the stretch starts in the unit. */
  readonly start: number;
  /** Where it ends. */
  readonly end: number;
  /** The delivery its words are spoken in, or null for a sound. */
  readonly delivery: string[] | null;
  /** The sound or pause, as reported to clients, or null for words. */
  readonly sound: [TextType, string] | null;

  constructor(options: ExpressionSpanOptions) {
    this.start = options.start;
    this.end = options.end;
    this.delivery = options.delivery ?? null;
    this.sound = options.sound ?? null;
    Object.freeze(this);
  }
}

export interface FormattedRequestOptions {
  /** The text to send to the service, empty when nothing is left to say. */
  text: string;
  /** A span for each stretch of the unit the service performs. */
  spans: ExpressionSpan[];
  /**
   * What the adapter asks to send beside the text, from
   * `BaseExpressionAdapter.requestSettings`.
   */
  settings: Record<string, unknown>;
}

/** A unit's request, as `ExpressionFormatter.format` builds it. */
export class FormattedRequest {
  /** The text to send to the service, empty when nothing is left to say. */
  text: string;
  /** A span for each stretch of the unit the service performs. */
  spans: ExpressionSpan[];
  /** What the adapter asks to send beside the text. */
  settings: Record<string, unknown>;

  constructor(options: FormattedRequestOptions) {
    this.text = options.text;
    this.spans = options.spans;
    this.settings = options.settings;
  }
}

export interface ExpressionFormatterOptions {
  /** The service, named in warnings. */
  owner: unknown;
}

export interface ParseOptions {
  /** Whether the text stands on its own, apart from any response. */
  whole?: boolean;
}

/**
 * Reads a TTS service's expression tags and formats its requests.
 *
 * A TTS service has one formatter, which follows a response from unit to
 * unit. A delivery set in one sentence carries on into the next, until the next
 * delivery tag or `reset`, which the service calls when the response ends
 * or is interrupted. Call `parse` on each unit in order, then `format` to
 * build its request. What the service can't perform is left out of the
 * request, with one warning per tag.
 *
 * @example
 * const formatter = new ExpressionFormatter(() => adapter, { owner: tts });
 *
 * const segments = formatter.parse("<<warm>> It's [[laugh]] ^^back^^ up.");
 * // [Text(" It's ", ["warm"], 8, 14),
 * //  Sound("laugh", 14, 23),
 * //  Text(" ", ["warm"], 23, 24),
 * //  Text("back", ["warm", "emphasis"], 26, 30),
 * //  Text(" up.", ["warm"], 32, 36)]
 *
 * ExpressionFormatter.shownText(segments, TextType.SENTENCE);
 * // "It's back up."
 *
 * const request = await formatter.format(segments, TextType.SENTENCE, transform, trim);
 * // With ElevenLabs' audio tags, request.text is "[warmly] It's [laughs] BACK up."
 *
 * formatter.parse("Bye.");
 * // [Text("Bye.", ["warm"], 0, 4)]: still warm
 */
export class ExpressionFormatter {
  protected _adapter: () => BaseExpressionAdapter;
  protected _owner: unknown;
  // The delivery the next words of the response are spoken in.
  protected _activeDelivery: readonly string[] = [];
  // The delivery of the words last formatted, so markup marks only changes.
  protected _formattedDelivery: string[] | null = null;
  protected _unperformed = new Set<string>();

  /**
   * Initialize the formatter.
   *
   * @param adapter Returns the service's adapter, which may depend on its
   *   settings, such as its model.
   * @param options.owner The service, named in warnings.
   */
  constructor(adapter: () => BaseExpressionAdapter, options: ExpressionFormatterOptions) {
    this._adapter = adapter;
    this._owner = options.owner;
  }

  /**
   * The expression the service can perform now.
   *
   * @returns The service's adapter's capabilities, or null when it performs none.
   */
  capabilities(): ExpressionCapabilities | null {
    return this._adapter().capabilities();
  }

  /**
   * Split a unit of text into segments.
   *
   * Words take the delivery in effect where they are written, which may have
   * been set by an earlier unit of the response:
   *
   * ```
   * formatter.parse("<<calm>> All set.")
   * // [Text(" All set.", ["calm"], 8, 17)]
   * formatter.parse(" Bye.")
   * // [Text(" Bye.", ["calm"], 0, 5)]
   * ```
   *
   * Text that stands on its own, such as a `TTSSpeakFrame`'s spoken in the
   * middle of a response, is parsed with `whole: true`: it starts in the
   * voice's baseline, and the response's delivery carries on after it:
   *
   * ```
   * formatter.parse("<<excited>> One moment.", { whole: true })
   * // [Text(" One moment.", ["excited"], 11, 23)]
   * formatter.parse(" Back.")
   * // [Text(" Back.", ["calm"], 0, 6)]
   * ```
   *
   * @param text The unit, with each of its tags whole.
   * @param options.whole Whether the text stands on its own, apart from any response.
   * @returns Its segments, in order. Spacing alone between two tags is a
   *   `Text` of its own, so the request keeps it.
   */
  parse(text: string, options: ParseOptions = {}): Segment[] {
    const whole = options.whole ?? false;
    const responseDelivery = this._activeDelivery;
    if (whole) {
      this._activeDelivery = [];
    }
    // The names the service declares, and the universal names it performs,
    // keep their kind in either brackets.
    const capabilities = this.capabilities();
    const declared = capabilities ?? new ExpressionCapabilities();
    const sounds = new Set<string>([
      ...declared.sounds.map((term) => term.name),
      ...EXPRESSION_SOUND_VALUES.filter((name) => declared.soundName(name)),
    ]);
    const delivery = new Set<string>([
      NEUTRAL_DELIVERY,
      ...declared.delivery.map((term) => term.name),
      ...EXPRESSION_DELIVERY_VALUES.filter((name) => declared.deliveryName(name)),
    ]);
    const segments: Segment[] = [];
    let position = 0;
    for (const match of text.matchAll(new RegExp(TAG_SOURCE, "gdu"))) {
      const matchStart = match.index;
      this._addText(segments, text, position, matchStart);
      const [, spanDelivery, spanWords, deliveryTag, soundTag, stressed] = match;
      const indices = match.indices as RegExpIndicesArray;
      if (spanWords !== undefined) {
        this._addSpan(
          segments,
          [deliveryName(spanDelivery as string)],
          spanWords,
          (indices[2] as [number, number])[0],
        );
      } else if (stressed !== undefined) {
        this._addSpan(segments, [EMPHASIS_DELIVERY], stressed, (indices[5] as [number, number])[0]);
      } else {
        this._addTag(
          segments,
          deliveryTag ?? null,
          soundTag ?? null,
          match[0],
          matchStart,
          matchStart + match[0].length,
          sounds,
          delivery,
        );
      }
      position = matchStart + match[0].length;
    }
    this._addText(segments, text, position, text.length);
    if (whole) {
      this._activeDelivery = responseDelivery;
    }
    return segments;
  }

  /**
   * Have the next request state its delivery from its start.
   *
   * Markup marks only where the delivery changes, so a request continuing
   * the one before it doesn't repeat them. Text spoken in an audio context
   * of its own, such as a `TTSSpeakFrame`'s, follows no earlier request
   * there, nor does the response's next request follow it, so the
   * service calls this before and after it.
   */
  restateDelivery(): void {
    this._formattedDelivery = null;
  }

  /** Return to the baseline, as at the end of a response or an interruption. */
  reset(): void {
    this._activeDelivery = [];
    this._formattedDelivery = null;
  }

  /**
   * The words of a unit, without its tags, spaced as written.
   *
   * This is the unit's text as clients are shown it:
   *
   * ```
   * const segments = formatter.parse("<<warm>> It's [[laugh]] ^^back^^ up.");
   * ExpressionFormatter.shownText(segments, TextType.SENTENCE);
   * // "It's back up."
   * ```
   *
   * A tag is removed as a word, with the space before it when punctuation
   * follows it: `"Hi [[laugh]], there."` is shown as `"Hi, there."`, and so
   * is `"Hi <<calm>>, there."`.
   *
   * @param segments The unit's segments.
   * @param textType The unit's text type. A sentence's words are trimmed at
   *   both ends; a streamed token keeps its spacing.
   * @returns The words, with one space where a tag stood between two.
   */
  static shownText(segments: Segment[], textType: TextType | string): string {
    let words = moveClosingPunctuation(segments)
      .filter((segment): segment is Text => segment instanceof Text)
      .map((segment) => segment.text)
      .join("");
    words = words.replace(SPACES, " ");
    return textType === TextType.TOKEN ? words : words.trim();
  }

  /**
   * Build the request for a unit.
   *
   * Each run of words goes through `transform` first, so text transforms such
   * as markdown stripping never see markup, and is then formatted by the
   * adapter in the delivery the service can perform. Sounds and pauses are
   * formatted at their places, except that punctuation written after one stays
   * with the words before it, where the service reports it:
   * `"Hi [[laugh]], there."` asks ElevenLabs for `"Hi, [laughs] there."`. A
   * sentence's request is trimmed at both ends; a streamed token keeps its
   * spacing.
   *
   * Cartesia names `warm` and `laugh` its own way, has no emphasis, and
   * changes emotion only between sentences:
   *
   * ```
   * const segments = formatter.parse("<<warm>> It's [[laugh]] ^^back^^ up.");
   * const request = await formatter.format(segments, TextType.SENTENCE, transform, trim);
   * // text:  '<emotion value="content"/> It's [laughter] back up.'
   * // spans: [ExpressionSpan(8, 14, delivery=["warm"]),
   * //         ExpressionSpan(14, 23, sound=[EXPRESSION_SOUND, "laugh"]),
   * //         ExpressionSpan(23, 24, delivery=["warm"]),
   * //         ExpressionSpan(26, 30, delivery=["warm"]),  // no emphasis
   * //         ExpressionSpan(32, 36, delivery=["warm"])]
   * ```
   *
   * @param segments The unit's segments.
   * @param textType The unit's text type.
   * @param transform Rewrites a run of words for the service, or returns null
   *   when nothing is left of it.
   * @param trim Trims the unit's first words as the service trims a unit's
   *   text, or returns null when nothing is left of them.
   * @returns The request: its text, its spans, and the settings the adapter
   *   asks for the delivery its first words are spoken in.
   */
  async format(
    segments: Segment[],
    textType: TextType | string,
    transform: (text: string, textType: TextType | string) => Promise<string | null>,
    trim: (text: string) => string | null,
  ): Promise<FormattedRequest> {
    const capabilities = this.capabilities();
    if (textType !== TextType.TOKEN) {
      // A sentence's request states its delivery from its start, since not
      // every service keeps delivery from one request to the next.
      this._formattedDelivery = null;
    }
    let sentenceDelivery: string[] | null = null;
    if (capabilities && capabilities.deliveryScope === DeliveryScope.SENTENCE) {
      sentenceDelivery = this._sentenceDelivery(segments, capabilities);
    }
    const parts: string[] = [];
    const spans: ExpressionSpan[] = [];
    let firstDelivery: string[] | null = null;
    let lastDelivery: string[] | null = null;
    let trimmed = false;
    for (const segment of moveClosingPunctuation(segments)) {
      if (!(segment instanceof Text)) {
        if (capabilities && segment.performedBy(capabilities)) {
          const sound = segment.reported(capabilities);
          spans.push(new ExpressionSpan({ start: segment.start, end: segment.end, sound }));
          parts.push(this._formatSound(segment, capabilities));
        } else {
          this._warnUnperformed(segment.tag);
        }
        continue;
      }
      let delivery = this._performedDelivery([...segment.delivery], capabilities);
      if (sentenceDelivery !== null) {
        delivery = sentenceDelivery;
      }
      spans.push(new ExpressionSpan({ start: segment.start, end: segment.end, delivery }));
      if (!segment.text.trim()) {
        // Spacing before the unit's first words is trimmed as they are.
        const spacing = trimmed ? segment.text : trim(segment.text);
        if (spacing) {
          parts.push(spacing);
        }
        continue;
      }
      if (firstDelivery === null) {
        firstDelivery = delivery;
      }
      let words: string | null = segment.text;
      if (!trimmed) {
        // The unit's first words are trimmed as its text would be, and a
        // sentence's even after a sound or pause written before them.
        words = trim(textType === TextType.TOKEN ? words : words.trimStart());
        trimmed = true;
      }
      words = words !== null ? await transform(words, textType) : null;
      if (words !== null) {
        parts.push(this._format(words, serviceDelivery(delivery, capabilities)));
        lastDelivery = delivery;
      }
    }
    if (lastDelivery !== null && textType !== TextType.TOKEN) {
      parts.push(this._adapter().formatEnd(serviceDelivery(lastDelivery, capabilities)));
    }
    const request = parts.join("").replace(SPACES, " ");
    // A streamed token with no words of its own goes on in the delivery
    // before it.
    const delivery =
      firstDelivery !== null
        ? serviceDelivery(firstDelivery, capabilities)
        : this._formattedDelivery;
    return new FormattedRequest({
      text: textType === TextType.TOKEN ? request : request.trim(),
      spans,
      settings: this._adapter().requestSettings(delivery ?? []),
    });
  }

  protected _addText(segments: Segment[], text: string, start: number, end: number): void {
    let words = text.slice(start, end);
    const unfinished = end === text.length ? UNFINISHED.exec(words) : null;
    if (unfinished) {
      logger.warning(
        `Removing an unfinished expression tag: ${pyStrRepr(words.slice(unfinished.index))}`,
      );
      words = words.slice(0, unfinished.index);
      end = start + words.length;
    }
    words = words.replaceAll(UNCLOSED_EMPHASIS, "");
    if (words) {
      segments.push(new Text({ text: words, delivery: this._activeDelivery, start, end }));
    }
  }

  /**
   * The one delivery a request takes on a service that changes delivery between requests.
   *
   * It is the delivery its words start in, and any span's, which such a
   * service can perform only over the whole request: `"Your code is
   * <<slow: A B 7>>."` is spoken slowly. Emphasis is the exception, as
   * stress over a whole sentence stresses nothing. Clients are told the
   * delivery that was requested.
   */
  protected _sentenceDelivery(
    segments: Segment[],
    capabilities: ExpressionCapabilities,
  ): string[] | null {
    const words = segments.filter((s): s is Text => s instanceof Text && s.text.trim().length > 0);
    if (words.length === 0) {
      return null;
    }
    const delivery = [...(words[0] as Text).delivery];
    for (const segment of words) {
      const spread = segment.span.filter((t) => t !== EMPHASIS_DELIVERY && !delivery.includes(t));
      delivery.push(...spread);
    }
    return this._performedDelivery(delivery, capabilities);
  }

  /**
   * Add a span's words, in the delivery around it and its own, or in the baseline for neutral.
   *
   * `^^B^^` is a span of emphasis, written short, and can stand within
   * another span: `<<slow: A ^^B^^ 7>>` stresses B on top of slow.
   */
  protected _addSpan(
    segments: Segment[],
    span: readonly string[],
    text: string,
    start: number,
    around: readonly string[] | null = null,
  ): void {
    const surrounding = around ?? this._activeDelivery;
    let delivery: readonly string[];
    if (span.length === 1 && span[0] === NEUTRAL_DELIVERY) {
      delivery = [];
      span = [];
    } else {
      delivery = [...surrounding, ...span.filter((t) => !surrounding.includes(t))];
    }
    let position = 0;
    for (const match of text.matchAll(new RegExp(EMPHASIS_SOURCE, "gd"))) {
      const matchStart = match.index;
      if (matchStart > position) {
        const words = text.slice(position, matchStart);
        segments.push(
          new Text({
            text: words,
            delivery,
            start: start + position,
            end: start + matchStart,
            span,
          }),
        );
      }
      const stressed = [...span, EMPHASIS_DELIVERY];
      const groupStart = ((match.indices as RegExpIndicesArray)[1] as [number, number])[0];
      this._addSpan(segments, stressed, match[1] as string, start + groupStart, delivery);
      position = matchStart + match[0].length;
    }
    if (position < text.length) {
      segments.push(
        new Text({
          text: text.slice(position),
          delivery,
          start: start + position,
          end: start + text.length,
          span,
        }),
      );
    }
  }

  protected _addTag(
    segments: Segment[],
    deliveryTag: string | null,
    soundTag: string | null,
    tag: string,
    start: number,
    end: number,
    sounds: Set<string>,
    delivery: Set<string>,
  ): void {
    const content = (deliveryTag !== null ? deliveryTag : soundTag || "").trim();
    if (deliveryTag === null) {
      const pause = PAUSE.exec(content);
      if (pause) {
        segments.push(new Pause({ durationMs: Number(pause[1]), start, end }));
        return;
      }
      if (delivery.has(content) && !sounds.has(content)) {
        logger.warning(
          `Reading a delivery written in sound brackets as a delivery: ${pyStrRepr(tag)}`,
        );
        this._setDelivery(content);
        return;
      }
      segments.push(new Sound({ name: content, start, end }));
      return;
    }
    if (sounds.has(content) && !delivery.has(content)) {
      logger.warning(`Reading a sound written in delivery brackets as a sound: ${pyStrRepr(tag)}`);
      segments.push(new Sound({ name: content, start, end }));
      return;
    }
    this._setDelivery(content);
  }

  protected _setDelivery(content: string): void {
    const name = deliveryName(content);
    this._activeDelivery = name === "" || name === NEUTRAL_DELIVERY ? [] : [name];
  }

  /** Format words to send to the TTS in their delivery, by the service's names. */
  protected _format(text: string, delivery: string[]): string {
    // Leading spacing stays outside the markup, between the words.
    const words = text.trimStart();
    const formatted = this._adapter().formatText(words, delivery, this._formattedDelivery);
    this._formattedDelivery = delivery;
    return text.slice(0, text.length - words.length) + formatted;
  }

  /** The delivery the service can perform, warning once about each it can't. */
  protected _performedDelivery(
    delivery: string[],
    capabilities: ExpressionCapabilities | null,
  ): string[] {
    const performed: string[] = [];
    for (const name of delivery) {
      let supported: boolean;
      if (name === EMPHASIS_DELIVERY) {
        supported = Boolean(capabilities?.emphasis);
      } else {
        supported = Boolean(capabilities?.deliveryName(name));
      }
      if (supported) {
        performed.push(name);
      } else {
        this._warnUnperformed(name === EMPHASIS_DELIVERY ? "^^emphasis^^" : `<<${name}>>`);
      }
    }
    return performed;
  }

  /** Format a sound or pause the service can perform. */
  protected _formatSound(segment: Sound | Pause, capabilities: ExpressionCapabilities): string {
    if (segment instanceof Pause) {
      return this._adapter().formatPause(segment.durationWithin(capabilities));
    }
    return this._adapter().formatSound(capabilities.soundName(segment.name) || segment.name);
  }

  protected _warnUnperformed(tag: string): void {
    if (!this._unperformed.has(tag)) {
      this._unperformed.add(tag);
      logger.warning(`${String(this._owner)} can't perform ${tag}, leaving it out of its speech`);
    }
  }
}

/**
 * Return text written with expression tags as its words alone.
 *
 * The words are spaced as clients are shown them, as by
 * `ExpressionFormatter.shownText`:
 *
 * ```
 * stripExpressionTags("<<warm>> It's [[laugh]] ^^back^^ up.")
 * // "It's back up."
 * ```
 *
 * @param text Text as an LLM writes it in expressive conversation.
 * @returns The words, without the tags.
 */
export function stripExpressionTags(text: string): string {
  const parser = new ExpressionFormatter(() => new BaseExpressionAdapter(), {
    owner: "strip_expression_tags",
  });
  return ExpressionFormatter.shownText(parser.parse(text, { whole: true }), TextType.SENTENCE);
}

/** The delivery a tag names, its words single-spaced. */
function deliveryName(text: string): string {
  return text
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .join(" ");
}

/** A performed delivery by the names the service performs it by. */
function serviceDelivery(
  delivery: string[],
  capabilities: ExpressionCapabilities | null,
): string[] {
  if (capabilities === null) {
    return delivery;
  }
  return delivery.map((name) =>
    name === EMPHASIS_DELIVERY ? name : capabilities.deliveryName(name) || name,
  );
}

/**
 * Move punctuation written after a tag onto the words before it.
 *
 * A tag is removed as a word, so in `"Hi [[laugh]], there."` the comma
 * closes `"Hi"`: the words become `"Hi,"` and `" there."`, with the
 * sound between them, where a service reports the comma. Words follow a tag
 * when a sound or pause stands between them, or the gap a delivery tag left.
 */
function moveClosingPunctuation(segments: Segment[]): Segment[] {
  const moved: Segment[] = [];
  let wordsAt: number | null = null;
  let tagSinceWords = false;
  let end: number | null = null;
  for (let segment of segments) {
    if (!(segment instanceof Text)) {
      tagSinceWords = true;
      moved.push(segment);
      continue;
    }
    if (end !== null && segment.start > end) {
      tagSinceWords = true;
    }
    end = segment.end;
    if (segment.text.trim()) {
      const closing = CLOSING_PUNCTUATION.exec(segment.text);
      if (closing && wordsAt !== null && tagSinceWords) {
        const words = moved[wordsAt] as Text;
        moved[wordsAt] = new Text({ ...words, text: words.text.trimEnd() + closing[0] });
        segment = new Text({ ...segment, text: segment.text.slice(closing[0].length) });
      }
      tagSinceWords = false;
      if (segment.text.trim()) {
        wordsAt = moved.length;
      }
    }
    moved.push(segment);
  }
  return moved;
}
