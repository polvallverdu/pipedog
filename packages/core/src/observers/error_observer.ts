// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/observers/error_observer.py

/**
 * Observer reporting the failures a pipeline runs into.
 *
 * Errors travel upstream from the processor that raised them, and not all of
 * them reach the end of that journey: a processor that answers for a failure
 * itself — a service switcher that fails over to its next service, say —
 * stops the error there. This observer reads each error where it is raised,
 * so a session's failure history holds the ones that were recovered from as
 * well as the ones that surfaced.
 */

import { time } from "@pipecat-ts/asyncio";
import { ErrorFrame } from "../frames/frames.ts";
import { ErrorCategory } from "../utils/errors.ts";
import { BaseObserver, type BaseObserverOptions, type FramePushed } from "./base_observer.ts";

export interface ErrorEventOptions {
  /** What went wrong, in the words of the processor that failed. */
  message: string;
  /**
   * Why it failed, drawn from `ErrorCategory` and independent of the provider
   * that failed: rejected credentials, an unreachable service, a malformed
   * request and so on.
   */
  category: ErrorCategory;
  /**
   * The name of the exception behind the failure, where one caused it.
   * Failures group by this where a message, carrying the particulars of a
   * single occurrence, is too specific to group by.
   */
  exceptionType?: string | null;
  /** The name of the processor that raised the error. */
  processor: string;
  /**
   * Whether that processor can still do its job. A processor that can't keeps
   * failing for as long as it is given work, so this separates a bad minute
   * from the end of a capability.
   */
  processorUsable: boolean;
  /** Unix timestamp of the failure. */
  timestamp: number;
}

/** One failure, as the processor that raised it described it. */
export class ErrorEvent {
  message: string;
  category: ErrorCategory;
  exceptionType: string | null;
  processor: string;
  processorUsable: boolean;
  timestamp: number;

  constructor(options: ErrorEventOptions) {
    this.message = options.message;
    this.category = options.category;
    this.exceptionType = options.exceptionType ?? null;
    this.processor = options.processor;
    this.processorUsable = options.processorUsable;
    this.timestamp = options.timestamp;
  }
}

export interface ErrorObserverOptions extends Omit<BaseObserverOptions, "observeEveryPush"> {
  /**
   * Reads the current time in seconds. Supplying one lets a test place
   * failures without waiting. Defaults to `time()`.
   */
  timeSource?: () => number;
}

/**
 * Reports each error a pipeline raises, once, where it is raised.
 *
 * An error is reported at its origin rather than where it ends up, and named
 * for the processor that raised it rather than the one that passed it along.
 *
 * Events:
 *
 * - on_error(observer, event): Emitted for each error, as an `ErrorEvent`.
 *
 * @example
 * const observer = new ErrorObserver();
 *
 * observer.eventHandler("on_error", async (observer, event: ErrorEvent) => {
 *   logger.info(JSON.stringify(event));
 * });
 */
export class ErrorObserver extends BaseObserver {
  protected _now: () => number;

  constructor(options: ErrorObserverOptions = {}) {
    super({ ...options, observeEveryPush: false });
    this._now = options.timeSource ?? time;

    this._registerEventHandler("on_error");
  }

  /**
   * Report an error frame.
   *
   * The first push of an error comes from the processor that failed.
   *
   * @param data Frame push event containing the frame and direction.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    const frame = data.frame;
    if (!(frame instanceof ErrorFrame)) {
      return;
    }

    // An error assembled by hand rather than reported through `pushError`
    // arrives without the processor and category that method settles, so
    // attribute it to the processor pushing it and report its cause as unknown.
    const processor = frame.processor ?? data.source;
    await this._callEventHandler(
      "on_error",
      new ErrorEvent({
        message: frame.error,
        category: frame.category ?? ErrorCategory.UNKNOWN,
        exceptionType: frame.exception ? (frame.exception as object).constructor.name : null,
        processor: processor.name,
        processorUsable: processor.isUsable,
        timestamp: this._now(),
      }),
    );
  }
}
