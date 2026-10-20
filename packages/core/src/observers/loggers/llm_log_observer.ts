// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/observers/loggers/llm_log_observer.py

/** LLM logging observer for Pipecat. */

import {
  FunctionCallInProgressFrame,
  FunctionCallResultFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
} from "../../frames/frames.ts";
import { FrameDirection } from "../../processors/frame_processor.ts";
import { LLMService } from "../../services/llm_service.ts";
import { logger } from "../../utils/logger.ts";
import { BaseObserver, type FramePushed } from "../base_observer.ts";

/** Python's `repr()` of a string: single-quoted unless it holds only single quotes. */
function reprStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch < " " || ch === "\x7f")
      out += `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `${quote}${out}${quote}`;
}

/** Approximation of Python's `repr()` for log lines. */
function repr(value: unknown): string {
  if (typeof value === "string") return reprStr(value);
  return String(value);
}

/** Approximation of Python's `str()` on containers for log lines. */
function str(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Observer to log LLM activity to the console.
 *
 * Logs all frame instances (only from/to LLM service) of:
 *
 * - LLMFullResponseStartFrame
 * - LLMFullResponseEndFrame
 * - LLMTextFrame
 * - FunctionCallInProgressFrame
 *
 * This allows you to track when the LLM starts responding, what it generates,
 * and when it finishes.
 */
export class LLMLogObserver extends BaseObserver {
  /**
   * Handle frame push events and log LLM-related activities.
   *
   * @param data The frame push event data containing source, destination,
   *   frame, direction, and timestamp information.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    const src = data.source;
    const dst = data.destination;
    const frame = data.frame;
    const direction = data.direction;
    const timestamp = data.timestamp;

    if (!(src instanceof LLMService) && !(dst instanceof LLMService)) {
      return;
    }

    const timeSec = (timestamp / 1_000_000_000).toFixed(2);

    const arrow = "→";

    // Log LLM start/end frames (output)
    if (frame instanceof LLMFullResponseStartFrame || frame instanceof LLMFullResponseEndFrame) {
      const event = frame instanceof LLMFullResponseStartFrame ? "START" : "END";
      logger.debug(`🧠 ${src} ${arrow} LLM ${event} RESPONSE at ${timeSec}s`);
    }
    // Log all LLMTextFrames (output)
    else if (frame instanceof LLMTextFrame) {
      logger.debug(`🧠 ${src} ${arrow} LLM GENERATING: ${repr(frame.text)} at ${timeSec}s`);
    }
    // Log function calling (output)
    else if (
      frame instanceof FunctionCallInProgressFrame &&
      direction !== FrameDirection.DOWNSTREAM
    ) {
      logger.debug(
        `🧠 ${src} ${arrow} LLM FUNCTION CALL (${frame.toolCallId}): ${repr(frame.functionName)}(${str(frame.arguments)}) at ${timeSec}s`,
      );
    }
    // Log LLMContextFrame (input)
    else if (frame instanceof LLMContextFrame) {
      const messages = frame.context.getMessages();
      logger.debug(`🧠 ${arrow} ${dst} LLM CONTEXT FRAME: ${str(messages)} at ${timeSec}s`);
    }
    // Log function call result (input)
    else if (frame instanceof FunctionCallResultFrame) {
      logger.debug(
        `🧠 ${arrow} ${src} LLM FUNCTION CALL RESULT (${frame.toolCallId}): ${str(frame.result)} at ${timeSec}s`,
      );
    }
  }
}
