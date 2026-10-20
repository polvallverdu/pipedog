// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/observers/function_call_observer.py

/**
 * Observer reporting the function calls a conversation makes.
 *
 * A function call is the one thing a bot does rather than says, and the part
 * of a turn whose duration belongs to the application's own code. This
 * observer reports a call when it starts, when it goes in progress, and when
 * it settles, so a call that stops short of any of those reads as one still
 * waiting rather than one that quietly stopped mattering.
 */

import { time } from "@pipedog/asyncio";
import {
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallInProgressFrame,
  FunctionCallResultFrame,
  FunctionCallsStartedFrame,
} from "../frames/frames.ts";
import { FrameDirection } from "../processors/frame_processor.ts";
import { BaseObserver, type BaseObserverOptions, type FramePushed } from "./base_observer.ts";

/**
 * Where a function call has got to.
 *
 * A call starts when the LLM asks for it and is in progress once it is
 * running, which are two moments rather than one: calls run one at a time
 * unless the service was built to run them in parallel, so a call can wait
 * in between, and a call still waiting when the conversation moves on never
 * runs at all. A call settles in one of four ways: it returned, its handler
 * raised, it ran past its deadline, or it was cancelled — by an
 * interruption, or by the LLM asking for it.
 */
export const FunctionCallEventKind = {
  STARTED: "function_call_started",
  IN_PROGRESS: "function_call_in_progress",
  COMPLETED: "function_call_completed",
  FAILED: "function_call_failed",
  TIMED_OUT: "function_call_timed_out",
  CANCELLED: "function_call_cancelled",
} as const;
export type FunctionCallEventKind =
  (typeof FunctionCallEventKind)[keyof typeof FunctionCallEventKind];

export interface FunctionCallEventOptions {
  /** What happened to the call. */
  kind: FunctionCallEventKind;
  /** The name of the function. */
  functionName: string;
  /** The LLM's identifier for this call, unique within a conversation. */
  toolCallId: string;
  /** Unix timestamp of the moment. */
  timestamp: number;
  /**
   * Identifies the calls the LLM asked for in one response, which run
   * together. Set when the call goes in progress.
   */
  groupId?: string | null;
  /**
   * Whether the conversation waited for this call. A call that doesn't block
   * is answered later through a developer message, while the LLM carries on
   * talking. Set when the call goes in progress.
   */
  blocking?: boolean | null;
  /**
   * What the LLM passed to the function, when the observer is reporting
   * arguments. Set both when the call starts and when it goes in progress,
   * since a call can be reported at either moment without the other.
   */
  arguments?: unknown;
  /**
   * When the call started, on the moment it goes in progress, so the wait
   * between the two reads from one record.
   */
  startedAt?: number | null;
  /**
   * When the call went in progress, on the moment that settles it, so the
   * time it ran reads from one record.
   */
  inProgressAt?: number | null;
  /** What the handler returned, when the observer is reporting results. */
  result?: unknown;
  /** What went wrong, on a call whose handler raised. */
  error?: string | null;
}

/**
 * One moment in the life of a function call.
 *
 * The moments that open a call describe it; the moment that settles it
 * describes what became of it. Each names the call, so they read as a
 * sequence without any of them repeating the others.
 */
export class FunctionCallEvent {
  kind: FunctionCallEventKind;
  functionName: string;
  toolCallId: string;
  timestamp: number;
  groupId: string | null;
  blocking: boolean | null;
  arguments: unknown;
  startedAt: number | null;
  inProgressAt: number | null;
  result: unknown;
  error: string | null;

  constructor(options: FunctionCallEventOptions) {
    this.kind = options.kind;
    this.functionName = options.functionName;
    this.toolCallId = options.toolCallId;
    this.timestamp = options.timestamp;
    this.groupId = options.groupId ?? null;
    this.blocking = options.blocking ?? null;
    this.arguments = options.arguments ?? null;
    this.startedAt = options.startedAt ?? null;
    this.inProgressAt = options.inProgressAt ?? null;
    this.result = options.result ?? null;
    this.error = options.error ?? null;
  }
}

export interface FunctionCallObserverOptions extends Omit<BaseObserverOptions, "observeEveryPush"> {
  /** Whether to report the arguments a call was made with. Defaults to true. */
  includeArguments?: boolean;
  /** Whether to report what a call returned. Defaults to false. */
  includeResults?: boolean;
  /**
   * Reads the current time in seconds. Supplying one lets a test place
   * moments without waiting. Defaults to `time()`.
   */
  timeSource?: () => number;
}

/** Remove `key` from `map` and return its value, or null (Python's `dict.pop(key, None)`). */
function pop<K, V>(map: Map<K, V>, key: K): V | null {
  const value = map.get(key);
  map.delete(key);
  return value ?? null;
}

/**
 * Reports each function call a conversation makes, from start to outcome.
 *
 * A call is reported at each moment it reaches rather than summarized once
 * it is over, because the moments can be far apart and a call need not reach
 * all of them: one waiting its turn to run is dropped if the conversation
 * moves on, and one the conversation doesn't wait for can settle long after
 * the turn that asked for it.
 *
 * Arguments and results are where a call holds whatever the conversation was
 * about, so each is a choice: arguments travel by default, being small and
 * the reason a call is worth reading at all, and results do not, being
 * whatever a provider decided to return.
 *
 * Events:
 *
 * - on_function_call_event(observer, event): Emitted for each moment, as a
 *   `FunctionCallEvent`.
 *
 * @example
 * const observer = new FunctionCallObserver();
 *
 * observer.eventHandler("on_function_call_event", async (observer, event: FunctionCallEvent) => {
 *   logger.info(JSON.stringify(event));
 * });
 */
export class FunctionCallObserver extends BaseObserver {
  protected _includeArguments: boolean;
  protected _includeResults: boolean;
  protected _now: () => number;
  // When each call started and when it went in progress, so the moment that
  // follows either can carry it.
  protected _startedAt = new Map<string, number>();
  protected _inProgressAt = new Map<string, number>();

  constructor(options: FunctionCallObserverOptions = {}) {
    super({ ...options, observeEveryPush: false });
    this._includeArguments = options.includeArguments ?? true;
    this._includeResults = options.includeResults ?? false;
    this._now = options.timeSource ?? time;

    this._registerEventHandler("on_function_call_event");
  }

  /**
   * Report the moment a frame represents.
   *
   * @param data Frame push event containing the frame and direction.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    const frame = data.frame;

    // These frames are broadcast, arriving as two frames, each pushed for the
    // first time once. Read the downstream one.
    if (frame.broadcastSiblingId !== null && data.direction !== FrameDirection.DOWNSTREAM) {
      return;
    }

    const events = this._asEvents(frame);
    if (events.length === 0) {
      return;
    }

    for (const event of events) {
      await this._callEventHandler("on_function_call_event", event);
    }
  }

  /**
   * Build the moments a frame represents.
   *
   * One frame reports one moment, except the frame starting the calls an LLM
   * response asked for, which reports one for each of them.
   *
   * @param frame The frame being pushed.
   * @returns The moments, or an empty list if this frame is not part of a
   *   function call's life.
   */
  protected _asEvents(frame: Frame): FunctionCallEvent[] {
    if (frame instanceof FunctionCallsStartedFrame) {
      const at = this._now();
      const events: FunctionCallEvent[] = [];
      for (const call of frame.functionCalls) {
        this._startedAt.set(call.toolCallId, at);
        events.push(
          new FunctionCallEvent({
            kind: FunctionCallEventKind.STARTED,
            functionName: call.functionName,
            toolCallId: call.toolCallId,
            timestamp: at,
            arguments: this._includeArguments ? call.arguments : null,
          }),
        );
      }
      return events;
    } else if (frame instanceof FunctionCallInProgressFrame) {
      const at = this._now();
      this._inProgressAt.set(frame.toolCallId, at);
      return [
        new FunctionCallEvent({
          kind: FunctionCallEventKind.IN_PROGRESS,
          functionName: frame.functionName,
          toolCallId: frame.toolCallId,
          timestamp: at,
          groupId: frame.groupId,
          // A call that survives an interruption is one the conversation was
          // never waiting on.
          blocking: frame.cancelOnInterruption,
          arguments: this._includeArguments ? frame.arguments : null,
          startedAt: pop(this._startedAt, frame.toolCallId),
        }),
      ];
    } else if (frame instanceof FunctionCallResultFrame) {
      // A call that doesn't block may report progress before it is done, and
      // only its final result settles it.
      if (frame.properties && !frame.properties.isFinal) {
        return [];
      }
      return this._settles(
        frame.error ? FunctionCallEventKind.FAILED : FunctionCallEventKind.COMPLETED,
        frame.functionName,
        frame.toolCallId,
        {
          result: this._includeResults && !frame.error ? frame.result : null,
          error: frame.error,
        },
      );
    } else if (frame instanceof FunctionCallCancelFrame) {
      // Inference is asked for by the deadline that settled the call, and by
      // nothing else that cancels one.
      const kind = frame.runLlm ? FunctionCallEventKind.TIMED_OUT : FunctionCallEventKind.CANCELLED;
      return this._settles(kind, frame.functionName, frame.toolCallId);
    }

    return [];
  }

  /**
   * Record the end of a call, naming when it began running if that is known.
   *
   * A call that began before the observer was watching settles without that
   * moment rather than borrowing one from another call.
   */
  protected _settles(
    kind: FunctionCallEventKind,
    functionName: string,
    toolCallId: string,
    options: { result?: unknown; error?: string | null } = {},
  ): FunctionCallEvent[] {
    this._startedAt.delete(toolCallId);
    return [
      new FunctionCallEvent({
        kind,
        functionName,
        toolCallId,
        timestamp: this._now(),
        inProgressAt: pop(this._inProgressAt, toolCallId),
        result: options.result ?? null,
        error: options.error ?? null,
      }),
    ];
  }
}
