// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/concepts/turn-detection.mdx and turn-strategies.mdx.
// Type-checked on every docs build.

import { sleep, type Task } from "@pipedog/asyncio";
import { SileroVADAnalyzer } from "@pipedog/audio-silero";
import { createLocalSmartTurnAnalyzerV3, HttpSmartTurnAnalyzer } from "@pipedog/audio-smart-turn";
import { WorkersAISmartTurnAnalyzer } from "@pipedog/cloudflare/smart_turn";
import {
  type Frame,
  ProposedUserStartedSpeakingFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import {
  LLMContextAggregatorPair,
  LLMUserAggregatorParams,
} from "@pipedog/core/processors/aggregators/llm_response_universal";
import { EmptyUserTurnConfig } from "@pipedog/core/turns/empty_user_turn";
import {
  BaseUserTurnStartStrategy,
  MinWordsUserTurnStartStrategy,
  TranscriptionUserTurnStartStrategy,
  VADUserTurnStartStrategy,
  WakePhraseUserTurnStartStrategy,
} from "@pipedog/core/turns/user_start/index";
import type { ReportUserTurnStoppedOptions } from "@pipedog/core/turns/user_stop/base_user_turn_stop_strategy";
import {
  ExactMatch,
  ExternalUserTurnStopStrategy,
  LLMTurnCompletionUserTurnStopStrategy,
  SpeechTimeoutUserTurnStopStrategy,
  TurnAnalyzerUserTurnStopStrategy,
} from "@pipedog/core/turns/user_stop/index";
import { UserTurnCompletionConfig } from "@pipedog/core/turns/user_turn_completion_mixin";
import {
  EagerUserTurnStrategies,
  FilterIncompleteUserTurnStrategies,
  MergeMode,
  StrategyMode,
  UserTurnStrategies,
  UserTurnStrategiesParams,
} from "@pipedog/core/turns/user_turn_strategies";
import { OpenAIRealtimeSTTService } from "@pipedog/openai/stt";

const context = new LLMContext();

{
  // #region local-models
  const aggregators = new LLMContextAggregatorPair(context, {
    userParams: new LLMUserAggregatorParams({ vadAnalyzer: new SileroVADAnalyzer() }),
  });
  // #endregion local-models
  void aggregators;
}

{
  // #region vad-only
  const userParams = new LLMUserAggregatorParams({
    vadAnalyzer: new SileroVADAnalyzer(),
    userTurnStrategies: new UserTurnStrategies({
      stop: [new SpeechTimeoutUserTurnStopStrategy()],
    }),
  });
  // #endregion vad-only
  void userParams;
}

{
  // #region provider
  const stt = new OpenAIRealtimeSTTService({
    apiKey: process.env.OPENAI_API_KEY ?? "",
    turnDetection: { type: "server_vad" },
  });
  // No vadAnalyzer: the STT service's turn signals drive the turns.
  const aggregators = new LLMContextAggregatorPair(context);
  // #endregion provider
  void stt;
  void aggregators;
}

{
  // #region explicit-defaults
  const userParams = new LLMUserAggregatorParams({
    vadAnalyzer: new SileroVADAnalyzer(),
    userTurnStrategies: new UserTurnStrategies({
      // The first start strategy to fire opens the turn.
      start: [new VADUserTurnStartStrategy(), new TranscriptionUserTurnStartStrategy()],
      // Smart Turn decides when the user is done.
      stop: [
        new TurnAnalyzerUserTurnStopStrategy({ turnAnalyzer: createLocalSmartTurnAnalyzerV3() }),
      ],
    }),
    // The first start strategy to decide starts the turn; every stop strategy
    // has to agree before it ends.
    userTurnStrategiesParams: new UserTurnStrategiesParams({
      startMode: StrategyMode.FIRST,
      stopMode: StrategyMode.ALL,
    }),
    // A turn with no speech, transcript or turn activity for this long ends anyway.
    userTurnStopTimeout: 5.0,
  });
  // #endregion explicit-defaults
  void userParams;
}

{
  // #region http-smart-turn
  // Smart Turn as a service: each candidate turn is POSTed to the endpoint.
  const userParams = new LLMUserAggregatorParams({
    vadAnalyzer: new SileroVADAnalyzer(),
    userTurnStrategies: new UserTurnStrategies({
      start: [new VADUserTurnStartStrategy(), new TranscriptionUserTurnStartStrategy()],
      stop: [
        new TurnAnalyzerUserTurnStopStrategy({
          turnAnalyzer: new HttpSmartTurnAnalyzer({
            url: "https://smart-turn.example.com/predict",
            headers: { Authorization: `Bearer ${process.env.SMART_TURN_KEY}` },
          }),
        }),
      ],
    }),
  });
  // #endregion http-smart-turn
  void userParams;
}

{
  const env = { AI: { run: async (_model: string, _input: unknown) => ({}) } };
  // #region workers-ai-smart-turn
  // Smart Turn v2 on Workers AI: the AI binding in a Worker, or accountId and apiToken elsewhere.
  const userParams = new LLMUserAggregatorParams({
    vadAnalyzer: new SileroVADAnalyzer(),
    userTurnStrategies: new UserTurnStrategies({
      start: [new VADUserTurnStartStrategy(), new TranscriptionUserTurnStartStrategy()],
      stop: [
        new TurnAnalyzerUserTurnStopStrategy({
          turnAnalyzer: new WorkersAISmartTurnAnalyzer({ ai: env.AI }),
        }),
      ],
    }),
  });
  // #endregion workers-ai-smart-turn
  void userParams;
}

{
  // #region min-words
  const userParams = new LLMUserAggregatorParams({
    vadAnalyzer: new SileroVADAnalyzer(),
    userTurnStrategies: new UserTurnStrategies({
      // No VAD start strategy: it would open the turn on the first sound.
      start: [new MinWordsUserTurnStartStrategy({ minWords: 3 })],
      stop: [new SpeechTimeoutUserTurnStopStrategy()],
    }),
  });
  // #endregion min-words
  void userParams;
}

{
  // #region wake-phrase
  const wakePhrase = new WakePhraseUserTurnStartStrategy({
    phrases: ["hey pipedog", "ok pipedog"],
    timeout: 10.0, // seconds of inactivity before the wake phrase is needed again
  });

  wakePhrase.eventHandler("on_wake_phrase_detected", async (_strategy, phrase: string) => {
    console.log(`woken up by "${phrase}"`);
  });
  wakePhrase.eventHandler("on_wake_phrase_timeout", async () => {
    console.log("asleep again");
  });

  const userParams = new LLMUserAggregatorParams({
    vadAnalyzer: new SileroVADAnalyzer(),
    userTurnStrategies: new UserTurnStrategies({
      // It starts turns on its own once awake, so it is the only start strategy.
      start: [wakePhrase],
    }),
  });
  // #endregion wake-phrase
  void userParams;
}

{
  // #region wake-phrase-all
  // Every start strategy has to agree: the wake phrase, and three words.
  const userParams = new LLMUserAggregatorParams({
    vadAnalyzer: new SileroVADAnalyzer(),
    userTurnStrategies: new UserTurnStrategies({
      start: [
        new WakePhraseUserTurnStartStrategy({ phrases: ["hey pipedog"] }),
        new MinWordsUserTurnStartStrategy({ minWords: 3 }),
      ],
    }),
    userTurnStrategiesParams: new UserTurnStrategiesParams({ startMode: StrategyMode.ALL }),
  });
  // #endregion wake-phrase-all
  void userParams;
}

{
  // #region stop-mode
  // Two stop strategies: by default (StrategyMode.ALL) both must agree.
  // StrategyMode.FIRST ends the turn on whichever decides first.
  const userParams = new LLMUserAggregatorParams({
    vadAnalyzer: new SileroVADAnalyzer(),
    userTurnStrategies: new UserTurnStrategies({
      stop: [
        new TurnAnalyzerUserTurnStopStrategy({ turnAnalyzer: createLocalSmartTurnAnalyzerV3() }),
        new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: 2.0 }),
      ],
    }),
    userTurnStrategiesParams: new UserTurnStrategiesParams({ stopMode: StrategyMode.FIRST }),
  });
  // #endregion stop-mode
  void userParams;
}

{
  // #region no-interruptions
  const userParams = new LLMUserAggregatorParams({
    vadAnalyzer: new SileroVADAnalyzer(),
    userTurnStrategies: new UserTurnStrategies({
      start: [
        new VADUserTurnStartStrategy({ enableInterruptions: false }),
        new TranscriptionUserTurnStartStrategy({ enableInterruptions: false }),
      ],
    }),
  });
  // #endregion no-interruptions
  void userParams;
}

{
  // #region speech-timeout
  const stop = new SpeechTimeoutUserTurnStopStrategy({
    userSpeechTimeout: 0.8, // wait a little longer before answering
  });
  // #endregion speech-timeout
  void stop;
}

{
  // #region smart-turn
  const stop = new TurnAnalyzerUserTurnStopStrategy({
    turnAnalyzer: createLocalSmartTurnAnalyzerV3({ cpuCount: 2 }),
  });
  // #endregion smart-turn
  void stop;
}

{
  // #region filter-incomplete
  // Smart Turn decides the user stopped, which runs the inference; the LLM's
  // ● marker then ends the turn.
  const strategies = new FilterIncompleteUserTurnStrategies({
    config: new UserTurnCompletionConfig({
      incompleteShortTimeout: 5.0,
      incompleteLongTimeout: 10.0,
    }),
  });

  // The same strategies, built by hand:
  const byHand = new UserTurnStrategies({
    stop: [
      new TurnAnalyzerUserTurnStopStrategy({ turnAnalyzer: createLocalSmartTurnAnalyzerV3() }),
      new LLMTurnCompletionUserTurnStopStrategy(),
    ],
  });

  // On top of the turn detection an STT service recommends:
  const extending = new LLMUserAggregatorParams({
    userTurnStrategies: new FilterIncompleteUserTurnStrategies(),
    userTurnStrategiesParams: new UserTurnStrategiesParams({ stopMergeMode: MergeMode.EXTEND }),
  });
  // #endregion filter-incomplete
  void strategies;
  void byHand;
  void extending;
}

{
  // #region eager
  const strategies = new EagerUserTurnStrategies({
    matchPolicy: new ExactMatch(), // default: NormalizedMatch
    speculationTimeout: 5.0,
  });
  // #endregion eager
  void strategies;
}

{
  // #region empty-turn
  const userParams = new LLMUserAggregatorParams({
    vadAnalyzer: new SileroVADAnalyzer(),
    emptyUserTurn: new EmptyUserTurnConfig({
      idlePrompt: "The user made a sound but said nothing clear. Ask if they said something.",
      maxConsecutiveRecoveries: 2,
    }),
  });
  // #endregion empty-turn
  void userParams;
}

// #region custom-start
/** Decides the user started on a final transcript that ends with a question mark. */
export class QuestionUserTurnStartStrategy extends BaseUserTurnStartStrategy {
  override async processFrame(frame: Frame): Promise<void> {
    if (frame instanceof TranscriptionFrame && frame.text.trim().endsWith("?")) {
      // The turn controller starts the turn on this decision (StrategyMode.FIRST),
      // or once every start strategy has decided (StrategyMode.ALL).
      await this.reportUserTurnStarted();
    }
  }
}
// #endregion custom-start

// #region custom-stop
/** Waits a grace period after the service says the user stopped. */
export class GracePeriodUserTurnStopStrategy extends ExternalUserTurnStopStrategy {
  #pending: Task<unknown> | null = null;

  /** Cancel a pending report when the user starts speaking again. */
  override async processFrame(frame: Frame): Promise<void> {
    if (frame instanceof ProposedUserStartedSpeakingFrame) {
      await this.#cancelPending();
    }
    await super.processFrame(frame);
  }

  // The base strategy calls this to report that the user is done, so this is
  // where a subclass adjusts the timing.
  override async reportUserTurnStopped(options: ReportUserTurnStoppedOptions = {}): Promise<void> {
    if (this.#pending) return;
    this.#pending = this.createTask(async () => {
      await sleep(0.5);
      this.#pending = null;
      await super.reportUserTurnStopped(options);
    }, `${this}::grace_period`);
  }

  override async handleUserTurnStopped(): Promise<void> {
    await this.#cancelPending();
    await super.handleUserTurnStopped();
  }

  override async cleanup(): Promise<void> {
    await this.#cancelPending();
    await super.cleanup();
  }

  async #cancelPending(): Promise<void> {
    if (this.#pending) {
      const task = this.#pending;
      this.#pending = null;
      await this.cancelTask(task);
    }
  }
}
// #endregion custom-stop
