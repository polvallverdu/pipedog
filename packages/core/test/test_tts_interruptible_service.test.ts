// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_tts_interruptible_service.py

/**
 * Tests for InterruptibleTTSService's reconnect-on-interruption tracking.
 *
 * InterruptibleTTSService reconnects its websocket on interruption if the bot
 * was speaking (or about to start speaking) for the turn being interrupted. It
 * tracks this with two flags:
 *
 * - `_botSpeaking`: true only once BotStartedSpeakingFrame confirms the output
 *   transport actually received audio (see test_no_error_on_long_streaming_turn
 *   and test_no_deadlock_on_zero_audio_context_completion in
 *   test_tts_frame_ordering).
 * - `_ttsStarted` (InterruptibleTTSService only): true from the moment runTts
 *   is invoked (TTSStartedFrame pushed) until consumed by an interruption, or
 *   cleared by BotStoppedSpeakingFrame (turn ended normally) or a following
 *   LLMFullResponseStartFrame (safety net for a turn that never got a
 *   BotStoppedSpeakingFrame at all), covering the narrow window before
 *   BotStartedSpeakingFrame confirmation arrives.
 *
 * These are deliberately separate: folding _ttsStarted's early, unconfirmed
 * signal into _botSpeaking would let a turn that produces zero audio look
 * "confirmed".
 */

import { expect, spyOn, test } from "bun:test";

import { Queue, sleep, type Task, waitFor } from "@pipedog/asyncio";

import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  DataFrame,
  type Frame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  type StartFrame,
  TextFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
} from "../src/frames/frames.ts";
import { FrameDirection } from "../src/processors/frame_processor.ts";
import {
  InterruptibleTTSService,
  type InterruptibleTTSServiceOptions,
  TTSService,
} from "../src/services/tts_service.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";

const _SAMPLE_RATE = 16000;

interface MarkerFrameOptions {
  label?: string;
}

/** Marks how far downstream processing has got. */
class MarkerFrame extends DataFrame {
  label: string;

  constructor(options: MarkerFrameOptions = {}) {
    super(options);
    this.label = options.label ?? "";
  }
}

/**
 * Minimal concrete InterruptibleTTSService for testing reconnect tracking.
 *
 * Never actually opens a websocket; _connect/_disconnect are patched or
 * spied on in individual tests instead.
 */
class FakeInterruptibleTTSService extends InterruptibleTTSService {
  constructor(options: InterruptibleTTSServiceOptions = {}) {
    super({
      pushStartFrame: true,
      pushTextFrames: false,
      sampleRate: _SAMPLE_RATE,
      ...options,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async _connectWebsocket(): Promise<void> {}

  override async _disconnectWebsocket(): Promise<void> {}

  override async _receiveMessages(): Promise<void> {}

  override async *runTts(_text: string, _contextId: string): AsyncGenerator<Frame | null, void> {}
}

/** Access to the service's protected state, as the Python tests do. */
interface Internals {
  _botSpeaking: boolean;
  _ttsStarted: boolean;
  _connect: () => Promise<void>;
  _disconnect: () => Promise<void>;
  _handleInterruption: (frame: InterruptionFrame, direction: FrameDirection) => Promise<void>;
}

function internals(tts: InterruptibleTTSService): Internals {
  return tts as unknown as Internals;
}

/** `patch.object(TTSService, "_handle_interruption", new=AsyncMock())`. */
async function withPatchedBaseInterruption(fn: () => Promise<void>): Promise<void> {
  const proto = TTSService.prototype as unknown as Internals;
  const spy = spyOn(proto, "_handleInterruption").mockImplementation(async () => {});
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
}

test("test_reconnects_when_bot_confirmed_speaking", async () => {
  // BotStartedSpeakingFrame confirms speech; interrupting must reconnect.
  const tts = new FakeInterruptibleTTSService();
  const t = internals(tts);

  const reconnected = { disconnect: false, connect: false };

  t._disconnect = async () => {
    reconnected.disconnect = true;
  };
  t._connect = async () => {
    reconnected.connect = true;
  };

  await tts.processFrame(new BotStartedSpeakingFrame(), FrameDirection.DOWNSTREAM);
  expect(t._botSpeaking).toBe(true);
  expect(t._ttsStarted).toBe(false);

  await withPatchedBaseInterruption(async () => {
    await t._handleInterruption(new InterruptionFrame(), FrameDirection.DOWNSTREAM);
  });

  expect(reconnected).toEqual({ disconnect: true, connect: true });
});

test("test_reconnects_when_started_but_not_yet_confirmed", async () => {
  // runTts invoked (TTSStartedFrame) but BotStartedSpeakingFrame hasn't
  // arrived yet — the narrow race window _ttsStarted exists for. Interrupting
  // here must still reconnect, even though _botSpeaking is still false.
  const tts = new FakeInterruptibleTTSService();
  const t = internals(tts);

  const reconnected = { disconnect: false, connect: false };

  t._disconnect = async () => {
    reconnected.disconnect = true;
  };
  t._connect = async () => {
    reconnected.connect = true;
  };

  await tts.pushFrame(new TTSStartedFrame());
  expect(t._ttsStarted).toBe(true);
  expect(t._botSpeaking).toBe(false);

  await withPatchedBaseInterruption(async () => {
    await t._handleInterruption(new InterruptionFrame(), FrameDirection.DOWNSTREAM);
  });

  expect(reconnected).toEqual({ disconnect: true, connect: true });
  // Consumed by the interruption it was needed for.
  expect(t._ttsStarted).toBe(false);
});

test("test_no_reconnect_when_bot_never_spoke", async () => {
  // No TTSStartedFrame or BotStartedSpeakingFrame this turn — interrupting
  // (e.g. the user talking over silence) must not reconnect.
  const tts = new FakeInterruptibleTTSService();
  const t = internals(tts);

  const reconnected = { disconnect: false, connect: false };

  t._disconnect = async () => {
    reconnected.disconnect = true;
  };
  t._connect = async () => {
    reconnected.connect = true;
  };

  await withPatchedBaseInterruption(async () => {
    await t._handleInterruption(new InterruptionFrame(), FrameDirection.DOWNSTREAM);
  });

  expect(reconnected).toEqual({ disconnect: false, connect: false });
});

test("test_tts_started_cleared_on_new_turn", async () => {
  // _ttsStarted must not leak into a new turn.
  //
  // Models a turn that invoked runTts (TTSStartedFrame) but never got a
  // BotStartedSpeakingFrame or BotStoppedSpeakingFrame — a turn that
  // completed with no audio, say — so nothing ever clears _ttsStarted via the
  // normal BotStoppedSpeakingFrame path. Without the LLMFullResponseStartFrame
  // reset, an interruption during the *next* turn (before it has invoked
  // runTts itself) would incorrectly reconnect because of the stale flag.
  const tts = new FakeInterruptibleTTSService();
  const t = internals(tts);

  await tts.pushFrame(new TTSStartedFrame());
  expect(t._ttsStarted).toBe(true);

  // New turn begins without the previous one ever resolving _ttsStarted.
  await tts.processFrame(new LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM);
  expect(t._ttsStarted).toBe(false);

  const reconnected = { disconnect: false, connect: false };

  t._disconnect = async () => {
    reconnected.disconnect = true;
  };
  t._connect = async () => {
    reconnected.connect = true;
  };

  await withPatchedBaseInterruption(async () => {
    await t._handleInterruption(new InterruptionFrame(), FrameDirection.DOWNSTREAM);
  });

  expect(reconnected).toEqual({ disconnect: false, connect: false });
});

test("test_silent_turn_resumes_frame_processing", async () => {
  // A turn that plays nothing must not leave frame processing paused for an
  // InterruptibleTTSService subclass that combines it with
  // pauseFrameProcessing=true (e.g. the deprecated RimeNonJsonTTSService).
  //
  // A context completes (TTSStoppedFrame) with zero TTSAudioRawFrames, and no
  // BotStartedSpeakingFrame/BotStoppedSpeakingFrame ever arrives — as in
  // production, where the output transport never receives audio to react to.
  // Whether the pause is taken at all depends on how long the provider holds
  // the context open, so this asserts only that the pipeline keeps moving.

  class FakeInterruptiblePauseTTSService extends FakeInterruptibleTTSService {
    constructor(options: InterruptibleTTSServiceOptions = {}) {
      super({ pauseFrameProcessing: true, ...options });
    }

    override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
      const _deliverZeroAudioCompletion = async () => {
        await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
        await this.removeAudioContext(contextId);
      };

      this.createTask(_deliverZeroAudioCompletion, `fake_zero_audio_${contextId}`);
    }
  }

  const tts = new FakeInterruptiblePauseTTSService();

  const framesToSend = [
    new LLMFullResponseStartFrame(),
    new TextFrame({ text: "Hello." }),
    new LLMFullResponseEndFrame(),
    new SleepFrame({ sleep: 0.4 }), // let the silent context complete
    new MarkerFrame({ label: "after_silence" }),
  ];

  const [down] = await runTest(tts, { framesToSend });

  const markers = down.filter((f): f is MarkerFrame => f instanceof MarkerFrame);
  // Frame processing stayed paused after a zero-audio completion, meaning
  // TTSStartedFrame's early marker masked both recoveries.
  expect(markers.some((f) => f.label === "after_silence")).toBe(true);
});

test("test_reconnect_flags_track_full_turn_via_process_frame_and_push_frame", async () => {
  // End-to-end sanity check through the public frame-processing API (not
  // direct attribute pokes): a normal turn with confirmed playback reconnects
  // on interruption, and after BotStoppedSpeakingFrame ends the turn cleanly,
  // a later interruption with no new speech does not reconnect.
  const tts = new FakeInterruptibleTTSService();
  const t = internals(tts);

  const calls: string[] = [];

  t._disconnect = async () => {
    calls.push("disconnect");
  };
  t._connect = async () => {
    calls.push("connect");
  };

  await tts.processFrame(new LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM);
  await tts.pushFrame(new TTSStartedFrame());
  await tts.processFrame(new BotStartedSpeakingFrame(), FrameDirection.DOWNSTREAM);
  await tts.processFrame(new BotStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM);

  expect(t._botSpeaking).toBe(false);
  expect(t._ttsStarted).toBe(false);

  await withPatchedBaseInterruption(async () => {
    await t._handleInterruption(new InterruptionFrame(), FrameDirection.DOWNSTREAM);
  });

  // Should not reconnect after a clean, already-finished turn.
  expect(calls).toEqual([]);
});

/**
 * Streams requests in order on one connection and labels audio with the
 * active context.
 *
 * Reconnecting drops the audio still to come (e.g. FishAudioTTSService).
 */
class FakeStreamingInterruptibleTTSService extends FakeInterruptibleTTSService {
  _requests: Queue<string> = new Queue();
  _streamTask: Task<unknown> | null = null;

  constructor() {
    super({ pushStopFrames: true, stopFrameTimeoutS: 0.2, pauseFrameProcessing: true });
  }

  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    await this._connect();
  }

  override async _connect(): Promise<void> {
    await super._connect();
    this._requests = new Queue();
    this._streamTask = this.createTask(() => this._stream());
  }

  override async _disconnect(): Promise<void> {
    await super._disconnect();
    if (this._streamTask) {
      await this.cancelTask(this._streamTask);
      this._streamTask = null;
    }
  }

  async _stream(): Promise<void> {
    while (true) {
      await this._requests.get();
      for (let i = 0; i < 4; i++) {
        await sleep(0.05);
        const contextId = this.getActiveAudioContextId();
        await this.appendToAudioContext(
          contextId,
          new TTSAudioRawFrame({
            audio: new Uint8Array(320),
            sampleRate: _SAMPLE_RATE,
            numChannels: 1,
            contextId,
          }),
        );
      }
    }
  }

  override async *runTts(text: string, _contextId: string): AsyncGenerator<Frame | null, void> {
    await this._requests.put(text);
    yield null;
  }
}

test("test_interrupted_reply_stays_interruptible_behind_uninterruptible_speech", async () => {
  // Uninterruptible speech sent mid-reply doesn't keep the interrupted reply playing.
  const speech = new TTSSpeakFrame({ text: "One moment.", appendToContext: false });
  speech.interruptible = false;
  const [down] = await waitFor(
    runTest(new FakeStreamingInterruptibleTTSService(), {
      framesToSend: [
        new LLMFullResponseStartFrame(),
        new TextFrame({ text: "Hello there. " }),
        new TextFrame({ text: "How" }),
        speech,
        new SleepFrame({ sleep: 0.1 }),
        new BotStartedSpeakingFrame(),
        new SleepFrame({ sleep: 0.05 }),
        new InterruptionFrame(),
        new SleepFrame({ sleep: 0.4 }),
      ],
    }),
    5,
  );
  const audio = down.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
  expect(audio.length).toBeGreaterThan(0);
  expect(audio.every((f) => f.interruptible)).toBe(true);
});
