// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_evals_judge.py

import { describe, expect, test } from "bun:test";

import {
  BaseClassifier,
  type ChoiceQuestion,
  ChoiceResult,
  ClassifierError,
  type ClassifierQuestion,
  type ClassifierResult,
  type ClassifierValue,
  YesNoResult,
} from "@pipedog/core/classifiers/base_classifier";
import { LLMClassifier } from "@pipedog/core/classifiers/llm/classifier";
import type { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import type { LLMService } from "@pipedog/core/services/llm_service";

import {
  _Explainer,
  EvalJudge,
  type EvalJudgeOptions,
  EXPLAIN_SYSTEM_INSTRUCTION,
  JudgeVerdict,
} from "../src/judge.ts";

const REPLY_OPTIONS = ["yes", "no", "continue"] as const;
const TURN_OPTIONS = ["meets", "fails", "not_applicable"] as const;

type State = Record<string, unknown>;
type Answers = Record<string, ClassifierResult> | Error;
type Responder = (state: State, questions: Readonly<Record<string, ClassifierQuestion>>) => Answers;

interface Asked {
  state: State;
  questions: Record<string, ChoiceQuestion & { options: Record<string, unknown> }>;
}

/**
 * Answers with queued results, or with a function of the state it is asked about.
 *
 * Records every question, so a test can check what the judge asked and what
 * it sent as the state. A queued exception is raised instead of answered.
 */
class _FakeClassifier extends BaseClassifier {
  protected _answers: Answers[] | Responder;
  asked: Asked[] = [];

  constructor(answers: Answers[] | Responder) {
    super();
    this._answers = answers;
  }

  protected async _ask(
    state: ClassifierValue,
    questions: Readonly<Record<string, ClassifierQuestion>>,
  ): Promise<[Record<string, ClassifierResult>, null]> {
    this.asked.push({ state: state as State, questions: { ...questions } as Asked["questions"] });
    const answer =
      typeof this._answers === "function"
        ? this._answers(state as State, questions)
        : (this._answers.shift() as Answers);
    if (answer instanceof Error) {
      throw answer;
    }
    return [answer, null];
  }
}

interface Call {
  ask: string;
  system_instruction: string | null | undefined;
  max_tokens: number | null | undefined;
  response_schema: Record<string, unknown> | null | undefined;
}

/** Returns a queued answer to every inference, and records the call; a queued exception is raised. */
class _FakeLLMService {
  protected _responses: (string | Error)[];
  calls: Call[] = [];
  settings = { model: "fake-model" };

  constructor(responses: (string | Error)[]) {
    this._responses = [...responses];
  }

  async runInference(
    context: LLMContext,
    options: {
      maxTokens?: number | null;
      systemInstruction?: string | null;
      responseSchema?: Record<string, unknown> | null;
    } = {},
  ): Promise<string> {
    const messages = context.messages;
    this.calls.push({
      ask: (messages[messages.length - 1] as { content: string }).content,
      system_instruction: options.systemInstruction,
      max_tokens: options.maxTokens,
      response_schema: options.responseSchema,
    });
    if (this._responses.length === 0) {
      throw new Error("FakeLLMService: no more queued responses");
    }
    const response = this._responses.shift() as string | Error;
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

const asLlm = (llm: _FakeLLMService) => llm as unknown as LLMService;

function _choice(
  choice: string,
  confidence = 0.95,
  options: readonly string[] = REPLY_OPTIONS,
): ChoiceResult {
  const rest = (1 - confidence) / (options.length - 1);
  const probabilities = Object.fromEntries(
    options.map((o) => [o, o === choice ? confidence : rest]),
  );
  return new ChoiceResult({ choice, probabilities, confidence });
}

/** A turn's answer: its probability of meeting the criterion, or the full distribution. */
function _turn(meets: number | Record<string, number>): ChoiceResult {
  const probabilities =
    typeof meets === "number" ? { meets, fails: 1 - meets, not_applicable: 0.0 } : meets;
  // Python's max(..., key=...): the first of the highest.
  let choice = "";
  for (const [k, v] of Object.entries(probabilities)) {
    if (choice === "" || v > (probabilities[choice] as number)) choice = k;
  }
  return new ChoiceResult({
    choice,
    probabilities,
    confidence: probabilities[choice] as number,
  });
}

function _judge(
  answers: Answers[] | Responder,
  explainer: _FakeLLMService | null = null,
  options: Omit<EvalJudgeOptions, "explainer"> = {},
): [EvalJudge, _FakeClassifier] {
  const classifier = new _FakeClassifier(answers);
  return [
    new EvalJudge(classifier, { explainer: explainer ? asLlm(explainer) : null, ...options }),
    classifier,
  ];
}

/** The turn verdicts a run asks the explainer about, by turn number. */
function _asked(...turns: number[]): Map<number, JudgeVerdict> {
  return new Map(
    turns.map((turn) => [turn, new JudgeVerdict({ verdict: "no", reason: "", rawResponse: "" })]),
  );
}

/** The explainer a judge holds (protected in the port). */
function explainerOf(judge: EvalJudge): _Explainer | null {
  return (judge as unknown as { _explainer: _Explainer | null })._explainer;
}

describe("TestParseRunReasons", () => {
  test("test_the_goals_reason_and_each_asked_turns", () => {
    const out = _Explainer._parseRunReasons(
      '{"goal": "Berlin was named.", ' +
        '"turns": {"Politeness": {"2": "curt"}, "brevity": {"1": "short"}}}',
      new Map([
        ["politeness", _asked(2)],
        ["brevity", _asked(1)],
      ]),
    );
    expect(out.goal).toEqual("Berlin was named.");
    expect(out.turns).toEqual(
      new Map([
        ["politeness", new Map([[2, "curt"]])],
        ["brevity", new Map([[1, "short"]])],
      ]),
    );
  });

  test("test_a_turn_is_the_number_in_its_key", () => {
    const out = _Explainer._parseRunReasons(
      '{"turns": {"politeness": {"bot turn 1": "warm", "Turn 2": "curt"}}}',
      new Map([["politeness", _asked(1, 2)]]),
    );
    expect(out.turns).toEqual(
      new Map([
        [
          "politeness",
          new Map([
            [1, "warm"],
            [2, "curt"],
          ]),
        ],
      ]),
    );
  });

  test("test_a_reason_not_given_is_empty", () => {
    const out = _Explainer._parseRunReasons(
      '```json\n{"turns": {"politeness": {"1": "warm"}}}\n```',
      new Map([["politeness", _asked(1, 2)]]),
    );
    expect(out.goal).toEqual("");
    expect(out.turns).toEqual(
      new Map([
        [
          "politeness",
          new Map([
            [1, "warm"],
            [2, ""],
          ]),
        ],
      ]),
    );
  });

  test("test_no_json_gives_no_reasons", () => {
    const out = _Explainer._parseRunReasons("no json here", new Map([["politeness", _asked(1)]]));
    expect([out.goal, out.turns]).toEqual(["", new Map([["politeness", new Map([[1, ""]])]])]);
  });
});

describe("TestParseReason", () => {
  test("test_the_json_reason", () => {
    expect(_Explainer._parseReason('{"reason": "It mentions weather."}')).toEqual(
      "It mentions weather.",
    );
  });

  test("test_fenced_or_surrounded_json", () => {
    for (const response of [
      '```json\n{"reason": "ok"}\n```',
      'Sure: {"reason": "ok"}\n\nLet me know if you need more!',
    ]) {
      expect(_Explainer._parseReason(response)).toEqual("ok");
    }
  });

  test("test_a_plain_answer_is_the_reason", () => {
    expect(_Explainer._parseReason("  It never mentions rain.\n")).toEqual(
      "It never mentions rain.",
    );
  });
});

describe("TestJudgeEvaluate", () => {
  test("test_the_latest_reply_is_judged_after_the_spoken_conversation", async () => {
    const [judge, classifier] = _judge([{ verdict: _choice("yes") }]);
    judge.addUserMessage("What's the weather?");
    judge.addToolCall("lookup()");
    judge.addAssistantMessage("Let me check.");
    judge.addAssistantMessage("It's 72 and sunny.");

    const verdict = await judge.evaluate("describes the weather");

    expect(verdict.passed).toBe(true);
    expect(verdict.confidence).toEqual(0.95);
    expect(verdict.probabilities.yes).toEqual(0.95);
    expect(verdict.reason).toContain("P(yes)=0.95");
    const state = classifier.asked[0]?.state as State;
    expect(state.latest_bot_reply).toEqual("Let me check. It's 72 and sunny.");
    expect(state.conversation).toEqual([{ speaker: "user", text: "What's the weather?" }]);
    const question = classifier.asked[0]?.questions.verdict as ChoiceQuestion;
    expect(new Set(Object.keys(question.options))).toEqual(new Set(REPLY_OPTIONS));
    expect(question.instructions).toContain("describes the weather");
  });

  test("test_without_continue_a_reply_is_judged_yes_or_no", async () => {
    const [judge, classifier] = _judge([{ verdict: _choice("no") }], null, {
      allowContinue: false,
    });
    judge.addUserMessage("What is the capital of Germany?");
    judge.addAssistantMessage("No rush, take your time.");
    const verdict = await judge.evaluate("says the capital of Germany is Berlin");
    expect(verdict.verdict).toEqual("no");
    expect(new Set(Object.keys(classifier.asked[0]?.questions.verdict?.options ?? {}))).toEqual(
      new Set(["yes", "no"]),
    );
  });

  test("test_a_verdict_is_cached_by_criterion_and_conversation", async () => {
    const [judge, classifier] = _judge([{ verdict: _choice("yes") }]);
    judge.addAssistantMessage("It rains.");
    await judge.evaluate("mentions weather");
    await judge.evaluate("mentions weather");
    expect(classifier.asked.length).toEqual(1);
  });

  test("test_a_failed_question_is_asked_again_then_gives_a_no", async () => {
    let [judge, classifier] = _judge([new ClassifierError("boom"), { verdict: _choice("yes") }]);
    judge.addAssistantMessage("It rains.");
    expect((await judge.evaluate("mentions weather")).passed).toBe(true);
    expect(classifier.asked.length).toEqual(2);

    [judge, classifier] = _judge([new ClassifierError("boom"), new ClassifierError("boom")]);
    judge.addAssistantMessage("anything");
    const verdict = await judge.evaluate("anything");
    expect(verdict.verdict).toEqual("no");
    expect(verdict.reason).toEqual("judge call failed");
    expect(classifier.asked.length).toEqual(2);
  });

  test("test_an_answer_of_the_wrong_type_fails_the_question", async () => {
    const wrong = { verdict: new YesNoResult({ probability: 0.9 }) };
    const [judge] = _judge([wrong, wrong]);
    judge.addAssistantMessage("anything");
    const verdict = await judge.evaluate("anything");
    expect(verdict.verdict).toEqual("no");
    expect(verdict.reason).toEqual("judge call failed");
  });
});

describe("TestJudgeExplainer", () => {
  test("test_a_no_takes_the_explainers_reason_and_keeps_its_probabilities", async () => {
    const llm = new _FakeLLMService(['{"reason": "it never mentions rain"}']);
    const [judge] = _judge([{ verdict: _choice("no") }], llm);
    judge.addAssistantMessage("Hello.");
    const verdict = await judge.evaluate("mentions weather");
    expect(verdict.verdict).toEqual("no");
    expect(verdict.reason).toEqual("it never mentions rain");
    expect(verdict.probabilities.no).toEqual(0.95);
  });

  test("test_the_explainer_is_told_the_verdict", async () => {
    const llm = new _FakeLLMService([
      '{"reason": "it says it rains"}',
      '{"reason": "it says it rains"}',
    ]);
    for (const [choice, outcome] of [
      ["yes", "satisfies"],
      ["no", "does not satisfy"],
    ] as const) {
      const [judge] = _judge([{ verdict: _choice(choice, 0.6) }], llm);
      judge.addAssistantMessage("It rains.");
      await judge.evaluate("mentions weather");
      expect(llm.calls[llm.calls.length - 1]?.ask).toContain(`reply ${outcome} this criterion`);
    }
  });

  test("test_the_reason_is_asked_for_in_a_schema_and_asked_again_when_the_call_fails", async () => {
    const llm = new _FakeLLMService([
      new Error("timed out"),
      '{"reason": "it never mentions rain"}',
    ]);
    const [judge] = _judge([{ verdict: _choice("no") }], llm);
    judge.addAssistantMessage("Hello.");
    const verdict = await judge.evaluate("mentions weather");
    expect(verdict.reason).toEqual("it never mentions rain");
    expect(llm.calls.length).toEqual(2);
    expect(llm.calls[0]?.response_schema).toEqual({
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    });
  });

  test("test_a_failed_explainer_leaves_the_probabilities", async () => {
    const llm = new _FakeLLMService([]);
    const [judge] = _judge([{ verdict: _choice("no") }], llm);
    judge.addAssistantMessage("Hello.");
    const verdict = await judge.evaluate("mentions weather");
    expect(verdict.reason.startsWith("P(yes)=")).toBe(true);
  });

  test("test_a_sure_yes_and_a_continue_are_not_explained", async () => {
    const llm = new _FakeLLMService([]);
    const [judge] = _judge([{ verdict: _choice("continue") }, { verdict: _choice("yes") }], llm);
    judge.addAssistantMessage("Let me check.");
    expect((await judge.evaluate("gives the weather")).verdict).toEqual("continue");
    judge.addAssistantMessage("It's sunny.");
    expect((await judge.evaluate("gives the weather")).passed).toBe(true);
    expect(llm.calls).toEqual([]);
  });

  test("test_an_unsure_yes_is_explained", async () => {
    const llm = new _FakeLLMService(['{"reason": "close enough"}']);
    const [judge] = _judge([{ verdict: _choice("yes", 0.6) }], llm);
    judge.addAssistantMessage("Sunny-ish.");
    const verdict = await judge.evaluate("gives the weather");
    expect(verdict.passed).toBe(true);
    expect(verdict.reason).toEqual("close enough");
    expect(llm.calls.length).toEqual(1);
  });
});

describe("TestJudgeEvaluateCall", () => {
  test("test_a_call_is_judged_by_name_and_arguments", async () => {
    const [judge, classifier] = _judge([{ answer: new YesNoResult({ probability: 0.2 }) }]);
    judge.addUserMessage("Book six o'clock.");
    const verdict = await judge.evaluateCall("book", { time: "7pm" }, "books six o'clock");
    expect(verdict.verdict).toEqual("no");
    expect(verdict.confidence).toBeCloseTo(0.8, 7);
    const state = classifier.asked[0]?.state as State;
    expect(state.call).toEqual({ name: "book", arguments: { time: "7pm" } });
  });

  test("test_the_same_criterion_on_another_call_is_another_question", async () => {
    const [judge, classifier] = _judge([
      { answer: new YesNoResult({ probability: 0.9 }) },
      { answer: new YesNoResult({ probability: 0.1 }) },
    ]);
    expect((await judge.evaluateCall("submit", { n: 1 }, "n is one")).passed).toBe(true);
    expect((await judge.evaluateCall("submit", { n: 1 }, "n is one")).passed).toBe(true);
    expect((await judge.evaluateCall("submit", { n: 2 }, "n is one")).passed).toBe(false);
    expect(classifier.asked.length).toEqual(2);
  });
});

describe("TestJudgeEvaluateRun", () => {
  const _converse = (judge: EvalJudge): void => {
    judge.addUserMessage("Book a table at six.");
    judge.addToolCall('book({"time": "6pm"})');
    judge.addAssistantMessage("Let me check.");
    judge.addAssistantMessage("Done, six o'clock.");
    judge.addUserMessage("Thanks.");
    judge.addAssistantMessage("You're welcome.");
  };

  /**
   * Answers a run's questions: the goal's, and each turn's by its reply text.
   *
   * A turn's answer is its probability of meeting the criterion (the rest
   * failing it), or the choice's full probabilities.
   */
  const _answer =
    (
      goal: number,
      turns: Record<string, number | Record<string, number>>,
      failing: string | null = null,
    ): Responder =>
    (state, questions) => {
      const reply = state.latest_bot_reply as string | undefined;
      if (reply === undefined) {
        if (failing === "goal") {
          throw new ClassifierError("goal question failed");
        }
        return { answer: new YesNoResult({ probability: goal }) };
      }
      if (reply === failing) {
        throw new ClassifierError("turn question failed");
      }
      return Object.fromEntries(
        Object.keys(questions).map((name) => [
          name,
          _turn(turns[reply] as number | Record<string, number>),
        ]),
      );
    };

  const turnsAsked = (classifier: _FakeClassifier) =>
    classifier.asked.filter((a) => "latest_bot_reply" in a.state);

  test("test_the_goal_is_asked_over_the_whole_conversation", async () => {
    const [judge, classifier] = _judge(
      _answer(0.9, { "Let me check. Done, six o'clock.": 0.8, "You're welcome.": 0.3 }),
    );
    _converse(judge);

    const verdicts = await judge.evaluateRun({ polite: "is polite" }, "a table is booked");

    expect(verdicts.goal.passed).toBe(true);
    const goal = classifier.asked.find((a) => !("latest_bot_reply" in a.state)) as Asked;
    expect(goal.state.conversation).toEqual([
      { speaker: "user", text: "Book a table at six." },
      { speaker: "tool", text: 'book({"time": "6pm"})' },
      { speaker: "bot", turn: 1, text: "Let me check. Done, six o'clock." },
      { speaker: "user", text: "Thanks." },
      { speaker: "bot", turn: 2, text: "You're welcome." },
    ]);
  });

  test("test_each_turn_is_judged_after_only_the_conversation_before_it", async () => {
    const [judge, classifier] = _judge(
      _answer(0.9, { "Let me check. Done, six o'clock.": 0.8, "You're welcome.": 0.3 }),
    );
    _converse(judge);

    const verdicts = await judge.evaluateRun({ polite: "is polite" }, "a table is booked");

    expect(verdicts.turns.polite?.map((v) => v.verdict)).toEqual(["yes", "no"]);
    const turns = turnsAsked(classifier);
    expect(turns.length).toEqual(2);
    const byReply = Object.fromEntries(turns.map((t) => [t.state.latest_bot_reply as string, t]));
    expect(byReply["Let me check. Done, six o'clock."]?.state.conversation).toEqual([
      { speaker: "user", text: "Book a table at six." },
      { speaker: "tool", text: 'book({"time": "6pm"})' },
    ]);
    expect(((byReply["You're welcome."] as Asked).state.conversation as unknown[]).length).toEqual(
      4,
    );
    expect(new Set(Object.keys(byReply["You're welcome."]?.questions ?? {}))).toEqual(
      new Set(["polite"]),
    );
  });

  test("test_a_turn_the_criterion_does_not_apply_to_passes", async () => {
    const [judge, classifier] = _judge(
      _answer(0.9, {
        "Let me check. Done, six o'clock.": { meets: 0.3, fails: 0.1, not_applicable: 0.6 },
        "You're welcome.": { meets: 0.05, fails: 0.9, not_applicable: 0.05 },
      }),
    );
    _converse(judge);

    const verdicts = await judge.evaluateRun(
      { apology: "when a time is taken, apologises" },
      "booked",
    );

    const [first, second] = verdicts.turns.apology as [JudgeVerdict, JudgeVerdict];
    expect(first.verdict).toEqual("yes");
    expect(first.confidence).toBeCloseTo(0.9, 7);
    expect(second.verdict).toEqual("no");
    expect(second.confidence).toBeCloseTo(0.9, 7);
    const question = turnsAsked(classifier)[0]?.questions.apology as ChoiceQuestion;
    expect(new Set(Object.keys(question.options))).toEqual(new Set(TURN_OPTIONS));
  });

  test("test_a_run_with_no_criteria_asks_only_the_goal", async () => {
    const [judge, classifier] = _judge(_answer(0.9, {}));
    _converse(judge);
    const verdicts = await judge.evaluateRun({}, "a table is booked");
    expect(verdicts.goal.passed).toBe(true);
    expect(classifier.asked.length).toEqual(1);
  });

  test("test_a_failed_question_blanks_only_its_own_verdicts", async () => {
    const [judge] = _judge(
      _answer(0.9, { "You're welcome.": 0.8 }, "Let me check. Done, six o'clock."),
    );
    _converse(judge);
    const verdicts = await judge.evaluateRun({ polite: "is polite" }, "booked");
    expect(verdicts.goal.passed).toBe(true);
    expect(verdicts.turns.polite?.map((v) => v.verdict)).toEqual(["none", "yes"]);
  });

  test("test_a_failed_goal_question_gives_no_goal_verdict", async () => {
    const [judge] = _judge(
      _answer(0.9, { "Let me check. Done, six o'clock.": 0.8, "You're welcome.": 0.8 }, "goal"),
    );
    _converse(judge);
    const verdicts = await judge.evaluateRun({ polite: "is polite" }, "booked");
    expect(verdicts.goal.verdict).toEqual("none");
    expect(verdicts.turns.polite?.map((v) => v.verdict)).toEqual(["yes", "yes"]);
  });

  test("test_the_explainer_is_asked_only_about_the_verdicts_that_need_a_reason", async () => {
    const llm = new _FakeLLMService(['{"turns": {"polite": {"2": "curt"}}}']);
    const [judge] = _judge(
      _answer(0.95, { "Let me check. Done, six o'clock.": 0.9, "You're welcome.": 0.1 }),
      llm,
    );
    _converse(judge);

    const verdicts = await judge.evaluateRun({ polite: "is polite" }, "booked");

    expect(llm.calls.length).toEqual(1);
    const ask = llm.calls[0]?.ask as string;
    expect(ask).toContain("- polite, bot turn 2: fails the criterion");
    expect(ask.split("verdicts to explain")[1]).not.toContain("bot turn 1:");
    expect(ask).not.toContain("- goal:");
    expect(verdicts.goal.reason).toEqual("P(yes)=0.95");
    const [first, second] = verdicts.turns.polite as [JudgeVerdict, JudgeVerdict];
    expect(first.reason).toEqual("P(meets)=0.90, P(fails)=0.10, P(not_applicable)=0.00");
    expect(second.reason).toEqual("curt");
  });

  test("test_the_schema_names_exactly_the_reasons_asked_for", async () => {
    const llm = new _FakeLLMService(['{"turns": {"polite": {"2": "curt"}}}']);
    const [judge] = _judge(
      _answer(0.95, { "Let me check. Done, six o'clock.": 0.9, "You're welcome.": 0.1 }),
      llm,
    );
    _converse(judge);
    await judge.evaluateRun({ polite: "is polite" }, "booked");
    const schema = llm.calls[0]?.response_schema as any;
    expect(schema.required).toEqual(["turns"]);
    const turns = schema.properties.turns;
    expect(turns.required).toEqual(["polite"]);
    expect(turns.properties.polite.required).toEqual(["2"]);
    expect(turns.properties.polite.additionalProperties).toBe(false);
  });

  test("test_an_answer_that_leaves_a_reason_out_is_asked_again", async () => {
    const llm = new _FakeLLMService([
      '{"goal": "booked", "turns": {"polite": {}}}',
      '{"goal": "booked", "turns": {"polite": {"2": "curt"}}}',
    ]);
    const [judge] = _judge(
      _answer(0.6, { "Let me check. Done, six o'clock.": 0.9, "You're welcome.": 0.1 }),
      llm,
    );
    _converse(judge);
    const verdicts = await judge.evaluateRun({ polite: "is polite" }, "booked");
    expect(llm.calls.length).toEqual(2);
    expect(verdicts.goal.reason).toEqual("booked");
    expect(verdicts.turns.polite?.[1]?.reason).toEqual("curt");
  });

  test("test_an_unsure_pass_is_explained_as_the_outcome_the_classifier_chose", async () => {
    // The second answer fails, and the first one's reason stands.
    const llm = new _FakeLLMService(['{"turns": {"polite": {"1": "thanked the caller"}}}']);
    const [judge] = _judge(
      _answer(0.95, {
        "Let me check. Done, six o'clock.": 0.6,
        "You're welcome.": { meets: 0.3, fails: 0.1, not_applicable: 0.6 },
      }),
      llm,
      { explainBelow: 0.95 },
    );
    _converse(judge);

    const verdicts = await judge.evaluateRun({ polite: "is polite" }, "booked");

    const ask = llm.calls[0]?.ask as string;
    expect(ask).toContain("- polite, bot turn 1: meets the criterion");
    expect(ask).toContain(
      "- polite, bot turn 2: passes because the criterion does not apply to it",
    );
    const [first, second] = verdicts.turns.polite as [JudgeVerdict, JudgeVerdict];
    expect(first.reason).toEqual("thanked the caller");
    // A reason not given leaves the probabilities.
    expect(second.reason.startsWith("P(meets)=")).toBe(true);
  });

  test("test_explain_below_above_one_explains_every_verdict_of_a_run", async () => {
    const llm = new _FakeLLMService([
      '{"goal": "booked", ' +
        '"turns": {"polite": {"1": "thanked the caller", "2": "warm goodbye"}}}',
    ]);
    const [judge] = _judge(
      _answer(0.95, { "Let me check. Done, six o'clock.": 0.9, "You're welcome.": 0.9 }),
      llm,
      { explainBelow: 2 },
    );
    _converse(judge);

    const verdicts = await judge.evaluateRun({ polite: "is polite" }, "booked");

    expect(llm.calls[0]?.ask).toContain("- goal: achieved");
    expect(verdicts.goal.reason).toEqual("booked");
    expect(verdicts.goal.probabilities).toEqual({ yes: 0.95, no: 1 - 0.95 });
    expect(verdicts.turns.polite?.map((v) => v.reason)).toEqual([
      "thanked the caller",
      "warm goodbye",
    ]);
  });

  // Skipped: passing a `transcript` to `evaluate_run` is deprecated (since
  // 1.11.0, removed in 2.0.0) and not ported.
  test.skip("test_a_transcript_passed_in_is_deprecated_and_judged_in_place_of_the_kept_one", () => {});
});

/** The judge over an LLM classifier, with the same LLM explaining. */
describe("TestJudgeOverAnLLM", () => {
  test("test_a_reply_is_classified_in_one_call", async () => {
    const llm = new _FakeLLMService([
      JSON.stringify({ verdict: { choice: "yes", probabilities: { yes: 0.95 } } }),
    ]);
    const judge = new EvalJudge(new LLMClassifier({ llm: asLlm(llm) }));
    judge.addAssistantMessage("It's 72 and sunny.");
    const verdict = await judge.evaluate("describes the weather");
    expect(verdict.passed).toBe(true);
    expect(llm.calls.length).toEqual(1);
    const ask = llm.calls[0]?.ask as string;
    expect(ask).toContain("describes the weather");
    expect(ask).toContain("It's 72 and sunny.");
    for (const option of REPLY_OPTIONS) {
      expect(ask).toContain(`- ${option}:`);
    }
  });

  test("test_a_no_is_explained_by_the_explainers_llm", async () => {
    const llm = new _FakeLLMService([
      JSON.stringify({ verdict: { choice: "no", probabilities: { no: 0.9 } } }),
      '{"reason": "it never mentions the weather"}',
    ]);
    const judge = new EvalJudge(new LLMClassifier({ llm: asLlm(llm) }), {
      explainer: asLlm(llm),
    });
    judge.addAssistantMessage("Hello there.");
    const verdict = await judge.evaluate("describes the weather");
    expect(verdict.verdict).toEqual("no");
    expect(verdict.reason).toEqual("it never mentions the weather");
    expect(llm.calls.length).toEqual(2);
  });

  test("test_without_an_explainer_the_probabilities_are_the_reason", async () => {
    const llm = new _FakeLLMService([
      JSON.stringify({ verdict: { choice: "no", probabilities: { no: 0.9 } } }),
    ]);
    const judge = new EvalJudge(new LLMClassifier({ llm: asLlm(llm) }));
    judge.addAssistantMessage("Hello there.");
    const verdict = await judge.evaluate("describes the weather");
    expect(verdict.verdict).toEqual("no");
    expect(verdict.reason).toEqual("P(yes)=0.00, P(no)=0.90, P(continue)=0.00");
    expect(llm.calls.length).toEqual(1);
  });
});

/** An LLM service in place of a classifier still classifies and explains. */
describe("TestJudgeOverADeprecatedService", () => {
  // Skipped: an LLM service in place of the classifier is deprecated (since
  // 1.12.0, removed in 2.0.0) and not ported.
  test.skip("test_a_service_warns_and_classifies_and_explains_with_itself", () => {});

  // Skipped: the `service` keyword is deprecated (since 1.12.0, removed in
  // 2.0.0) and not ported.
  test.skip("test_the_service_keyword_warns_and_works", () => {});

  test("test_a_judge_needs_a_classifier", () => {
    expect(() => new EvalJudge()).toThrow(Error);
  });
});

/** What the explainer is asked when a verdict needs a reason. */
describe("TestJudgeExplainerPrompts", () => {
  test("test_a_reply_is_explained_over_the_conversation", async () => {
    const llm = new _FakeLLMService(['{"reason": "it never mentions rain"}']);
    const [judge] = _judge([{ verdict: _choice("no") }], llm);
    judge.addUserMessage("What's the weather?");
    judge.addAssistantMessage("Hello there.");
    await judge.evaluate("describes the weather");
    const ask = llm.calls[0]?.ask as string;
    expect(ask).toContain("most recent reply does not satisfy this criterion");
    expect(ask).toContain("Criterion: describes the weather");
    expect(llm.calls[0]?.system_instruction).toEqual(EXPLAIN_SYSTEM_INSTRUCTION);
  });

  test("test_a_call_is_explained_by_name_and_arguments", async () => {
    const llm = new _FakeLLMService(['{"reason": "wrong speaker"}']);
    const [judge] = _judge([{ answer: new YesNoResult({ probability: 0.1 }) }], llm);
    const verdict = await judge.evaluateCall("submit", { speaker: "Ann" }, "submitted for Bob");
    expect(verdict.reason).toEqual("wrong speaker");
    const ask = llm.calls[0]?.ask as string;
    expect(ask).toContain('called the function `submit` with arguments `{"speaker": "Ann"}`');
    expect(ask).toContain("this call does not satisfy this criterion");
    expect(llm.calls[0]?.system_instruction).toEqual(EXPLAIN_SYSTEM_INSTRUCTION);
  });

  test("test_a_run_is_explained_from_the_whole_transcript", async () => {
    const llm = new _FakeLLMService(['{"goal": "never booked"}']);
    const [judge] = _judge(
      (state, questions) =>
        !("latest_bot_reply" in state)
          ? { answer: new YesNoResult({ probability: 0.1 }) }
          : Object.fromEntries(Object.keys(questions).map((name) => [name, _turn(0.9)])),
      llm,
    );
    judge.addUserMessage("Book a table at six.");
    judge.addToolCall('book({"time": "6pm"})');
    judge.addAssistantMessage("Sure.");
    const verdicts = await judge.evaluateRun({ polite: "is polite" }, "a table is booked");
    expect(verdicts.goal.verdict).toEqual("no");
    expect(verdicts.goal.reason).toEqual("never booked");
    const ask = llm.calls[0]?.ask as string;
    expect(ask).toContain("User: Book a table at six.");
    expect(ask).toContain('[tool call] book({"time": "6pm"})');
    expect(ask).toContain("Bot turn 1: Sure.");
    expect(ask).toContain("- goal: not achieved");
    expect(llm.calls[0]?.system_instruction).toEqual(EXPLAIN_SYSTEM_INSTRUCTION);
  });

  test("test_max_tokens_caps_the_explainer", async () => {
    const llm = new _FakeLLMService(['{"reason": "no rain"}']);
    const [judge] = _judge([{ verdict: _choice("no") }], llm, { maxTokens: 64 });
    judge.addAssistantMessage("Hello.");
    await judge.evaluate("describes the weather");
    expect(llm.calls[0]?.max_tokens).toEqual(64);
  });
});

describe("TestJudgeConfig", () => {
  test("test_the_default_judge_classifies_and_explains_with_one_llm", async () => {
    const judge = await EvalJudge.fromConfig(null);
    expect(judge.classifier).toBeInstanceOf(LLMClassifier);
    expect(explainerOf(judge)?.service).toBe((judge.classifier as LLMClassifier).llm);
  });

  test("test_an_explainer_block_names_the_llm_that_gives_the_reasons", async () => {
    const judge = await EvalJudge.fromConfig({
      service: "ollama",
      model: "a",
      explainer: { service: "ollama", model: "b" },
    });
    expect((judge.classifier as LLMClassifier).llm.settings.model).toEqual("a");
    expect(explainerOf(judge)?.service.settings.model).toEqual("b");
  });

  test("test_explainer_false_builds_no_explainer", async () => {
    const judge = await EvalJudge.fromConfig({ service: "ollama", explainer: false });
    expect(explainerOf(judge)).toBeNull();
  });

  test("test_allow_continue_false_is_read_from_the_config", async () => {
    const judge = await EvalJudge.fromConfig({ service: "ollama", allow_continue: false });
    const outcomes = (judge as unknown as { _replyOutcomes: Record<string, string> })
      ._replyOutcomes;
    expect(Object.keys(outcomes)).not.toContain("continue");
  });
});

describe("TestJudgeVerdictDataclass", () => {
  test("test_construction", () => {
    const v = new JudgeVerdict({ verdict: "yes", reason: "ok", rawResponse: "raw" });
    expect(v.passed).toBe(true);
    expect(v.reason).toEqual("ok");
    expect(v.rawResponse).toEqual("raw");
  });

  test("test_passed_only_for_yes", () => {
    expect(new JudgeVerdict({ verdict: "yes", reason: "", rawResponse: "" }).passed).toBe(true);
    expect(new JudgeVerdict({ verdict: "no", reason: "", rawResponse: "" }).passed).toBe(false);
    expect(new JudgeVerdict({ verdict: "continue", reason: "", rawResponse: "" }).passed).toBe(
      false,
    );
  });
});
