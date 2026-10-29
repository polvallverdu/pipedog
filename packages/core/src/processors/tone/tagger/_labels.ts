// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/tone/tagger/_labels.py

/**
 * The labels Pipecat Tone's tagger chooses, and the expression tags they're written as.
 *
 * The tagger labels with `CORE_DELIVERY` and `CORE_SOUNDS`, universal names, and draws
 * a breath as one of `BREATH_KINDS`. A call's label space holds those its TTS service
 * performs and its policy offers, each with the name to write: its universal name, or a
 * developer's own, which the TTS service then performs by its own name.
 *
 * PORTING NOTES:
 * - Python dicts of label to name are plain objects (`Record<string, string>`), in
 *   insertion order; membership is checked with `Object.hasOwn`.
 * - Offsets into a sentence are UTF-16 code units, as JavaScript string indices are
 *   (upstream counts code points). They differ only outside the Basic Multilingual Plane.
 */

import {
  CORE_DELIVERY,
  CORE_SOUNDS,
  type ExpressionCapabilities,
  type ExpressionDelivery,
  ExpressionSound,
  NEUTRAL_DELIVERY,
} from "../../../expressive/expression.ts";
import { ExpressionGuidance, type ExpressionPolicy } from "../../../expressive/policy.ts";
import { isAlnum, isSpace } from "../../../utils/text/alnum_utils.ts";

/** The kinds the tagger draws a breath as, each a universal sound. */
export const BREATH_KINDS: readonly ExpressionSound[] = [
  ExpressionSound.LIGHT_BREATH,
  ExpressionSound.DEEP_BREATH,
  ExpressionSound.EXHALE,
];

/**
 * The services the model was trained with, by the names it reads for them. It reads
 * "other" for any other.
 */
export const TRAINED_SERVICES: readonly string[] = ["cartesia", "elevenlabs", "fish", "minimax"];
export const OTHER_SERVICE = "other";

/** Names to try first for a label, before its own. */
export type LabelVocabulary = Partial<Record<ExpressionDelivery | ExpressionSound, string[]>>;

export interface LabelSpaceOptions {
  /** Delivery label to the name to write, in `CORE_DELIVERY` order. */
  deliveries: Record<string, string>;
  /** Sound label to the name to write, in `CORE_SOUNDS` order. */
  sounds: Record<string, string>;
  /** Whether the service stresses `^^words^^`. */
  emphasis: boolean;
  /** The service, by the name the model was trained to read for it. */
  tts?: string;
  /**
   * Kind of breath to the name to write, in `BREATH_KINDS` order, where a breath is
   * offered. The model chooses only a breath, and the tagger draws its kind.
   */
  breaths?: Record<string, string>;
}

/** The labels a call can use, each with the name to write it as. */
export class LabelSpace {
  /** Delivery label to the name to write, in `CORE_DELIVERY` order. */
  readonly deliveries: Record<string, string>;
  /** Sound label to the name to write, in `CORE_SOUNDS` order. */
  readonly sounds: Record<string, string>;
  /** Whether the service stresses `^^words^^`. */
  readonly emphasis: boolean;
  /** The service, by the name the model was trained to read for it. */
  readonly tts: string;
  /** Kind of breath to the name to write, in `BREATH_KINDS` order, where a breath is offered. */
  readonly breaths: Record<string, string>;

  constructor(options: LabelSpaceOptions) {
    this.deliveries = options.deliveries;
    this.sounds = options.sounds;
    this.emphasis = options.emphasis;
    this.tts = options.tts ?? OTHER_SERVICE;
    this.breaths = options.breaths ?? {};
  }

  /**
   * The labels the service performs and the policy offers.
   *
   * A label is written as the first of the developer's names for it, then its
   * own, that the service performs and the policy offers. A breath, and its kinds,
   * are offered only with `ExpressionGuidance.BREATHE` in the policy. A breath is
   * offered where the service performs only some of its kinds, written as the first
   * of them for a model that draws no kinds.
   *
   * @param capabilities What the service performs.
   * @param policy The pipeline's expression policy.
   * @param serviceName The service's name, such as `"ElevenLabsTTSService#0"`,
   *   which says which of the services the model was trained with it is.
   *   A service given a name of its own, such as `name: "tts"`, is read
   *   as one the model wasn't trained with.
   * @param vocabulary Names to try first for a label, before its own.
   */
  static resolve(
    capabilities: ExpressionCapabilities,
    policy: ExpressionPolicy,
    serviceName = "",
    vocabulary: LabelVocabulary | null = null,
  ): LabelSpace {
    const names = (vocabulary ?? {}) as Record<string, string[]>;
    const soundName = (name: string) => capabilities.soundName(name);
    const sounds = CORE_SOUNDS.filter((s) => s !== ExpressionSound.BREATH || _breathes(policy));
    const resolved = _resolve(sounds, soundName, names, policy.sounds);
    // Each kind of breath is a sound of its own.
    const breaths = _breathes(policy)
      ? _resolve(BREATH_KINDS, soundName, names, policy.sounds)
      : {};
    // A breath is last in CORE_SOUNDS, so adding it keeps the order.
    const firstBreath = Object.values(breaths)[0];
    if (firstBreath !== undefined && !Object.hasOwn(resolved, ExpressionSound.BREATH)) {
      resolved[ExpressionSound.BREATH] = firstBreath;
    }
    return new LabelSpace({
      deliveries: _resolve(
        CORE_DELIVERY,
        (name) => capabilities.deliveryName(name),
        names,
        policy.delivery,
      ),
      sounds: resolved,
      emphasis: capabilities.emphasis,
      tts: _trainedService(serviceName),
      breaths,
    });
  }

  /** The name to write for a sound or a kind of breath, if the space holds it. */
  soundName(label: string): string | null {
    return (
      (Object.hasOwn(this.sounds, label) ? this.sounds[label] : undefined) ||
      (Object.hasOwn(this.breaths, label) ? this.breaths[label] : undefined) ||
      null
    );
  }
}

export interface SpanOptions {
  /** The offset of the first word's first character. */
  start: number;
  /** The offset just past the last word. */
  end: number;
  /** The words' delivery, a label from `CORE_DELIVERY`. */
  delivery: string;
}

/** A delivery for some words, `<<delivery: words>>`, by offsets in the sentence. */
export class Span {
  /** The offset of the first word's first character. */
  readonly start: number;
  /** The offset just past the last word. */
  readonly end: number;
  /** The words' delivery, a label from `CORE_DELIVERY`. */
  readonly delivery: string;

  constructor(options: SpanOptions) {
    this.start = options.start;
    this.end = options.end;
    this.delivery = options.delivery;
  }
}

export interface SentenceLabelsOptions {
  /** The sentence's delivery, or null for the voice's baseline. */
  delivery?: string | null;
  /** Words in a delivery of their own, mainly slow details. */
  spans?: Span[];
  /** Words to stress, as `[start, end]` offsets. */
  emphasis?: [number, number][];
  /** A sound before the sentence, or null. */
  soundBefore?: string | null;
  /** A sound after the sentence, or null. */
  soundAfter?: string | null;
}

/** What the tagger chose for one sentence, in its labels; usually nothing. */
export class SentenceLabels {
  /** The sentence's delivery, or null for the voice's baseline. */
  delivery: string | null;
  /** Words in a delivery of their own, mainly slow details. */
  spans: Span[];
  /** Words to stress, as `[start, end]` offsets. */
  emphasis: [number, number][];
  /** A sound before the sentence, or null. */
  soundBefore: string | null;
  /** A sound after the sentence, or null. */
  soundAfter: string | null;

  constructor(options: SentenceLabelsOptions = {}) {
    this.delivery = options.delivery ?? null;
    this.spans = options.spans ?? [];
    this.emphasis = options.emphasis ?? [];
    this.soundBefore = options.soundBefore ?? null;
    this.soundAfter = options.soundAfter ?? null;
  }
}

/** Writes one reply's sentences as tags, a delivery only where it changes. */
export class ReplyRenderer {
  protected _space: LabelSpace;
  protected _delivery: string | null;

  /**
   * Initialize the renderer.
   *
   * @param space The labels the call can use.
   */
  constructor(space: LabelSpace) {
    this._space = space;
    this._delivery = null;
  }

  /**
   * Write the next sentence of the reply with its labels as tags.
   *
   * Labels the space doesn't hold, or that would overlap or cut a word, are
   * dropped, so the tags always speak exactly the sentence's words.
   */
  render(sentence: string, labels: SentenceLabels): string {
    let text = _strip(sentence);
    if (!text) {
      return text;
    }
    const kept = _keep(text, labels, this._space);
    const names = this._space.deliveries;

    // (offset, order, tag): at one offset a close comes before an open.
    const inserts: [number, number, string][] = [];
    for (const span of kept.spans) {
      inserts.push([span.start, 1, `<<${names[span.delivery]}: `], [span.end, 0, ">>"]);
    }
    for (const [start, end] of kept.emphasis) {
      inserts.push([start, 1, "^^"], [end, 0, "^^"]);
    }
    // A stable sort, descending: equal keys keep their order, as Python's reverse sort does.
    const ordered = [...inserts].sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    for (const [at, , tag] of ordered) {
      text = text.slice(0, at) + tag + text.slice(at);
    }

    if (kept.soundBefore) {
      text = `[[${this._space.soundName(kept.soundBefore)}]] ${text}`;
    }
    if (kept.soundAfter) {
      text = `${text} [[${this._space.soundName(kept.soundAfter)}]]`;
    }
    const delivery = kept.delivery ? (names[kept.delivery] ?? null) : null;
    if (delivery !== this._delivery) {
      text = `<<${delivery || NEUTRAL_DELIVERY}>> ${text}`;
      this._delivery = delivery;
    }
    return text;
  }
}

function _trainedService(serviceName: string): string {
  const name = serviceName.toLowerCase();
  return TRAINED_SERVICES.find((service) => name.includes(service)) ?? OTHER_SERVICE;
}

function _breathes(policy: ExpressionPolicy): boolean {
  return policy.guidance.some((g) => String(g) === ExpressionGuidance.BREATHE.value);
}

/**
 * Each label's first name the service performs and the policy offers.
 *
 * The developer's names for a label are tried best first, then the label itself.
 * A label with no such name is left out.
 */
function _resolve(
  labels: Iterable<string>,
  performedName: (name: string) => string | null,
  vocabulary: Record<string, string[]>,
  offered: readonly string[] | null,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const label of labels) {
    const own = Object.hasOwn(vocabulary, label) ? (vocabulary[label] ?? []) : [];
    for (const name of [...own, label]) {
      if (performedName(name) !== null && (offered === null || offered.includes(name))) {
        resolved[label] = name;
        break;
      }
    }
  }
  return resolved;
}

/** The labels the space holds, on whole words and not overlapping. */
function _keep(sentence: string, labels: SentenceLabels, space: LabelSpace): SentenceLabels {
  const taken: [number, number][] = [];
  const spans: Span[] = [];
  for (const span of [...labels.spans].sort((a, b) => a.start - b.start)) {
    if (
      Object.hasOwn(space.deliveries, span.delivery) &&
      _words(sentence, span.start, span.end) &&
      !_overlaps(taken, span.start, span.end)
    ) {
      taken.push([span.start, span.end]);
      spans.push(span);
    }
  }
  const emphasis: [number, number][] = [];
  if (space.emphasis) {
    for (const [start, end] of [...labels.emphasis].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      if (_words(sentence, start, end) && !_overlaps(taken, start, end)) {
        taken.push([start, end]);
        emphasis.push([start, end]);
      }
    }
  }
  return new SentenceLabels({
    delivery:
      labels.delivery !== null && Object.hasOwn(space.deliveries, labels.delivery)
        ? labels.delivery
        : null,
    spans,
    emphasis,
    soundBefore: space.soundName(labels.soundBefore ?? "") ? labels.soundBefore : null,
    soundAfter: space.soundName(labels.soundAfter ?? "") ? labels.soundAfter : null,
  });
}

function _words(text: string, start: number, end: number): boolean {
  return (
    0 <= start &&
    start < end &&
    end <= text.length &&
    !isSpace(text[start]) &&
    !isSpace(text[end - 1]) &&
    _boundary(text, start) &&
    _boundary(text, end)
  );
}

function _boundary(text: string, at: number): boolean {
  return at === 0 || at === text.length || !(isAlnum(text[at - 1]) && isAlnum(text[at]));
}

function _overlaps(taken: [number, number][], start: number, end: number): boolean {
  return taken.some(([s, e]) => start < e && s < end);
}

/** Python's `str.strip()`: leading and trailing whitespace, by `str.isspace()`. */
function _strip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpace(text[start])) start++;
  while (end > start && isSpace(text[end - 1])) end--;
  return text.slice(start, end);
}
