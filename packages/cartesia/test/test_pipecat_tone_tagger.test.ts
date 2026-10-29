// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_pipecat_tone_tagger.py

/** Tests for the processor that tags an LLM's replies with Pipecat Tone. */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "@pipedog/asyncio";
import { PerceptionSignal } from "@pipedog/core/expressive/perception";
import { ExpressionGuidance, ExpressionPolicy } from "@pipedog/core/expressive/policy";
import {
  AggregatedTextFrame,
  ErrorFrame,
  ExpressionMetadataFrame,
  type Frame,
  LLMContextAssistantTurnFrame,
  LLMContextUserTurnFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  TTSMetadataFrame,
  UserTurnResponseCancelFrame,
} from "@pipedog/core/frames/frames";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { RTVISendTextFrame } from "@pipedog/core/processors/frameworks/rtvi/frames";
import * as _models from "@pipedog/core/processors/tone/_models";
import { encode, Layout, Message, TurnContext } from "@pipedog/core/processors/tone/tagger/_input";
import { LabelSpace, SentenceLabels, Span } from "@pipedog/core/processors/tone/tagger/_labels";
import {
  PipecatToneTagger,
  type PipecatToneTaggerModelOpener,
  type PipecatToneTaggerOptions,
} from "@pipedog/core/processors/tone/tagger/processor";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";

import { ElevenLabsAudioTagExpressionAdapter } from "../../elevenlabs/src/elevenlabs_adapter.ts";
import { PipecatToneTaggerModel } from "../../tone/src/tagger/model.ts";
import { CartesiaExpressionAdapter } from "../src/cartesia_adapter.ts";

const EXPRESSIVE = new PipelineParams({ enableExpressiveConversation: true });

const CARTESIA = new TTSMetadataFrame({
  serviceName: "tts",
  expression: new CartesiaExpressionAdapter().capabilities(),
});
const ELEVENLABS = new TTSMetadataFrame({
  serviceName: "tts",
  expression: new ElevenLabsAudioTagExpressionAdapter().capabilities(),
});

/** Labels each sentence from a script, keyed by the sentence. */
class FakeTaggerModel {
  labels: Record<string, SentenceLabels>;
  breathsPerReply: number | null;
  breathKinds: Record<string, number>;
  calls: [TurnContext, string[], string][] = [];
  #error: Error | null;

  constructor(
    labels: Record<string, SentenceLabels> | null = null,
    options: {
      breathsPerReply?: number | null;
      error?: Error | null;
      breathKinds?: Record<string, number> | null;
    } = {},
  ) {
    this.labels = labels ?? {};
    this.breathsPerReply = options.breathsPerReply ?? null;
    this.breathKinds = options.breathKinds ?? {};
    this.#error = options.error ?? null;
  }

  tag(turn: TurnContext, earlier: string[], sentence: string): SentenceLabels {
    this.calls.push([turn, earlier, sentence]);
    if (this.#error) {
      throw this.#error;
    }
    return Object.hasOwn(this.labels, sentence)
      ? (this.labels[sentence] as SentenceLabels)
      : new SentenceLabels();
  }
}

// `@pipedog/tone` depends on `@pipedog/core`, so in this monorepo core can't resolve
// it for the tagger's default opener. This opener is that default (upstream's
// `_open_model`), on `@pipedog/tone`'s `PipecatToneTaggerModel`, so patching its
// `download` / `load` (upstream's `__init__`) works as upstream's monkeypatching does.
const openModel: PipecatToneTaggerModelOpener = async (settings) => {
  if (settings.modelDir) {
    return await PipecatToneTaggerModel.load(settings.modelDir, { threads: settings.threads });
  }
  return await PipecatToneTaggerModel.download({
    size: settings.size,
    revision: settings.revision,
    threads: settings.threads,
  });
};

function newTagger(options: PipecatToneTaggerOptions = {}): PipecatToneTagger {
  return new PipecatToneTagger({ openModel, ...options });
}

const spies: { mockRestore(): void }[] = [];

// Each test loads its own model.
beforeEach(() => {
  _models._models.clear();
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  _models._models.clear();
});

function patchDownload(impl: (options?: any) => unknown) {
  spies.push(spyOn(PipecatToneTaggerModel, "download").mockImplementation(impl as any));
}

function patchLoad(impl: (modelDir: string | URL, options?: any) => unknown) {
  spies.push(spyOn(PipecatToneTaggerModel, "load").mockImplementation(impl as any));
}

/** A tagger whose model downloads as `model`. */
function _tagger(model: FakeTaggerModel): PipecatToneTagger {
  patchDownload(() => model);
  return newTagger();
}

function _reply(...chunks: string[]): Frame[] {
  return [
    new LLMFullResponseStartFrame(),
    ...chunks.map((chunk) => new LLMTextFrame({ text: chunk })),
    new LLMFullResponseEndFrame(),
  ];
}

function _expressive(policy: ExpressionPolicy): PipelineParams {
  return new PipelineParams({ enableExpressiveConversation: true, expressionPolicy: policy });
}

async function _tagged(
  model: FakeTaggerModel,
  frames: Frame[],
  params: PipelineParams = EXPRESSIVE,
): Promise<string[]> {
  const [down] = await runTest(_tagger(model), {
    framesToSend: [...frames],
    pipelineParams: params,
  });
  return down.filter((f) => f instanceof AggregatedTextFrame).map((f) => f.text);
}

function _texts(frames: Frame[]): string[] {
  return frames.filter((f) => f instanceof AggregatedTextFrame).map((f) => f.text);
}

function _roles(messages: Message[]): [string, string][] {
  return messages.map((m) => [m.role, m.text]);
}

test("test_the_tagger_announces_itself_both_ways_at_start", async () => {
  const [down, up] = await runTest(_tagger(new FakeTaggerModel()), {
    framesToSend: [],
    pipelineParams: EXPRESSIVE,
  });

  expect(down.filter((f) => f instanceof ExpressionMetadataFrame).length).toBeGreaterThan(0);
  expect(up.filter((f) => f instanceof ExpressionMetadataFrame).length).toBeGreaterThan(0);
});

test("test_labels_are_written_by_their_universal_names", async () => {
  const model = new FakeTaggerModel({
    "Congratulations!": new SentenceLabels({ delivery: "warm", soundAfter: "laugh" }),
    "Your code is A B 7.": new SentenceLabels({
      spans: [new Span({ start: 13, end: 18, delivery: "slow" })],
    }),
  });

  const tagged = await _tagged(model, [
    CARTESIA,
    ..._reply("Congratulations! Your code ", "is A B 7."),
  ]);

  expect(tagged).toEqual([
    "<<warm>> Congratulations! [[laugh]]",
    "<<neutral>> Your code is <<slow: A B 7>>.",
  ]);
});

test("test_a_delivery_is_written_only_where_it_changes", async () => {
  const calm = new SentenceLabels({ delivery: "calm" });
  const model = new FakeTaggerModel({ "I'm sorry.": calm, "I'll fix it.": calm });

  const tagged = await _tagged(model, [ELEVENLABS, ..._reply("I'm sorry. I'll fix it.")]);

  expect(tagged).toEqual(["<<calm>> I'm sorry.", "I'll fix it."]);
});

test("test_each_sentence_is_tagged_after_the_ones_before_it", async () => {
  const model = new FakeTaggerModel();

  await _tagged(model, [ELEVENLABS, ..._reply("One. Two. Three.")]);

  expect(model.calls.map(([, earlier, sentence]) => [earlier, sentence])).toEqual([
    [[], "One."],
    [["One."], "Two."],
    [["One.", "Two."], "Three."],
  ]);
});

test("test_the_policy_narrows_the_names_written", async () => {
  const model = new FakeTaggerModel({
    "Great!": new SentenceLabels({ delivery: "warm", soundBefore: "laugh" }),
  });
  const policy = new ExpressionPolicy({ delivery: ["calm"], sounds: [] });

  const tagged = await _tagged(model, [CARTESIA, ..._reply("Great!")], _expressive(policy));

  expect(tagged).toEqual(["Great!"]);
});

test("test_a_sentence_that_cant_be_tagged_is_spoken_untagged_with_an_error", async () => {
  const model = new FakeTaggerModel(null, { error: new Error("boom") });

  const [down, up] = await runTest(_tagger(model), {
    framesToSend: [ELEVENLABS, ..._reply("Hello there.")],
    pipelineParams: EXPRESSIVE,
  });

  expect(_texts(down)).toEqual(["Hello there."]);
  const errors = up.filter((f) => f instanceof ErrorFrame);
  expect(errors.length).toBeGreaterThan(0);
  expect(errors[0]?.fatal).toBeFalsy();
});

test("test_a_breath_is_offered_only_with_the_breathe_preset", async () => {
  const model = new FakeTaggerModel();

  await _tagged(model, [ELEVENLABS, ..._reply("Hi.")]);
  await _tagged(
    model,
    [ELEVENLABS, ..._reply("Hi.")],
    _expressive(new ExpressionPolicy({ guidance: [ExpressionGuidance.BREATHE] })),
  );

  const [without, withBreathe] = model.calls.map(([turn]) => turn.space) as [
    LabelSpace,
    LabelSpace,
  ];
  expect(Object.hasOwn(without.sounds, "breath")).toBe(false);
  expect(without.breaths).toEqual({});
  expect(withBreathe.sounds.breath).toBe("breath");
  expect(withBreathe.breaths).toEqual({
    "light breath": "light breath",
    "deep breath": "deep breath",
    exhale: "exhale",
  });
});

test("test_the_call_is_kept_from_the_turn_frames", async () => {
  const model = new FakeTaggerModel();
  const angry = [
    new PerceptionSignal({
      name: "emotion",
      labels: [
        ["angry", 0.62],
        ["disgusted", 0.2],
      ],
    }),
  ];

  await _tagged(model, [
    ELEVENLABS,
    new LLMContextAssistantTurnFrame({ text: "How can I help?", timestamp: "t0" }),
    new LLMContextUserTurnFrame({ text: "My order is late.", timestamp: "t1", perception: angry }),
    ..._reply("Sorry."),
  ]);

  const turn = model.calls[0]?.[0] as TurnContext;
  expect(_roles(turn.messages)).toEqual([
    ["assistant", "How can I help?"],
    ["user", "My order is late."],
  ]);
  // The reader's emotions, folded into the tones the model reads.
  expect(turn.heard).toEqual([
    new PerceptionSignal({ name: "tone", labels: [["frustrated", 0.82]] }),
  ]);
});

test("test_each_reply_is_tagged_knowing_the_labels_of_the_one_before", async () => {
  const calm = new SentenceLabels({ delivery: "calm" });
  const model = new FakeTaggerModel({ "I'm sorry.": calm });

  await _tagged(model, [ELEVENLABS, ..._reply("I'm sorry. Let me look."), ..._reply("Done.")]);

  const [first, , second] = model.calls.map(([turn]) => turn) as [
    TurnContext,
    TurnContext,
    TurnContext,
  ];
  expect(first.previous).toBeNull();
  expect(second.previous).toEqual([calm, new SentenceLabels()]);
});

test("test_breaths_past_the_models_limit_for_a_reply_are_dropped", async () => {
  const breath = new SentenceLabels({ soundBefore: "breath" });
  const model = new FakeTaggerModel({ "One.": breath, "Two.": breath }, { breathsPerReply: 1 });
  const policy = new ExpressionPolicy({ guidance: [ExpressionGuidance.BREATHE] });

  const tagged = await _tagged(model, [ELEVENLABS, ..._reply("One. Two.")], _expressive(policy));

  expect(tagged).toEqual(["[[breath]] One.", "Two."]);
});

const BREATHE = _expressive(new ExpressionPolicy({ guidance: [ExpressionGuidance.BREATHE] }));

test.each(["light breath", "deep breath", "exhale"])(
  "test_each_breath_is_drawn_as_a_kind_at_the_models_shares[%s]",
  async (kind) => {
    const model = new FakeTaggerModel(
      { "One.": new SentenceLabels({ soundBefore: "breath" }) },
      { breathKinds: { [kind]: 1.0 } },
    );

    const tagged = await _tagged(model, [ELEVENLABS, ..._reply("One.")], BREATHE);

    expect(tagged).toEqual([`[[${kind}]] One.`]);
  },
);

test("test_a_call_draws_its_breaths_alike_each_time", async () => {
  const breath = new SentenceLabels({ soundBefore: "breath" });
  const kinds = { "light breath": 0.59, "deep breath": 0.36, exhale: 0.05 };
  const ns = [...Array(8).keys()];
  const replies = ns.flatMap((n) => _reply(`Reply ${n}.`));
  const labels = Object.fromEntries(ns.map((n) => [`Reply ${n}.`, breath]));

  const runs: string[][] = [];
  for (let i = 0; i < 2; i++) {
    runs.push(
      await _tagged(
        new FakeTaggerModel(labels, { breathKinds: kinds }),
        [ELEVENLABS, ...replies],
        BREATHE,
      ),
    );
  }
  const [first, second] = runs as [string[], string[]];

  expect(first).toEqual(second);
  const allowed = new Set(["[[light breath", "[[deep breath", "[[exhale"]);
  for (const prefix of new Set(first.map((tagged) => tagged.split("]]")[0]))) {
    expect(allowed.has(prefix as string)).toBe(true);
  }
});

test("test_the_next_reply_reads_a_drawn_breath_as_a_breath", async () => {
  const breath = new SentenceLabels({ soundBefore: "breath" });
  const model = new FakeTaggerModel({ "One.": breath }, { breathKinds: { exhale: 1.0 } });

  await _tagged(model, [ELEVENLABS, ..._reply("One."), ..._reply("Two.")], BREATHE);

  const second = model.calls[1]?.[0] as TurnContext;
  expect(second.previous).toEqual([breath]);
});

test("test_a_policy_that_names_one_breath_draws_only_that_kind", async () => {
  const breath = new SentenceLabels({ soundBefore: "breath" });
  const ns = [...Array(6).keys()];
  const model = new FakeTaggerModel(Object.fromEntries(ns.map((n) => [`Reply ${n}.`, breath])), {
    breathKinds: { "light breath": 0.5, exhale: 0.5 },
  });
  const policy = new ExpressionPolicy({
    guidance: [ExpressionGuidance.BREATHE],
    sounds: ["light breath"],
  });
  const replies = ns.flatMap((n) => _reply(`Reply ${n}.`));

  const tagged = await _tagged(model, [ELEVENLABS, ...replies], _expressive(policy));

  expect(tagged).toEqual(ns.map((n) => `[[light breath]] Reply ${n}.`));
});

test("test_a_policy_that_names_only_a_kind_still_breathes", async () => {
  const breath = new SentenceLabels({ soundBefore: "breath" });
  const model = new FakeTaggerModel(
    { "One.": breath },
    { breathKinds: { "light breath": 0.5, "deep breath": 0.5 } },
  );
  const policy = new ExpressionPolicy({
    guidance: [ExpressionGuidance.BREATHE],
    sounds: ["deep breath"],
  });

  const tagged = await _tagged(model, [ELEVENLABS, ..._reply("One.")], _expressive(policy));

  expect(tagged).toEqual(["[[deep breath]] One."]);
});

test("test_a_name_for_breath_is_written_for_every_breath", async () => {
  const model = new FakeTaggerModel(
    { "One.": new SentenceLabels({ soundBefore: "breath" }) },
    { breathKinds: { exhale: 1.0 } },
  );
  patchDownload(() => model);

  const [down] = await runTest(newTagger({ vocabulary: { breath: ["inhales deeply"] } }), {
    framesToSend: [ELEVENLABS, ..._reply("One.")],
    pipelineParams: BREATHE,
  });

  expect(_texts(down)).toEqual(["[[inhales deeply]] One."]);
});

test("test_a_models_breath_kinds_come_from_its_config", () => {
  const model = Object.create(PipecatToneTaggerModel.prototype) as PipecatToneTaggerModel;

  model.config = { breath_kinds: { "light breath": 0.6, exhale: 0.4 } };
  expect(model.breathKinds).toEqual({ "light breath": 0.6, exhale: 0.4 });
  // A model without them writes a plain breath.
  model.config = {};
  expect(model.breathKinds).toEqual({});
});

/** A sentence's labels from a model's six heads: the sound before's logits and the breath head's. */
function _decoded(before: number[], breath: number, sentence = "Hi."): SentenceLabels {
  const model = Object.create(PipecatToneTaggerModel.prototype) as PipecatToneTaggerModel;
  model.config = {
    deliveries: ["none", "calm"],
    sounds: ["none", "laugh", "chuckle", "sigh", "breath"],
    sound_bias: {
      breath: [
        [5, -1.0],
        [null, 0.0],
      ],
    },
  };
  const space = new LabelSpace({
    deliveries: { calm: "calm" },
    sounds: { laugh: "laughs", breath: "quick breath" },
    emphasis: false,
  });
  const quiet = [9.0, 0.0, 0.0, 0.0, 0.0];
  const tokens = [[9.0, 0.0, 0.0]];
  const heads = [[9.0, 0.0], [...before], quiet, tokens, tokens, [breath]];
  return model._decode(heads, [[0, 2]], sentence, space);
}

test("test_a_breath_comes_from_its_own_head_shifted_for_the_sentences_length", () => {
  const quiet = [9.0, 0.0, 0.0, 0.0, 0.0];

  // Up to five words, the breath head's logit is shifted down by one.
  expect(_decoded(quiet, 0.5).soundBefore).toBeNull();
  expect(_decoded(quiet, 0.5, "Hi ".repeat(6)).soundBefore).toBe("breath");
});

test("test_the_sound_heads_never_choose_a_breath", () => {
  const breathClassWins = [0.0, 0.0, 0.0, 0.0, 9.0];

  expect(_decoded(breathClassWins, -1.0, "Hi ".repeat(6)).soundBefore).toBeNull();
});

test("test_a_breath_goes_only_where_no_other_sound_starts_the_sentence", () => {
  const laugh = [0.0, 9.0, 0.0, 0.0, 0.0];

  expect(_decoded(laugh, 9.0, "Hi ".repeat(6)).soundBefore).toBe("laugh");
});

test("test_a_sentence_is_read_as_the_text_the_model_was_trained_on", () => {
  const policy = new ExpressionPolicy({
    guidance: [
      ExpressionGuidance.MATCH_STYLE,
      ExpressionGuidance.SLOW_FOR_DETAILS,
      ExpressionGuidance.BREATHE,
    ],
  });
  const heard = [
    new PerceptionSignal({
      name: "tone",
      labels: [
        ["frustrated", 0.62],
        ["neutral", 0.3],
      ],
    }),
  ];
  const space = LabelSpace.resolve(
    new ElevenLabsAudioTagExpressionAdapter().capabilities(),
    policy,
    "ElevenLabsTTSService#0",
  );
  const turn = new TurnContext({
    messages: [
      new Message({ role: "assistant", text: "Thanks for calling. How can I help?" }),
      new Message({ role: "user", text: "I need my new booking code.", heard }),
    ],
    space,
    policy,
    previous: [
      new SentenceLabels({ delivery: "calm" }),
      new SentenceLabels({ soundBefore: "breath" }),
    ],
  });
  // tagger-rc1's layout.
  const layout = new Layout({ earlier: 1, maxTokens: 160, previousTags: true });

  const [call, sentence, start] = encode(
    turn,
    ["Sure, one moment."],
    "Your new code is AB12CD.",
    layout,
  );

  // What training wrote for this turn.
  expect(call).toBe("caller (tone frustrated likely, neutral guess): I need my new booking code.");
  expect(sentence).toBe(
    "tts elevenlabs | can calm sympathetic apologetic warm excited surprised sad grateful " +
      "curious confident slow fast | sounds laugh chuckle sigh breath | stress yes | policy " +
      "match style, slow for details, breathe | caller sounded tone frustrated likely, neutral " +
      "guess | last reply calm breath | state new detail | reply so far: Sure, one moment. | " +
      "sentence: Your new code is AB12CD.",
  );
  expect(start).toBe(354);
});

test("test_a_service_the_model_wasnt_trained_with_is_read_as_other", () => {
  const capabilities = new ElevenLabsAudioTagExpressionAdapter().capabilities();

  expect(
    LabelSpace.resolve(capabilities, new ExpressionPolicy(), "ElevenLabsTTSService#0").tts,
  ).toBe("elevenlabs");
  expect(LabelSpace.resolve(capabilities, new ExpressionPolicy(), "MyTTSService#0").tts).toBe(
    "other",
  );
});

test("test_a_layout_that_reads_no_turns_reads_none_of_the_call", () => {
  const turn = new TurnContext({
    messages: [new Message({ role: "user", text: "My order is late." })],
    space: new LabelSpace({ deliveries: {}, sounds: {}, emphasis: false }),
    policy: new ExpressionPolicy(),
    previous: null,
  });

  const [call] = encode(turn, [], "Sorry.", new Layout({ contextTurns: 0 }));

  expect(call).toBe("");
});

test("test_text_the_user_typed_is_part_of_the_call", async () => {
  const model = new FakeTaggerModel();

  await _tagged(model, [
    ELEVENLABS,
    new LLMContextAssistantTurnFrame({ text: "How can I help?", timestamp: "t0" }),
    // RTVI drains the pipeline before it appends text that runs at once.
    new SleepFrame({ sleep: 0.05 }),
    new RTVISendTextFrame({ msgId: "1", text: "The spots have resolved!" }),
    ..._reply("That's encouraging news."),
  ]);

  const turn = model.calls[0]?.[0] as TurnContext;
  expect(_roles(turn.messages)).toEqual([
    ["assistant", "How can I help?"],
    ["user", "The spots have resolved!"],
  ]);
  expect(turn.heard).toBeNull();
});

test("test_a_confirmed_turn_replaces_its_speculation_where_it_stands", async () => {
  const model = new FakeTaggerModel();

  await _tagged(model, [
    ELEVENLABS,
    new LLMContextUserTurnFrame({ text: "My order", timestamp: "t1", speculation: true }),
    ..._reply("Sorry."),
    new LLMContextAssistantTurnFrame({ text: "Sorry.", timestamp: "t2" }),
    new LLMContextUserTurnFrame({ text: "My order is late.", timestamp: "t1" }),
    ..._reply("Next."),
  ]);

  const [early, later] = model.calls.map(([turn]) => turn) as [TurnContext, TurnContext];
  expect(_roles(early.messages)).toEqual([["user", "My order"]]);
  expect(_roles(later.messages)).toEqual([
    ["user", "My order is late."],
    ["assistant", "Sorry."],
  ]);
});

test("test_a_withdrawn_speculation_leaves_the_call", async () => {
  const model = new FakeTaggerModel();

  await _tagged(model, [
    ELEVENLABS,
    new LLMContextAssistantTurnFrame({ text: "How can I help?", timestamp: "t0" }),
    new LLMContextUserTurnFrame({ text: "My order", timestamp: "t1", speculation: true }),
    new SleepFrame({ sleep: 0.05 }),
    new UserTurnResponseCancelFrame(),
    new LLMContextAssistantTurnFrame({ text: "Take your time.", timestamp: "t2" }),
    new LLMContextUserTurnFrame({ text: "My order is late.", timestamp: "t3" }),
    ..._reply("Sorry."),
  ]);

  const turn = model.calls[0]?.[0] as TurnContext;
  expect(_roles(turn.messages)).toEqual([
    ["assistant", "How can I help?"],
    ["assistant", "Take your time."],
    ["user", "My order is late."],
  ]);
});

test("test_replies_pass_through_when_the_tts_performs_nothing", async () => {
  const model = new FakeTaggerModel();

  const tagged = await _tagged(model, [
    new TTSMetadataFrame({ serviceName: "tts", expression: null }),
    ..._reply("Hello there."),
  ]);

  expect(tagged).toEqual(["Hello there."]);
  expect(model.calls.length).toBe(0);
});

test("test_without_expressive_conversation_nothing_is_tagged_or_announced", async () => {
  const model = new FakeTaggerModel();

  const [down, up] = await runTest(_tagger(model), {
    framesToSend: [ELEVENLABS, ..._reply("Hello there.")],
  });

  expect(_texts(down)).toEqual(["Hello there."]);
  expect([...down, ...up].filter((f) => f instanceof ExpressionMetadataFrame).length).toBe(0);
  expect(model.calls.length).toBe(0);
});

test("test_the_tts_metadata_goes_on_unchanged", async () => {
  const [, up] = await runTest(_tagger(new FakeTaggerModel()), {
    framesToSend: [ELEVENLABS],
    framesToSendDirection: FrameDirection.UPSTREAM,
    pipelineParams: EXPRESSIVE,
  });

  expect(up.filter((f) => f instanceof TTSMetadataFrame).map((f) => f.expression)).toEqual([
    ELEVENLABS.expression,
  ]);
});

test("test_a_model_that_cant_load_leaves_the_tagger_unusable", async () => {
  const fail = () => {
    throw new Error("no network");
  };

  patchDownload(fail);
  const tagger = newTagger();

  const [down, up] = await runTest(tagger, {
    framesToSend: [ELEVENLABS, ..._reply("<<calm>> Hello there.")],
    pipelineParams: EXPRESSIVE,
  });

  expect(tagger.isUsable).toBe(false);
  expect(up.filter((f) => f instanceof ErrorFrame).length).toBeGreaterThan(0);
  // The LLM is still taught the tags, and its reply is spoken as it wrote it.
  expect([...down, ...up].filter((f) => f instanceof ExpressionMetadataFrame).length).toBe(0);
  expect(_texts(down)).toEqual(["<<calm>> Hello there."]);
});

test("test_the_pipeline_starts_once_the_model_has_loaded", async () => {
  const slow = async () => {
    await sleep(0.2);
    return new FakeTaggerModel({ "Hello there.": new SentenceLabels({ delivery: "calm" }) });
  };

  patchDownload(slow);

  const [down] = await runTest(newTagger(), {
    framesToSend: [ELEVENLABS, ..._reply("Hello there.")],
    pipelineParams: EXPRESSIVE,
  });

  const announced = down.findIndex((f) => f instanceof ExpressionMetadataFrame);
  const reply = down.findIndex((f) => f instanceof AggregatedTextFrame);
  expect(announced).toBeGreaterThanOrEqual(0);
  expect(reply).toBeGreaterThanOrEqual(0);
  expect(announced).toBeLessThan(reply);
  expect((down[reply] as AggregatedTextFrame).text).toBe("<<calm>> Hello there.");
});

test("test_every_tagger_shares_one_model", async () => {
  const model = new FakeTaggerModel();
  const loads: unknown[] = [];

  const download = (options?: unknown) => {
    loads.push(options);
    return model;
  };

  patchDownload(download);

  for (let i = 0; i < 2; i++) {
    await runTest(newTagger(), { framesToSend: [], pipelineParams: EXPRESSIVE });
  }

  expect(loads.length).toBe(1);
});

test("test_the_model_downloads_at_the_size_and_release_asked_for", async () => {
  const asked: unknown[] = [];

  const download = (options?: unknown) => {
    asked.push(options);
    return new FakeTaggerModel();
  };

  patchDownload(download);
  for (const tagger of [newTagger(), newTagger({ size: "32m", revision: "tagger-rc9" })]) {
    await runTest(tagger, { framesToSend: [], pipelineParams: EXPRESSIVE });
  }

  expect(asked).toEqual([
    { size: "17m", revision: "tagger-rc1", threads: 1 },
    { size: "32m", revision: "tagger-rc9", threads: 1 },
  ]);
});

// DIVERGENCE (see `@pipedog/tone`'s tagger model): upstream downloads the folder's every
// file (`snapshot_download(..., allow_patterns=["tagger/<size>/*"])`); the port fetches
// `config.json`, `tokenizer.json` and the ONNX file `config.json` names, each from the
// size's folder.
test("test_each_size_downloads_its_own_folder", async () => {
  const tmpPath = await mkdtemp(join(tmpdir(), "pipecat-tone-tagger-"));
  try {
    const seen: Record<string, unknown> = {};
    const urls: string[] = [];

    // Stands in for `snapshot_download`: the download fetches each file it asks for.
    const fetchFile = async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(String(url).endsWith("/config.json") ? '{"onnx": "model.onnx"}' : "{}");
    };
    patchLoad((modelDir) => {
      seen.dir = String(modelDir);
      return {};
    });

    await PipecatToneTaggerModel.download({
      size: "32m",
      downloadRoot: tmpPath,
      endpoint: "https://huggingface.co",
      fetch: fetchFile as typeof fetch,
    });

    // `<endpoint>/<repo>/resolve/<revision>/<pattern>`
    const parsed = urls.map((u) => {
      const m = /^https:\/\/huggingface\.co\/(.+?)\/resolve\/([^/]+)\/(.+)$/.exec(u);
      if (!m) throw new Error(`unexpected download URL: ${u}`);
      return { repo: m[1], revision: decodeURIComponent(m[2] as string), pattern: m[3] };
    });
    seen.repo = [...new Set(parsed.map((p) => p.repo))].join();
    seen.revision = [...new Set(parsed.map((p) => p.revision))].join();
    seen.patterns = parsed.map((p) => p.pattern);

    // The snapshot's root, as `snapshot_download` returns it.
    const root = `${tmpPath}/pipecat-ai--tone-models@tagger-rc1`;
    expect(seen).toEqual({
      repo: "pipecat-ai/tone-models",
      revision: "tagger-rc1",
      patterns: ["tagger/32m/config.json", "tagger/32m/tokenizer.json", "tagger/32m/model.onnx"],
      dir: `${root}/tagger/32m`,
    });
  } finally {
    await rm(tmpPath, { recursive: true, force: true });
  }
});

test("test_a_folder_of_your_own_loads_in_place_of_a_download", async () => {
  const tmpPath = await mkdtemp(join(tmpdir(), "pipecat-tone-tagger-"));
  try {
    const loaded: [string, unknown][] = [];

    const fail = () => {
      throw new Error("no network");
    };

    patchDownload(fail);
    patchLoad((modelDir, options) => {
      loaded.push([String(modelDir), (options as { threads?: number }).threads]);
      return Object.create(PipecatToneTaggerModel.prototype);
    });

    let down: Frame[] = [];
    for (const tagger of [0, 1].map(() => newTagger({ modelDir: tmpPath, threads: 2 }))) {
      [down] = await runTest(tagger, { framesToSend: [], pipelineParams: EXPRESSIVE });
    }

    // Loaded once a process, and shared.
    expect(loaded).toEqual([[tmpPath, 2]]);
    expect(down.filter((f) => f instanceof ExpressionMetadataFrame).length).toBeGreaterThan(0);
  } finally {
    await rm(tmpPath, { recursive: true, force: true });
  }
});

test("test_a_vocabulary_names_a_label_first_where_the_service_performs_it", async () => {
  const model = new FakeTaggerModel();
  patchDownload(() => model);
  const vocabulary = { warm: ["cheerful"], laugh: ["giggles"] };

  for (const tts of [ELEVENLABS, CARTESIA]) {
    _models._models.clear();
    await runTest(newTagger({ vocabulary }), {
      framesToSend: [tts, ..._reply("Hi.")],
      pipelineParams: EXPRESSIVE,
    });
  }

  const [elevenlabs, cartesia] = model.calls.map(([turn]) => turn.space) as [
    LabelSpace,
    LabelSpace,
  ];
  // ElevenLabs takes free text, so it performs both names.
  expect(elevenlabs.deliveries.warm).toBe("cheerful");
  expect(elevenlabs.sounds.laugh).toBe("giggles");
  // Cartesia performs neither, so the universal names stand.
  expect(cartesia.deliveries.warm).toBe("warm");
  expect(cartesia.sounds.laugh).toBe("laugh");
});

test("test_a_vocabulary_for_a_label_the_tagger_doesnt_write_is_refused", () => {
  expect(() => newTagger({ vocabulary: { cheerful: ["happy"] } as any })).toThrow(/cheerful/);
});
