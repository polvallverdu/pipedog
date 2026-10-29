// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_tts_expression.py

/** Tests for how a TTSService reads expression tags in expressive conversation. */

import { expect, setDefaultTimeout, test } from "bun:test";
import { sleep } from "@pipedog/asyncio";

import { BaseExpressionAdapter } from "../src/adapters/tts/base_expression_adapter.ts";
import {
  DeliveryScope,
  ExpressionCapabilities,
  ExpressionDelivery,
  ExpressionSound,
  ExpressionTerm,
} from "../src/expressive/expression.ts";
import {
  AggregatedTextFrame,
  AggregatedTextProgressFrame,
  ExpressionMetadataFrame,
  type Frame,
  InterruptionFrame,
  LLMContextAssistantTurnFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  TextType,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSTextFrame,
} from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { ServiceSwitcher } from "../src/pipeline/service_switcher.ts";
import { PipelineParams } from "../src/pipeline/worker.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import { LLMAssistantAggregator } from "../src/processors/aggregators/llm_response_universal.ts";
import { LLMTextProcessor } from "../src/processors/aggregators/llm_text_processor.ts";
import type { FrameProcessor } from "../src/processors/frame_processor.ts";
import {
  TextAggregationMode,
  TTSService,
  type TTSServiceOptions,
} from "../src/services/tts_service.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import { logger } from "../src/utils/logger.ts";
import { SkipTagsAggregator } from "../src/utils/text/skip_tags_aggregator.ts";
import { stripMarkdown } from "../src/utils/text/transforms/strip_markdown.ts";

setDefaultTimeout(15_000);

// ---------------------------------------------------------------------------
// Mocks from tests/test_tts_frame_ordering.py (a test module can't be imported
// here without registering its tests, so the two used are copied).
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

/** Simulates an HTTP TTS service with pushTextFrames=true. */
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

type WordTimes = [string, number][];

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
      : pySplit(text).map((w, i) => [w, i * 0.1]);
    await this.addWordTimestamps(wordTimes, contextId, {
      includesInterFrameSpaces: this._includesInterFrameSpaces,
      preMergeTokens: this._preMergeTokens,
    });
    yield fakeAudio(contextId);
  }
}

/** Python `str.split()`. */
function pySplit(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/** `re.sub(r" ([!?.,;:])", r"\1", re.sub(r"<[^>]*>", " ", text))` */
function wordsOf(text: string): string {
  return text.replace(/<[^>]*>/g, " ").replace(/ ([!?.,;:])/g, "$1");
}

// ---------------------------------------------------------------------------

const EXPRESSIVE = new PipelineParams({ enableExpressiveConversation: true });

const REPLY = ["<<cheerful>> It's [[la", "ugh]] ^^back up^^ now. [[pause 400]] Bye!"];
const WRITTEN = "<<cheerful>> It's [[laugh]] ^^back up^^ now. [[pause 400]] Bye!";

/** Formats delivery as <delivery> where it changes, sounds as <name>, pauses as <Nms>, set apart. */
class BracketAdapter extends BaseExpressionAdapter {
  override capabilities(): ExpressionCapabilities {
    return new ExpressionCapabilities({
      sounds: [new ExpressionTerm({ name: "laugh" })],
      delivery: [new ExpressionTerm({ name: "cheerful" }), new ExpressionTerm({ name: "calm" })],
      pauseRangeMs: [100, 1000],
      emphasis: true,
    });
  }

  override formatText(text: string, delivery: string[], previousDelivery: string[] | null): string {
    const previous = previousDelivery ?? [];
    const changed =
      delivery.length !== previous.length || delivery.some((d, i) => d !== previous[i]);
    return changed && delivery.length > 0 ? `<${delivery.join(",")}> ${text}` : text;
  }

  override formatSound(name: string): string {
    return ` <${name}> `;
  }

  override formatPause(durationMs: number): string {
    return ` <${durationMs}ms> `;
  }
}

class PushTextTTSService extends MockHttpPushTextTTSService {
  static override expressionAdapterClass = BracketAdapter;
}

/** Reports timestamps for the words it speaks, not for its markup. */
class WordTimestampTTSService extends _MockWordTimestampHttpTTSService {
  static override expressionAdapterClass = BracketAdapter;

  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    // Markup is set apart from the words, which keep their punctuation.
    const words = wordsOf(text);
    yield* super.runTts(words, contextId);
  }
}

type ServiceClass = new (options?: MockWordTimestampTTSServiceOptions) => TTSService;

const SERVICES: ServiceClass[] = [PushTextTTSService, WordTimestampTTSService];

function response(...chunks: string[]): Frame[] {
  return [
    new LLMFullResponseStartFrame(),
    ...chunks.map((c) => new LLMTextFrame({ text: c })),
    new LLMFullResponseEndFrame(),
  ];
}

function recordRequests(tts: TTSService): string[] {
  const requests: string[] = [];
  tts.eventHandler("on_tts_request", async (_tts: unknown, _contextId: unknown, text: string) => {
    requests.push(text);
  });
  return requests;
}

async function contextAfter(tts: FrameProcessor, frames: Frame[]): Promise<string> {
  const context = new LLMContext();
  await runTest(new Pipeline([tts, new LLMAssistantAggregator(context)]), {
    framesToSend: frames,
    pipelineParams: EXPRESSIVE,
  });
  return lastContent(context);
}

function lastContent(context: LLMContext): string {
  const messages = context.messages as { content: string }[];
  return messages[messages.length - 1]!.content;
}

function ttsTextFrames(frames: readonly Frame[]): TTSTextFrame[] {
  return frames.filter((f): f is TTSTextFrame => f instanceof TTSTextFrame);
}

/** loguru `logger.add(sink, level="WARNING")` around `fn`. */
async function captureWarnings<T>(fn: () => Promise<T>): Promise<[T, string[]]> {
  const warnings: string[] = [];
  const remove = logger.addSink((record) => {
    if (record.level === "WARNING" || record.level === "ERROR" || record.level === "CRITICAL") {
      warnings.push(record.message);
    }
  });
  try {
    return [await fn(), warnings];
  } finally {
    remove();
  }
}

for (const service of SERVICES) {
  test(`test_the_tts_is_sent_the_words_with_their_formatted_expression[${service.name}]`, async () => {
    const tts = new service();
    const requests = recordRequests(tts);
    await runTest(tts, { framesToSend: response(...REPLY), pipelineParams: EXPRESSIVE });

    expect(requests).toEqual([
      "<cheerful> It's <laugh> <cheerful,emphasis> back up <cheerful> now.",
      "<400ms> <cheerful> Bye!",
    ]);
  });
}

test("test_apps_get_the_words_while_the_context_keeps_the_tags", async () => {
  const context = new LLMContext();
  const aggregator = new LLMAssistantAggregator(context);
  const stopped: string[] = [];

  aggregator.eventHandler(
    "on_assistant_turn_stopped",
    async (_aggregator: unknown, message: { content: string }) => {
      stopped.push(message.content);
    },
  );

  const [down] = await runTest(new Pipeline([new WordTimestampTTSService(), aggregator]), {
    framesToSend: response(...REPLY),
    pipelineParams: EXPRESSIVE,
  });

  expect(lastContent(context)).toEqual(WRITTEN);
  expect(stopped).toEqual(["It's back up now. Bye!"]);
  expect(
    down
      .filter((f): f is LLMContextAssistantTurnFrame => f instanceof LLMContextAssistantTurnFrame)
      .map((f) => f.text),
  ).toEqual(["It's back up now. Bye!"]);
});

for (const [switched, id] of [
  [false, "tts"],
  [true, "tts switcher"],
] as const) {
  test(`test_the_context_keeps_only_the_words_when_a_tagger_wrote_the_tags[${id}]`, async () => {
    const context = new LLMContext();
    let tts: FrameProcessor = new WordTimestampTTSService();
    if (switched) {
      tts = new ServiceSwitcher([tts, new WordTimestampTTSService()]);
    }

    await runTest(new Pipeline([tts, new LLMAssistantAggregator(context)]), {
      framesToSend: [new ExpressionMetadataFrame({ serviceName: "tagger" }), ...response(...REPLY)],
      pipelineParams: EXPRESSIVE,
    });

    expect(lastContent(context)).toEqual("It's back up now. Bye!");
  });
}

for (const service of SERVICES) {
  test(`test_the_context_keeps_the_reply_as_written[${service.name}]`, async () => {
    expect(await contextAfter(new service(), response(...REPLY))).toEqual(WRITTEN);
  });
}

test("test_without_word_timestamps_a_sentence_carries_its_delivery_and_sounds", async () => {
  const [down] = await runTest(new PushTextTTSService(), {
    framesToSend: response(...REPLY),
    pipelineParams: EXPRESSIVE,
  });

  // Each sentence is reported whole, in the delivery it starts in, after its sounds.
  const written = ttsTextFrames(down).map((f) => [f.textType, f.text, f.delivery]);
  expect(written).toEqual([
    [TextType.EXPRESSION_SOUND, "laugh", null],
    [TextType.SENTENCE, "It's back up now.", ["cheerful"]],
    [TextType.EXPRESSION_PAUSE, "400", null],
    [TextType.SENTENCE, "Bye!", ["cheerful"]],
  ]);
});

test("test_word_timestamps_report_each_words_delivery_and_the_sounds_between", async () => {
  const [down] = await runTest(new WordTimestampTTSService(), {
    framesToSend: response(...REPLY),
    pipelineParams: EXPRESSIVE,
  });

  const words = ttsTextFrames(down).map((f) => [f.textType, f.text, f.delivery]);
  expect(words).toEqual([
    [TextType.WORD, "It's", ["cheerful"]],
    [TextType.EXPRESSION_SOUND, "laugh", null],
    [TextType.WORD, "back", ["cheerful", "emphasis"]],
    [TextType.WORD, "up", ["cheerful", "emphasis"]],
    [TextType.WORD, "now.", ["cheerful"]],
    [TextType.EXPRESSION_PAUSE, "400", null],
    [TextType.WORD, "Bye!", ["cheerful"]],
  ]);
});

/** Performs the universal warm and laugh by names of its own. */
class VocabularyAdapter extends BracketAdapter {
  override capabilities(): ExpressionCapabilities {
    return new ExpressionCapabilities({
      sounds: [new ExpressionTerm({ name: "laughs" })],
      delivery: [new ExpressionTerm({ name: "warmly" })],
      serviceVocabulary: {
        [ExpressionDelivery.WARM]: ["warmly"],
        [ExpressionSound.LAUGH]: ["laughs"],
      },
    });
  }
}

class VocabularyTTSService extends WordTimestampTTSService {
  static override expressionAdapterClass = VocabularyAdapter;
}

test("test_universal_names_are_sent_by_the_services_names_and_reported_as_written", async () => {
  const tts = new VocabularyTTSService();
  const requests = recordRequests(tts);
  const [down] = await runTest(tts, {
    framesToSend: response("<<warm>> Hi [[laugh]] there."),
    pipelineParams: EXPRESSIVE,
  });

  expect(requests).toEqual(["<warmly> Hi <laughs> there."]);
  const words = ttsTextFrames(down).map((f) => [f.textType, f.text, f.delivery]);
  expect(words).toEqual([
    [TextType.WORD, "Hi", ["warm"]],
    [TextType.EXPRESSION_SOUND, "laugh", null],
    [TextType.WORD, "there.", ["warm"]],
  ]);
});

test("test_a_sentence_is_one_segment_shown_without_its_tags", async () => {
  const [down] = await runTest(new WordTimestampTTSService(), {
    framesToSend: response("<<calm>> It's ^^back up^^ now."),
    pipelineParams: EXPRESSIVE,
  });

  const segments = down
    .filter(
      (f): f is AggregatedTextFrame =>
        f.constructor === AggregatedTextFrame && (f as AggregatedTextFrame).willBeSpoken,
    )
    .map((f) => [f.text, f.rawText]);
  expect(segments).toEqual([["It's back up now.", "<<calm>> It's ^^back up^^ now."]]);
  // Its progress carries the delivery of each word as it is spoken.
  const progress = down
    .filter((f): f is AggregatedTextProgressFrame => f instanceof AggregatedTextProgressFrame)
    .map((f) => [f.accumulatedText, f.delivery]);
  expect(progress).toEqual([
    ["It's", ["calm"]],
    ["It's back", ["calm", "emphasis"]],
    ["It's back up", ["calm", "emphasis"]],
    ["It's back up now.", ["calm"]],
  ]);
});

const ONLY_TAGS_CASES: [TextAggregationMode, string[]][] = [
  [TextAggregationMode.TOKEN, ["<<chee", "rful>>", " It's", " fine."]],
  [TextAggregationMode.TOKEN, ["It's", " fine.", " [[laugh]]"]],
  [TextAggregationMode.TOKEN, ["It's", " fine.", " <<calm>>"]],
  [TextAggregationMode.SENTENCE, ["It's fine. Bye. [[laugh]]"]],
  [TextAggregationMode.SENTENCE, ["It's fine. Bye. [[snort]]"]],
  [TextAggregationMode.SENTENCE, ["It's fine. Bye. <<calm>>"]],
];

for (const [mode, chunks] of ONLY_TAGS_CASES) {
  for (const service of SERVICES) {
    test(`test_a_unit_that_is_only_tags_reaches_the_context[${mode}-${JSON.stringify(chunks)}-${service.name}]`, async () => {
      // A tag with no words of its own, performed or not, is text the LLM wrote.
      const tts = new service({ textAggregationMode: mode });

      expect(await contextAfter(tts, response(...chunks))).toEqual(chunks.join(""));
    });
  }
}

for (const mode of [TextAggregationMode.SENTENCE, TextAggregationMode.TOKEN]) {
  for (const service of SERVICES) {
    test(`test_a_reply_that_is_only_tags_is_recorded_and_ended[${mode}-${service.name}]`, async () => {
      // It speaks nothing, so no audio context ends it: the reply's end does.
      const tts = new service({ textAggregationMode: mode });
      const context = new LLMContext();
      await runTest(new Pipeline([tts, new LLMAssistantAggregator(context)]), {
        framesToSend: [
          ...response("<<calm>>"),
          new SleepFrame({ sleep: 0.1 }),
          ...response("Hi there."),
        ],
        pipelineParams: EXPRESSIVE,
      });

      expect((context.messages as { content: string }[]).map((m) => m.content)).toEqual([
        "<<calm>>",
        "Hi there.",
      ]);
      expect((tts as unknown as { _ttsContexts: Map<string, unknown> })._ttsContexts.size).toBe(0);
    });
  }
}

for (const [first, firstRequest] of [
  ["\n", "Hi"],
  [" ", "Hi"],
  ["<<cheerful>>", "<cheerful> Hi"],
] as const) {
  for (const service of SERVICES) {
    test(`test_whitespace_before_anything_is_said_isnt_sent_in_token_mode[${JSON.stringify(first)}-${firstRequest}-${service.name}]`, async () => {
      // As without expressive conversation: nothing has been said for it to separate.
      const tts = new service({ textAggregationMode: TextAggregationMode.TOKEN });
      const requests = recordRequests(tts);

      await runTest(tts, {
        framesToSend: response(first, " ", "Hi", " there."),
        pipelineParams: EXPRESSIVE,
      });

      expect(requests).toEqual([firstRequest, " there."]);
    });
  }
}

for (const service of SERVICES) {
  test(`test_a_reply_of_only_whitespace_says_nothing_in_token_mode[${service.name}]`, async () => {
    const tts = new service({ textAggregationMode: TextAggregationMode.TOKEN });
    const requests = recordRequests(tts);

    const [down] = await runTest(tts, {
      framesToSend: response("\n", "\n\n", " "),
      pipelineParams: EXPRESSIVE,
    });

    expect(requests).toEqual([]);
    expect(down.filter((f) => f instanceof TTSStartedFrame)).toEqual([]);
  });
}

/** Keeps its own tags whole, as Cartesia keeps <spell> tags. */
class SpellingTTSService extends PushTextTTSService {
  constructor(options: TTSServiceOptions = {}) {
    super(options);
    this._textAggregator = new SkipTagsAggregator({
      tags: [["<spell>", "</spell>"]],
      aggregationType: this._textAggregationMode,
    });
  }
}

test("test_a_service_keeps_its_own_tags_whole_too", async () => {
  const tts = new SpellingTTSService();
  const requests = recordRequests(tts);

  await runTest(tts, {
    framesToSend: response("Your code is <spell>A. B. C.</spell> okay? <<calm>> Bye."),
    pipelineParams: EXPRESSIVE,
  });

  expect(requests).toEqual(["Your code is <spell>A. B. C.</spell> okay?", "<calm> Bye."]);
});

test("test_tags_split_across_tokens_are_read_in_token_mode", async () => {
  const tts = new PushTextTTSService({ textAggregationMode: TextAggregationMode.TOKEN });
  const requests = recordRequests(tts);
  const context = await contextAfter(
    tts,
    response("<<chee", "rful>> It's", " [[la", "ugh]] fine."),
  );

  expect(requests.join("")).toEqual("<cheerful> It's <laugh> fine.");
  expect(context).toEqual("<<cheerful>> It's [[laugh]] fine.");
});

for (const service of SERVICES) {
  test(`test_a_tts_speak_frame_is_read_too[${service.name}]`, async () => {
    const tts = new service();
    const requests = recordRequests(tts);
    const context = await contextAfter(tts, [
      new TTSSpeakFrame({ text: "<<cheerful>> Welcome back!" }),
    ]);

    expect(requests).toEqual(["<cheerful> Welcome back!"]);
    expect(context).toEqual("<<cheerful>> Welcome back!");
  });
}

test("test_text_aggregated_upstream_is_read_too", async () => {
  const tts = new PushTextTTSService();
  const requests = recordRequests(tts);
  const sentence = new AggregatedTextFrame({
    text: "<<calm>> One moment.",
    textType: TextType.SENTENCE,
  });
  const context = await contextAfter(tts, [
    new LLMFullResponseStartFrame(),
    sentence,
    new LLMFullResponseEndFrame(),
  ]);

  expect(requests).toEqual(["<calm> One moment."]);
  expect(context).toEqual("<<calm>> One moment.");
});

test("test_a_service_that_ends_inputs_in_a_space_gets_one", async () => {
  // A service whose inputs are joined verbatim needs the space, or one
  // sentence's last word runs into the next one's first.
  const tts = new PushTextTTSService({ appendTrailingSpace: true });
  const requests = recordRequests(tts);
  await runTest(tts, { framesToSend: response(...REPLY), pipelineParams: EXPRESSIVE });

  expect(requests.every((request) => request.endsWith(" "))).toBe(true);
});

/** Never reports the last two words of a request, as a provider can drop events. */
class UnreportingTTSService extends _MockWordTimestampHttpTTSService {
  static override expressionAdapterClass = BracketAdapter;

  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const words = pySplit(wordsOf(text));
    this._wordTimes = words.slice(0, -2).map((word, i) => [word, i * 0.1]);
    yield* super.runTts(text, contextId);
  }
}

for (const written of [
  "<<calm>> I'm so sorry your order is late.",
  "<<calm>> Your code is <<slow: A B 7>>, okay?",
]) {
  test(`test_words_the_service_never_reports_reach_the_context_as_written[${written}]`, async () => {
    expect(await contextAfter(new UnreportingTTSService(), response(written))).toEqual(written);
  });
}

test("test_a_tag_cut_off_by_an_interruption_is_never_spoken", async () => {
  const tts = new PushTextTTSService({ textAggregationMode: TextAggregationMode.TOKEN });
  const requests = recordRequests(tts);
  await runTest(tts, {
    framesToSend: [
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Sure " }),
      new LLMTextFrame({ text: "[[la" }),
      new SleepFrame(),
      new InterruptionFrame(),
      ...response("ugh]] Okay."),
    ],
    pipelineParams: EXPRESSIVE,
  });

  expect(requests).toEqual(["Sure ", "ugh]] Okay."]);
});

test("test_tags_are_spoken_as_written_without_expressive_conversation", async () => {
  const tts = new MockHttpPushTextTTSService();
  const requests = recordRequests(tts);
  await runTest(tts, { framesToSend: response("<<cheerful>> Hi!") });

  expect(requests).toEqual(["<<cheerful>> Hi!"]);
});

test("test_a_service_without_an_adapter_speaks_only_the_words", async () => {
  const tts = new MockHttpPushTextTTSService();
  const requests = recordRequests(tts);
  const [down] = await runTest(tts, {
    framesToSend: response(...REPLY),
    pipelineParams: EXPRESSIVE,
  });

  expect(requests).toEqual(["It's back up now.", "Bye!"]);
  // What clients see matches what was spoken: no delivery, and no sounds.
  expect(ttsTextFrames(down).map((f) => [f.text, f.delivery])).toEqual([
    ["It's back up now.", []],
    ["Bye!", []],
  ]);
  const context = await contextAfter(new MockHttpPushTextTTSService(), response(...REPLY));
  expect(context).toEqual("<<cheerful>> It's [[laugh]] ^^back up^^ now. [[pause 400]] Bye!");
});

test("test_a_delivery_the_service_cant_perform_is_left_out", async () => {
  const tts = new PushTextTTSService();
  const requests = recordRequests(tts);
  const [down] = await runTest(tts, {
    framesToSend: response("<<whisper>> Shh."),
    pipelineParams: EXPRESSIVE,
  });

  expect(requests).toEqual(["Shh."]);
  expect(ttsTextFrames(down).map((f) => f.delivery)).toEqual([[]]);
});

test("test_each_unperformed_tag_is_warned_about_as_written", async () => {
  const [, warnings] = await captureWarnings(() =>
    runTest(new MockHttpPushTextTTSService(), {
      framesToSend: response(...REPLY),
      pipelineParams: EXPRESSIVE,
    }),
  );

  const unperformed = warnings
    .filter((w) => w.includes("can't perform"))
    .map((w) => w.split("can't perform ")[1]!.split(",")[0]);
  expect(unperformed).toEqual(["<<cheerful>>", "[[laugh]]", "^^emphasis^^", "[[pause 400]]"]);
});

test("test_a_sound_the_service_cant_perform_is_left_out", async () => {
  const tts = new PushTextTTSService();
  const requests = recordRequests(tts);
  const context = await contextAfter(tts, response("Ha [[snort]] okay."));

  expect(requests).toEqual(["Ha okay."]);
  // The context keeps the reply as written.
  expect(context).toEqual("Ha [[snort]] okay.");
});

test("test_a_pause_is_kept_within_the_services_range", async () => {
  const tts = new PushTextTTSService();
  const requests = recordRequests(tts);
  await runTest(tts, {
    framesToSend: response("One. [[pause 5000]] Two."),
    pipelineParams: EXPRESSIVE,
  });

  expect(requests).toEqual(["One.", "<1000ms> Two."]);
});

/** For a service that takes delivery with each request. */
class StyleAdapter extends BaseExpressionAdapter {
  override capabilities(): ExpressionCapabilities {
    return new ExpressionCapabilities({
      delivery: [new ExpressionTerm({ name: "calm" }), new ExpressionTerm({ name: "cheerful" })],
      deliveryScope: DeliveryScope.SENTENCE,
    });
  }

  override requestSettings(delivery: string[]): Record<string, unknown> {
    return delivery.length > 0 ? { style: delivery.join(" ") } : {};
  }
}

/** Records the delivery each request is spoken in, as a style. */
class StyleTTSService extends MockHttpPushTextTTSService {
  static override expressionAdapterClass = StyleAdapter;

  styles: [string, string][] = [];

  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    this.styles.push([text, (this.expressionSettings.style as string | undefined) ?? "plain"]);
    yield* super.runTts(text, contextId);
  }
}

test("test_each_request_is_given_the_delivery_it_is_spoken_in", async () => {
  const tts = new StyleTTSService();
  await runTest(tts, {
    framesToSend: [
      ...response("One. <<calm>> Two. Three. <<neutral>> Four. <<cheerful>> Five."),
      ...response("Six."),
    ],
    pipelineParams: EXPRESSIVE,
  });

  expect(tts.styles).toEqual([
    ["One.", "plain"],
    ["Two.", "calm"],
    ["Three.", "calm"],
    ["Four.", "plain"],
    ["Five.", "cheerful"],
    ["Six.", "plain"],
  ]);
});

test("test_each_sentence_states_its_delivery", async () => {
  // Not every service keeps delivery from one request to the next.
  const tts = new PushTextTTSService();
  const requests = recordRequests(tts);
  await runTest(tts, {
    framesToSend: response("<<calm>> One. Two. <<neutral>> Three."),
    pipelineParams: EXPRESSIVE,
  });

  expect(requests).toEqual(["<calm> One.", "<calm> Two.", "Three."]);
});

test("test_streamed_tokens_state_delivery_only_where_it_changes", async () => {
  const tts = new PushTextTTSService({ textAggregationMode: TextAggregationMode.TOKEN });
  const requests = recordRequests(tts);
  await runTest(tts, {
    framesToSend: response("<<calm>> One.", " Two."),
    pipelineParams: EXPRESSIVE,
  });

  expect(requests).toEqual(["<calm> One.", " Two."]);
});

test("test_each_response_starts_from_the_baseline_when_streaming_tokens", async () => {
  const tts = new PushTextTTSService({ textAggregationMode: TextAggregationMode.TOKEN });
  const requests = recordRequests(tts);
  await runTest(tts, {
    // The first response ends in text the parser holds until its end.
    framesToSend: [...response("<<calm>> One ^^two"), ...response("<<calm>> Three.")],
    pipelineParams: EXPRESSIVE,
  });

  expect(requests[requests.length - 1]).toEqual("<calm> Three.");
});

test("test_a_span_sets_the_delivery_of_its_whole_request", async () => {
  const tts = new StyleTTSService();
  await runTest(tts, {
    framesToSend: response("Your code is <<calm: A B 7>>. Anything else?"),
    pipelineParams: EXPRESSIVE,
  });

  expect(tts.styles).toEqual([
    ["Your code is A B 7.", "calm"],
    ["Anything else?", "plain"],
  ]);
});

test("test_a_request_is_spoken_in_the_delivery_its_words_start_in", async () => {
  const tts = new StyleTTSService();
  const [down] = await runTest(tts, {
    framesToSend: response("The code is <<calm>> four two. Anything else?"),
    pipelineParams: EXPRESSIVE,
  });

  // The change takes effect from the next request, as a delivery lasts until the next tag.
  expect(tts.styles).toEqual([
    ["The code is four two.", "plain"],
    ["Anything else?", "calm"],
  ]);
  expect(ttsTextFrames(down).map((f) => [f.text, f.delivery])).toEqual([
    ["The code is four two.", []],
    ["Anything else?", ["calm"]],
  ]);
});

/** Formats tags as bracketed markup, which its service reports back with its words. */
class MarkupAdapter extends BaseExpressionAdapter {
  override capabilities(): ExpressionCapabilities {
    return new ExpressionCapabilities({
      sounds: [new ExpressionTerm({ name: "laugh" })],
      delivery: [new ExpressionTerm({ name: "calm" })],
      pauseRangeMs: [100, 1000],
    });
  }

  override formatText(text: string, delivery: string[], previousDelivery: string[] | null): string {
    const previous = previousDelivery ?? [];
    const changed =
      delivery.length > 0 &&
      (delivery.length !== previous.length || delivery.some((d, i) => d !== previous[i]));
    return changed ? `[${delivery.join(" ")}] ${text}` : text;
  }

  override formatSound(name: string): string {
    return ` [${name}] `;
  }

  override formatPause(_durationMs: number): string {
    return " [pause] ";
  }
}

/** Reports each token it is sent, markup included, as ElevenLabs' alignment does. */
class ReportingTTSService extends _MockWordTimestampHttpTTSService {
  static override expressionAdapterClass = MarkupAdapter;
}

async function spokenWords(
  tts: TTSService,
  text: string,
): Promise<[[string, number | null][], string[]]> {
  const [[down], warnings] = await captureWarnings(() =>
    runTest(tts, { framesToSend: response(text), pipelineParams: EXPRESSIVE }),
  );
  return [ttsTextFrames(down).map((f) => [f.text, f.pts]), warnings];
}

test("test_a_sound_is_timed_by_the_markup_its_service_reports", async () => {
  const [words, warnings] = await spokenWords(new ReportingTTSService(), "It's [[laugh]] back.");

  // The markup the service reports times the sound.
  expect(words.map(([text]) => text)).toEqual(["It's", "laugh", "back."]);
  const [its, laugh, back] = words.map(([, pts]) => pts as number);
  expect(its!).toBeLessThan(laugh!);
  expect(laugh!).toBeLessThan(back!);
  expect(warnings.filter((w) => w.includes("Dropping word"))).toEqual([]);
});

test("test_a_sound_its_service_reports_is_reported_as_performed", async () => {
  const [down] = await runTest(new ReportingTTSService(), {
    framesToSend: response("It's [[laugh]] back."),
    pipelineParams: EXPRESSIVE,
  });

  const sound = ttsTextFrames(down).find((f) => f.textType === TextType.EXPRESSION_SOUND);
  expect(sound).toBeDefined();
  // Clients are told a sound was performed when it is spoken, in a segment of its own.
  expect(sound!.willBeSpoken).toBe(true);
  expect(sound!.segmentId).toBeNull();
});

test("test_reported_delivery_markup_is_not_spoken", async () => {
  const [words, warnings] = await spokenWords(
    new ReportingTTSService(),
    "<<calm>> It's [[laugh]] back.",
  );

  expect(words.map(([text]) => text)).toEqual(["It's", "laugh", "back."]);
  expect(warnings.filter((w) => w.includes("Dropping word"))).toEqual([]);
});

const SPAN_CASES: [string, [string, string[]][]][] = [
  [
    "<<calm>> It's <<neutral: A B 7>>, okay.",
    [
      ["It's", ["calm"]],
      ["A", []],
      ["B", []],
      ["7,", []],
      ["okay.", ["calm"]],
    ],
  ],
  [
    "Email <<calm: docs@acme.com>> today.",
    [
      ["Email", []],
      ["docs@acme.com", ["calm"]],
      ["today.", []],
    ],
  ],
];

for (const [text, spoken] of SPAN_CASES) {
  for (const service of [ReportingTTSService, WordTimestampTTSService]) {
    test(`test_a_spans_words_are_spoken_in_its_delivery[${text}-${service.name}]`, async () => {
      const [down] = await runTest(new service(), {
        framesToSend: response(text),
        pipelineParams: EXPRESSIVE,
      });

      expect(ttsTextFrames(down).map((f) => [f.text, f.delivery])).toEqual(spoken);
      expect(await contextAfter(new service(), response(text))).toEqual(text);
    });
  }
}

const SOUND_BEFORE_PUNCTUATION_CASES: [string, string[]][] = [
  ["Hi [[laugh]], there.", ["Hi,", "laugh", "there."]],
  ["It's ^^back^^ [[laugh]]! Bye.", ["It's", "back!", "laugh", "Bye."]],
  ["Really [[laugh]]? Yes.", ["Really?", "laugh", "Yes."]],
  ["Wait [[pause 300]]. Okay.", ["Wait.", "300", "Okay."]],
  ["See you [[laugh]]", ["See", "you", "laugh"]],
];

for (const [text, spoken] of SOUND_BEFORE_PUNCTUATION_CASES) {
  for (const service of [ReportingTTSService, WordTimestampTTSService]) {
    test(`test_a_sound_before_punctuation_is_reported_after_the_words_it_follows[${text}-${service.name}]`, async () => {
      const [words, warnings] = await spokenWords(new service(), text);

      expect(words.map(([word]) => word)).toEqual(spoken);
      expect(warnings.filter((w) => w.includes("Dropping word"))).toEqual([]);
      expect(await contextAfter(new service(), response(text))).toEqual(text);
    });
  }
}

for (const service of SERVICES) {
  test(`test_punctuation_after_emphasis_stays_with_it_in_the_context[${service.name}]`, async () => {
    const context = await contextAfter(new service(), response("It's ^^back^^! ^^Wow^^, nice."));

    expect(context).toEqual("It's ^^back^^! ^^Wow^^, nice.");
  });
}

test("test_expression_survives_markdown_stripped_before_the_tts", async () => {
  const tts = new PushTextTTSService();
  const requests = recordRequests(tts);
  await runTest(
    new Pipeline([new LLMTextProcessor({ textTransforms: [["*", stripMarkdown]] }), tts]),
    { framesToSend: response(WRITTEN), pipelineParams: EXPRESSIVE },
  );

  expect(requests.join("")).toEqual(
    "<cheerful> It's <laugh> <cheerful,emphasis> back up <cheerful> now.<400ms> <cheerful> Bye!",
  );
});

test("test_spacing_between_pieces_is_sent_as_written", async () => {
  const tts = new MockHttpPushTextTTSService();
  const requests = recordRequests(tts);
  await runTest(tts, {
    framesToSend: response("That is ^^very^^ ^^good^^ news."),
    pipelineParams: EXPRESSIVE,
  });

  expect(requests).toEqual(["That is very good news."]);
});

test("test_spacing_between_pieces_is_sent_as_written_when_streaming_tokens", async () => {
  const tts = new MockHttpPushTextTTSService({ textAggregationMode: TextAggregationMode.TOKEN });
  const requests = recordRequests(tts);
  await runTest(tts, {
    framesToSend: response("^^Wow^^ that's great."),
    pipelineParams: EXPRESSIVE,
  });

  expect(requests.join("")).toEqual("Wow that's great.");
});

test("test_a_response_after_a_tts_speak_frame_states_its_delivery", async () => {
  const tts = new PushTextTTSService({ textAggregationMode: TextAggregationMode.TOKEN });
  const requests = recordRequests(tts);
  await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "<<calm>> Hi." }), ...response("<<calm>> Three.")],
    pipelineParams: EXPRESSIVE,
  });

  expect(requests).toEqual(["<calm> Hi.", "<calm> Three."]);
});

test("test_a_patterns_match_is_spoken_as_it_is", async () => {
  // Tags are read in the text an LLM writes its reply in, not in a pattern's match.
  const tts = new PushTextTTSService();
  const requests = recordRequests(tts);
  const spelled = new AggregatedTextFrame({
    text: "ABC",
    textType: "spell",
    rawText: "<spell>ABC</spell>",
  });
  const context = await contextAfter(tts, [
    new LLMFullResponseStartFrame(),
    spelled,
    new LLMFullResponseEndFrame(),
  ]);

  expect(requests).toEqual(["ABC"]);
  expect(context).toEqual("<spell>ABC</spell>");
});

/** Streams each word's audio and timestamp after the request, as a WebSocket service does. */
class StreamingTTSService extends TTSService {
  static override expressionAdapterClass = BracketAdapter;

  constructor() {
    super({
      pushStartFrame: true,
      pushStopFrames: true,
      pushTextFrames: false,
      stopFrameTimeoutS: 0.2,
      sampleRate: 16000,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const words = pySplit(wordsOf(text));
    this.createTask(() => this._stream(words, contextId));
    yield null;
  }

  async _stream(words: string[], contextId: string): Promise<void> {
    for (const [i, word] of words.entries()) {
      await sleep(0.05);
      const audio = new TTSAudioRawFrame({
        audio: new Uint8Array(320),
        sampleRate: 16000,
        numChannels: 1,
        contextId,
      });
      await this.appendToAudioContext(contextId, audio);
      await this.addWordTimestamps([[word, i * 0.05]], contextId);
    }
  }
}

test("test_uninterruptible_speech_keeps_its_delivery_through_an_interruption", async () => {
  const speech = new TTSSpeakFrame({ text: "<<calm>> One two three four five six." });
  speech.interruptible = false;
  const [down] = await runTest(new StreamingTTSService(), {
    framesToSend: [
      speech,
      new SleepFrame({ sleep: 0.15 }),
      new InterruptionFrame(),
      new SleepFrame({ sleep: 0.8 }),
    ],
    pipelineParams: EXPRESSIVE,
  });

  const words = ttsTextFrames(down).map((f) => [f.text, f.delivery]);
  expect(words).toEqual(
    ["One", "two", "three", "four", "five", "six."].map((word) => [word, ["calm"]]),
  );
});
