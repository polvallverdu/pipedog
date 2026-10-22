// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: the IVR processor turns LLM text into
// DTMF frames and status events, and the voicemail detector decides a call
// with a scripted classifier and gates the bot's speech, in a real pipeline.

import {
  BaseClassifier,
  ChoiceResult,
  type ClassifierQuestion,
  type ClassifierResult,
  type ClassifierValue,
} from "@pipedog/core/classifiers/base_classifier";
import {
  LLMMessagesUpdateFrame,
  LLMTextFrame,
  OutputDTMFUrgentFrame,
  TextFrame,
  TranscriptionFrame,
  TTSStartedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import type { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { logger } from "@pipedog/core/utils/logger";

import { IVRProcessor, IVRStatus } from "../src/ivr_navigator.ts";
import { VoicemailDetector } from "../src/voicemail_detector.ts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`extensions smoke: ${message}`);
}

class ScriptedClassifier extends BaseClassifier {
  label: string;

  constructor(label: string) {
    super();
    this.label = label;
  }

  protected async _ask(
    _state: ClassifierValue,
    questions: Readonly<Record<string, ClassifierQuestion>>,
  ): Promise<[Record<string, ClassifierResult>, LLMTokenUsage | null]> {
    const results: Record<string, ClassifierResult> = {};
    for (const name of Object.keys(questions)) {
      results[name] = new ChoiceResult({
        choice: this.label,
        probabilities: { [this.label]: 1 },
        confidence: 0.9,
      });
    }
    return [results, null];
  }
}

async function ivr(): Promise<void> {
  const processor = new IVRProcessor({ classifierPrompt: "classify", ivrPrompt: "navigate" });
  const statuses: unknown[] = [];
  processor.addEventHandler("on_ivr_status_changed", async (_p, status) => {
    statuses.push(status);
  });
  const [down, up] = await runTest(processor, {
    framesToSend: [
      new LLMTextFrame({ text: "<dtmf>1</dtmf>" }),
      new LLMTextFrame({ text: "<ivr>completed</ivr>" }),
    ],
  });
  const buttons = down
    .filter((f): f is OutputDTMFUrgentFrame => f instanceof OutputDTMFUrgentFrame)
    .map((f) => f.buttons?.join(""));
  check(buttons.join() === "1", `DTMF frames: ${buttons}`);
  check(down.filter((f) => f instanceof TextFrame).length === 2, "context text frames");
  check(
    up.some((f) => f instanceof LLMMessagesUpdateFrame),
    "classifier prompt update",
  );
  check(statuses.join() === IVRStatus.COMPLETED, `statuses: ${statuses}`);
}

async function voicemail(label: "conversation" | "voicemail"): Promise<void> {
  const detector = new VoicemailDetector({
    classifier: new ScriptedClassifier(label),
    decisionTimeout: 0.1,
    voicemailResponseDelay: 0.05,
  });
  const fired: string[] = [];
  detector.addEventHandler("on_conversation_detected", async () => {
    fired.push("conversation");
  });
  detector.addEventHandler("on_voicemail_detected", async () => {
    fired.push("voicemail");
  });
  const [down] = await runTest(new Pipeline([detector, detector.gate()]), {
    framesToSend: [
      new TTSStartedFrame(),
      new TTSTextFrame({ text: "Hi, this is Alex.", textType: "sentence" }),
      new SleepFrame({ sleep: 0.1 }),
      new TranscriptionFrame({ text: "Hello?", userId: "", timestamp: "" }),
      new SleepFrame({ sleep: 0.6 }),
    ],
    startTimeout: 5.0,
  });
  check(fired.join() === label, `${label}: fired ${fired}`);
  const heldSpeechReleased = down.some((f) => f instanceof TTSTextFrame);
  check(heldSpeechReleased === (label === "conversation"), `${label}: held speech`);
}

export default async function smoke(): Promise<void> {
  logger.setLevel("CRITICAL");
  await ivr();
  await voicemail("conversation");
  await voicemail("voicemail");
}
