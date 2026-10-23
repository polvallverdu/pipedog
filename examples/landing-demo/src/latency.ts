// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Voice-to-voice latency without a VAD.
//
// `UserBotLatencyObserver` times each reply from the moment the user stopped speaking, which it
// reads from the VAD (`VADUserStoppedSpeakingFrame`, minus the VAD's stop delay). This bot has no
// VAD: Deepgram Flux decides when a turn ends. So the turn's end comes from
// `UserStoppedSpeakingFrame`, which the user aggregator pushes as Flux reports `EndOfTurn`, and
// the latency is from there to the bot's first audio (`BotStartedSpeakingFrame`). The time Flux
// takes to decide the turn is over happens before that, and is not included.

import {
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import type { FramePushed } from "@pipedog/core/observers/base_observer";
import { UserBotLatencyObserver } from "@pipedog/core/observers/user_bot_latency_observer";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";

export class TurnEndLatencyObserver extends UserBotLatencyObserver {
  #sawVad = false;

  override async onPushFrame(data: FramePushed): Promise<void> {
    if (data.direction === FrameDirection.DOWNSTREAM && !this.#sawVad) {
      const frame = data.frame;
      if (frame instanceof VADUserStoppedSpeakingFrame) {
        // A VAD is present after all: leave the timing to the parent.
        this.#sawVad = true;
      } else if (frame instanceof UserStartedSpeakingFrame) {
        // A new turn: whatever was being timed is abandoned, greeting included.
        this._userStoppedTime = null;
        this._userTurnStartTime = null;
        this._userTurn = null;
        this._resetAccumulators();
        this._firstBotSpeechMeasured = true;
      } else if (frame instanceof UserStoppedSpeakingFrame && this._userStoppedTime === null) {
        this._userStoppedTime = this._now();
        this._userTurnStartTime = this._userStoppedTime;
      }
    }
    await super.onPushFrame(data);
  }
}
