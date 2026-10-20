// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_tts_frame_ordering.py

/**
 * Tests for frame ordering across TTS service types.
 *
 * Covers three patterns:
 * - HTTP TTS services (e.g. CartesiaHttpTTSService): yield audio frames synchronously.
 * - WebSocket TTS services without pause (e.g. CartesiaTTSService): deliver audio via
 *   appendToAudioContext from a background receive loop, no frame-processing pause.
 * - WebSocket TTS services with pause (e.g. ElevenLabsTTSService): same delivery
 *   mechanism, but pause downstream frame processing while audio is in flight.
 *
 * For all three patterns we verify:
 *     AggregatedTextFrame → TTSStartedFrame → TTSAudioRawFrame (1+) → TTSStoppedFrame → FooFrame
 *
 * repeated for each TTSSpeakFrame, with no cross-group contamination.
 *
 * Also covers LLM response flow with pushTextFrames=true (non-word-timestamp TTS):
 * verifies TTSTextFrame ordering relative to LLMFullResponseEndFrame.
 *
 * Also covers smart-text / WordCompletionTracker features:
 * - Skipped frames (skipTextTypes) held until preceding spoken slots complete.
 * - rawText on AggregatedTextFrame propagated as spans to TTSTextFrames.
 * - Overflow: a single TTS word straddling two AggregatedTextFrame boundaries produces
 *   two correctly-attributed TTSTextFrames.
 * - Force-complete safety net: skipped frames flush even when TTS drops word timestamps.
 *
 * Also covers the interruption-during-pause deadlock scenario (see test_no_deadlock_on_interrupt_*).
 */

import { expect, setDefaultTimeout, test } from "bun:test";
import { Event, sleep, waitFor } from "@pipedog/asyncio";

import {
  AggregatedTextFrame,
  AggregatedTextProgressFrame,
  BotBackchannelFrame,
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  ControlFrame,
  DataFrame,
  ErrorFrame,
  type Frame,
  InterruptionFrame,
  LLMAssistantPushAggregationFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  TextFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
  VADUserStartedSpeakingFrame,
} from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import { LLMAssistantAggregator } from "../src/processors/aggregators/llm_response_universal.ts";
import type { FrameDirection } from "../src/processors/frame_processor.ts";
import {
  TextAggregationMode,
  TTSService,
  type TTSServiceOptions,
} from "../src/services/tts_service.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import { concatenateAggregatedText, TextPartForConcatenation } from "../src/utils/string.ts";
import { TextType } from "../src/utils/text/base_text_aggregator.ts";
import { BaseTextFilter } from "../src/utils/text/base_text_filter.ts";
import { SkipTagsAggregator } from "../src/utils/text/skip_tags_aggregator.ts";

setDefaultTimeout(15_000);

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

type FrameClass = abstract new (...args: any[]) => Frame;

function isAny(f: Frame, classes: readonly FrameClass[]): boolean {
  return classes.some((c) => f instanceof c);
}

function typeNames(frames: readonly Frame[]): string[] {
  return frames.map((f) => f.constructor.name);
}

// ---------------------------------------------------------------------------
// Test-only frame
// ---------------------------------------------------------------------------

const _FAKE_AUDIO = (() => {
  // b"\x00\x01" * 320
  const a = new Uint8Array(640);
  for (let i = 1; i < a.length; i += 2) a[i] = 1;
  return a;
})();
const _SAMPLE_RATE = 16000;

function fakeAudio(contextId: string | null): TTSAudioRawFrame {
  return new TTSAudioRawFrame({
    audio: _FAKE_AUDIO,
    sampleRate: _SAMPLE_RATE,
    numChannels: 1,
    contextId,
  });
}

/** Marker frame used to verify relative ordering against TTS audio frames. */
class FooFrame extends DataFrame {
  label: string;

  constructor(options: { label?: string } = {}) {
    super(options);
    this.label = options.label ?? "";
  }
}

/**
 * Test-only uninterruptible marker frame used to trigger the deadlock code path.
 *
 * When this is in the process queue with #shouldBlockFrames=true, and an
 * InterruptionFrame arrives, _startInterruption() takes the non-cancel path
 * (because of the uninterruptible frame) leaving #shouldBlockFrames=true.
 */
class UninterruptibleMarkerFrame extends ControlFrame {
  override interruptible = false;
  label: string;

  constructor(options: { label?: string } = {}) {
    super(options);
    this.label = options.label ?? "";
  }
}

// ---------------------------------------------------------------------------
// Mock TTS services
// ---------------------------------------------------------------------------

/**
 * Simulates an HTTP TTS service (e.g. CartesiaHttpTTSService).
 *
 * Audio frames are yielded synchronously from runTts(), so the audio context
 * is fully populated before the next downstream frame is processed.
 * TTSStoppedFrame is appended by the base class in onTurnContextCompleted()
 * once it detects _isYieldingFramesSynchronously is true.
 */
class MockHttpTTSService extends TTSService {
  constructor(options: TTSServiceOptions = {}) {
    super({
      pushStartFrame: true,
      pushStopFrames: true,
      pushTextFrames: false,
      sampleRate: _SAMPLE_RATE,
      ...options,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    yield fakeAudio(contextId);
  }
}

/**
 * Simulates a service that emits its own TTSStartedFrame (pushStartFrame=false).
 *
 * Mirrors the websocket TTS services (and NvidiaTTSService) that create the audio
 * context and yield TTSStartedFrame from runTts rather than letting the base class
 * do it. Used to verify appendToContext is stamped centrally for this path too.
 */
class MockSelfStartHttpTTSService extends TTSService {
  constructor(options: TTSServiceOptions = {}) {
    super({
      pushStartFrame: false,
      pushStopFrames: true,
      pushTextFrames: false,
      sampleRate: _SAMPLE_RATE,
      ...options,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    if (!this.audioContextAvailable(contextId)) {
      await this.createAudioContext(contextId);
      yield new TTSStartedFrame({ contextId });
    }
    yield fakeAudio(contextId);
  }
}

/**
 * Simulates an HTTP TTS service with pushTextFrames=true.
 *
 * Used to test that LLMFullResponseEndFrame is emitted after all TTSTextFrames
 * when the TTS service generates text frames itself (non-word-timestamp mode).
 */
class MockHttpPushTextTTSService extends TTSService {
  constructor(options: TTSServiceOptions = {}) {
    super({
      pushStartFrame: true,
      pushStopFrames: true,
      pushTextFrames: true,
      sampleRate: _SAMPLE_RATE,
      ...options,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    yield fakeAudio(contextId);
  }
}

/** Shared async delivery: audio, then TTSStoppedFrame, then the context is removed. */
async function deliverAudioAndStop(tts: TTSService, contextId: string): Promise<void> {
  await sleep(0.01);
  await tts.appendToAudioContext(contextId, fakeAudio(contextId));
  await tts.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
  await tts.removeAudioContext(contextId);
}

/**
 * Simulates a WebSocket TTS service without frame-processing pause (e.g. CartesiaTTSService).
 *
 * runTts() is an empty async generator (signals async delivery). A background
 * task appends audio frames and the TTSStoppedFrame to the audio context after a
 * short delay, mimicking real WebSocket receive-loop behaviour.
 * pauseFrameProcessing=false means downstream frames (FooFrame) are NOT held.
 */
class MockWebSocketTTSService extends TTSService {
  constructor(options: TTSServiceOptions = {}) {
    super({
      pushStartFrame: true,
      pushTextFrames: false,
      pauseFrameProcessing: false,
      sampleRate: _SAMPLE_RATE,
      ...options,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    this.createTask(() => deliverAudioAndStop(this, contextId), `mock_ws_deliver_${contextId}`);
  }
}

/**
 * Simulates a WebSocket TTS service WITH frame-processing pause (e.g. ElevenLabsTTSService).
 *
 * Identical to MockWebSocketTTSService except pauseFrameProcessing=true, so
 * frames wait until the audio context ends, guaranteeing FooFrame arrives after
 * TTSStoppedFrame.
 */
class MockWebSocketPauseTTSService extends TTSService {
  constructor(options: TTSServiceOptions = {}) {
    super({
      pushStartFrame: true,
      pushTextFrames: false,
      pauseFrameProcessing: true,
      sampleRate: _SAMPLE_RATE,
      ...options,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    this.createTask(
      () => deliverAudioAndStop(this, contextId),
      `mock_ws_pause_deliver_${contextId}`,
    );
  }
}

/**
 * Simulates a WebSocket TTS service with pause but no audio delivery.
 *
 * Used to test the interruption-during-pause deadlock. Audio is never
 * delivered within the test window, so BotStoppedSpeakingFrame is never
 * sent by the transport, and onAudioContextCompleted is never called.
 * Without the fix, an interruption arriving while the process task is
 * blocked behind an uninterruptible frame causes a permanent deadlock.
 */
class MockWebSocketPauseTTSServiceNoAudio extends TTSService {
  constructor(options: TTSServiceOptions = {}) {
    super({
      pushStartFrame: true,
      pushTextFrames: false,
      pauseFrameProcessing: true,
      sampleRate: _SAMPLE_RATE,
      ...options,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, _contextId: string): AsyncGenerator<Frame | null, void> {
    // Intentionally never deliver audio — simulates extreme TTS latency.
  }
}

/**
 * Simulates a WebSocket TTS service (pauseFrameProcessing=true) whose
 * provider accepts the request and reports the context as successfully
 * completed (isFinal) but never sends any audio bytes — e.g. a quota-
 * exhausted provider that still accepts the connection.
 *
 * Because no TTSAudioRawFrame is ever produced, the output transport's
 * BotStartedSpeakingFrame/BotStoppedSpeakingFrame never fire in production
 * either. The context completing lifts the pause.
 */
class MockWebSocketPauseTTSServiceZeroAudioCompletion extends TTSService {
  constructor(options: TTSServiceOptions = {}) {
    super({
      pushStartFrame: true,
      pushTextFrames: false,
      pauseFrameProcessing: true,
      sampleRate: _SAMPLE_RATE,
      ...options,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const deliverZeroAudioCompletion = async () => {
      await sleep(0.01);
      // Provider reports the context finished (isFinal) with no audio.
      await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
      await this.removeAudioContext(contextId);
    };

    this.createTask(() => deliverZeroAudioCompletion(), `mock_ws_pause_zero_audio_${contextId}`);
  }
}

/**
 * Simulates a streaming WebSocket TTS service (pauseFrameProcessing=true)
 * whose audio context completes quickly (as ElevenLabs-style providers
 * typically report isFinal shortly after the last text is sent), but whose
 * actual playback — tracked independently by the output transport — keeps
 * going well after the turn's LLMFullResponseEndFrame.
 *
 * The test injects BotStartedSpeakingFrame and BotStoppedSpeakingFrame
 * directly to model the output transport's behavior without a real transport
 * in the pipeline.
 */
class MockWebSocketPauseTTSServiceLongPlayback extends TTSService {
  constructor(options: TTSServiceOptions = {}) {
    super({
      pushStartFrame: true,
      pushTextFrames: false,
      pauseFrameProcessing: true,
      sampleRate: _SAMPLE_RATE,
      ...options,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    this.createTask(
      () => deliverAudioAndStop(this, contextId),
      `mock_ws_pause_long_playback_${contextId}`,
    );
  }
}

type WordTimes = [string, number][];

interface MockWordTimestampTTSServiceOptions extends TTSServiceOptions {
  includesInterFrameSpaces?: boolean;
  preMergeTokens?: boolean;
  wordTimes?: WordTimes | null;
}

function splitWordTimes(text: string): WordTimes {
  return text
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w, i) => [w, i * 0.1]);
}

/**
 * HTTP-style TTS: yields audio synchronously, calls addWordTimestamps first.
 *
 * `wordTimes` pins the exact tokens and their timestamps. When omitted the
 * service splits the input text on spaces, assigning 0.1 s gaps.
 */
class _MockWordTimestampHttpTTSService extends TTSService {
  protected _includesInterFrameSpaces: boolean;
  protected _preMergeTokens: boolean;
  protected _wordTimes: WordTimes | null;

  constructor(options: MockWordTimestampTTSServiceOptions = {}) {
    const { includesInterFrameSpaces, preMergeTokens, wordTimes, ...rest } = options;
    super({
      pushStartFrame: true,
      pushStopFrames: true,
      pushTextFrames: false,
      sampleRate: _SAMPLE_RATE,
      ...rest,
    });
    this._includesInterFrameSpaces = includesInterFrameSpaces ?? false;
    this._preMergeTokens = preMergeTokens ?? false;
    this._wordTimes = wordTimes ?? null;
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const wordTimes = this._wordTimes?.length ? this._wordTimes : splitWordTimes(text);
    await this.addWordTimestamps(wordTimes, contextId, {
      includesInterFrameSpaces: this._includesInterFrameSpaces,
      preMergeTokens: this._preMergeTokens,
    });
    yield fakeAudio(contextId);
  }
}

/**
 * WebSocket-style TTS: delivers audio asynchronously via the audio context.
 *
 * Word timestamps are enqueued as `WordTimestamp` items (audio context
 * already exists at call time) and processed by `_handleAudioContext` in
 * playback order.
 *
 * `wordTimes` pins the exact tokens and their timestamps. When omitted the
 * service splits the input text on spaces, assigning 0.1 s gaps.
 */
class _MockWordTimestampWSTTSService extends TTSService {
  protected _includesInterFrameSpaces: boolean;
  protected _preMergeTokens: boolean;
  protected _wordTimes: WordTimes | null;

  constructor(options: MockWordTimestampTTSServiceOptions = {}) {
    const { includesInterFrameSpaces, preMergeTokens, wordTimes, ...rest } = options;
    super({
      pushStartFrame: true,
      pushTextFrames: false,
      pauseFrameProcessing: false,
      sampleRate: _SAMPLE_RATE,
      ...rest,
    });
    this._includesInterFrameSpaces = includesInterFrameSpaces ?? false;
    this._preMergeTokens = preMergeTokens ?? false;
    this._wordTimes = wordTimes ?? null;
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const deliver = async () => {
      await sleep(0.01);
      const wordTimes = this._wordTimes?.length ? this._wordTimes : splitWordTimes(text);
      await this.addWordTimestamps(wordTimes, contextId, {
        includesInterFrameSpaces: this._includesInterFrameSpaces,
        preMergeTokens: this._preMergeTokens,
      });
      await this.appendToAudioContext(contextId, fakeAudio(contextId));
      await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
      await this.removeAudioContext(contextId);
    };

    this.createTask(() => deliver(), `mock_ws_word_deliver_${contextId}`);
  }
}

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

/**
 * Assert two (or more) TTS+FooFrame groups are in strict order.
 *
 * @param downFrames All downstream frames received by the test sink.
 * @param expectedGroups List of [ttsText, fooLabel] pairs, one per TTSSpeakFrame.
 *   ttsText is unused in assertions today but included for readability.
 */
function _assertGroupOrdering(
  downFrames: readonly Frame[],
  expectedGroups: readonly (readonly [string, string])[],
): void {
  const relevant = downFrames.filter((f) =>
    isAny(f, [AggregatedTextFrame, TTSStartedFrame, TTSAudioRawFrame, TTSStoppedFrame, FooFrame]),
  );

  // Locate the FooFrames that delimit groups.
  const fooIndices = relevant.flatMap((f, i) => (f instanceof FooFrame ? [i] : []));
  assert(
    fooIndices.length === expectedGroups.length,
    `Expected ${expectedGroups.length} FooFrames, got ${fooIndices.length}.\n` +
      `Relevant frames: ${typeNames(relevant)}`,
  );

  // Build groups: everything up to and including each FooFrame.
  const groups: Frame[][] = [];
  let prev = 0;
  for (const idx of fooIndices) {
    groups.push(relevant.slice(prev, idx + 1));
    prev = idx + 1;
  }

  groups.forEach((group, gi) => {
    const fooLabel = expectedGroups[gi]![1];
    const types = group.map((f) => f.constructor);
    const names = typeNames(group);

    assert(
      types.includes(AggregatedTextFrame),
      `Group '${fooLabel}': missing AggregatedTextFrame. Got: ${names}`,
    );
    assert(
      types.includes(TTSStartedFrame),
      `Group '${fooLabel}': missing TTSStartedFrame. Got: ${names}`,
    );
    assert(
      types.includes(TTSAudioRawFrame),
      `Group '${fooLabel}': missing TTSAudioRawFrame. Got: ${names}`,
    );
    assert(
      types.includes(TTSStoppedFrame),
      `Group '${fooLabel}': missing TTSStoppedFrame. Got: ${names}`,
    );

    const startedIdx = types.indexOf(TTSStartedFrame);
    const stoppedIdx = types.indexOf(TTSStoppedFrame);
    const fooIdx = types.indexOf(FooFrame);

    assert(
      startedIdx < stoppedIdx,
      `Group '${fooLabel}': TTSStartedFrame (pos ${startedIdx}) must precede ` +
        `TTSStoppedFrame (pos ${stoppedIdx}). Got: ${names}`,
    );
    assert(
      stoppedIdx < fooIdx,
      `Group '${fooLabel}': TTSStoppedFrame (pos ${stoppedIdx}) must precede ` +
        `FooFrame (pos ${fooIdx}). Got: ${names}`,
    );

    // All frames between TTSStartedFrame and TTSStoppedFrame must be audio.
    const midTypes = types.slice(startedIdx + 1, stoppedIdx);
    for (const t of midTypes) {
      assert(
        t === TTSAudioRawFrame || t === TTSTextFrame,
        `Group '${fooLabel}': unexpected frame '${t.name}' between ` +
          `TTSStartedFrame and TTSStoppedFrame. Got: ${names}`,
      );
    }

    // Check the FooFrame label.
    const actualLabel = (group[fooIdx] as FooFrame).label;
    assert(
      actualLabel === fooLabel,
      `Expected FooFrame(label='${fooLabel}'), got label='${actualLabel}'`,
    );
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const _GROUPS = [
  ["test 1", "1"],
  ["test 2", "2"],
] as const;

/**
 * Return two TTSSpeakFrame+FooFrame pairs sent back-to-back.
 *
 * Only correct for services that pause downstream processing until the audio
 * context is fully consumed (pauseFrameProcessing=true + onAudioContextCompleted).
 */
function _makeFramesNoSleep(): Frame[] {
  return [
    new TTSSpeakFrame({ text: "test 1", appendToContext: false }),
    new FooFrame({ label: "1" }),
    new TTSSpeakFrame({ text: "test 2", appendToContext: false }),
    new FooFrame({ label: "2" }),
  ];
}

function _printFramesReceived(framesReceived: [Frame[], Frame[]]): void {
  console.log("FRAMES RECEIVED:");
  for (const frame of framesReceived[0]) {
    console.log(frame.name);
  }
}

test("test_http_tts_frame_ordering", async () => {
  // HTTP TTS services yield audio synchronously.
  const tts = new MockHttpTTSService();
  const framesReceived = await runTest(tts, { framesToSend: _makeFramesNoSleep() });

  // only for debugging
  _printFramesReceived(framesReceived);

  _assertGroupOrdering(framesReceived[0], _GROUPS);
});

test("test_websocket_tts_no_pause_frame_ordering", async () => {
  // WebSocket TTS services without pauseFrameProcessing.
  const tts = new MockWebSocketTTSService();
  const framesReceived = await runTest(tts, { framesToSend: _makeFramesNoSleep() });
  _assertGroupOrdering(framesReceived[0], _GROUPS);
});

test("test_websocket_tts_with_pause_frame_ordering", async () => {
  // WebSocket TTS services with pauseFrameProcessing=true.
  const tts = new MockWebSocketPauseTTSService();
  const framesReceived = await runTest(tts, { framesToSend: _makeFramesNoSleep() });
  _assertGroupOrdering(framesReceived[0], _GROUPS);
});

test("test_http_push_text_llm_response_end_after_tts_text", async () => {
  // LLMFullResponseEndFrame must arrive after all TTSTextFrames.
  //
  // Simulates an LLM response producing multiple sentences through an HTTP TTS
  // service with pushTextFrames=true. Each sentence is sent as a separate
  // TextFrame terminated by a period so the sentence aggregator flushes it.
  // The final sentence is flushed by the LLMFullResponseEndFrame itself.
  const tts = new MockHttpPushTextTTSService();

  // Two sentences: the first ends with a period (triggers aggregator flush),
  // the second does NOT (will be flushed by LLMFullResponseEndFrame).
  const framesToSend = [
    new LLMFullResponseStartFrame(),
    new TextFrame({ text: "Hello there. " }),
    new TextFrame({ text: "How are you?" }),
    new LLMFullResponseEndFrame(),
  ];
  const framesReceived = await runTest(tts, { framesToSend });
  const down = framesReceived[0];

  // Collect relevant frame types for ordering check.
  const relevant = down.filter((f) =>
    isAny(f, [LLMFullResponseStartFrame, TTSTextFrame, LLMFullResponseEndFrame]),
  );
  const names = typeNames(relevant);

  // There should be exactly one LLMFullResponseStartFrame, 2 TTSTextFrames, 1 LLMFullResponseEndFrame.
  const ttsTextFrames = relevant.filter((f) => f instanceof TTSTextFrame);
  const endFrames = relevant.filter((f) => f instanceof LLMFullResponseEndFrame);
  const startFrames = relevant.filter((f) => f instanceof LLMFullResponseStartFrame);

  assert(
    startFrames.length === 1,
    `Expected 1 LLMFullResponseStartFrame, got ${startFrames.length}: ${names}`,
  );
  assert(
    ttsTextFrames.length === 2,
    `Expected 2 TTSTextFrames, got ${ttsTextFrames.length}: ${names}`,
  );
  assert(
    endFrames.length === 1,
    `Expected 1 LLMFullResponseEndFrame, got ${endFrames.length}: ${names}`,
  );

  // The critical check: LLMFullResponseEndFrame must come after ALL TTSTextFrames.
  const endIdx = relevant.indexOf(endFrames[0]!);
  const lastTtsTextIdx = Math.max(...ttsTextFrames.map((f) => relevant.indexOf(f)));

  assert(
    lastTtsTextIdx < endIdx,
    `LLMFullResponseEndFrame (pos ${endIdx}) must come after the last ` +
      `TTSTextFrame (pos ${lastTtsTextIdx}). Got: ${names}`,
  );
});

test("test_second_turn_start_does_not_race_ahead_of_first_turn_completion", async () => {
  // LLMFullResponseStartFrame for a new turn must not race ahead of the
  // previous turn's still-draining audio context.
  //
  // Regression test for a pauseFrameProcessing=false service (e.g. Cartesia):
  // since that service's frame-processing loop is never paused while audio is
  // in flight, a second turn's LLMFullResponseStartFrame can be dequeued and
  // processed while the first turn's audio context (delivered asynchronously,
  // here after a short delay) is still draining. The Start frame must still be
  // emitted only after the first turn's TTSStoppedFrame/LLMFullResponseEndFrame —
  // exactly the ordering downstream consumers like LLMAssistantAggregator rely
  // on turns never violating.
  const tts = new MockWebSocketTTSService();

  const framesToSend = [
    new LLMFullResponseStartFrame(),
    new TextFrame({ text: "Hello there." }),
    new LLMFullResponseEndFrame(),
    new LLMFullResponseStartFrame(),
    new TextFrame({ text: "World." }),
    new LLMFullResponseEndFrame(),
  ];
  const framesReceived = await runTest(tts, { framesToSend });
  const down = framesReceived[0];

  const relevant = down.filter((f) =>
    isAny(f, [LLMFullResponseStartFrame, TTSStoppedFrame, LLMFullResponseEndFrame]),
  );

  expect(typeNames(relevant)).toEqual([
    "LLMFullResponseStartFrame",
    "TTSStoppedFrame",
    "LLMFullResponseEndFrame",
    "LLMFullResponseStartFrame",
    "TTSStoppedFrame",
    "LLMFullResponseEndFrame",
  ]);
});

function strictlyIncreasing(values: readonly (number | null)[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (!((values[i - 1] as number) < (values[i] as number))) return false;
  }
  return true;
}

test("test_http_word_timestamps_verbatim_tokens", async () => {
  // HTTP path: text, PTS order, and text-before-audio are all verified.
  //
  // Word timestamps arrive in the audio context queue before the audio frame.
  // _handleAudioContext caches them, then flushes when the first audio frame
  // arrives (startWordTimestamps), so TTSTextFrames must be emitted before
  // the TTSAudioRawFrame in the downstream sequence.
  const wordTimes: WordTimes = [
    ["hello", 0.0],
    ["world", 0.2],
  ];
  const tts = new _MockWordTimestampHttpTTSService({ includesInterFrameSpaces: true, wordTimes });
  const framesReceived = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "hello world", appendToContext: false })],
  });
  const down = framesReceived[0];
  const ttsTextFrames = down.filter((f): f is TTSTextFrame => f instanceof TTSTextFrame);
  const audioFrames = down.filter((f) => f instanceof TTSAudioRawFrame);

  expect(ttsTextFrames.map((f) => f.text)).toEqual(["hello", "world"]);

  const ptsValues = ttsTextFrames.map((f) => f.pts);
  assert(strictlyIncreasing(ptsValues), `PTS values must be strictly increasing, got ${ptsValues}`);

  // TTSTextFrames must precede the audio frame (they are flushed from cache
  // at the moment the first audio chunk sets the timestamp baseline).
  const lastTextIdx = Math.max(...ttsTextFrames.map((f) => down.indexOf(f)));
  const firstAudioIdx = down.indexOf(audioFrames[0]!);
  assert(
    lastTextIdx < firstAudioIdx,
    "TTSTextFrames must appear before TTSAudioRawFrame in the downstream sequence",
  );
});

const _VERBATIM_TOKENS: WordTimes = [
  ["hello", 0.0],
  [" world", 0.15],
  ["! ", 0.3],
  ["How", 0.45],
  [" are", 0.6],
  [" you", 0.75],
  ["?", 0.9],
];

test("test_http_word_timestamps_punctuation_tokens", async () => {
  // Punct-only tokens are merged into the preceding word when preMergeTokens=true.
  //
  // Models the Inworld API scenario: the TTS returns separate space and punctuation
  // tokens. addWordTimestamps calls mergePunctTokens when preMergeTokens=true,
  // collapsing those tokens into the preceding word before the tracker sees them.
  //
  // With preMergeTokens=false (default) tokens are forwarded as-is; the tracker
  // strips leading/trailing whitespace from each frame word via getWordForFrame().
  const verbatimTokens = _VERBATIM_TOKENS;

  // With preMergeTokens=true: punct-only tokens ("! " and "?") are merged into the
  // preceding words (" world" → " world! " and " you" → " you?"), then stripped.
  const ttsMerged = new _MockWordTimestampHttpTTSService({
    preMergeTokens: true,
    wordTimes: verbatimTokens,
  });
  const framesMerged = await runTest(ttsMerged, {
    framesToSend: [
      new TTSSpeakFrame({ text: "hello world! How are you?", appendToContext: false }),
    ],
  });
  const textFramesMerged = framesMerged[0].filter(
    (f): f is TTSTextFrame => f instanceof TTSTextFrame,
  );
  // Punct-only tokens must be merged into the preceding word
  expect(textFramesMerged.map((f) => f.text)).toEqual(["hello", "world!", "How", "are", "you?"]);

  // With preMergeTokens=false (default): no merging; tracker strips leading/trailing spaces.
  const ttsPlain = new _MockWordTimestampHttpTTSService({ wordTimes: verbatimTokens });
  const framesPlain = await runTest(ttsPlain, {
    framesToSend: [
      new TTSSpeakFrame({ text: "hello world! How are you?", appendToContext: false }),
    ],
  });
  const textFramesPlain = framesPlain[0].filter(
    (f): f is TTSTextFrame => f instanceof TTSTextFrame,
  );
  expect(textFramesPlain.map((f) => f.text)).toEqual([
    "hello",
    "world",
    "!",
    "How",
    "are",
    "you",
    "?",
  ]);
});

test("test_websocket_word_timestamps_verbatim_tokens", async () => {
  // WebSocket path: text, PTS order, and text-before-audio are all verified.
  //
  // Unlike the HTTP path the word timestamps are sent asynchronously from a
  // background task. They arrive before the audio frame and are cached until
  // startWordTimestamps() fires, so the same text-before-audio ordering
  // property must hold.
  const wordTimes: WordTimes = [
    ["hello", 0.0],
    ["world", 0.2],
  ];
  const tts = new _MockWordTimestampWSTTSService({ includesInterFrameSpaces: true, wordTimes });
  const framesReceived = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "hello world", appendToContext: false })],
  });
  const down = framesReceived[0];
  const ttsTextFrames = down.filter((f): f is TTSTextFrame => f instanceof TTSTextFrame);
  const audioFrames = down.filter((f) => f instanceof TTSAudioRawFrame);

  expect(ttsTextFrames.map((f) => f.text)).toEqual(["hello", "world"]);

  const ptsValues = ttsTextFrames.map((f) => f.pts);
  assert(strictlyIncreasing(ptsValues), `PTS values must be strictly increasing, got ${ptsValues}`);

  const lastTextIdx = Math.max(...ttsTextFrames.map((f) => down.indexOf(f)));
  const firstAudioIdx = down.indexOf(audioFrames[0]!);
  assert(
    lastTextIdx < firstAudioIdx,
    "TTSTextFrames must appear before TTSAudioRawFrame in the downstream sequence",
  );
});

test("test_websocket_word_timestamps_punctuation_tokens", async () => {
  // WebSocket path: punct-only tokens are merged into the preceding word.
  const tts = new _MockWordTimestampWSTTSService({
    preMergeTokens: true,
    wordTimes: _VERBATIM_TOKENS,
  });
  const framesReceived = await runTest(tts, {
    framesToSend: [
      new TTSSpeakFrame({ text: "hello world! How are you?", appendToContext: false }),
    ],
  });
  const textFrames = framesReceived[0].filter((f): f is TTSTextFrame => f instanceof TTSTextFrame);
  // Punct-only tokens must be merged into the preceding word
  expect(textFrames.map((f) => f.text)).toEqual(["hello", "world!", "How", "are", "you?"]);
});

// ---------------------------------------------------------------------------
// Per-call word-timestamp mock (for overflow tests)
// ---------------------------------------------------------------------------

interface MockPerCallTTSServiceOptions extends TTSServiceOptions {
  wordTimesPerCall: WordTimes[];
}

/**
 * HTTP-style TTS where each runTts() call consumes its own word-time list.
 *
 * Designed for tests that need different word tokens per sentence. The
 * `wordTimesPerCall` list is consumed in order; an empty inner list means
 * no word-timestamp events are emitted for that call.
 */
class _MockPerCallWordTimestampHttpTTSService extends TTSService {
  protected _wordTimesQueue: WordTimes[];

  constructor(options: MockPerCallTTSServiceOptions) {
    const { wordTimesPerCall, ...rest } = options;
    super({
      pushStartFrame: true,
      pushStopFrames: true,
      pushTextFrames: false,
      sampleRate: _SAMPLE_RATE,
      ...rest,
    });
    this._wordTimesQueue = [...wordTimesPerCall];
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const wordTimes = this._wordTimesQueue.shift() ?? [];
    if (wordTimes.length) {
      await this.addWordTimestamps(wordTimes, contextId);
    }
    yield fakeAudio(contextId);
  }
}

// ---------------------------------------------------------------------------
// Tests: skipped frame ordering (skipTextTypes)
// ---------------------------------------------------------------------------

function _skippedFrameWaitsForSpokenWords(down: Frame[]): void {
  const wordFrames = down.filter((f): f is TTSTextFrame => f instanceof TTSTextFrame);
  const skipped = down.filter(
    (f): f is AggregatedTextFrame => f instanceof AggregatedTextFrame && f.text === "some code",
  );

  expect(wordFrames.map((f) => f.text)).toEqual(["hello", "world"]);
  expect(skipped.length).toEqual(1);
  expect(skipped[0]!.appendToContext).toBe(true);

  const lastWordIdx = Math.max(...wordFrames.map((f) => down.indexOf(f)));
  const skippedIdx = down.indexOf(skipped[0]!);
  assert(
    skippedIdx > lastWordIdx,
    `Skipped frame (pos ${skippedIdx}) must appear after last word frame (pos ${lastWordIdx})`,
  );
}

test("test_http_skipped_frame_waits_for_spoken_words", async () => {
  // Skipped frames are held until the preceding spoken slot's word timestamps
  // are all processed, then flushed in order (HTTP / synchronous audio path).
  //
  // Sequence sent:
  //     AggregatedTextFrame("hello world", SENTENCE)  — spoken; yields 2 TTSTextFrames
  //     AggregatedTextFrame("some code", "code")       — in skipTextTypes; must wait
  //
  // Expected downstream order:
  //     TTSTextFrame("hello")
  //     TTSTextFrame("world")
  //     AggregatedTextFrame("some code", appendToContext=true)
  const tts = new _MockWordTimestampHttpTTSService({ skipTextTypes: ["code"] });
  const framesReceived = await runTest(tts, {
    framesToSend: [
      new AggregatedTextFrame({ text: "hello world", textType: TextType.SENTENCE }),
      new AggregatedTextFrame({ text: "some code", textType: "code" }),
    ],
  });
  _skippedFrameWaitsForSpokenWords(framesReceived[0]);
});

test("test_ws_skipped_frame_waits_for_spoken_words", async () => {
  // Same ordering guarantee on the WebSocket / async audio delivery path.
  //
  // Because audio is delivered from a background task after sleep(), the
  // skipped frame arrives at _pushSkippedText *before* the spoken slot's word
  // timestamps have been processed, directly exercising the hold-and-flush path.
  const tts = new _MockWordTimestampWSTTSService({ skipTextTypes: ["code"] });
  const framesReceived = await runTest(tts, {
    framesToSend: [
      new AggregatedTextFrame({ text: "hello world", textType: TextType.SENTENCE }),
      new AggregatedTextFrame({ text: "some code", textType: "code" }),
    ],
  });
  _skippedFrameWaitsForSpokenWords(framesReceived[0]);
});

test("test_skipped_frame_before_spoken_emits_immediately", async () => {
  // A skipped frame with no preceding spoken slot is emitted right away.
  //
  // Sequence:
  //     AggregatedTextFrame("some code", "code")       — no spoken slot before it → emits now
  //     AggregatedTextFrame("hello world", SENTENCE)   — spoken; TTSTextFrames follow
  //
  // Expected: AggregatedTextFrame("some code") appears *before* TTSTextFrame("hello").
  const tts = new _MockWordTimestampHttpTTSService({ skipTextTypes: ["code"] });
  const framesReceived = await runTest(tts, {
    framesToSend: [
      new AggregatedTextFrame({ text: "some code", textType: "code" }),
      new AggregatedTextFrame({ text: "hello world", textType: TextType.SENTENCE }),
    ],
  });
  const down = framesReceived[0];

  const wordFrames = down.filter((f) => f instanceof TTSTextFrame);
  const skipped = down.filter(
    (f): f is AggregatedTextFrame => f instanceof AggregatedTextFrame && f.text === "some code",
  );

  expect(skipped.length).toEqual(1);
  expect(skipped[0]!.appendToContext).toBe(true);
  expect(skipped[0]!.skipTts).toBe(true);
  expect(wordFrames.length).toBeGreaterThanOrEqual(1);

  const skippedIdx = down.indexOf(skipped[0]!);
  const firstWordIdx = down.indexOf(wordFrames[0]!);
  assert(
    skippedIdx < firstWordIdx,
    `Skipped frame (pos ${skippedIdx}) must appear before first word frame (pos ${firstWordIdx})`,
  );
});

test("test_skipped_frame_flushed_when_word_timestamps_incomplete", async () => {
  // Force-complete path: skipped frame still emits when the TTS drops word timestamps.
  //
  // Only one of the two expected tokens ("hello") is returned. The spoken slot never
  // reaches its expected character count through the normal path. When
  // onAudioContextDone fires it force-completes any remaining spoken slots and
  // flushes the waiting skipped frame.
  const tts = new _MockWordTimestampHttpTTSService({
    wordTimes: [["hello", 0.0]], // "world" is never sent
    skipTextTypes: ["code"],
  });
  const framesReceived = await runTest(tts, {
    framesToSend: [
      new AggregatedTextFrame({ text: "hello world", textType: TextType.SENTENCE }),
      new AggregatedTextFrame({ text: "some code", textType: "code" }),
    ],
  });
  const down = framesReceived[0];

  const skipped = down.filter(
    (f): f is AggregatedTextFrame => f instanceof AggregatedTextFrame && f.text === "some code",
  );
  // Skipped frame must be flushed via force-complete safety net
  expect(skipped.length).toEqual(1);
  expect(skipped[0]!.appendToContext).toBe(true);
});

// ---------------------------------------------------------------------------
// Tests: LLM text marked skipTts
// ---------------------------------------------------------------------------

function _skipTts<T extends Frame>(frame: T): T {
  (frame as unknown as { skipTts: boolean }).skipTts = true;
  return frame;
}

/** An LLM response the LLM marked skipTts, as it streams it. */
function _skipTtsResponse(...chunks: string[]): Frame[] {
  return [
    _skipTts(new LLMFullResponseStartFrame()),
    ...chunks.map((chunk) => _skipTts(new LLMTextFrame({ text: chunk }))),
    _skipTts(new LLMFullResponseEndFrame()),
  ];
}

for (const mode of [TextAggregationMode.SENTENCE, TextAggregationMode.TOKEN]) {
  test(`test_skip_tts_llm_text_is_pushed_as_unspoken_sentences[${mode}]`, async () => {
    // A response that isn't spoken is still cut into sentences, in token mode too.
    const tts = new MockHttpTTSService({ textAggregationMode: mode });
    const [down] = await runTest(tts, {
      framesToSend: _skipTtsResponse("Hello there. How", " are you?"),
    });

    const sentences = down.filter(
      (f): f is AggregatedTextFrame => f instanceof AggregatedTextFrame,
    );
    expect(sentences.map((f) => f.text)).toEqual(["Hello there.", "How are you?"]);
    expect(sentences.every((f) => f.skipTts && !f.willBeSpoken)).toBe(true);
    expect(down.some((f) => isAny(f, [LLMTextFrame, TTSStartedFrame, TTSAudioRawFrame]))).toBe(
      false,
    );
    expect(down.map((f) => f.constructor)).toEqual([
      LLMFullResponseStartFrame,
      AggregatedTextFrame,
      AggregatedTextFrame,
      LLMFullResponseEndFrame,
    ]);
  });
}

test("test_skip_tts_response_of_only_whitespace_has_no_sentences", async () => {
  // A response that isn't spoken and holds only whitespace pushes no text.
  const [down] = await runTest(new MockHttpTTSService(), {
    framesToSend: _skipTtsResponse("\n"),
  });

  expect(down.map((f) => f.constructor)).toEqual([
    LLMFullResponseStartFrame,
    LLMFullResponseEndFrame,
  ]);
});

test("test_skip_tts_text_that_isnt_llm_text_passes_through", async () => {
  // Text another processor marked skipTts, such as an IVR tag, is pushed on as it is.
  const tag = _skipTts(new TextFrame({ text: "<dtmf>1</dtmf>" }));
  const [down] = await runTest(new MockHttpTTSService(), { framesToSend: [tag] });

  const texts = down.filter((f) => f instanceof TextFrame);
  expect(texts.length).toEqual(1);
  expect(texts[0]).toBe(tag);
});

test("test_skip_tts_response_reaches_the_context_once", async () => {
  // The context gets the response once, as the sentences it was cut into.
  const context = new LLMContext();
  const pipeline = new Pipeline([new MockHttpTTSService(), new LLMAssistantAggregator(context)]);
  await runTest(pipeline, { framesToSend: _skipTtsResponse("Hello there. How", " are you?") });

  expect(context.messages).toEqual([{ role: "assistant", content: "Hello there. How are you?" }]);
});

function _index(frames: readonly Frame[], predicate: (f: Frame) => boolean): number {
  const i = frames.findIndex(predicate);
  if (i < 0) throw new Error("StopIteration");
  return i;
}

test("test_skip_tts_response_comes_out_after_the_audio_still_playing", async () => {
  // A reply that isn't spoken waits for earlier speech, then its frames come out in order.
  const [down] = await runTest(new MockWebSocketTTSService(), {
    framesToSend: [new TTSSpeakFrame({ text: "One moment." }), ..._skipTtsResponse("Hello there.")],
  });

  const audio = _index(down, (f) => f instanceof TTSAudioRawFrame);
  const start = _index(down, (f) => f instanceof LLMFullResponseStartFrame);
  const sentence = _index(down, (f) => f instanceof AggregatedTextFrame && !!f.skipTts);
  const end = _index(down, (f) => f instanceof LLMFullResponseEndFrame);
  expect(audio < start && start < sentence && sentence < end).toBe(true);
});

test("test_skip_tts_response_after_speech_reaches_the_context_once", async () => {
  // The context gets a reply that isn't spoken once, even while earlier speech plays.
  const context = new LLMContext();
  const pipeline = new Pipeline([
    new MockWebSocketTTSService(),
    new LLMAssistantAggregator(context),
  ]);
  await runTest(pipeline, {
    framesToSend: [
      new TTSSpeakFrame({ text: "One moment.", appendToContext: false }),
      ..._skipTtsResponse("Hello there. How", " are you?"),
    ],
  });

  expect(context.messages).toEqual([{ role: "assistant", content: "Hello there. How are you?" }]);
});

// ---------------------------------------------------------------------------
// Tests: rawText propagation through WordCompletionTracker
// ---------------------------------------------------------------------------

test("test_raw_text_propagated_to_tts_text_frames", async () => {
  // rawText on AggregatedTextFrame is split across TTSTextFrames by the tracker.
  //
  // The frame carries rawText="<card>4111 1111</card>" while the TTS-prepared
  // text is "4111 1111". The WordCompletionTracker advances a cursor through the
  // raw text in step with incoming word tokens, so each TTSTextFrame receives the
  // exact raw span it represents.
  //
  // Expected (trailing whitespace stripped because includesInterFrameSpaces=false):
  //     TTSTextFrame("4111").rawText == "<card>4111"
  //     TTSTextFrame("1111").rawText == "1111</card>"
  const tts = new _MockWordTimestampHttpTTSService();
  const framesReceived = await runTest(tts, {
    framesToSend: [
      new AggregatedTextFrame({
        text: "4111 1111",
        textType: TextType.SENTENCE,
        rawText: "<card>4111 1111</card>",
      }),
    ],
  });
  const wordFrames = framesReceived[0].filter((f): f is TTSTextFrame => f instanceof TTSTextFrame);

  expect(wordFrames.map((f) => f.text)).toEqual(["4111", "1111"]);
  // getRawConsumed() strips trailing whitespace when includesInterFrameSpaces=false
  expect(wordFrames[0]!.rawText).toEqual("<card>4111");
  expect(wordFrames[1]!.rawText).toEqual("1111</card>");
});

// ---------------------------------------------------------------------------
// Tests: overflow — TTS word spanning two AggregatedTextFrame boundaries
// ---------------------------------------------------------------------------

test("test_overflow_word_spanning_two_aggregated_frames", async () => {
  // A single TTS token straddling two same-turn sentence slots produces two frames.
  //
  // Setup (one LLM turn, so both sentences share the turn's context ID under
  // reuseContextIdWithinTurn):
  //     Frame 1: AggregatedTextFrame("abc", SENTENCE)
  //     Frame 2: AggregatedTextFrame("def", SENTENCE)
  //
  // The TTS for frame 1 returns the single token "abcdef", which overshoots frame 1
  // by three characters. The overflow is sliced and routed to frame 2's slot (the
  // next incomplete slot of the same context):
  //     TTSTextFrame("abc")  — frame 1's portion
  //     TTSTextFrame("def")  — overflow attributed to frame 2
  //
  // Frame 2 receives no word-timestamp events because the overflow already consumed
  // its expected text. A single word-timestamp token only ever spans slots within one
  // context — separate contexts are independent syntheses — so both frames carry the
  // same context ID.
  const tts = new _MockPerCallWordTimestampHttpTTSService({
    wordTimesPerCall: [
      [["abcdef", 0.0]], // frame 1: single token spanning both frames
      [], // frame 2: no word timestamps (overflow already covered it)
    ],
  });
  const framesReceived = await runTest(tts, {
    framesToSend: [
      new LLMFullResponseStartFrame(),
      new AggregatedTextFrame({ text: "abc", textType: TextType.SENTENCE }),
      new AggregatedTextFrame({ text: "def", textType: TextType.SENTENCE }),
      new LLMFullResponseEndFrame(),
    ],
  });
  const wordFrames = framesReceived[0].filter((f): f is TTSTextFrame => f instanceof TTSTextFrame);

  expect(wordFrames.map((f) => f.text)).toEqual(["abc", "def"]);
  // Overflow within a turn stays in the same context
  expect(wordFrames[0]!.contextId).toEqual(wordFrames[1]!.contextId);
});

// ---------------------------------------------------------------------------
// Per-call word-timestamp mock for WebSocket path (for force-complete tests)
// ---------------------------------------------------------------------------

/**
 * WebSocket-style TTS where each runTts() call consumes its own word-time list.
 *
 * Mirrors _MockPerCallWordTimestampHttpTTSService but uses the async audio-context
 * delivery pattern so it exercises _handleAudioContext (the WebSocket path).
 * An empty inner list means no word-timestamp events are emitted for that call.
 */
class _MockPerCallWordTimestampWSTTSService extends TTSService {
  protected _wordTimesQueue: WordTimes[];

  constructor(options: MockPerCallTTSServiceOptions) {
    const { wordTimesPerCall, ...rest } = options;
    super({
      pushStartFrame: true,
      pushTextFrames: false,
      pauseFrameProcessing: false,
      sampleRate: _SAMPLE_RATE,
      ...rest,
    });
    this._wordTimesQueue = [...wordTimesPerCall];
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const wordTimes = this._wordTimesQueue.shift() ?? [];

    const deliver = async () => {
      await sleep(0.01);
      if (wordTimes.length) {
        await this.addWordTimestamps(wordTimes, contextId);
      }
      await this.appendToAudioContext(contextId, fakeAudio(contextId));
      await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
      await this.removeAudioContext(contextId);
    };

    this.createTask(() => deliver(), `mock_ws_per_call_deliver_${contextId}`);
  }
}

/**
 * WebSocket-style TOKEN-streaming TTS: one runTts() call per token, all sharing
 * one audio context (mirrors `_reuseContextIdWithinTurn`).
 *
 * Each call delivers its own word-timestamp event into the shared context but never
 * closes it — the context is only closed when flushAudio() is called, mirroring a
 * real provider's "continue: false" semantics, triggered by
 * TTSService.onTurnContextCompleted() at end of turn.
 */
class _MockTokenStreamingWSTTSService extends TTSService {
  protected _wordTimesQueue: WordTimes[];

  constructor(options: MockPerCallTTSServiceOptions) {
    const { wordTimesPerCall, ...rest } = options;
    super({
      pushStartFrame: true,
      pushTextFrames: false,
      pauseFrameProcessing: false,
      sampleRate: _SAMPLE_RATE,
      ...rest,
    });
    this._wordTimesQueue = [...wordTimesPerCall];
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const wordTimes = this._wordTimesQueue.shift() ?? [];

    const deliver = async () => {
      await sleep(0.01);
      if (wordTimes.length) {
        await this.addWordTimestamps(wordTimes, contextId);
      }
      await this.appendToAudioContext(contextId, fakeAudio(contextId));
    };

    this.createTask(() => deliver(), `mock_token_deliver_${contextId}`);
  }

  override async flushAudio(contextId: string | null = null): Promise<void> {
    const ctx = contextId || this.getActiveAudioContextId();
    if (!ctx || !this.audioContextAvailable(ctx)) {
      return;
    }

    const close = async () => {
      await sleep(0.02);
      await this.appendToAudioContext(ctx, new TTSStoppedFrame({ contextId: ctx }));
      await this.removeAudioContext(ctx);
    };

    this.createTask(() => close(), `mock_token_close_${ctx}`);
  }
}

/**
 * WebSocket-style TOKEN-streaming TTS with no word-timestamp support (e.g.
 * DeepgramFluxTTSService): one runTts() call per token, all sharing one audio
 * context, pushTextFrames=true.
 *
 * Mirrors _MockTokenStreamingWSTTSService but runTts() never calls
 * addWordTimestamps — audio just appears asynchronously, exercising the
 * pushTextFrames=true + TOKEN-streaming combination where the sequencer has
 * no per-word signal and must complete each promoted sentence immediately.
 */
class _MockTokenStreamingPushTextWSTTSService extends TTSService {
  constructor(options: TTSServiceOptions = {}) {
    super({
      pushStartFrame: true,
      pushTextFrames: true,
      pauseFrameProcessing: false,
      sampleRate: _SAMPLE_RATE,
      ...options,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const deliver = async () => {
      await sleep(0.01);
      await this.appendToAudioContext(contextId, fakeAudio(contextId));
    };

    this.createTask(() => deliver(), `mock_token_push_text_deliver_${contextId}`);
  }

  override async flushAudio(contextId: string | null = null): Promise<void> {
    const ctx = contextId || this.getActiveAudioContextId();
    if (!ctx || !this.audioContextAvailable(ctx)) {
      return;
    }

    const close = async () => {
      await sleep(0.02);
      await this.appendToAudioContext(ctx, new TTSStoppedFrame({ contextId: ctx }));
      await this.removeAudioContext(ctx);
    };

    this.createTask(() => close(), `mock_token_push_text_close_${ctx}`);
  }
}

// ---------------------------------------------------------------------------
// Tests: _forceCompleteSpokenSlots — TTSTextFrame emission for dropped timestamps
// ---------------------------------------------------------------------------

function ttsTexts(frames: readonly Frame[]): TTSTextFrame[] {
  return frames.filter((f): f is TTSTextFrame => f instanceof TTSTextFrame);
}

test("test_http_force_complete_partial_timestamps_emits_remaining_text", async () => {
  // _forceCompleteSpokenSlots emits a TTSTextFrame for the unspoken word suffix.
  //
  // Only the first token ("hello") is delivered as a word-timestamp event; "world"
  // is never sent. When the audio context ends _forceCompleteSpokenSlots fires,
  // reads getRemainingText() from the tracker, and emits TTSTextFrame("world").
  //
  // Expected TTSTextFrames in order: ["hello", "world"].
  const tts = new _MockWordTimestampHttpTTSService({ wordTimes: [["hello", 0.0]] });
  const framesReceived = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "hello world", appendToContext: false })],
  });
  const wordFrames = ttsTexts(framesReceived[0]);

  expect(wordFrames.map((f) => f.text)).toEqual(["hello", "world"]);
});

test("test_http_force_complete_no_timestamps_emits_full_text", async () => {
  // _forceCompleteSpokenSlots emits the full text when no word timestamps arrive.
  //
  // No word-timestamp events are sent for "hello world". The slot remains incomplete
  // when the audio context ends; force-complete reads the full remaining text from the
  // tracker and emits TTSTextFrame("hello world").
  const tts = new _MockPerCallWordTimestampHttpTTSService({ wordTimesPerCall: [[]] });
  const framesReceived = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "hello world", appendToContext: false })],
  });
  const wordFrames = ttsTexts(framesReceived[0]);

  expect(wordFrames.map((f) => f.text)).toHaveLength(1);
  expect(wordFrames[0]!.text).toEqual("hello world");
});

test("test_http_force_complete_raw_text_propagated", async () => {
  // force-complete carries the correct rawText span on the emitted TTSTextFrame.
  //
  // AggregatedTextFrame carries rawText="<card>4111 1111</card>". Only "4111" arrives
  // as a word-timestamp; "1111" is force-completed.
  //
  // Expected:
  //     TTSTextFrame("4111").rawText == "<card>4111"    — from normal word path
  //     TTSTextFrame("1111").rawText == "1111</card>"   — from force-complete path
  const tts = new _MockPerCallWordTimestampHttpTTSService({
    wordTimesPerCall: [[["4111", 0.0]]],
  });
  const framesReceived = await runTest(tts, {
    framesToSend: [
      new AggregatedTextFrame({
        text: "4111 1111",
        textType: TextType.SENTENCE,
        rawText: "<card>4111 1111</card>",
      }),
    ],
  });
  const wordFrames = ttsTexts(framesReceived[0]);

  expect(wordFrames.map((f) => f.text)).toEqual(["4111", "1111"]);
  expect(wordFrames[0]!.rawText).toEqual("<card>4111");
  expect(wordFrames[1]!.rawText).toEqual("1111</card>");
});

test("test_ws_force_complete_partial_timestamps_emits_remaining_text", async () => {
  // WebSocket path: _forceCompleteSpokenSlots emits TTSTextFrame for dropped token.
  //
  // Mirrors test_http_force_complete_partial_timestamps_emits_remaining_text on the
  // async audio delivery path to confirm force-complete fires correctly from
  // _handleAudioContext when TTSStoppedFrame arrives before all word timestamps.
  const tts = new _MockWordTimestampWSTTSService({ wordTimes: [["hello", 0.0]] });
  const framesReceived = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "hello world", appendToContext: false })],
  });
  const wordFrames = ttsTexts(framesReceived[0]);

  expect(wordFrames.map((f) => f.text)).toEqual(["hello", "world"]);
});

test("test_ws_force_complete_no_timestamps_emits_full_text", async () => {
  // WebSocket path: full text emitted as single TTSTextFrame when no timestamps arrive.
  const tts = new _MockPerCallWordTimestampWSTTSService({ wordTimesPerCall: [[]] });
  const framesReceived = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "hello world", appendToContext: false })],
  });
  const wordFrames = ttsTexts(framesReceived[0]);

  expect(wordFrames.map((f) => f.text)).toHaveLength(1);
  expect(wordFrames[0]!.text).toEqual("hello world");
});

test("test_push_aggregation_pts_after_last_word", async () => {
  // LLMAssistantPushAggregationFrame must carry PTS > last TTSTextFrame PTS.
  //
  // Without a PTS the aggregation frame routes through the transport's audio
  // (sync) queue while word-level TTSTextFrames go through the clock queue, so
  // it can overtake the last words and leave the trailing text orphaned in the
  // aggregator buffer (issue #4264).
  const wordTimes: WordTimes = [
    ["hello", 0.0],
    ["world", 0.2],
  ];
  const tts = new _MockWordTimestampHttpTTSService({ wordTimes });
  const framesReceived = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "hello world", appendToContext: true })],
  });
  const down = framesReceived[0];
  const textFrames = ttsTexts(down);
  const pushFrames = down.filter((f) => f instanceof LLMAssistantPushAggregationFrame);

  expect(pushFrames).toHaveLength(1);
  assert(textFrames.length > 0, "Expected TTSTextFrames to be emitted");

  const lastWordPts = Math.max(...textFrames.map((f) => f.pts as number));
  const pushPts = pushFrames[0]!.pts;
  assert(
    pushPts !== null && pushPts > lastWordPts,
    `LLMAssistantPushAggregationFrame.pts (${pushPts}) must exceed ` +
      `the last TTSTextFrame PTS (${lastWordPts}) so it can't overtake it in the ` +
      "transport's clock queue",
  );
});

test("test_push_aggregation_no_pts_without_word_timestamps", async () => {
  // Aggregation frame stays unstamped when no word timestamps were emitted.
  //
  // Without word frames, both the aggregation frame and any other downstream
  // frames travel through the transport's sync queue in order, so adding a PTS
  // would needlessly route it through the clock queue.
  const tts = new MockHttpTTSService();
  const framesReceived = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "hello world", appendToContext: true })],
  });
  const pushFrames = framesReceived[0].filter((f) => f instanceof LLMAssistantPushAggregationFrame);
  expect(pushFrames).toHaveLength(1);
  expect(pushFrames[0]!.pts === null || pushFrames[0]!.pts === 0).toBe(true);
});

function fooLabels(frames: readonly Frame[]): string[] {
  return frames.filter((f): f is FooFrame => f instanceof FooFrame).map((f) => f.label);
}

test("test_no_deadlock_on_interrupt_before_audio_simple", async () => {
  // Interrupting before any TTS audio arrives must not deadlock.
  //
  // This simpler scenario (no uninterruptible frame in the queue at interrupt
  // time) is handled by _startInterruption() in the base class: it cancels and
  // recreates the process task, resetting #shouldBlockFrames to false.
  //
  // Timeline:
  // 1. LLM response → text sent to TTS.
  // 2. LLMFullResponseEndFrame → pauseProcessingFrames() called.
  // 3. (No audio from TTS yet; BotStoppedSpeakingFrame never sent.)
  // 4. InterruptionFrame → _startInterruption() cancels + recreates process
  //    task → #shouldBlockFrames=false.
  // 5. FooFrame must arrive downstream within the timeout.
  const tts = new MockWebSocketPauseTTSServiceNoAudio();

  const framesToSend = [
    new LLMFullResponseStartFrame(),
    new TextFrame({ text: "Hello." }),
    new LLMFullResponseEndFrame(),
    new SleepFrame({ sleep: 0.1 }), // window: after pause set, before audio
    new InterruptionFrame(),
    new SleepFrame({ sleep: 0.1 }),
    new FooFrame({ label: "after_interrupt" }),
  ];

  const framesReceived = await waitFor(() => runTest(tts, { framesToSend }), 3.0);

  // FooFrame after interruption was not received — possible deadlock
  expect(fooLabels(framesReceived[0])).toContain("after_interrupt");
});

test("test_no_deadlock_on_interrupt_before_audio_with_uninterruptible", async () => {
  // Interrupting during pause with an uninterruptible frame queued must not deadlock.
  //
  // This is the harder scenario that requires the fix in _handleInterruption().
  //
  // Without the fix the pipeline deadlocks permanently:
  //   - pauseProcessingFrames() blocks #shouldBlockFrames=true.
  //   - The process task dequeues UninterruptibleMarkerFrame and blocks at
  //     #processEvent.wait().
  //   - InterruptionFrame arrives → _startInterruption() sees the
  //     uninterruptible frame and takes the reset-queue-only path, leaving
  //     #shouldBlockFrames=true and the process task blocked.
  //   - BotStoppedSpeakingFrame is never sent (no audio played).
  //   - resumeProcessingFrames() is never called → deadlock.
  //
  // With the fix (_releaseFramesIfAudioContextsEnded() inside _handleInterruption()),
  // the event is set and the process task unblocks, allowing subsequent frames
  // (FooFrame, EndFrame) to be processed.
  const tts = new MockWebSocketPauseTTSServiceNoAudio();

  const framesToSend = [
    new LLMFullResponseStartFrame(),
    new TextFrame({ text: "Hello." }),
    new LLMFullResponseEndFrame(),
    // Queue right after: process task will pick this up after setting pause,
    // then block at #processEvent.wait() because #shouldBlockFrames=true.
    new UninterruptibleMarkerFrame({ label: "uninterruptible" }),
    new SleepFrame({ sleep: 0.1 }), // let process task dequeue and block on the frame
    new InterruptionFrame(),
    new SleepFrame({ sleep: 0.1 }), // let interruption handling complete
    new FooFrame({ label: "after_interrupt" }),
  ];

  const framesReceived = await waitFor(() => runTest(tts, { framesToSend }), 3.0);

  // FooFrame after interruption was not received — pipeline deadlocked
  // (missing _releaseFramesIfAudioContextsEnded() in _handleInterruption)
  expect(fooLabels(framesReceived[0])).toContain("after_interrupt");
});

test("test_no_deadlock_on_zero_audio_context_completion", async () => {
  // A context that completes (TTSStoppedFrame) having produced zero
  // TTSAudioRawFrames must not deadlock the pipeline.
  //
  // Timeline:
  // 1. LLM response -> text sent to TTS.
  // 2. LLMFullResponseEndFrame -> pauseProcessingFrames() called, the context
  //    still being open and able to produce audio.
  // 3. Provider reports the context finished with no audio (TTSStoppedFrame,
  //    zero TTSAudioRawFrame). onAudioContextCompleted() is a no-op here,
  //    matching ElevenLabsTTSService's actual override.
  // 4. No BotStartedSpeakingFrame/BotStoppedSpeakingFrame ever arrives — in
  //    production the output transport only sends them once TTS audio was
  //    actually received, and this test models that absence directly by never
  //    sending either.
  // 5. The context completing with no audio resumes frame processing, so
  //    FooFrame must arrive downstream.
  const tts = new MockWebSocketPauseTTSServiceZeroAudioCompletion();

  const framesToSend = [
    new LLMFullResponseStartFrame(),
    new TextFrame({ text: "Hello." }),
    new LLMFullResponseEndFrame(),
    new SleepFrame({ sleep: 0.1 }), // let the zero-audio completion play out
    new FooFrame({ label: "after_completion" }),
  ];

  const framesReceived = await waitFor(() => runTest(tts, { framesToSend }), 3.0);

  // FooFrame after zero-audio context completion was not received —
  // pipeline deadlocked (missing resume-on-zero-audio guard)
  expect(fooLabels(framesReceived[0])).toContain("after_completion");
});

/** Text filter that strips all text, like a filter removing leaked reasoning tokens. */
class _StripEverythingFilter extends BaseTextFilter {
  override async filter(_text: string): Promise<string> {
    return "";
  }
}

test("test_filter_stripped_text_does_not_pause_frame_processing", async () => {
  // A text filter that strips the whole utterance must not pause frame processing.
  //
  // No audio context is opened for the stripped text, so nothing holds the
  // frames that follow it.
  const tts = new MockWebSocketPauseTTSServiceNoAudio({
    textFilters: [new _StripEverythingFilter()],
  });

  const framesToSend = [
    new LLMFullResponseStartFrame(),
    new TextFrame({ text: "Leaked reasoning tokens." }),
    new LLMFullResponseEndFrame(),
    new SleepFrame({ sleep: 0.1 }),
    new FooFrame({ label: "after_stripped_response" }),
  ];

  const framesReceived = await waitFor(() => runTest(tts, { framesToSend }), 3.0);

  // FooFrame was not received — frame processing paused on filter-stripped text
  expect(fooLabels(framesReceived[0])).toContain("after_stripped_response");
});

test("test_no_error_on_long_streaming_turn", async () => {
  // A long streaming turn whose audio is still playing reports no error.
  //
  // Timeline:
  // 1. LLM response -> text sent to TTS.
  // 2. BotStartedSpeakingFrame arrives *before* LLMFullResponseEndFrame —
  //    streaming TTS starts playback while the LLM is still generating, and
  //    the output transport only sends this frame once per turn.
  // 3. LLMFullResponseEndFrame -> frames wait for this turn's audio context
  //    to end.
  // 4. Time passes with no BotStoppedSpeakingFrame yet — nothing must push an
  //    ErrorFrame; playback is still legitimately in progress.
  // 5. BotStoppedSpeakingFrame finally arrives (playback finished); FooFrame
  //    must arrive afterward.
  const tts = new MockWebSocketPauseTTSServiceLongPlayback();

  const framesToSend = [
    new LLMFullResponseStartFrame(),
    new TextFrame({ text: "Hello, this is a long multi-sentence response." }),
    // Let LLMFullResponseStartFrame/TextFrame (ControlFrame/DataFrame,
    // handled by the process task) actually finish processing before
    // BotStartedSpeakingFrame arrives. BotStartedSpeakingFrame is a
    // SystemFrame handled inline by the input task, so it would otherwise
    // jump ahead of same-queued-but-not-yet-processed non-system frames
    // — an ordering quirk of the test harness sending everything nearly
    // simultaneously, not a real possibility in production, where
    // processing a plain LLMFullResponseStartFrame/TextFrame takes far
    // less time than a network round trip to start audio playback.
    new SleepFrame({ sleep: 0.05 }),
    new BotStartedSpeakingFrame(),
    new SleepFrame({ sleep: 0.05 }),
    new LLMFullResponseEndFrame(),
    new SleepFrame({ sleep: 0.3 }), // playback still in progress
    new BotStoppedSpeakingFrame(),
    new FooFrame({ label: "after_stop" }),
  ];

  const [down, up] = await waitFor(() => runTest(tts, { framesToSend }), 3.0);

  const errorFrames = up.filter((f) => f instanceof ErrorFrame);
  // Spurious ErrorFrame(s) during in-progress playback
  expect(errorFrames).toEqual([]);

  // FooFrame after BotStoppedSpeakingFrame was not received —
  // pipeline never resumed after the pause
  expect(fooLabels(down)).toContain("after_stop");
});

// ---------------------------------------------------------------------------
// Serialization queue interruption tests
// ---------------------------------------------------------------------------

/**
 * WebSocket TTS that creates an audio context but never delivers audio.
 *
 * The audio context consumer blocks indefinitely on the per-context queue,
 * allowing subsequent frames to accumulate in the serialization queue.
 * pauseFrameProcessing=false so frames after TTSSpeakFrame enter the
 * serialization queue directly rather than stalling in the FrameProcessor.
 */
class MockBlockingWebSocketTTSService extends TTSService {
  constructor(options: TTSServiceOptions = {}) {
    super({
      pushStartFrame: true,
      pushTextFrames: false,
      pauseFrameProcessing: false,
      sampleRate: _SAMPLE_RATE,
      ...options,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, _contextId: string): AsyncGenerator<Frame | null, void> {}
}

test("test_serialization_queue_drops_regular_frames_on_interruption", async () => {
  // Regular frames in the serialization queue are dropped on interruption.
  //
  // While the audio context consumer is blocked (no audio delivered), a FooFrame
  // enters the serialization queue. When InterruptionFrame arrives, the queue is
  // reset and the FooFrame must not appear downstream.
  const tts = new MockBlockingWebSocketTTSService();

  const framesToSend = [
    new TTSSpeakFrame({ text: "hello", appendToContext: false }),
    new SleepFrame({ sleep: 0.05 }), // let audio context task start blocking
    new FooFrame({ label: "will_be_dropped" }),
    new SleepFrame({ sleep: 0.05 }), // let FooFrame enter the serialization queue
    new InterruptionFrame(),
    new SleepFrame({ sleep: 0.1 }), // let interruption handling complete
  ];

  const framesReceived = await waitFor(() => runTest(tts, { framesToSend }), 5.0);

  // FooFrame should be dropped on interruption
  expect(fooLabels(framesReceived[0])).toHaveLength(0);
});

test("test_serialization_queue_preserves_uninterruptible_frames_on_interruption", async () => {
  // Uninterruptible frames in the serialization queue survive interruption.
  //
  // While the audio context consumer is blocked, both a regular FooFrame and an
  // UninterruptibleMarkerFrame enter the serialization queue. When InterruptionFrame
  // arrives, reset() drops FooFrame but keeps UninterruptibleMarkerFrame, which
  // the new audio context task then pushes downstream.
  const tts = new MockBlockingWebSocketTTSService();

  const framesToSend = [
    new TTSSpeakFrame({ text: "hello", appendToContext: false }),
    new SleepFrame({ sleep: 0.05 }), // let audio context task start blocking
    new FooFrame({ label: "will_be_dropped" }),
    new UninterruptibleMarkerFrame({ label: "must_survive" }),
    new SleepFrame({ sleep: 0.05 }), // let frames enter the serialization queue
    new InterruptionFrame(),
    new SleepFrame({ sleep: 0.1 }), // let interruption handling and new task run
  ];

  const framesReceived = await waitFor(() => runTest(tts, { framesToSend }), 5.0);

  const down = framesReceived[0];

  // FooFrame should be dropped on interruption
  expect(fooLabels(down)).toHaveLength(0);

  const uninterruptibleFrames = down.filter(
    (f): f is UninterruptibleMarkerFrame => f instanceof UninterruptibleMarkerFrame,
  );
  // UninterruptibleMarkerFrame must survive interruption
  expect(uninterruptibleFrames).toHaveLength(1);
  expect(uninterruptibleFrames[0]!.label).toEqual("must_survive");
});

// ---------------------------------------------------------------------------
// CJK (ElevenLabs-style) includesInterFrameSpaces propagation tests
// ---------------------------------------------------------------------------

/**
 * HTTP-style TTS that emits word timestamps with includesInterFrameSpaces=true.
 *
 * Models the ElevenLabs CJK path: each runTts() call consumes a pre-set
 * list of [word, timestamp] pairs and forwards them with
 * includesInterFrameSpaces=true, as ElevenLabsTTSService does for ja/zh.
 */
class _MockCJKHttpTTSService extends TTSService {
  protected _wordTimesQueue: WordTimes[];

  constructor(options: MockPerCallTTSServiceOptions) {
    const { wordTimesPerCall, ...rest } = options;
    super({
      pushStartFrame: true,
      pushStopFrames: true,
      pushTextFrames: false,
      sampleRate: _SAMPLE_RATE,
      ...rest,
    });
    this._wordTimesQueue = [...wordTimesPerCall];
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const wordTimes = this._wordTimesQueue.shift() ?? [];
    if (wordTimes.length) {
      await this.addWordTimestamps(wordTimes, contextId, { includesInterFrameSpaces: true });
    }
    yield fakeAudio(contextId);
  }
}

test("test_cjk_includes_inter_frame_spaces_propagated_to_tts_text_frames", async () => {
  // TTSTextFrames for CJK word tokens must carry includesInterFrameSpaces=true.
  //
  // When includesInterFrameSpaces=true is passed to addWordTimestamps (as
  // ElevenLabsTTSService does for Japanese/Chinese), every TTSTextFrame produced
  // for those tokens must have includesInterFrameSpaces=true so the context
  // aggregator does not inject extra spaces between them.
  //
  // Regression: registerSpoken() was called without includesInterFrameSpaces,
  // so the slot's flag was false. processWord() uses the slot's flag when an
  // active slot exists, ignoring the per-call value — emitting frames with
  // includesInterFrameSpaces=false and causing spurious spaces in CJK output.
  const wordTimes: WordTimes = [
    ["どんなことでも気", 0.0],
    ["軽に話しかけてくださいね。", 0.2],
  ];
  const tts = new _MockCJKHttpTTSService({ wordTimesPerCall: [wordTimes] });
  const framesReceived = await runTest(tts, {
    framesToSend: [
      new TTSSpeakFrame({
        text: "どんなことでも気軽に話しかけてくださいね。",
        appendToContext: false,
      }),
    ],
  });
  const ttsTextFrames = ttsTexts(framesReceived[0]);

  expect(ttsTextFrames).toHaveLength(2);
  for (const f of ttsTextFrames) {
    // TTSTextFrame must have includesInterFrameSpaces=true for CJK; context
    // assembler will inject spurious spaces otherwise
    expect(f.includesInterFrameSpaces).toBeTruthy();
  }
});

/**
 * WebSocket-style TTS that emits word timestamps with includesInterFrameSpaces=true.
 *
 * Like _MockCJKHttpTTSService but uses async audio-context delivery so each
 * context's background task completes cleanly before EndFrame closes the
 * pipeline, avoiding race conditions in multi-sentence tests.
 */
class _MockCJKWSTTSService extends TTSService {
  protected _wordTimesQueue: WordTimes[];

  constructor(options: MockPerCallTTSServiceOptions) {
    const { wordTimesPerCall, ...rest } = options;
    super({
      pushStartFrame: true,
      pushTextFrames: false,
      pauseFrameProcessing: false,
      sampleRate: _SAMPLE_RATE,
      ...rest,
    });
    this._wordTimesQueue = [...wordTimesPerCall];
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const wordTimes = this._wordTimesQueue.shift() ?? [];

    const deliver = async () => {
      await sleep(0.01);
      if (wordTimes.length) {
        await this.addWordTimestamps(wordTimes, contextId, { includesInterFrameSpaces: true });
      }
      await this.appendToAudioContext(contextId, fakeAudio(contextId));
      await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
      await this.removeAudioContext(contextId);
    };

    this.createTask(() => deliver(), `mock_cjk_ws_deliver_${contextId}`);
  }
}

function assembleContext(frames: readonly TTSTextFrame[]): string {
  const parts = frames.map(
    (f) =>
      new TextPartForConcatenation({
        text: f.text,
        includesInterPartSpaces: f.includesInterFrameSpaces,
      }),
  );
  return concatenateAggregatedText(parts);
}

test("test_cjk_two_sentences_no_extra_spaces_in_assembled_context", async () => {
  // Two Japanese TTS sentences assembled into context must not include extra spaces.
  //
  // Reproduces the observed bug where CJK output looked like:
  //     'こんにちは...です。 どんなことでも気 軽に...'
  // with both an inter-sentence space and an intra-sentence space.
  //
  // Both spurious spaces come from includesInterFrameSpaces not propagating
  // from addWordTimestamps through to the emitted TTSTextFrames. The fix
  // in the addWordTimestamps → _addWordTimestamps → processWord path is
  // bypassed because processWord prefers the slot's own flag (set by
  // registerSpoken, which did not receive includesInterFrameSpaces).
  const tts = new _MockCJKWSTTSService({
    wordTimesPerCall: [
      [
        ["こんにちは、私はあなたのお手伝いをする", 0.0],
        ["AIアシスタントです。", 0.5],
      ],
      [
        ["どんなことでも気", 0.0],
        ["軽に話しかけてくださいね。", 0.3],
      ],
    ],
  });
  const framesReceived = await runTest(tts, {
    framesToSend: [
      new TTSSpeakFrame({
        text: "こんにちは、私はあなたのお手伝いをするAIアシスタントです。",
        appendToContext: false,
      }),
      new SleepFrame({ sleep: 0.05 }),
      new TTSSpeakFrame({
        text: "どんなことでも気軽に話しかけてくださいね。",
        appendToContext: false,
      }),
      new SleepFrame({ sleep: 0.05 }),
    ],
  });
  const ttsTextFrames = ttsTexts(framesReceived[0]);

  const assembled = assembleContext(ttsTextFrames);

  const expected =
    "こんにちは、私はあなたのお手伝いをするAIアシスタントです。" +
    "どんなことでも気軽に話しかけてくださいね。";
  // Assembled context must not contain extra spaces.
  expect(assembled).toEqual(expected);
});

for (const [serviceFactory, id] of [
  [() => new MockHttpTTSService(), "base_class_start_frame"],
  [() => new MockSelfStartHttpTTSService(), "self_yielded_start_frame"],
] as const) {
  for (const appendToContext of [true, false]) {
    test(`test_tts_started_carries_append_to_context[${id}-${appendToContext ? "True" : "False"}]`, async () => {
      // TTSStartedFrame must carry the utterance's appendToContext.
      //
      // The assistant aggregator reads TTSStartedFrame.appendToContext to decide whether
      // to open an assistant turn for TTSSpeakFrame utterances. This must hold whether the
      // base class emits the TTSStartedFrame (pushStartFrame=true) or the service yields
      // its own (pushStartFrame=false), since both are stamped centrally from the TTS
      // context in _handleAudioContext.
      const tts = serviceFactory();
      const framesReceived = await runTest(tts, {
        framesToSend: [new TTSSpeakFrame({ text: "hello world", appendToContext })],
      });
      const started = framesReceived[0].filter(
        (f): f is TTSStartedFrame => f instanceof TTSStartedFrame,
      );
      // Expected exactly one TTSStartedFrame
      expect(started).toHaveLength(1);
      expect(started[0]!.appendToContext).toBe(appendToContext);
    });
  }
}

function sentenceAnchors(frames: readonly Frame[]): AggregatedTextFrame[] {
  return frames.filter(
    (f): f is AggregatedTextFrame =>
      f.constructor === AggregatedTextFrame &&
      (f as AggregatedTextFrame).textType === TextType.SENTENCE,
  );
}

function progressFrames(frames: readonly Frame[]): AggregatedTextProgressFrame[] {
  return frames.filter(
    (f): f is AggregatedTextProgressFrame => f instanceof AggregatedTextProgressFrame,
  );
}

function contextWordFrames(frames: readonly Frame[]): TTSTextFrame[] {
  return frames.filter((f): f is TTSTextFrame => f instanceof TTSTextFrame && f.appendToContext);
}

test("test_token_mode_progress_and_context_across_whole_sentence", async () => {
  // TextAggregationMode.TOKEN must track the whole sentence for progress and context.
  //
  // Two regressions this guards:
  //
  // 1. Progress: every streamed token used to register its own single-token
  //    WordCompletionTracker, so AggregatedTextProgressFrame reported a degenerate
  //    one-word accumulatedText. The sequencer now groups tokens back into a
  //    sentence, so progress grows across the whole sentence, and a single
  //    `TextType.SENTENCE` frame (`willBeSpoken=true`) is emitted as
  //    the anchor the progress frames' `segmentId` references.
  //
  // 2. Context: the per-word TTSTextFrames were stamped
  //    `includesInterFrameSpaces=true` (inherited from the LLM token flag),
  //    so the assistant context assembled with no spaces ("Hithere."). They must
  //    carry false so the context aggregator re-inserts spaces ("Hi there.").
  //
  // Two tokens ("Hi", " there.") are streamed individually — each gets its own
  // runTts() call and word-timestamp event — but are tracked as one sentence.
  const tts = new _MockTokenStreamingWSTTSService({
    wordTimesPerCall: [[["Hi", 0.0]], [["there.", 0.2]]],
    textAggregationMode: TextAggregationMode.TOKEN,
  });
  const framesToSend = [
    new LLMFullResponseStartFrame(),
    new TextFrame({ text: "Hi" }),
    new TextFrame({ text: " there." }),
    new LLMFullResponseEndFrame(),
  ];
  const framesReceived = await runTest(tts, { framesToSend });
  const down = framesReceived[0];

  // --- Progress across the whole sentence, one shared segment ---
  const progress = progressFrames(down);
  expect(progress).toHaveLength(2);
  const segmentIds = new Set(progress.map((f) => f.segmentId));
  // Expected both progress frames to share one segmentId
  expect(segmentIds.size).toEqual(1);
  expect(progress[0]!.accumulatedText).toEqual("Hi");
  expect(progress[0]!.remainingText).toEqual(" there.");
  expect(progress[1]!.accumulatedText).toEqual("Hi there.");
  expect(progress[1]!.remainingText).toEqual("");

  // --- The anchor: one SENTENCE AggregatedTextFrame, willBeSpoken, matching id ---
  const sentenceFrames = sentenceAnchors(down);
  expect(sentenceFrames).toHaveLength(1);
  expect(sentenceFrames[0]!.text).toEqual("Hi there.");
  expect(sentenceFrames[0]!.willBeSpoken).toBeTruthy();
  expect(sentenceFrames[0]!.id).toEqual([...segmentIds][0]!);

  // --- Assistant context assembled from the word frames keeps correct spacing ---
  expect(assembleContext(contextWordFrames(down))).toEqual("Hi there.");
});

test("test_token_mode_coarse_chunk_straddling_sentence_boundary", async () => {
  // A coarse TOKEN-mode chunk spanning a sentence boundary is grouped correctly.
  //
  // Token streams are not always one word per frame: an upstream can deliver a
  // chunk that carries the tail of one sentence and the head of the next (here
  // "Hey" then " there! I'm here."). The sequencer must slice the boundary inside
  // that chunk so the first sentence anchor is the whole "Hey there!" — not a bare
  // "Hey" with " there!" wrongly folded into the next sentence.
  const tts = new _MockTokenStreamingWSTTSService({
    wordTimesPerCall: [
      [["Hey", 0.0]],
      [
        ["there!", 0.2],
        ["I'm", 0.4],
        ["here.", 0.6],
      ],
    ],
    textAggregationMode: TextAggregationMode.TOKEN,
  });
  const framesToSend = [
    new LLMFullResponseStartFrame(),
    new TextFrame({ text: "Hey" }),
    new TextFrame({ text: " there! I'm here." }),
    new LLMFullResponseEndFrame(),
  ];
  const framesReceived = await runTest(tts, { framesToSend });
  const down = framesReceived[0];

  // --- Two sentence anchors, sliced at the boundary inside the coarse chunk ---
  const sentenceFrames = sentenceAnchors(down);
  expect(sentenceFrames.map((f) => f.text)).toEqual(["Hey there!", " I'm here."]);
  expect(sentenceFrames.every((f) => f.willBeSpoken)).toBe(true);

  // --- Progress for the first sentence grows across its whole span ---
  const firstId = sentenceFrames[0]!.id;
  const firstProgress = progressFrames(down).filter((f) => f.segmentId === firstId);
  expect(firstProgress.map((f) => f.accumulatedText)).toEqual(["Hey", "Hey there!"]);

  // --- Assistant context keeps spaces across the whole response ---
  expect(assembleContext(contextWordFrames(down))).toEqual("Hey there! I'm here.");
});

test("test_isolated_tts_speak_frame_finalizes_in_token_mode", async () => {
  // A lone TTSSpeakFrame in TOKEN mode must still emit its words.
  //
  // A TTSSpeakFrame is a self-contained sentence with no following token to confirm
  // its boundary, so without an explicit finalize its pending sentence would never be
  // promoted and no TTSTextFrame would be emitted.
  const tts = new _MockTokenStreamingWSTTSService({
    wordTimesPerCall: [
      [
        ["hello", 0.0],
        ["world", 0.2],
      ],
    ],
    textAggregationMode: TextAggregationMode.TOKEN,
  });
  const framesReceived = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "hello world", appendToContext: false })],
  });
  const wordFrames = ttsTexts(framesReceived[0]);
  expect(wordFrames.map((f) => f.text)).toEqual(["hello", "world"]);
});

function spokenAnchorsWithText(frames: readonly Frame[], text: string): AggregatedTextFrame[] {
  return frames.filter(
    (f): f is AggregatedTextFrame =>
      f.constructor === AggregatedTextFrame &&
      (f as AggregatedTextFrame).willBeSpoken &&
      (f as AggregatedTextFrame).text === text,
  );
}

test("test_tts_speak_frame_emits_single_anchor_in_token_mode", async () => {
  // A TTSSpeakFrame in TOKEN mode must emit exactly one willBeSpoken anchor.
  //
  // In streaming mode the sequencer regroups tokens into a sentence and emits that
  // sentence as the anchor. The raw srcFrame must not also be pushed, or the
  // listener sees a duplicate "new segment" for the same text.
  const tts = new _MockTokenStreamingWSTTSService({
    wordTimesPerCall: [
      [
        ["hello", 0.0],
        ["world", 0.2],
      ],
    ],
    textAggregationMode: TextAggregationMode.TOKEN,
  });
  const framesReceived = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "hello world", appendToContext: false })],
  });
  const anchors = spokenAnchorsWithText(framesReceived[0], "hello world");
  expect(anchors).toHaveLength(1);
});

function groupByContext(frames: readonly TTSTextFrame[]): Map<string | null, string[]> {
  const byContext = new Map<string | null, string[]>();
  for (const f of frames) {
    const list = byContext.get(f.contextId) ?? [];
    list.push(f.text);
    byContext.set(f.contextId, list);
  }
  return byContext;
}

test("test_concurrent_tts_speak_frames_dont_cross_contaminate", async () => {
  // Two back-to-back TTSSpeakFrames stay in their own contexts.
  //
  // Each utterance opens its own audio context. Completing the first must not truncate
  // or steal words from the second: each context's words are emitted under its own
  // context ID, in order, with nothing crossing over.
  const tts = new _MockTokenStreamingWSTTSService({
    wordTimesPerCall: [
      [
        ["Comment", 0.0],
        ["ça", 0.2],
        ["va", 0.4],
      ],
      [
        ["Bom", 0.0],
        ["jour", 0.2],
      ],
    ],
    textAggregationMode: TextAggregationMode.TOKEN,
  });
  const framesReceived = await runTest(tts, {
    framesToSend: [
      new TTSSpeakFrame({ text: "Comment ça va", appendToContext: false }),
      new TTSSpeakFrame({ text: "Bom jour", appendToContext: false }),
    ],
  });
  const down = framesReceived[0];

  // Each context emits exactly its own words, in order.
  const byContext = groupByContext(ttsTexts(down));
  expect([...byContext.values()]).toEqual([
    ["Comment", "ça", "va"],
    ["Bom", "jour"],
  ]);
  // Two distinct contexts, no cross-contamination.
  expect(byContext.size).toEqual(2);
});

test("test_token_mode_push_text_frames_groups_into_sentences", async () => {
  // TOKEN mode + pushTextFrames=true must track whole sentences, not tokens.
  //
  // Regression: a pushTextFrames=true (no word-timestamp) service in TOKEN mode
  // used to register one spoken slot per token and never emit a willBeSpoken
  // "new segment" anchor at all (only non-streaming and tracker-based streaming went
  // through sentence promotion). Two tokens are streamed individually here but must
  // be tracked, anchored, and completed as one sentence.
  const tts = new _MockTokenStreamingPushTextWSTTSService({
    textAggregationMode: TextAggregationMode.TOKEN,
  });
  const framesToSend = [
    new LLMFullResponseStartFrame(),
    new TextFrame({ text: "Hi" }),
    new TextFrame({ text: " there." }),
    new LLMFullResponseEndFrame(),
  ];
  const framesReceived = await runTest(tts, { framesToSend });
  const down = framesReceived[0];

  // --- One SENTENCE anchor for the whole response, not one per token ---
  const sentenceFrames = sentenceAnchors(down);
  expect(sentenceFrames.map((f) => f.text)).toEqual(["Hi there."]);
  expect(sentenceFrames[0]!.willBeSpoken).toBeTruthy();
  expect(sentenceFrames[0]!.appendToContext).toBeFalsy();

  // --- One TTSTextFrame carrying the whole sentence into the context ---
  const contextFrames = contextWordFrames(down);
  expect(contextFrames.map((f) => f.text)).toEqual(["Hi there."]);
  expect(contextFrames[0]!.willBeSpoken).toBeTruthy();
});

test("test_token_mode_push_text_frames_speak_frame_emits_single_anchor", async () => {
  // A TTSSpeakFrame in TOKEN mode + pushTextFrames=true emits exactly one anchor.
  //
  // Mirrors test_tts_speak_frame_emits_single_anchor_in_token_mode for the
  // pushTextFrames=true (no word-timestamp) path.
  const tts = new _MockTokenStreamingPushTextWSTTSService({
    textAggregationMode: TextAggregationMode.TOKEN,
  });
  const framesReceived = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "hello world", appendToContext: false })],
  });
  const down = framesReceived[0];
  const anchors = spokenAnchorsWithText(down, "hello world");
  expect(anchors).toHaveLength(1);
  const contextFrames = ttsTexts(down).filter((f) => f.text === "hello world");
  // Expected exactly one whole-utterance TTSTextFrame
  expect(contextFrames).toHaveLength(1);
});

test("test_token_mode_push_text_frames_concurrent_speak_frames_dont_cross_contaminate", async () => {
  // Two back-to-back TTSSpeakFrames stay in their own contexts (pushTextFrames=true).
  //
  // Mirrors test_concurrent_tts_speak_frames_dont_cross_contaminate for the
  // pushTextFrames=true (no word-timestamp) path.
  const tts = new _MockTokenStreamingPushTextWSTTSService({
    textAggregationMode: TextAggregationMode.TOKEN,
  });
  const framesReceived = await runTest(tts, {
    framesToSend: [
      new TTSSpeakFrame({ text: "Comment ça va", appendToContext: false }),
      new TTSSpeakFrame({ text: "Bom jour", appendToContext: false }),
    ],
  });
  const down = framesReceived[0];

  const byContext = groupByContext(ttsTexts(down));
  // Each utterance must stay a single whole-sentence frame in its own context
  expect([...byContext.values()]).toEqual([["Comment ça va"], ["Bom jour"]]);
  expect(byContext.size).toEqual(2);
});

test("test_aggregated_anchor_pts_precedes_its_progress_per_context", async () => {
  // Each context's "new segment" anchor must sort before its own progress frames.
  //
  // On a word-timestamp service the per-word AggregatedTextProgressFrames carry a PTS
  // (clock queue). The anchor AggregatedTextFrame (willBeSpoken) must be stamped with
  // a PTS no later than its first progress frame, so at the transport it rides the same
  // clock queue and is delivered before the progress that references its segmentId —
  // even when a second context's audio is delayed behind the first.
  //
  // Regression: previously the anchor had pts=null (audio/sync queue), letting a
  // later context's clock-queued progress overtake its own anchor.
  const tts = new _MockPerCallWordTimestampWSTTSService({
    wordTimesPerCall: [
      [
        ["Comment", 0.0],
        ["ca", 0.2],
        ["va", 0.4],
      ],
      [
        ["Bom", 0.0],
        ["jour", 0.2],
      ],
    ],
  });
  const framesReceived = await runTest(tts, {
    framesToSend: [
      new TTSSpeakFrame({ text: "Comment ca va", appendToContext: false }),
      new TTSSpeakFrame({ text: "Bom jour", appendToContext: false }),
    ],
  });
  const down = framesReceived[0];

  const anchors = down.filter(
    (f): f is AggregatedTextFrame =>
      f.constructor === AggregatedTextFrame && (f as AggregatedTextFrame).willBeSpoken,
  );
  const progress = progressFrames(down);
  // Expected one anchor per context
  expect(anchors).toHaveLength(2);

  for (const anchor of anchors) {
    // The anchor must carry a PTS so it rides the clock queue with its progress.
    assert(anchor.pts !== null, `Anchor '${anchor.text}' must have a PTS`);
    const segProgress = progress.filter((p) => p.segmentId === anchor.id);
    assert(segProgress.length > 0, `No progress frames found for anchor '${anchor.text}'`);
    const firstProgressPts = Math.min(...segProgress.map((p) => p.pts as number));
    assert(
      anchor.pts <= firstProgressPts,
      `Anchor '${anchor.text}' pts ${anchor.pts} must be <= its first progress pts ` +
        `${firstProgressPts} so it is delivered before its own progress`,
    );
  }
});

function setTextAggregator(tts: TTSService, aggregator: SkipTagsAggregator): void {
  (tts as unknown as { _textAggregator: SkipTagsAggregator })._textAggregator = aggregator;
}

test("test_sentence_inline_tts_markup_tracks_word_by_word", async () => {
  // A synthesis tag inline in the source text must not cost the sentence its
  // word-level tracking.
  //
  // Only the tagged span is unalignable — the TTS reports "1234." for it, so it can
  // only be committed whole. The words around it are byte-identical on both sides
  // and must still advance progress one at a time.
  const tts = new _MockPerCallWordTimestampWSTTSService({
    // One runTts call carries the whole sentence, so all of its words arrive
    // from this single word-time list.
    // Cartesia echoes the tag block as one token; the service strips it to "1234.".
    wordTimesPerCall: [
      [
        ["I", 0.0],
        ["love", 0.2],
        ["to", 0.4],
        ["count", 0.6],
        ["1234.", 0.8],
      ],
    ],
    textAggregationMode: TextAggregationMode.SENTENCE,
  });
  setTextAggregator(
    tts,
    new SkipTagsAggregator({
      tags: [["<spell>", "</spell>"]],
      aggregationType: TextAggregationMode.SENTENCE,
    }),
  );
  const framesReceived = await runTest(tts, {
    framesToSend: [
      new LLMFullResponseStartFrame(),
      new TextFrame({ text: "I" }),
      new TextFrame({ text: " love" }),
      new TextFrame({ text: " to count <spell>" }),
      new TextFrame({ text: "1234</spell>." }),
      new LLMFullResponseEndFrame(),
    ],
  });
  const down = framesReceived[0];
  const sentence = "I love to count <spell>1234</spell>.";

  const progress = progressFrames(down);
  expect(progress.map((f) => f.accumulatedText)).toEqual([
    "I",
    "I love",
    "I love to",
    "I love to count",
    sentence,
  ]);

  const anchors = down.filter(
    (f): f is AggregatedTextFrame =>
      f.constructor === AggregatedTextFrame && (f as AggregatedTextFrame).willBeSpoken,
  );
  expect(anchors).toHaveLength(1);
  expect(anchors[0]!.text).toEqual(sentence);

  const wordFrames = ttsTexts(down);
  expect(wordFrames.map((f) => f.text)).toEqual(["I", "love", "to", "count", "1234."]);
  // only the tagged span is atomic, so every word reaches the context
  expect(wordFrames.map((f) => [f.text, f.appendToContext])).toEqual(
    wordFrames.map((f) => [f.text, true]),
  );
  // the word completing the tagged span must commit it with its tag
  expect(wordFrames[wordFrames.length - 1]!.rawText).toEqual("<spell>1234</spell>.");
});

test("test_token_inline_tts_markup_tracks_word_by_word", async () => {
  // TOKEN-mode counterpart of test_sentence_inline_tts_markup_tracks_word_by_word.
  //
  // The sentence reaches the TTS as three separate tokens here, the tagged span
  // among them, and the sequencer regroups them into one sentence before tracking
  // it. The result must match SENTENCE mode: only the tagged span is committed
  // whole, every other word advancing progress on its own.
  const tts = new _MockTokenStreamingWSTTSService({
    // One runTts call per token, each with its own word-time list.
    // Cartesia echoes the tag block as one token; the service strips it to "1234.".
    wordTimesPerCall: [
      [["I", 0.0]],
      [["love", 0.2]],
      [
        ["to", 0.4],
        ["count", 0.6],
        ["1234.", 0.8],
      ],
    ],
    textAggregationMode: TextAggregationMode.TOKEN,
  });
  setTextAggregator(
    tts,
    new SkipTagsAggregator({
      tags: [["<spell>", "</spell>"]],
      aggregationType: TextAggregationMode.TOKEN,
    }),
  );
  const framesReceived = await runTest(tts, {
    framesToSend: [
      new LLMFullResponseStartFrame(),
      new TextFrame({ text: "I" }),
      new TextFrame({ text: " love" }),
      new TextFrame({ text: " to count <spell>" }),
      new TextFrame({ text: "1234</spell>." }),
      new LLMFullResponseEndFrame(),
    ],
  });
  const down = framesReceived[0];
  const sentence = "I love to count <spell>1234</spell>.";

  const progress = progressFrames(down);
  expect(progress.map((f) => f.accumulatedText)).toEqual([
    "I",
    "I love",
    "I love to",
    "I love to count",
    sentence,
  ]);
  expect(progress.map((f) => f.remainingText).at(-1)).toEqual("");

  // The tokens are regrouped into a single sentence, so they announce one segment
  // rather than one per token.
  const anchors = down.filter(
    (f): f is AggregatedTextFrame =>
      f.constructor === AggregatedTextFrame && (f as AggregatedTextFrame).willBeSpoken,
  );
  expect(anchors).toHaveLength(1);
  expect(anchors[0]!.text).toEqual(sentence);
  expect(progress.every((f) => f.segmentId === anchors[0]!.id)).toBe(true);

  const wordFrames = ttsTexts(down);
  expect(wordFrames.map((f) => f.text)).toEqual(["I", "love", "to", "count", "1234."]);
  // only the tagged span is atomic, so every word reaches the context
  expect(wordFrames.map((f) => [f.text, f.appendToContext])).toEqual(
    wordFrames.map((f) => [f.text, true]),
  );
  // the word completing the tagged span must commit it with its tag
  expect(wordFrames[wordFrames.length - 1]!.rawText).toEqual("<spell>1234</spell>.");
});

for (const mode of [TextAggregationMode.SENTENCE, TextAggregationMode.TOKEN]) {
  test(`test_tts_speak_frame_labels_its_text[${mode}]`, async () => {
    // The text frames pushed for a TTSSpeakFrame carry its aggregation type.
    const tts = new MockHttpPushTextTTSService({ textAggregationMode: mode });
    const framesReceived = await runTest(tts, {
      framesToSend: [
        new TTSSpeakFrame({
          text: "One moment, please.",
          appendToContext: false,
          textType: "status",
        }),
      ],
    });
    const textFrames = framesReceived[0].filter(
      (f): f is AggregatedTextFrame => f instanceof AggregatedTextFrame,
    );

    expect(textFrames.length).toBeGreaterThan(0);
    expect([...new Set(textFrames.map((f) => f.textType))]).toEqual(["status"]);
  });
}

for (const mode of [TextAggregationMode.SENTENCE, TextAggregationMode.TOKEN]) {
  test(`test_spoken_text_carries_the_id_of_its_segment[${mode}]`, async () => {
    // A TTSTextFrame names the AggregatedTextFrame it speaks.
    const tts = new MockHttpPushTextTTSService({ textAggregationMode: mode });
    const framesReceived = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "One moment, please.", appendToContext: false })],
    });
    const segment = framesReceived[0].find((f) => f.constructor === AggregatedTextFrame)!;
    const spoken = framesReceived[0].find((f): f is TTSTextFrame => f instanceof TTSTextFrame)!;

    expect(spoken.segmentId).toEqual(segment.id);
  });
}

for (const mode of [TextAggregationMode.SENTENCE, TextAggregationMode.TOKEN]) {
  test(`test_bot_backchannel_frame_is_spoken_as_an_uninterruptible_backchannel[${mode}]`, async () => {
    // A BotBackchannelFrame is spoken as backchannel text, kept out of the context.
    const tts = new MockHttpPushTextTTSService({ textAggregationMode: mode });
    const framesReceived = await runTest(tts, {
      framesToSend: [new BotBackchannelFrame({ text: "Mm-hmm." })],
    });
    const textFrames = framesReceived[0].filter(
      (f): f is AggregatedTextFrame => f instanceof AggregatedTextFrame,
    );

    expect(textFrames.length).toBeGreaterThan(0);
    expect([...new Set(textFrames.map((f) => f.textType))]).toEqual([TextType.BACKCHANNEL]);
    expect(textFrames.some((f) => f.interruptible || f.appendToContext)).toBe(false);
  });
}

for (const delivery of ["http", "websocket", "words", "tokens"] as const) {
  test(`test_uninterruptible_speech_survives_before_audio[${delivery}]`, async () => {
    // An uninterruptible request finishes synthesis across VAD and turn interruptions.
    const words = delivery === "words" || delivery === "tokens";

    class DelayedTTS extends TTSService {
      release = new Event();
      interrupted: string[] = [];

      constructor() {
        super({
          pushStartFrame: true,
          pushStopFrames: true,
          pushTextFrames: !words,
          sampleRate: _SAMPLE_RATE,
          textAggregationMode:
            delivery === "tokens" ? TextAggregationMode.TOKEN : TextAggregationMode.SENTENCE,
        });
      }

      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        if (frame instanceof InterruptionFrame) {
          this.release.set();
        }
      }

      override async onAudioContextInterrupted(contextId: string): Promise<void> {
        this.interrupted.push(contextId);
      }

      override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
        const deliver = async () => {
          await this.release.wait();
          if (words) {
            await this.addWordTimestamps([[text, 0.0]], contextId);
          }
          await this.appendToAudioContext(contextId, fakeAudio(contextId));
          await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
          await this.removeAudioContext(contextId);
        };

        if (delivery === "http") {
          await this.release.wait();
          yield fakeAudio(contextId);
        } else {
          this.createTask(() => deliver());
          yield null;
        }
      }
    }

    const tts = new DelayedTTS();
    const speech = new TTSSpeakFrame({ text: "Mm-hmm.", appendToContext: false });
    speech.interruptible = false;
    const [down] = await waitFor(
      () =>
        runTest(tts, {
          framesToSend: [
            speech,
            new SleepFrame({ sleep: 0.05 }),
            new VADUserStartedSpeakingFrame(),
            new InterruptionFrame(),
            new SleepFrame({ sleep: 0.1 }),
            new TTSSpeakFrame({ text: "Next reply." }),
            new SleepFrame({ sleep: 0.1 }),
          ],
        }),
      5,
    );
    const texts = ttsTexts(down);
    expect(texts.map((f) => f.text)).toEqual(["Mm-hmm.", "Next reply."]);
    expect(texts.map((f) => f.interruptible)).toEqual([false, true]);
    for (const frameType of [TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame]) {
      expect(down.filter((f) => f instanceof frameType).map((f) => f.interruptible)).toEqual([
        false,
        true,
      ]);
    }
    expect(tts.interrupted).toEqual([]);
  });
}

test("test_queued_uninterruptible_synthesis_survives_an_interrupted_context", async () => {
  // A queued uninterruptible context survives while the preceding regular one is dropped.

  class QueuedTTS extends TTSService {
    release = new Event();
    interrupted: string[] = [];
    requests: Record<string, string> = {};

    constructor() {
      super({ pushStartFrame: true, pushTextFrames: true, sampleRate: _SAMPLE_RATE });
    }

    override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
      await super.processFrame(frame, direction);
      if (frame instanceof InterruptionFrame) {
        this.release.set();
      }
    }

    override async onAudioContextInterrupted(contextId: string): Promise<void> {
      this.interrupted.push(contextId);
    }

    override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
      this.requests[text] = contextId;

      const deliver = async () => {
        await this.release.wait();
        if (!this.audioContextAvailable(contextId)) {
          return;
        }
        await this.appendToAudioContext(contextId, fakeAudio(contextId));
        await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
        await this.removeAudioContext(contextId);
      };

      this.createTask(() => deliver());
      yield null;
    }
  }

  const tts = new QueuedTTS();
  const speech = new TTSSpeakFrame({ text: "Keep this." });
  speech.interruptible = false;
  const [down] = await waitFor(
    () =>
      runTest(tts, {
        framesToSend: [
          new TTSSpeakFrame({ text: "Drop this." }),
          speech,
          new SleepFrame({ sleep: 0.05 }),
          new InterruptionFrame(),
          new SleepFrame({ sleep: 0.1 }),
        ],
      }),
    5,
  );
  expect(tts.interrupted).toEqual([tts.requests["Drop this."]!]);
  const audio = down.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
  expect(audio).toHaveLength(1);
  expect(audio[0]!.contextId).toEqual(tts.requests["Keep this."]!);
  expect(audio[0]!.interruptible).toBe(false);
  expect(down.some((f) => f instanceof TTSTextFrame && f.text === "Keep this.")).toBe(true);
});

test("test_words_after_an_interruption_follow_uninterruptible_words_still_to_play", async () => {
  // Uninterruptible words outlive their synthesis, so the next words are timed after them.
  const tts = new _MockPerCallWordTimestampWSTTSService({
    wordTimesPerCall: [
      [
        ["Keep", 0.0],
        ["this.", 5.0],
      ],
      [["Next.", 0.0]],
    ],
  });
  const speech = new TTSSpeakFrame({ text: "Keep this.", appendToContext: false });
  speech.interruptible = false;
  const [down] = await waitFor(
    () =>
      runTest(tts, {
        framesToSend: [
          speech,
          // Synthesis finishes long before "this." plays.
          new SleepFrame({ sleep: 0.1 }),
          new InterruptionFrame(),
          new SleepFrame({ sleep: 0.05 }),
          new TTSSpeakFrame({ text: "Next.", appendToContext: false }),
          new SleepFrame({ sleep: 0.1 }),
        ],
      }),
    5,
  );
  const texts = ttsTexts(down);
  expect(texts.map((f) => f.text)).toEqual(["Keep", "this.", "Next."]);
  expect(texts[2]!.pts as number).toBeGreaterThanOrEqual(texts[1]!.pts as number);
});

/**
 * Labels audio with the active context and never ends one (e.g. FishAudioTTSService).
 *
 * Contexts end with the stop-frame timeout, a while after their audio arrives.
 */
class _MockActiveContextTTSService extends TTSService {
  constructor() {
    super({
      pushStartFrame: true,
      pushStopFrames: true,
      stopFrameTimeoutS: 0.2,
      pauseFrameProcessing: true,
      sampleRate: _SAMPLE_RATE,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, _contextId: string): AsyncGenerator<Frame | null, void> {
    const activeContextId = this.getActiveAudioContextId();

    const deliver = async () => {
      await this.appendToAudioContext(activeContextId, fakeAudio(activeContextId));
    };

    this.createTask(() => deliver());
    yield null;
  }
}

test("test_reply_after_uninterruptible_speech_waits_for_its_context_to_end", async () => {
  // The bot stops before uninterruptible speech ends, and the reply stays interruptible.
  const speech = new TTSSpeakFrame({ text: "Keep this.", appendToContext: false });
  speech.interruptible = false;
  const [down] = await waitFor(
    () =>
      runTest(new _MockActiveContextTTSService(), {
        framesToSend: [
          speech,
          new SleepFrame({ sleep: 0.05 }),
          new BotStartedSpeakingFrame(),
          new BotStoppedSpeakingFrame(),
          new LLMFullResponseStartFrame(),
          new TextFrame({ text: "Hello there." }),
          new LLMFullResponseEndFrame(),
          new SleepFrame({ sleep: 0.4 }),
          new BotStoppedSpeakingFrame(),
        ],
      }),
    5,
  );
  const audio = down.filter((f) => f instanceof TTSAudioRawFrame);
  expect(audio.map((f) => f.interruptible)).toEqual([false, true]);
});

test("test_interruption_keeps_the_pause_while_uninterruptible_speech_is_open", async () => {
  // An interruption doesn't let the reply start before uninterruptible speech ends.
  const speech = new TTSSpeakFrame({ text: "Keep this.", appendToContext: false });
  speech.interruptible = false;
  const [down] = await waitFor(
    () =>
      runTest(new _MockActiveContextTTSService(), {
        framesToSend: [
          speech,
          new SleepFrame({ sleep: 0.05 }),
          new BotStartedSpeakingFrame(),
          new InterruptionFrame(),
          new LLMFullResponseStartFrame(),
          new TextFrame({ text: "Hello there." }),
          new LLMFullResponseEndFrame(),
          new SleepFrame({ sleep: 0.4 }),
          new BotStoppedSpeakingFrame(),
        ],
      }),
    5,
  );
  const audio = down.filter((f) => f instanceof TTSAudioRawFrame);
  expect(audio.map((f) => f.interruptible)).toEqual([false, true]);
});

test("test_next_request_waits_for_open_contexts_to_end", async () => {
  // Back-to-back replies each get their own audio, though the bot stops between them.
  const [down, up] = await waitFor(
    () =>
      runTest(new _MockActiveContextTTSService(), {
        framesToSend: [
          new TTSSpeakFrame({ text: "One.", appendToContext: false }),
          new SleepFrame({ sleep: 0.05 }),
          new BotStartedSpeakingFrame(),
          new BotStoppedSpeakingFrame(),
          new TTSSpeakFrame({ text: "Two.", appendToContext: false }),
          new SleepFrame({ sleep: 0.6 }),
        ],
      }),
    5,
  );
  const audio = down.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
  expect(new Set(audio.map((f) => f.contextId)).size).toEqual(2);
  expect([...down, ...up].some((f) => f instanceof ErrorFrame)).toBe(false);
});

/** Sends audio without word timestamps and never ends its contexts, so they go quiet. */
class _MockUntimedWordsTTSService extends TTSService {
  constructor() {
    super({
      pushStartFrame: true,
      pushTextFrames: false,
      pushStopFrames: true,
      stopFrameTimeoutS: 0.1,
      sampleRate: _SAMPLE_RATE,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    await this.appendToAudioContext(contextId, fakeAudio(contextId));
    yield null;
  }
}

test("test_untimed_words_come_before_the_stop_frame_of_a_quiet_context", async () => {
  // Text the provider never timed is pushed before the context's stop frame.
  const [down] = await waitFor(
    () =>
      runTest(new _MockUntimedWordsTTSService(), {
        framesToSend: [new TTSSpeakFrame({ text: "Hello there." }), new SleepFrame({ sleep: 0.4 })],
      }),
    5,
  );
  const order = down
    .filter((f) => isAny(f, [TTSTextFrame, LLMAssistantPushAggregationFrame, TTSStoppedFrame]))
    .map((f) => f.constructor);
  expect(order).toEqual([TTSTextFrame, LLMAssistantPushAggregationFrame, TTSStoppedFrame]);
});

/** Labels audio with its request's context and ends a context when it is flushed. */
class _MockFlushedContextTTSService extends TTSService {
  constructor() {
    super({
      pushStartFrame: true,
      stopFrameTimeoutS: 1.0,
      pauseFrameProcessing: true,
      sampleRate: _SAMPLE_RATE,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    await this.appendToAudioContext(contextId, fakeAudio(contextId));
    yield null;
  }

  override async flushAudio(contextId: string | null = null): Promise<void> {
    await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
    await this.removeAudioContext(contextId);
  }
}

test("test_speak_frame_in_the_middle_of_a_reply_does_not_hold_the_reply", async () => {
  // The reply goes on after a TTSSpeakFrame, and each context ends with its own stop frame.
  const [down] = await waitFor(
    () =>
      runTest(new _MockFlushedContextTTSService(), {
        framesToSend: [
          new LLMFullResponseStartFrame(),
          new AggregatedTextFrame({ text: "Sure, checking.", textType: TextType.SENTENCE }),
          new TTSSpeakFrame({ text: "Let me check.", appendToContext: false }),
          new AggregatedTextFrame({ text: "One moment.", textType: TextType.SENTENCE }),
          new LLMFullResponseEndFrame(),
          new SleepFrame({ sleep: 0.2 }),
        ],
      }),
    5,
  );
  const audio = down.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
  const stopped = down.filter((f): f is TTSStoppedFrame => f instanceof TTSStoppedFrame);
  const replyContextId = audio[0]!.contextId;
  expect(audio.map((f) => f.contextId === replyContextId)).toEqual([true, true, false]);
  expect(new Set(stopped.map((f) => f.contextId)).size).toEqual(2);
  expect(down.filter((f) => f instanceof LLMFullResponseEndFrame)).toHaveLength(1);
});

test("test_speak_frame_after_a_reply_commits_its_text", async () => {
  // A TTSSpeakFrame after an LLM reply pushes its own assistant aggregation.
  const [down] = await waitFor(
    () =>
      runTest(new _MockFlushedContextTTSService(), {
        framesToSend: [
          new LLMFullResponseStartFrame(),
          new AggregatedTextFrame({ text: "Hello there.", textType: TextType.SENTENCE }),
          new LLMFullResponseEndFrame(),
          new SleepFrame({ sleep: 0.1 }),
          new TTSSpeakFrame({ text: "Welcome." }),
          new SleepFrame({ sleep: 0.2 }),
        ],
      }),
    5,
  );
  const order = down
    .filter((f) =>
      isAny(f, [TTSTextFrame, LLMFullResponseEndFrame, LLMAssistantPushAggregationFrame]),
    )
    .map((f) => f.constructor);
  expect(order).toEqual([
    TTSTextFrame,
    LLMFullResponseEndFrame,
    TTSTextFrame,
    LLMAssistantPushAggregationFrame,
  ]);
});

for (const reuseContextIdWithinTurn of [true, false]) {
  test(`test_llm_response_end_follows_the_last_word[${reuseContextIdWithinTurn ? "True" : "False"}]`, async () => {
    // With word timestamps, the turn's own end frame comes after its words, at their PTS.
    const endFrame = new LLMFullResponseEndFrame();
    const [down] = await waitFor(
      () =>
        runTest(new _MockWordTimestampWSTTSService({ reuseContextIdWithinTurn }), {
          framesToSend: [
            new LLMFullResponseStartFrame(),
            new TextFrame({ text: "Hello there." }),
            endFrame,
            new SleepFrame({ sleep: 0.2 }),
          ],
        }),
      5,
    );
    const frames = down.filter((f) => isAny(f, [TTSTextFrame, LLMFullResponseEndFrame]));
    expect(frames.map((f) => f.constructor)).toEqual([
      TTSTextFrame,
      TTSTextFrame,
      LLMFullResponseEndFrame,
    ]);
    expect(frames[frames.length - 1]).toBe(endFrame);
    expect(endFrame.pts).toEqual(frames[frames.length - 2]!.pts);
  });
}

test("test_llm_response_end_of_a_reply_without_text_is_pushed", async () => {
  // With word timestamps, a reply with nothing to speak still pushes its end frame.
  const endFrame = new LLMFullResponseEndFrame();
  const [down] = await waitFor(
    () =>
      runTest(new _MockWordTimestampWSTTSService(), {
        framesToSend: [new LLMFullResponseStartFrame(), endFrame, new SleepFrame({ sleep: 0.2 })],
      }),
    5,
  );
  expect(down).toContain(endFrame);
});

for (const reuseContextIdWithinTurn of [true, false]) {
  test(`test_speak_frame_settings_reach_its_spoken_context[${reuseContextIdWithinTurn ? "True" : "False"}]`, async () => {
    // A TTSSpeakFrame's appendToContext, and its aggregation push, apply to its speech.
    const [down] = await runTest(
      new _MockWordTimestampHttpTTSService({ reuseContextIdWithinTurn }),
      {
        framesToSend: [
          new TTSSpeakFrame({ text: "secret note", appendToContext: false }),
          new TTSSpeakFrame({ text: "hello there" }),
        ],
      },
    );
    const started = down.filter((f): f is TTSStartedFrame => f instanceof TTSStartedFrame);
    expect(started.map((f) => f.appendToContext)).toEqual([false, true]);
    const words: Record<string, boolean> = {};
    for (const f of ttsTexts(down)) words[f.text] = f.appendToContext;
    expect(words).toEqual({ secret: false, note: false, hello: true, there: true });
    // Only the speak frame that goes into the context commits it once spoken.
    expect(down.filter((f) => f instanceof LLMAssistantPushAggregationFrame)).toHaveLength(1);
  });
}

test("test_llm_response_end_of_a_reply_without_timed_words_has_no_pts", async () => {
  // A reply that times no words leaves its end frame unstamped, behind its start frame.
  const firstEnd = new LLMFullResponseEndFrame();
  const secondEnd = new LLMFullResponseEndFrame();
  const [down] = await runTest(new _MockWordTimestampHttpTTSService({ skipTextTypes: ["code"] }), {
    framesToSend: [
      new LLMFullResponseStartFrame(),
      new TextFrame({ text: "hello world." }),
      firstEnd,
      new SleepFrame({ sleep: 0.2 }),
      new LLMFullResponseStartFrame(),
      new AggregatedTextFrame({ text: "some code", textType: "code" }),
      secondEnd,
      new SleepFrame({ sleep: 0.2 }),
    ],
  });
  const words = ttsTexts(down);
  expect(firstEnd.pts).toEqual(words[words.length - 1]!.pts);
  expect(secondEnd.pts).toBeFalsy();
});
