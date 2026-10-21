// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/concepts/user-muting.mdx. Type-checked on every docs build.

import { SileroVADAnalyzer } from "@pipedog/audio-silero";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type Frame,
  TTSSpeakFrame,
} from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import {
  LLMContextAggregatorPair,
  LLMUserAggregatorParams,
} from "@pipedog/core/processors/aggregators/llm_response_universal";
import {
  AlwaysUserMuteStrategy,
  BaseUserMuteStrategy,
  FunctionCallUserMuteStrategy,
  MuteUntilFirstBotCompleteUserMuteStrategy,
} from "@pipedog/core/turns/user_mute/index";

const context = new LLMContext();
const worker = new PipelineWorker(new Pipeline([]));

{
  // #region configure
  const aggregators = new LLMContextAggregatorPair(context, {
    userParams: new LLMUserAggregatorParams({
      vadAnalyzer: new SileroVADAnalyzer(),
      userMuteStrategies: [
        // Let the greeting play out in full...
        new MuteUntilFirstBotCompleteUserMuteStrategy(),
        // ...and ignore the user while a tool runs.
        new FunctionCallUserMuteStrategy(),
      ],
    }),
  });
  // #endregion configure

  // #region events
  const user = aggregators.user();

  user.eventHandler("on_user_mute_started", async () => {
    console.log("user muted");
  });
  user.eventHandler("on_user_mute_stopped", async () => {
    console.log("user unmuted");
  });
  // #endregion events
}

{
  // #region always
  const userParams = new LLMUserAggregatorParams({
    vadAnalyzer: new SileroVADAnalyzer(),
    userMuteStrategies: [new AlwaysUserMuteStrategy()],
  });
  // #endregion always
  void userParams;
}

// #region custom
/**
 * Mutes the user while the bot speaks, but only while `protecting` is on.
 * Turn it on before the bot reads something that must be heard in full.
 */
export class ProtectedSpeechUserMuteStrategy extends BaseUserMuteStrategy {
  protecting = false;
  protected _botSpeaking = false;

  override async processFrame(frame: Frame): Promise<boolean> {
    await super.processFrame(frame);

    if (frame instanceof BotStartedSpeakingFrame) {
      this._botSpeaking = true;
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      this._botSpeaking = false;
      this.protecting = false; // one protected utterance at a time
    }

    // true mutes the user, starting with the next frame.
    return this.protecting && this._botSpeaking;
  }
}

const protectedSpeech = new ProtectedSpeechUserMuteStrategy();
const userParams = new LLMUserAggregatorParams({
  vadAnalyzer: new SileroVADAnalyzer(),
  userMuteStrategies: [protectedSpeech],
});

// Later, before the bot reads the terms:
protectedSpeech.protecting = true;
await worker.queueFrame(new TTSSpeakFrame({ text: "Before we continue, please listen..." }));
// #endregion custom
void userParams;
