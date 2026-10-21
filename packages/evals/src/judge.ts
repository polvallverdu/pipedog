// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/judge.py

/**
 * The judge: decides whether the bot did what a scenario asks.
 *
 * A judge answers a natural-language criterion, an `eval:` on a scripted
 * turn or a simulation's `success:` and metrics, about the conversation it
 * was given. It keeps that conversation, fed as it happens: the user's turns,
 * the bot's replies, and the tool calls the bot makes. A terse reply ("That's
 * four") is judged in context, and a whole run is judged over the same record.
 *
 * How it decides:
 *
 * Every question goes to a `BaseClassifier`, which answers with an option
 * and a probability for each of the options it was offered. Two classifiers
 * come with Pipecat:
 *
 * - `LLMClassifier`, over any Pipecat LLM service with `runInference()`:
 *   OpenAI, Ollama, Together, and others. This is the default.
 * - `JevClassifier`, over TypeSafe's Jev, a hosted classification model. Jev
 *   answers in a few hundred milliseconds, costs little, and its
 *   probabilities are calibrated, so a scenario can tell a sure verdict from
 *   a close call.
 *
 * A scenario picks one in its `judge.eval:` block. All the options:
 *
 * ```yaml
 * judge:
 *   eval:
 *     service: ollama          # the LLM that classifies (the default), or
 *     model: gemma4:12b        #   factory: a module and export that
 *                              #   takes this block and returns a classifier
 *     explainer:               # optional; the LLM that gives reasons
 *       service: ollama        #   (the judging LLM if omitted, the default
 *       model: gemma4:12b      #   LLM for a factory's classifier; none if
 *                              #   set to false)
 *     explain_below: 0.75      # optional; see "The explainer" below
 *     allow_continue: true     # optional; false judges a reply yes or no only
 * ```
 *
 * A factory may also return an LLM service, which the judge then classifies
 * with.
 *
 * What the judge asks:
 *
 * The harness asks three kinds of question, and each is one classifier call:
 *
 * - A reply, for an `eval:` on a scripted turn. The state holds the
 *   conversation so far and, separately, the bot's latest reply. The answers
 *   are `yes` (the reply meets the criterion), `no` (it's a real answer that
 *   doesn't, including a reply that waits for the user instead), and
 *   `continue` (the bot is still working toward its answer: it only greeted,
 *   said it's checking, or the reply is still arriving). On `continue` the
 *   harness waits for more of the reply and asks again. A suite whose judged
 *   replies are all final answers, with nothing for the bot to fetch first,
 *   sets `allow_continue: false`, and a reply is then yes or no; a reply that
 *   is still arriving is still judged again as more of it comes.
 * - A function call, for an `eval:` on a `function_call`. The state holds the
 *   call's name and arguments and the conversation as context. The answer is
 *   yes or no.
 * - A whole simulation, at the end of the run. The goal is one yes/no
 *   question over the whole conversation, tool calls included. Each bot turn
 *   is asked about on its own, once per criterion, with only the
 *   conversation before that turn as context. The answers are `meets`,
 *   `fails`, and `not_applicable` (the criterion only covers some situation,
 *   like "when the time is taken, apologise", and this turn isn't in it);
 *   only `fails` fails the turn. All of a run's questions go out at once.
 *
 * How each question is written:
 *
 * - The reply or function call being judged is sent separately from the
 *   conversation before it (`latest_bot_reply` or `call`), so the classifier
 *   knows which part to judge.
 * - Every possible answer is one of the options. "The bot hasn't answered
 *   yet" is the option `continue`, and "this criterion doesn't apply to this
 *   turn" is the option `not_applicable`. Don't write these as rules in the
 *   instructions instead: a classifier follows an instruction for every
 *   criterion, even where it doesn't fit. A rule like "a criterion about some
 *   situation passes when that situation doesn't come up" also passes turns
 *   that never state a price against "the reply states a price".
 * - The instructions hold only the question and the criterion.
 *
 * How answers become verdicts:
 *
 * Each verdict carries a confidence from 0 to 1, and its reason starts out as
 * the probabilities the classifier gave (for example `P(yes)=0.97`):
 *
 * - A reply's verdict is the option chosen, with the confidence in it.
 * - A yes/no question (a function call, a goal) is `yes` when the
 *   probability of yes is at least 0.5; its confidence is the probability of
 *   the answer given.
 * - A turn's confidence is the probability of the verdict given: for a pass,
 *   the probability of `meets` and `not_applicable` together.
 *
 * Each question's verdict is cached by its criterion and state, so asking the
 * same question about the same conversation twice costs one call.
 *
 * The explainer:
 *
 * A classifier gives no reasons, so the judge asks an LLM of its own, the
 * explainer, for them, in a one-shot inference outside the pipeline with the
 * prompts in this module. It is asked for:
 *
 * - every `no`, on a reply, a function call, a turn or a goal;
 * - every verdict the classifier is unsure of, meaning a confidence below
 *   `explain_below` (0.75 by default). When a verdict is close to 50/50, the
 *   next run can go the other way, so these are worth a second look. An LLM
 *   classifier's probabilities are not calibrated and rarely fall this low,
 *   so in practice it is the `no` verdicts that are explained;
 * - never a `continue`, which is only a request to wait for more text.
 *
 * `explain_below: 0` limits it to the `no` verdicts, and a value above 1 has
 * every verdict explained.
 *
 * The explainer never decides a verdict. It is told the classifier's and
 * asked what in the conversation supports it, so the reason points to
 * evidence for the verdict that counts, not to how the classifier reached it.
 * Its reason takes the place of the probabilities as the verdict's `reason`,
 * and the probabilities stay in `probabilities`. For a simulation, every
 * verdict of the run that needs a reason is explained in one call. Each
 * question names the reasons it wants in a response schema, so an LLM that
 * can enforce one answers in exactly that shape, and a question whose call
 * fails or times out, or whose answer leaves a reason out, is asked once
 * more. A verdict still without a reason keeps the probabilities.
 *
 * When a call fails:
 *
 * A question that times out, can't connect, or comes back unusable is asked
 * once more. A second failure fails the question: a reply or a function call
 * gets a `no` with the reason "judge call failed", and each verdict of a
 * failed simulation question is a `none` (the verdict the harness reports as
 * not given).
 *
 * Lifecycle:
 *
 * The judge sets its classifier up before its first question and cleans it
 * up when the session closes it at the end of the run, so a classifier that
 * keeps a connection opens it once and a simulation's questions share it.
 *
 * Deprecated upstream and not ported: an LLM service in place of the
 * classifier (`EvalJudge(llmService)` and the `service` option), and the
 * `transcript` argument of `evaluateRun()`.
 *
 * @example
 * import { LLMClassifier } from "@pipedog/core/classifiers/llm/classifier";
 * import { OLLamaLLMService } from "@pipedog/ollama/llm";
 *
 * const service = new OLLamaLLMService({
 *   settings: new OLLamaLLMService.Settings({ model: "gemma4:12b" }),
 * });
 * const judge = new EvalJudge(new LLMClassifier({ llm: service }), { explainer: service });
 * judge.addUserMessage("What can you help me with?");
 * judge.addAssistantMessage("I can answer questions, set reminders, and look things up.");
 * const verdict = await judge.evaluate("describes the bot's capabilities");
 * if (!verdict.passed) {
 *   console.log(`judge said no: ${verdict.reason}`);
 * }
 */

import {
  createTask,
  gather,
  rethrowIfCancelled,
  shield,
  type Task,
  waitFor,
} from "@pipedog/asyncio";
import {
  type BaseClassifier,
  ChoiceQuestion,
  type ChoiceResult,
  ClassifierError,
  YesNoQuestion,
  type YesNoResult,
} from "@pipedog/core/classifiers/base_classifier";
import { LLMClassifier } from "@pipedog/core/classifiers/llm/classifier";
import {
  LLMContext,
  type LLMContextMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import type { LLMService } from "@pipedog/core/services/llm_service";
import { TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyNumberRepr } from "@pipedog/core/utils/py_json";

import { formatFixed2, pyStrRepr, sha256Hex } from "./_pyutil.ts";
import { classifierFromConfig, llmServiceFromConfig, type ServiceConfig } from "./services.ts";

// The explainer's instructions, for every question it is asked. The classifier
// has decided: the explainer is told the verdict and says what in the
// conversation supports it, so a reason always explains the verdict that counts.
export const EXPLAIN_SYSTEM_INSTRUCTION =
  "You explain the verdicts a judge gave on a conversation between a user and a bot " +
  "under test. The 'user' messages are the user; the 'assistant' messages are the bot's " +
  "replies. The judge's verdicts are final. For each verdict you are asked about, say in " +
  "one short sentence what the bot said or did that makes it right, naming it; never " +
  "just restate the verdict, and never argue for a different verdict. When a criterion " +
  "does not apply to a reply, say what the reply does instead and why that is outside " +
  "what the criterion covers. " +
  "When the bot spoke its replies, its text is an automatic speech-to-text " +
  "transcription, so it may contain homophones, misspellings, split or merged words, " +
  "and missing punctuation; read it by its intended spoken meaning. " +
  "Respond ONLY with the JSON object the question describes, on a single line, with no " +
  "other text or markdown.";

/** Python's `str.format(**values)` for the templates below (`{name}` and `{{`/`}}`). */
function _format(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{|\}\}|\{(\w+)\}/g, (match, name: string | undefined) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    return values[name as string] as string;
  });
}

// The ask for a reply's verdict, after the conversation so far.
export const EXPLAIN_REPLY_ASK_TEMPLATE =
  "The judge's verdict: the bot's most recent reply {outcome} this criterion.\n\n" +
  "Criterion: {criterion}\n\n" +
  'Answer with {{"reason": "<one short sentence>"}}.';

// The ask for a function call's verdict; the conversation so far is context.
export const EXPLAIN_CALL_ASK_TEMPLATE =
  "The bot called the function `{name}` with arguments `{args}`. The judge's verdict: " +
  "this call {outcome} this criterion.\n\n" +
  "Criterion: {criterion}\n\n" +
  'Answer with {{"reason": "<one short sentence>"}}.';

// The ask for a simulation run's verdicts: the transcript, with the bot's turns
// numbered and its tool calls inline, what the run was judged on, and the
// verdicts to explain, one per line.
export const EXPLAIN_RUN_ASK_TEMPLATE =
  "Transcript:\n{transcript}\n\n" +
  "A line marked '[tool call]' is a function the bot called at that point.\n\n" +
  "Criteria every bot reply was judged on:\n{criteria}\n\n" +
  "Goal the conversation as a whole was judged on: {success}\n\n" +
  "The judge's verdicts to explain:\n{verdicts}\n\n" +
  'Answer with {{"goal": "<reason>", "turns": {{"<criterion name>": ' +
  '{{"<bot turn number>": "<reason>"}}}}}}, a reason for each verdict listed and ' +
  "nothing else.";

export interface JudgeVerdictOptions {
  /**
   * `"yes"` (satisfies), `"no"` (substantive answer that fails), or
   * `"continue"` (interim/filler/incomplete: re-judge once more text arrives).
   */
  verdict: string;
  /**
   * The explainer's one-sentence reason for the verdict, or the classifier's
   * probabilities when nothing explained it.
   */
  reason: string;
  /** The judge's raw answer, for diagnostics. */
  rawResponse: string;
  /** How sure the judge is of the verdict, from 0 to 1. */
  confidence?: number | null;
  /**
   * The probability of each outcome the classifier was offered; empty when
   * the question failed.
   */
  probabilities?: Record<string, number>;
}

/** Outcome of a single judge call. */
export class JudgeVerdict {
  verdict: string;
  reason: string;
  rawResponse: string;
  confidence: number | null;
  probabilities: Record<string, number>;

  constructor(options: JudgeVerdictOptions) {
    this.verdict = options.verdict;
    this.reason = options.reason;
    this.rawResponse = options.rawResponse;
    this.confidence = options.confidence ?? null;
    this.probabilities = options.probabilities ?? {};
  }

  /** True only when the verdict is a definite `"yes"`. */
  get passed(): boolean {
    return this.verdict === "yes";
  }
}

export interface RunVerdictsOptions {
  /** The verdict on the goal, over the whole conversation. */
  goal: JudgeVerdict;
  /** Per criterion name, a verdict per bot turn, in order. */
  turns: Record<string, JudgeVerdict[]>;
}

/** A whole simulation run's verdicts. */
export class RunVerdicts {
  goal: JudgeVerdict;
  turns: Record<string, JudgeVerdict[]>;

  constructor(options: RunVerdictsOptions) {
    this.goal = options.goal;
    this.turns = options.turns;
  }
}

// The questions the judge asks, each followed by the criterion and the notes
// that go with every question; see `EvalJudge._instructions`.
const _REPLY_QUESTION =
  "Does `latest_bot_reply`, the bot's most recent reply, following `conversation`, satisfy " +
  "this criterion?";
const _CALL_QUESTION =
  "Does the bot's function `call`, judged by its name and arguments, satisfy this criterion?";
const _CALL_NOTE = "`conversation` is context only.";
const _GOAL_QUESTION = "Does the conversation as a whole achieve this goal?";
const _GOAL_NOTE =
  "A `tool` entry is a function the bot called at that point; a completed call is stronger " +
  "evidence of an action than the bot saying it did it.";
const _TURN_QUESTION =
  "`latest_bot_reply` is the bot's reply following `conversation`. How does it stand against " +
  "this criterion?";
const _TRANSCRIPTION_NOTE =
  "The bot's text may be an automatic speech-to-text transcription: judge its intended " +
  "spoken meaning, never its spelling ('for' may mean 'four', 'to' may mean 'two').";

const _REPLY_OUTCOMES: Record<string, string> = {
  yes: "The bot has given its answer, and the answer satisfies the criterion.",
  no:
    "The bot has given its answer, and the answer does not satisfy the criterion. A reply " +
    "that waits for the user (asking them to take their time or to go on) instead of " +
    "giving what the criterion asks for is a no.",
  continue:
    "The bot is still working toward its answer: it only greets, says it is checking or " +
    "looking something up and will report back, or the reply is an obviously incomplete " +
    "fragment.",
};

// A run's per-turn outcomes. A classifier can't tell by itself whether a
// criterion only applies in some situation ("when the time is taken,
// apologises"), so "doesn't apply" is an outcome of its own rather than a rule
// in the instructions.
const _TURN_OUTCOMES: Record<string, string> = {
  meets: "The reply does what the criterion asks.",
  fails: "The criterion applies to this reply, and the reply does not do what it asks.",
  not_applicable:
    "The criterion only asks something of replies in a particular situation (it says " +
    "'when', 'if', or similar), and that situation does not arise in this reply.",
};

/** An entry of the judge's conversation: a `user`, `assistant` or `tool` line. */
export interface TranscriptEntry {
  role: string;
  content: string;
}

/** A conversation entry with each bot reply joined into one numbered turn. */
interface NumberedEntry {
  role: string;
  turn?: number;
  content: string;
}

/** A conversation entry as the state carries it. */
type StateEntry = { speaker: string; turn?: number; text: string };

/** Pydantic's `model_dump_json()` of a classifier result: compact, floats as floats. */
function _modelDumpJson(fields: Record<string, unknown>): string {
  const encode = (v: unknown): string => {
    if (typeof v === "number") {
      const repr = pyNumberRepr(v);
      return Number.isFinite(v) && /^-?\d+$/.test(repr) ? `${repr}.0` : repr;
    }
    if (typeof v === "string") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(encode).join(",")}]`;
    if (v !== null && typeof v === "object") {
      return `{${Object.entries(v)
        .map(([k, x]) => `${JSON.stringify(k)}:${encode(x)}`)
        .join(",")}}`;
    }
    return JSON.stringify(v ?? null);
  };
  return encode(fields);
}

function _choiceDump(answer: ChoiceResult): string {
  return _modelDumpJson({
    choice: answer.choice,
    probabilities: answer.probabilities,
    confidence: answer.confidence,
  });
}

export interface EvalJudgeOptions {
  /**
   * The LLM asked for the reason behind a `no` or an unsure verdict; `null`
   * reports the probabilities alone.
   */
  explainer?: LLMService | null;
  /** A `yes` less sure than this is explained too. */
  explainBelow?: number;
  /**
   * Whether a reply may be judged `continue` (the bot is still working
   * toward its answer, so the harness waits for more of it). A suite whose
   * judged replies are all final answers turns it off, and a reply is then
   * `yes` or `no`.
   */
  allowContinue?: boolean;
  /**
   * Cap on the explainer's response length for one reason. Default 200,
   * enough for a short sentence.
   */
  maxTokens?: number;
}

/** Judges a conversation with a classifier, and asks an LLM for the reasons. */
export class EvalJudge {
  protected _classifier: BaseClassifier;
  protected _explainer: _Explainer | null;
  protected _explainBelow: number;
  protected _replyOutcomes: Record<string, string>;
  // The conversation the judge evaluates against, grown by the harness over
  // the scenario: entries with a `role` of `user`, `assistant` (a segment of
  // a reply), or `tool` (a call the bot made, one line), and the `content`.
  protected _transcript: TranscriptEntry[] = [];
  protected _cache = new Map<string, JudgeVerdict>();
  protected _runCache = new Map<string, RunVerdicts>();
  protected _setupTask: Task<void> | null = null;

  /**
   * Initialize the judge with an empty conversation.
   *
   * @param classifier The classifier that decides the verdicts. The judge
   *   sets it up and cleans it up with itself.
   * @param options The explainer and how the judge asks.
   * @throws Error If no classifier is given.
   */
  constructor(classifier: BaseClassifier | null = null, options: EvalJudgeOptions = {}) {
    if (classifier === null || classifier === undefined) {
      throw new Error("EvalJudge needs a classifier to decide the verdicts");
    }
    this._classifier = classifier;
    const explainer = options.explainer ?? null;
    this._explainer =
      explainer !== null
        ? new _Explainer(explainer, { maxTokens: options.maxTokens ?? 200 })
        : null;
    this._explainBelow = options.explainBelow ?? 0.75;
    this._replyOutcomes =
      (options.allowContinue ?? true)
        ? _REPLY_OUTCOMES
        : Object.fromEntries(Object.entries(_REPLY_OUTCOMES).filter(([k]) => k !== "continue"));
  }

  /**
   * Build a judge from a scenario's `judge.eval:` block.
   *
   * The block names an LLM, `ollama` by default, and the judge classifies and
   * explains with it. A `factory` builds the classifier instead, or an LLM
   * service to classify with; the explainer is then the `explainer:` block's
   * LLM, or the default LLM when the block names none. For a fully custom
   * judge, construct `EvalJudge` directly and pass it to the session.
   *
   * DIVERGENCE: async, since a factory and the provider are imported
   * dynamically (see `services.ts`).
   *
   * @param judgeConfig The `judge.eval:` block, with the keys the module
   *   docs list. `null` uses all defaults.
   * @returns A configured EvalJudge.
   * @throws Error If the block names an unknown service, or its factory
   *   returned neither a classifier nor an LLM service.
   *
   * @example
   * // In the scenario: judge.eval.factory: "./my_judge.ts.makeJudge"
   * export function makeJudge(config) {
   *   return new JevClassifier({ apiKey: ... }); // or any LLM service with runInference()
   * }
   */
  static async fromConfig(judgeConfig: ServiceConfig | null): Promise<EvalJudge> {
    const config = judgeConfig ?? {};
    const classifier = await classifierFromConfig(config, { where: "judge.eval" });
    const explainerConfig = config.explainer;
    let explainer: LLMService | null;
    if (explainerConfig === false) {
      explainer = null;
    } else if (explainerConfig) {
      explainer = await llmServiceFromConfig(explainerConfig as ServiceConfig, {
        where: "judge.eval.explainer",
      });
    } else if (classifier instanceof LLMClassifier) {
      // Without a block of its own, the explainer is the judging LLM.
      explainer = classifier.llm;
    } else {
      explainer = await llmServiceFromConfig(null, { where: "judge.eval.explainer" });
    }
    const explainBelow = config.explain_below;
    return new EvalJudge(classifier, {
      explainer,
      explainBelow: explainBelow === undefined ? 0.75 : Number(explainBelow),
      allowContinue: config.allow_continue !== false,
    });
  }

  /** The classifier that decides the verdicts. */
  get classifier(): BaseClassifier {
    return this._classifier;
  }

  /**
   * Record a user turn, so a later reply is judged in context.
   *
   * @param text The user's utterance, or `null` for a bot-first turn (ignored).
   */
  addUserMessage(text: string | null | undefined): void {
    if (text?.trim()) {
      this._transcript.push({ role: "user", content: text });
    }
  }

  /**
   * Add a segment of the bot's current reply to the conversation the judge sees.
   *
   * Consecutive segments are one reply: a judged run counts them as one bot
   * turn.
   *
   * @param text The new reply segment; empty or `null` is ignored.
   */
  addAssistantMessage(text: string | null | undefined): void {
    if (text?.trim()) {
      this._transcript.push({ role: "assistant", content: text });
    }
  }

  /**
   * Record a tool call the bot made, as evidence for a judged run.
   *
   * @param text The call on one line, e.g. `book({"time": "6pm"})` or
   *   `book was cancelled`; empty or `null` is ignored.
   */
  addToolCall(text: string | null | undefined): void {
    if (text?.trim()) {
      this._transcript.push({ role: "tool", content: text });
    }
  }

  /**
   * Judge whether the bot's latest reply satisfies `criterion`, in the conversation so far.
   *
   * @param criterion Natural-language description of what the reply should express.
   * @returns A `yes`, a `no`, or, when `allowContinue` is on, a `continue`
   *   when the bot is still working toward its answer, cached by criterion
   *   and conversation. A final verdict that needs a reason is explained, and
   *   a failed call is a `no` with the failure as its reason.
   */
  async evaluate(criterion: string): Promise<JudgeVerdict> {
    const entries = EvalJudge._numberedTurns(this._transcript.filter((e) => e.role !== "tool"));
    const latest =
      entries.length > 0 && entries[entries.length - 1]?.role === "bot"
        ? (entries.pop() as NumberedEntry).content
        : "";
    const state = { conversation: EvalJudge._conversation(entries), latest_bot_reply: latest };
    const key = _cacheKey("reply", criterion, state);
    if (!this._cache.has(key)) {
      const question = new ChoiceQuestion({
        instructions: EvalJudge._instructions(_REPLY_QUESTION, "Criterion", criterion),
        options: this._replyOutcomes,
      });
      const answers = await this._choices(state, { verdict: question });
      let verdict: JudgeVerdict;
      if (answers === null) {
        verdict = EvalJudge._failed("no");
      } else {
        verdict = EvalJudge._replyVerdict(answers.verdict as ChoiceResult);
        if (verdict.verdict !== "continue" && this._explainer && this._needsReason(verdict)) {
          const reason = await this._explainer.explain(this._transcript, criterion, verdict);
          verdict = EvalJudge._withReason(verdict, reason);
        }
      }
      this._cache.set(key, verdict);
    }
    return this._cache.get(key) as JudgeVerdict;
  }

  /**
   * Judge whether a function call the bot made satisfies `criterion`, in the conversation so far.
   *
   * @param name The function's name.
   * @param args The call's arguments.
   * @param criterion Natural-language description of what the call should be.
   * @returns A `yes` or a `no`, cached by call, criterion and conversation,
   *   and explained when it needs a reason.
   */
  async evaluateCall(
    name: string,
    args: Record<string, unknown> | null | undefined,
    criterion: string,
  ): Promise<JudgeVerdict> {
    const entries = EvalJudge._numberedTurns(this._transcript.filter((e) => e.role !== "tool"));
    const state = {
      conversation: EvalJudge._conversation(entries),
      call: { name, arguments: args ?? {} },
    };
    const key = _cacheKey("call", criterion, state);
    if (!this._cache.has(key)) {
      const answer = await this._yesNo(
        state,
        EvalJudge._instructions(_CALL_QUESTION, "Criterion", criterion, _CALL_NOTE),
      );
      let verdict: JudgeVerdict;
      if (answer === null) {
        verdict = EvalJudge._failed("no");
      } else {
        verdict = EvalJudge._yesNoVerdict(answer);
        if (this._explainer && this._needsReason(verdict)) {
          const reason = await this._explainer.explainCall(
            this._transcript,
            name,
            args,
            criterion,
            verdict,
          );
          verdict = EvalJudge._withReason(verdict, reason);
        }
      }
      this._cache.set(key, verdict);
    }
    return this._cache.get(key) as JudgeVerdict;
  }

  /**
   * Judge the whole conversation: every bot turn on every criterion, and the goal.
   *
   * The goal is asked over the whole conversation. Each bot turn is its own
   * call, judged in the light of the conversation before it, with the turn
   * itself as `latest_bot_reply`; the calls run concurrently. When any
   * verdict needs a reason, the explainer judges the run once and its reasons
   * go with the classifier's verdicts.
   *
   * @param criteria The per-turn criteria to decide, by name.
   * @param success The goal criterion, decided over the whole conversation.
   * @returns The goal's verdict and, per criterion, a verdict per bot turn in
   *   order. A failed call is a `none` for each verdict it asked for.
   */
  async evaluateRun(criteria: Record<string, string>, success: string): Promise<RunVerdicts> {
    const conversation = [...this._transcript];
    const entries = EvalJudge._numberedTurns(conversation);
    const names = Object.keys(criteria);
    const key = _cacheKey("run", criteria, success, entries);
    const cached = this._runCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const goalInstructions = EvalJudge._instructions(_GOAL_QUESTION, "Goal", success, _GOAL_NOTE);
    const turnQuestions: Record<string, ChoiceQuestion> = {};
    for (const name of names) {
      turnQuestions[name] = new ChoiceQuestion({
        instructions: EvalJudge._instructions(
          _TURN_QUESTION,
          "Criterion",
          criteria[name] as string,
        ),
        options: _TURN_OUTCOMES,
      });
    }
    const turnStates = entries.flatMap((entry, i) =>
      entry.role === "bot"
        ? [
            {
              conversation: EvalJudge._conversation(entries.slice(0, i)),
              latest_bot_reply: entry.content,
            },
          ]
        : [],
    );

    // The goal, and every criterion on each turn: one call each, all at once.
    const hasTurnQuestions = names.length > 0;
    const [goalAnswer, turnAnswers] = await gather(
      () => this._yesNo({ conversation: EvalJudge._conversation(entries) }, goalInstructions),
      () =>
        gather(
          ...(hasTurnQuestions ? turnStates : []).map(
            (state) => () => this._choices(state, turnQuestions),
          ),
        ) as Promise<(Record<string, ChoiceResult> | null)[]>,
    );

    const failed = EvalJudge._failed("none");
    const turns: Record<string, JudgeVerdict[]> = {};
    for (const name of names) {
      turns[name] = turnAnswers.map((answers) =>
        answers ? EvalJudge._turnVerdict(answers[name] as ChoiceResult) : failed,
      );
    }
    let verdicts = new RunVerdicts({
      goal: goalAnswer ? EvalJudge._yesNoVerdict(goalAnswer) : failed,
      turns,
    });
    verdicts = await this._explainRun(verdicts, conversation, criteria, success);
    this._runCache.set(key, verdicts);
    return verdicts;
  }

  /** Release what the judge holds open; the session calls it when the run ends. */
  async close(): Promise<void> {
    if (this._setupTask !== null) {
      await this._setupTask;
    }
    await this._classifier.cleanup();
  }

  /**
   * Wire the classifier up, before the first question.
   *
   * The judge runs outside any pipeline, so it gives the classifier a task
   * manager of its own. A classifier that cannot be set up is only a
   * warning: the question goes out regardless.
   */
  protected async _setup(): Promise<void> {
    try {
      await this._classifier.setup(new TaskManager());
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(
        `Judge couldn't set its classifier up: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Whether a verdict is worth explaining: a `no`, or an unsure `yes`. */
  protected _needsReason(verdict: JudgeVerdict): boolean {
    const unsure = verdict.confidence !== null && verdict.confidence < this._explainBelow;
    return verdict.verdict === "no" || unsure;
  }

  /** The run's verdicts, those that need a reason given the explainer's; it explains them in one call. */
  protected async _explainRun(
    verdicts: RunVerdicts,
    transcript: readonly TranscriptEntry[],
    criteria: Record<string, string>,
    success: string,
  ): Promise<RunVerdicts> {
    const goal = this._needsReason(verdicts.goal) ? verdicts.goal : null;
    const turns = new Map<string, Map<number, JudgeVerdict>>();
    for (const [name, turnVerdicts] of Object.entries(verdicts.turns)) {
      const byTurn = new Map<number, JudgeVerdict>();
      turnVerdicts.forEach((v, i) => {
        if (this._needsReason(v)) byTurn.set(i + 1, v);
      });
      turns.set(name, byTurn);
    }
    if (this._explainer === null || (goal === null && ![...turns.values()].some((t) => t.size))) {
      return verdicts;
    }
    const reasons = await this._explainer.explainRun(transcript, criteria, success, goal, turns);
    const explained: Record<string, JudgeVerdict[]> = {};
    for (const [name, turnVerdicts] of Object.entries(verdicts.turns)) {
      explained[name] = turnVerdicts.map((v, i) =>
        EvalJudge._withReason(v, reasons.turns.get(name)?.get(i + 1) ?? ""),
      );
    }
    return new RunVerdicts({
      goal: EvalJudge._withReason(verdicts.goal, reasons.goal),
      turns: explained,
    });
  }

  /** The probability of yes, or `null` when the question failed. */
  protected async _yesNo(state: unknown, instructions: string): Promise<YesNoResult | null> {
    const answers = await this._ask(state, () =>
      this._classifier.yesNo(state as Record<string, unknown>, {
        answer: new YesNoQuestion({ instructions }),
      }),
    );
    return answers ? (answers.answer as YesNoResult) : null;
  }

  /**
   * The option chosen for each question, or `null` when they failed.
   *
   * The questions share the state, so they go in one call.
   */
  protected async _choices(
    state: unknown,
    questions: Readonly<Record<string, ChoiceQuestion>>,
  ): Promise<Record<string, ChoiceResult> | null> {
    return await this._ask(state, () =>
      this._classifier.choice(state as Record<string, unknown>, questions),
    );
  }

  /** The classifier's answer, asked once more if it failed, or `null`. */
  protected async _ask<R>(state: unknown, ask: () => Promise<R>): Promise<R | null> {
    // The first question sets the classifier up; the others wait for it.
    if (this._setupTask === null) {
      this._setupTask = createTask(() => this._setup());
    }
    await shield(this._setupTask);
    logger.debug(`Judge asking over state:\n${pyJsonDumps(state)}`);
    for (const attempt of [1, 2]) {
      try {
        const answers = await ask();
        logger.debug(`Judge answered: ${_reprAnswers(answers)}`);
        return answers;
      } catch (e) {
        if (!(e instanceof ClassifierError)) {
          throw e;
        }
        if (attempt === 1) {
          logger.warning(`Judge question failed, asking again: ${e.message}`);
        } else {
          logger.error(`Judge question failed: ${e.message}`);
        }
      }
    }
    return null;
  }

  /**
   * The conversation with each bot reply joined into one numbered turn.
   *
   * A bot turn is a run of reply segments with nothing else between them.
   *
   * @param transcript The judge's conversation entries.
   * @returns The entries, each with a `role` of `user`, `bot` or `tool` and
   *   the `content`, a bot entry also carrying its `turn` (from 1).
   */
  protected static _numberedTurns(transcript: Iterable<TranscriptEntry>): NumberedEntry[] {
    const entries: NumberedEntry[] = [];
    let turn = 0;
    for (const entry of transcript) {
      if (entry.role === "assistant") {
        const last = entries[entries.length - 1];
        if (last && last.role === "bot") {
          last.content += ` ${entry.content}`;
          continue;
        }
        turn += 1;
        entries.push({ role: "bot", turn, content: entry.content });
      } else {
        entries.push({ role: entry.role, content: entry.content });
      }
    }
    return entries;
  }

  /** The conversation as the state carries it: a speaker, the text, and a bot turn's number. */
  protected static _conversation(entries: readonly NumberedEntry[]): StateEntry[] {
    return entries.map((e) => ({
      speaker: e.role,
      ...(e.turn !== undefined ? { turn: e.turn } : {}),
      text: e.content,
    }));
  }

  /**
   * A question's instructions: the question, the labelled criterion, and the notes.
   *
   * The criterion gets its final punctuation so the note after it reads as a
   * new sentence, and every question carries the transcription note.
   */
  protected static _instructions(
    question: string,
    label: string,
    criterion: string,
    note = "",
  ): string {
    let text = criterion.trim();
    if (!(text.endsWith(".") || text.endsWith("!") || text.endsWith("?"))) {
      text += ".";
    }
    const parts = [question, `${label}: ${text}`, note, _TRANSCRIPTION_NOTE];
    return parts.filter((part) => part).join(" ");
  }

  /** A reply's verdict: the choice of `yes`, `no` or `continue`. */
  protected static _replyVerdict(answer: ChoiceResult): JudgeVerdict {
    return new JudgeVerdict({
      verdict: answer.choice,
      reason: EvalJudge._probabilities(answer.probabilities),
      rawResponse: _choiceDump(answer),
      confidence: answer.confidence,
      probabilities: { ...answer.probabilities },
    });
  }

  /** A yes/no verdict from the probability of yes. */
  protected static _yesNoVerdict(answer: YesNoResult): JudgeVerdict {
    const probability = answer.probability;
    return new JudgeVerdict({
      verdict: answer.isYes ? "yes" : "no",
      reason: `P(yes)=${formatFixed2(probability)}`,
      rawResponse: _modelDumpJson({ probability }),
      confidence: Math.max(probability, 1 - probability),
      probabilities: { yes: probability, no: 1 - probability },
    });
  }

  /**
   * A turn's verdict: a `no` only when the criterion applies to the turn and fails.
   *
   * Its confidence is the probability of the verdict given: for a pass, the
   * probability of either outcome that passes.
   */
  protected static _turnVerdict(answer: ChoiceResult): JudgeVerdict {
    const fails = answer.probabilities.fails ?? 0.0;
    const passed = answer.choice !== "fails";
    return new JudgeVerdict({
      verdict: passed ? "yes" : "no",
      reason: EvalJudge._probabilities(answer.probabilities),
      rawResponse: _choiceDump(answer),
      confidence: passed ? 1 - fails : fails,
      probabilities: { ...answer.probabilities },
    });
  }

  /** The probability of each outcome, as a verdict's reason. */
  protected static _probabilities(probabilities: Record<string, number>): string {
    return Object.entries(probabilities)
      .map(([k, v]) => `P(${k})=${formatFixed2(v)}`)
      .join(", ");
  }

  /** The verdict a failed call gives. */
  protected static _failed(verdict: string): JudgeVerdict {
    return new JudgeVerdict({ verdict, reason: "judge call failed", rawResponse: "" });
  }

  /** The verdict with the explainer's reason in place of the probabilities, when it gave one. */
  protected static _withReason(verdict: JudgeVerdict, reason: string): JudgeVerdict {
    // Python's `dataclasses.replace()`: a new verdict, the same fields.
    return reason
      ? new JudgeVerdict({
          verdict: verdict.verdict,
          reason,
          rawResponse: verdict.rawResponse,
          confidence: verdict.confidence,
          probabilities: verdict.probabilities,
        })
      : verdict;
  }
}

/** The answers, for the debug log (upstream logs their `repr()`). */
function _reprAnswers(answers: unknown): string {
  if (answers === null || typeof answers !== "object") return String(answers);
  return `{${Object.entries(answers as Record<string, unknown>)
    .map(([k, v]) => `${pyStrRepr(k)}: ${v?.constructor?.name ?? "?"}(${JSON.stringify(v)})`)
    .join(", ")}}`;
}

// How long the explainer has to answer a question before it is asked again.
const _EXPLAINER_TIMEOUT_S = 60.0;

/** The explainer's reasons for a run's verdicts. @internal */
export class _RunReasons {
  /** The goal verdict's reason; empty when it was not asked or not given. */
  goal: string;
  /** Per criterion name, the reason for each turn asked about, by turn number. */
  turns: Map<string, Map<number, string>>;

  constructor(options: { goal: string; turns: Map<string, Map<number, string>> }) {
    this.goal = options.goal;
    this.turns = options.turns;
  }
}

/**
 * Asks an LLM why the classifier gave its verdicts, telling it each verdict.
 *
 * Each question names the reasons it wants in a response schema, so a
 * service that can enforce one answers in exactly that shape. A question
 * whose call fails, or whose answer lacks a reason it asked for, is asked
 * once more. Its answers are cached by question and conversation, so
 * explaining the same verdict twice costs one call. A reason is empty when it
 * was still not given.
 *
 * PORTING NOTE: a run's turn verdicts and reasons are keyed by turn number in
 * a `Map`, since Python's `dict[int, ...]` keeps int keys a plain object
 * cannot.
 *
 * @internal
 */
export class _Explainer {
  protected _service: LLMService;
  protected _maxTokens: number;
  protected _cache = new Map<string, string>();
  protected _runCache = new Map<string, _RunReasons>();

  /**
   * Initialize the explainer with a configured pipecat LLM service.
   *
   * @param service A pipecat LLM service exposing `runInference()`.
   * @param options.maxTokens Cap on the explainer's response length for one
   *   reason. Default 200, enough for a short sentence in JSON.
   */
  constructor(service: LLMService, options: { maxTokens?: number } = {}) {
    this._service = service;
    this._maxTokens = options.maxTokens ?? 200;
  }

  /** The LLM service that answers. */
  get service(): LLMService {
    return this._service;
  }

  /**
   * Why the bot's latest reply got `verdict` on `criterion`.
   *
   * @returns A one-sentence reason, or `""` when the call failed.
   */
  async explain(
    transcript: readonly TranscriptEntry[],
    criterion: string,
    verdict: JudgeVerdict,
  ): Promise<string> {
    const ask = _format(EXPLAIN_REPLY_ASK_TEMPLATE, {
      outcome: _Explainer._satisfies(verdict),
      criterion,
    });
    return await this._reason(transcript, criterion, ask);
  }

  /**
   * Why a function call the bot made got `verdict` on `criterion`.
   *
   * @returns A one-sentence reason, or `""` when the call failed.
   */
  async explainCall(
    transcript: readonly TranscriptEntry[],
    name: string,
    args: Record<string, unknown> | null | undefined,
    criterion: string,
    verdict: JudgeVerdict,
  ): Promise<string> {
    const ask = _format(EXPLAIN_CALL_ASK_TEMPLATE, {
      name,
      args: pyJsonDumps(args ?? {}, { ensureAscii: false }),
      outcome: _Explainer._satisfies(verdict),
      criterion,
    });
    return await this._reason(transcript, criterion, ask);
  }

  /**
   * Why a whole conversation's verdicts were given, in one call.
   *
   * The conversation goes in the question, bot turns numbered and tool calls
   * inline. A bot turn is a run of reply segments with nothing else between
   * them.
   *
   * @param transcript The conversation, as the judge kept it.
   * @param criteria The per-turn criteria the turns were judged on, by name.
   * @param success The goal criterion the whole conversation was judged on.
   * @param goal The goal's verdict to explain, or `null`.
   * @param turns Per criterion name, the turn verdicts to explain, by turn number.
   * @returns The reasons for the verdicts asked about; a reason not given is empty.
   */
  async explainRun(
    transcript: readonly TranscriptEntry[],
    criteria: Record<string, string>,
    success: string,
    goal: JudgeVerdict | null,
    turns: Map<string, Map<number, JudgeVerdict>>,
  ): Promise<_RunReasons> {
    const lines: string[] = [];
    let turn = 0;
    for (const entry of transcript) {
      if (entry.role === "assistant") {
        if (
          lines.length > 0 &&
          (lines[lines.length - 1] as string).startsWith(`Bot turn ${turn}:`)
        ) {
          lines[lines.length - 1] += ` ${entry.content}`;
          continue;
        }
        turn += 1;
        lines.push(`Bot turn ${turn}: ${entry.content}`);
      } else if (entry.role === "tool") {
        lines.push(`[tool call] ${entry.content}`);
      } else {
        lines.push(`User: ${entry.content}`);
      }
    }
    const verdicts: string[] = [];
    if (goal !== null) {
      verdicts.push(`- goal: ${goal.passed ? "achieved" : "not achieved"}`);
    }
    for (const [name, byTurn] of turns) {
      for (const [number, verdict] of byTurn) {
        verdicts.push(`- ${name}, bot turn ${number}: ${_Explainer._turnOutcome(verdict)}`);
      }
    }
    const listed = Object.entries(criteria)
      .map(([name, criterion]) => `- ${name}: ${criterion}`)
      .join("\n");
    const ask = _format(EXPLAIN_RUN_ASK_TEMPLATE, {
      transcript: lines.join("\n") || "(nothing was said)",
      criteria: listed || "(none)",
      success,
      verdicts: verdicts.join("\n"),
    });
    const key = _cacheKey(ask, []);
    if (!this._runCache.has(key)) {
      // Room for a reason per verdict; a budget sized for one cuts it short.
      const budget = Math.max(300, 50 * verdicts.length + 80);
      const schema = _Explainer._runSchema(goal, turns);
      let reasons = new _RunReasons({ goal: "", turns: new Map() });
      for (const attempt of [1, 2]) {
        const response = await this._ask(success, [], ask, schema, { maxTokens: budget });
        reasons = _Explainer._filled(reasons, _Explainer._parseRunReasons(response ?? "", turns));
        const given = goal !== null ? [reasons.goal] : [];
        for (const byTurn of reasons.turns.values()) {
          given.push(...byTurn.values());
        }
        if (given.every((reason) => reason)) {
          break;
        }
        if (attempt === 1) {
          logger.warning("Explainer left reasons out, asking again");
        }
      }
      this._runCache.set(key, reasons);
    }
    return this._runCache.get(key) as _RunReasons;
  }

  /** The reason the explainer gives to `ask` after the spoken conversation. */
  protected async _reason(
    transcript: readonly TranscriptEntry[],
    criterion: string,
    ask: string,
  ): Promise<string> {
    const messages = transcript.filter((e) => e.role !== "tool");
    const key = _cacheKey(ask, messages);
    if (!this._cache.has(key)) {
      const schema = _Explainer._object({ reason: { type: "string" } });
      let reason = "";
      for (const _ of [1, 2]) {
        const response = await this._ask(criterion, messages, ask, schema);
        reason = response ? _Explainer._parseReason(response) : "";
        if (reason) {
          break;
        }
      }
      this._cache.set(key, reason);
    }
    return this._cache.get(key) as string;
  }

  /** The explainer's raw answer to `ask`, in `schema`'s shape, or `null` when the call failed or said nothing. */
  protected async _ask(
    criterion: string,
    messages: readonly TranscriptEntry[],
    ask: string,
    schema: Record<string, unknown>,
    options: { maxTokens?: number | null } = {},
  ): Promise<string | null> {
    // Copy the conversation and append the transient ask, so neither the ask
    // nor the answer ever lands in the persistent context.
    const context = new LLMContext({
      messages: messages.map((m) => ({ ...m })) as unknown as LLMContextMessage[],
    });
    context.addMessage({ role: "user", content: ask } as LLMContextMessage);

    // Log the conversation the explainer is about to read, before its answer,
    // so the debug log shows exactly what it saw. A run-level ask carries the
    // transcript itself, so that is what to show.
    const transcript = messages.map((m) => `  [${m.role}] ${m.content}`).join("\n");
    logger.debug(
      `Explainer explaining ${pyStrRepr(criterion)} over conversation:\n${
        transcript ||
        ask
          .split(/\r?\n/)
          .map((line) => `  ${line}`)
          .join("\n")
      }`,
    );

    let response: string | null;
    try {
      response = await waitFor(
        () =>
          this._service.runInference(context, {
            maxTokens: options.maxTokens ?? this._maxTokens,
            systemInstruction: EXPLAIN_SYSTEM_INSTRUCTION,
            responseSchema: schema,
          }),
        _EXPLAINER_TIMEOUT_S,
      );
    } catch (e) {
      rethrowIfCancelled(e);
      const name = e instanceof Error ? e.constructor.name : typeof e;
      const message = e instanceof Error ? e.message : String(e);
      logger.error(`Explainer call failed: ${name} (${message})`);
      return null;
    }
    if (!response) {
      logger.error("Explainer returned an empty response");
      return null;
    }
    logger.debug(`Explainer answered: ${response}`);
    return response;
  }

  /** `reasons`, with the ones it lacks taken from `answer`. */
  protected static _filled(reasons: _RunReasons, answer: _RunReasons): _RunReasons {
    const turns = new Map<string, Map<number, string>>();
    for (const [name, byTurn] of answer.turns) {
      const merged = new Map<number, string>();
      for (const [number, reason] of byTurn) {
        merged.set(number, reasons.turns.get(name)?.get(number) || reason);
      }
      turns.set(name, merged);
    }
    return new _RunReasons({ goal: reasons.goal || answer.goal, turns });
  }

  /** A schema for an object with exactly these properties, all required. */
  protected static _object(properties: Record<string, unknown>): Record<string, unknown> {
    return {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    };
  }

  /** The run answer's schema: the goal's reason when it is asked, and each asked turn's by its number. */
  protected static _runSchema(
    goal: JudgeVerdict | null,
    turns: Map<string, Map<number, JudgeVerdict>>,
  ): Record<string, unknown> {
    const reason = { type: "string" };
    const properties: Record<string, unknown> = goal !== null ? { goal: reason } : {};
    const asked = [...turns].filter(([, byTurn]) => byTurn.size > 0);
    if (asked.length > 0) {
      const byName: Record<string, unknown> = {};
      for (const [name, byTurn] of asked) {
        const byNumber: Record<string, unknown> = {};
        for (const number of byTurn.keys()) {
          byNumber[String(number)] = reason;
        }
        byName[name] = _Explainer._object(byNumber);
      }
      properties.turns = _Explainer._object(byName);
    }
    return _Explainer._object(properties);
  }

  /** A yes or a no as the ask words it. */
  protected static _satisfies(verdict: JudgeVerdict): string {
    return verdict.passed ? "satisfies" : "does not satisfy";
  }

  /** A turn's verdict as the ask words it: which outcome the classifier chose. */
  protected static _turnOutcome(verdict: JudgeVerdict): string {
    if (!verdict.passed) {
      return "fails the criterion";
    }
    const probabilities = verdict.probabilities;
    if ((probabilities.not_applicable ?? 0.0) > (probabilities.meets ?? 0.0)) {
      return "passes because the criterion does not apply to it";
    }
    return "meets the criterion";
  }

  /** The reason in the answer: its JSON `reason`, or the answer itself when it is plain text. */
  static _parseReason(response: string): string {
    const reason = _Explainer._jsonObject(response).reason;
    return reason ? _pyStr(reason).trim() : response.trim();
  }

  /**
   * The reasons in the run answer, for the turns asked about; one not given is empty.
   *
   * Criterion names match case-insensitively, and a turn is the number in its
   * key, so `"bot turn 2"` reads as turn 2. An answer that is not the
   * expected JSON gives no reasons, and is logged.
   */
  static _parseRunReasons(
    response: string,
    turns: Map<string, Map<number, JudgeVerdict>>,
  ): _RunReasons {
    const obj = _Explainer._jsonObject(response);
    if (Object.keys(obj).length === 0) {
      logger.warning(`Explainer answer was not the expected JSON: ${pyStrRepr(response)}`);
    }
    let goal = obj.goal;
    if (_isDict(goal)) {
      goal = goal.reason;
    }
    const given = new Map<string, Map<number, string>>();
    const answeredTurns = obj.turns || {};
    if (_isDict(answeredTurns)) {
      for (const [name, byTurn] of Object.entries(answeredTurns)) {
        if (_isDict(byTurn)) {
          const numbered = new Map<number, string>();
          for (const [k, v] of Object.entries(byTurn)) {
            const m = /\d+/.exec(k);
            if (m) numbered.set(Number.parseInt(m[0], 10), _pyStr(v));
          }
          given.set(name.toLowerCase(), numbered);
        }
      }
    }
    const reasons = new Map<string, Map<number, string>>();
    for (const [name, byTurn] of turns) {
      const out = new Map<number, string>();
      for (const n of byTurn.keys()) {
        out.set(n, (given.get(name.toLowerCase())?.get(n) ?? "").trim());
      }
      reasons.set(name, out);
    }
    return new _RunReasons({ goal: _pyStr(goal || "").trim(), turns: reasons });
  }

  /** The JSON object in the answer, or `{}` when there is none; a fenced or prefaced answer still parses. */
  static _jsonObject(response: string): Record<string, unknown> {
    let cleaned = response.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*|\s*```$/gm, "").trim();
    }
    const start = cleaned.indexOf("{");
    if (start !== -1) {
      const parsed = _rawDecode(cleaned.slice(start));
      if (_isDict(parsed)) {
        return parsed;
      }
    }
    return {};
  }
}

function _isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python's `str()` of a JSON value. */
function _pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return pyNumberRepr(value);
  if (value === true) return "True";
  if (value === false) return "False";
  if (value === null || value === undefined) return "None";
  return pyJsonDumps(value);
}

/**
 * Python's `json.JSONDecoder().raw_decode()`: the JSON value at the start of
 * `text`, ignoring whatever follows it, or `undefined` when there is none.
 */
function _rawDecode(text: string): unknown {
  // Find where the leading object ends, honouring strings, then parse it.
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(0, i + 1));
        } catch (e) {
          rethrowIfCancelled(e);
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Python's `json.dumps(..., sort_keys=True)` input: dicts with their keys sorted, recursively. */
function _sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(_sortKeys);
  if (
    _isDict(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = _sortKeys(value[key]);
    }
    return out;
  }
  return value;
}

/** Hash what a question was about (its kind, criterion and conversation) for the cache. */
function _cacheKey(...parts: unknown[]): string {
  return sha256Hex(
    pyJsonDumps(_sortKeys(parts), { ensureAscii: false, default: (v) => String(v) }),
  );
}
