// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_elevenlabs_dialogue_tts.py

/** Tests for the ElevenLabs Text-to-Dialogue TTS service. */

import { describe, expect, test } from "bun:test";
import { ExpressionFormatter } from "@pipedog/core/expressive/formatter";
import {
  type Frame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  TextType,
  TTSAudioRawFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import {
  TextAggregationMode,
  TTSService,
  type TTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import { State } from "@pipedog/core/services/websocket_service";
import { runTest } from "@pipedog/core/tests/utils";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";
import {
  _DialogueContext,
  _KEEPALIVE_CONTEXT_ID,
  _normalizeTtdAlignment,
  ElevenLabsDialogueTTSService,
} from "../src/dialogue/tts.ts";
import { ElevenLabsAudioTagExpressionAdapter } from "../src/elevenlabs_adapter.ts";
import { calculateWordTimes } from "../src/tts.ts";

// Tests reach into protected members.
type Any = any;

const _WS_ALIGNMENT_KEYS = ["chars", "charStartTimesMs", "charDurationsMs"];

/** Minimal stand-in for the ElevenLabs websocket that records sends. */
class _FakeWebSocket {
  state: State = State.OPEN;
  sent: Record<string, any>[] = [];

  async send(data: string): Promise<void> {
    this.sent.push(pyJsonLoads(data) as Record<string, any>);
  }
}

function _makeDialogueService(settingsKwargs: Record<string, unknown> = {}): Any {
  const settings = new ElevenLabsDialogueTTSService.Settings({
    voice: "test-voice",
    ...settingsKwargs,
  });
  return new ElevenLabsDialogueTTSService({ apiKey: "test-key", settings });
}

/** Put the service in the state runTts leaves behind for an open context. */
async function _openDialogueContext(
  service: Any,
  ws: _FakeWebSocket,
  contextId = "ctx-1",
): Promise<void> {
  service._websocket = ws;
  service._contexts.set(contextId, new _DialogueContext());
  await service._audioContextManager.create(contextId);
}

describe("TestElevenLabsDialogueTTS", () => {
  test("test_dialogue_text_is_sent_as_inputs", async () => {
    // Text goes out as an inputs array tagged with the configured voice.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    await _openDialogueContext(service, ws);

    await service._sendText("Hello there.", "ctx-1");

    expect(ws.sent).toEqual([
      {
        context_id: "ctx-1",
        inputs: [{ text: "Hello there.", voice_id: "test-voice", new_turn: true }],
      },
    ]);
  });

  test("test_dialogue_new_turn_only_on_first_input", async () => {
    // new_turn resets prosody once per context, not on every input.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    await _openDialogueContext(service, ws);

    await service._sendText("First sentence.", "ctx-1");
    await service._sendText("Second sentence.", "ctx-1");

    expect(ws.sent.map((m) => m.inputs[0].new_turn)).toEqual([true, false]);
  });

  test("test_dialogue_text_for_unregistered_context_is_dropped", async () => {
    // Messages naming an unregistered context would close the socket with 1008.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    service._websocket = ws;

    await service._sendText("Hello there.", "ctx-unknown");
    await service.flushAudio("ctx-unknown");

    expect(ws.sent).toEqual([]);
  });

  test("test_dialogue_interruption_closes_context_without_reconnect", async () => {
    // Interruptions cancel via close_context on the open socket.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    await _openDialogueContext(service, ws);

    const disconnects: boolean[] = [];
    service._disconnect = async () => {
      disconnects.push(true);
    };

    await service._closeContext("ctx-1");

    expect(ws.sent).toEqual([{ context_id: "ctx-1", close_context: true }]);
    expect(disconnects).toEqual([]);
    expect(service._contexts.get("ctx-1").registered).toBe(false);
  });

  test("test_dialogue_close_context_is_idempotent", async () => {
    // A context already closed by the server isn't closed twice.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    await _openDialogueContext(service, ws);

    await service._closeContext("ctx-1");
    await service._closeContext("ctx-1");

    expect(ws.sent.length).toBe(1);
  });

  test("test_dialogue_context_init_is_idempotent", async () => {
    // Re-registering a context the server already has closes the socket.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    service._websocket = ws;

    await service._sendContextInit("ctx-1");
    await service._sendContextInit("ctx-1");

    expect(ws.sent).toEqual([{ context_id: "ctx-1", voices: ["test-voice"] }]);
  });

  test("test_dialogue_quiet_context_is_not_registered_again", async () => {
    // The reported 1008: runTts reopens the audio context, the server's stays.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    await _openDialogueContext(service, ws);
    service._turnContextId = "ctx-1";
    await service._sendText("First sentence.", "ctx-1");

    // What the base class does when an audio context reaches its idle timeout.
    service._audioContextManager.remove("ctx-1");
    await service.onAudioContextCompleted("ctx-1");
    ws.sent.length = 0;

    for await (const _ of service.runTts("The rest of the turn.", "ctx-1")) {
      // drain
    }

    expect(ws.sent).toEqual([
      {
        context_id: "ctx-1",
        inputs: [{ text: "The rest of the turn.", voice_id: "test-voice", new_turn: false }],
      },
    ]);
  });

  test("test_dialogue_new_connection_forgets_old_contexts", async () => {
    // A context belongs to the connection that registered it.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    await _openDialogueContext(service, ws);

    const fresh = new _FakeWebSocket();
    service._websocket = fresh;
    await service._onWebsocketConnected();

    expect(service._contexts.has("ctx-1")).toBe(false);
    expect(fresh.sent).toEqual([{ context_id: _KEEPALIVE_CONTEXT_ID, voices: ["test-voice"] }]);
  });

  test("test_dialogue_keepalive_context_is_registered_on_connect", async () => {
    // The connection idles out in 20s without a context to keep alive.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    service._websocket = ws;

    await service._registerKeepaliveContext();

    const keepaliveId = _KEEPALIVE_CONTEXT_ID;
    expect(ws.sent).toEqual([{ context_id: keepaliveId, voices: ["test-voice"] }]);
    expect(service._contexts.has(keepaliveId)).toBe(true);
  });

  test("test_dialogue_keepalive_targets_its_own_context", async () => {
    // A keep_alive without a registered context_id is rejected with 1008.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    service._websocket = ws;
    await service._registerKeepaliveContext();
    ws.sent.length = 0;

    await service._sendKeepalive();

    expect(ws.sent).toEqual([{ context_id: _KEEPALIVE_CONTEXT_ID, keep_alive: true }]);
  });

  test("test_dialogue_keepalive_silent_before_registration", async () => {
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    service._websocket = ws;

    await service._sendKeepalive();

    expect(ws.sent).toEqual([]);
  });

  test("test_dialogue_keepalive_context_messages_are_ignored", async () => {
    // Nothing about the keepalive context should reach the audio pipeline.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    service._websocket = ws;

    const appended: unknown[] = [];
    service.appendToAudioContext = async (ctx: string, frame: unknown) => {
      appended.push([ctx, frame]);
    };

    await service._handleMessage({ context_id: _KEEPALIVE_CONTEXT_ID, is_final: true });

    expect(appended).toEqual([]);
  });

  test("test_dialogue_flush_targets_registered_contexts_only", async () => {
    // The server rejects any message naming a context it has closed.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    await _openDialogueContext(service, ws);

    await service.flushAudio("ctx-1");
    expect(ws.sent).toEqual([{ context_id: "ctx-1", flush: true }]);

    service._contexts.get("ctx-1").registered = false;
    await service.flushAudio("ctx-1");

    expect(ws.sent.filter((m) => m.context_id === "ctx-1" && m.flush === true).length).toBe(1);
  });

  test("test_dialogue_turn_end_closes_the_context", async () => {
    // Ending a turn sends the close, which is what generates the turn's tail.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    await _openDialogueContext(service, ws);

    await service._sendText("Sure.", "ctx-1");

    service._turnContextId = "ctx-1";
    await service.onTurnContextCompleted();

    expect(ws.sent.at(-1)).toEqual({ context_id: "ctx-1", close_context: true });
  });

  test("test_dialogue_turn_end_closes_a_context_that_went_quiet", async () => {
    // A context still generating outlives the audio context that waits on it.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    await _openDialogueContext(service, ws);
    service._turnContextId = "ctx-1";

    // What the base class does when an audio context reaches its idle timeout.
    service._audioContextManager.remove("ctx-1");
    await service.onAudioContextCompleted("ctx-1");

    await service.onTurnContextCompleted();

    expect(ws.sent).toEqual([{ context_id: "ctx-1", close_context: true }]);
  });

  test("test_dialogue_turn_final_does_not_end_the_audio_context", async () => {
    // Turn finals arrive per generation batch; only is_final ends a context.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    await _openDialogueContext(service, ws);

    const appended: unknown[] = [];
    service.appendToAudioContext = async (_ctx: string, frame: unknown) => {
      appended.push(frame);
    };

    await service._handleMessage({ context_id: "ctx-1", is_final_audio_for_turn: true });

    expect(appended).toEqual([]);
  });

  test("test_dialogue_interruption_closes_without_waiting_for_audio", async () => {
    // Before generation starts, an immediate close is what cancels the text.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    await _openDialogueContext(service, ws);

    await service._closeContext("ctx-1");

    expect(ws.sent).toEqual([{ context_id: "ctx-1", close_context: true }]);
  });

  test("test_dialogue_stability_is_passed_through", () => {
    // The API validates the range itself; it accepts any value in it.
    for (const given of [0.0, 0.25, 0.3, 0.5, 0.7, 1.0]) {
      const service = _makeDialogueService({ stability: given });
      expect(service._voiceSettings).toEqual({ stability: given });
    }
  });

  test("test_dialogue_voice_settings_carries_stability_only", () => {
    // Text-to-Dialogue ignores the other voice settings entirely.
    const service = _makeDialogueService({ stability: 0.3 });
    expect(new Set(Object.keys(service._voiceSettings))).toEqual(new Set(["stability"]));
  });

  test("test_dialogue_voice_settings_omitted_when_stability_unset", () => {
    const service = _makeDialogueService();
    expect(service._voiceSettings).toBeNull();
  });

  test("test_dialogue_voice_change_does_not_require_reconnect", () => {
    // Voices are registered per context, so a voice change just needs a new one.
    expect(ElevenLabsDialogueTTSService.Settings.URL_FIELDS.has("voice")).toBe(false);
    expect(ElevenLabsDialogueTTSService.Settings.VOICE_SETTINGS_FIELDS.has("voice")).toBe(true);
  });

  test("test_dialogue_alignment_is_normalized_for_word_times", () => {
    // Text-to-Dialogue sends snake_case alignment; shared helpers expect camelCase.
    const normalized = _normalizeTtdAlignment({
      chars: ["H", "i", " ", "t", "h", "e", "r", "e"],
      char_start_times_ms: [0, 50, 100, 120, 170, 220, 270, 320],
      char_durations_ms: [50, 50, 20, 50, 50, 50, 50, 50],
    });

    expect(new Set(Object.keys(normalized))).toEqual(new Set(_WS_ALIGNMENT_KEYS));

    const [wordTimes, partial] = calculateWordTimes(normalized, 0.0, "", 0.0);
    expect(wordTimes.map(([word]) => word)).toEqual(["Hi"]);
    expect(partial).toBe("there");
  });

  test("test_dialogue_wordless_alignment_still_advances_the_clock", async () => {
    // Trailing punctuation arrives on its own; its span must not be dropped.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    await _openDialogueContext(service, ws);

    service.addWordTimestamps = async () => null;

    // "Hi there" -- completes "Hi", carries "there".
    await service._handleMessage({
      context_id: "ctx-1",
      alignment: {
        chars: ["H", "i", " ", "t", "h", "e", "r", "e"],
        char_start_times_ms: [0, 120, 240, 293, 347, 400, 453, 507],
        char_durations_ms: [120, 120, 53, 54, 53, 53, 54, 53],
      },
    });
    const afterFirst = service._cumulativeTime;
    expect(afterFirst).toBeCloseTo(0.56, 6);

    // "!" alone: completes no word, but occupies 320ms of audio.
    await service._handleMessage({
      context_id: "ctx-1",
      alignment: {
        chars: ["!"],
        char_start_times_ms: [0],
        char_durations_ms: [320],
      },
    });

    // word-less alignment chunk dropped from the clock; later word timestamps would run early
    expect(service._cumulativeTime).toBeCloseTo(afterFirst + 0.32, 6);
  });

  test("test_dialogue_appends_trailing_space_to_inputs", () => {
    // Consecutive inputs are concatenated verbatim by the server.
    const service = _makeDialogueService();

    expect(service._appendTrailingSpace).toBe(true);
    expect(service._prepareTextForTts("Hi there!")).toBe("Hi there! ");
    expect(service._prepareTextForTts("Hi there! ")).toBe("Hi there! ");
  });

  test("test_dialogue_always_aggregates_sentences", () => {
    // Each flush generates independently, so tokens would synthesize out of context.
    const service = _makeDialogueService();

    expect(service._textAggregationMode).toBe(TextAggregationMode.SENTENCE);
    expect(service._isStreamingTokens).toBe(false);
  });

  test("test_dialogue_token_aggregation_is_refused", () => {
    // Sentence aggregation holds even when the caller asks for tokens.
    const settings = new ElevenLabsDialogueTTSService.Settings({ voice: "test-voice" });
    const service: Any = new ElevenLabsDialogueTTSService({
      apiKey: "test-key",
      settings,
      textAggregationMode: TextAggregationMode.TOKEN,
    });

    expect(service._textAggregationMode).toBe(TextAggregationMode.SENTENCE);
    expect(service._isStreamingTokens).toBe(false);
  });

  test("test_dialogue_defaults_to_eleven_v4_turbo", () => {
    const service = _makeDialogueService();

    expect(service._settings.model).toBe("eleven_v4_turbo");
  });

  test("test_dialogue_non_dialogue_model_warns_without_raising", () => {
    // The wrong-model warning names the service, so it needs a constructed one.
    const service = _makeDialogueService({ model: "eleven_flash_v2_5" });

    expect(service._settings.model).toBe("eleven_flash_v2_5");
  });

  test("test_dialogue_appends_trailing_space_under_sentence_aggregation", () => {
    // Sentence aggregation is what makes the trailing space safe to append.
    const service = _makeDialogueService();

    expect(service._appendTrailingSpace).toBe(true);
    expect(service._prepareTextForTts("Hi there!")).toBe("Hi there! ");
  });

  test("test_dialogue_drained_alignment_does_not_disturb_the_next_turn", async () => {
    // An interrupted context keeps streaming; its alignment belongs to nobody.
    const service = _makeDialogueService();
    const ws = new _FakeWebSocket();
    await _openDialogueContext(service, ws);

    service.addWordTimestamps = async () => null;

    // The next turn is under way with a fresh clock.
    service._cumulativeTime = 0.0;
    service._partialWord = "";
    service._audioContextManager.remove("ctx-1");
    await service._audioContextManager.create("ctx-2");

    // Late alignment from the interrupted context arrives.
    await service._handleMessage({
      context_id: "ctx-1",
      alignment: {
        chars: ["s", "t", "a", "l", "e"],
        char_start_times_ms: [0, 100, 200, 300, 400],
        char_durations_ms: [100, 100, 100, 100, 100],
      },
    });

    // drained context advanced the next turn's clock
    expect(service._cumulativeTime).toBe(0.0);
    // drained context left a partial word behind
    expect(service._partialWord).toBe("");
  });
});

/** Alignment for text, one character every 10ms. */
function _alignment(text: string, startMs = 0): Record<string, any> {
  const chars = Array.from(text);
  return {
    chars,
    charStartTimesMs: chars.map((_, i) => startMs + 10 * i),
    charDurationsMs: chars.map(() => 10),
  };
}

test("test_an_audio_tag_is_one_word", () => {
  const [wordTimes, partial] = calculateWordTimes(
    _alignment("10\u00a0000, [short pause] two"),
    0.0,
    undefined,
    undefined,
    { audioTags: true },
  );

  expect(wordTimes.map(([word]) => word)).toEqual(["10\u00a0000,", "[short pause]"]);
  expect(partial).toBe("two");
});

test("test_an_audio_tag_split_across_chunks_is_one_word", () => {
  const [first, partial1, start] = calculateWordTimes(
    _alignment("[clear th"),
    0.0,
    undefined,
    undefined,
    { audioTags: true },
  );
  const [second, partial] = calculateWordTimes(_alignment("roat] It's"), 0.0, partial1, start, {
    audioTags: true,
  });

  expect(first).toEqual([]);
  expect(second.map(([word]) => word)).toEqual(["[clear throat]"]);
  expect(partial).toBe("It's");
});

test("test_dialogue_word_timestamps_report_audio_tags_as_words", async () => {
  const service = _makeDialogueService();
  const ws = new _FakeWebSocket();
  await _openDialogueContext(service, ws);
  const reported: string[] = [];

  service.addWordTimestamps = async (wordTimes: [string, number][]) => {
    reported.push(...wordTimes.map(([word]) => word));
  };
  service._expressionFormatter = new ExpressionFormatter(() => service.getExpressionAdapter(), {
    owner: service,
  });

  for (const chunk of ["[exci", "ted] Good news [clear th", "roat] it's ", "back."]) {
    const alignment = _alignment(chunk);
    await service._handleMessage({
      context_id: "ctx-1",
      alignment: {
        chars: alignment.chars,
        char_start_times_ms: alignment.charStartTimesMs,
        char_durations_ms: alignment.charDurationsMs,
      },
    });
  }

  expect(reported).toEqual(["[excited]", "Good", "news", "[clear throat]", "it's"]);
  expect(service._cumulativeTime).toBeCloseTo(0.05 + 0.24 + 0.11 + 0.05, 6);
});

describe("TestAudioTagExpressionAdapter", () => {
  test("test_capabilities", () => {
    const capabilities = new ElevenLabsAudioTagExpressionAdapter().capabilities();
    expect(capabilities.allowsFreeText).toBeTruthy();
    expect(capabilities.emphasis).toBeTruthy();
    expect(capabilities.pauseRangeMs).toEqual([100, 3000]);
  });

  test("test_delivery_names_are_single_words", () => {
    // A delivery tag separates its names by spaces.
    const capabilities = new ElevenLabsAudioTagExpressionAdapter().capabilities();
    expect(
      capabilities.delivery.every(
        (term) => term.name.split(/\s+/).filter((w) => w.length > 0).length === 1,
      ),
    ).toBe(true);
  });

  test("test_tags_formatted_where_delivery_changes", () => {
    const adapter = new ElevenLabsAudioTagExpressionAdapter();
    expect(adapter.formatText("Hi.", ["excited"], null)).toBe("[excited] Hi.");
    expect(adapter.formatText("Hi.", ["excited"], ["excited"])).toBe("Hi.");
    expect(adapter.formatText("Hi.", ["sad", "whispers"], null)).toBe("[sad] [whispers] Hi.");
  });

  test("test_slow_and_fast_are_written_as_pace_tags", () => {
    const adapter = new ElevenLabsAudioTagExpressionAdapter();
    const names = new Set(adapter.capabilities().delivery.map((term) => term.name));
    expect(names.has("slow") && names.has("fast")).toBe(true);
    expect(adapter.formatText("Hi.", ["calm", "slow"], null)).toBe("[calm] [slowly] Hi.");
    expect(adapter.formatText("Hi.", ["fast"], ["calm"])).toBe("[quickly] Hi.");
  });

  test("test_return_to_baseline_formats_nothing", () => {
    const adapter = new ElevenLabsAudioTagExpressionAdapter();
    expect(adapter.formatText("Hi.", [], ["excited"])).toBe("Hi.");
  });

  test("test_emphasis_is_capitalized", () => {
    const adapter = new ElevenLabsAudioTagExpressionAdapter();
    expect(adapter.formatText("back up", ["emphasis"], null)).toBe("BACK UP");
    expect(adapter.formatText("back up", ["excited", "emphasis"], ["excited"])).toBe("BACK UP");
  });

  test("test_sounds", () => {
    expect(new ElevenLabsAudioTagExpressionAdapter().formatSound("laughs")).toBe(" [laughs] ");
  });

  test("test_pauses_are_short_or_long", () => {
    const adapter = new ElevenLabsAudioTagExpressionAdapter();
    expect(adapter.formatPause(500)).toBe(" [short pause] ");
    expect(adapter.formatPause(1500)).toBe(" [long pause] ");
  });
});

// ---------------------------------------------------------------------------
// _MockWordTimestampHttpTTSService from tests/test_tts_frame_ordering.py (a test
// module can't be imported here without registering its tests, so it is copied).
// ---------------------------------------------------------------------------

type WordTimes = [string, number][];

const _FAKE_AUDIO = (() => {
  // b"\x00\x01" * 320
  const a = new Uint8Array(640);
  for (let i = 1; i < a.length; i += 2) a[i] = 1;
  return a;
})();
const _SAMPLE_RATE = 16000;

interface MockWordTimestampTTSServiceOptions extends TTSServiceOptions {
  includesInterFrameSpaces?: boolean;
  preMergeTokens?: boolean;
  wordTimes?: WordTimes | null;
}

/** HTTP-style TTS: yields audio synchronously, calls addWordTimestamps first. */
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
    const wordTimes: WordTimes = this._wordTimes?.length
      ? this._wordTimes
      : text
          .split(/\s+/)
          .filter((w) => w.length > 0)
          .map((w, i) => [w, i * 0.1]);
    await this.addWordTimestamps(wordTimes, contextId, {
      includesInterFrameSpaces: this._includesInterFrameSpaces,
      preMergeTokens: this._preMergeTokens,
    });
    yield new TTSAudioRawFrame({
      audio: _FAKE_AUDIO,
      sampleRate: _SAMPLE_RATE,
      numChannels: 1,
      contextId,
    });
  }
}

/** Reports the words of what it's sent as ElevenLabs aligns them, audio tags whole. */
class _AlignedTTSService extends _MockWordTimestampHttpTTSService {
  static override expressionAdapterClass = ElevenLabsAudioTagExpressionAdapter;

  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const [wordTimes, partial, start] = calculateWordTimes(
      _alignment(text),
      0.0,
      undefined,
      undefined,
      { audioTags: true },
    );
    this._wordTimes = [...wordTimes, ...(partial ? ([[partial, start]] as WordTimes) : [])];
    yield* super.runTts(text, contextId);
  }
}

describe("test_every_word_around_a_tag_of_several_words_is_reported", () => {
  for (const tag of ["[[inhales deeply]]", "[[clears throat]]", "[[pause 400]]"]) {
    test(`test_every_word_around_a_tag_of_several_words_is_reported[${tag}]`, async () => {
      const warnings: string[] = [];
      const remove = logger.addSink((record) => {
        if (record.level === "WARNING" || record.level === "ERROR" || record.level === "CRITICAL") {
          warnings.push(record.message);
        }
      });
      let down: Frame[];
      try {
        [down] = await runTest(new _AlignedTTSService(), {
          framesToSend: [
            new LLMFullResponseStartFrame(),
            new LLMTextFrame({ text: `Here's a story. ${tag} Every night, a lighthouse blinked.` }),
            new LLMFullResponseEndFrame(),
          ],
          pipelineParams: new PipelineParams({ enableExpressiveConversation: true }),
        });
      } finally {
        remove();
      }

      const words = down
        .filter((f) => f instanceof TTSTextFrame && f.textType === TextType.WORD)
        .map((f) => (f as TTSTextFrame).text);
      expect(words).toEqual([
        "Here's",
        "a",
        "story.",
        "Every",
        "night,",
        "a",
        "lighthouse",
        "blinked.",
      ]);
      expect(warnings.filter((w) => w.includes("Dropping word"))).toEqual([]);
    });
  }
});
