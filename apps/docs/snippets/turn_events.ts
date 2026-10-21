// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/concepts/turn-events.mdx. Type-checked on every docs build.

import { SileroVADAnalyzer } from "@pipedog/audio-silero";
import {
  EndWorkerFrame,
  LLMMessagesAppendFrame,
  TTSSpeakFrame,
  UserIdleTimeoutUpdateFrame,
} from "@pipedog/core/frames/frames";
import { TurnTrackingObserver } from "@pipedog/core/observers/turn_tracking_observer";
import {
  type LatencyBreakdown,
  UserBotLatencyObserver,
} from "@pipedog/core/observers/user_bot_latency_observer";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import {
  type AssistantTurnStoppedMessage,
  LLMContextAggregatorPair,
  type LLMUserAggregator,
  LLMUserAggregatorParams,
  type UserTurnMessageAddedMessage,
  type UserTurnStoppedMessage,
} from "@pipedog/core/processors/aggregators/llm_response_universal";
import type { BaseUserTurnStartStrategy } from "@pipedog/core/turns/user_start/index";
import type { BaseUserTurnStopStrategy } from "@pipedog/core/turns/user_stop/index";

const context = new LLMContext();
const pipeline = new Pipeline([]);

{
  // #region turn-events
  const aggregators = new LLMContextAggregatorPair(context, {
    userParams: new LLMUserAggregatorParams({ vadAnalyzer: new SileroVADAnalyzer() }),
  });
  const user = aggregators.user();
  const assistant = aggregators.assistant();

  user.eventHandler(
    "on_user_turn_started",
    async (_aggregator, strategy: BaseUserTurnStartStrategy) => {
      console.log(`user turn started (${strategy.name})`);
    },
  );

  user.eventHandler(
    "on_user_turn_stopped",
    async (_aggregator, strategy: BaseUserTurnStopStrategy, message: UserTurnStoppedMessage) => {
      console.log(`user said "${message.content}" (${strategy.name}, from ${message.timestamp})`);
    },
  );

  // The text written to the context, in cascade and realtime mode alike.
  user.eventHandler(
    "on_user_turn_message_added",
    async (_aggregator, message: UserTurnMessageAddedMessage) => {
      console.log(`added to context: ${message.content}`);
    },
  );

  assistant.eventHandler(
    "on_assistant_turn_stopped",
    async (_aggregator, message: AssistantTurnStoppedMessage) => {
      console.log(`bot said "${message.content}" (interrupted: ${message.interrupted})`);
    },
  );
  // #endregion turn-events
}

{
  // #region idle
  const aggregators = new LLMContextAggregatorPair(context, {
    userParams: new LLMUserAggregatorParams({
      vadAnalyzer: new SileroVADAnalyzer(),
      userIdleTimeout: 8.0, // seconds of silence after the bot stops speaking
    }),
  });
  const user = aggregators.user();

  let idleCount = 0;

  user.eventHandler("on_user_turn_idle", async (aggregator: LLMUserAggregator) => {
    idleCount += 1;
    if (idleCount === 1) {
      await aggregator.pushFrame(
        new LLMMessagesAppendFrame({
          messages: [
            { role: "developer", content: "The user has been quiet. Ask if they're still there." },
          ],
          runLlm: true,
        }),
      );
    } else if (idleCount === 2) {
      await aggregator.pushFrame(
        new LLMMessagesAppendFrame({
          messages: [
            {
              role: "developer",
              content: "The user is still quiet. Ask whether they'd like to continue.",
            },
          ],
          runLlm: true,
        }),
      );
    } else {
      await aggregator.pushFrame(new TTSSpeakFrame({ text: "I'll let you go. Goodbye!" }));
      await aggregator.pushFrame(new EndWorkerFrame());
    }
  });

  // Any user turn resets the count.
  user.eventHandler("on_user_turn_started", async () => {
    idleCount = 0;
  });
  // #endregion idle
}

{
  const worker = new PipelineWorker(pipeline);
  // #region idle-update
  await worker.queueFrame(new UserIdleTimeoutUpdateFrame({ timeout: 15.0 })); // change or enable
  await worker.queueFrame(new UserIdleTimeoutUpdateFrame({ timeout: 0 })); // disable
  // #endregion idle-update
}

{
  // #region turn-tracking
  const worker = new PipelineWorker(pipeline); // enableTurnTracking defaults to true

  worker.turnTrackingObserver?.eventHandler(
    "on_turn_started",
    async (_observer, turnNumber: number) => {
      console.log(`turn ${turnNumber} started`);
    },
  );
  worker.turnTrackingObserver?.eventHandler(
    "on_turn_ended",
    async (_observer, turnNumber: number, duration: number, wasInterrupted: boolean) => {
      console.log(`turn ${turnNumber}: ${duration.toFixed(2)}s, interrupted: ${wasInterrupted}`);
    },
  );
  // #endregion turn-tracking
}

{
  // #region turn-tracking-custom
  const turns = new TurnTrackingObserver({ turnEndTimeoutSecs: 3.5 });
  const worker = new PipelineWorker(pipeline, {
    observers: [turns],
    enableTurnTracking: false, // or the worker adds a second, default observer
  });
  // #endregion turn-tracking-custom
  void worker;
}

{
  // #region latency
  const latency = new UserBotLatencyObserver();

  latency.eventHandler("on_latency_measured", async (_observer, seconds: number) => {
    console.log(`user stopped -> bot started: ${seconds.toFixed(3)}s`);
  });
  latency.eventHandler("on_first_bot_speech_latency", async (_observer, seconds: number) => {
    console.log(`client connected -> first bot speech: ${seconds.toFixed(3)}s`);
  });
  // The per-service figures need enableMetrics.
  latency.eventHandler("on_latency_breakdown", async (_observer, breakdown: LatencyBreakdown) => {
    for (const line of breakdown.turnContributionLines()) console.log(line);
  });

  const worker = new PipelineWorker(pipeline, {
    params: new PipelineParams({ enableMetrics: true }),
    observers: [latency],
  });
  // #endregion latency
  void worker;
}
