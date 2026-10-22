// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/guides/effect.mdx. Type-checked on every docs build.

import { SileroVADAnalyzer } from "@pipedog/audio-silero";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import {
  LLMContextAggregatorPair,
  LLMUserAggregatorParams,
} from "@pipedog/core/processors/aggregators/llm_response_universal";
import type { BaseTransport } from "@pipedog/core/transports/base_transport";
import { OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { OpenAISTTService } from "@pipedog/openai/stt";
import { OpenAITTSService } from "@pipedog/openai/tts";

// #region service
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

class ModerationError extends Data.TaggedError("ModerationError")<{ cause: unknown }> {}

/** Decides whether a user's words may go to the LLM. */
class Moderation extends Context.Service<
  Moderation,
  { readonly isAllowed: (text: string) => Effect.Effect<boolean, ModerationError> }
>()("Moderation") {}

/** OpenAI's moderation endpoint. */
const ModerationLive = Layer.succeed(Moderation, {
  isAllowed: (text) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch("https://api.openai.com/v1/moderations", {
          method: "POST",
          headers: {
            authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
          signal,
        });
        const body = (await response.json()) as { results: { flagged: boolean }[] };
        return !body.results[0]?.flagged;
      },
      catch: (cause) => new ModerationError({ cause }),
    }),
});

// #endregion service

// #region processor
import { TranscriptionFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { makeProcessor } from "@pipedog/effect";

/** Lets a final transcription through only if Moderation allows it. */
const moderateTranscriptions = makeProcessor((frame, direction, ctx) =>
  Effect.gen(function* () {
    if (!(frame instanceof TranscriptionFrame) || direction !== FrameDirection.DOWNSTREAM) {
      return yield* ctx.push(frame, direction);
    }
    const moderation = yield* Moderation;
    const allowed = yield* moderation.isAllowed(frame.text).pipe(
      Effect.retry({ times: 2, schedule: Schedule.exponential("100 millis") }),
      Effect.timeout("2 seconds"),
      // Fail open: a slow or failing moderation call must not stall the conversation.
      Effect.orElseSucceed(() => true),
    );
    if (allowed) {
      yield* ctx.push(frame);
    } else {
      yield* ctx.push(new TTSSpeakFrame({ text: "Sorry, I can't help with that." }));
    }
  }),
);

// #endregion processor

// #region session
import { startPipeline } from "@pipedog/effect";

/** One voice session on `transport`, for as long as the scope is open. */
const session = (transport: BaseTransport) =>
  Effect.gen(function* () {
    const context = new LLMContext();
    const aggregators = new LLMContextAggregatorPair(context, {
      userParams: new LLMUserAggregatorParams({ vadAnalyzer: new SileroVADAnalyzer() }),
    });
    const worker = new PipelineWorker(
      new Pipeline([
        transport.input(),
        new OpenAISTTService(),
        yield* moderateTranscriptions,
        aggregators.user(),
        new OpenAILLMService({
          settings: new OpenAILLMSettings({ systemInstruction: "You are a helpful assistant." }),
        }),
        new OpenAITTSService({ sampleRate: 24000 }),
        transport.output(),
        aggregators.assistant(),
      ]),
      {
        cancelOnIdleTimeout: false,
        params: new PipelineParams({ audioInSampleRate: 16000, audioOutSampleRate: 24000 }),
      },
    );

    // A hang-up cancels the pipeline, which interrupts this fiber's `join`.
    transport.eventHandler("on_client_disconnected", async () => {
      await worker.cancel({ reason: "client disconnected" });
    });

    const pipeline = yield* startPipeline(worker);
    yield* Effect.logInfo(`session ${worker.name} started`);
    yield* pipeline.join;
  }).pipe(Effect.scoped);

// #endregion session

// #region run
import * as Fiber from "effect/Fiber";

/** Called by your server for each connected client. */
export function onConnection(transport: BaseTransport): () => void {
  const fiber = Effect.runFork(session(transport).pipe(Effect.provide(ModerationLive)));
  // Interrupting the fiber cancels the pipeline and waits until it has stopped.
  return () => void Effect.runFork(Fiber.interrupt(fiber));
}

// #endregion run

// #region test
import { EndFrame, TextFrame } from "@pipedog/core/frames/frames";
import * as Stream from "effect/Stream";

const BlockEverything = Layer.succeed(Moderation, { isAllowed: () => Effect.succeed(false) });

const moderationTest = Effect.gen(function* () {
  const worker = new PipelineWorker(new Pipeline([yield* moderateTranscriptions]), {
    cancelOnIdleTimeout: false,
  });
  const pipeline = yield* startPipeline(worker);
  const spoken = yield* pipeline.frames(TTSSpeakFrame);
  const passed = yield* pipeline.frames(TextFrame);
  yield* pipeline.queueFrames([
    new TranscriptionFrame({ text: "something awful", userId: "u1", timestamp: "" }),
    new EndFrame(),
  ]);
  yield* pipeline.join;
  return { spoken: yield* Stream.runCollect(spoken), passed: yield* Stream.runCollect(passed) };
}).pipe(Effect.scoped, Effect.provide(BlockEverything));
// #endregion test

void moderationTest;
