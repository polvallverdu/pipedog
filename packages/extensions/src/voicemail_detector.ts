// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/extensions/voicemail/voicemail_detector.py

/**
 * Voicemail detection for outbound calls.
 *
 * A bot that places a call needs to know whether a person answered or the call
 * went to voicemail. `VoicemailDetector` listens to what the other side
 * says and asks a classifier; until it has an answer, `TTSGate` holds
 * the bot's speech back so a voicemail greeting is never talked over.
 *
 * Any classifier will do. An `LLMClassifier` needs a service with
 * `runInference()`, so a realtime LLM cannot back the detector.
 *
 * DIVERGENCE: upstream's deprecated `llm` and `custom_system_prompt` parameters
 * (deprecated since 1.12.0, removed in 2.0.0) are not ported, so `classifier`
 * is required.
 */

import { Queue, rethrowIfCancelled, sleep, type Task } from "@pipedog/asyncio";
import {
  type BaseClassifier,
  ChoiceQuestion,
  type ChoiceResult,
} from "@pipedog/core/classifiers/base_classifier";
import {
  EndFrame,
  type Frame,
  MetricsFrame,
  StopFrame,
  SystemFrame,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  WorkerFrame,
} from "@pipedog/core/frames/frames";
import type { MetricsData } from "@pipedog/core/metrics/metrics";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "@pipedog/core/processors/frame_processor";
import { logger } from "@pipedog/core/utils/logger";
import type { BaseNotifier } from "@pipedog/core/utils/sync/base_notifier";
import { EventNotifier } from "@pipedog/core/utils/sync/event_notifier";

// Lifecycle frames that must still flow after voicemail is detected.
function isClosedGateAllowed(frame: Frame): boolean {
  return (
    frame instanceof SystemFrame ||
    frame instanceof EndFrame ||
    frame instanceof StopFrame ||
    frame instanceof WorkerFrame
  );
}

type Verdict = "conversation" | "voicemail";

/** The question put to the classifier, with the transcript so far as the state. */
export const VOICEMAIL_QUESTION = new ChoiceQuestion({
  instructions:
    "A bot has placed an outbound phone call. This is what was heard after the " +
    "call connected. Decide whether a person answered or the call went to " +
    "voicemail.",
  options: {
    conversation:
      "a person answered: a greeting such as 'hello?', 'hi', 'yeah?' or " +
      "'John speaking'; a question to the caller such as 'who is this?' or " +
      "'can I help you?'; spontaneous speech that expects a reply",
    voicemail:
      "an automated greeting or carrier message: 'you've reached', 'leave a " +
      "message', 'I'm not available right now', 'call me back', 'mailbox is " +
      "full', 'not in service', 'all circuits are busy', 'our office is " +
      "currently closed'",
  },
});

export interface TTSGateOptions extends FrameProcessorOptions {
  /** Signals that a person answered and the buffered frames should play. */
  conversationNotifier: BaseNotifier;
  /** Signals that the call went to voicemail and the buffered frames should be dropped. */
  voicemailNotifier: BaseNotifier;
}

/**
 * Holds the bot's speech until the voicemail decision is made.
 *
 * Placed right after the TTS service. TTS frames are buffered while the
 * decision is pending; every other frame passes through. A conversation
 * verdict releases the buffered frames in order, a voicemail verdict
 * discards them, since they were meant for a person.
 */
export class TTSGate extends FrameProcessor {
  #conversationNotifier: BaseNotifier;
  #voicemailNotifier: BaseNotifier;
  #frameBuffer: [Frame, FrameDirection][] = [];
  #gatingActive = true;
  #conversationTask: Task<unknown> | null = null;
  #voicemailTask: Task<unknown> | null = null;

  constructor(options: TTSGateOptions) {
    super(options);
    this.#conversationNotifier = options.conversationNotifier;
    this.#voicemailNotifier = options.voicemailNotifier;
  }

  /**
   * Set up the processor with required components.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this.#conversationTask = this.createTask(() => this.#waitForConversation());
    this.#voicemailTask = this.createTask(() => this.#waitForVoicemail());
  }

  /** Clean up the processor resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    if (this.#conversationTask) {
      await this.cancelTask(this.#conversationTask);
      this.#conversationTask = null;
    }
    if (this.#voicemailTask) {
      await this.cancelTask(this.#voicemailTask);
      this.#voicemailTask = null;
    }
  }

  /**
   * Buffer TTS frames while the decision is pending; pass the rest.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (
      this.#gatingActive &&
      (frame instanceof TTSStartedFrame ||
        frame instanceof TTSStoppedFrame ||
        frame instanceof TTSTextFrame ||
        frame instanceof TTSAudioRawFrame)
    ) {
      this.#frameBuffer.push([frame, direction]);
    } else {
      await this.pushFrame(frame, direction);
    }
  }

  async #waitForConversation(): Promise<void> {
    await this.#conversationNotifier.wait();
    this.#gatingActive = false;
    for (const [frame, direction] of this.#frameBuffer) {
      await this.pushFrame(frame, direction);
    }
    this.#frameBuffer = [];
  }

  async #waitForVoicemail(): Promise<void> {
    await this.#voicemailNotifier.wait();
    this.#gatingActive = false;
    this.#frameBuffer = [];
  }
}

export interface VoicemailDetectorOptions extends FrameProcessorOptions {
  /**
   * What decides between a person and a voicemail. It is asked a `choice`
   * question with the transcript so far.
   */
  classifier: BaseClassifier;
  /**
   * Seconds of silence after a voicemail verdict before `on_voicemail_detected`
   * fires, so the message is left after the greeting ends and the recording
   * starts. Defaults to 2.0.
   */
  voicemailResponseDelay?: number;
  /**
   * Seconds of silence after the caller stops speaking before the latest
   * answer decides. A greeting resumes after its pauses while a person stays
   * quiet, so a verdict on a fragment such as "hi, this is Sam" is not acted
   * on until the caller has really stopped. Defaults to 1.0.
   */
  decisionTimeout?: number;
}

/**
 * Decides whether a person answered an outbound call or it went to voicemail.
 *
 * Placed after the STT service. It passes every frame through and collects
 * what the other side says. After each transcription it asks its classifier,
 * in the background, whether the call reached a person or a voicemail, and
 * keeps asking as more is said. Once the caller has been quiet for
 * `decisionTimeout`, the latest answer decides and the detector acts:
 *
 * - CONVERSATION: the bot's held-back speech is released and the call goes
 *   on as normal.
 * - VOICEMAIL: the held-back speech is dropped, the pipeline is interrupted,
 *   no further input reaches the conversation, and `on_voicemail_detected`
 *   fires once the greeting has finished, so the handler can leave a
 *   message.
 *
 * Event handlers available:
 *
 * - on_conversation_detected: A person answered. The handler receives the
 *   detector, which it can push frames through.
 * - on_voicemail_detected: The call went to voicemail and the greeting has
 *   been quiet for `voicemailResponseDelay` seconds. The handler
 *   receives the detector, which it can push frames through.
 *
 * @example
 * const detector = new VoicemailDetector({ classifier: new JevClassifier({ apiKey }) });
 *
 * detector.eventHandler("on_voicemail_detected", async (processor) => {
 *   await processor.pushFrame(new TTSSpeakFrame({ text: "Please call me back." }));
 * });
 *
 * const pipeline = new Pipeline([
 *   transport.input(),
 *   stt,
 *   detector.detector(), // Classification
 *   contextAggregator.user(),
 *   llm,
 *   tts,
 *   detector.gate(), // TTS gating
 *   transport.output(),
 *   contextAggregator.assistant(),
 * ]);
 */
export class VoicemailDetector extends FrameProcessor {
  protected _classifier: BaseClassifier;
  #voicemailResponseDelay: number;
  #decisionTimeout: number;

  // The gate that holds the bot's speech until the verdict.
  #conversationNotifier = new EventNotifier();
  #voicemailNotifier = new EventNotifier();
  #ttsGate: TTSGate;

  // What was heard so far, and what the classifier made of it. Transcriptions
  // are queued for the classifying task, which owns the transcript and
  // the answer.
  #segments = new Queue<string>();
  #classifyTask: Task<unknown> | null = null;
  #transcript: string[] = [];
  #lastResult: ChoiceResult | null = null;
  protected _decision: Verdict | null = null;

  // Two silence timers, each restarted by speech. The decision timer acts
  // on the latest answer once the caller has stopped; after a voicemail
  // verdict, the message timer fires the handler once the greeting has.
  #userSpeaking = false;
  #decisionTask: Task<unknown> | null = null;
  #messageTask: Task<unknown> | null = null;
  #messageLeft = false;

  constructor(options: VoicemailDetectorOptions) {
    super(options);
    if (!options.classifier) {
      throw new Error("VoicemailDetector needs a classifier");
    }
    this._classifier = options.classifier;
    this.#voicemailResponseDelay = options.voicemailResponseDelay ?? 2.0;
    this.#decisionTimeout = options.decisionTimeout ?? 1.0;

    this.#ttsGate = new TTSGate({
      conversationNotifier: this.#conversationNotifier,
      voicemailNotifier: this.#voicemailNotifier,
    });

    this._registerEventHandler("on_conversation_detected");
    this._registerEventHandler("on_voicemail_detected");

    this._classifier.addEventHandler("on_metrics", (_classifier, data: MetricsData[]) =>
      this.#onClassifierMetrics(data),
    );
  }

  /**
   * The processor to place after the STT service.
   *
   * @returns This detector.
   */
  detector(): VoicemailDetector {
    return this;
  }

  /**
   * The processor to place after the TTS service.
   *
   * @returns The gate that holds speech until the decision is made.
   */
  gate(): TTSGate {
    return this.#ttsGate;
  }

  /**
   * Set up the processor and its classifier.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._classifier.setup(this.taskManager);
    this.#classifyTask = this.createTask(() => this.#classifySegments());
  }

  /** Clean up the processor and its classifier. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    if (this.#classifyTask) {
      await this.cancelTask(this.#classifyTask);
      this.#classifyTask = null;
    }
    await this.#cancelDecisionTimer();
    await this.#cancelMessageTimer();
    await this._classifier.cleanup();
  }

  /**
   * Collect transcriptions, keep the voicemail timer, and gate after a voicemail.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof TranscriptionFrame && frame.text.trim()) {
      this.#segments.putNowait(frame.text.trim());
      // A transcription often lands after the caller has stopped; the
      // silence timer restarts from it.
      if (!this.#userSpeaking && !this._decision) {
        await this.#restartDecisionTimer();
      }
    } else if (frame instanceof UserStartedSpeakingFrame) {
      this.#userSpeaking = true;
      await this.#cancelDecisionTimer();
      await this.#cancelMessageTimer();
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      this.#userSpeaking = false;
      if (!this._decision) {
        await this.#restartDecisionTimer();
      } else if (this._decision === "voicemail" && !this.#messageLeft) {
        await this.#restartMessageTimer();
      }
    }

    // After a voicemail verdict nothing more should reach the conversation,
    // only the frames that end or control the pipeline.
    if (this._decision === "voicemail" && !isClosedGateAllowed(frame)) {
      return;
    }
    await this.pushFrame(frame, direction);
  }

  /**
   * Classify the transcript every time it grows.
   *
   * Segments that arrive during a classification are taken together, so
   * a burst of transcriptions costs one call on the full transcript.
   */
  async #classifySegments(): Promise<void> {
    while (true) {
      // Wait for a segment, then take any that arrived meanwhile.
      const segments = [await this.#segments.get()];
      while (!this.#segments.empty()) {
        segments.push(this.#segments.getNowait());
      }
      this.#transcript.push(...segments);
      try {
        // Nothing to ask once the verdict is in.
        if (!this._decision) {
          await this.#classify(this.#transcript.join(" "));
        }
      } finally {
        // Lets the silence timer know the transcript is fully classified.
        for (let i = 0; i < segments.length; i++) {
          this.#segments.taskDone();
        }
      }
    }
  }

  /** Ask the classifier about the transcript and keep its answer. */
  async #classify(transcript: string): Promise<void> {
    // Any failure is one missed answer; the silence timer must never be
    // left waiting on a classification that will not come.
    let results: Record<string, ChoiceResult>;
    try {
      results = await this._classifier.choice(transcript, { voicemail: VOICEMAIL_QUESTION });
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`${this}: classification failed: ${e}`);
      return;
    }
    const result = results.voicemail as ChoiceResult;
    logger.debug(
      `${this}: ${result.choice} (${result.confidence.toFixed(2)}) for ${JSON.stringify(transcript)}`,
    );
    // No verdict acts from here: "hi, this is Sam" is what a person says
    // and how a greeting starts, and only the silence that follows tells
    // them apart, so the silence timer decides.
    this.#lastResult = result;
  }

  /** Start the decision timer over. */
  async #restartDecisionTimer(): Promise<void> {
    await this.#cancelDecisionTimer();
    this.#decisionTask = this.createTask(() => this.#decideAfterSilence());
  }

  /** Stop the decision timer, if it is running. */
  async #cancelDecisionTimer(): Promise<void> {
    if (this.#decisionTask) {
      await this.cancelTask(this.#decisionTask);
      this.#decisionTask = null;
    }
  }

  /**
   * Act on the latest answer once the caller has been quiet long enough.
   *
   * A greeting goes on after its pauses; a person stops and waits. So this
   * is how every verdict comes to act.
   */
  async #decideAfterSilence(): Promise<void> {
    await sleep(this.#decisionTimeout);
    // The answer for everything heard so far, once a call in flight is
    // done. This cannot hang: the classifier answers or raises within a
    // timeout of its own, and every segment is marked done either way.
    await this.#segments.join();
    if (this._decision) {
      return;
    }
    if (this.#lastResult) {
      logger.debug(
        `${this}: ${this.#lastResult.choice} (${this.#lastResult.confidence.toFixed(2)}) ` +
          `after ${this.#decisionTimeout}s of silence`,
      );
      const choice = this.#lastResult.choice;
      await this.#decide(choice === "voicemail" ? "voicemail" : "conversation");
    } else {
      logger.warning(
        `${this}: no answer from the classifier after ${this.#decisionTimeout}s of ` +
          "silence, assuming a conversation",
      );
      await this.#decide("conversation");
    }
  }

  /** Record the verdict and act on it: release or drop the held speech. */
  async #decide(label: Verdict): Promise<void> {
    this._decision = label;
    if (label === "voicemail") {
      logger.debug(`${this}: VOICEMAIL detected`);
      await this.#voicemailNotifier.notify();
      await this.broadcastInterruption();
      await this.#restartMessageTimer();
    } else {
      logger.debug(`${this}: CONVERSATION detected`);
      await this.#conversationNotifier.notify();
      await this._callEventHandler("on_conversation_detected");
    }
  }

  /** Start the message timer over. */
  async #restartMessageTimer(): Promise<void> {
    await this.#cancelMessageTimer();
    this.#messageTask = this.createTask(() => this.#leaveMessageAfterQuiet());
  }

  /** Stop the message timer, if it is running. */
  async #cancelMessageTimer(): Promise<void> {
    if (this.#messageTask) {
      await this.cancelTask(this.#messageTask);
      this.#messageTask = null;
    }
  }

  /**
   * Fire `on_voicemail_detected` once the greeting has been quiet for the delay.
   *
   * Fires once: a beep or a prompt heard while the message is being left
   * does not start it over.
   */
  async #leaveMessageAfterQuiet(): Promise<void> {
    await sleep(this.#voicemailResponseDelay);
    this.#messageLeft = true;
    await this._callEventHandler("on_voicemail_detected");
  }

  /** Push the classifier's metrics into the pipeline. */
  async #onClassifierMetrics(data: MetricsData[]): Promise<void> {
    await this.pushFrame(new MetricsFrame({ data }));
  }
}
