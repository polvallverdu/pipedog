// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_voicemail_detector.py

import { describe, expect, test } from "bun:test";

import {
  BaseClassifier,
  ChoiceResult,
  ClassifierError,
  type ClassifierImage,
  type ClassifierQuestion,
  type ClassifierResult,
  type ClassifierValue,
} from "@pipedog/core/classifiers/base_classifier";
import {
  EndWorkerFrame,
  type Frame,
  LLMTextFrame,
  MetricsFrame,
  TranscriptionFrame,
  TTSStartedFrame,
  TTSTextFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import type { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import { ProcessingMetricsData } from "@pipedog/core/metrics/metrics";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { TextType } from "@pipedog/core/utils/text/base_text_aggregator";

import { VoicemailDetector } from "../src/voicemail_detector.ts";

// Long enough for a verdict to reach the delayed voicemail handler, which
// fires VOICEMAIL_DELAY after the verdict.
const VERDICT_SETTLE = 1.0;
const VOICEMAIL_DELAY = 0.1;
const DECISION_TIMEOUT = 0.2;

type Answer = [string, number] | Error;

/** Answers the voicemail question from a scripted list of answers. */
class FakeClassifier extends BaseClassifier {
  answers: Answer[];
  asked: ClassifierValue[] = [];
  setupTaskManager: unknown = null;
  cleanedUp = false;

  constructor(...answers: Answer[]) {
    super();
    this.answers = answers;
  }

  override async setup(taskManager: unknown): Promise<void> {
    this.setupTaskManager = taskManager;
  }

  override async cleanup(): Promise<void> {
    this.cleanedUp = true;
  }

  protected async _ask(
    state: ClassifierValue,
    questions: Readonly<Record<string, ClassifierQuestion>>,
    _images?: readonly ClassifierImage[],
  ): Promise<[Record<string, ClassifierResult>, LLMTokenUsage | null]> {
    this.asked.push(state);
    const answer = this.answers.shift() as Answer;
    if (answer instanceof Error) {
      throw answer;
    }
    const [label, confidence] = answer;
    const results: Record<string, ClassifierResult> = {};
    for (const [name, q] of Object.entries(questions)) {
      const probabilities: Record<string, number> = {};
      for (const o of Object.keys((q as { options: Record<string, unknown> }).options)) {
        probabilities[o] = Number(o === label);
      }
      results[name] = new ChoiceResult({ choice: label, probabilities, confidence });
    }
    return [results, null];
  }
}

class Passthrough extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);
  }
}

function names(frames: Frame[]): string[] {
  return frames.map((f) => f.constructor.name);
}

function said(text: string): TranscriptionFrame {
  return new TranscriptionFrame({ text, userId: "", timestamp: "" });
}

function makeDetector(...answers: Answer[]): [VoicemailDetector, FakeClassifier] {
  const classifier = new FakeClassifier(...answers);
  const detector = new VoicemailDetector({
    classifier,
    voicemailResponseDelay: VOICEMAIL_DELAY,
    decisionTimeout: DECISION_TIMEOUT,
  });
  return [detector, classifier];
}

describe("TestVoicemailDetectorVerdicts", () => {
  test("test_voicemail_verdict_fires_handler_with_the_transcript", async () => {
    const [detector, classifier] = makeDetector(["voicemail", 0.95]);
    const fired: unknown[] = [];

    detector.eventHandler("on_voicemail_detected", async (processor) => {
      fired.push(processor);
    });

    await runTest(detector, {
      framesToSend: [said("Hi, you've reached Sam."), new SleepFrame({ sleep: VERDICT_SETTLE })],
      startTimeout: 5.0,
    });
    expect(fired).toEqual([detector]);
    expect(classifier.asked).toEqual(["Hi, you've reached Sam."]);
  });

  test("test_each_classification_pushes_its_metrics", async () => {
    const [detector] = makeDetector(["conversation", 0.9]);

    const [down] = await runTest(detector, {
      framesToSend: [said("Hello?"), new SleepFrame({ sleep: VERDICT_SETTLE })],
      startTimeout: 5.0,
    });

    const metrics = down.filter((f): f is MetricsFrame => f instanceof MetricsFrame);
    expect(metrics.length).toEqual(1);
    expect(metrics[0]?.data.length).toEqual(1);
    const processing = metrics[0]?.data[0];
    expect(processing).toBeInstanceOf(ProcessingMetricsData);
    expect(processing?.processor).toEqual((detector as any)._classifier.name);
  });

  test("test_conversation_verdict_fires_handler", async () => {
    const [detector] = makeDetector(["conversation", 0.9]);
    const fired: unknown[] = [];

    detector.eventHandler("on_conversation_detected", async (processor) => {
      fired.push(processor);
    });

    await runTest(detector, {
      framesToSend: [said("Hello?"), new SleepFrame({ sleep: VERDICT_SETTLE })],
      startTimeout: 5.0,
    });
    expect(fired).toEqual([detector]);
  });

  test("test_a_later_answer_replaces_an_earlier_one", async () => {
    const [detector, classifier] = makeDetector(["voicemail", 0.4], ["voicemail", 0.95]);
    const fired: unknown[] = [];

    detector.eventHandler("on_voicemail_detected", async (processor) => {
      fired.push(processor);
    });

    await runTest(detector, {
      framesToSend: [
        new UserStartedSpeakingFrame(),
        said("Hi,"),
        new SleepFrame({ sleep: 0.2 }),
        said("you've reached Sam. Leave a message."),
        new UserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: VERDICT_SETTLE }),
      ],
      startTimeout: 5.0,
    });
    expect(fired.length).toEqual(1);
    expect(classifier.asked).toEqual(["Hi,", "Hi, you've reached Sam. Leave a message."]);
  });

  test("test_classifier_error_does_not_decide", async () => {
    const [detector, classifier] = makeDetector(new ClassifierError("down"), ["conversation", 0.9]);
    const fired: unknown[] = [];

    detector.eventHandler("on_conversation_detected", async (processor) => {
      fired.push(processor);
    });

    await runTest(detector, {
      framesToSend: [
        new UserStartedSpeakingFrame(),
        said("Hello?"),
        new SleepFrame({ sleep: 0.2 }),
        said("Anyone there?"),
        new UserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: VERDICT_SETTLE }),
      ],
      startTimeout: 5.0,
    });
    expect(fired.length).toEqual(1);
    expect(classifier.asked.length).toEqual(2);
  });

  test("test_an_unexpected_classifier_error_does_not_hang_the_decision", async () => {
    const [detector, classifier] = makeDetector(new Error("connection reset"), [
      "conversation",
      0.9,
    ]);
    const fired: unknown[] = [];

    detector.eventHandler("on_conversation_detected", async (processor) => {
      fired.push(processor);
    });

    await runTest(detector, {
      framesToSend: [
        new UserStartedSpeakingFrame(),
        said("Hello?"),
        new SleepFrame({ sleep: 0.2 }),
        said("Anyone there?"),
        new UserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: VERDICT_SETTLE }),
      ],
      startTimeout: 5.0,
    });
    expect(fired.length).toEqual(1);
    expect(classifier.asked.length).toEqual(2);
  });

  test("test_setup_and_cleanup_reach_the_classifier", async () => {
    const [detector, classifier] = makeDetector(["conversation", 0.9]);
    await runTest(detector, { framesToSend: [said("Hello?")], startTimeout: 5.0 });
    expect(classifier.setupTaskManager).not.toBeNull();
    expect(classifier.cleanedUp).toBe(true);
  });
});

describe("TestVoicemailDetectorFallback", () => {
  // Silence decides with the latest answer; more speech restarts the wait.

  test("test_silence_decides_with_the_best_answer_so_far", async () => {
    const classifier = new FakeClassifier(["voicemail", 0.3]);
    const detector = new VoicemailDetector({
      classifier,
      decisionTimeout: 0.2,
      voicemailResponseDelay: VOICEMAIL_DELAY,
    });
    const fired: unknown[] = [];

    detector.eventHandler("on_voicemail_detected", async (processor) => {
      fired.push(processor);
    });

    await runTest(detector, {
      framesToSend: [
        said("Hi, this is Sam."),
        new UserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.5 + VERDICT_SETTLE }),
      ],
      startTimeout: 5.0,
    });
    expect(fired).toEqual([detector]);
  });

  test("test_the_message_is_left_once", async () => {
    // A beep or a prompt heard after the message started must not leave
    // it again.
    const [detector] = makeDetector(["voicemail", 0.9]);
    const fired: unknown[] = [];

    detector.eventHandler("on_voicemail_detected", async (processor) => {
      fired.push(processor);
    });

    await runTest(detector, {
      framesToSend: [
        new UserStartedSpeakingFrame(),
        said("Hi, you've reached Sam. Leave a message after the tone."),
        new UserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: VERDICT_SETTLE }),
        new UserStartedSpeakingFrame(),
        new SleepFrame({ sleep: 0.1 }),
        new UserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: VERDICT_SETTLE }),
      ],
      startTimeout: 5.0,
    });
    expect(fired.length).toEqual(1);
  });

  test("test_more_speech_cancels_the_silence_decision", async () => {
    const classifier = new FakeClassifier(["voicemail", 0.3], ["conversation", 0.3]);
    const detector = new VoicemailDetector({ classifier, decisionTimeout: 0.3 });
    const fired: unknown[] = [];

    detector.eventHandler("on_voicemail_detected", async (processor) => {
      fired.push(processor);
    });

    await runTest(detector, {
      framesToSend: [
        said("Hi, this is Sam."),
        new UserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.1 }),
        new UserStartedSpeakingFrame(),
        new SleepFrame({ sleep: 0.4 }),
      ],
      startTimeout: 5.0,
    });
    expect(fired).toEqual([]);
    expect((detector as any)._decision).toBeNull();
  });

  test("test_a_voicemail_verdict_waits_for_the_caller_to_stop", async () => {
    // The caller is still speaking: "Hi, this is Sam" looks like a person,
    // then the greeting goes on and turns out to be a voicemail. Neither
    // verdict acts until the caller stops.
    const answers: Answer[] = [
      ["conversation", 0.99],
      ["voicemail", 0.98],
    ];
    let [detector] = makeDetector(...answers);
    const fired: { conversation: unknown[]; voicemail: unknown[] } = {
      conversation: [],
      voicemail: [],
    };

    detector.eventHandler("on_conversation_detected", async (processor) => {
      fired.conversation.push(processor);
    });
    detector.eventHandler("on_voicemail_detected", async (processor) => {
      fired.voicemail.push(processor);
    });

    const speaking = () => [
      new UserStartedSpeakingFrame(),
      said("Hi, this is Sam."),
      new SleepFrame({ sleep: 0.2 }),
      said("Sorry I missed your call, leave a message."),
      new SleepFrame({ sleep: VERDICT_SETTLE }),
    ];
    await runTest(detector, { framesToSend: speaking(), startTimeout: 5.0 });
    expect(fired).toEqual({ conversation: [], voicemail: [] });

    [detector] = makeDetector(...answers);

    detector.eventHandler("on_conversation_detected", async (processor) => {
      fired.conversation.push(processor);
    });
    detector.eventHandler("on_voicemail_detected", async (processor) => {
      fired.voicemail.push(processor);
    });

    await runTest(detector, {
      framesToSend: [
        ...speaking(),
        new UserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: VERDICT_SETTLE }),
      ],
      startTimeout: 5.0,
    });
    expect(fired).toEqual({ conversation: [], voicemail: [detector] });
  });

  test("test_a_confident_conversation_decides_after_the_silence", async () => {
    let classifier = new FakeClassifier(["conversation", 0.99]);
    let detector = new VoicemailDetector({ classifier, decisionTimeout: 0.4 });
    const fired: unknown[] = [];

    detector.eventHandler("on_conversation_detected", async (processor) => {
      fired.push(processor);
    });

    await runTest(detector, {
      framesToSend: [
        new UserStartedSpeakingFrame(),
        said("Hello?"),
        new SleepFrame({ sleep: 0.1 }),
        new UserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.2 }),
      ],
      startTimeout: 5.0,
    });
    // a conversation verdict waits out the silence
    expect(fired).toEqual([]);

    fired.length = 0;
    classifier = new FakeClassifier(["conversation", 0.99]);
    detector = new VoicemailDetector({ classifier, decisionTimeout: 0.2 });

    detector.eventHandler("on_conversation_detected", async (processor) => {
      fired.push(processor);
    });

    await runTest(detector, {
      framesToSend: [
        new UserStartedSpeakingFrame(),
        said("Hello?"),
        new SleepFrame({ sleep: 0.1 }),
        new UserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.5 }),
      ],
      startTimeout: 5.0,
    });
    expect(fired).toEqual([detector]);
  });

  test("test_silence_without_any_answer_assumes_a_conversation", async () => {
    const classifier = new FakeClassifier(new ClassifierError("down"));
    const detector = new VoicemailDetector({ classifier, decisionTimeout: 0.2 });
    const fired: unknown[] = [];

    detector.eventHandler("on_conversation_detected", async (processor) => {
      fired.push(processor);
    });

    await runTest(detector, {
      framesToSend: [
        said("Hello?"),
        new UserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.5 + VERDICT_SETTLE }),
      ],
      startTimeout: 5.0,
    });
    expect(fired).toEqual([detector]);
  });
});

describe("TestVoicemailDetectorGating", () => {
  test("test_conversation_releases_held_speech", async () => {
    const [detector] = makeDetector(["conversation", 0.9]);
    const [down] = await runTest(new Pipeline([detector, detector.gate()]), {
      framesToSend: [
        new TTSStartedFrame(),
        new TTSTextFrame({ text: "Hi, this is Alex.", textType: TextType.SENTENCE }),
        new SleepFrame({ sleep: 0.2 }),
        said("Hello?"),
        new SleepFrame({ sleep: VERDICT_SETTLE }),
      ],
      startTimeout: 5.0,
    });
    const frameNames = names(down);
    expect(frameNames).toContain("TTSTextFrame");
    expect(frameNames.indexOf("TTSStartedFrame")).toBeLessThan(frameNames.indexOf("TTSTextFrame"));
  });

  test("test_voicemail_drops_held_speech_and_blocks_later_input", async () => {
    const [detector] = makeDetector(["voicemail", 0.95]);
    const [down] = await runTest(new Pipeline([detector, detector.gate()]), {
      framesToSend: [
        new TTSStartedFrame(),
        new TTSTextFrame({ text: "Hi, this is Alex.", textType: TextType.SENTENCE }),
        new SleepFrame({ sleep: 0.2 }),
        said("Please leave a message."),
        new SleepFrame({ sleep: VERDICT_SETTLE }),
        new LLMTextFrame({ text: "should not reach the conversation" }),
        new SleepFrame({ sleep: 0.2 }),
      ],
      startTimeout: 5.0,
    });
    const frameNames = names(down);
    expect(frameNames).not.toContain("TTSTextFrame");
    expect(frameNames).not.toContain("LLMTextFrame");
  });

  test("test_transcriptions_pass_through_before_a_verdict", async () => {
    const [detector] = makeDetector(["conversation", 0.9]);
    const [down] = await runTest(detector, {
      framesToSend: [said("Hello?"), new SleepFrame({ sleep: VERDICT_SETTLE })],
      startTimeout: 5.0,
    });
    expect(names(down)).toContain("TranscriptionFrame");
  });
});

describe("TestVoicemailDetectorEndWorkerFrame", () => {
  test("test_handler_pushing_upstream_ends_worker", async () => {
    const [detector] = makeDetector(["voicemail", 0.95]);

    detector.eventHandler("on_voicemail_detected", async (processor) => {
      await processor.pushFrame(
        new EndWorkerFrame({ reason: "Voicemail detected." }),
        FrameDirection.UPSTREAM,
      );
    });

    const [, up] = await runTest(detector, {
      framesToSend: [said("Please leave a message."), new SleepFrame({ sleep: VERDICT_SETTLE })],
      startTimeout: 5.0,
    });
    expect(
      up.some((f) => f instanceof EndWorkerFrame),
      `EndWorkerFrame did not escape upstream: ${names(up)}`,
    ).toBe(true);
  });

  test("test_handler_pushing_downstream_ends_worker", async () => {
    const [detector] = makeDetector(["voicemail", 0.95]);

    detector.eventHandler("on_voicemail_detected", async (processor) => {
      await processor.pushFrame(
        new EndWorkerFrame({ reason: "Voicemail detected." }),
        FrameDirection.DOWNSTREAM,
      );
    });

    const [down] = await runTest(detector, {
      framesToSend: [said("Please leave a message."), new SleepFrame({ sleep: VERDICT_SETTLE })],
      startTimeout: 5.0,
    });
    expect(
      down.some((f) => f instanceof EndWorkerFrame),
      `EndWorkerFrame did not escape downstream: ${names(down)}`,
    ).toBe(true);
  });

  test("test_voicemail_verdict_lets_upstream_end_from_main_pipeline", async () => {
    const [detector] = makeDetector(["voicemail", 0.95]);
    const ender = new Passthrough();

    detector.eventHandler("on_voicemail_detected", async () => {
      await ender.pushFrame(
        new EndWorkerFrame({ reason: "VOICEMAIL detected." }),
        FrameDirection.UPSTREAM,
      );
    });

    const [, up] = await runTest(new Pipeline([detector, ender]), {
      framesToSend: [said("Please leave a message."), new SleepFrame({ sleep: VERDICT_SETTLE })],
      startTimeout: 5.0,
    });
    expect(
      up.some((f) => f instanceof EndWorkerFrame),
      `EndWorkerFrame did not escape upstream after VOICEMAIL: ${names(up)}`,
    ).toBe(true);
  });

  test("test_conversation_verdict_lets_upstream_end_from_main_pipeline", async () => {
    const [detector] = makeDetector(["conversation", 0.9]);
    const ender = new Passthrough();

    detector.eventHandler("on_conversation_detected", async () => {
      await ender.pushFrame(
        new EndWorkerFrame({ reason: "CONVERSATION detected." }),
        FrameDirection.UPSTREAM,
      );
    });

    const [, up] = await runTest(new Pipeline([detector, ender]), {
      framesToSend: [said("Hello?"), new SleepFrame({ sleep: VERDICT_SETTLE })],
      startTimeout: 5.0,
    });
    expect(
      up.some((f) => f instanceof EndWorkerFrame),
      `EndWorkerFrame did not escape upstream after CONVERSATION: ${names(up)}`,
    ).toBe(true);
  });
});

describe("TestDeprecatedLLMParameter", () => {
  // DIVERGENCE: the deprecated `llm` and `custom_system_prompt` parameters are not
  // ported (deprecated upstream since 1.12.0, removed in 2.0.0).
  test.skip("test_llm_parameter_warns", () => {
    // Exercises only the deprecated `llm=` parameter.
  });

  test("test_needs_a_classifier_or_an_llm", () => {
    // Without the deprecated `llm`, only a classifier will do.
    expect(() => new VoicemailDetector({} as never)).toThrow("needs a classifier");
  });

  test.skip("test_llm_builds_an_llm_classifier", () => {
    // Exercises only the deprecated `llm=` / `custom_system_prompt=` parameters.
  });
});
