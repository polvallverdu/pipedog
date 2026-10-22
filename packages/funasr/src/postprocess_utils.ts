// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Adapted from FunASR's funasr/utils/postprocess_utils.py
// (https://github.com/modelscope/FunASR, MIT License, Copyright (c) 2022 Alibaba).

/**
 * SenseVoice's rich transcription post-processing: a TypeScript port of
 * FunASR's `rich_transcription_postprocess` (and `format_str_v2`).
 *
 * SenseVoice prefixes its text with special tokens, e.g.
 * `<|en|><|NEUTRAL|><|Speech|><|woitn|>hello`: the language, the emotion, the
 * audio event and whether inverse text normalization was applied. This drops
 * the language and ITN tags, turns events into a leading emoji (🎼 👏 😀 😭 🤧 😷)
 * and the dominant emotion into a trailing one (😊 😔 😡 😰 🤢 😮), and merges
 * the segments of multi-language output.
 *
 * Python indexes strings by code point, so the emoji checks here work on code
 * points too (an emoji is two UTF-16 units in JS).
 */

/** Emotion tags and their emoji. */
export const EMO_DICT: Readonly<Record<string, string>> = {
  "<|HAPPY|>": "😊",
  "<|SAD|>": "😔",
  "<|ANGRY|>": "😡",
  "<|NEUTRAL|>": "",
  "<|FEARFUL|>": "😰",
  "<|DISGUSTED|>": "🤢",
  "<|SURPRISED|>": "😮",
};

/** Audio event tags and their emoji. */
export const EVENT_DICT: Readonly<Record<string, string>> = {
  "<|BGM|>": "🎼",
  "<|Speech|>": "",
  "<|Applause|>": "👏",
  "<|Laughter|>": "😀",
  "<|Cry|>": "😭",
  "<|Sneeze|>": "🤧",
  "<|Breath|>": "",
  "<|Cough|>": "😷",
};

/** Language tags (each one starts a new segment). */
export const LANG_DICT: Readonly<Record<string, string>> = {
  "<|zh|>": "<|lang|>",
  "<|en|>": "<|lang|>",
  "<|yue|>": "<|lang|>",
  "<|ja|>": "<|lang|>",
  "<|ko|>": "<|lang|>",
  "<|nospeech|>": "<|lang|>",
};

/** Every special token and what it becomes (insertion order matters). */
export const EMOJI_DICT: Readonly<Record<string, string>> = {
  "<|nospeech|><|Event_UNK|>": "❓",
  "<|zh|>": "",
  "<|en|>": "",
  "<|yue|>": "",
  "<|ja|>": "",
  "<|ko|>": "",
  "<|nospeech|>": "",
  "<|HAPPY|>": "😊",
  "<|SAD|>": "😔",
  "<|ANGRY|>": "😡",
  "<|NEUTRAL|>": "",
  "<|BGM|>": "🎼",
  "<|Speech|>": "",
  "<|Applause|>": "👏",
  "<|Laughter|>": "😀",
  "<|FEARFUL|>": "😰",
  "<|DISGUSTED|>": "🤢",
  "<|SURPRISED|>": "😮",
  "<|Cry|>": "😭",
  "<|EMO_UNKNOWN|>": "",
  "<|Sneeze|>": "🤧",
  "<|Breath|>": "",
  "<|Cough|>": "😷",
  "<|Sing|>": "",
  "<|Speech_Noise|>": "",
  "<|withitn|>": "",
  "<|woitn|>": "",
  "<|GBG|>": "",
  "<|Event_UNK|>": "",
};

const EMO_SET: ReadonlySet<string> = new Set(["😊", "😔", "😡", "😰", "🤢", "😮"]);
const EVENT_SET: ReadonlySet<string> = new Set(["🎼", "👏", "😀", "😭", "🤧", "😷"]);

function count(s: string, sub: string): number {
  return s.split(sub).length - 1;
}

/** Python's `str.strip(" ")`. */
function stripSpaces(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === " ") start++;
  while (end > start && s[end - 1] === " ") end--;
  return s.slice(start, end);
}

/** Python's `s[0]` / `s[-1]` / `s[1:]` / `s[:-1]` by code point. */
function firstChar(s: string): string {
  const cp = s.codePointAt(0);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}
function lastChar(s: string): string {
  if (s.length === 0) return "";
  const lo = s.charCodeAt(s.length - 1);
  if (s.length >= 2 && lo >= 0xdc00 && lo <= 0xdfff) {
    const hi = s.charCodeAt(s.length - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(-2);
  }
  return s.slice(-1);
}
function dropFirst(s: string): string {
  return s.slice(firstChar(s).length);
}
function dropLast(s: string): string {
  return s.slice(0, s.length - lastChar(s).length);
}

/** FunASR's `format_str_v2`: replace one segment's special tokens with emoji. */
export function formatStrV2(s: string): string {
  const sptkCount: Record<string, number> = {};
  for (const sptk of Object.keys(EMOJI_DICT)) {
    sptkCount[sptk] = count(s, sptk);
    s = s.replaceAll(sptk, "");
  }
  let emo = "<|NEUTRAL|>";
  for (const e of Object.keys(EMO_DICT)) {
    if (sptkCount[e]! > sptkCount[emo]!) emo = e;
  }
  for (const e of Object.keys(EVENT_DICT)) {
    if (sptkCount[e]! > 0) s = EVENT_DICT[e] + s;
  }
  s = s + EMO_DICT[emo];

  for (const emoji of [...EMO_SET, ...EVENT_SET]) {
    s = s.replaceAll(` ${emoji}`, emoji);
    s = s.replaceAll(`${emoji} `, emoji);
  }
  return s.trim();
}

/**
 * FunASR's `rich_transcription_postprocess`: turn SenseVoice's raw output
 * (with `<|...|>` tags) into display text with emotion/event emoji.
 */
export function richTranscriptionPostprocess(s: string): string {
  const getEmo = (x: string): string | null => {
    const c = lastChar(x);
    return EMO_SET.has(c) ? c : null;
  };
  const getEvent = (x: string): string | null => {
    const c = firstChar(x);
    return EVENT_SET.has(c) ? c : null;
  };

  s = s.replaceAll("<|nospeech|><|Event_UNK|>", "❓");
  for (const lang of Object.keys(LANG_DICT)) {
    s = s.replaceAll(lang, "<|lang|>");
  }
  const sList = s.split("<|lang|>").map((si) => stripSpaces(formatStrV2(si)));
  let newS = ` ${sList[0]}`;
  let curEntEvent = getEvent(newS);
  for (let i = 1; i < sList.length; i++) {
    let si = sList[i]!;
    if (si.length === 0) continue;
    if (getEvent(si) === curEntEvent && getEvent(si) !== null) {
      si = dropFirst(si);
    }
    if (si.length === 0) continue;
    curEntEvent = getEvent(si);
    if (getEmo(si) !== null && getEmo(si) === getEmo(newS)) {
      newS = dropLast(newS);
    }
    newS += si.trim().trimStart();
  }
  newS = newS.replaceAll("The.", " ");
  return newS.trim();
}
