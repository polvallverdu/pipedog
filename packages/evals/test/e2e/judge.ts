// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A fake judge for the evals end-to-end test, named by the scenario's
// `judge.eval.factory`. It stands in for an LLM classifier: a reply meets a
// criterion when it holds the word the criterion quotes ('... "Berlin" ...'),
// or, when the criterion quotes nothing, when there is a reply at all. Every
// question it is asked is recorded in `asked`.

import {
  BaseClassifier,
  ChoiceResult,
  type ClassifierQuestion,
  type ClassifierResult,
  type ClassifierValue,
  YesNoResult,
} from "@pipedog/core/classifiers/base_classifier";

export const asked: { state: Record<string, unknown>; questions: string[] }[] = [];

class KeywordClassifier extends BaseClassifier {
  protected async _ask(
    state: ClassifierValue,
    questions: Readonly<Record<string, ClassifierQuestion>>,
  ): Promise<[Record<string, ClassifierResult>, null]> {
    const s = state as Record<string, unknown>;
    asked.push({ state: s, questions: Object.keys(questions) });
    const reply = String(s.latest_bot_reply ?? "");
    const answers: Record<string, ClassifierResult> = {};
    for (const [name, question] of Object.entries(questions)) {
      const instructions = (question as { instructions: string }).instructions;
      const quoted = /"([^"]+)"/.exec(instructions.split("Criterion").pop() ?? "")?.[1];
      const meets = reply.trim() !== "" && (!quoted || reply.includes(quoted));
      const options = Object.keys((question as { options?: Record<string, string> }).options ?? {});
      if (options.length === 0) {
        answers[name] = new YesNoResult({ probability: meets ? 0.99 : 0.01 });
        continue;
      }
      const choice = meets ? "yes" : "no";
      const probabilities = Object.fromEntries(options.map((o) => [o, o === choice ? 0.99 : 0]));
      answers[name] = new ChoiceResult({ choice, probabilities, confidence: 0.99 });
    }
    return [answers, null];
  }
}

/** The `judge.eval.factory`: takes the config block, returns the classifier. */
export function judge(_config: Record<string, unknown>): BaseClassifier {
  return new KeywordClassifier();
}
