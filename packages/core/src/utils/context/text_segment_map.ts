// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/context/text_segment_map.py

/**
 * Keeps a position in three versions of the same text as a TTS speaks it.
 *
 * Positions are UTF-16 code unit offsets (upstream counts code points); see
 * `alnum_utils.ts`.
 */

import {
  advanceByAlnums,
  advanceByChars,
  alnumOnly,
  charAt,
  foldForMatching,
  hasAlnum,
  isAlnum,
  isPunctuation,
  isSpace,
  stripTrailingPunctuation,
} from "../text/alnum_utils.ts";
import {
  rawOffsetAfterCleanChars,
  splitMarkupRuns,
  stripCompleteMarkup,
  stripMarkup,
} from "../text/markup_utils.ts";

/** Python's `len(s.split())`. */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w).length;
}

export interface TextSegmentOptions {
  /** The piece as a client displays it. */
  original: string;
  /**
   * The same piece as it was sent to the TTS. Identical to `original` unless
   * something rewrote it, and empty if it was dropped entirely.
   */
  tts: string;
  /** Where the piece starts in the full original text. */
  originalStart: number;
  /**
   * Where it ends. Cursors jump straight here once a rewritten piece is
   * finished, since no position inside one means anything.
   */
  originalEnd: number;
}

/**
 * A piece of the utterance, paired with what the TTS was given in its place.
 *
 * The map is a list of these, laid end to end over the whole utterance. In
 * most of them the two sides are identical; the interesting ones are where a
 * transform, a filter or a tag made them differ (see `isTransformed`).
 *
 * - `original`: the piece as a client displays it.
 * - `tts`: the same piece as it was sent to the TTS. Identical to `original`
 *   unless something rewrote it, and empty if it was dropped entirely.
 * - `originalStart`: where the piece starts in the full original text.
 * - `originalEnd`: where it ends. Cursors jump straight here once a rewritten
 *   piece is finished, since no position inside one means anything.
 */
export class TextSegment {
  readonly original: string;
  readonly tts: string;
  readonly originalStart: number;
  readonly originalEnd: number;

  constructor(options: TextSegmentOptions) {
    this.original = options.original;
    this.tts = options.tts;
    this.originalStart = options.originalStart;
    this.originalEnd = options.originalEnd;
    Object.freeze(this);
  }

  /**
   * True when the two sides cannot be followed together, character by character.
   *
   * A segment like this is all or nothing. The cursors into the other texts
   * wait at its start until every spoken word of it has arrived, then jump
   * straight to its end, because no position inside it means anything.
   *
   * Any one of these makes it true:
   *
   * - the letters and digits differ, as in `"$42.50"` against
   *   `"forty two dollars"`;
   * - the two sides have different numbers of words;
   * - the TTS side has tags in it, even when the words match. The cursor
   *   through the spoken text has tag characters to cross that the other
   *   texts do not have.
   *
   * Only the shape of a tag matters, never its name: `<phoneme
   * ...>Siobhan</phoneme>` counts because of the tags around the word.
   */
  get isTransformed(): boolean {
    if (this.tts !== stripCompleteMarkup(this.tts)) {
      return true;
    }
    if (alnumOnly(this.original) !== alnumOnly(this.tts)) {
      return true;
    }
    return wordCount(this.original) !== wordCount(this.tts);
  }

  /**
   * How many letters and digits the spoken side of this segment has.
   *
   * This is what the provider's words spend as they arrive. On a rewritten
   * segment it has nothing to do with `originalAlnumCount`: "forty two
   * dollars" against "$42.50".
   */
  get ttsAlnumCount(): number {
    return alnumOnly(this.tts).length;
  }

  /**
   * How many letters and digits the original side of this segment has.
   *
   * This is what the cursors into `originalText` and `llmText` spend, since
   * those texts hold the original characters, not the spoken ones.
   */
  get originalAlnumCount(): number {
    return alnumOnly(this.original).length;
  }

  toString(): string {
    return `TextSegment(original=${JSON.stringify(this.original)}, tts=${JSON.stringify(this.tts)}, original_start=${this.originalStart}, original_end=${this.originalEnd})`;
  }
}

/**
 * What happened when a word was offered to one segment.
 *
 * Trying one word against one segment is called a hop. Two of these answers
 * end the attempt; the other two send the word on to the next segment.
 *
 * - `PLACED`: the word fits here. Move to the end of the match and stop.
 * - `CROSSES`: this segment holds only the beginning of the word. Finish the
 *   segment and take the rest of the word to the next one.
 * - `EXHAUSTED`: there is nothing here that can be spoken, so no word will
 *   ever match -- an empty side of the diff, or a lone `<break/>`. Finish the
 *   segment and try the whole word again on the next one.
 * - `NO_MATCH`: nothing here matches the word, usually a symbol the provider
 *   reports differently from the text. Step every cursor past the next run of
 *   punctuation, which the word stands for, and stop.
 */
export const _HopKind = {
  PLACED: 1,
  CROSSES: 2,
  EXHAUSTED: 3,
  NO_MATCH: 4,
} as const;
export type _HopKind = (typeof _HopKind)[keyof typeof _HopKind];

/**
 * The outcome of offering one word to one segment.
 *
 * Produced by `TextSegmentMap._classifyHop`, collected by
 * `TextSegmentMap._planHops`, and acted on by `TextSegmentMap._consumeWord`.
 *
 * - `kind`: which of the four outcomes happened.
 * - `segmentAdvance`: how many characters to move forward in this segment.
 *   The length of the match for `PLACED`, or a step past the next run of
 *   punctuation for `NO_MATCH`. The other two leave it at 0 because they
 *   finish the whole segment anyway.
 * - `wordConsumed`: how many characters of the word this segment used up, and
 *   so how many to drop before offering the rest to the next segment. Only
 *   `CROSSES` sets it; `EXHAUSTED` passes the word on whole.
 */
export interface _Hop {
  readonly kind: _HopKind;
  readonly segmentAdvance: number;
  readonly wordConsumed: number;
}

function hop(
  kind: _HopKind,
  options: { segmentAdvance?: number; wordConsumed?: number } = {},
): _Hop {
  return Object.freeze({
    kind,
    segmentAdvance: options.segmentAdvance ?? 0,
    wordConsumed: options.wordConsumed ?? 0,
  });
}

//
// difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes(), for
// token lists. No junk, so this is the plain Ratcliff/Obershelp matching.
//

type Opcode = ["equal" | "replace" | "delete" | "insert", number, number, number, number];

function getOpcodes(a: readonly string[], b: readonly string[]): Opcode[] {
  const b2j = new Map<string, number[]>();
  b.forEach((elt, j) => {
    let indices = b2j.get(elt);
    if (!indices) {
      indices = [];
      b2j.set(elt, indices);
    }
    indices.push(j);
  });

  const findLongestMatch = (
    alo: number,
    ahi: number,
    blo: number,
    bhi: number,
  ): [number, number, number] => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i] as string) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1;
    }
    return [besti, bestj, bestsize];
  };

  const la = a.length;
  const lb = b.length;
  const queue: [number, number, number, number][] = [[0, la, 0, lb]];
  const matchingBlocks: [number, number, number][] = [];
  while (queue.length > 0) {
    const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
    const x = findLongestMatch(alo, ahi, blo, bhi);
    const [i, j, k] = x;
    if (k) {
      matchingBlocks.push(x);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  matchingBlocks.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);

  let i1 = 0;
  let j1 = 0;
  let k1 = 0;
  const nonAdjacent: [number, number, number][] = [];
  for (const [i2, j2, k2] of matchingBlocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) {
      k1 += k2;
    } else {
      if (k1) nonAdjacent.push([i1, j1, k1]);
      i1 = i2;
      j1 = j2;
      k1 = k2;
    }
  }
  if (k1) nonAdjacent.push([i1, j1, k1]);
  nonAdjacent.push([la, lb, 0]);

  let i = 0;
  let j = 0;
  const answer: Opcode[] = [];
  for (const [ai, bj, size] of nonAdjacent) {
    let tag: Opcode[0] | "" = "";
    if (i < ai && j < bj) tag = "replace";
    else if (i < ai) tag = "delete";
    else if (j < bj) tag = "insert";
    if (tag) answer.push([tag, i, ai, j, bj]);
    i = ai + size;
    j = bj + size;
    if (size) answer.push(["equal", ai, i, bj, j]);
  }
  return answer;
}

/**
 * Answers "where are we?" in three versions of one utterance, word by word.
 *
 * A TTS provider reports the words it speaks. Each report has to be turned
 * into a position -- but into a position in *three* different strings,
 * because the same utterance exists in three forms at once:
 *
 * - `ttsText` -- what was actually spoken, tags and all:
 *   `"Your balance is forty two dollars"`
 * - `originalText` -- what a client displays: `"Your balance is $42.50"`
 * - `llmText` -- what the LLM wrote, so what the transcript should keep:
 *   `"Your balance is <b>$42.50</b>"`. Defaults to `originalText`.
 *
 * For a frame nothing rewrote, all three are the same string and every
 * position is the same.
 *
 * **The hard part is that a spoken word need not appear in the other two.**
 * The provider says `"dollars"`; nothing in `"$42.50"` matches it. So the map
 * is built once, by diffing `ttsText` against `originalText` into aligned
 * `TextSegment` pieces -- each either survived unchanged or was rewritten
 * whole.
 *
 * `llmText` is never compared against the others, and does not need to be.
 * It holds the same letters and digits as `originalText`, in the same order,
 * and differs only in what is wrapped around them -- tags, delimiters,
 * punctuation. So counting letters and digits is enough to keep it in step,
 * and its cursor moves by that count.
 *
 * From then on one real cursor moves: `rawPos`, how far into `ttsText` the
 * provider has got. `userFacingPos` and the two LLM cursors follow it:
 *
 * - Through an **unchanged** segment they keep pace, word for word.
 * - Through a **rewritten** one they wait. There is no honest position
 *   halfway through `"$42.50"` while `"forty two dollars"` is being spoken, so
 *   they hold and then jump to the end of the span in one step when the last
 *   of its words lands.
 *
 * The LLM side carries two of them because one position cannot answer both
 * questions asked of it. `llmSpokenPos` is what the provider has reported;
 * `llmPos` is what has been attributed to a word, and runs ahead of it over a
 * mark stuck to a word the provider has already named. See
 * `_advanceLlmCursors`.
 *
 * Callers ask two things. `wordBelongsCurrentSegment` -- does this token
 * plausibly continue what is left to speak? -- and `advanceWord`, which
 * consumes it. Both tolerate the ways providers mangle tokens (added
 * punctuation, changed case or diacritics, a fragment of a half-open SSML
 * tag) without the caller knowing anything about it; `_classifyHop` holds
 * that logic.
 *
 * A word need not sit at the cursor to be placed. When the provider garbles
 * or drops an event, the next good word still matches a few words on, and the
 * text stepped over -- which no event will ever name -- is consumed with it.
 * So the two questions above stay simple: a token either has a home somewhere
 * in what is left to speak, or it belongs to another utterance entirely.
 *
 * @example
 * // "$42.50" was sent to the TTS as "forty two dollars and fifty cents"
 * const smap = new TextSegmentMap(
 *   "Your balance is forty two dollars and fifty cents",
 *   "Your balance is $42.50",
 * );
 * for (const word of ["Your", "balance", "is"]) {
 *   smap.advanceWord(word); // unchanged: every cursor keeps pace
 * }
 * for (const word of ["forty", "two", "dollars", "and", "fifty"]) {
 *   smap.advanceWord(word); // rewritten: the other two cursors wait
 * }
 * smap.advanceWord("cents"); // the span is done, so they jump to its end
 * // smap.lastCompletedSegment.original === "$42.50"
 * // smap.inTransformedSegment === false
 */
export class TextSegmentMap {
  /** How many words a word may be placed past -- see `_lookaheadHop`. */
  static readonly LOOKAHEAD_WORDS = 3;

  protected _ttsText: string;
  protected _originalText: string;
  protected _llmText: string;
  protected _segments: TextSegment[];

  protected _segIdx = 0;
  protected _segRawPos = 0;
  protected _userFacingPos = 0;
  protected _llmPos = 0;
  protected _llmSpokenPos = 0;
  protected _lastCompleted: TextSegment | null = null;
  protected _lastOverflow: string | null = null;
  protected _lastLeadingDuplicate = 0;

  /**
   * Line the three texts up against each other.
   *
   * The comparison happens once, here. Everything after this only moves
   * cursors.
   *
   * @param ttsText What was sent to the TTS, and so what incoming words are
   *   matched against. May carry synthesis tags and rewritten values.
   * @param originalText The same content as a client displays it, before any
   *   rewriting. Diffed against `ttsText` to build the segments.
   * @param llmText The same content as the LLM wrote it, which may add
   *   delimiters the other two never see. Rides its own cursor rather than
   *   being diffed. Defaults to `originalText`.
   */
  constructor(ttsText: string, originalText: string, llmText: string | null = null) {
    this._ttsText = ttsText;
    this._originalText = originalText;
    this._llmText = llmText !== null && llmText !== undefined ? llmText : originalText;
    this._segments = TextSegmentMap._buildSegments(ttsText, originalText);
    this._resetState();
  }

  /**
   * Compare the two texts and cut them into the segments the map walks.
   *
   * `difflib` lines them up a word at a time and reports each piece as equal,
   * replaced, inserted or deleted. Every piece becomes one `TextSegment`.
   * Spaces are kept as words of their own so that the positions stay exact.
   *
   * One extra step: a piece that came out equal is cut around any tag inside
   * it, so a single tag does not turn the whole sentence into an
   * all-or-nothing segment.
   *
   * Called once, from the constructor.
   */
  protected static _buildSegments(ttsText: string, originalText: string): TextSegment[] {
    const tokenize = (text: string): string[] => text.split(/(\s+)/);

    const origTokens = tokenize(originalText);
    const ttsTokens = tokenize(ttsText);

    // SequenceMatcher lines the two texts up a word at a time. Each piece it
    // reports becomes a TextSegment, positioned in the original text.
    //
    // Example:
    //
    //     originalText = "Your balance is $42.50"
    //     ttsText      = "Your balance is forty two dollars and fifty cents"
    //
    // Tokenization preserves whitespace, so SequenceMatcher sees:
    //
    //     equal:
    //         "Your balance is "
    //
    //     replace:
    //         "$42.50"
    //         ->
    //         "forty two dollars and fifty cents"
    //
    // This produces two segments:
    //
    //     TextSegment(
    //         original="Your balance is ",
    //         tts="Your balance is ",
    //         original_start=0,
    //         original_end=16,
    //     )
    //
    //     TextSegment(
    //         original="$42.50",
    //         tts="forty two dollars and fifty cents",
    //         original_start=16,
    //         original_end=22,
    //     )
    //
    // During playback, unchanged segments advance cursors
    // proportionally. Transformed segments are treated as atomic:
    // the cursors are held while the expanded TTS text is being
    // consumed and jump to original_end only when the entire
    // transformed segment completes.
    const segments: TextSegment[] = [];
    let origPos = 0;

    for (const [tag, i1, i2, j1, j2] of getOpcodes(origTokens, ttsTokens)) {
      const origChunk = origTokens.slice(i1, i2).join("");
      const ttsChunk = ttsTokens.slice(j1, j2).join("");

      // A segment is all-or-nothing as soon as it holds a tag, so one tag in
      // the middle of otherwise identical text would hold the cursors still
      // for the whole piece. Giving the tag a segment of its own limits that
      // to the words the tag wraps:
      //
      //     original = tts = "I love to count <spell>1234</spell>."
      //
      //     "I love to count "       plain, cursors move word by word
      //     "<spell>1234</spell>."   all-or-nothing, lands as one
      //
      // Only equal pieces can be split this way. Both sides hold the same
      // text there, so a single position cuts both. Where the sides differ
      // there is no position that means the same thing on each.
      const parts: [string, string][] =
        tag === "equal"
          ? splitMarkupRuns(origChunk).map((part) => [part, part])
          : [[origChunk, ttsChunk]];

      for (const [origPart, ttsPart] of parts) {
        const origEnd = origPos + origPart.length;
        segments.push(
          new TextSegment({
            original: origPart,
            tts: ttsPart,
            originalStart: origPos,
            originalEnd: origEnd,
          }),
        );
        origPos = origEnd;
      }
    }

    return segments;
  }

  protected _resetState(): void {
    this._segIdx = 0;
    this._segRawPos = 0;
    this._userFacingPos = 0;
    this._llmPos = 0;
    this._llmSpokenPos = 0;
    this._lastCompleted = null;
    this._lastOverflow = null;
    this._lastLeadingDuplicate = 0;
  }

  /**
   * Return `word`, then with its last mark removed, then with every trailing
   * mark removed.
   *
   * A TTS can add punctuation the text it was given never had -- reading a
   * list item `"my account"` as a sentence and reporting `"account."`.
   * Matching tries the word as it arrived first, then the trimmed forms.
   *
   * Dropping only the added mark comes before dropping them all, so the marks
   * the text does have are still matched: `"images:."` lands past the colon
   * in `"images:"`, and `"---."` keeps something to match at all. The
   * variants are tried in order and empty ones are skipped.
   */
  protected static _wordVariants(word: string): string[] {
    const allMarksDropped = stripTrailingPunctuation(word);
    // No trailing mark to drop: "hello" -> ["hello"]
    if (allMarksDropped === word) {
      return [word];
    }

    const lastMarkDropped = word.slice(0, -1);
    // A single trailing mark, so both trims agree: "account." -> ["account.", "account"]
    if (lastMarkDropped === allMarksDropped) {
      return [word, allMarksDropped];
    }

    // Several trailing marks: "images:." -> ["images:.", "images:", "images"]
    return [word, lastMarkDropped, allMarksDropped];
  }

  /**
   * Compare `remainingWord` to each candidate, character for character.
   *
   * Two things can match. If a candidate starts with the word, the word fits
   * here (`PLACED`). If the word starts with a candidate, the candidate ran
   * out first, so the rest of the word belongs to the next segment
   * (`CROSSES`).
   *
   * `_foldedHop` calls this too, on folded copies of the same strings.
   * Folding never changes a string's length, so a position found in a folded
   * copy is the same position in the original.
   *
   * @param candidates `[text, offset]` pairs to match `remainingWord` against,
   *   tried in order.
   * @param remainingWord The word (or its trailing-punctuation-stripped
   *   variant) to match.
   * @param requireWordBoundary When true, the word must end where a word ends
   *   in the candidate -- either it used the candidate up, or the next
   *   character is not a letter or digit. This stops `"account"` from matching
   *   the start of `"Accountant"`. Only the folded pass asks for it, because
   *   folding away case makes that kind of accidental match much easier to hit.
   * @returns A `PLACED` or `CROSSES` hop, or `null` if nothing matched.
   */
  protected static _literalHop(
    candidates: [string, number][],
    remainingWord: string,
    requireWordBoundary = false,
  ): _Hop | null {
    for (const word of TextSegmentMap._wordVariants(remainingWord)) {
      if (!word) {
        continue;
      }
      for (const [candidate, offset] of candidates) {
        if (candidate.startsWith(word)) {
          const landsMidWord =
            requireWordBoundary &&
            word.length < candidate.length &&
            isAlnum(charAt(candidate, word.length));
          if (!landsMidWord) {
            return hop(_HopKind.PLACED, { segmentAdvance: offset + word.length });
          }
        } else if (candidate && word.startsWith(candidate)) {
          return hop(_HopKind.CROSSES, { wordConsumed: candidate.length });
        }
      }
    }
    return null;
  }

  /**
   * Count the characters at the start of `text` that are not letters or digits.
   *
   * For `", I can"` this returns 2 -- the comma and the space.
   *
   * With `stopAtMarkup`, counting also stops at a `'<'`, so the count never
   * reaches inside a tag. Without it, `"<break/>hello"` would count past the
   * `'<'`, and a provider that reports the tag's name `"break"` as a word
   * would look like it had spoken it.
   */
  protected static _leadingNonalnumLen(text: string, stopAtMarkup = false): number {
    let i = 0;
    while (i < text.length) {
      const ch = charAt(text, i);
      if (isAlnum(ch)) {
        break;
      }
      if (stopAtMarkup && ch === "<") {
        break;
      }
      i += ch.length;
    }
    return i;
  }

  /**
   * Return the three starting points a word may be matched against here.
   *
   * Providers disagree about what they include in a word, so the same text is
   * offered from three places, each paired with how far in it starts:
   *
   * 1. The text as it is, for a provider that reports `" world"` with its own
   *    leading space.
   * 2. Past any spaces.
   * 3. Past everything that is not a letter or digit, for a provider that
   *    does not repeat punctuation it already spoke -- when `"I"` arrives for
   *    `"Yeah, I can"`, the `", "` is still waiting here.
   *
   * Each start is further in than the last, so the closest match is tried
   * first. Identical starting points are dropped.
   */
  protected static _matchCandidates(segmentRemaining: string): [string, number][] {
    const leadWs = segmentRemaining.length - segmentRemaining.trimStart().length;
    const leadNonalnum = TextSegmentMap._leadingNonalnumLen(segmentRemaining, true);
    return [...new Set([0, leadWs, leadNonalnum])].map((offset) => [
      segmentRemaining.slice(offset),
      offset,
    ]);
  }

  /**
   * Match `remainingWord` again, ignoring differences in how it is written.
   *
   * A provider may report a word in lower case, without accents, or with
   * plain quotes: `"SQL"` as `"sql"`, `"café"` as `"cafe"`, `"don’t"` as
   * `"don't"`. Folding both sides makes those the same.
   *
   * Folding swaps characters one for one and never adds or removes any, so
   * the strings keep their length and a position found here means the same
   * position in the original text.
   *
   * Because folding hides case, a short word could now match inside a longer
   * one -- `"account"` inside `"Accountant"`. So a match here is only accepted
   * if it ends where a word ends.
   */
  protected static _foldedHop(candidates: [string, number][], remainingWord: string): _Hop | null {
    const foldedCandidates: [string, number][] = candidates.map(([c, offset]) => [
      foldForMatching(c),
      offset,
    ]);
    return TextSegmentMap._literalHop(foldedCandidates, foldForMatching(remainingWord), true);
  }

  /**
   * Match `remainingWord` again, with tags removed from both sides.
   *
   * A provider may report a word wrapped in tags the text it was given did
   * not have, or the other way round. Removing tags from both sides lets the
   * words themselves be compared.
   *
   * The match is found in text that has no tags, so its position has to be
   * translated back to a position in the real text, tags included, by
   * `rawOffsetAfterCleanChars`.
   *
   * Only `PLACED` comes out of this. A word that runs past the end of the
   * segment is left to the two earlier passes.
   */
  protected static _markupHop(segmentRemaining: string, remainingWord: string): _Hop | null {
    const stripped = segmentRemaining.trimStart();
    const leadWs = segmentRemaining.length - stripped.length;
    const haystack = stripMarkup(stripped);

    for (const candidate of TextSegmentMap._wordVariants(stripMarkup(remainingWord))) {
      if (candidate && haystack.startsWith(candidate)) {
        const rawLen = rawOffsetAfterCleanChars(stripped, candidate.length);
        return hop(_HopKind.PLACED, { segmentAdvance: leadWs + rawLen });
      }
    }
    return null;
  }

  /**
   * Look for `remainingWord` a few words further into this segment.
   *
   * Reached only once the three strategies above have all declined, which
   * means the provider garbled or dropped an event and the text at the cursor
   * will never be reported on its own. Matching a word a little further on
   * puts the segment back in step, and the text stepped over is consumed with
   * the word that found it rather than being lost.
   *
   * Two limits keep a coincidence from being read as a recovery. Only whole
   * words anchor the match, so a partial prefix is not enough, and only the
   * next `LOOKAHEAD_WORDS` of them are tried, so a word repeated later in a
   * long segment cannot swallow everything before it.
   *
   * Word separators are what those anchors are found by, so a script written
   * without them -- Japanese, Chinese -- offers a single word start for the
   * whole run and never matches here; frames in one recover through
   * force-complete instead. Spaced scripts, Korean among them, recover
   * normally.
   *
   * `_foldedHop` alone does the matching, since it already demands the whole
   * word this needs and folding only ever widens what matches -- the fold is
   * one character for one, so anything matching literally matches folded too.
   *
   * A segment holding markup is left alone: tag names are made of letters, so
   * a word start inside one would read as something spoken. That also keeps
   * the match from anchoring inside a rewritten span whose words carry tags.
   */
  protected static _lookaheadHop(segmentRemaining: string, remainingWord: string): _Hop | null {
    if (segmentRemaining.includes("<")) {
      return null;
    }

    const wordStarts: number[] = [];
    let prevAlnum = false;
    let i = 0;
    for (const ch of segmentRemaining) {
      const alnum = isAlnum(ch);
      if (alnum && !prevAlnum) {
        wordStarts.push(i);
      }
      prevAlnum = alnum;
      i += ch.length;
    }
    // The first word start is where the strategies above already looked.
    for (const offset of wordStarts.slice(1, 1 + TextSegmentMap.LOOKAHEAD_WORDS)) {
      const candidates: [string, number][] = [[segmentRemaining.slice(offset), offset]];
      const h = TextSegmentMap._foldedHop(candidates, remainingWord);
      if (h !== null && h.kind === _HopKind.PLACED) {
        return h;
      }
    }
    return null;
  }

  /**
   * Decide what `remainingWord` does to the text left in this segment.
   *
   * Everything here is plain string comparison. No tag names are understood,
   * and nothing is remembered between calls.
   *
   * Four ways of matching are tried, each more forgiving than the one before:
   * `_literalHop`, then `_foldedHop`, then `_markupHop`. Any of them can
   * report that the word fits here (`PLACED`) or that it runs past the end of
   * the segment (`CROSSES`). Last comes `_lookaheadHop`, which places the word
   * a few words further in, stepping over text a garbled or dropped event left
   * unaccounted for.
   *
   * If none of them match, the answer depends on what is left in the segment:
   *
   * - `EXHAUSTED` when nothing here can be spoken -- only a tag such as
   *   `<break/>`, or trailing spaces and punctuation. The segment is finished
   *   so the word can try the next one. This is checked last, so a word that
   *   really does match something like a trailing emoji is found by the
   *   passes above first.
   * - `NO_MATCH` otherwise. The word is taken to stand for the next run of
   *   punctuation (see `_unmatchedSymbolLen`), so the cursors step past that
   *   run alone, never past a letter or digit.
   */
  protected static _classifyHop(segmentRemaining: string, remainingWord: string): _Hop {
    const candidates = TextSegmentMap._matchCandidates(segmentRemaining);

    let h = TextSegmentMap._literalHop(candidates, remainingWord);
    if (h === null) {
      h = TextSegmentMap._foldedHop(candidates, remainingWord);
    }
    if (h === null) {
      h = TextSegmentMap._markupHop(segmentRemaining, remainingWord);
    }
    if (h === null) {
      h = TextSegmentMap._lookaheadHop(segmentRemaining, remainingWord);
    }
    if (h !== null) {
      return h;
    }

    // Nothing left here that can be spoken: finish the segment so the word
    // can try the next one.
    if (!hasAlnum(segmentRemaining)) {
      return hop(_HopKind.EXHAUSTED);
    }

    return hop(_HopKind.NO_MATCH, {
      segmentAdvance: TextSegmentMap._unmatchedSymbolLen(segmentRemaining),
    });
  }

  /**
   * Count how far a word that matched nothing moves the cursor.
   *
   * Such a word is usually a symbol the provider reports differently from the
   * text -- `"-"` for `"→"` -- so it stands for the next run of punctuation,
   * and the cursor steps past that run alone:
   *
   *     " → step two"     -> 2, stops before " step"
   *     " → ### **Title**" -> 2, stops before " ###"
   *
   * Stopping at whitespace is what matters: the symbols after it (`###`,
   * `**`) arrive as events of their own, and stepping past them would leave
   * those events nothing to match.
   */
  protected static _unmatchedSymbolLen(segmentRemaining: string): number {
    let i = segmentRemaining.length - segmentRemaining.trimStart().length;
    while (i < segmentRemaining.length) {
      const ch = charAt(segmentRemaining, i);
      if (isAlnum(ch) || isSpace(ch)) {
        break;
      }
      i += ch.length;
    }
    return i;
  }

  /**
   * Move every cursor to `newPos` within `seg`, and finish `seg` if reached.
   *
   * This is where the "keep pace or wait" rule from the class docstring is
   * applied, and the only place the cursors into the other two texts move.
   *
   * **Unchanged segment** -- both sides hold the same text, so the other two
   * cursors keep pace. They move by a count, not a position: however many
   * letters and digits this step used up in the spoken text is how many they
   * move past. `advanceByAlnums` does that, crossing tags for free (which is
   * how a tag travels with the word beside it) and taking any punctuation
   * stuck to the end of the word, so `"you?"` moves as one.
   *
   * **Rewritten segment** -- the other two cursors do not move at all until
   * the segment is finished, then jump straight to its end.
   *
   * Either way a cursor stops before trailing spaces, which belong to
   * whatever comes next.
   */
  protected _advanceCursorsTo(seg: TextSegment, newPos: number): void {
    if (seg.isTransformed) {
      // Whatever is left is only a closing tag or the like, which no word
      // event will ever name. Take it now so the segment can finish.
      // Unchanged segments are not given this: a trailing emoji there is
      // real output, and its own event is still coming.
      if (!hasAlnum(seg.tts.slice(newPos))) {
        newPos = seg.tts.length;
      }
    } else {
      this._keepDerivedCursorsInPace(seg, newPos);
    }

    this._segRawPos = newPos;

    if (newPos >= seg.tts.length) {
      if (seg.isTransformed) {
        this._commitTransformedSpan(seg);
      }
      this._finishSegment(seg);
    }
  }

  /**
   * Move the cursors into the other two texts by what this step just spoke.
   *
   * The user-facing cursor moves by the count of letters and digits consumed
   * here. The two LLM cursors have their own rule -- see `_advanceLlmCursors`.
   */
  protected _keepDerivedCursorsInPace(seg: TextSegment, newPos: number): void {
    const crossed = seg.tts.slice(this._segRawPos, newPos);
    const nAlnum = alnumOnly(crossed).length;
    if (nAlnum) {
      this._userFacingPos = advanceByAlnums(this._originalText, this._userFacingPos, nAlnum);
    } else {
      // A token with no letters or digits to spend -- punctuation set
      // off by a space, as French writes it ("va ?", "Attention :").
      // There is no budget to advance by, so step straight to where the
      // raw cursor got to, and the mark leaves the remaining text now
      // rather than a word later. Both sides are identical here, so that
      // offset is exact.
      this._userFacingPos = seg.originalStart + seg.tts.slice(0, newPos).trimEnd().length;
    }
    this._advanceLlmCursors(crossed, nAlnum);
  }

  /**
   * Move both LLM cursors for a step that just spoke `crossed`.
   *
   * The two answer different questions and so stop in different places,
   * which is the whole reason there are two of them:
   *
   * - `llmSpokenPos` -- what has been **reported spoken**. It crosses exactly
   *   the characters the raw cursor did, so it stops in front of a mark no
   *   event has arrived for.
   * - `llmPos` -- what has been **attributed**. It also takes a mark stuck to
   *   the end of the word, since the conversation context is rebuilt by
   *   joining the attributed spans and every character has to belong to one
   *   of them: `"Yeah,"` then `"I"` reads back correctly where `"Yeah"` then
   *   `", I"` would put a space before the comma.
   *
   * Attribution never moves backwards and never trails what was spoken, so a
   * step that spends no budget on the attributed side -- an emoji, a symbol
   * the source spells differently -- is still credited to the word that
   * crossed it.
   */
  protected _advanceLlmCursors(crossed: string, nAlnum: number): void {
    this._llmSpokenPos = advanceByChars(this._llmText, this._llmSpokenPos, crossed.length);
    this._llmPos = Math.max(
      advanceByAlnums(this._llmText, this._llmPos, nAlnum),
      this._llmSpokenPos,
    );
  }

  /** Jump the other two cursors to the end of `seg`, now that it is done. */
  protected _commitTransformedSpan(seg: TextSegment): void {
    this._userFacingPos = seg.originalEnd;
    // The original's count, not the TTS side's: llmText holds "$42.50"
    // (4 alnums), never the spoken "forty two dollars".
    this._llmPos = advanceByAlnums(this._llmText, this._llmPos, seg.originalAlnumCount);
    // The span is spoken in full or not at all, so both cursors land together.
    this._llmSpokenPos = this._llmPos;
  }

  /** Record `seg` as finished and move on to the next segment. */
  protected _finishSegment(seg: TextSegment): void {
    this._lastCompleted = seg;
    this._segIdx += 1;
    this._segRawPos = 0;
  }

  /**
   * Work out what `word` would do, without moving anything.
   *
   * This decides; `_consumeWord` acts. Keeping them apart is what stops them
   * disagreeing, since `_canConsumeWord` asks the same question and must get
   * the same answer.
   *
   * Most words are placed by the first segment tried, and the walk stops
   * there. It goes on when a segment cannot finish the job -- the word runs
   * past it, or it has nothing speakable left -- and whatever remains of the
   * word is offered to the next segment.
   *
   * @returns What each segment answered, in order, and whatever is left of
   *   the word once the segments run out. Anything left over is the word
   *   running past the end of this text.
   */
  protected _planHops(word: string): [_Hop[], string] {
    let segIdx = this._segIdx;
    let rawPos = this._segRawPos;
    let remainingWord = word;
    const hops: _Hop[] = [];

    while (remainingWord && segIdx < this._segments.length) {
      const h = TextSegmentMap._classifyHop(
        (this._segments[segIdx] as TextSegment).tts.slice(rawPos),
        remainingWord,
      );
      hops.push(h);

      // PLACED and NO_MATCH both end the walk; the other two carry on.
      if (h.kind === _HopKind.PLACED || h.kind === _HopKind.NO_MATCH) {
        return [hops, ""];
      }

      remainingWord = remainingWord.slice(h.wordConsumed);
      segIdx += 1;
      rawPos = 0;
    }

    return [hops, remainingWord];
  }

  /**
   * Move the cursors according to what `_planHops` decided.
   *
   * Anything left unplaced ran past the end of this text and is kept in
   * `lastOverflow`, for the caller to hand to the next frame.
   */
  protected _consumeWord(word: string): void {
    const [hops, overflow] = this._planHops(word);

    for (const h of hops) {
      const seg = this._segments[this._segIdx] as TextSegment;

      if (h.kind === _HopKind.PLACED || h.kind === _HopKind.NO_MATCH) {
        // NO_MATCH is a symbol the provider reports differently from the
        // text ("-" for "→"). It was still spoken, so every cursor moves
        // past the symbol it stands for, the same as a placed word.
        this._advanceCursorsTo(seg, this._segRawPos + h.segmentAdvance);
      } else {
        // CROSSES or EXHAUSTED: this segment is done either way, and the
        // next hop was classified against the one after it.
        this._advanceCursorsTo(seg, seg.tts.length);
      }
    }

    if (overflow) {
      this._lastOverflow = overflow;
    }
  }

  /**
   * Take one spoken word and move every cursor to where it ends.
   *
   * Afterwards `lastCompletedSegment`, `lastOverflow` and
   * `lastLeadingDuplicate` describe what this particular word did; each is
   * cleared at the start of the next call.
   *
   * @param word One token from the provider's word-timestamp stream. It may
   *   be a plain word, a word carrying its own spacing or punctuation, or a
   *   fragment of a half-open tag -- matching is textual, so the caller does
   *   not have to know which.
   */
  advanceWord(word: string): void {
    this._lastCompleted = null;
    this._lastOverflow = null;
    this._lastLeadingDuplicate = 0;

    if (word) {
      this._lastLeadingDuplicate = this._leadingDuplicateLen(word);
      this._consumeWord(word);
    }
  }

  /**
   * Count characters at the start of `word` that were already spoken.
   *
   * In `"Yeah, I can"` the comma travels with `"Yeah"`. If the provider then
   * reports the next word as `", I"` instead of `"I"`, the comma would be
   * recorded twice, so this returns 2 -- the comma and its space.
   *
   * Returns 0 when that punctuation is new text instead (`'"hello'`), and
   * when the word is nothing but punctuation, which is a mark arriving on its
   * own. Must be called before the cursors move, while `llmPos` still sits at
   * the end of the previous word.
   */
  protected _leadingDuplicateLen(word: string): number {
    let i = 0;
    while (i < word.length && (isSpace(word[i]) || isPunctuation(word[i]))) {
      i += 1;
    }
    if (i >= word.length) {
      return 0;
    }
    const mark = word.slice(0, i).trim();
    if (!mark) {
      return 0;
    }
    const start = this._llmPos - mark.length;
    if (start < 0 || this._llmText.slice(start, this._llmPos) !== mark) {
      return 0;
    }
    return i;
  }

  /**
   * Return true if `word` could be the next thing spoken here.
   *
   * `advanceWord` without the moving, so a caller can check first. A false
   * answer means the provider skipped ahead, and the word should go to the
   * next frame instead.
   *
   * A word with no letters or digits gets a second chance from
   * `_symbolBelongsHere`, since there is nothing in it to match on.
   */
  wordBelongsCurrentSegment(word: string): boolean {
    if (!word) {
      return true;
    }
    if (this._canConsumeWord(word)) {
      return true;
    }
    if (!hasAlnum(word)) {
      return this._symbolBelongsHere(word);
    }
    return false;
  }

  /**
   * Ask whether this word would be placed, without placing it.
   *
   * True if some segment would take the word, or if the word simply runs off
   * the end. False if there are no segments left, or a segment turns it down.
   */
  protected _canConsumeWord(word: string): boolean {
    if (this._segIdx >= this._segments.length) {
      return false;
    }

    const [hops] = this._planHops(word);
    return hops.length === 0 || (hops[hops.length - 1] as _Hop).kind !== _HopKind.NO_MATCH;
  }

  /**
   * Decide whether a word made only of punctuation or symbols belongs here.
   *
   * There is nothing in such a word to match on, so it gets two chances:
   *
   * 1. Look for the word itself in the text still to be spoken. The search
   *    starts a little before the cursor, because punctuation is often taken
   *    along with the word before it.
   *
   * 2. Accept it as a stand-in. Some providers report a different symbol than
   *    the one they were given -- ElevenLabs reports `"->"` as `"-"` -- so the
   *    first check can never succeed. If words remain to be spoken and the
   *    next thing in the text is itself a symbol, treat the word as that
   *    symbol.
   */
  protected _symbolBelongsHere(word: string): boolean {
    let pos = this.rawPos;
    let searchStart = pos;
    while (searchStart > 0) {
      const ch = this._ttsText[searchStart - 1];
      if (isAlnum(ch) || isSpace(ch) || ch === ">") {
        break;
      }
      searchStart -= 1;
    }
    if (this._ttsText.slice(searchStart).includes(word)) {
      return true;
    }

    if (this._segIdx >= this._segments.length) {
      return false;
    }

    while (pos < this._ttsText.length && isSpace(this._ttsText[pos])) {
      pos += 1;
    }
    return pos < this._ttsText.length && !isAlnum(charAt(this._ttsText, pos));
  }

  /** How far into the user-facing text the spoken words have reached. */
  get userFacingPos(): number {
    return this._userFacingPos;
  }

  /**
   * How far into the LLM's text has been attributed to a word so far.
   *
   * Ahead of `llmSpokenPos` whenever a word swept up a mark that no event has
   * reported yet; the text between the two is attributed but not yet spoken.
   */
  get llmPos(): number {
    return this._llmPos;
  }

  /**
   * How far into the LLM's text the provider has actually reported speaking.
   *
   * What a caller showing progress, or ending a frame early, should read:
   * text past this point has had no word event, so it still belongs to what
   * is left to say even when `llmPos` has already credited it to a word.
   */
  get llmSpokenPos(): number {
    return this._llmSpokenPos;
  }

  /** How far into `ttsText` the provider has spoken, counted from its start. */
  get rawPos(): number {
    let pos = 0;
    for (const s of this._segments.slice(0, this._segIdx)) {
      pos += s.tts.length;
    }
    if (this._segIdx < this._segments.length) {
      pos += this._segRawPos;
    }
    return pos;
  }

  /**
   * The end of the last word passed to `advanceWord`, if it did not fit.
   *
   * `null` most of the time. It is set only when that word ran past the end
   * of `ttsText`, with no segment left to take the rest, which means the
   * leftover belongs to the next frame. It is always the tail of the word
   * that was passed in, so the part that did fit is
   * `word.slice(0, word.length - lastOverflow.length)`.
   */
  get lastOverflow(): string | null {
    return this._lastOverflow;
  }

  /**
   * How much of the last word's start was punctuation already spoken.
   *
   * The opposite end of the word from `lastOverflow`: that one is about a
   * tail running past this text, this one about a head repeating punctuation
   * the previous word already took. Cut both off to get the part of the word
   * that belongs to this frame:
   *
   *     word.slice(lastLeadingDuplicate, word.length - (lastOverflow ?? "").length)
   */
  get lastLeadingDuplicate(): number {
    return this._lastLeadingDuplicate;
  }

  /**
   * True once every letter and digit in the text has been spoken.
   *
   * This is not the same as the cursor reaching the end. If all that is left
   * is punctuation or tags, the text counts as finished even though those
   * characters have not been walked over, because no word event is coming
   * for them.
   *
   * There is one exception. Punctuation separated from its word by a space,
   * as French writes `"Comment ça va ?"`, does arrive as its own word event,
   * so the text stays unfinished until it does (see
   * `_pendingSeparatedPunctuation`). Punctuation stuck to the word itself, as
   * in `"you?"`, was already taken with the word.
   */
  get isComplete(): boolean {
    if (this._segIdx >= this._segments.length) {
      return true;
    }
    const seg = this._segments[this._segIdx] as TextSegment;
    if (hasAlnum(seg.tts.slice(this._segRawPos))) {
      return false;
    }
    if (TextSegmentMap._pendingSeparatedPunctuation(seg.tts.slice(this._segRawPos))) {
      return false;
    }
    return this._segments.slice(this._segIdx + 1).every((s) => !hasAlnum(s.tts));
  }

  /**
   * True when all that is left is punctuation set off from its word by a space.
   *
   * Some languages write a space before a mark, as in `"va ?"` or
   * `"Bonjour !"`. A TTS reports that mark as a word of its own, so the
   * segment has to stay open until it arrives.
   *
   * Only real punctuation counts. A trailing emoji or arrow (`"day! 😊"`,
   * `"→"`) never arrives as its own word, so it must not keep the segment
   * open, and tags are removed first for the same reason. Only called once no
   * letters or digits are left.
   */
  protected static _pendingSeparatedPunctuation(remaining: string): boolean {
    const strippedMarkup = stripCompleteMarkup(remaining);
    if (!isSpace(strippedMarkup[0])) {
      return false;
    }
    const content = strippedMarkup.trim();
    return content.length > 0 && isPunctuation(charAt(content, 0));
  }

  /** True when the cursor is partway through a rewritten segment. */
  get inTransformedSegment(): boolean {
    if (this._segIdx >= this._segments.length) {
      return false;
    }

    const seg = this._segments[this._segIdx] as TextSegment;
    return seg.isTransformed && this._segRawPos > 0;
  }

  /** The segment finished by the last `advanceWord` call, if any. */
  get lastCompletedSegment(): TextSegment | null {
    return this._lastCompleted;
  }

  /** Put every cursor back to the start of the text. */
  reset(): void {
    this._resetState();
  }
}
