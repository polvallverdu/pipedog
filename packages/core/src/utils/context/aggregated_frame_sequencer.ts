// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/context/aggregated_frame_sequencer.py

/** Ordered sequencer for AggregatedTextFrame slots through TTS processing. */

import {
  AggregatedTextFrame,
  AggregatedTextProgressFrame,
  type Frame,
  TextType,
  TTSTextFrame,
} from "../../frames/frames.ts";
import { logger } from "../logger.ts";
import { matchEndofsentence } from "../string.ts";
import { stripCompleteMarkup } from "../text/markup_utils.ts";
import { SimpleTextAggregator } from "../text/simple_text_aggregator.ts";
import { WordCompletionTracker } from "./word_completion_tracker.ts";

/** Python's `repr()` of a string, for log lines. */
function repr(text: string): string {
  // Python quotes with " when the text holds ' but no ", and only then
  // leaves the ' unescaped.
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let body = text
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  if (quote === "'") body = body.replace(/'/g, "\\'");
  return `${quote}${body}${quote}`;
}

/** Python's `" ".join(text.split())`: collapse whitespace runs to one space. */
function joinWords(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/**
 * One completed sentence, in each of the sequencer's three parallel channels.
 *
 * - `ttsText`: the sentence as sent to the TTS service (post-filter/transform).
 * - `llmText`: the sentence in the original LLM text (with any pattern delimiters).
 * - `userFacingText`: the sentence as shown to the user (no TTS tags/transforms).
 */
export interface _ParallelAggregation {
  ttsText: string;
  llmText: string;
  userFacingText: string;
}

/**
 * Internal: groups streamed tokens back into sentences for the sequencer.
 *
 * Used by `AggregatedFrameSequencer` when a TTS service streams tokens
 * individually (`TextAggregationMode.TOKEN`) but still needs whole-sentence
 * units for word-timestamp tracking and RTVI progress. Each token contributes
 * one part to each of the three channels (tts / llm / user-facing); sentence
 * completion is driven by the **TTS text** and completes all three together.
 *
 * Boundary timing: a sentence-ending boundary is only *confirmed* by
 * lookahead — the first non-whitespace character of the *next* sentence. So
 * the underlying `SimpleTextAggregator` only yields "Hi there!" once the
 * following non-whitespace character has arrived.
 *
 * Splitting granularity: token streams are not guaranteed to be one word or
 * one punctuation mark per token — an upstream can deliver a coarse chunk that
 * carries the tail of one sentence *and* the head of the next (e.g. "Hey" then
 * " there! I'm ..."). Two cases:
 *
 * - When every token accumulated for the pending sentence has identical text
 *   in all three channels (the common case — no TTS transform/tag rewriting is
 *   active), a boundary is sliced *inside* the triggering token at its
 *   confirmed offset, so " there!" stays with "Hey" and only " I'm ..."
 *   carries over.
 * - When a transform has made the channels differ in length, the channels can
 *   no longer be split at a shared character offset, so the boundary is cut at
 *   the token boundary instead: the text accumulated *before* the triggering
 *   token is emitted and the whole triggering token begins the next sentence's
 *   buffer.
 */
export class _ParallelSentenceAggregator {
  protected _aggregator: SimpleTextAggregator;
  // Tokens accumulated since the last emitted sentence, per channel.
  protected _tts = "";
  protected _llm = "";
  protected _user = "";
  // Whether every token accumulated for the pending sentence has identical
  // text across the three channels. While true the tts buffer mirrors the
  // inner aggregator's buffer, so a boundary can be sliced inside a token.
  protected _aligned = true;

  /**
   * Initialize empty channels using the context's sentence language.
   *
   * @param language Language code for this context.
   */
  constructor(language: string | null = null) {
    // A plain SENTENCE-mode aggregator drives boundary detection on the TTS
    // text. The TTS text is already post-transform, so tag/pattern-aware
    // boundary rules are not needed here.
    this._aggregator = new SimpleTextAggregator({
      aggregationType: TextType.SENTENCE,
      language,
    });
    this._reset();
  }

  /** Use the supplied language for subsequent text without clearing buffers. */
  setLanguage(language: string | null): void {
    this._aggregator.setLanguage(language);
  }

  protected _reset(): void {
    this._tts = "";
    this._llm = "";
    this._user = "";
    this._aligned = true;
  }

  /** The inner aggregator's buffer (its protected `_text`). */
  protected get _aggregatorText(): string {
    return (this._aggregator as unknown as { _text: string })._text;
  }

  /**
   * Feed one token (all three channels) and yield any completed sentences.
   *
   * @param ttsText The token as sent to the TTS service.
   * @param llmText The token in the original LLM text.
   * @param userFacingText The token as shown to the user.
   * @returns A `_ParallelAggregation` for each sentence this token confirms.
   *   Usually zero or one, but a coarse chunk carrying several sentence
   *   endings can confirm more than one at once.
   */
  async *aggregate(
    ttsText: string,
    llmText: string,
    userFacingText: string,
  ): AsyncGenerator<_ParallelAggregation> {
    const tokenIdentical = ttsText === llmText && llmText === userFacingText;

    // The inner SENTENCE aggregator is the source of truth for *when* and *how
    // many* boundaries are confirmed (it applies the lookahead rule char by
    // char on the TTS text).
    let boundaryCount = 0;
    for await (const _ of this._aggregator.aggregate(ttsText)) {
      boundaryCount += 1;
    }

    if (boundaryCount && this._aligned && tokenIdentical) {
      // Channels are identical for the whole pending sentence, so the tts
      // buffer mirrors the inner aggregator's buffer and we can slice inside
      // this token at each confirmed boundary, keeping the channels aligned.
      const combined = this._tts + ttsText;
      let idx = 0;
      for (let n = 0; n < boundaryCount; n++) {
        const boundary = matchEndofsentence(combined.slice(idx), {
          language: this._aggregator.language,
        });
        if (boundary <= 0) {
          break;
        }
        const sentence = combined.slice(idx, idx + boundary);
        yield { ttsText: sentence, llmText: sentence, userFacingText: sentence };
        idx += boundary;
      }
      // The remainder came from identical channels, so the next pending
      // sentence starts aligned and its buffer still mirrors the inner one.
      const rest = combined.slice(idx);
      this._tts = rest;
      this._llm = rest;
      this._user = rest;
      this._aligned = true;
      return;
    }

    // A transform has diverged the channels (or nothing is buffered before this
    // token): we can only cut at the token boundary. Emit whatever was buffered
    // before this token and let this token begin the next sentence's buffer.
    if (boundaryCount && (this._tts || this._llm || this._user)) {
      yield { ttsText: this._tts, llmText: this._llm, userFacingText: this._user };
      this._tts = "";
      this._llm = "";
      this._user = "";
    }

    // Plain concatenation: LLM tokens already carry their own spacing.
    this._tts += ttsText;
    this._llm += llmText;
    this._user += userFacingText;
    // Re-derive alignment from ground truth rather than assuming a token-boundary
    // cut restores it.
    this._aligned =
      this._tts === this._llm && this._llm === this._user && this._tts === this._aggregatorText;
  }

  /**
   * Emit any trailing partial sentence at end of turn.
   *
   * @returns A `_ParallelAggregation` for the accumulated-but-unemitted text,
   *   or `null` when nothing substantive is buffered.
   */
  async flush(): Promise<_ParallelAggregation | null> {
    await this._aggregator.flush();
    // A trailing tag has no words to show, but is still text the LLM wrote.
    if (this._user.trim() || this._llm.trim()) {
      const result = { ttsText: this._tts, llmText: this._llm, userFacingText: this._user };
      this._reset();
      return result;
    }
    return null;
  }

  /** Discard all buffered text (called on interruption/reset). */
  async handleInterruption(): Promise<void> {
    await this._aggregator.handleInterruption();
    this._reset();
  }
}

/**
 * Ordered slot tracking one AggregatedTextFrame through TTS processing.
 *
 * Every frame that passes through _handleAggregatedText — whether spoken or
 * skipped — occupies a slot in the sequencer. Skipped frames wait at their
 * position and are emitted downstream only after all preceding spoken slots
 * are complete, preserving correct context ordering.
 */
export interface _AggregatedFrameSlot {
  frame: AggregatedTextFrame;
  contextId: string;
  spoken: boolean;
  tracker: WordCompletionTracker | null;
  transportDestination: string | null;
  complete: boolean;
  includesInterFrameSpaces: boolean;
}

function newSlot(
  options: Pick<_AggregatedFrameSlot, "frame" | "contextId" | "spoken"> &
    Partial<_AggregatedFrameSlot>,
): _AggregatedFrameSlot {
  return {
    tracker: null,
    transportDestination: null,
    complete: false,
    includesInterFrameSpaces: false,
    ...options,
  };
}

/**
 * A word-timestamp event held until the slot it belongs to is promoted.
 *
 * In streaming mode a word can arrive before the sentence it belongs to has
 * been promoted into a real slot. The event is parked here and replayed once
 * a matching slot appears (see `AggregatedFrameSequencer._drainBufferedWords`).
 */
export interface _BufferedWord {
  word: string;
  pts: number;
  contextId: string | null;
  includesInterFrameSpaces: boolean;
}

/**
 * Per-context streaming (TOKEN-mode) state.
 *
 * Each concurrently-live audio context keeps its own token→sentence
 * aggregator and the slot metadata a promoted sentence needs, so two contexts
 * in flight at once never share one pending-sentence buffer.
 *
 * - `aggregator`: groups this context's streamed tokens back into sentences.
 * - `appendToContext`: whether word frames built for a promoted sentence
 *   should carry `appendToContext=true`. Turn-constant for the context.
 * - `buildTracker`: whether a promoted sentence should get a
 *   `WordCompletionTracker` (word-timestamp services) or complete immediately
 *   on promotion (pushTextFrames=true services). Turn-constant for the context.
 * - `textType`: the text type of a promoted sentence: `SENTENCE` for streamed
 *   tokens, or the type the context's text was given with, such as a
 *   `TTSSpeakFrame`'s.
 */
export interface _StreamingContext {
  aggregator: _ParallelSentenceAggregator;
  appendToContext: boolean;
  buildTracker: boolean;
  textType: TextType | string;
}

export interface AggregatedFrameSequencerOptions {
  /** Label used in log messages (typically the owning TTS service name). */
  name?: string;
  /**
   * True when tokens are dispatched to the TTS individually
   * (`TextAggregationMode.TOKEN`). Each `registerSpoken` call then represents
   * one token rather than a complete unit, so tokens are fed to a
   * `_ParallelSentenceAggregator` and only turned into a real slot once a
   * sentence boundary is detected (or forced via `registerSkipped`/`finalize`).
   * Fixed for the life of the sequencer — a TTS service's aggregation mode
   * never changes at runtime.
   *
   * Requires the owning TTS service to reuse one context ID for the whole
   * turn (`reuseContextIdWithinTurn=true`, the default): a promoted sentence
   * built from several tokens is registered under a single context ID, and
   * word-timestamp events for all of its tokens must arrive tagged with that
   * same ID. A per-token context ID would leave every token but the last
   * unmatched, and its words dropped as stale.
   */
  streaming?: boolean;
}

export interface RegisterSpokenOptions {
  /**
   * Whether to track word completion at all. False for pushTextFrames=true
   * services, which complete via completeSpokenSlot instead of word-timestamp
   * matching. Defaults to true.
   */
  buildTracker?: boolean;
  /**
   * When true, every TTSTextFrame emitted for this slot carries
   * `includesInterFrameSpaces=true` so downstream consumers do not inject
   * extra spaces between consecutive frames. Not used on the streaming path —
   * there, CJK spacing is driven solely by `processWord`'s per-call flag.
   */
  includesInterFrameSpaces?: boolean;
  /**
   * Sentence tokenizer for this text and subsequent boundary checks on the
   * context's pending sentence.
   */
  language?: string | null;
}

interface BuildWordFrameOptions {
  segmentId?: number | null;
  rawText?: string | null;
  suppressInContext?: boolean;
  includesInterFrameSpaces?: boolean;
}

/**
 * Sequences AggregatedTextFrame slots to preserve TTS context ordering.
 *
 * Manages an ordered queue of spoken and skipped TTS slots. Spoken slots are
 * tracked via a `WordCompletionTracker`; skipped slots (e.g. code blocks
 * excluded from TTS synthesis) wait in-place until all preceding spoken slots
 * are complete, then are flushed downstream with `appendToContext=true`.
 *
 * Most methods are synchronous and return lists of frames the caller should
 * push downstream, making the sequencer easily testable. The exceptions are
 * `registerSpoken`, `registerSkipped`, and `finalize`, which are async because
 * — when the sequencer is built with `streaming: true` — they drive an async
 * `_ParallelSentenceAggregator` to group streamed tokens into sentences.
 *
 * Contexts can be in flight concurrently (e.g. two back-to-back
 * `TTSSpeakFrame` utterances on a websocket TTS service whose `runTts`
 * returns before synthesis finishes). State is organised in three tiers so
 * concurrent contexts never bleed into each other:
 *
 * - `_slots`: the single global ordered timeline across all contexts.
 *   Ordering is the whole point of the sequencer, so this stays one list.
 * - `_contextAppendToContext`: a per-context flag whose presence also marks
 *   the context as *live* — an entry existing is the "process this context's
 *   words" signal in `processWord`'s stale gate. Created at slot registration,
 *   removed when the context is fully done (`forceComplete`).
 * - `_streamingContexts`: transient per-context pending-sentence state
 *   (`_StreamingContext`), present only while a sentence is being accumulated
 *   from tokens. Released at end of text input (`finalize`).
 *
 * @example
 * const sequencer = new AggregatedFrameSequencer();
 * await sequencer.registerSpoken(frame, ctxId, ttsText, true);
 * for (const f of sequencer.processWord("hello", 1000, ctxId)) {
 *   await this.pushFrame(f);
 * }
 */
export class AggregatedFrameSequencer {
  protected _name: string;
  protected _streaming: boolean;
  // Tags only the LLM's text carries, such as expressive conversation's,
  // which word tracking passes over in it. Set by the TTS service.
  llmMarkup: RegExp | null = null;
  protected _slots: _AggregatedFrameSlot[] = [];
  protected _contextAppendToContext = new Map<string, boolean>();
  // Transient per-context pending-sentence state, keyed by context ID. An entry
  // exists only while a sentence is being accumulated from tokens for that
  // context (streaming mode only). Aggregators are created lazily per context.
  protected _streamingContexts = new Map<string, _StreamingContext>();
  protected _bufferedWords: _BufferedWord[] = [];

  /**
   * Initialize the sequencer.
   *
   * @param options.name Label used in log messages. Defaults to
   *   "AggregatedFrameSequencer".
   * @param options.streaming True when tokens are dispatched to the TTS
   *   individually (see `AggregatedFrameSequencerOptions.streaming`).
   */
  constructor(options: AggregatedFrameSequencerOptions = {}) {
    this._name = options.name ?? "AggregatedFrameSequencer";
    this._streaming = options.streaming ?? false;
  }

  /**
   * Register a spoken AggregatedTextFrame slot.
   *
   * Called from _handleAggregatedText for every frame sent to the TTS service
   * (one call per token when `streaming`, one call per complete unit
   * otherwise). Builds the `WordCompletionTracker` internally when
   * `buildTracker` is set — callers never construct one themselves. A
   * registered slot is marked complete either via `processWord`
   * (word-timestamp services) or `completeSpokenSlot` (pushTextFrames=true
   * services).
   *
   * When the sequencer is non-streaming, this registers a slot immediately.
   * When streaming — whether or not `buildTracker` is set — the call instead
   * feeds this token to the `_ParallelSentenceAggregator` and only registers a
   * real slot once a sentence boundary is confirmed there; a
   * pushTextFrames=true (no-tracker) slot completes immediately on promotion
   * (see `_promote`) since there is no word-timestamp signal to complete it
   * progressively.
   *
   * @param frame The AggregatedTextFrame being spoken (one token when streaming).
   * @param contextId The TTS context ID assigned to this frame.
   * @param ttsText The text actually sent to the TTS for this call (may differ
   *   from `frame.text` after filters/transforms).
   * @param appendToContext Whether word frames built for this context should
   *   carry appendToContext=true.
   * @param options See `RegisterSpokenOptions`.
   * @returns Frames unblocked by this call (a promoted sentence and/or
   *   buffered words replayed once a pending sentence promotes). Always empty
   *   for the non-streaming case.
   */
  async registerSpoken(
    frame: AggregatedTextFrame,
    contextId: string,
    ttsText: string,
    appendToContext: boolean,
    options: RegisterSpokenOptions = {},
  ): Promise<Frame[]> {
    const buildTracker = options.buildTracker ?? true;
    const includesInterFrameSpaces = options.includesInterFrameSpaces ?? false;
    const language = options.language ?? null;

    if (!this._streaming) {
      this._appendSpokenSlot(
        frame,
        contextId,
        buildTracker
          ? new WordCompletionTracker(ttsText, {
              llmText: frame.rawText || frame.text,
              userFacingText: frame.text,
              llmMarkup: this.llmMarkup,
            })
          : null,
        appendToContext,
        includesInterFrameSpaces,
      );
      return [];
    }

    let sc = this._streamingContexts.get(contextId);
    if (!sc) {
      sc = {
        aggregator: new _ParallelSentenceAggregator(language),
        appendToContext,
        buildTracker,
        textType: frame.textType === TextType.TOKEN ? TextType.SENTENCE : frame.textType,
      };
      this._streamingContexts.set(contextId, sc);
    }
    sc.aggregator.setLanguage(language);
    const frames: Frame[] = [];
    for await (const agg of sc.aggregator.aggregate(
      ttsText,
      frame.rawText || frame.text,
      frame.text,
    )) {
      frames.push(...this._promote(agg, contextId, sc));
    }
    return frames;
  }

  /**
   * Register a skipped AggregatedTextFrame and attempt an immediate flush.
   *
   * Any sentence still pending for this context is finalized first, so a real
   * spoken slot exists immediately before the skipped slot in the queue —
   * `flush`'s "stop at first incomplete spoken slot" logic then blocks this
   * skipped frame correctly until that sentence is actually spoken.
   *
   * The frame is appended as a skipped slot. If no incomplete spoken slot
   * precedes it, the frame is returned right away; otherwise it waits until a
   * later `flush` unblocks it.
   *
   * @param frame The skipped AggregatedTextFrame (e.g. a code block).
   * @param contextId The context ID assigned in _handleAggregatedText.
   * @param transportDestination Transport routing value to attach at flush time.
   * @returns The frames to push downstream — any sentence promoted by the
   *   initial `finalize` (streaming mode), followed by this skipped frame once
   *   it is unblocked. The skipped frame itself is absent while a preceding
   *   spoken slot is still incomplete — the promoted-sentence frame can still
   *   be returned in that case, so the list is not necessarily empty when
   *   blocked.
   */
  async registerSkipped(
    frame: AggregatedTextFrame,
    contextId: string,
    transportDestination: string | null,
  ): Promise<Frame[]> {
    const frames = await this.finalize(contextId);
    frame.contextId = contextId;
    this._slots.push(
      newSlot({
        frame,
        contextId,
        spoken: false,
        transportDestination,
      }),
    );
    frames.push(...this.flush());
    return frames;
  }

  /**
   * Force-promote a context's still-pending sentence into a real slot.
   *
   * Called at end of text input for a context (no more tokens are coming), to
   * handle a response that ends with no terminal punctuation. The context's
   * pending-sentence state is released here; its `_contextAppendToContext`
   * entry is deliberately kept, since word-timestamp events for the
   * just-promoted slot still arrive later (during audio playback) and must be
   * recognised as live. A no-op when nothing is pending for the context (or
   * the sequencer is not streaming).
   *
   * @param contextId The context whose pending sentence should be finalized.
   * @returns Frames unblocked by finalizing (e.g. buffered words that can now
   *   be replayed against the newly-registered slot).
   */
  async finalize(contextId: string | null): Promise<Frame[]> {
    if (!this._streaming || contextId === null) {
      return [];
    }
    const sc = this._streamingContexts.get(contextId);
    this._streamingContexts.delete(contextId);
    if (!sc) {
      return [];
    }
    const agg = await sc.aggregator.flush();
    return agg ? this._promote(agg, contextId, sc) : [];
  }

  /**
   * Process one word-timestamp event and return frames to push downstream.
   *
   * Locates the active slot (the first incomplete spoken slot with a tracker
   * for this `contextId`), advances it by the incoming word, and builds a
   * `TTSTextFrame`. Handles:
   *
   * - Words from a context that was never registered, was wiped by `clear` on
   *   interruption, or has already completed (`forceComplete` removes its
   *   entry): dropped as stale (returns an empty list).
   * - Normal words that fit entirely within the active slot.
   * - Overflow words straddling two slot boundaries.
   * - Force-complete when the TTS drops an event (word belongs to the next slot).
   * - Drop for a word no slot recognises, which is not this turn's text. The
   *   slot is left where it is, and the next word that does match carries the
   *   text this one should have covered; only what no later word accounts for
   *   waits for `forceComplete` at the end of the audio context. When
   *   streaming, such a word is buffered instead, since the slot it belongs to
   *   may simply not be promoted yet.
   * - Flushes any skipped slots unblocked by slot completion.
   *
   * @param word A word token from the TTS service word-timestamp stream.
   * @param pts Presentation timestamp (nanoseconds) to assign to the frame.
   * @param contextId TTS context ID from the word-timestamp event.
   * @param includesInterFrameSpaces Stamped onto the emitted TTSTextFrame so
   *   downstream consumers know not to inject extra spaces between frames.
   * @returns Ordered list of frames (TTSTextFrame and/or AggregatedTextFrame)
   *   to push.
   */
  processWord(
    word: string,
    pts: number,
    contextId: string | null,
    includesInterFrameSpaces = false,
  ): Frame[] {
    // Drop words from contexts we never registered, that were wiped by clear() on
    // interruption, or that have already fully completed (forceComplete removes the
    // entry). Such a word is stale (e.g. delayed word-timestamps the TTS server
    // delivers seconds after the context was cancelled); emitting it would interleave
    // it into the current turn's transcript. A null contextId is left untouched:
    // services without audio contexts legitimately use the passthrough path below. A
    // word for a context still streaming a pending sentence (no slot promoted yet) is
    // not stale — it's handled by the buffering below.
    const isPendingStreamingCtx = contextId !== null && this._streamingContexts.has(contextId);
    if (
      contextId !== null &&
      !this._contextAppendToContext.has(contextId) &&
      !isPendingStreamingCtx
    ) {
      logger.debug(
        `${this._name} Dropping stale word '${word}' from unknown/cleared context ${contextId}`,
      );
      return [];
    }

    const active = this._getActiveSlot(contextId);
    let isComplete = false;
    let rawOverflowWord: string | null = null;

    if (active?.tracker) {
      if (!active.tracker.wordBelongsHere(word)) {
        const nextSlot = this._getNextActiveSlot(active, contextId);
        const wordFitsNext = nextSlot?.tracker?.wordBelongsHere(word) ?? false;
        if (!wordFitsNext) {
          if (this._streaming) {
            this._bufferedWords.push({ word, pts, contextId, includesInterFrameSpaces });
            return [];
          }
          // Nothing left in this turn's text can be what was reported.
          // Emitting it anyway would write words the LLM never wrote into
          // the conversation context. Dropping it loses nothing: the slot
          // keeps its place, so the next word that does match is matched
          // past this one and carries the text it should have covered.
          // Only text no later word accounts for waits for
          // forceComplete, when the audio context ends.
          logger.warning(`${this._name} Dropping word '${word}' not recognised by any slot.`);
          return [];
        }
      }

      isComplete = active.tracker.addWordAndCheckComplete(word);
      rawOverflowWord = active.tracker.getOverflowWord();
    } else if (this._streaming && active === null) {
      this._bufferedWords.push({ word, pts, contextId, includesInterFrameSpaces });
      return [];
    }

    // Give preference to the per-call flag; fall back to the slot's flag.
    // Also propagate the per-call flag onto the slot so forceComplete inherits it.
    if (active && includesInterFrameSpaces) {
      active.includesInterFrameSpaces = true;
    }
    const slotIfs = includesInterFrameSpaces || (active ? active.includesInterFrameSpaces : false);

    const frameText = active?.tracker ? active.tracker.getWordForFrame() : word;
    const rawText = active?.tracker ? active.tracker.getLlmConsumed() : null;
    const suppress = active?.tracker ? active.tracker.suppressInContext() : false;
    const emitContextId = active ? active.contextId : contextId;

    const frames: Frame[] = [];
    if (frameText) {
      frames.push(
        this._buildWordFrame(frameText, pts, emitContextId, {
          segmentId: active ? active.frame.id : null,
          rawText,
          suppressInContext: suppress,
          includesInterFrameSpaces: slotIfs,
        }),
      );
    }

    if (active?.tracker && !suppress) {
      frames.push(this._buildProgressFrame(active, pts));
    }

    if (isComplete && active) {
      active.complete = true;
      frames.push(...this.flush(pts));
      if (rawOverflowWord) {
        logger.debug(`${this._name} Emitting overflow word '${rawOverflowWord}'`);
        frames.push(...this.processWord(rawOverflowWord, pts, contextId));
      }
    }

    return frames;
  }

  /**
   * Mark the first pending spoken slot complete and flush unblocked skipped frames.
   *
   * Used by pushTextFrames=true services: non-streaming callers invoke this
   * directly after appending the unit's TTSTextFrame to the audio context;
   * `_promote` calls it internally for a streaming (no-tracker) sentence,
   * immediately on promotion. Only ever targets a buildTracker=false slot (a
   * word-timestamp slot completes via `processWord` instead), so "first
   * pending" is always the caller's own slot even with multiple contexts in
   * flight — such slots complete synchronously, one at a time, in the same
   * call chain that registers them.
   *
   * @returns AggregatedTextFrame(s) that are now unblocked and should be pushed.
   */
  completeSpokenSlot(): Frame[] {
    const slot = this._slots.find((s) => s.spoken && !s.complete);
    if (slot) {
      slot.complete = true;
    }
    return this.flush();
  }

  /**
   * Walk the slot queue and return all skipped frames that are now unblocked.
   *
   * Removes complete spoken slots from the head of the queue, then emits (and
   * removes) skipped slots whose preceding spoken slots are all done. Stops at
   * the first incomplete spoken slot.
   *
   * @param lastWordPts When provided, skipped frames receive this PTS so they
   *   appear immediately after the last spoken word in the timeline.
   * @returns AggregatedTextFrame(s) ready to be pushed downstream.
   */
  flush(lastWordPts: number | null = null): Frame[] {
    const frames: Frame[] = [];
    while (this._slots.length > 0) {
      const slot = this._slots[0] as _AggregatedFrameSlot;
      if (slot.spoken && slot.complete) {
        this._slots.shift();
      } else if (!slot.spoken && !slot.complete) {
        slot.frame.appendToContext = true;
        slot.frame.transportDestination = slot.transportDestination;
        if (lastWordPts) {
          slot.frame.pts = lastWordPts;
        }
        logger.debug(`${this._name}: Flushing Aggregated Frame ${slot.frame}`);
        frames.push(slot.frame);
        slot.complete = true;
        this._slots.shift();
      } else {
        break; // spoken but not yet complete — wait
      }
    }
    return frames;
  }

  /**
   * Force-complete a context's incomplete spoken slots and flush skipped frames.
   *
   * Called at the end of an audio context to handle TTS providers that
   * silently drop word-timestamp events. Emits a TTSTextFrame for any
   * remaining unspoken text in each incomplete slot *belonging to this
   * context*, marks it complete, then flushes all now-unblocked skipped
   * frames. Slots for other contexts still in flight are left untouched so
   * their own word events (or their own forceComplete) finish them.
   *
   * Audio contexts are drained one at a time in registration order (a
   * context's whole `_handleAudioContext` runs, ending with its own
   * forceComplete, before the next starts), so an earlier context is never
   * still open here — every earlier context has already been force-completed
   * by the time this one ends.
   *
   * The context is fully done once this returns, so its live-context and
   * pending state are forgotten — any word that arrives afterwards is dropped
   * as stale.
   *
   * @param contextId The audio context that has ended.
   * @param lastWordPts PTS of the last received word frame, used as the PTS
   *   for force-completed frames and forwarded to `flush`.
   * @returns Combined list of TTSTextFrames (for incomplete spoken slots),
   *   AggregatedTextProgressFrames pairing the forced text, and
   *   AggregatedTextFrames (skipped slots now unblocked), in emission order.
   */
  forceComplete(contextId: string, lastWordPts: number): Frame[] {
    const frames: Frame[] = [];
    if (this._streaming) {
      this._discardBufferedWords(contextId);
    }
    for (const slot of this._slots) {
      if (slot.spoken && !slot.complete && slot.contextId === contextId) {
        if (slot.tracker) {
          const remainingText = slot.tracker.getRemainingTtsText();
          let rawRemaining = slot.tracker.getRemainingLlmText();
          // The words left, not the markup the service was sent for its
          // tags, are what the LLM's text has to hold, read without its
          // own tags.
          const remainingWords = joinWords(stripCompleteMarkup(remainingText));
          let llmWords = rawRemaining ?? "";
          if (this.llmMarkup) {
            const flags = this.llmMarkup.flags.includes("g")
              ? this.llmMarkup.flags
              : `${this.llmMarkup.flags}g`;
            llmWords = llmWords.replace(new RegExp(this.llmMarkup.source, flags), "");
          }
          llmWords = joinWords(llmWords);
          if (rawRemaining && remainingWords && !llmWords.includes(remainingWords)) {
            logger.warning(
              `${this._name} force-complete: raw_remaining ${repr(rawRemaining)} ` +
                `does not contain remaining_text ${repr(remainingText)}, discarding`,
            );
            rawRemaining = null;
          }
          // A slot that is only tags, such as a sound, has LLM text and
          // nothing left to say.
          if (remainingText || rawRemaining) {
            logger.debug(
              `${this._name} force-completing slot with remaining text ${repr(remainingText)}`,
            );
            frames.push(
              this._buildWordFrame(remainingText, lastWordPts, slot.contextId, {
                segmentId: slot.frame.id,
                rawText: rawRemaining,
                includesInterFrameSpaces: slot.includesInterFrameSpaces,
              }),
            );
            // That frame carries the rest of the text, so the progress view
            // has to reach the end alongside it.
            slot.tracker.takeRemainingAsSpoken();
            frames.push(this._buildProgressFrame(slot, lastWordPts));
          }
        }
        slot.complete = true;
      }
    }
    frames.push(...this.flush(lastWordPts));
    // Context is fully done: forget it so any later word is dropped as stale.
    this._contextAppendToContext.delete(contextId);
    this._streamingContexts.delete(contextId);
    return frames;
  }

  /**
   * Clear slots and metadata, optionally preserving selected contexts.
   *
   * @param options.keepContexts Synthesis contexts that survive the interruption.
   */
  clear(options: { keepContexts?: Set<string> | null } = {}): void {
    const keep = options.keepContexts ?? new Set<string>();
    this._slots = this._slots.filter((slot) => keep.has(slot.contextId));
    this._contextAppendToContext = new Map(
      [...this._contextAppendToContext].filter(([key]) => keep.has(key)),
    );
    this._bufferedWords = this._bufferedWords.filter(
      (word) => word.contextId !== null && keep.has(word.contextId),
    );
    this._streamingContexts = new Map(
      [...this._streamingContexts].filter(([key]) => keep.has(key)),
    );
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Append a real, immediately-registered spoken slot.
   *
   * Shared by the non-streaming path of `registerSpoken` and by `_promote`
   * once a streamed sentence's boundary is confirmed.
   */
  protected _appendSpokenSlot(
    frame: AggregatedTextFrame,
    contextId: string,
    tracker: WordCompletionTracker | null,
    appendToContext: boolean,
    includesInterFrameSpaces: boolean,
  ): void {
    this._contextAppendToContext.set(contextId, appendToContext);
    this._slots.push(
      newSlot({
        frame,
        contextId,
        spoken: true,
        tracker,
        includesInterFrameSpaces,
      }),
    );
  }

  /**
   * Turn a completed parallel-aggregated sentence into a real spoken slot.
   *
   * Builds an AggregatedTextFrame of the context's text type (usually
   * `TextType.SENTENCE`) from the three aggregated text channels and appends
   * the slot for `contextId`, then replays any words that were buffered
   * waiting for it.
   *
   * The sentence frame is **emitted downstream** (first in the returned list)
   * with `willBeSpoken=true`: it is the streaming-mode equivalent of the
   * pre-synthesis sentence frame that SENTENCE mode pushes, giving RTVI
   * clients the initial `spoken_status="new"` event whose `segment_id` the
   * subsequent progress frames (built from this same frame's id) reference.
   * `appendToContext` is false on it — the conversation context is built from
   * the per-word TTSTextFrames (or, for pushTextFrames=true services, the
   * whole-sentence TTSTextFrame built below), not this announcement.
   *
   * When `buildTracker` is true (word-timestamp services), the slot gets a
   * real `WordCompletionTracker` and completes progressively as `processWord`
   * events arrive. When false (pushTextFrames=true services, e.g.
   * streamed-token providers with no word-timestamp signal), the slot gets no
   * tracker and is completed immediately: by the time a sentence promotes
   * (confirmed only by the *next* sentence's first token, or by `finalize` at
   * end of turn), every token making it up has already been sent to the TTS,
   * so there is nothing further to wait for. A whole-sentence TTSTextFrame is
   * built here to carry that content into the conversation context, mirroring
   * the single TTSTextFrame a non-streaming pushTextFrames=true service emits
   * per unit.
   *
   * The slot's `includesInterFrameSpaces` is left false: for a streamed
   * (TOKEN-mode) sentence, per-word CJK spacing is stamped by `processWord`
   * from `addWordTimestamps`, never from the incoming LLM token's own
   * inter-frame-space flag.
   *
   * @param agg The completed sentence, in the three parallel text channels.
   * @param contextId The context the promoted slot belongs to.
   * @param sc The context's streaming state.
   * @returns The sentence frame, followed — for pushTextFrames=true services —
   *   by the whole-sentence TTSTextFrame and any skipped frames it unblocks,
   *   followed by any frames unblocked by replaying previously-buffered words.
   *   Empty if the sentence has no text in any channel.
   */
  protected _promote(agg: _ParallelAggregation, contextId: string, sc: _StreamingContext): Frame[] {
    // A sentence that is only tags has no words to show, but its text still
    // reaches the context in order.
    if (!agg.userFacingText.trim() && !agg.llmText.trim()) {
      return [];
    }

    const frame = new AggregatedTextFrame({
      text: agg.userFacingText,
      textType: sc.textType,
      rawText: agg.llmText || null,
    });
    frame.contextId = contextId;
    frame.willBeSpoken = true;
    frame.appendToContext = false;
    const tracker = sc.buildTracker
      ? new WordCompletionTracker(agg.ttsText, {
          llmText: agg.llmText || null,
          userFacingText: agg.userFacingText,
          llmMarkup: this.llmMarkup,
        })
      : null;
    this._appendSpokenSlot(frame, contextId, tracker, sc.appendToContext, false);
    const frames: Frame[] = agg.userFacingText.trim() ? [frame] : [];

    if (!sc.buildTracker) {
      // Trimmed like a sentence-mode unit: the context joins its parts with
      // a space, and a streamed sentence keeps the spaces of its tokens.
      const wordFrame = new TTSTextFrame({
        text: agg.userFacingText.trim(),
        textType: sc.textType,
        rawText: agg.llmText.trim() || null,
        segmentId: frame.id,
      });
      wordFrame.contextId = contextId;
      wordFrame.willBeSpoken = true;
      wordFrame.appendToContext = sc.appendToContext;
      frames.push(wordFrame);
      frames.push(...this.completeSpokenSlot());
    }

    frames.push(...this._drainBufferedWords());
    return frames;
  }

  /**
   * Replay previously-buffered word events now that a new slot may match them.
   *
   * Snapshots and clears the buffer before replaying so a word that still
   * doesn't match anything (it belongs to a later, still-pending sentence)
   * gets re-buffered by `processWord` itself and waits for the next
   * promotion, rather than looping here.
   */
  protected _drainBufferedWords(): Frame[] {
    const buffered = this._bufferedWords;
    this._bufferedWords = [];
    const frames: Frame[] = [];
    for (const w of buffered) {
      frames.push(...this.processWord(w.word, w.pts, w.contextId, w.includesInterFrameSpaces));
    }
    return frames;
  }

  /**
   * Drop this context's still-buffered words, which no slot ever matched.
   *
   * Sentence mode drops an unrecognised word where it arrives; streaming only
   * knows one will never match once the context it belongs to has ended.
   */
  protected _discardBufferedWords(contextId: string): void {
    const keep: _BufferedWord[] = [];
    for (const w of this._bufferedWords) {
      if (w.contextId !== contextId) {
        keep.push(w);
        continue;
      }
      logger.warning(
        `${this._name} Dropping buffered word '${w.word}' not recognised by any slot.`,
      );
    }
    this._bufferedWords = keep;
  }

  /**
   * Whether `slot` is an eligible active slot for `contextId`.
   *
   * A `null` contextId (legacy providers with no per-context word tagging,
   * where concurrency can't occur) matches any slot, preserving the
   * untargeted behaviour. Otherwise word routing is scoped to the slot's own
   * context so concurrently-live contexts never consume each other's words.
   */
  protected _slotMatchesContext(slot: _AggregatedFrameSlot, contextId: string | null): boolean {
    if (!(slot.spoken && !slot.complete && slot.tracker !== null)) {
      return false;
    }
    return contextId === null || slot.contextId === contextId;
  }

  /** Return the first incomplete spoken slot with a tracker for `contextId`. */
  protected _getActiveSlot(contextId: string | null = null): _AggregatedFrameSlot | null {
    return this._slots.find((s) => this._slotMatchesContext(s, contextId)) ?? null;
  }

  /**
   * Return the first incomplete spoken slot with a tracker for `contextId`
   * after `current`.
   */
  protected _getNextActiveSlot(
    current: _AggregatedFrameSlot,
    contextId: string | null = null,
  ): _AggregatedFrameSlot | null {
    let found = false;
    for (const s of this._slots) {
      if (s === current) {
        found = true;
        continue;
      }
      if (found && this._slotMatchesContext(s, contextId)) {
        return s;
      }
    }
    return null;
  }

  /**
   * Build an AggregatedTextProgressFrame reflecting the current
   * spoken/remaining state of a slot.
   */
  protected _buildProgressFrame(
    slot: _AggregatedFrameSlot,
    pts: number,
  ): AggregatedTextProgressFrame {
    const tracker = slot.tracker;
    if (tracker === null) {
      throw new Error("_buildProgressFrame requires a slot with a tracker");
    }
    const frame = new AggregatedTextProgressFrame({
      segmentId: slot.frame.id,
      contextId: slot.contextId,
      text: slot.frame.text,
      textType: slot.frame.textType,
      accumulatedText: tracker.getAccumulatedUserFacingText(),
      remainingText: tracker.getRemainingUserFacingText(false),
    });
    frame.pts = pts;
    return frame;
  }

  /** Build a TTSTextFrame with all standard word-timestamp attributes set. */
  protected _buildWordFrame(
    text: string,
    pts: number,
    contextId: string | null,
    options: BuildWordFrameOptions = {},
  ): Frame {
    const frame = new TTSTextFrame({
      text,
      textType: TextType.WORD,
      segmentId: options.segmentId ?? null,
    });
    frame.pts = pts;
    frame.contextId = contextId;
    if (options.suppressInContext) {
      frame.appendToContext = false;
    } else {
      frame.appendToContext =
        contextId !== null ? (this._contextAppendToContext.get(contextId) ?? true) : true;
    }
    frame.rawText = options.rawText ?? null;
    frame.includesInterFrameSpaces = options.includesInterFrameSpaces ?? false;
    return frame;
  }
}
