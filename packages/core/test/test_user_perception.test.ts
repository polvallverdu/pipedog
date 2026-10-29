// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_user_perception.py

/** Tests for how the user aggregator writes how the user spoke into the context. */

import { expect, test } from "bun:test";

import { formatPerception, PerceptionSignal } from "../src/expressive/perception.ts";
import {
  EagerTranscriptionFrame,
  type Frame,
  InterimTranscriptionFrame,
  LLMContextFrame,
  LLMContextUserTurnFrame,
  ProposedUserStartedSpeakingFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { PipelineParams } from "../src/pipeline/worker.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import {
  LLMUserAggregator,
  LLMUserAggregatorParams,
  type UserTurnStoppedMessage,
} from "../src/processors/aggregators/llm_response_universal.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import { SpeechTimeoutUserTurnStopStrategy } from "../src/turns/user_stop/speech_timeout_user_turn_stop_strategy.ts";
import { EagerUserTurnStrategies, UserTurnStrategies } from "../src/turns/user_turn_strategies.ts";

const EXPRESSIVE = new PipelineParams({ enableExpressiveConversation: true });
const TIMEOUT = 0.1;

const FRUSTRATED = [
  new PerceptionSignal({
    name: "tone",
    labels: [
      ["frustrated", 0.86],
      ["neutral", 0.1],
    ],
  }),
];
const NEUTRAL = [
  new PerceptionSignal({
    name: "tone",
    labels: [
      ["neutral", 0.81],
      ["positive", 0.12],
    ],
  }),
];

function _interim(words: string, perception: PerceptionSignal[]): InterimTranscriptionFrame {
  return new InterimTranscriptionFrame({ text: words, userId: "", timestamp: "now", perception });
}

function _turn(
  words: string,
  perception: PerceptionSignal[] | null = null,
  { before = null }: { before?: Frame[] | null } = {},
): Frame[] {
  return [
    new VADUserStartedSpeakingFrame(),
    ...(before ?? []),
    new TranscriptionFrame({ text: words, userId: "", timestamp: "now", perception }),
    new SleepFrame(),
    new VADUserStoppedSpeakingFrame(),
    new SleepFrame({ sleep: TIMEOUT + 0.1 }),
  ];
}

function _aggregator(context: LLMContext): LLMUserAggregator {
  return new LLMUserAggregator(context, {
    params: new LLMUserAggregatorParams({
      userTurnStrategies: new UserTurnStrategies({
        stop: [new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TIMEOUT })],
      }),
    }),
  });
}

async function _userMessages(
  turns: Frame[][],
  params: PipelineParams | null = EXPRESSIVE,
): Promise<[unknown[], Frame[]]> {
  const context = new LLMContext();
  const aggregator = _aggregator(context);
  const [down] = await runTest(aggregator, {
    framesToSend: turns.flat(),
    pipelineParams: params,
  });
  const messages = (context.messages as { role?: string; content?: unknown }[])
    .filter((m) => m.role === "user")
    .map((m) => m.content);
  return [messages, down];
}

test("test_a_reading_formats_labels_with_confidences_and_values", () => {
  const signals = [...FRUSTRATED, new PerceptionSignal({ name: "speech_rate", value: 4.1 })];

  expect(formatPerception(signals)).toBe(
    "([tone frustrated=0.86, neutral=0.10],[speech_rate value=4.1])",
  );
});

test("test_the_reading_is_written_at_the_head_of_the_user_message", async () => {
  const [messages, down] = await _userMessages([
    _turn("Can you tell me where my order is?", FRUSTRATED),
  ]);

  expect(messages).toEqual([
    "([tone frustrated=0.86, neutral=0.10]) Can you tell me where my order is?",
  ]);
  const turnFrames = down.filter((f) => f instanceof LLMContextUserTurnFrame);
  expect(turnFrames[0]!.text).toBe("Can you tell me where my order is?");
  expect(turnFrames[0]!.perception).toEqual(FRUSTRATED);
});

test("test_nothing_is_written_without_expressive_conversation", async () => {
  const [messages, down] = await _userMessages(
    [_turn("Can you tell me where my order is?", FRUSTRATED)],
    null,
  );

  expect(messages).toEqual(["Can you tell me where my order is?"]);
  const turnFrames = down.filter((f) => f instanceof LLMContextUserTurnFrame);
  expect(turnFrames[0]!.perception).toBeNull();
});

test("test_a_provisional_reading_is_not_written", async () => {
  const [messages] = await _userMessages([
    _turn("Can you tell me where my order is?", null, {
      before: [_interim("Can you tell me", FRUSTRATED)],
    }),
  ]);

  expect(messages).toEqual(["Can you tell me where my order is?"]);
});

test("test_the_turns_latest_final_reading_is_written", async () => {
  const [messages] = await _userMessages([
    _turn("where my order is?", FRUSTRATED, {
      before: [
        new TranscriptionFrame({
          text: "Can you tell me",
          userId: "",
          timestamp: "now",
          perception: NEUTRAL,
        }),
      ],
    }),
  ]);

  expect(messages).toEqual([
    "([tone frustrated=0.86, neutral=0.10]) Can you tell me where my order is?",
  ]);
});

/** The user message an early reply is generated from, and the turn broadcast ahead of it. */
async function _earlyTurn(
  perception: PerceptionSignal[] | null,
  params: PipelineParams | null = EXPRESSIVE,
): Promise<[unknown, LLMContextUserTurnFrame]> {
  const aggregator = new LLMUserAggregator(new LLMContext(), {
    params: new LLMUserAggregatorParams({ userTurnStrategies: new EagerUserTurnStrategies() }),
  });
  const [down] = await runTest(aggregator, {
    framesToSend: [
      new ProposedUserStartedSpeakingFrame(),
      new SleepFrame(),
      new EagerTranscriptionFrame({
        text: "Can you tell me where my order is?",
        userId: "",
        timestamp: "now",
        perception,
      }),
      new SleepFrame(),
    ],
    pipelineParams: params,
  });
  const provisional = down.find(
    (f): f is LLMContextFrame => f instanceof LLMContextFrame && f.speculation,
  );
  if (!provisional) throw new Error("StopIteration");
  const turn = down.find(
    (f): f is LLMContextUserTurnFrame => f instanceof LLMContextUserTurnFrame && f.speculation,
  );
  if (!turn) throw new Error("StopIteration");
  const last = provisional.context.messages.at(-1) as { content?: unknown };
  return [last.content, turn];
}

test("test_an_early_reply_reads_the_eager_reading", async () => {
  const [message, turn] = await _earlyTurn(FRUSTRATED);

  expect(message).toBe("([tone frustrated=0.86, neutral=0.10]) Can you tell me where my order is?");
  expect(turn.perception).toEqual(FRUSTRATED);
});

test("test_an_eager_reading_is_not_written_without_expressive_conversation", async () => {
  const [message, turn] = await _earlyTurn(FRUSTRATED, null);

  expect(message).toBe("Can you tell me where my order is?");
  expect(turn.perception).toBeNull();
});

test("test_a_reading_belongs_to_its_own_turn", async () => {
  const [messages] = await _userMessages([
    _turn("Can you tell me where my order is?", FRUSTRATED),
    _turn("Thanks."),
  ]);

  expect(messages).toEqual([
    "([tone frustrated=0.86, neutral=0.10]) Can you tell me where my order is?",
    "Thanks.",
  ]);
});

async function _stopped(
  turns: Frame[][],
  params: PipelineParams | null = EXPRESSIVE,
): Promise<UserTurnStoppedMessage[]> {
  const aggregator = _aggregator(new LLMContext());
  const stopped: UserTurnStoppedMessage[] = [];

  aggregator.eventHandler(
    "on_user_turn_stopped",
    async (_aggregator: unknown, _strategy: unknown, message: UserTurnStoppedMessage) => {
      stopped.push(message);
    },
  );

  await runTest(aggregator, {
    framesToSend: turns.flat(),
    pipelineParams: params,
  });
  return stopped;
}

test("test_the_turn_stops_with_its_final_reading", async () => {
  const stopped = await _stopped([
    _turn("Can you tell me where my order is?", FRUSTRATED),
    _turn("Thanks."),
  ]);

  expect(stopped.map((m) => m.perception)).toEqual([FRUSTRATED, null]);
});

test("test_a_provisional_reading_is_not_reported_with_the_turn", async () => {
  const stopped = await _stopped([
    _turn("Can you tell me where my order is?", null, {
      before: [_interim("Can you tell me", NEUTRAL)],
    }),
  ]);

  expect(stopped[0]!.perception).toBeNull();
});

test("test_nothing_is_reported_without_expressive_conversation", async () => {
  const stopped = await _stopped([_turn("Can you tell me where my order is?", FRUSTRATED)], null);

  expect(stopped[0]!.perception).toBeNull();
});
