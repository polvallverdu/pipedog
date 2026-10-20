// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/speculation_gate.py

/** Decision engine holding a speculative bot response until its turn is confirmed. */

import {
  EagerEndOfTurnCancelFrame,
  EndFrame,
  type Frame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  SystemFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "../frames/frames.ts";
import { FrameDirection } from "../processors/frame_processor.ts";
import { FrameQueue } from "../utils/frame_queue.ts";
import { logger } from "../utils/logger.ts";

/** A frame paired with the direction it travels in. */
export type GatedFrame = [Frame, FrameDirection];

/**
 * What the gate is doing with the frames passing through it.
 *
 * - `OPEN`: emitting everything.
 * - `HOLDING`: holding a speculative response until it is confirmed.
 * - `DROPPING`: discarding the rest of a withdrawn speculative response.
 */
export const SpeculationState = {
  OPEN: "open",
  HOLDING: "holding",
  DROPPING: "dropping",
} as const;
export type SpeculationState = (typeof SpeculationState)[keyof typeof SpeculationState];

export interface SpeculationGateOptions {
  /** Label used in log messages, typically the owning service's. */
  name?: string;
}

/**
 * Decides which frames of a speculative bot response may be emitted, and when.
 *
 * A speculative response is generated from an eager end of turn — a
 * provisional guess that the user has finished talking — so it may answer a
 * transcript the user never actually completed. This holds everything such a
 * response produces until the turn is confirmed, then releases it, or discards
 * it if the guess is withdrawn.
 *
 * A host calls `beginSpeculation` when it starts an inference for a turn that
 * may not have ended, and the response that follows is held from its
 * LLMFullResponseStartFrame onward. A UserStoppedSpeakingFrame releases it —
 * the turn it answers has ended — and an EagerEndOfTurnCancelFrame discards
 * it. Neither names a response: only one speculation is ever in flight, since
 * producing one takes a whole user turn.
 *
 * Whether an inference is still answering an unconfirmed turn is therefore the
 * gate's to answer, through `isSpeculating`, rather than something a host
 * tracks alongside it. A host that kept its own copy would have to clear it on
 * every path that settles a speculation, and the two would disagree on the
 * paths it missed.
 *
 * The gate also tracks whether the turn has ended, because a confirmation can
 * arrive before the inference it confirms — Pipecat dispatches system frames
 * ahead of the queued frames they pass — and a response for a turn already
 * over is not held at all.
 *
 * Both of those resolving frames reach the gate ahead of anything queued
 * behind them, which is what keeps a withdrawal in front of the turn end that
 * follows it. A withdrawal arriving second would find the response already
 * released.
 *
 * While holding, everything is held in arrival order except system frames,
 * which are out-of-band throughout Pipecat — and which carry the verdicts the
 * gate is waiting for, so holding them would deadlock it. That includes
 * uninterruptible frames (`Frame.interruptible` false), which are ordered like
 * any other frame; discarding a speculation keeps them and emits them on,
 * since they can belong to work started before it.
 *
 * This decides rather than processes frames: `process` is synchronous and
 * returns the frames its caller should push, in order. A host can therefore
 * push from several tasks at once — every state transition completes without
 * an await for another task to interleave with. LLMService hosts one, gating
 * every response it produces.
 *
 * Holding is unbounded here. Whoever started the speculation bounds it and
 * withdraws it if it goes unresolved — see EagerUserTurnStopStrategy — so
 * every way a speculation ends reaches this gate as a frame, and the gate
 * never has to abandon one on its own.
 *
 * @example
 * for (const [frame, direction] of gate.process(frame, direction)) {
 *   await this.pushFrame(frame, direction);
 * }
 */
export class SpeculationGate {
  protected _name: string;
  protected _state: SpeculationState = SpeculationState.OPEN;
  // Whether the inference in flight answers a turn that has not been
  // confirmed. Set when the inference starts, cleared when the turn settles it
  // either way — so it outlives any one response frame.
  protected _speculating = false;
  // Whether the turn ended since it was last seen to start. A speculation
  // registered while this is set answers a turn that is already over, so it is
  // not held. Starts false, so a gate that never sees turn frames holds rather
  // than speaks — the strategy's bound then recovers it.
  protected _turnEnded = false;
  protected _buffer: FrameQueue<GatedFrame> = new FrameQueue<GatedFrame>((item) => item[0]);

  /**
   * Initialize the speculation gate.
   *
   * @param options.name Label used in log messages, typically the owning service's.
   */
  constructor(options: SpeculationGateOptions = {}) {
    this._name = options.name ?? "SpeculationGate";
  }

  toString(): string {
    return this._name;
  }

  /** What the gate is currently doing with frames passing through it. */
  get state(): SpeculationState {
    return this._state;
  }

  /**
   * Whether the inference in flight answers an unconfirmed turn.
   *
   * Set from `beginSpeculation` until the turn settles it, so it covers the
   * whole inference rather than only the stretch with frames in flight. False
   * means whatever is generating now answers a turn that has ended, and its
   * side effects can be let through. Use `state` to ask the narrower question
   * of whether frames are being held right now.
   */
  get isSpeculating(): boolean {
    return this._speculating;
  }

  /**
   * Take note of an inference whose turn may not have ended.
   *
   * Called when the inference starts rather than when its first response
   * frame arrives, so a turn confirmed in between is already accounted for by
   * the time the response shows up.
   *
   * @param speculation Whether the inference answers a turn that may still be
   *   open, rather than an ordinary one against a turn that has ended.
   */
  beginSpeculation(speculation: boolean): void {
    // A turn that ended before the inference reached us leaves nothing to
    // hold for: the response answers a turn that is already over.
    this._speculating = speculation && !this._turnEnded;
  }

  /**
   * Decide what a frame passing through the gate releases.
   *
   * @param frame The frame to process.
   * @param direction The direction the frame travels in.
   * @returns The frames to push, in order. Empty while a frame is held or
   *   dropped; longer than one frame when a verdict releases what was held
   *   behind it.
   */
  process(frame: Frame, direction: FrameDirection): GatedFrame[] {
    if (direction !== FrameDirection.DOWNSTREAM) {
      return [[frame, direction]];
    }

    if (frame instanceof SystemFrame) {
      // Emitted before the verdict is applied, so a released response still
      // follows the frame that ended the turn it answers.
      let emitted: GatedFrame[] = [[frame, direction]];
      if (frame instanceof EagerEndOfTurnCancelFrame || frame instanceof InterruptionFrame) {
        emitted = emitted.concat(this._discard());
      } else if (frame instanceof UserStoppedSpeakingFrame) {
        emitted = emitted.concat(this._release());
      } else if (frame instanceof UserStartedSpeakingFrame) {
        // A turn is open again, so an inference started from here on answers
        // something that may not have ended.
        this._turnEnded = false;
      }
      return emitted;
    }

    if (frame instanceof EndFrame) {
      // Uninterruptible, and the runner awaits it: holding it hangs shutdown.
      // Discarding first delivers whatever is held that has to outlive the
      // speculation, ahead of it.
      return [...this._discard(), [frame, direction]];
    }

    const emitted: GatedFrame[] = [];
    if (frame instanceof LLMFullResponseStartFrame) {
      emitted.push(...this._begin());
    }

    if (this._state === SpeculationState.HOLDING) {
      // Held in arrival order, uninterruptible frames included: they are
      // ordered like any other, and the buffer preserves them when the
      // speculation around them is discarded.
      this._buffer.putNowait([frame, direction]);
    } else if (this._state === SpeculationState.DROPPING) {
      if (!frame.interruptible) {
        // Not part of the response being dropped, and nothing is being held
        // back, so emitting it keeps it in order.
        emitted.push([frame, direction]);
      } else if (frame instanceof LLMFullResponseEndFrame) {
        this._state = SpeculationState.OPEN;
      }
    } else {
      emitted.push([frame, direction]);
    }

    return emitted;
  }

  /**
   * Leave the hold.
   *
   * The single exit from `HOLDING`. Whether the speculation itself is over is
   * a separate question — a response superseded by a new one ends its hold
   * while the inference that replaced it is still pending.
   *
   * @param state What the gate does with the frames that follow.
   */
  protected _endHold(state: SpeculationState): void {
    this._state = state;
  }

  /** Decide what to do with the response opening here. */
  protected _begin(): GatedFrame[] {
    const emitted: GatedFrame[] = [];

    if (this._state !== SpeculationState.OPEN) {
      // A new response supersedes the one we were holding or dropping. A
      // withdrawn response may never send its end frame, since its generation
      // was cancelled mid-flight, and an unconfirmed one is void once
      // something else starts answering. Nothing of it can still be queued
      // behind this frame, so there is no tail left to drop.
      emitted.push(...this._dropHeld("superseded by a new response", { keepDropping: false }));
    }

    // Whether this response is speculative was settled when its inference
    // started, so a turn confirmed since then already cleared it.
    if (!this._speculating) {
      return emitted;
    }

    this._state = SpeculationState.HOLDING;
    return emitted;
  }

  /**
   * Release whatever the turn ending confirms.
   *
   * @returns The frames the confirmation releases, in arrival order.
   */
  protected _release(): GatedFrame[] {
    // Remembered so an inference that arrives after this is not held: the turn
    // it answers is already over, and nothing follows to release it.
    this._turnEnded = true;

    // Nothing this inference still produces is speculative either — including
    // a tool call it has yet to reach.
    this._speculating = false;

    if (this._state !== SpeculationState.HOLDING) {
      return [];
    }

    logger.debug(`${this}: releasing speculative response (${this._buffer.qsize()} frames)`);
    this._endHold(SpeculationState.OPEN);
    return this._flush();
  }

  /**
   * Discard the response a withdrawal or an interruption voids.
   *
   * A withdrawal that arrives before the response it voids needs no memory:
   * the response is held on arrival, and whatever answers the turn instead
   * supersedes it — or the bound on the hold runs out if nothing does.
   *
   * @returns Whatever the discarded response was holding back that has to be
   *   delivered anyway.
   */
  protected _discard(): GatedFrame[] {
    // The speculation is void, so nothing the inference still produces
    // answers a turn worth holding for.
    this._speculating = false;

    return this._dropHeld("withdrawn", { keepDropping: true });
  }

  /**
   * Drop the held response.
   *
   * @param reason Why it is being dropped, for the log line.
   * @param options.keepDropping Whether the rest of the response may still be
   *   queued behind us and has to be dropped as it arrives. False when
   *   something already past it proves there is no tail left.
   * @returns The held frames that must be delivered anyway, in arrival order.
   */
  protected _dropHeld(reason: string, options: { keepDropping: boolean }): GatedFrame[] {
    if (this._state !== SpeculationState.HOLDING) {
      this._state = SpeculationState.OPEN;
      return [];
    }

    logger.debug(
      `${this}: discarding speculative response (${this._buffer.qsize()} frames, ${reason})`,
    );
    // A response that already ended has no tail left to drop.
    const complete = this._buffer.hasFrame(LLMFullResponseEndFrame);
    // Drops the speculative response and keeps anything that must always be
    // delivered, which is then emitted rather than discarded with it.
    this._buffer.reset();
    this._endHold(
      options.keepDropping && !complete ? SpeculationState.DROPPING : SpeculationState.OPEN,
    );
    return this._flush();
  }

  /** Take everything the buffer still holds, in the order it arrived. */
  protected _flush(): GatedFrame[] {
    const emitted: GatedFrame[] = [];
    while (!this._buffer.empty()) {
      const [frame, direction] = this._buffer.getNowait();
      this._buffer.taskDone();
      emitted.push([frame, direction]);
    }
    return emitted;
  }
}
