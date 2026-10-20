// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/aggregators/dtmf_aggregator.py

/**
 * DTMF aggregation processor for converting keypad input to transcription.
 *
 * This module provides a frame processor that aggregates DTMF (Dual-Tone
 * Multi-Frequency) keypad inputs into meaningful sequences and converts them to
 * transcription frames for downstream processing by LLM context aggregators.
 */

import { Event, type Task, TimeoutError, waitFor } from "@pipedog/asyncio";
import { KeypadEntry } from "../../audio/dtmf/types.ts";
import {
  CancelFrame,
  EndFrame,
  type Frame,
  InputDTMFFrame,
  StartFrame,
  TranscriptionFrame,
} from "../../frames/frames.ts";
import { timeNowIso8601 } from "../../utils/time.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "../frame_processor.ts";

export interface DTMFAggregatorOptions extends FrameProcessorOptions {
  /** Idle timeout in seconds before flushing. Defaults to 2.0. */
  timeout?: number;
  /** Digit that triggers immediate flush. Defaults to `KeypadEntry.POUND`. */
  terminationDigit?: KeypadEntry;
  /** Prefix added to DTMF sequence in transcription. Defaults to "DTMF: ". */
  prefix?: string;
}

/**
 * Aggregates DTMF frames into meaningful sequences for LLM processing.
 *
 * The aggregator accumulates digits from InputDTMFFrame instances and flushes
 * when:
 *
 * - Timeout occurs (configurable idle period)
 * - Termination digit is received (default: '#')
 * - EndFrame or CancelFrame is received
 *
 * Emits TranscriptionFrame for compatibility with existing LLM context aggregators.
 */
export class DTMFAggregator extends FrameProcessor {
  protected _aggregation = "";
  protected _idleTimeout: number;
  protected _terminationDigit: KeypadEntry;
  protected _prefix: string;

  protected _digitEvent = new Event();
  protected _aggregationTask: Task<unknown> | null = null;

  /** Initialize the DTMF aggregator. */
  constructor(options: DTMFAggregatorOptions = {}) {
    super(options);
    this._idleTimeout = options.timeout ?? 2.0;
    this._terminationDigit = options.terminationDigit ?? KeypadEntry.POUND;
    this._prefix = options.prefix ?? "DTMF: ";
  }

  /** Clean up resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._stopAggregationTask();
  }

  /**
   * Process incoming frames and handle DTMF aggregation.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof StartFrame) {
      await this.pushFrame(frame, direction);
      this._createAggregationTask();
    } else if (frame instanceof EndFrame || frame instanceof CancelFrame) {
      if (this._aggregation) {
        await this._flushAggregation();
      }
      await this._stopAggregationTask();
      await this.pushFrame(frame, direction);
    } else if (frame instanceof InputDTMFFrame) {
      // Push the DTMF frame downstream first
      await this.pushFrame(frame, direction);
      // Then handle it in order for the TranscriptionFrame to be emitted
      // after the InputDTMFFrame
      await this._handleDtmfFrame(frame);
    } else {
      await this.pushFrame(frame, direction);
    }
  }

  /** Handle DTMF input frame. */
  protected async _handleDtmfFrame(frame: InputDTMFFrame): Promise<void> {
    const isFirstDigit = !this._aggregation;

    const digitValue = frame.button;
    this._aggregation += digitValue;

    // For first digit, schedule interruption.
    if (isFirstDigit) {
      await this.broadcastInterruption();
    }

    // Check for immediate flush conditions
    if (frame.button === this._terminationDigit) {
      await this._flushAggregation();
    } else {
      // Signal digit received for timeout handling
      this._digitEvent.set();
    }
  }

  /** Creates the aggregation task if it hasn't been created yet. */
  protected _createAggregationTask(): void {
    if (!this._aggregationTask) {
      this._aggregationTask = this.createTask(() => this._aggregationTaskHandler());
    }
  }

  /** Stops the aggregation task. */
  protected async _stopAggregationTask(): Promise<void> {
    if (this._aggregationTask) {
      await this.cancelTask(this._aggregationTask);
      this._aggregationTask = null;
    }
  }

  /** Background task that handles timeout-based flushing. */
  protected async _aggregationTaskHandler(): Promise<void> {
    for (;;) {
      try {
        await waitFor(() => this._digitEvent.wait(), this._idleTimeout);
        this._digitEvent.clear();
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        if (this._aggregation) {
          await this._flushAggregation();
        }
      }
    }
  }

  /** Flush the current aggregation as a TranscriptionFrame. */
  protected async _flushAggregation(): Promise<void> {
    if (!this._aggregation) {
      return;
    }

    const sequence = this._aggregation;
    const transcriptionText = `${this._prefix}${sequence}`;

    // A DTMF flush is always a complete entry, so mark it finalized.
    const transcriptionFrame = new TranscriptionFrame({
      text: transcriptionText,
      userId: "",
      timestamp: timeNowIso8601(),
      finalized: true,
    });
    await this.pushFrame(transcriptionFrame);

    this._aggregation = "";
  }
}
