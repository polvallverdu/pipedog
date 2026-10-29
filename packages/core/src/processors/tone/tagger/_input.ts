// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/tone/tagger/_input.py

/**
 * What Pipecat Tone's tagger model reads: the call so far, as text it was trained on.
 *
 * For each sentence the model reads a text pair. The first text is the end of the call.
 * The second holds what the TTS service performs, the policy's presets, how the user
 * sounded, the tags of the bot's previous reply, state hints from the whole call, the
 * reply so far and the sentence, last. State hints carry what the end of the call leaves
 * out.
 *
 * Training wrote the same text, so it must not change for a released model.
 *
 * PORTING NOTES:
 * - The regular expressions use the `u` flag and spell out Python's Unicode `\w`, `\d`
 *   and `\b` (JavaScript's are ASCII-only), so they match what upstream's match.
 * - `encode` returns where the sentence starts in UTF-16 code units (upstream counts
 *   code points); they differ only outside the Basic Multilingual Plane.
 */

import { PerceptionSignal } from "../../../expressive/perception.ts";
import { ExpressionGuidance, type ExpressionPolicy } from "../../../expressive/policy.ts";
import type { LabelSpace, SentenceLabels } from "./_labels.ts";

/** The presets the model reads, by the names it was trained on, keyed by the preset's text. */
export const PRESET_NAMES: Readonly<Record<string, string>> = {
  [ExpressionGuidance.MATCH_STYLE.value]: "match style",
  [ExpressionGuidance.SLOW_FOR_DETAILS.value]: "slow for details",
  [ExpressionGuidance.BREATHE.value]: "breathe",
};

// The model was trained on a `tone` signal; Pipecat Tone's reader reads an
// `emotion`, folded in by adding its confidences.
const _EMOTION_TO_TONE: Readonly<Record<string, string>> = {
  neutral: "neutral",
  happy: "positive",
  amused: "positive",
  surprised: "neutral",
  sad: "sad",
  afraid: "sad",
  angry: "frustrated",
  disgusted: "frustrated",
  contemptuous: "frustrated",
};
const _CLEAR = 0.7;
const _LIKELY = 0.5;

// Python's Unicode `\w`, `\d` and `\b` for `str` patterns.
const W = "[\\p{L}\\p{N}_]";
const D = "\\p{Nd}";
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

// Details someone might write down: a code with letters and digits, five or more
// digits (with dashes or spaces), characters spelled out one by one, an email.
const _DETAILS = new RegExp(
  `${B}(?=[A-Z0-9]*${D})(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,}${B}` +
    `|(?<![${D}$.,])${D}(?:[${D}\\- ]*${D}){4,}(?![${D}.,]${D})` +
    `|${B}(?:[A-Za-z0-9][ -]){3,}[A-Za-z0-9]${B}` +
    `|[\\p{L}\\p{N}_.+-]+@[\\p{L}\\p{N}_-]+(?:\\.[\\p{L}\\p{N}_-]+)+`,
  "gu",
);
const _APOLOGY = new RegExp(`${B}(sorry|apologi[sz]e)`, "iu");
const _SLOW_OR_REPEAT = new RegExp(
  `${B}(slow(er)? down|slower|say (that|it) again|repeat|didn't (catch|get) (that|it)` +
    `|one more time|come again)${B}`,
  "iu",
);
const _DIGIT_WORDS: Readonly<Record<string, string>> = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

export interface MessageOptions {
  /** `"user"` or `"assistant"`. */
  role: string;
  /** The words. */
  text: string;
  /** How the user sounded, folded into the model's tones, or null. */
  heard?: PerceptionSignal[] | null;
  /** Whether it's the turn an early reply answers, not yet confirmed. */
  speculation?: boolean;
}

/** A turn of the call, as plain words. */
export class Message {
  /** `"user"` or `"assistant"`. */
  role: string;
  /** The words. */
  text: string;
  /** How the user sounded, folded into the model's tones, or null. */
  heard: PerceptionSignal[] | null;
  /** Whether it's the turn an early reply answers, not yet confirmed. */
  speculation: boolean;

  constructor(options: MessageOptions) {
    this.role = options.role;
    this.text = options.text;
    this.heard = options.heard ?? null;
    this.speculation = options.speculation ?? false;
  }
}

export interface TurnContextOptions {
  /** The call so far. */
  messages: Message[];
  /** The labels the call can use. */
  space: LabelSpace;
  /** The pipeline's expression policy. */
  policy: ExpressionPolicy;
  /** The labels of the bot's previous reply, or null before the first. */
  previous?: SentenceLabels[] | null;
}

/** What the model knows when a reply starts. */
export class TurnContext {
  /** The call so far. */
  messages: Message[];
  /** The labels the call can use. */
  space: LabelSpace;
  /** The pipeline's expression policy. */
  policy: ExpressionPolicy;
  /** The labels of the bot's previous reply, or null before the first. */
  previous: SentenceLabels[] | null;

  constructor(options: TurnContextOptions) {
    this.messages = options.messages;
    this.space = options.space;
    this.policy = options.policy;
    this.previous = options.previous ?? null;
  }

  /** How the user sounded in the turn this reply answers. */
  get heard(): PerceptionSignal[] | null {
    const user = this.messages.findLast((m) => m.role === "user");
    return user ? user.heard : null;
  }
}

export interface LayoutOptions {
  /** The messages of the call. */
  contextTurns?: number;
  /** The reply's earlier sentences. */
  earlier?: number;
  /** Whether the policy's own lines are read too. */
  customGuidance?: boolean;
  /** Whether state hints are read. */
  state?: boolean;
  /** The token budget. */
  maxTokens?: number;
  /** Over budget, whether the call's oldest tokens go first. */
  cutCallFirst?: boolean;
  /** Whether the labels of the bot's previous reply are read. */
  previousTags?: boolean;
}

/** What a model reads, as its config records it was trained. */
export class Layout {
  /** The messages of the call. */
  readonly contextTurns: number;
  /** The reply's earlier sentences. */
  readonly earlier: number;
  /** Whether the policy's own lines are read too. */
  readonly customGuidance: boolean;
  /** Whether state hints are read. */
  readonly state: boolean;
  /** The token budget. */
  readonly maxTokens: number;
  /** Over budget, whether the call's oldest tokens go first. */
  readonly cutCallFirst: boolean;
  /** Whether the labels of the bot's previous reply are read. */
  readonly previousTags: boolean;

  constructor(options: LayoutOptions = {}) {
    this.contextTurns = options.contextTurns ?? 1;
    this.earlier = options.earlier ?? 1;
    this.customGuidance = options.customGuidance ?? false;
    this.state = options.state ?? true;
    this.maxTokens = options.maxTokens ?? 160;
    this.cutCallFirst = options.cutCallFirst ?? false;
    this.previousTags = options.previousTags ?? false;
  }
}

/** Fold an `emotion` signal into a `tone` signal, leaving the others as they are. */
export function fold(heard: PerceptionSignal[] | null): PerceptionSignal[] | null {
  if (!heard || heard.length === 0) {
    return heard;
  }
  const folded: PerceptionSignal[] = [];
  for (const signal of heard) {
    if (signal.name === "emotion" && signal.labels.length > 0) {
      const totals = new Map<string, number>();
      for (const [label, confidence] of signal.labels) {
        const tone = Object.hasOwn(_EMOTION_TO_TONE, label) ? _EMOTION_TO_TONE[label] : undefined;
        if (tone) {
          totals.set(tone, (totals.get(tone) ?? 0.0) + confidence);
        }
      }
      const labels = [...totals]
        .map(([tone, c]): [string, number] => [tone, _round2(Math.min(c, 1.0))])
        .sort((a, b) => b[1] - a[1]);
      folded.push(new PerceptionSignal({ name: "tone", labels: labels.slice(0, 2) }));
    } else {
      folded.push(signal);
    }
  }
  return folded;
}

/**
 * Write one sentence's text pair.
 *
 * @param turn What the model knows of the call.
 * @param earlier The reply's earlier sentences.
 * @param sentence The sentence to label.
 * @param layout What the model reads.
 * @returns The two texts, and where the sentence starts in the second.
 */
export function encode(
  turn: TurnContext,
  earlier: string[],
  sentence: string,
  layout: Layout,
): [string, string, number] {
  const lines: string[] = [];
  for (const m of layout.contextTurns ? turn.messages.slice(-layout.contextTurns) : []) {
    lines.push(
      m.role === "user" ? `caller (${_describe(m.heard)}): ${m.text}` : `agent: ${m.text}`,
    );
  }

  const guidance = turn.policy.guidance.map((g) => String(g));
  const presets = guidance
    .filter((g) => Object.hasOwn(PRESET_NAMES, g))
    .map((g) => PRESET_NAMES[g]);
  const custom = layout.customGuidance
    ? guidance.filter((g) => !Object.hasOwn(PRESET_NAMES, g))
    : [];
  const space = turn.space;
  const header = [
    `tts ${space.tts}`,
    `can ${Object.keys(space.deliveries).join(" ") || "nothing"}`,
    `sounds ${Object.keys(space.sounds).join(" ") || "none"}`,
    `stress ${space.emphasis ? "yes" : "no"}`,
    `policy ${presets.join(", ") || "none"}${custom.length > 0 ? `; ${custom.join(" ")}` : ""}`,
    `caller sounded ${_describe(turn.heard)}`,
  ];
  if (layout.previousTags) {
    header.push(`last reply ${_lastReply(turn.previous)}`);
  }
  if (layout.state) {
    header.push(`state ${_stateHints(turn.messages, sentence).join(", ") || "none"}`);
  }
  const before = layout.earlier ? earlier.slice(-layout.earlier).join(" ") : "";
  const prefix = `${header.join(" | ")} | reply so far: ${before || "-"} | sentence: `;
  return [lines.join("\n"), prefix + sentence, prefix.length];
}

/** Facts from the whole call that the model's short window misses. */
function _stateHints(messages: Message[], sentence: string): string[] {
  const agent = messages.filter((m) => m.role !== "user").map((m) => m.text);
  const user = messages.filter((m) => m.role === "user").map((m) => m.text);
  const hints: string[] = [];
  if (agent.some((text) => _APOLOGY.test(text))) {
    hints.push("apologized before");
  }
  if (user.some((text) => _SLOW_OR_REPEAT.test(text))) {
    hints.push("caller asked to slow down or repeat");
  }
  const details = [...sentence.matchAll(_DETAILS)].map((m) => _normalize(m[0]));
  if (details.length > 0) {
    const said = _normalize(agent.join(" "));
    const lastUser = user.at(-1);
    const last = lastUser !== undefined ? _normalize(lastUser) : "";
    if (details.some((d) => last.includes(d))) {
      hints.push("caller just read this detail back");
    } else if (details.some((d) => said.includes(d))) {
      hints.push("detail given before");
    } else {
      hints.push("new detail");
    }
  }
  return hints;
}

/** The deliveries and sounds the previous reply used, in order: "none" before the first. */
function _lastReply(labels: SentenceLabels[] | null): string {
  if (labels === null) {
    return "none";
  }
  const used: (string | null)[] = [];
  for (const sentence of labels) {
    used.push(
      sentence.soundBefore,
      sentence.delivery,
      ...sentence.spans.map((span) => span.delivery),
      sentence.soundAfter,
    );
  }
  return [...new Set(used.filter((u): u is string => Boolean(u)))].join(" ") || "plain";
}

/** A reading in bands: `"tone sad clear, neutral guess; sarcasm low"`. */
function _describe(heard: PerceptionSignal[] | null): string {
  if (!heard || heard.length === 0) {
    return "no reading";
  }
  const parts: string[] = [];
  for (const signal of heard) {
    if (signal.labels.length > 0) {
      const bands = signal.labels.map(([label, c]) => `${label} ${_band(c)}`).join(", ");
      parts.push(`${signal.name} ${bands}`);
    } else if (signal.value !== null && signal.value !== undefined) {
      parts.push(`${signal.name} ${_level(signal.value)}`);
    }
  }
  return parts.join("; ");
}

function _band(confidence: number): string {
  return confidence >= _CLEAR ? "clear" : confidence >= _LIKELY ? "likely" : "guess";
}

function _level(value: number): string {
  return value >= _CLEAR ? "high" : value >= _LIKELY ? "some" : "low";
}

/** Letters and digits only, spoken digits as digits: "seven Q two" is "7q2". */
function _normalize(text: string): string {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.map((w) => (Object.hasOwn(_DIGIT_WORDS, w) ? _DIGIT_WORDS[w] : w)).join("");
}

/** Python's `round(x, 2)`: to the nearest hundredth, an exact tie to even. */
function _round2(x: number): number {
  // An exact tie in hundredths is an odd number of eighths (x * 8 is exact).
  const eighths = x * 8;
  if (Number.isInteger(eighths) && eighths % 2 !== 0) {
    const floor = Math.floor(x * 100);
    return (floor % 2 === 0 ? floor : floor + 1) / 100;
  }
  // toFixed rounds the exact binary value, as Python does; only its ties differ.
  return Number(x.toFixed(2));
}
