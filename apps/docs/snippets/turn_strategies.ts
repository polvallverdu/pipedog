// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/concepts/turn-detection.mdx and turn-strategies.mdx.
// Type-checked on every docs build.

import { SileroVADAnalyzer } from "@pipedog/audio-silero";
import { createLocalSmartTurnAnalyzerV3, HttpSmartTurnAnalyzer } from "@pipedog/audio-smart-turn";
import { type Frame, TranscriptionFrame } from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import {
  LLMContextAggregatorPair,
  LLMUserAggregatorParams,
} from "@pipedog/core/processors/aggregators/llm_response_universal";
import { EmptyUserTurnConfig } from "@pipedog/core/turns/empty_user_turn";
import { ProcessFrameResult } from "@pipedog/core/turns/types";
import {
  BaseUserTurnStartStrategy,
  MinWordsUserTurnStartStrategy,
  TranscriptionUserTurnStartStrategy,
  VADUserTurnStartStrategy,
  WakePhraseUserTurnStartStrategy,
} from "@pipedog/core/turns/user_start/index";
import {
  deferred,
  ExactMatch,
  LLMTurnCompletionUserTurnStopStrategy,
  SpeechTimeoutUserTurnStopStrategy,
  TurnAnalyzerUserTurnStopStrategy,
} from "@pipedog/core/turns/user_stop/index";
import { UserTurnCompletionConfig } from "@pipedog/core/turns/user_turn_completion_mixin";
import {
  defaultUserTurnStartStrategies,
  EagerUserTurnStrategies,
  FilterIncompleteUserTurnStrategies,
  UserTurnStrategies,
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
      // First, so it can hold back the other start strategies while asleep.
      start: [wakePhrase, ...defaultUserTurnStartStrategies()],
    }),
  });
  // #endregion wake-phrase
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
  // Smart Turn still triggers inference; the LLM's ● marker ends the turn.
  const strategies = new FilterIncompleteUserTurnStrategies({
    config: new UserTurnCompletionConfig({
      incompleteShortTimeout: 5.0,
      incompleteLongTimeout: 10.0,
    }),
  });

  // The same chain, built by hand:
  const byHand = new UserTurnStrategies({
    stop: [
      deferred(
        new TurnAnalyzerUserTurnStopStrategy({ turnAnalyzer: createLocalSmartTurnAnalyzerV3() }),
      ),
      new LLMTurnCompletionUserTurnStopStrategy(),
    ],
  });
  // #endregion filter-incomplete
  void strategies;
  void byHand;
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
/** Starts a turn on a final transcript that ends with a question mark. */
export class QuestionUserTurnStartStrategy extends BaseUserTurnStartStrategy {
  override async processFrame(frame: Frame): Promise<ProcessFrameResult> {
    if (frame instanceof TranscriptionFrame && frame.text.trim().endsWith("?")) {
      await this.triggerUserTurnStarted();
      // Stop: no later start strategy needs to see this frame.
      return ProcessFrameResult.STOP;
    }
    // Continue: let the next start strategy look at the frame.
    return ProcessFrameResult.CONTINUE;
  }
}
// #endregion custom-start
