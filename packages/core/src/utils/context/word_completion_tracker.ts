// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/context/word_completion_tracker.py

/** Per-frame bookkeeping for the words a TTS provider reports speaking. */

import { logger } from "../logger.ts";
import { alnumOnly, isSpace } from "../text/alnum_utils.ts";
import { stripCompleteMarkup, stripMarkup } from "../text/markup_utils.ts";
import { TextSegmentMap } from "./text_segment_map.ts";

export interface WordCompletionTrackerOptions {
  /**
   * What the LLM wrote, with any delimiters an aggregator split off
   * (`<card>4111 1111</card>`). Supply it to have each word attributed back
   * to it via `getLlmConsumed`, which is what keeps those delimiters in the
   * conversation context.
   */
  llmText?: string | null;
  /**
   * What a client displays -- no tags, no rewrites. Defaults to `ttsText`
   * with markup stripped.
   */
  userFacingText?: string | null;
}

/**
 * Follows one AggregatedTextFrame from dispatch until it is fully spoken.
 *
 * A TTS provider reports the words it speaks one event at a time. This class
 * consumes those events for a single frame and answers, for each one:
 *
 * - What text should the emitted `TTSTextFrame` carry? -- `getWordForFrame`
 * - Which of the LLM's own text does that stand for? -- `getLlmConsumed`
 * - How much of the frame has been spoken? -- `getAccumulatedUserFacingText`
 *   and `getRemainingUserFacingText`
 * - Is the frame finished? -- the return of `addWordAndCheckComplete`
 * - Did the word run past this frame? -- `getOverflowWord`
 *
 * Three texts describe the same frame, and each answer above is phrased in
 * one of them:
 *
 * | Text             | Example                      | Answers about           |
 * |------------------|------------------------------|-------------------------|
 * | `ttsText`        | `<spell>4111 1111</spell>`   | what was spoken         |
 * | `userFacingText` | `4111 1111`                  | what a UI displays      |
 * | `llmText`        | `<card>4111 1111</card>`     | what the context stores |
 *
 * Keeping a position in all three is the job of `TextSegmentMap`, which this
 * class owns one of and defers to for every question of *where*. What the
 * tracker adds is the handful of decisions a position alone cannot express:
 *
 * - **Providers drop events.** A word the provider never reported has no
 *   event coming, so the next word that does arrive is matched a little
 *   further on and the text passed over is emitted with it. When nothing
 *   matches at all, waiting would stall this frame and everything queued
 *   behind it, so the frame is force-completed instead: the unspoken remainder
 *   is emitted so the context still gets it, and the stray word is handed
 *   back for the next frame to try.
 * - **Some text is never spoken.** A closing `</card>`, or a tag sitting
 *   between the last word and its punctuation, never arrives as its own
 *   event. Whatever is left once everything speakable is done belongs to this
 *   frame, so the word that finishes it claims the rest.
 * - **A word can belong to two frames.** A provider may merge across the
 *   boundary (`"1111And"`). The part that fits stays here; the rest is
 *   exposed as overflow for the caller to feed to the next frame.
 *
 * @example
 * const tracker = new WordCompletionTracker("Hello, world!");
 * tracker.addWordAndCheckComplete("Hello"); // false
 * tracker.addWordAndCheckComplete("world"); // true -- nothing left to speak
 */
export class WordCompletionTracker {
  // --- The three texts ---
  protected _ttsText: string;
  protected _userFacingText: string;
  protected _llmText: string | null;

  // --- Cursors into two of them ---
  // The map owns the authoritative positions; these mirror it, and only
  // diverge where the tracker deliberately moves further (see
  // _recordLlmSpan and _forceComplete). The position in ttsText is not
  // mirrored -- the map's rawPos is read directly.
  protected _userFacingPos = 0;
  protected _llmPos = 0;
  protected _llmSpokenPos = 0;

  // --- Answers about the most recent word ---
  // Rewritten by every addWordAndCheckComplete call and read back through
  // the get* accessors.
  protected _frameWord: string | null = null; // this frame's share of the word
  protected _overflowWord: string | null = null; // the next frame's share
  protected _llmConsumed: string | null = null; // LLM text the word stands for

  // Set by _forceComplete. The map is never advanced there, so its own
  // isComplete would keep saying false; this flag is the answer instead.
  protected _forceCompleted = false;

  protected _segmentMap: TextSegmentMap;

  /**
   * Initialize the tracker with the frame's three texts.
   *
   * Only `ttsText` is required; the other two default to it, which is exactly
   * right for a frame nothing rewrote.
   *
   * @param ttsText What was sent to the TTS, and so what the incoming words
   *   are matched against. May carry synthesis tags (`<spell>...`).
   * @param options.llmText What the LLM wrote (see `WordCompletionTrackerOptions`).
   * @param options.userFacingText What a client displays.
   */
  constructor(ttsText: string, options: WordCompletionTrackerOptions = {}) {
    this._ttsText = ttsText;
    // Stripping markup from the fallback keeps synthesis tags out of what a UI
    // shows, and gives the map a plain run to split around any tag rather than
    // one atomic string.
    this._userFacingText =
      options.userFacingText !== null && options.userFacingText !== undefined
        ? options.userFacingText
        : stripCompleteMarkup(ttsText);
    this._llmText = options.llmText ?? null;
    this._segmentMap = new TextSegmentMap(ttsText, this._userFacingText, this._llmText);
  }

  /**
   * Record one word the TTS provider reported speaking.
   *
   * Three things can happen, in this order:
   *
   * 1. The frame is already finished -- the word is ignored.
   * 2. The word does not match what is left to speak, so the provider must
   *    have dropped an event: the frame is force-completed (see
   *    `_forceComplete`) and this word is handed back as overflow.
   * 3. Otherwise the word advances the frame. Afterwards the `get*` accessors
   *    describe it: this frame's share of the word, the LLM text it stands
   *    for, and how much of the frame is now spoken.
   *
   * @param word One token from the provider's word-timestamp stream. It may
   *   be a plain word, a word carrying its own spacing or punctuation, or a
   *   fragment of a still-open SSML tag -- matching is textual, so none of
   *   those need special handling from the caller. Services that report
   *   spaces and punctuation as separate tokens (e.g. Inworld) must merge
   *   them into the preceding word first, via `mergePunctTokens`.
   * @returns True once nothing is left for this frame to speak.
   */
  addWordAndCheckComplete(word: string): boolean {
    this._frameWord = null;
    this._overflowWord = null;
    this._llmConsumed = null;

    // Every raw character consumed, not isComplete: a frame ending in an
    // emoji contributes no alphanumeric content, so it reads as complete
    // before that emoji's own event arrives, and that event is still wanted.
    if (this._forceCompleted || this._segmentMap.rawPos >= this._ttsText.length) {
      logger.warning(`${this}, trying to add a word in an already complete frame`);
      return true;
    }

    if (!this.wordBelongsHere(word)) {
      return this._forceComplete(word);
    }

    const llmPosBefore = this._llmPos;
    const spokenBefore = this._llmSpokenPos;
    const rawPosBefore = this._segmentMap.rawPos;
    this._segmentMap.advanceWord(word);

    const overflow = this._segmentMap.lastOverflow;
    const spoken = this._ttsText.slice(rawPosBefore, this._segmentMap.rawPos);

    // If the spoken text is longer than the word reported by the provider, the
    // provider skipped some text. Markup does not count because providers don't
    // report tags, and we compare only letters and digits so differences in case,
    // accents, punctuation, or spacing don't affect the check.
    const coversSkippedText = alnumOnly(stripMarkup(spoken)).length > alnumOnly(word).length;

    if (coversSkippedText) {
      // The skipped text will never be reported by the provider, so include it
      // in this frame together with the word that brings the tracker back in sync.
      this._frameWord = spoken;
    } else {
      // Keep only the part of the word that belongs to this frame.
      // The beginning may overlap with text already emitted by the previous
      // frame, while the end may overlap with the next frame.
      const head = this._llmText !== null ? this._segmentMap.lastLeadingDuplicate : 0;
      const tail = overflow ? word.length - overflow.length : word.length;
      this._frameWord = word.slice(head, tail);
    }
    this._overflowWord = overflow;

    this._userFacingPos = this._segmentMap.userFacingPos;
    this._llmPos = this._segmentMap.llmPos;
    this._llmSpokenPos = this._segmentMap.llmSpokenPos;

    if (this._llmText !== null) {
      this._recordLlmSpan(word, llmPosBefore, spokenBefore);
    }

    const complete = this.isComplete;
    if (complete) {
      // Everything speakable has been spoken, so anything still left is
      // text no word will ever arrive for -- a closing tag, or one sitting
      // between the last word and its punctuation. It belongs to this
      // frame, so take it rather than leave it out of the turn.
      this._userFacingPos = this._userFacingText.length;
    }
    return complete;
  }

  /**
   * End this frame early because `word` does not belong to it.
   *
   * The provider dropped one or more events, so the rest of this frame will
   * never be reported. Rather than stall, emit the unspoken remainder as this
   * frame's word -- the conversation context still receives the full text --
   * and hand `word` back as overflow for the next frame to try.
   *
   * The segment map is deliberately left where it is, since nothing here was
   * actually spoken; `_forceCompleted` answers for it from now on.
   *
   * @returns Always true -- the frame is finished.
   */
  protected _forceComplete(word: string): boolean {
    this._frameWord = this._ttsText.slice(this._segmentMap.rawPos);
    this._userFacingPos = this._userFacingText.length;
    if (this._llmText !== null) {
      // The whole remainder is this frame's by definition, tags included.
      this._llmConsumed = this._llmText.slice(this._llmSpokenPos);
      this._llmPos = this._llmText.length;
      this._llmSpokenPos = this._llmText.length;
    }
    this._forceCompleted = true;
    this._overflowWord = word;
    return true;
  }

  /**
   * Move the cursors to the end, for a caller that emits the remainder itself.
   *
   * The accumulated and remaining views then agree with the text that went out.
   */
  takeRemainingAsSpoken(): void {
    this._userFacingPos = this._userFacingText.length;
    if (this._llmText !== null) {
      this._llmPos = this._llmText.length;
      this._llmSpokenPos = this._llmText.length;
    }
  }

  /**
   * Record which part of `llmText` the word just added stands for.
   *
   * Usually that is simply the span the attributed cursor moved over. Two
   * cases reach further, and both leave `_llmPos` ahead of the map's:
   *
   * - **The word finished the frame**: take everything to the end of
   *   `llmText`. The map stops at the last spoken character, so a closing tag
   *   -- which never arrives as its own event -- is still outstanding and
   *   belongs to this word.
   * - **Neither cursor moved**: the map accepted the word without matching it
   *   to anything, as it does for a symbol the source text spells differently
   *   (a provider reporting `->` for `→`). Nothing else will ever report that
   *   character, so the word's own length is spent on it instead.
   *
   * A word inside a transformed segment records nothing, and is checked
   * before that second case: the cursors are held there on purpose, so "did
   * not move" would be misread as "stood for something unmatched" and would
   * walk through text the transform covers. Only the word completing the
   * segment carries its original span.
   *
   * An empty span is not the same as an unmatched word -- it means an earlier
   * word already covered this one, which `suppressInContext` reports so the
   * context does not record it twice.
   */
  protected _recordLlmSpan(word: string, llmPosBefore: number, spokenBefore: number): void {
    const llmText = this._llmText;
    if (llmText === null) {
      throw new Error("_recordLlmSpan requires an llmText");
    }

    if (this.isComplete) {
      this._llmConsumed = llmText.slice(llmPosBefore);
      this._llmPos = llmText.length;
      this._llmSpokenPos = llmText.length;
    } else if (this._segmentMap.inTransformedSegment) {
      this._llmConsumed = null;
    } else if (
      this._llmSpokenPos === spokenBefore &&
      this._llmPos === llmPosBefore &&
      this._segmentMap.lastCompletedSegment === null
    ) {
      // Neither cursor moved, so the map accepted the word without matching
      // it to anything -- a symbol the source text spells differently, which
      // no other event will report. Spend the word's own length so the
      // character it stands for still reaches the context.
      let start = this._llmPos;
      while (start < llmText.length && isSpace(llmText[start])) {
        start += 1;
      }
      const end = start + word.length;
      this._llmConsumed = llmText.slice(start, end);
      this._llmPos = end;
    } else {
      this._llmConsumed = llmText.slice(llmPosBefore, this._llmPos);
    }
  }

  /**
   * Return true if `word` plausibly continues what this frame has left to say.
   *
   * A false answer means the provider dropped an event. Callers ask this
   * before adding a word so they can offer it to the next frame instead;
   * adding it anyway force-completes this one.
   */
  wordBelongsHere(word: string): boolean {
    return this._segmentMap.wordBelongsCurrentSegment(word);
  }

  /**
   * True when the last word must not be written to the conversation context.
   *
   * Two kinds of word answer to this, both of which the context already has
   * covered, or will have:
   *
   * - **One step inside a rewritten span.** `"$42.50"` is spoken as five
   *   words, none of which the transcript should contain; the word that
   *   finishes the span carries `"$42.50"` for all of them.
   * - **A word with no span of its own.** A provider reporting `","` on its
   *   own, after `"Yeah"` took the comma into its span, has nothing left to
   *   record. The context falls back to the spoken text when a word carries
   *   no span, which would store the mark a second time.
   *
   * The word is still emitted either way: the provider spoke it, and a
   * consumer reading the word stream should see it. Without an `llmText`
   * there are no spans at all, so nothing is suppressed and every word is
   * recorded from its spoken text as usual.
   */
  suppressInContext(): boolean {
    return (
      this._segmentMap.inTransformedSegment ||
      (this._llmText !== null && !(this._llmConsumed ?? "").trim())
    );
  }

  /**
   * Return this frame's share of the last word -- the text to emit for it.
   *
   * Usually the whole word. A word straddling the boundary gives up its tail
   * (`"1111"` out of `"1111And"`), and a word that repeats the previous word's
   * punctuation gives up that mark. A word matched past an event the provider
   * never sent brings along the text it passed over, and after a
   * force-complete this is the frame's unspoken remainder instead -- either
   * way, nothing is missing from the turn.
   */
  getWordForFrame(): string | null {
    return this._frameWord ? this._frameWord.trim() : this._frameWord;
  }

  /**
   * Return the part of the last word that belongs to the *next* frame.
   *
   * Feed it to that frame's tracker as if the provider had sent it there.
   * Casing and punctuation are untouched so it still reads as a real word.
   * `null` when the word fit entirely within this frame.
   */
  getOverflowWord(): string | null {
    return this._overflowWord ? this._overflowWord.trim() : this._overflowWord;
  }

  /**
   * Return the LLM's own text that the last word stands for.
   *
   * This is what the conversation context records, so it keeps the tags and
   * spellings the LLM wrote (`"<card>4111"`) rather than what the provider
   * reported speaking (`"4111"`).
   *
   * `null` when there is nothing to attribute: no `llmText` was given, the
   * word is mid-rewrite, or `llmText` is already exhausted (a trailing emoji
   * it never carried).
   */
  getLlmConsumed(): string | null {
    if (!this._llmConsumed) {
      return null;
    }
    return this._llmConsumed.trim() || null;
  }

  /**
   * Return the part of the frame spoken so far, as the user sees it.
   *
   * With `getRemainingUserFacingText` this splits the frame's text in two,
   * which is what lets a client highlight speech as it happens.
   */
  getAccumulatedUserFacingText(): string {
    return this._userFacingText.slice(0, this._userFacingPos);
  }

  /**
   * Return the part of the frame not yet spoken, as the user sees it.
   *
   * @param strip Whether to trim surrounding whitespace. Pass false to keep
   *   the leading space, so accumulated + remaining reproduces the frame's
   *   text exactly -- callers that index into that text rely on it.
   */
  getRemainingUserFacingText(strip = true): string {
    const remaining = this._userFacingText.slice(this._userFacingPos);
    return strip ? remaining.trim() : remaining;
  }

  /**
   * Return everything spoken so far, as it was sent to the TTS.
   *
   * The whole frame up to the cursor, where `getWordForFrame` describes only
   * the most recent word.
   */
  getAccumulatedTtsText(): string {
    return this._ttsText.slice(0, this._segmentMap.rawPos);
  }

  /**
   * Return everything spoken so far, as the LLM wrote it.
   *
   * The whole frame up to the cursor, where `getLlmConsumed` describes only
   * the most recent word. `null` without an `llmText`.
   */
  getAccumulatedLlmText(): string | null {
    if (this._llmText === null) {
      return null;
    }
    return this._llmText.slice(0, this._llmSpokenPos);
  }

  /**
   * Return what this frame still has left to speak.
   *
   * Callers ending a frame early emit this, so text the provider never
   * reported still reaches the conversation context.
   *
   * @param strip Whether to trim surrounding whitespace. Pass false to keep
   *   the leading space, so accumulated + remaining reproduces `ttsText`
   *   exactly.
   */
  getRemainingTtsText(strip = true): string {
    const remaining = this._ttsText.slice(this._segmentMap.rawPos);
    return strip ? remaining.trim() : remaining;
  }

  /**
   * Return what this frame still has left to speak, as the LLM wrote it.
   *
   * The companion to `getRemainingTtsText` when ending a frame early: that
   * supplies the text to emit, this the text to record. `null` without an
   * `llmText`, or when nothing is left.
   */
  getRemainingLlmText(): string | null {
    if (this._llmText === null) {
      return null;
    }
    const remaining = this._llmText.slice(this._llmSpokenPos).trim();
    return remaining ? remaining : null;
  }

  /**
   * True when this frame has nothing left to speak.
   *
   * Alphanumeric content is what counts, so a frame whose remainder is only
   * punctuation or a closing tag is already finished -- no word will ever
   * arrive for those.
   */
  get isComplete(): boolean {
    return this._forceCompleted || this._segmentMap.isComplete;
  }

  /** Rewind to the start of the frame, keeping the three texts. */
  reset(): void {
    this._userFacingPos = 0;
    this._llmPos = 0;
    this._llmSpokenPos = 0;
    this._overflowWord = null;
    this._llmConsumed = null;
    this._frameWord = null;
    this._forceCompleted = false;
    this._segmentMap.reset();
  }

  toString(): string {
    return `${this.constructor.name}(${JSON.stringify(this._ttsText)})`;
  }
}
