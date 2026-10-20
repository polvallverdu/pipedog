// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/observers/speaking_observer.py

/**
 * Observer reporting who was speaking, and when.
 *
 * A conversation is a sequence of people taking the floor and occasionally
 * taking it from each other. This observer reports each of those moments as
 * it happens, leaving what counts as a turn to whoever reads them: a turn
 * boundary is a policy, and a policy that ships inside a record can never be
 * revised.
 */

import { time } from "@pipecat-ts/asyncio";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type Frame,
  InterruptionFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../frames/frames.ts";
import { FrameDirection } from "../processors/frame_processor.ts";
import { BaseObserver, type BaseObserverOptions, type FramePushed } from "./base_observer.ts";

/**
 * What happened, to whom, and at which layer.
 *
 * The user appears at two layers, and they answer different questions.
 * `user_speech_*` is the speech itself, as the voice activity detector heard
 * it: speech that never becomes a turn — a cough, a false start, a pause
 * mid-sentence — appears only here. `user_turn_*` is the turn strategy's
 * ruling on that speech, which is what the rest of the pipeline acts on, and
 * follows the speech by however long the ruling took.
 */
export const SpeechEventKind = {
  USER_SPEECH_STARTED: "user_speech_started",
  USER_SPEECH_STOPPED: "user_speech_stopped",
  USER_TURN_STARTED: "user_turn_started",
  USER_TURN_STOPPED: "user_turn_stopped",
  BOT_SPEECH_STARTED: "bot_speech_started",
  BOT_SPEECH_STOPPED: "bot_speech_stopped",
  INTERRUPTION: "interruption",
} as const;
export type SpeechEventKind = (typeof SpeechEventKind)[keyof typeof SpeechEventKind];

export interface SpeechEventOptions {
  /** What happened, to whom, and at which layer. */
  kind: SpeechEventKind;
  /**
   * Unix timestamp of the moment itself. Speech is timed to when it began and
   * ended, not to when the detector confirmed it, so an interval drawn from
   * these matches what was said.
   */
  timestamp: number;
  /**
   * When the matching stretch of speech began, on the moments that end one,
   * so a stretch reads as an interval without pairing it with the moment that
   * opened it.
   */
  startedAt?: number | null;
}

/** One moment in the conversation's speaking lifecycle. */
export class SpeechEvent {
  kind: SpeechEventKind;
  timestamp: number;
  startedAt: number | null;

  constructor(options: SpeechEventOptions) {
    this.kind = options.kind;
    this.timestamp = options.timestamp;
    this.startedAt = options.startedAt ?? null;
  }
}

export interface SpeakingObserverOptions extends Omit<BaseObserverOptions, "observeEveryPush"> {
  /**
   * Reads the current time in seconds. Supplying one lets a test place
   * moments without waiting. Defaults to `time()`.
   */
  timeSource?: () => number;
}

/**
 * Reports the speaking lifecycle of a conversation.
 *
 * Every moment is reported as it happens, and the moments that close a
 * stretch of speech name where it began, so an interval reads whole from one
 * record: a stretch whose closing moment never arrives stays open rather than
 * quietly joining itself to the next one. What a turn is stays with the
 * reader: a turn built here would freeze one definition into every record,
 * where the moments themselves can be grouped again later, differently, over
 * the same history.
 *
 * Events:
 *
 * - on_speech_event(observer, event): Emitted for each moment, as a
 *   `SpeechEvent`.
 *
 * @example
 * const observer = new SpeakingObserver();
 *
 * observer.eventHandler("on_speech_event", async (observer, event: SpeechEvent) => {
 *   logger.info(JSON.stringify(event));
 * });
 */
export class SpeakingObserver extends BaseObserver {
  protected _now: () => number;
  // When each open stretch of speech began, so the moment that closes one can
  // carry it.
  protected _open = new Map<SpeechEventKind, number>();

  constructor(options: SpeakingObserverOptions = {}) {
    super({ ...options, observeEveryPush: false });
    this._now = options.timeSource ?? time;

    this._registerEventHandler("on_speech_event");
  }

  /**
   * Report the moment a frame represents.
   *
   * @param data Frame push event containing the frame and direction.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    const frame = data.frame;

    // An interruption is broadcast, arriving as two frames, each pushed for
    // the first time once. Read the downstream one.
    if (frame.broadcastSiblingId !== null && data.direction !== FrameDirection.DOWNSTREAM) {
      return;
    }

    const event = this._asEvent(frame);
    if (!event) {
      return;
    }

    await this._callEventHandler("on_speech_event", event);
  }

  /**
   * Build the moment a frame represents.
   *
   * @param frame The frame being pushed.
   * @returns The moment, or null if this frame is not part of the speaking
   *   lifecycle.
   */
  protected _asEvent(frame: Frame): SpeechEvent | null {
    if (frame instanceof VADUserStartedSpeakingFrame) {
      // The detector's account of when speech began, which precedes its
      // confirmation by the time it needed to be sure.
      return this._opens(SpeechEventKind.USER_SPEECH_STARTED, frame.timestamp - frame.startSecs);
    } else if (frame instanceof VADUserStoppedSpeakingFrame) {
      return this._closes(
        SpeechEventKind.USER_SPEECH_STOPPED,
        SpeechEventKind.USER_SPEECH_STARTED,
        frame.timestamp - frame.stopSecs,
      );
    } else if (frame instanceof UserStartedSpeakingFrame) {
      return this._opens(SpeechEventKind.USER_TURN_STARTED, this._now());
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      return this._closes(
        SpeechEventKind.USER_TURN_STOPPED,
        SpeechEventKind.USER_TURN_STARTED,
        this._now(),
      );
    } else if (frame instanceof BotStartedSpeakingFrame) {
      return this._opens(SpeechEventKind.BOT_SPEECH_STARTED, this._now());
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      return this._closes(
        SpeechEventKind.BOT_SPEECH_STOPPED,
        SpeechEventKind.BOT_SPEECH_STARTED,
        this._now(),
      );
    } else if (frame instanceof InterruptionFrame) {
      return new SpeechEvent({ kind: SpeechEventKind.INTERRUPTION, timestamp: this._now() });
    }
    return null;
  }

  /** Record the start of a stretch of speech. */
  protected _opens(kind: SpeechEventKind, at: number): SpeechEvent {
    this._open.set(kind, at);
    return new SpeechEvent({ kind, timestamp: at });
  }

  /**
   * Record the end of a stretch, naming its start where one is known.
   *
   * A stretch that began before the observer was watching closes without a
   * start rather than borrowing one from another stretch.
   */
  protected _closes(kind: SpeechEventKind, openedBy: SpeechEventKind, at: number): SpeechEvent {
    const startedAt = this._open.get(openedBy) ?? null;
    this._open.delete(openedBy);
    return new SpeechEvent({ kind, timestamp: at, startedAt });
  }
}
