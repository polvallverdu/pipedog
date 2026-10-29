// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_eager_end_of_turn_mixin.py

import { describe, expect, test } from "bun:test";

import {
  EagerTranscriptionFrame,
  type Frame,
  UserTurnResponseCancelFrame,
} from "../src/frames/frames.ts";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "../src/processors/frame_processor.ts";
import {
  EagerEndOfTurnSTTServiceMixin,
  type EagerEndOfTurnSTTServiceMixinOptions,
} from "../src/turns/eager_end_of_turn_mixin.ts";
import { EagerUserTurnStopStrategy, ExactMatch } from "../src/turns/user_stop/index.ts";
import {
  EagerUserTurnStrategies,
  ExternalUserTurnStrategies,
} from "../src/turns/user_turn_strategies.ts";

type PredictorOptions = FrameProcessorOptions & EagerEndOfTurnSTTServiceMixinOptions;

/** Stands in for an STT service that predicts the end of a turn. */
class Predictor extends EagerEndOfTurnSTTServiceMixin(FrameProcessor) {
  pushed: Frame[] = [];

  constructor(options: PredictorOptions = {}) {
    super({ ...options, enableEagerEndOfTurn: options.enableEagerEndOfTurn ?? true });
  }

  override async pushFrame(
    frame: Frame,
    _direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    this.pushed.push(frame);
  }
}

describe("TestEagerEndOfTurnMixin", () => {
  test("test_a_prediction_is_followed_by_its_withdrawal", async () => {
    const service = new Predictor();

    await service._pushEagerEndOfTurn("book a flight", { userId: "user" });
    expect(service.eagerEndOfTurnPending).toBe(true);

    await service._cancelEagerEndOfTurn();

    expect(service.pushed.length).toBe(2);
    const [prediction, withdrawal] = service.pushed;
    expect(prediction).toBeInstanceOf(EagerTranscriptionFrame);
    expect((prediction as EagerTranscriptionFrame).text).toBe("book a flight");
    expect((prediction as EagerTranscriptionFrame).userId).toBe("user");
    expect(withdrawal).toBeInstanceOf(UserTurnResponseCancelFrame);
    expect(service.eagerEndOfTurnPending).toBe(false);
  });

  test("test_a_committed_turn_resolves_the_prediction_without_withdrawing_it", async () => {
    const service = new Predictor();

    await service._pushEagerEndOfTurn("book a flight", { userId: "user" });
    service._clearEagerEndOfTurn();
    // A committed turn settles the prediction on its own; withdrawing it
    // afterwards would discard a response the committed transcript may keep.
    await service._cancelEagerEndOfTurn();

    expect(service.pushed.some((f) => f instanceof UserTurnResponseCancelFrame)).toBe(false);
    expect(service.eagerEndOfTurnPending).toBe(false);
  });

  test("test_withdrawing_without_a_prediction_does_nothing", async () => {
    const service = new Predictor();

    await service._cancelEagerEndOfTurn();
    service._clearEagerEndOfTurn();

    expect(service.pushed).toEqual([]);
    expect(service.eagerEndOfTurnPending).toBe(false);
  });
});

describe("TestEagerEndOfTurnIsOptIn", () => {
  test("test_predictions_are_not_reported_while_it_is_off", async () => {
    // A service reports what its protocol gives it either way; the mixin is
    // what decides whether the prediction goes anywhere.
    const service = new Predictor({ enableEagerEndOfTurn: false });

    await service._pushEagerEndOfTurn("book a flight", { userId: "user" });
    await service._cancelEagerEndOfTurn();
    service._clearEagerEndOfTurn();

    expect(service.pushed).toEqual([]);
    expect(service.eagerEndOfTurnPending).toBe(false);
    expect(service.eagerEndOfTurnEnabled).toBe(false);
  });

  test("test_it_recommends_eager_strategies_only_when_enabled", () => {
    expect(
      new Predictor().recommendedUserTurnStrategies({ enableInterruptions: true }),
    ).toBeInstanceOf(EagerUserTurnStrategies);

    const recommended = new Predictor({
      enableEagerEndOfTurn: false,
    }).recommendedUserTurnStrategies({ enableInterruptions: true });
    expect(recommended).toBeInstanceOf(ExternalUserTurnStrategies);
    expect(recommended).not.toBeInstanceOf(EagerUserTurnStrategies);
  });

  test("test_the_recommendation_carries_the_match_policy_and_interruptions", () => {
    const service = new Predictor({ eagerMatchPolicy: new ExactMatch() });

    const recommended = service.recommendedUserTurnStrategies({
      enableInterruptions: false,
    }) as ExternalUserTurnStrategies;

    expect(recommended.stop[0]).toBeInstanceOf(EagerUserTurnStopStrategy);
    expect((recommended.stop[0] as EagerUserTurnStopStrategy).matchPolicy).toBeInstanceOf(
      ExactMatch,
    );
    expect(recommended.enableInterruptions).toBe(false);
  });
});
