// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_aggregated_frame_sequencer.py

/**
 * Tests for AggregatedFrameSequencer.
 *
 * registerSpoken is async (it may drive an async text aggregator when the
 * sequencer streams tokens). Every other method remains synchronous.
 *
 * Test groups:
 * - registerSkipped: immediate flush vs. blocked by a preceding spoken slot
 * - registerSpoken / completeSpokenSlot: pushTextFrames=true path (buildTracker=false)
 * - flush: pts propagation, transportDestination, stops at incomplete spoken slot
 * - processWord: normal, completing, dropped, rawText propagation
 * - processWord overflow: single token spanning two slot boundaries
 * - processWord force-complete via belongsHere failure
 * - forceComplete: remaining text emission, rawText, corrupt raw discard, slot ordering
 * - clear: resets all state
 * - registerSpoken streaming: token-by-token sentence accumulation and promotion
 * - registerSpoken buffered words: words arriving before a pending sentence promotes
 * - registerSkipped forces finalize: streamed pending sentence forced by a skipped frame
 * - finalize: end-of-turn forced promotion
 * - clear resets streaming state: pending accumulation and buffered words
 */

import { describe, expect, test } from "bun:test";

import {
  AggregatedTextFrame,
  AggregatedTextProgressFrame,
  type Frame,
  TextType,
  TTSTextFrame,
} from "../src/frames/frames.ts";
import {
  type _AggregatedFrameSlot,
  type _BufferedWord,
  _ParallelSentenceAggregator,
  type _StreamingContext,
  AggregatedFrameSequencer,
} from "../src/utils/context/aggregated_frame_sequencer.ts";
import { concatenateAggregatedText, TextPartForConcatenation } from "../src/utils/string.ts";
import { mergePunctTokens } from "../src/utils/text/word_timestamp_utils.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Access to the sequencer's protected state, as the Python tests do. */
interface SequencerInternals {
  _slots: _AggregatedFrameSlot[];
  _contextAppendToContext: Map<string, boolean>;
  _streamingContexts: Map<string, _StreamingContext>;
  _bufferedWords: _BufferedWord[];
}

function internals(seq: AggregatedFrameSequencer): SequencerInternals {
  return seq as unknown as SequencerInternals;
}

function _seq(streaming = false): AggregatedFrameSequencer {
  return new AggregatedFrameSequencer({ name: "test", streaming });
}

function _spokenFrame(text: string, rawText: string | null = null): AggregatedTextFrame {
  return new AggregatedTextFrame({ text, textType: TextType.SENTENCE, rawText });
}

function _skippedFrame(text: string): AggregatedTextFrame {
  return new AggregatedTextFrame({ text, textType: "code" });
}

function ttsFrames(frames: Frame[]): TTSTextFrame[] {
  return frames.filter((f): f is TTSTextFrame => f instanceof TTSTextFrame);
}

function progressFrames(frames: Frame[]): AggregatedTextProgressFrame[] {
  return frames.filter(
    (f): f is AggregatedTextProgressFrame => f instanceof AggregatedTextProgressFrame,
  );
}

function wordFrame(frames: Frame[], i: number): TTSTextFrame {
  return frames[i] as TTSTextFrame;
}

// ---------------------------------------------------------------------------
// registerSkipped
// ---------------------------------------------------------------------------

describe("TestRegisterSkipped", () => {
  test("test_emits_immediately_with_empty_queue", async () => {
    const seq = _seq();
    const frame = _skippedFrame("code block");
    const result = await seq.registerSkipped(frame, "ctx1", null);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(frame);
  });

  test("test_sets_append_to_context_true", async () => {
    const seq = _seq();
    const frame = _skippedFrame("code");
    await seq.registerSkipped(frame, "ctx1", null);
    expect(frame.appendToContext).toBe(true);
  });

  test("test_sets_context_id_on_frame", async () => {
    const seq = _seq();
    const frame = _skippedFrame("code");
    await seq.registerSkipped(frame, "ctx42", null);
    expect(frame.contextId).toBe("ctx42");
  });

  test("test_sets_transport_destination", async () => {
    const seq = _seq();
    const frame = _skippedFrame("code");
    const result = await seq.registerSkipped(frame, "ctx1", "dest-A");
    expect(result[0]!.transportDestination).toBe("dest-A");
  });

  test("test_blocked_by_incomplete_spoken_slot", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello world"), "ctx1", "hello world", true);
    const result = await seq.registerSkipped(_skippedFrame("code"), "ctx2", null);
    expect(result).toEqual([]);
  });

  test("test_emits_immediately_after_already_complete_spoken_slot", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hi"), "ctx1", "hi", true, { buildTracker: false });
    seq.completeSpokenSlot();
    const result = await seq.registerSkipped(_skippedFrame("code"), "ctx2", null);
    expect(result.length).toBe(1);
  });

  test("test_multiple_skipped_before_any_spoken_all_emit", async () => {
    const seq = _seq();
    const r1 = await seq.registerSkipped(_skippedFrame("code1"), "ctx1", null);
    const r2 = await seq.registerSkipped(_skippedFrame("code2"), "ctx2", null);
    expect(r1.length).toBe(1);
    expect(r2.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// registerSpoken / completeSpokenSlot  (pushTextFrames=true path)
// ---------------------------------------------------------------------------

describe("TestCompleteSpokenSlot", () => {
  test("test_noop_with_empty_queue", () => {
    const seq = _seq();
    expect(seq.completeSpokenSlot()).toEqual([]);
  });

  test("test_marks_slot_complete_and_flushes_skipped", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true, {
      buildTracker: false,
    });
    const skipped = _skippedFrame("code");
    await seq.registerSkipped(skipped, "ctx2", null); // blocked

    const result = seq.completeSpokenSlot();
    expect(result.length).toBe(1);
    expect(result[0]).toBe(skipped);
    expect(skipped.appendToContext).toBe(true);
  });

  test("test_only_first_pending_slot_is_marked", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("one"), "ctx1", "one", true, { buildTracker: false });
    await seq.registerSpoken(_spokenFrame("two"), "ctx2", "two", true, { buildTracker: false });
    const skipped = _skippedFrame("code");
    await seq.registerSkipped(skipped, "ctx3", null);

    // ctx2 still blocks the skipped frame
    const result = seq.completeSpokenSlot();
    expect(result).toEqual([]);
  });

  test("test_skipped_flushes_after_all_preceding_spoken_complete", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("one"), "ctx1", "one", true, { buildTracker: false });
    await seq.registerSpoken(_spokenFrame("two"), "ctx2", "two", true, { buildTracker: false });
    const skipped = _skippedFrame("code");
    await seq.registerSkipped(skipped, "ctx3", null);

    seq.completeSpokenSlot(); // completes ctx1
    const result = seq.completeSpokenSlot(); // completes ctx2 → flush skipped
    expect(result.length).toBe(1);
    expect(result[0]).toBe(skipped);
  });
});

// ---------------------------------------------------------------------------
// flush
// ---------------------------------------------------------------------------

describe("TestFlush", () => {
  test("test_empty_queue_returns_empty", () => {
    expect(_seq().flush()).toEqual([]);
  });

  test("test_stops_at_incomplete_spoken_slot", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true, {
      buildTracker: false,
    });
    await seq.registerSkipped(_skippedFrame("code"), "ctx2", null);
    expect(seq.flush()).toEqual([]);
  });

  test("test_last_word_pts_assigned_to_skipped_frame", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true);
    const skipped = _skippedFrame("code");
    await seq.registerSkipped(skipped, "ctx2", null);

    // processWord("hello") completes the spoken slot and calls flush(lastWordPts=77)
    const result = seq.processWord("hello", 77, "ctx1");
    const flushed = result.filter(
      (f): f is AggregatedTextFrame => f instanceof AggregatedTextFrame && f.text === "code",
    );
    expect(flushed.length).toBe(1);
    expect(flushed[0]!.pts).toBe(77);
  });

  test("test_complete_spoken_slots_are_swept", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true, {
      buildTracker: false,
    });
    seq.completeSpokenSlot();
    // Queue should be empty after sweeping the complete spoken slot
    expect(internals(seq)._slots).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// processWord — basic
// ---------------------------------------------------------------------------

describe("TestProcessWordBasic", () => {
  async function _seqWithSpoken(
    text: string,
    ctx = "ctx1",
    append = true,
  ): Promise<AggregatedFrameSequencer> {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame(text), ctx, text, append);
    return seq;
  }

  test("test_returns_tts_text_frame", async () => {
    const seq = await _seqWithSpoken("hello");
    const result = seq.processWord("hello", 100, "ctx1");
    expect(result.length).toBe(2);
    expect(result[0]).toBeInstanceOf(TTSTextFrame);
    expect(result[1]).toBeInstanceOf(AggregatedTextProgressFrame);
  });

  test("test_frame_text_and_pts", async () => {
    const seq = await _seqWithSpoken("hello");
    const result = seq.processWord("hello", 100, "ctx1");
    expect(wordFrame(result, 0).text).toBe("hello");
    expect(result[0]!.pts).toBe(100);
  });

  test("test_frame_segment_id", async () => {
    const seq = _seq();
    const segment = _spokenFrame("hello");
    await seq.registerSpoken(segment, "ctx1", "hello", true);
    const result = seq.processWord("hello", 1, "ctx1");
    expect(wordFrame(result, 0).segmentId).toBe(segment.id);
  });

  test("test_frame_context_id", async () => {
    const seq = await _seqWithSpoken("hello", "ctx99");
    const result = seq.processWord("hello", 1, "ctx99");
    expect(wordFrame(result, 0).contextId).toBe("ctx99");
  });

  test("test_append_to_context_true", async () => {
    const seq = await _seqWithSpoken("hello", "ctx1", true);
    const result = seq.processWord("hello", 1, "ctx1");
    expect(wordFrame(result, 0).appendToContext).toBe(true);
  });

  test("test_append_to_context_false", async () => {
    const seq = await _seqWithSpoken("hello", "ctx1", false);
    const result = seq.processWord("hello", 1, "ctx1");
    expect(wordFrame(result, 0).appendToContext).toBe(false);
  });

  test("test_non_completing_word_does_not_flush_skipped", async () => {
    const seq = await _seqWithSpoken("hello world");
    await seq.registerSkipped(_skippedFrame("code"), "ctx2", null);
    const result = seq.processWord("hello", 10, "ctx1");
    expect(result.length).toBe(2);
    expect(result[0]).toBeInstanceOf(TTSTextFrame);
    expect(result[1]).toBeInstanceOf(AggregatedTextProgressFrame);
  });

  test("test_completing_word_flushes_blocked_skipped_frame", async () => {
    const seq = await _seqWithSpoken("hello");
    const skipped = _skippedFrame("code");
    await seq.registerSkipped(skipped, "ctx2", null);
    const result = seq.processWord("hello", 50, "ctx1");
    expect(result.length).toBe(3);
    expect(result[0]).toBeInstanceOf(TTSTextFrame);
    expect(result[1]).toBeInstanceOf(AggregatedTextProgressFrame);
    expect(result[2]).toBe(skipped);
  });

  test("test_last_of_multiple_words_flushes_skipped", async () => {
    const seq = await _seqWithSpoken("hello world");
    const skipped = _skippedFrame("code");
    await seq.registerSkipped(skipped, "ctx2", null);
    seq.processWord("hello", 10, "ctx1");
    const result = seq.processWord("world", 20, "ctx1");
    expect(result.some((f) => f === skipped)).toBe(true);
  });

  test("test_none_context_emits_passthrough", () => {
    // Services without audio contexts pass contextId=null and rely on the
    // passthrough path even when no slot is registered.
    const seq = _seq();
    const result = seq.processWord("hello", 1, null);
    expect(result.length).toBe(1);
    expect(result[0]).toBeInstanceOf(TTSTextFrame);
    expect(wordFrame(result, 0).text).toBe("hello");
    expect(wordFrame(result, 0).contextId).toBeNull();
  });

  test("test_none_context_passthrough_appends_to_context", () => {
    const seq = _seq();
    const result = seq.processWord("hello", 1, null);
    expect(wordFrame(result, 0).appendToContext).toBe(true);
  });

  test("test_unknown_context_is_dropped", () => {
    // A real (non-null) contextId that was never registered is stale and must
    // be dropped rather than emitted into the current turn's transcript.
    const seq = _seq();
    const result = seq.processWord("hello", 1, "ctx-unknown");
    expect(result).toEqual([]);
  });

  test("test_unrecognised_word_is_dropped", async () => {
    // "zzz" is nowhere in "hello world", there is no next slot, and no resync
    // can place it -- so it is not this turn's text and must not be emitted.
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello world"), "ctx1", "hello world", true);
    expect(seq.processWord("zzz", 5, "ctx1")).toEqual([]);
  });

  test("test_none_context_word_completes_registered_slot", async () => {
    // Legacy providers register slots under real context IDs but emit word
    // events with contextId=null; an untagged word must still land on (and
    // complete) the active slot rather than passing through beside it.
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true);
    const result = seq.processWord("hello", 1, null);
    const words = ttsFrames(result);
    expect(words.map((f) => f.text)).toEqual(["hello"]);
    expect(words[0]!.contextId).toBe("ctx1");
    // The completed slot flushed out; nothing is left pending.
    expect(internals(seq)._slots).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// processWord — rawText propagation
// ---------------------------------------------------------------------------

describe("TestProcessWordRawText", () => {
  test("test_raw_text_split_across_word_frames", async () => {
    const seq = _seq();
    await seq.registerSpoken(
      _spokenFrame("4111 1111", "<card>4111 1111</card>"),
      "ctx1",
      "4111 1111",
      true,
    );
    const r1 = seq.processWord("4111", 10, "ctx1");
    const r2 = seq.processWord("1111", 20, "ctx1");
    expect(wordFrame(r1, 0).rawText).toBe("<card>4111");
    const lastWordFrames = ttsFrames(r2);
    expect(lastWordFrames[0]!.rawText).toBe("1111</card>");
  });

  test("test_raw_text_defaults_to_frame_text_when_no_raw_text", async () => {
    // llmText is always derived from frame.rawText or frame.text — never null.
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true);
    const result = seq.processWord("hello", 1, "ctx1");
    expect(wordFrame(result, 0).rawText).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// processWord — overflow (single token spanning two slots)
// ---------------------------------------------------------------------------

describe("TestProcessWordOverflow", () => {
  // A single word-timestamp token spanning two slots only happens within one
  // context: sentences in a turn share a context ID (reuseContextIdWithinTurn),
  // so overflow crosses between that context's own slots, never across contexts.
  test("test_overflow_produces_two_tts_text_frames", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("abc"), "ctx1", "abc", true);
    await seq.registerSpoken(_spokenFrame("def"), "ctx1", "def", true);

    const result = seq.processWord("abcdef", 100, "ctx1");
    const words = ttsFrames(result);
    expect(words.length).toBe(2);
    expect(words[0]!.text).toBe("abc");
    expect(words[1]!.text).toBe("def");
  });

  test("test_overflow_words_carry_their_own_segment_id", async () => {
    const seq = _seq();
    const first = _spokenFrame("abc");
    const second = _spokenFrame("def");
    await seq.registerSpoken(first, "ctx1", "abc", true);
    await seq.registerSpoken(second, "ctx1", "def", true);

    const result = seq.processWord("abcdef", 100, "ctx1");
    const words = ttsFrames(result);
    expect(words.map((f) => f.segmentId)).toEqual([first.id, second.id]);
  });

  test("test_overflow_stays_within_context", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("abc"), "ctx1", "abc", true);
    await seq.registerSpoken(_spokenFrame("def"), "ctx1", "def", true);

    const result = seq.processWord("abcdef", 100, "ctx1");
    const words = ttsFrames(result);
    expect(words[0]!.contextId).toBe("ctx1");
    expect(words[1]!.contextId).toBe("ctx1");
  });

  test("test_overflow_completing_next_slot_flushes_skipped", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("abc"), "ctx1", "abc", true);
    await seq.registerSpoken(_spokenFrame("def"), "ctx1", "def", true);
    const skipped = _skippedFrame("code");
    await seq.registerSkipped(skipped, "ctx2", null); // blocked behind ctx1's slots

    const result = seq.processWord("abcdef", 100, "ctx1");
    expect(result.some((f) => f === skipped)).toBe(true);
  });

  test("test_overflow_not_completing_next_slot_does_not_flush_skipped", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("abc"), "ctx1", "abc", true);
    await seq.registerSpoken(_spokenFrame("def ghi"), "ctx1", "def ghi", true);
    const skipped = _skippedFrame("code");
    await seq.registerSkipped(skipped, "ctx2", null);

    // "abcdef" overflows: "def" goes to the next slot, which still expects " ghi"
    const result = seq.processWord("abcdef", 100, "ctx1");
    expect(result.some((f) => f === skipped)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// processWord — force-complete via wordBelongsHere failure
// ---------------------------------------------------------------------------

describe("TestProcessWordForcesComplete", () => {
  // These exercise a dropped word-timestamp within one context (its sentence slots
  // share a context ID), so a word for a later slot force-completes the earlier one.
  test("test_word_for_next_slot_force_completes_current", async () => {
    // When a word belongs to the next slot but not the current, the current
    // slot is force-completed and the word is routed to the next slot.
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true);
    await seq.registerSpoken(_spokenFrame("world"), "ctx1", "world", true);

    // "world" doesn't belong to the first slot but belongs to the second
    const result = seq.processWord("world", 50, "ctx1");
    const texts = new Set(ttsFrames(result).map((f) => f.text));
    expect(texts.has("world")).toBe(true);
  });

  test("test_force_complete_then_overflow_flushes_skipped", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true);
    await seq.registerSpoken(_spokenFrame("world"), "ctx1", "world", true);
    const skipped = _skippedFrame("code");
    await seq.registerSkipped(skipped, "ctx2", null);

    // "world" force-completes the first slot and completes the second via overflow
    const result = seq.processWord("world", 50, "ctx1");
    expect(result.some((f) => f === skipped)).toBe(true);
  });

  test("test_whitespace_slot_force_complete_skips_emission", async () => {
    // When a whitespace-only slot is force-completed, getWordForFrame()
    // returns an empty string for it, so no frame should be emitted for that
    // slot.
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame(" "), "ctx1", " ", true);
    await seq.registerSpoken(_spokenFrame("World"), "ctx1", "World", true);

    // Word for the second slot arrives, forcing the first (whitespace) to complete
    const result = seq.processWord("World", 10, "ctx1");
    const words = ttsFrames(result);

    // Should only emit ONE frame, not a duplicate for the whitespace slot
    expect(words.length).toBe(1);
    expect(words[0]!.text).toBe("World");
    expect(words[0]!.contextId).toBe("ctx1");
  });
});

// ---------------------------------------------------------------------------
// forceComplete
// ---------------------------------------------------------------------------

describe("TestForceComplete", () => {
  test("test_emits_remaining_text_when_word_dropped", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello world"), "ctx1", "hello world", true);
    seq.processWord("hello", 10, "ctx1"); // "world" never arrives

    const result = seq.forceComplete("ctx1", 50);
    const tts = ttsFrames(result);
    expect(tts.length).toBe(1);
    expect(tts[0]!.text).toBe("world");
    expect(tts[0]!.pts).toBe(50);
  });

  test("test_remaining_text_carries_the_segment_id", async () => {
    const seq = _seq();
    const segment = _spokenFrame("hello world");
    await seq.registerSpoken(segment, "ctx1", "hello world", true);
    seq.processWord("hello", 10, "ctx1");

    const result = seq.forceComplete("ctx1", 50);
    const tts = ttsFrames(result);
    expect(tts[0]!.segmentId).toBe(segment.id);
  });

  test("test_emits_full_text_when_no_words_arrived", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello world"), "ctx1", "hello world", true);

    const result = seq.forceComplete("ctx1", 0);
    const tts = ttsFrames(result);
    expect(tts.length).toBe(1);
    expect(tts[0]!.text).toBe("hello world");
  });

  test("test_already_complete_slot_emits_nothing", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hi"), "ctx1", "hi", true);
    seq.processWord("hi", 5, "ctx1"); // completes normally

    const result = seq.forceComplete("ctx1", 10);
    expect(result).toEqual([]);
  });

  test("test_flushes_skipped_frames_after_completing", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true);
    const skipped = _skippedFrame("code");
    await seq.registerSkipped(skipped, "ctx2", null);

    const result = seq.forceComplete("ctx1", 20);
    expect(result.some((f) => f === skipped)).toBe(true);
    expect(skipped.appendToContext).toBe(true);
  });

  test("test_propagates_raw_text", async () => {
    const seq = _seq();
    await seq.registerSpoken(
      _spokenFrame("4111 1111", "<card>4111 1111</card>"),
      "ctx1",
      "4111 1111",
      true,
    );
    seq.processWord("4111", 10, "ctx1"); // "1111" never arrives

    const result = seq.forceComplete("ctx1", 20);
    const tts = ttsFrames(result);
    expect(tts[0]!.text).toBe("1111");
    expect(tts[0]!.rawText).toBe("1111</card>");
  });

  test("test_discards_corrupt_raw_remaining", async () => {
    // rawRemaining is discarded when it does not contain remainingText.
    const seq = _seq();
    // "abc" normalized ≠ "xyz" normalized — any remaining won't be in rawRemaining
    await seq.registerSpoken(_spokenFrame("abc", "xyz"), "ctx1", "abc", true);
    const result = seq.forceComplete("ctx1", 0);
    const tts = ttsFrames(result);
    expect(tts.length).toBe(1);
    expect(tts[0]!.text).toBe("abc");
    expect(tts[0]!.rawText).toBeNull(); // discarded due to corruption
  });

  test("test_slot_without_tracker_just_marks_complete_and_flushes", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true, {
      buildTracker: false,
    });
    const skipped = _skippedFrame("code");
    await seq.registerSkipped(skipped, "ctx2", null);

    const result = seq.forceComplete("ctx1", 0);
    const tts = ttsFrames(result);
    expect(tts).toEqual([]); // no tracker → no word frame
    expect(result.some((f) => f === skipped)).toBe(true);
  });

  test("test_scoped_to_context_id_leaves_other_contexts_incomplete", async () => {
    // forceComplete only closes the named context; other in-flight contexts stay.
    //
    // Two contexts are registered concurrently (e.g. two back-to-back TTSSpeakFrame
    // utterances). Completing the first must not force-close the second's slot — that
    // slot completes later via its own words or its own forceComplete.
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true);
    await seq.registerSpoken(_spokenFrame("world"), "ctx2", "world", true);

    const result = seq.forceComplete("ctx1", 0);
    const texts = new Set(ttsFrames(result).map((f) => f.text));
    expect(texts).toEqual(new Set(["hello"])); // ctx2's "world" is untouched

    // ctx2 still completes on its own afterwards.
    const result2 = seq.forceComplete("ctx2", 10);
    const texts2 = new Set(ttsFrames(result2).map((f) => f.text));
    expect(texts2).toEqual(new Set(["world"]));
  });

  test("test_late_word_after_force_complete_is_dropped", async () => {
    // A word arriving after its context is force-completed is dropped as stale.
    //
    // forceComplete removes the context's live-context entry, so delayed
    // word-timestamps (delivered by some providers seconds later) no longer leak
    // into the transcript.
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true);
    seq.forceComplete("ctx1", 0);

    const result = seq.processWord("hello", 5, "ctx1");
    expect(result).toEqual([]);
  });

  test("test_second_force_complete_for_same_context_is_a_noop", async () => {
    // A repeated forceComplete for an already-completed context emits nothing.
    //
    // The service force-completes a context both when handling `TTSStoppedFrame`
    // and again after the audio-context loop ends, so the second call must find
    // no matching slots and no live context state.
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true);
    const first = seq.forceComplete("ctx1", 0);
    expect(new Set(ttsFrames(first).map((f) => f.text))).toEqual(new Set(["hello"]));

    expect(seq.forceComplete("ctx1", 10)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

/**
 * End-to-end: a provider whose word-timestamp events don't repeat punctuation
 * attached to the previous word (e.g. Inworld reporting "Yeah" then "I" for
 * "Yeah, I can do that.").
 *
 * Every word after the comma must be attributed to the slot, carrying its
 * rawText into the conversation context. A word the slot turns down is dropped
 * and the slot is left stranded at the cursor, so the rest of the sentence
 * arrives in one lump from forceComplete instead of word by word.
 */
describe("TestWordsAfterUnrepeatedPunctuation", () => {
  const SENTENCE = "Yeah, I can do that. ";
  const WORDS = ["Yeah", "I", "can", "do", "that"];

  test("test_every_word_is_attributed_to_the_slot", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame(SENTENCE, SENTENCE), "ctx1", SENTENCE, true);

    const emitted: TTSTextFrame[] = [];
    for (const word of WORDS) {
      const frames = seq.processWord(word, 10, "ctx1");
      emitted.push(...ttsFrames(frames));
    }

    expect(emitted.map((f) => f.text)).toEqual(WORDS);
    // Only a word attributed to the slot carries rawText.
    for (const frame of emitted) {
      expect(frame.rawText).not.toBeNull();
    }
  });

  test("test_force_complete_has_nothing_left_to_emit", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame(SENTENCE, SENTENCE), "ctx1", SENTENCE, true);
    for (const word of WORDS) {
      seq.processWord(word, 10, "ctx1");
    }

    // The slot completed through the words themselves, so the end of the audio
    // context has no remaining text to re-emit or discard.
    expect(seq.forceComplete("ctx1", 20)).toEqual([]);
  });
});

/**
 * One sentence, tokenized the many ways real providers report it.
 *
 * Providers differ in where punctuation, spacing and casing land in the
 * word-timestamp stream. Whatever the shape, the text reassembled for the
 * conversation context must come back as the original sentence.
 *
 * Raw provider tokens are passed through `mergePunctTokens` first,
 * mirroring the service layer: punctuation-only tokens are collapsed into the
 * preceding word before the sequencer ever sees them.
 */
describe("TestTokenizationShapeResilience", () => {
  const SENTENCE = "Yeah, I can do that. ";

  const SHAPES: Record<string, string[]> = {
    "punctuation omitted entirely": ["Yeah", "I", "can", "do", "that"],
    "punctuation attached to word": ["Yeah,", "I", "can", "do", "that."],
    "tokens carry leading spaces": ["Yeah,", " I", " can", " do", " that."],
    "tokens carry trailing spaces": ["Yeah, ", "I ", "can ", "do ", "that. "],
    "punctuation as its own token": ["Yeah", ",", "I", "can", "do", "that", "."],
    "punctuation leads next token": ["Yeah", ", I", "can", "do", "that", "."],
    "lowercased by provider": ["yeah", "i", "can", "do", "that"],
    "uppercased by provider": ["YEAH", "I", "CAN", "DO", "THAT"],
    "trailing period only": ["Yeah", "I", "can", "do", "that."],
  };

  /**
   * Reassemble what the context aggregator would write for these frames.
   *
   * A word frame contributes its `rawText` (the span of original text it
   * was attributed to) when it has one, falling back to the spoken text.
   */
  function _assembleContext(frames: Frame[]): string {
    const parts = ttsFrames(frames).map(
      (f) =>
        new TextPartForConcatenation({
          text: f.rawText ? f.rawText : f.text,
          includesInterPartSpaces: f.includesInterFrameSpaces,
        }),
    );
    return concatenateAggregatedText(parts);
  }

  async function _runShape(words: string[]): Promise<string> {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame(SENTENCE, SENTENCE), "ctx1", SENTENCE, true);
    const merged = mergePunctTokens(words.map((w) => [w, 0.0] as const)).map(([w]) => w);
    const frames: Frame[] = [];
    for (const word of merged) {
      frames.push(...seq.processWord(word, 10, "ctx1"));
    }
    // End of the audio context: emit anything the provider never reported
    // (e.g. a trailing period that never arrives as its own token).
    frames.push(...seq.forceComplete("ctx1", 20));
    return _assembleContext(frames);
  }

  test("test_context_reconstructs_for_every_shape", async () => {
    for (const [name, words] of Object.entries(SHAPES)) {
      // subTest(shape=name): pair the shape name with the result for diagnostics.
      expect([name, await _runShape(words)]).toEqual([name, SENTENCE.trim()]);
    }
  });
});

/**
 * A service forwarding raw tokens, so a mark reaches the sequencer on its own.
 *
 * `mergePunctTokens` folds a punctuation-only token into the word before it,
 * but only where the service asks for it (`preMergeTokens=true`). Without it
 * the mark arrives as its own event, after the word it trails already carried it
 * into the context.
 */
describe("TestPunctuationTokensWithoutPreMerge", () => {
  function _context(frames: Frame[]): string {
    return concatenateAggregatedText(
      ttsFrames(frames)
        .filter((f) => f.appendToContext)
        .map(
          (f) =>
            new TextPartForConcatenation({
              text: f.rawText ? f.rawText : f.text,
              includesInterPartSpaces: f.includesInterFrameSpaces,
            }),
        ),
    );
  }

  async function _run(text: string, tokens: string[]): Promise<Frame[]> {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame(text, text), "ctx1", text, true);
    const frames: Frame[] = [];
    for (const word of tokens) {
      frames.push(...seq.processWord(word, 10, "ctx1"));
    }
    return frames;
  }

  test("test_the_mark_reaches_the_context_once", async () => {
    const frames = await _run("Yeah, I can help", ["Yeah", ",", "I", "can", "help"]);
    expect(_context(frames)).toBe("Yeah, I can help");
  });

  test("test_the_mark_is_still_emitted_on_the_word_channel", async () => {
    // It is what the provider reported speaking, so a word consumer sees it.
    const frames = await _run("Yeah, I can help", ["Yeah", ",", "I", "can", "help"]);
    const spoken = ttsFrames(frames).map((f) => f.text);
    expect(spoken).toEqual(["Yeah", ",", "I", "can", "help"]);
  });

  test("test_a_mark_carrying_its_own_spacing", async () => {
    // The token shape Inworld reports: the mark arrives with a trailing space.
    const text = "hello world! How are you";
    const frames = await _run(text, ["hello", " world", "! ", "How", " are", " you"]);
    expect(_context(frames)).toBe(text);
  });

  test("test_a_symbol_the_source_spells_differently", async () => {
    // ElevenLabs reports an arrow as a dash; the arrow still reaches the context.
    const text = "Step one → step two";
    const frames = await _run(text, ["Step", "one", "-", "step", "two"]);
    expect(_context(frames)).toBe(text);
  });
});

describe("TestClear", () => {
  test("test_clears_slots", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true);
    await seq.registerSkipped(_skippedFrame("code"), "ctx2", null);
    seq.clear();
    expect(internals(seq)._slots).toEqual([]);
  });

  test("test_clears_context_map", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true);
    seq.clear();
    expect(internals(seq)._contextAppendToContext).toEqual(new Map());
  });

  test("test_after_clear_skipped_emits_immediately", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true);
    seq.clear();
    const frame = _skippedFrame("code");
    const result = await seq.registerSkipped(frame, "ctx2", null);
    expect(result.length).toBe(1);
  });

  test("test_after_clear_process_word_drops_stale_word", async () => {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true);
    seq.clear();
    // ctx1 was wiped by clear(); a delayed word for it is stale and dropped.
    const result = seq.processWord("hello", 1, "ctx1");
    expect(result).toEqual([]);
  });

  test("test_stale_words_do_not_corrupt_next_turn_transcript", async () => {
    // Regression for #4750: after an interruption clears context A and a new
    // context B is registered, delayed word-timestamps for A must not interleave
    // into B's transcript.
    const seq = _seq();
    // Turn A starts, then is interrupted (clear wipes its slot + context map).
    await seq.registerSpoken(
      _spokenFrame("I just wanted to follow up"),
      "ctxA",
      "I just wanted to follow up",
      true,
    );
    seq.clear();
    // Turn B (the voicemail message) is registered.
    await seq.registerSpoken(_spokenFrame("Hello"), "ctxB", "Hello", true);
    // Delayed words for the dead context A arrive — every one must be dropped.
    for (const stale of ["I", "just", "wanted", "to", "follow", "up"]) {
      expect(seq.processWord(stale, 1, "ctxA")).toEqual([]);
    }
    // Context B's own word still flows normally and appends to the transcript.
    const result = seq.processWord("Hello", 2, "ctxB");
    expect(result.length).toBe(2);
    expect(wordFrame(result, 0).text).toBe("Hello");
    expect(wordFrame(result, 0).contextId).toBe("ctxB");
    expect(wordFrame(result, 0).appendToContext).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CJK languages — Korean, Japanese, Chinese
// ---------------------------------------------------------------------------

/**
 * Sequencer behaviour for CJK language scenarios.
 *
 * Korean: Cartesia returns each word as a separate timestamp event (one word
 * per processWord call). Japanese/Chinese: Cartesia merges all characters
 * in one timestamp message into a single combined token before calling
 * processWord.
 */
describe("TestCJKLanguages", () => {
  // --- Korean ---

  test("test_korean_word_by_word_completes_slot_and_flushes_skipped", async () => {
    // Korean words fed one at a time complete the spoken slot and unblock a skipped frame.
    const seq = _seq();
    const sentence = "저는 여러분의 AI 어시스턴트입니다.";
    const words = ["저는", "여러분의", "AI", "어시스턴트입니다."];
    await seq.registerSpoken(_spokenFrame(sentence), "ctx1", sentence, true);
    const skipped = _skippedFrame("[code]");
    await seq.registerSkipped(skipped, "ctx2", null);

    // Skipped stays blocked until the last word arrives
    for (const word of words.slice(0, -1)) {
      const partial = seq.processWord(word, 100, "ctx1");
      expect(partial.some((f) => f === skipped)).toBe(false);
    }

    const result = seq.processWord(words[words.length - 1]!, 200, "ctx1");
    expect(result.some((f) => f === skipped)).toBe(true);
  });

  test("test_korean_force_complete_emits_correct_remaining_text", async () => {
    // After one Korean word, forceComplete emits the correct unspoken suffix.
    const seq = _seq();
    const sentence = "저는 여러분의 AI 어시스턴트입니다.";
    await seq.registerSpoken(_spokenFrame(sentence), "ctx1", sentence, true);
    seq.processWord("저는", 10, "ctx1");

    const result = seq.forceComplete("ctx1", 50);
    const tts = ttsFrames(result);
    expect(tts.length).toBe(1);
    expect(tts[0]!.text).toBe("여러분의 AI 어시스턴트입니다.");
    expect(tts[0]!.pts).toBe(50);
  });

  // --- Japanese ---

  test("test_japanese_combined_groups_complete_spoken_slot", async () => {
    // Two Cartesia-style combined Japanese groups complete the slot and flush skipped.
    const seq = _seq();
    const sentence = "こんにちは、私はあなたの";
    await seq.registerSpoken(_spokenFrame(sentence), "ctx1", sentence, true);
    const skipped = _skippedFrame("[skipped]");
    await seq.registerSkipped(skipped, "ctx2", null);

    const r1 = seq.processWord("こんにちは、私", 100, "ctx1");
    expect(r1.some((f) => f === skipped)).toBe(false);

    const r2 = seq.processWord("はあなたの", 200, "ctx1");
    expect(r2.some((f) => f === skipped)).toBe(true);
  });

  test("test_japanese_force_complete_emits_remaining_chars", async () => {
    // After the first Japanese combined group, forceComplete emits the rest.
    const seq = _seq();
    const sentence = "こんにちは、私はあなたの";
    await seq.registerSpoken(_spokenFrame(sentence), "ctx1", sentence, true);
    seq.processWord("こんにちは、私", 10, "ctx1");

    const result = seq.forceComplete("ctx1", 50);
    const tts = ttsFrames(result);
    expect(tts.length).toBe(1);
    expect(tts[0]!.text).toBe("はあなたの");
  });

  // --- Chinese ---

  test("test_chinese_combined_groups_complete_spoken_slot", async () => {
    // Two Cartesia-style combined Chinese groups complete the slot and flush skipped.
    const seq = _seq();
    const sentence = "你好，我是你的智能";
    await seq.registerSpoken(_spokenFrame(sentence), "ctx1", sentence, true);
    const skipped = _skippedFrame("[skipped]");
    await seq.registerSkipped(skipped, "ctx2", null);

    const r1 = seq.processWord("你好，我是", 100, "ctx1");
    expect(r1.some((f) => f === skipped)).toBe(false);

    const r2 = seq.processWord("你的智能", 200, "ctx1");
    expect(r2.some((f) => f === skipped)).toBe(true);
  });

  test("test_chinese_force_complete_emits_remaining_chars", async () => {
    // After the first Chinese combined group, forceComplete emits the rest.
    const seq = _seq();
    const sentence = "你好，我是你的智能";
    await seq.registerSpoken(_spokenFrame(sentence), "ctx1", sentence, true);
    seq.processWord("你好，我是", 10, "ctx1");

    const result = seq.forceComplete("ctx1", 50);
    const tts = ttsFrames(result);
    expect(tts.length).toBe(1);
    expect(tts[0]!.text).toBe("你的智能");
  });
});

// ---------------------------------------------------------------------------
// CJK context assembly — includesInterFrameSpaces propagation
// ---------------------------------------------------------------------------

/** Reassemble TTSTextFrames the same way the context aggregator does. */
function _assembleContextFromText(frames: Frame[]): string {
  const parts = ttsFrames(frames).map(
    (f) =>
      new TextPartForConcatenation({
        text: f.text,
        includesInterPartSpaces: f.includesInterFrameSpaces,
      }),
  );
  return concatenateAggregatedText(parts);
}

/**
 * CJK word-timestamp chunks assembled into assistant context must not include extra spaces.
 *
 * Regression: _buildWordFrame always created TTSTextFrame(includesInterFrameSpaces=false).
 * The context aggregator then injected a space between every consecutive word frame,
 * producing "です。 何か" instead of "です。何か" for Japanese/Chinese.
 *
 * The fix stamps the correct flag on each frame so the context aggregator skips the space.
 */
describe("TestCJKContextAssembly", () => {
  test("test_japanese_chunks_no_space_in_context", async () => {
    // Japanese ElevenLabs-style word chunks must concatenate without an extra space.
    const seq = _seq();
    const sentence = "どんなことでも気軽に相談してくださいね。";
    await seq.registerSpoken(_spokenFrame(sentence), "ctx1", sentence, true, {
      includesInterFrameSpaces: true,
    });

    const r1 = seq.processWord("どんなことでも気", 100, "ctx1");
    const r2 = seq.processWord("軽に相談してくださいね。", 200, "ctx1");

    const contextText = _assembleContextFromText([...r1, ...r2]);
    // Japanese CJK chunks must not be separated by a space in context
    expect(contextText).toBe("どんなことでも気軽に相談してくださいね。");
  });

  test("test_chinese_chunks_no_space_in_context", async () => {
    // Chinese ElevenLabs-style word chunks must concatenate without an extra space.
    const seq = _seq();
    const sentence = "你好，我是你的智能助手。";
    await seq.registerSpoken(_spokenFrame(sentence), "ctx1", sentence, true, {
      includesInterFrameSpaces: true,
    });

    const r1 = seq.processWord("你好，我是", 100, "ctx1");
    const r2 = seq.processWord("你的智能助手。", 200, "ctx1");

    const contextText = _assembleContextFromText([...r1, ...r2]);
    // Chinese CJK chunks must not be separated by a space in context
    expect(contextText).toBe("你好，我是你的智能助手。");
  });

  test("test_english_words_still_have_spaces_in_context", async () => {
    // Non-CJK (English) word tokens must still be joined with spaces.
    const seq = _seq();
    const sentence = "Hello world.";
    await seq.registerSpoken(_spokenFrame(sentence), "ctx1", sentence, true);

    const r1 = seq.processWord("Hello", 100, "ctx1");
    const r2 = seq.processWord("world.", 200, "ctx1");

    const contextText = _assembleContextFromText([...r1, ...r2]);
    expect(contextText).toBe("Hello world.");
  });

  test("test_force_complete_cjk_frame_has_flag", async () => {
    // forceComplete for a CJK slot must also produce a frame with the flag set.
    const seq = _seq();
    const sentence = "こんにちは、私はあなたの";
    await seq.registerSpoken(_spokenFrame(sentence), "ctx1", sentence, true, {
      includesInterFrameSpaces: true,
    });
    seq.processWord("こんにちは、私", 10, "ctx1");

    const result = seq.forceComplete("ctx1", 50);
    const tts = ttsFrames(result);
    expect(tts.length).toBe(1);
    // forceComplete must propagate includesInterFrameSpaces for CJK slots
    expect(tts[0]!.includesInterFrameSpaces).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AggregatedTextProgressFrame emission
// ---------------------------------------------------------------------------

describe("TestAggregatedTextProgressFrame", () => {
  async function _seqWithSpoken(
    text: string,
    ctx = "ctx1",
  ): Promise<[AggregatedFrameSequencer, AggregatedTextFrame]> {
    const seq = _seq();
    const frame = _spokenFrame(text);
    await seq.registerSpoken(frame, ctx, text, true);
    return [seq, frame];
  }

  test("test_progress_frame_emitted_alongside_word_frame", async () => {
    const [seq, source] = await _seqWithSpoken("hello");
    const result = seq.processWord("hello", 100, "ctx1");
    const progress = progressFrames(result);
    expect(progress.length).toBe(1);
    const p = progress[0]!;
    expect(p.text).toBe("hello");
    expect(p.textType).toBe(TextType.SENTENCE);
    expect(p.accumulatedText).toBe("hello");
    expect(p.remainingText).toBe("");
    expect(p.contextId).toBe("ctx1");
    expect(p.segmentId).toBe(source.id);
    expect(p.pts).toBe(100);
  });

  test("test_progress_accumulated_and_remaining_mid_slot", async () => {
    const [seq] = await _seqWithSpoken("hello world");
    const result = seq.processWord("hello", 10, "ctx1");
    const progress = progressFrames(result);
    expect(progress.length).toBe(1);
    expect(progress[0]!.accumulatedText).toBe("hello");
    expect(progress[0]!.remainingText).toBe(" world");
  });

  test("test_no_progress_frame_for_passthrough", () => {
    // A word emitted beside the queue rather than against a slot has no slot to
    // report progress for.
    const seq = _seq();
    const result = seq.processWord("hello", 1, null);
    const progress = progressFrames(result);
    expect(progress).toEqual([]);
  });

  test("test_progress_uses_user_facing_text_not_tts_text", async () => {
    // accumulated/remaining in the progress frame come from userFacingText, not ttsText.
    const seq = _seq();
    const frame = _spokenFrame("4111 1111 1111 1111", "<card>4111 1111 1111 1111</card>");
    await seq.registerSpoken(frame, "ctx1", "<spell>4111 1111 1111 1111</spell>", true);
    const result = seq.processWord("4111", 10, "ctx1");
    const progress = progressFrames(result);
    expect(progress.length).toBe(1);
    const p = progress[0]!;
    // userFacingText has no SSML tags
    expect(p.accumulatedText).toBe("4111");
    expect(p.remainingText).toBe(" 1111 1111 1111");
  });

  test("test_french_space_before_question_mark_word_by_word", async () => {
    // Trailing space-separated punctuation ("Comment ça va ?") completes the slot.
    //
    // French typography sets terminal `?` off from its word with a space, and
    // the TTS emits that `?` as its own word-timestamp event. The slot must
    // stay open until the `?` arrives, and the final progress frame must carry
    // the full sentence as `accumulatedText` with an empty `remainingText`
    // -- otherwise RTVI clients committing captions on the completed sentence
    // would drop the `?`.
    const seq = _seq();
    const frame = _spokenFrame("Comment ça va ?");
    await seq.registerSpoken(frame, "ctx1", "Comment ça va ?", true);

    const steps: [string, string, string][] = [
      ["Comment", "Comment", " ça va ?"],
      ["ça", "Comment ça", " va ?"],
      ["va", "Comment ça va", " ?"],
      ["?", "Comment ça va ?", ""],
    ];
    for (const [word, expAcc, expRem] of steps) {
      const result = seq.processWord(word, 10, "ctx1");
      expect(ttsFrames(result).map((f) => f.text)).toEqual([word]);
      const progress = progressFrames(result);
      // expected 1 progress frame after `word`
      expect(progress.length).toBe(1);
      expect(progress[0]!.accumulatedText).toBe(expAcc);
      expect(progress[0]!.remainingText).toBe(expRem);
    }

    // The "va" (last alnum) word must NOT complete the slot; only "?" does.
    expect(internals(seq)._slots).toEqual([]);
  });

  test("test_french_same_sentence_twice_word_by_word", async () => {
    // Two consecutive identical French sentences each complete on their own `?`.
    //
    // Reproduces the double `TTSSpeakFrame("Comment ça va ?")` scenario: both
    // sentences occupy their own slot/context and stream in word by word. Each
    // must complete only when its trailing `?` arrives, and every progress
    // frame must be attributed to the sentence's own context -- the second
    // sentence's words must not leak into the first slot or vice versa.
    const seq = _seq();
    const sentence = "Comment ça va ?";
    await seq.registerSpoken(_spokenFrame(sentence), "ctx1", sentence, true);
    await seq.registerSpoken(_spokenFrame(sentence), "ctx2", sentence, true);

    const steps: [string, string, string][] = [
      ["Comment", "Comment", " ça va ?"],
      ["ça", "Comment ça", " va ?"],
      ["va", "Comment ça va", " ?"],
      ["?", "Comment ça va ?", ""],
    ];

    // First sentence: consumes ctx1, ctx2 stays queued behind it.
    for (const [word, expAcc, expRem] of steps) {
      const result = seq.processWord(word, 10, "ctx1");
      const words = ttsFrames(result);
      expect(words.map((f) => f.text)).toEqual([word]);
      expect(words.every((f) => f.contextId === "ctx1")).toBe(true);
      const progress = progressFrames(result);
      expect(progress.length).toBe(1);
      expect(progress[0]!.contextId).toBe("ctx1");
      expect(progress[0]!.accumulatedText).toBe(expAcc);
      expect(progress[0]!.remainingText).toBe(expRem);
    }

    // ctx1 is complete and swept; ctx2 is now the active slot.
    expect(internals(seq)._slots.length).toBe(1);

    // Second sentence: consumes ctx2 and empties the queue.
    for (const [word, expAcc, expRem] of steps) {
      const result = seq.processWord(word, 20, "ctx2");
      const words = ttsFrames(result);
      expect(words.map((f) => f.text)).toEqual([word]);
      expect(words.every((f) => f.contextId === "ctx2")).toBe(true);
      const progress = progressFrames(result);
      expect(progress.length).toBe(1);
      expect(progress[0]!.contextId).toBe("ctx2");
      expect(progress[0]!.accumulatedText).toBe(expAcc);
      expect(progress[0]!.remainingText).toBe(expRem);
    }

    expect(internals(seq)._slots).toEqual([]);
  });

  test("test_card_scenario_word_by_word", async () => {
    // Progress accumulated/remaining track userFacingText through all four digit groups.
    const seq = _seq();
    const frame = _spokenFrame("4111 1111 1111 1111", "<card>4111 1111 1111 1111</card>");
    await seq.registerSpoken(frame, "ctx1", "<spell>4111 1111 1111 1111</spell>", true);

    const steps: [string, string, string][] = [
      ["4111", "4111", " 1111 1111 1111"],
      ["1111", "4111 1111", " 1111 1111"],
      ["1111", "4111 1111 1111", " 1111"],
      ["1111", "4111 1111 1111 1111", ""],
    ];
    for (const [word, expAcc, expRem] of steps) {
      const result = seq.processWord(word, 10, "ctx1");
      const progress = progressFrames(result);
      // expected 1 progress frame after `word`
      expect(progress.length).toBe(1);
      expect(progress[0]!.accumulatedText).toBe(expAcc);
      expect(progress[0]!.remainingText).toBe(expRem);
    }
  });
});

// ---------------------------------------------------------------------------
// CJK includesInterFrameSpaces: per-call arg must reach the emitted frame
// even when registerSpoken did not set the flag on the slot.
//
// Regression: processWord used slot.includesInterFrameSpaces exclusively
// when an active slot existed, ignoring the per-call includesInterFrameSpaces
// argument. tts_service calls registerSpoken() without setting this flag,
// so it always defaulted to false even when addWordTimestamps was called
// with includesInterFrameSpaces=true (as ElevenLabsTTSService does for CJK).
// ---------------------------------------------------------------------------

/**
 * processWord must propagate includesInterFrameSpaces to TTSTextFrame.
 *
 * These tests simulate the tts_service code path: registerSpoken is called
 * without includesInterFrameSpaces (the default false), and then processWord
 * is called with includesInterFrameSpaces=true (as addWordTimestamps does
 * for ElevenLabs CJK languages).
 *
 * The flag must reach the emitted TTSTextFrame so the context aggregator knows
 * not to inject spaces between consecutive CJK word tokens.
 */
describe("TestCJKProcessWordFlagPropagation", () => {
  test("test_process_word_flag_reaches_frame_when_slot_has_no_flag", async () => {
    // includesInterFrameSpaces=true on processWord must stamp the emitted frame.
    const seq = _seq();
    const sentence = "どんなことでも気軽に話しかけてくださいね。";
    // tts_service does NOT pass includesInterFrameSpaces to registerSpoken
    await seq.registerSpoken(_spokenFrame(sentence), "ctx1", sentence, true);

    // addWordTimestamps passes includesInterFrameSpaces=true for CJK
    const result = seq.processWord("どんなことでも気", 100, "ctx1", true);

    const tts = ttsFrames(result);
    expect(tts.length).toBe(1);
    // TTSTextFrame must carry includesInterFrameSpaces=true when processWord
    // is called with that flag, even if registerSpoken did not set it on the slot
    expect(tts[0]!.includesInterFrameSpaces).toBe(true);
  });

  test("test_cjk_two_chunks_no_space_when_slot_has_no_flag", async () => {
    // Two CJK chunks must concatenate without a space when processWord carries the flag.
    //
    // Matches the ElevenLabs runtime: registerSpoken gets no flag; both
    // processWord calls get includesInterFrameSpaces=true. Context assembly
    // must produce '気軽に' not '気 軽に'.
    const seq = _seq();
    const sentence = "どんなことでも気軽に話しかけてくださいね。";
    await seq.registerSpoken(_spokenFrame(sentence), "ctx1", sentence, true);

    const r1 = seq.processWord("どんなことでも気", 100, "ctx1", true);
    const r2 = seq.processWord("軽に話しかけてくださいね。", 200, "ctx1", true);

    const assembled = _assembleContextFromText([...r1, ...r2]);
    // CJK word chunks must concatenate without spaces when processWord
    // carries includesInterFrameSpaces=true
    expect(assembled).toBe("どんなことでも気軽に話しかけてくださいね。");
  });

  test("test_force_complete_cjk_flag_when_slot_has_no_flag", async () => {
    // forceComplete must also carry the flag for CJK slots registered without it.
    //
    // When TTS drops the final token, forceComplete emits the remainder. The
    // flag must still reach that frame so the context assembler doesn't add a space.
    const seq = _seq();
    const sentence = "どんなことでも気軽に話しかけてくださいね。";
    await seq.registerSpoken(_spokenFrame(sentence), "ctx1", sentence, true);

    // First chunk arrives with the flag via processWord
    seq.processWord("どんなことでも気", 100, "ctx1", true);
    // Second chunk is dropped by TTS — forceComplete emits the remainder
    const result = seq.forceComplete("ctx1", 200);
    const tts = ttsFrames(result);

    expect(tts.length).toBe(1);
    // forceComplete must propagate includesInterFrameSpaces for CJK slots
    // even when registerSpoken did not set the flag
    expect(tts[0]!.includesInterFrameSpaces).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Voice-formatting: sequencer behaviour when transforms change alnum content
//
// Simulates the billing message scenario:
//   userFacing: "Your balance is $5, due on 3/15. Call us at 555-1234."
//   tts (post-transform): "Your balance is five dollars, due on 3/15. Call us at 555-1234."
//
// Expected sequencer behaviour:
//   - "five"    → appendToContext=false (mid transformed segment, suppress)
//   - "dollars," → appendToContext=true (segment completes, rawText="$5,")
//   - All other words → appendToContext=true (unchanged segments)
// ---------------------------------------------------------------------------

const _BILL_UF = "Your balance is $5, due on 3/15. Call us at 555-1234.";
const _BILL_TTS = "Your balance is five dollars, due on 3/15. Call us at 555-1234.";
const _BILL_WORDS = [
  "Your",
  "balance",
  "is",
  "five",
  "dollars,",
  "due",
  "on",
  "3/15.",
  "Call",
  "us",
  "at",
  "555-1234.",
];

/** Sequencer correctly handles transform-aware trackers for billing messages. */
describe("TestVoiceFormattingTransforms", () => {
  async function _setup(): Promise<[AggregatedFrameSequencer, AggregatedTextFrame]> {
    const seq = new AggregatedFrameSequencer({ name: "test-billing" });
    const source = new AggregatedTextFrame({
      text: _BILL_UF,
      textType: TextType.SENTENCE,
      rawText: _BILL_UF,
    });
    await seq.registerSpoken(source, "ctx1", _BILL_TTS, true);
    return [seq, source];
  }

  function _advance(seq: AggregatedFrameSequencer, ...words: string[]): void {
    for (const word of words) {
      seq.processWord(word, 10, "ctx1");
    }
  }

  // --- appendToContext ---

  test("test_pre_transform_words_append_to_context", async () => {
    const [seq] = await _setup();
    for (const word of ["Your", "balance", "is"]) {
      const result = seq.processWord(word, 10, "ctx1");
      const wf = ttsFrames(result);
      // word should append to context
      expect([word, wf[0]!.appendToContext]).toEqual([word, true]);
    }
  });

  test("test_mid_transform_word_suppressed", async () => {
    // `five` is mid-segment: appendToContext must be false.
    const [seq] = await _setup();
    _advance(seq, "Your", "balance", "is");
    const result = seq.processWord("five", 20, "ctx1");
    const wf = ttsFrames(result);
    expect(wf.length).toBe(1);
    expect(wf[0]!.appendToContext).toBe(false);
  });

  test("test_completing_transform_word_appends_to_context", async () => {
    // `dollars,` completes the segment: appendToContext must be true.
    const [seq] = await _setup();
    _advance(seq, "Your", "balance", "is", "five");
    const result = seq.processWord("dollars,", 30, "ctx1");
    const wf = ttsFrames(result);
    expect(wf.length).toBe(1);
    expect(wf[0]!.appendToContext).toBe(true);
  });

  test("test_post_transform_words_append_to_context", async () => {
    const [seq] = await _setup();
    _advance(seq, "Your", "balance", "is", "five", "dollars,");
    const result = seq.processWord("due", 40, "ctx1");
    const wf = ttsFrames(result);
    expect(wf[0]!.appendToContext).toBe(true);
  });

  // --- rawText / llmConsumed ---

  test("test_mid_transform_word_raw_text_none", async () => {
    // `five` is mid-segment: rawText must be null so it is not written to context.
    const [seq] = await _setup();
    _advance(seq, "Your", "balance", "is");
    const result = seq.processWord("five", 20, "ctx1");
    const wf = ttsFrames(result);
    expect(wf[0]!.rawText).toBeNull();
  });

  test("test_completing_transform_word_raw_text_is_original", async () => {
    // `dollars,` completing the segment must carry `$5,` as rawText.
    const [seq] = await _setup();
    _advance(seq, "Your", "balance", "is", "five");
    const result = seq.processWord("dollars,", 30, "ctx1");
    const wf = ttsFrames(result);
    expect(wf[0]!.rawText).toBe("$5,");
  });

  // --- AggregatedTextProgressFrame ---

  test("test_no_progress_frame_emitted_mid_transform", async () => {
    // No AggregatedTextProgressFrame is emitted for mid-segment words ('five').
    //
    // The userFacingPos is held during a transformed segment, so emitting a
    // progress frame with identical accumulated/remaining text would be redundant.
    const [seq] = await _setup();
    _advance(seq, "Your", "balance", "is");
    const result = seq.processWord("five", 20, "ctx1");
    expect(progressFrames(result)).toEqual([]);
  });

  test("test_progress_accumulated_jumps_after_transform_completes", async () => {
    // After 'dollars,' completes, accumulatedText must include 'Your balance is $5,'.
    const [seq] = await _setup();
    _advance(seq, "Your", "balance", "is", "five");
    const result = seq.processWord("dollars,", 30, "ctx1");
    const pf = progressFrames(result);
    expect(pf.length).toBe(1);
    expect(pf[0]!.accumulatedText).toBe("Your balance is $5,");
  });

  test("test_progress_remaining_after_transform_completes", async () => {
    // After 'dollars,', remainingText starts with 'due on 3/15.'
    const [seq] = await _setup();
    _advance(seq, "Your", "balance", "is", "five");
    const result = seq.processWord("dollars,", 30, "ctx1");
    const pf = progressFrames(result);
    expect(pf[0]!.remainingText.startsWith(" due on 3/15.")).toBe(true);
  });

  test("test_progress_full_sentence_completion", async () => {
    // After all words the slot is complete and the queue is empty.
    const [seq] = await _setup();
    for (const word of _BILL_WORDS) {
      seq.processWord(word, 10, "ctx1");
    }
    expect(internals(seq)._slots).toEqual([]);
  });

  // --- forceComplete during transform ---

  test("test_force_complete_mid_transform_emits_remaining_tts_text", async () => {
    // forceComplete when mid-segment emits remaining ttsText (not userFacingText).
    const [seq] = await _setup();
    _advance(seq, "Your", "balance", "is", "five");
    // "dollars," never arrives — force complete
    const result = seq.forceComplete("ctx1", 99);
    const wf = ttsFrames(result);
    expect(wf.length).toBe(1);
    // Remaining ttsText starts with "dollars," (the unexpanded portion)
    expect(wf[0]!.text).toContain("dollars,");
  });

  test("test_force_complete_after_transform_emits_remaining_unchanged_text", async () => {
    // forceComplete after the transform emits remaining ttsText correctly.
    const [seq] = await _setup();
    _advance(seq, "Your", "balance", "is", "five", "dollars,", "due", "on");
    const result = seq.forceComplete("ctx1", 99);
    const wf = ttsFrames(result);
    expect(wf.length).toBe(1);
    expect(wf[0]!.text).toContain("3/15.");
    expect(wf[0]!.text).toContain("555-1234.");
  });
});

// ---------------------------------------------------------------------------
// registerSpoken — streaming (TOKEN mode): token-by-token sentence accumulation
//
// In streaming mode the sequencer owns a _ParallelSentenceAggregator;
// registerSpoken is called once per token and only registers a real slot once a
// sentence boundary is confirmed (which happens when the NEXT sentence's first
// token arrives, or via finalize() at end of turn).
// ---------------------------------------------------------------------------

/** Feed same-text tokens through streaming registerSpoken; return pushed frames. */
async function _stream(
  seq: AggregatedFrameSequencer,
  ctx: string,
  ...tokens: string[]
): Promise<Frame[]> {
  const frames: Frame[] = [];
  for (const t of tokens) {
    frames.push(...(await seq.registerSpoken(_spokenFrame(t), ctx, t, true)));
  }
  return frames;
}

describe("TestRegisterSpokenStreaming", () => {
  test("test_promoted_sentence_keeps_the_type_its_text_was_given_with", async () => {
    const seq = _seq(true);
    const frame = new AggregatedTextFrame({ text: "One moment, please.", textType: "status" });
    await seq.registerSpoken(frame, "ctx1", "One moment, please.", false);
    await seq.finalize("ctx1");
    expect(internals(seq)._slots[0]!.frame.textType).toBe("status");
  });

  test("test_sentence_spoken_in_one_piece_carries_its_segment_id", async () => {
    const seq = _seq(true);
    const frame = new AggregatedTextFrame({ text: "Hi there.", textType: TextType.TOKEN });
    const result = await seq.registerSpoken(frame, "ctx1", "Hi there.", true, {
      buildTracker: false,
    });
    result.push(...(await seq.finalize("ctx1")));
    const sentence = result.find((f) => f.constructor === AggregatedTextFrame)!;
    const spoken = result.find((f): f is TTSTextFrame => f instanceof TTSTextFrame)!;
    expect(spoken.segmentId).toBe(sentence.id);
  });

  test("test_streamed_tokens_promote_as_a_sentence", async () => {
    const seq = _seq(true);
    for (const token of ["Hi", " there", "!"]) {
      const frame = new AggregatedTextFrame({ text: token, textType: TextType.TOKEN });
      await seq.registerSpoken(frame, "ctx1", token, true);
    }
    await seq.finalize("ctx1");
    expect(internals(seq)._slots[0]!.frame.textType).toBe(TextType.SENTENCE);
  });

  test("test_non_terminal_tokens_do_not_promote", async () => {
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hi", " there");
    expect(internals(seq)._slots).toEqual([]);
  });

  test("test_terminal_token_alone_does_not_promote", async () => {
    // Needs the next sentence's lookahead token before the boundary confirms.
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hi", " there", "!");
    expect(internals(seq)._slots).toEqual([]);
  });

  test("test_next_sentence_token_promotes_clean_first_sentence", async () => {
    const seq = _seq(true);
    // The lookahead token " How" confirms "Hi there!" but is NOT folded in.
    await _stream(seq, "ctx1", "Hi", " there", "!", " How");
    expect(internals(seq)._slots.length).toBe(1);
    const slot = internals(seq)._slots[0]!;
    expect(slot.tracker).not.toBeNull();
    expect(slot.frame.textType).toBe(TextType.SENTENCE);
    expect(slot.frame.text).toBe("Hi there!");
  });

  test("test_promoted_slot_processes_words_normally", async () => {
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hi", " there", "!", " How"); // promotes "Hi there!"
    const result = seq.processWord("Hi", 10, "ctx1");
    result.push(...seq.processWord("there!", 20, "ctx1"));
    const words = ttsFrames(result);
    const progress = progressFrames(result);
    expect(words.map((f) => f.text)).toEqual(["Hi", "there!"]);
    expect(progress[progress.length - 1]!.accumulatedText).toBe("Hi there!");
    expect(progress[progress.length - 1]!.remainingText).toBe("");
  });

  test("test_slot_ifs_not_set_from_streaming_path", async () => {
    // The spacing bug: LLM tokens carry includesInterFrameSpaces=true, but
    // that must NOT propagate to the promoted slot / word frames — English
    // word timestamps must still be joined with spaces in the context.
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hi", " there", "!", " How");
    expect(internals(seq)._slots[0]!.includesInterFrameSpaces).toBe(false);
    const r1 = seq.processWord("Hi", 10, "ctx1");
    const r2 = seq.processWord("there!", 20, "ctx1");
    const parts = ttsFrames([...r1, ...r2]).map(
      (f) =>
        new TextPartForConcatenation({
          text: f.text,
          includesInterPartSpaces: f.includesInterFrameSpaces,
        }),
    );
    expect(concatenateAggregatedText(parts)).toBe("Hi there!");
  });

  test("test_multi_sentence_promotes_each_cleanly", async () => {
    const seq = _seq(true);
    // Two sentences streamed; the first promotes when the second starts.
    await _stream(seq, "ctx1", "Hi", " there", "!", " How", " are", " you", "?");
    expect(internals(seq)._slots.map((s) => s.frame.text)).toEqual(["Hi there!"]);
    // The trailing sentence promotes on finalize.
    await seq.finalize("ctx1");
    expect(internals(seq)._slots.map((s) => s.frame.text)).toEqual(["Hi there!", " How are you?"]);
  });

  test("test_transformed_tts_text_preserved_through_promotion", async () => {
    const seq = _seq(true);
    // tts differs from user-facing (a simulated transform): "$5" -> "five dollars".
    for (const [tts, txt] of [
      ["five dollars", "$5"],
      [".", "."],
      [" Ok", " Ok"],
    ] as const) {
      await seq.registerSpoken(_spokenFrame(txt), "ctx1", tts, true);
    }
    expect(internals(seq)._slots.length).toBe(1);
    const slot = internals(seq)._slots[0]!;
    expect(slot.frame.text).toBe("$5."); // user-facing unaffected
    const result = seq.processWord("five", 10, "ctx1");
    const words = ttsFrames(result);
    expect(words[0]!.text).toBe("five");
  });

  test("test_no_tracker_still_groups_into_sentences", async () => {
    // streaming + buildTracker=false (pushTextFrames=true): tokens are still
    // grouped into sentences, not registered as one slot per token. The promoted
    // slot completes immediately (no tracker to progress it), so it's swept from
    // _slots as soon as it promotes.
    const seq = _seq(true);
    await seq.registerSpoken(_spokenFrame("Hi"), "ctx1", "Hi", true, { buildTracker: false });
    expect(internals(seq)._slots).toEqual([]); // nothing promoted yet
    const result: Frame[] = [];
    for (const t of [" there", "!", " How"]) {
      result.push(
        ...(await seq.registerSpoken(_spokenFrame(t), "ctx1", t, true, { buildTracker: false })),
      );
    }
    expect(internals(seq)._slots).toEqual([]); // promoted and immediately completed
    const aggFrames = result.filter(
      (f): f is AggregatedTextFrame => f.constructor === AggregatedTextFrame,
    );
    const words = ttsFrames(result);
    expect(aggFrames.map((f) => f.text)).toEqual(["Hi there!"]);
    expect(aggFrames[0]!.willBeSpoken).toBe(true);
    expect(aggFrames[0]!.appendToContext).toBe(false);
    expect(words.map((f) => f.text)).toEqual(["Hi there!"]);
    expect(words[0]!.willBeSpoken).toBe(true);
    expect(words[0]!.appendToContext).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// registerSpoken — streaming: words buffered until a pending sentence promotes
// ---------------------------------------------------------------------------

describe("TestRegisterSpokenBufferedWords", () => {
  test("test_word_for_pending_sentence_is_buffered", async () => {
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hi", " there"); // nothing promoted yet
    const result = seq.processWord("Hi", 10, "ctx1");
    expect(result).toEqual([]);
    expect(internals(seq)._bufferedWords.length).toBe(1);
  });

  test("test_buffered_word_replayed_once_boundary_confirmed", async () => {
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hi", " there", "!"); // pending, not promoted
    // Word arrives before promotion -> buffered.
    expect(seq.processWord("Hi", 10, "ctx1")).toEqual([]);
    // The next sentence's token promotes "Hi there!"; buffered word replays.
    const result = await _stream(seq, "ctx1", " How");
    const words = ttsFrames(result);
    expect(words.map((f) => f.text)).toEqual(["Hi"]);
  });

  test("test_word_still_unmatched_after_one_promotion_is_rebuffered", async () => {
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hi", " there", "!", " How"); // promotes "Hi there!"
    expect(internals(seq)._slots.length).toBe(1);
    // A word for the second (not-yet-promoted) sentence is buffered.
    expect(seq.processWord("How", 5, "ctx1")).toEqual([]);
    expect(internals(seq)._bufferedWords.length).toBe(1);
    // First sentence completes via its own words.
    seq.processWord("Hi", 10, "ctx1");
    seq.processWord("there!", 20, "ctx1");
    expect(internals(seq)._slots).toEqual([]);
    // Second sentence promotes; the buffered "How" now matches.
    const result = await seq.finalize("ctx1");
    const words = ttsFrames(result);
    expect(words.some((f) => f.text === "How")).toBe(true);
  });

  test("test_non_streaming_sequencer_drops_instead_of_buffering", async () => {
    // Buffering only makes sense while a sentence may still be promoted. With
    // every slot already registered, an unplaceable word is simply dropped.
    const seq = _seq(false);
    await seq.registerSpoken(_spokenFrame("hello world"), "ctx1", "hello world", true);
    expect(seq.processWord("zzz", 5, "ctx1")).toEqual([]);
    expect(internals(seq)._bufferedWords).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// registerSkipped — finalizes a pending streamed sentence first
// ---------------------------------------------------------------------------

describe("TestRegisterSkippedForcesFinalize", () => {
  test("test_pending_sentence_promoted_before_skipped_slot", async () => {
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hi", " there"); // pending, no boundary
    const skipped = _skippedFrame("code");
    // A turn's skipped frame shares the turn context ID, so registerSkipped
    // finalizes this same context's pending sentence first.
    await seq.registerSkipped(skipped, "ctx1", null);
    const slots = internals(seq)._slots;
    expect(slots.length).toBe(2);
    expect(slots[0]!.spoken).toBe(true);
    expect(slots[0]!.frame.text).toBe("Hi there");
    expect(slots[1]!.spoken).toBe(false);
    expect(slots[1]!.frame).toBe(skipped);
  });

  test("test_register_skipped_with_nothing_pending_behaves_as_today", async () => {
    const seq = _seq(true);
    const frame = _skippedFrame("code");
    const result = await seq.registerSkipped(frame, "ctx1", null);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(frame);
  });

  test("test_skipped_frame_stays_blocked_until_finalized_sentence_completes", async () => {
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hi", " there");
    const skipped = _skippedFrame("code");
    let result = await seq.registerSkipped(skipped, "ctx1", null);
    // The forced finalize emits the sentence frame, but the skipped frame
    // stays blocked behind the not-yet-spoken sentence slot.
    expect(result.some((f) => f === skipped)).toBe(false);
    result = seq.processWord("Hi", 10, "ctx1");
    result.push(...seq.processWord("there", 20, "ctx1"));
    expect(result.some((f) => f === skipped)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// finalize — end-of-turn forced promotion
// ---------------------------------------------------------------------------

describe("TestFinalizeEndOfTurn", () => {
  test("test_finalize_promotes_pending_sentence_with_no_terminal_punctuation", async () => {
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hi", " there");
    expect(internals(seq)._slots).toEqual([]);
    const result = await seq.finalize("ctx1");
    // The promoted sentence frame is emitted (the "new" announcement).
    expect(result.length).toBe(1);
    expect(result[0]).toBeInstanceOf(AggregatedTextFrame);
    const promoted = result[0] as AggregatedTextFrame;
    expect(promoted.text).toBe("Hi there");
    expect(promoted.willBeSpoken).toBe(true);
    expect(internals(seq)._slots.length).toBe(1);
    expect(internals(seq)._slots[0]!.frame.text).toBe("Hi there");
  });

  test("test_finalize_with_nothing_pending_is_a_noop", async () => {
    const seq = _seq(true);
    expect(await seq.finalize("ctx1")).toEqual([]);
    expect(internals(seq)._slots).toEqual([]);
  });

  test("test_finalize_on_non_streaming_is_a_noop", async () => {
    const seq = _seq(false);
    expect(await seq.finalize("ctx1")).toEqual([]);
  });

  test("test_finalize_does_not_create_slot_for_whitespace_only_pending", async () => {
    const seq = _seq(true);
    await _stream(seq, "ctx1", "   ");
    const result = await seq.finalize("ctx1");
    expect(result).toEqual([]);
    expect(internals(seq)._slots).toEqual([]);
  });

  test("test_finalize_then_processing_words_drains_the_slot", async () => {
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hi", " there");
    await seq.finalize("ctx1");
    seq.processWord("Hi", 10, "ctx1");
    seq.processWord("there", 20, "ctx1");
    expect(internals(seq)._slots).toEqual([]);
  });

  test("test_finalize_keeps_context_live_for_later_words", async () => {
    // finalize releases the pending-sentence aggregator but must keep the context
    // live, since its word-timestamp events still arrive afterwards (during audio
    // playback) and must not be dropped as stale.
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hi", " there");
    await seq.finalize("ctx1");
    const result = seq.processWord("Hi", 10, "ctx1");
    expect(result.some((f) => f instanceof TTSTextFrame && f.text === "Hi")).toBe(true);
  });

  test("test_finalize_is_per_context", async () => {
    // Two contexts pending at once: finalizing one must not promote the other.
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hello");
    await _stream(seq, "ctx2", "World");
    await seq.finalize("ctx1");
    expect(internals(seq)._slots.map((s) => s.frame.text)).toEqual(["Hello"]);
    await seq.finalize("ctx2");
    expect(internals(seq)._slots.map((s) => s.frame.text)).toEqual(["Hello", "World"]);
  });
});

// ---------------------------------------------------------------------------
// finalize rescues a mid-sentence prefix when a context is closed early
// ---------------------------------------------------------------------------

/**
 * A context closed mid-sentence (e.g. a TTS settings change re-mints the
 * turn context) must finalize its pending sentence, or the already-heard
 * prefix's word-timestamps land on no slot and are dropped from the transcript.
 */
describe("TestFinalizeRescuesMidSentencePrefix", () => {
  test("test_word_after_finalize_emits_progress_for_heard_prefix", async () => {
    const seq = _seq(true);
    // A sentence is mid-stream: two tokens, no terminal boundary yet.
    await _stream(seq, "ctx1", "Hi", " there");
    expect(internals(seq)._slots).toEqual([]);
    // The context is closed early — finalize force-promotes the prefix.
    await seq.finalize("ctx1");
    // A word-timestamp for the flushed prefix now lands on the promoted slot
    // and emits both the word frame and a progress frame.
    const result = seq.processWord("Hi", 10, "ctx1");
    expect(result.some((f) => f instanceof TTSTextFrame && f.text === "Hi")).toBe(true);
    const progress = progressFrames(result);
    expect(progress.length).toBe(1);
    expect(progress[0]!.accumulatedText).toBe("Hi");
  });

  test("test_word_without_finalize_emits_no_progress", async () => {
    // Same setup, but the prefix is never finalized (the pre-fix bug): the
    // word for the still-pending sentence is buffered and no progress frame
    // is emitted for the heard prefix.
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hi", " there");
    expect(internals(seq)._slots).toEqual([]);
    const result = seq.processWord("Hi", 10, "ctx1");
    expect(result).toEqual([]);
    expect(result.some((f) => f instanceof AggregatedTextProgressFrame)).toBe(false);
    expect(internals(seq)._bufferedWords.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Concurrent contexts — two audio contexts in flight at once must not bleed
// ---------------------------------------------------------------------------

describe("TestConcurrentContexts", () => {
  test("test_concurrent_pending_sentences_dont_bleed_across_contexts", async () => {
    // Each context keeps its own pending-sentence buffer.
    //
    // Tokens for two contexts are interleaved before either confirms a boundary.
    // When one finalizes, its promoted sentence must contain only that context's
    // text and carry its own context ID.
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Comment", " ça");
    await _stream(seq, "ctx2", "Bom", " jour");

    const r1 = await seq.finalize("ctx1");
    const promoted1 = r1.filter((f): f is AggregatedTextFrame => f instanceof AggregatedTextFrame);
    expect(promoted1.length).toBe(1);
    expect(promoted1[0]!.text).toBe("Comment ça");
    expect(promoted1[0]!.contextId).toBe("ctx1");

    const r2 = await seq.finalize("ctx2");
    const promoted2 = r2.filter((f): f is AggregatedTextFrame => f instanceof AggregatedTextFrame);
    expect(promoted2[0]!.text).toBe("Bom jour");
    expect(promoted2[0]!.contextId).toBe("ctx2");
  });

  test("test_process_word_routes_by_context_id_when_concurrent", async () => {
    // A word advances only its own context's slot, even when it isn't first.
    const seq = _seq(); // non-streaming: two concurrently-live spoken slots
    await seq.registerSpoken(_spokenFrame("hello"), "ctx1", "hello", true);
    await seq.registerSpoken(_spokenFrame("world"), "ctx2", "world", true);

    // A word tagged ctx2 must land on ctx2's slot, not the earlier ctx1 slot.
    const result = seq.processWord("world", 10, "ctx2");
    const words = ttsFrames(result);
    expect(words.map((f) => f.text)).toEqual(["world"]);
    expect(words[0]!.contextId).toBe("ctx2");
    // ctx1's slot is untouched (still the first, still incomplete).
    expect(internals(seq)._slots[0]!.contextId).toBe("ctx1");
    expect(internals(seq)._slots[0]!.complete).toBe(false);
  });

  test("test_force_complete_scoped_to_context_id_streaming", async () => {
    // forceComplete on a streamed context leaves a concurrent context intact.
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hello");
    await _stream(seq, "ctx2", "World");
    await seq.finalize("ctx1");
    await seq.finalize("ctx2"); // both promoted, both incomplete

    const result = seq.forceComplete("ctx1", 0);
    const texts = new Set(ttsFrames(result).map((f) => f.text));
    expect(texts).toEqual(new Set(["Hello"]));
    // ctx2's slot survives.
    expect(internals(seq)._slots.map((s) => s.frame.text)).toEqual(["World"]);
  });

  test("test_stale_gate_recognizes_non_latest_pending_context", async () => {
    // A word for an earlier-registered pending context is not dropped as stale.
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Comment", " ça"); // pending, not promoted
    await _stream(seq, "ctx2", "Bom", " jour"); // a more recent pending context
    // The word for ctx1 (registered first) must be buffered, not dropped.
    const result = seq.processWord("Comment", 10, "ctx1");
    expect(result).toEqual([]);
    expect(internals(seq)._bufferedWords.length).toBe(1);
    expect(internals(seq)._bufferedWords[0]!.contextId).toBe("ctx1");
  });
});

// ---------------------------------------------------------------------------
// clear — resets streaming-specific state
// ---------------------------------------------------------------------------

describe("TestClearResetsStreamingState", () => {
  test("test_clear_empties_pending_aggregator", async () => {
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hi", " there");
    seq.clear();
    // No streaming contexts remain: finalize now yields nothing.
    expect(await seq.finalize("ctx1")).toEqual([]);
    expect(internals(seq)._streamingContexts).toEqual(new Map());
  });

  test("test_clear_empties_buffered_words", async () => {
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hi", " there");
    seq.processWord("Hi", 10, "ctx1"); // buffered
    expect(internals(seq)._bufferedWords.length).toBe(1);
    seq.clear();
    expect(internals(seq)._bufferedWords).toEqual([]);
  });

  test("test_sequencer_behaves_fresh_after_clear", async () => {
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hi");
    seq.clear();
    await _stream(seq, "ctx1", "Bye", "!", " Ok");
    expect(internals(seq)._slots.length).toBe(1);
    expect(internals(seq)._slots[0]!.frame.text).toBe("Bye!");
  });

  test("test_clear_wipes_all_concurrent_contexts", async () => {
    // An interruption with two contexts in flight wipes every context's state.
    //
    // ctx1 has a promoted slot and remains live for later word timestamps; ctx2
    // still has a pending sentence and a buffered word. clear() must reset all of
    // it at once, and a late word from either context is then dropped as stale.
    const seq = _seq(true);
    await _stream(seq, "ctx1", "Hello");
    await _stream(seq, "ctx2", "World");
    await seq.finalize("ctx1"); // promoted slot; ctx1 stays live for later words
    seq.processWord("World", 1, "ctx2"); // buffered: ctx2 still pending
    expect(internals(seq)._bufferedWords.length).toBe(1);

    seq.clear();

    expect(internals(seq)._slots).toEqual([]);
    expect(internals(seq)._streamingContexts).toEqual(new Map());
    expect(internals(seq)._contextAppendToContext).toEqual(new Map());
    expect(internals(seq)._bufferedWords).toEqual([]);
    // Delayed words from both wiped contexts are stale and dropped.
    expect(seq.processWord("Hello", 2, "ctx1")).toEqual([]);
    expect(seq.processWord("World", 2, "ctx2")).toEqual([]);
    expect(await seq.finalize("ctx2")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// _ParallelSentenceAggregator — the sequencer's internal token→sentence grouper
//
// Emits a sentence only once the NEXT sentence's first token supplies the
// lookahead (no over-grouping), and keeps the three channels token-aligned.
// ---------------------------------------------------------------------------

/**
 * Feed same-text tokens through the aggregator, collecting emitted sentences.
 *
 * Each token is used for all three channels. Returns the list of
 * [tts, llm, user] tuples emitted across the whole run.
 */
async function _aggFeed(
  agg: _ParallelSentenceAggregator,
  ...tokens: string[]
): Promise<[string, string, string][]> {
  const out: [string, string, string][] = [];
  for (const t of tokens) {
    for await (const s of agg.aggregate(t, t, t)) {
      out.push([s.ttsText, s.llmText, s.userFacingText]);
    }
  }
  return out;
}

/** Feed (tts, llm, user) triples through the aggregator, collecting emitted sentences. */
async function _aggFeedTriples(
  agg: _ParallelSentenceAggregator,
  triples: [string, string, string][],
): Promise<[string, string, string][]> {
  const out: [string, string, string][] = [];
  for (const [tts, llm, user] of triples) {
    for await (const s of agg.aggregate(tts, llm, user)) {
      out.push([s.ttsText, s.llmText, s.userFacingText]);
    }
  }
  return out;
}

describe("TestParallelSentenceAggregator", () => {
  test("test_no_boundary_yields_nothing", async () => {
    const agg = new _ParallelSentenceAggregator();
    expect(await _aggFeed(agg, "Hi", " there")).toEqual([]);
  });

  test("test_terminal_token_alone_does_not_emit", async () => {
    // A sentence-ending token needs lookahead (the next sentence's first
    // token) before it is confirmed, so "!" alone emits nothing.
    const agg = new _ParallelSentenceAggregator();
    expect(await _aggFeed(agg, "Hi", " there", "!")).toEqual([]);
  });

  test("test_next_sentence_token_confirms_first_sentence_only", async () => {
    // The lookahead token (" How") confirms "Hi there!" — but must NOT be
    // folded into it (that was the over-grouping bug that broke progress).
    const agg = new _ParallelSentenceAggregator();
    const out = await _aggFeed(agg, "Hi", " there", "!", " How");
    expect(out.map((e) => e[0])).toEqual(["Hi there!"]);
  });

  test("test_multi_sentence_stream_yields_each_cleanly", async () => {
    const agg = new _ParallelSentenceAggregator();
    const emitted = await _aggFeed(agg, "Hi", " there", "!", " How", " are", " you", "?");
    // Only the first sentence is confirmed mid-stream; the second waits.
    expect(emitted.map((e) => e[0])).toEqual(["Hi there!"]);
    // The trailing sentence comes out on flush.
    const f = await agg.flush();
    expect(f).not.toBeNull();
    expect(f!.ttsText).toBe(" How are you?");
  });

  test("test_flush_emits_trailing_partial_sentence", async () => {
    const agg = new _ParallelSentenceAggregator();
    await _aggFeed(agg, "Just", " a", " fragment");
    const f = await agg.flush();
    expect(f).not.toBeNull();
    expect(f!.userFacingText).toBe("Just a fragment");
  });

  test("test_flush_returns_none_when_empty", async () => {
    expect(await new _ParallelSentenceAggregator().flush()).toBeNull();
  });

  test("test_flush_returns_none_for_whitespace_only", async () => {
    const agg = new _ParallelSentenceAggregator();
    await _aggFeed(agg, "   ");
    expect(await agg.flush()).toBeNull();
  });

  test("test_handle_interruption_resets", async () => {
    const agg = new _ParallelSentenceAggregator();
    await _aggFeed(agg, "Hi", " there");
    await agg.handleInterruption();
    expect(await agg.flush()).toBeNull();
    // Behaves fresh afterwards.
    const out = await _aggFeed(agg, "Bye", "!", " Next");
    expect(out.map((e) => e[0])).toEqual(["Bye!"]);
  });

  test("test_channels_stay_token_aligned_under_transform", async () => {
    // ttsText differs from user-facing/llm (a simulated transform), but
    // because emission is token-aligned (whole tokens only), the three
    // channels correspond to the same sentence span.
    const agg = new _ParallelSentenceAggregator();
    // (tts, llm, user) per token: "$5" is spoken as "five dollars".
    const out = await _aggFeedTriples(agg, [
      ["five dollars", "$5", "$5"],
      [".", ".", "."],
      [" Thanks", " Thanks", " Thanks"],
    ]);
    expect(out).toEqual([["five dollars.", "$5.", "$5."]]);
  });

  test("test_coarse_chunk_straddling_boundary_splits_inside_token", async () => {
    // A coarse chunk carries the tail of one sentence and the head of the
    // next ("Hey" then " there! I'm ..."). The boundary must be sliced
    // inside the chunk so "Hey there!" is emitted whole — not split into a
    // bare "Hey" with " there!" wrongly carried into the next sentence.
    const agg = new _ParallelSentenceAggregator();
    const out = await _aggFeed(agg, "Hey", " there! I'm your friendly assistant, here to");
    expect(out.map((e) => e[0])).toEqual(["Hey there!"]);
    // The remainder (post-boundary head of the chunk) stays buffered.
    const f = await agg.flush();
    expect(f).not.toBeNull();
    expect(f!.ttsText).toBe(" I'm your friendly assistant, here to");
  });

  test("test_single_chunk_with_two_boundaries_splits_both", async () => {
    // One chunk containing two full sentence endings plus the lookahead of a
    // third confirms both completed sentences at once, sliced cleanly.
    const agg = new _ParallelSentenceAggregator();
    const out = await _aggFeed(agg, "One. Two. Three");
    expect(out.map((e) => e[0])).toEqual(["One.", " Two."]);
    const f = await agg.flush();
    expect(f).not.toBeNull();
    expect(f!.ttsText).toBe(" Three");
  });

  test("test_straddling_split_keeps_all_three_channels_equal", async () => {
    // On the identical-channel path the sliced sentence is reported the same
    // in every channel, so downstream user/llm/tts stay in agreement.
    const agg = new _ParallelSentenceAggregator();
    const out = await _aggFeedTriples(agg, [
      ["Hi", "Hi", "Hi"],
      [" there! Next", " there! Next", " there! Next"],
    ]);
    expect(out.length).toBe(1);
    expect(out[0]).toEqual(["Hi there!", "Hi there!", "Hi there!"]);
  });

  test("test_divergent_channel_straddle_falls_back_to_token_boundary", async () => {
    // When a transform has diverged the channels, a straddling chunk cannot be
    // split at a shared offset, so emission falls back to the token boundary:
    // the text accumulated before the chunk is emitted whole.
    const agg = new _ParallelSentenceAggregator();
    const out = await _aggFeedTriples(agg, [
      ["five dollars", "$5", "$5"],
      [" spent! More", " spent! More", " spent! More"],
    ]);
    expect(out).toEqual([["five dollars", "$5", "$5"]]);
  });

  test("test_divergent_cut_does_not_poison_later_sentences", async () => {
    // After a divergent-channel token-boundary cut whose triggering token
    // straddled a boundary, the inner aggregator has consumed past that boundary
    // while the whole token stays buffered here. Alignment must NOT be falsely
    // restored: a later identical-channel chunk must still be grouped correctly
    // instead of being sliced against a stale buffer (which used to emit a
    // spurious partial-sentence anchor and drop a real sentence).
    const agg = new _ParallelSentenceAggregator();
    // "$5" is spoken as "five dollars" (length-changing transform diverges the
    // channels); " spent! More" then straddles a sentence boundary.
    const out = await _aggFeedTriples(agg, [
      ["five dollars", "$5", "$5"],
      [" spent! More", " spent! More", " spent! More"],
      [" stuff.", " stuff.", " stuff."],
      [" X", " X", " X"],
    ]);
    // Token-boundary cuts only — no spurious " spent!" anchor, and " More stuff."
    // is not lost (it rides out with the second emitted unit).
    expect(out.map((e) => e[0])).toEqual(["five dollars", " spent! More stuff."]);
  });

  test("test_alignment_recovers_after_divergent_cut", async () => {
    // Once a divergent run resolves back to identical channels at a token edge,
    // the fast path must re-engage so a later straddling chunk is again sliced
    // inside the token rather than cut coarsely at the token boundary.
    const agg = new _ParallelSentenceAggregator();
    const out = await _aggFeedTriples(agg, [
      ["five dollars", "$5", "$5"], // diverge the channels
      [" spent!", " spent!", " spent!"], // completes the diverged sentence
      [" Buy", " Buy", " Buy"], // confirms the cut; buffer realigns to " Buy"
      [" more! Now", " more! Now", " more! Now"], // fast path slices inside token
    ]);
    expect(out.map((e) => e[0])).toEqual(["five dollars spent!", " Buy more!"]);
  });
});

// ---------------------------------------------------------------------------
// processWord — a garbled word-timestamp event, then a resync
// ---------------------------------------------------------------------------

/**
 * A word no slot recognises is dropped, and the next good one resyncs.
 *
 * Emitting such a word verbatim would put text the LLM never wrote into the
 * conversation context and leave the slot stranded at the cursor, so every word
 * after it is unrecognised too. Dropping it costs nothing: the text it should
 * have covered still reaches the context, carried either by the word that
 * resyncs or -- if none does -- by forceComplete.
 */
describe("TestProcessWordResync", () => {
  const SENTENCE = "This is how it is supposed to work";

  async function _seqThreeWordsIn(): Promise<AggregatedFrameSequencer> {
    const seq = _seq();
    await seq.registerSpoken(_spokenFrame(SENTENCE, SENTENCE), "ctx1", SENTENCE, true);
    for (const word of ["This", "is", "how"]) {
      seq.processWord(word, 10, "ctx1");
    }
    return seq;
  }

  test("test_garbled_word_emits_nothing", async () => {
    const seq = await _seqThreeWordsIn();
    expect(seq.processWord("ity", 20, "ctx1")).toEqual([]);
  });

  test("test_next_word_resyncs_and_carries_the_skipped_text", async () => {
    const seq = await _seqThreeWordsIn();
    seq.processWord("ity", 20, "ctx1");
    const words = ttsFrames(seq.processWord("ís", 30, "ctx1"));
    expect(words.map((f) => f.text)).toEqual(["it is"]);
    expect(words[0]!.rawText).toBe("it is");
  });

  test("test_progress_follows_the_resync", async () => {
    const seq = await _seqThreeWordsIn();
    seq.processWord("ity", 20, "ctx1");
    const frames = seq.processWord("ís", 30, "ctx1");
    const progress = progressFrames(frames);
    expect(progress.length).toBe(1);
    expect(progress[0]!.accumulatedText).toBe("This is how it is");
    expect(progress[0]!.remainingText).toBe(" supposed to work");
  });

  test("test_slot_completes_and_leaves_force_complete_nothing_to_do", async () => {
    const seq = await _seqThreeWordsIn();
    seq.processWord("ity", 20, "ctx1");
    for (const word of ["ís", "supposed", "to", "work"]) {
      seq.processWord(word, 30, "ctx1");
    }
    expect(seq.forceComplete("ctx1", 40)).toEqual([]);
  });

  test("test_context_reassembles_the_whole_sentence", async () => {
    const seq = await _seqThreeWordsIn();
    const frames: Frame[] = [];
    for (const word of ["ity", "ís", "supposed", "to", "work"]) {
      frames.push(...seq.processWord(word, 30, "ctx1"));
    }
    const spoken = ["This", "is", "how", ...ttsFrames(frames).map((f) => f.rawText)];
    expect(spoken.join(" ")).toBe(SENTENCE);
  });

  test("test_word_no_resync_can_place_is_dropped", async () => {
    const seq = await _seqThreeWordsIn();
    expect(seq.processWord("banana", 20, "ctx1")).toEqual([]);
  });

  test("test_force_complete_recovers_what_no_word_resynced", async () => {
    const seq = await _seqThreeWordsIn();
    seq.processWord("banana", 20, "ctx1");
    const words = ttsFrames(seq.forceComplete("ctx1", 30));
    expect(words.map((f) => f.text)).toEqual(["it is supposed to work"]);
  });

  test("test_a_word_both_slots_could_take_still_reconstructs_both", async () => {
    // "Is" opens the second sentence, but "is" is also still unspoken in the
    // first, so the first slot takes it along with the words before it. The word
    // after it matches nothing there, which force-completes the first slot and
    // hands that word to the second, where looking ahead recovers "Is" too. The
    // word boundaries shift; the text of both sentences does not.
    const seq = _seq();
    for (const text of [SENTENCE, "Is that clear?"]) {
      await seq.registerSpoken(_spokenFrame(text, text), "ctx1", text, true);
    }
    for (const word of ["This", "is", "how"]) {
      seq.processWord(word, 10, "ctx1");
    }

    const frames: Frame[] = [];
    for (const word of ["Is", "that", "clear?"]) {
      frames.push(...seq.processWord(word, 20, "ctx1"));
    }
    frames.push(...seq.forceComplete("ctx1", 30));

    const spoken = ["This", "is", "how", ...ttsFrames(frames).map((f) => f.rawText)];
    expect(spoken.join(" ")).toBe(`${SENTENCE} Is that clear?`);
  });
});

/**
 * Resync in a slot whose TTS text carries synthesis tags and whose LLM text
 * carries delimiters of its own.
 */
describe("TestProcessWordResyncWithMarkup", () => {
  const TTS = "Call <spell>4111</spell> when it is ready";
  const LLM = "Call <card>4111</card> when it is ready";
  const USER_FACING = "Call 4111 when it is ready";

  async function _seqPastTheTag(): Promise<AggregatedFrameSequencer> {
    const seq = _seq();
    const frame = _spokenFrame(USER_FACING, LLM);
    await seq.registerSpoken(frame, "ctx1", TTS, true);
    for (const word of ["Call", "4111"]) {
      seq.processWord(word, 10, "ctx1");
    }
    return seq;
  }

  test("test_garbled_word_after_the_tag_emits_nothing", async () => {
    const seq = await _seqPastTheTag();
    expect(seq.processWord("whenx", 20, "ctx1")).toEqual([]);
  });

  test("test_resync_carries_the_closing_delimiter_into_context", async () => {
    const seq = await _seqPastTheTag();
    seq.processWord("whenx", 20, "ctx1");
    const words = ttsFrames(seq.processWord("ís", 30, "ctx1"));
    expect(words.map((f) => f.text)).toEqual(["when it is"]);
    expect(words[0]!.rawText).toBe("</card> when it is");
  });

  test("test_slot_completes_after_the_resync", async () => {
    const seq = await _seqPastTheTag();
    seq.processWord("whenx", 20, "ctx1");
    seq.processWord("ís", 30, "ctx1");
    seq.processWord("ready", 40, "ctx1");
    expect(internals(seq)._slots).toEqual([]);
  });
});

/**
 * What a context ending has to account for: text no word arrived for, which the
 * progress view has to reach, and a buffered word no slot ever matched, which is
 * dropped where sentence mode would have dropped it on arrival.
 */
describe("TestForceCompleteWordStream", () => {
  async function _streamedSlot(...tokens: string[]): Promise<AggregatedFrameSequencer> {
    const seq = _seq(true);
    for (const t of tokens) {
      await seq.registerSpoken(_spokenFrame(t, t), "ctx1", t, true);
    }
    return seq;
  }

  test("test_buffered_word_is_dropped_at_context_end", async () => {
    // "。" is taken by "好" as trailing punctuation, so the slot is already
    // complete when the provider reports the mark on its own, so it is buffered.
    const seq = await _streamedSlot("您好", "。", "谢谢");
    ["您", "好", "。"].forEach((ch, i) => {
      seq.processWord(ch, (i + 1) * 10, "ctx1");
    });
    expect(internals(seq)._bufferedWords.map((w) => w.word)).toEqual(["。"]);

    const words = ttsFrames(seq.forceComplete("ctx1", 30));
    expect(words).toEqual([]);
    expect(internals(seq)._bufferedWords).toEqual([]);
  });

  test("test_buffered_word_for_another_context_is_left_alone", async () => {
    const seq = await _streamedSlot("您好", "。", "谢谢");
    ["您", "好", "。"].forEach((ch, i) => {
      seq.processWord(ch, (i + 1) * 10, "ctx1");
    });
    internals(seq)._bufferedWords[0]!.contextId = "ctx2";
    seq.forceComplete("ctx1", 30);
    expect(internals(seq)._bufferedWords.map((w) => w.word)).toEqual(["。"]);
  });

  test("test_forced_tail_reports_progress_to_the_end", async () => {
    const seq = _seq();
    const text = "Hello there friend";
    await seq.registerSpoken(_spokenFrame(text, text), "ctx1", text, true);
    seq.processWord("Hello", 10, "ctx1");

    const frames = seq.forceComplete("ctx1", 20);
    const words = ttsFrames(frames);
    const progress = progressFrames(frames);
    expect(words.map((f) => f.text)).toEqual(["there friend"]);
    expect(progress[progress.length - 1]!.accumulatedText).toBe(text);
    expect(progress[progress.length - 1]!.remainingText).toBe("");
  });
});

/** Python's `" ".join(s.split())`: collapse every whitespace run to one space. */
function normalizeSpaces(s: string): string {
  return s
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .join(" ");
}

/** Run every word through the sequencer, collecting dropped words and context spans. */
async function runTurn(
  sentences: string[],
  wordGroups: string[][],
): Promise<{ dropped: string[]; contextSpans: string[] }> {
  const seq = _seq();
  for (const text of sentences) {
    await seq.registerSpoken(_spokenFrame(text, text), "ctx1", text, true);
  }

  const contextSpans: string[] = [];
  const dropped: string[] = [];
  let pts = 0;
  for (const words of wordGroups) {
    for (const word of words) {
      pts += 10;
      const frames = ttsFrames(seq.processWord(word, pts, "ctx1"));
      if (frames.length === 0) {
        dropped.push(word);
      }
      for (const f of frames) {
        if (f.appendToContext && f.rawText) {
          contextSpans.push(f.rawText);
        }
      }
    }
  }
  return { dropped, contextSpans };
}

/**
 * A markdown-heavy LLM response spoken by Cartesia, several sentences queued.
 *
 * Cartesia keeps the markdown on each token and appends a period to the last
 * token of every line. One misplaced token force-completes its slot, and every
 * later word of the turn is then dropped as unrecognised. So every word must
 * produce a TTSTextFrame, and the context must receive every sentence in full.
 */
describe("TestMarkdownResponseStaysInSync", () => {
  const SENTENCES = [
    "Each menu lists food items under categories such as **ENTREE**, **SIDES**, " +
      "and **SELECTIONS**.",
    "Below is a detailed description of the content across the images:\n\n---\n\n" +
      "### **General Overview**\n" +
      "- **Purpose**: These menus are designed for students, offering meals each day.",
    "- **Structure**: Each day has a designated **ENTREE** (main course).",
  ];

  // biome-ignore format: keep the upstream layout
  const WORDS = [
    ["Each", "menu", "lists", "food", "items", "under", "categories", "such", "as",
     "**ENTREE**,", "**SIDES**,", "and", "**SELECTIONS**."],
    ["Below", "is", "a", "detailed", "description", "of", "the", "content", "across",
     "the", "images:.", "---.", "###", "**General", "Overview**.", "-", "**Purpose**:",
     "These", "menus", "are", "designed", "for", "students,", "offering", "meals",
     "each", "day."],
    ["-", "**Structure**:", "Each", "day", "has", "a", "designated", "**ENTREE**",
     "(main", "course)."],
  ];

  test("test_every_word_is_emitted_and_every_sentence_reaches_the_context", async () => {
    const { dropped, contextSpans } = await runTurn(SENTENCES, WORDS);
    expect(dropped).toEqual([]);
    expect(normalizeSpaces(contextSpans.join(" "))).toBe(normalizeSpaces(SENTENCES.join(" ")));
  });
});

/**
 * A swapped symbol followed by more symbol tokens, across two queued sentences.
 *
 * ElevenLabs reports `→` as `-`. If the cursor steps past the symbol tokens
 * after it, the next one is rejected, the slot is force-completed, and the
 * following words are dropped as unrecognised.
 */
describe("TestUnmatchedSymbolDoesNotDesyncTheTurn", () => {
  const SENTENCES = ["Step one →\n\n### **Step two**\nDone.", "Then we finish."];

  const WORDS = [
    ["Step", "one", "-", "###", "**Step", "two**", "Done."],
    ["Then", "we", "finish."],
  ];

  test("test_every_word_is_emitted_and_every_sentence_reaches_the_context", async () => {
    const { dropped, contextSpans } = await runTurn(SENTENCES, WORDS);
    expect(dropped).toEqual([]);
    expect(normalizeSpaces(contextSpans.join(" "))).toBe(normalizeSpaces(SENTENCES.join(" ")));
  });
});
