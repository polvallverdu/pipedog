// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/observers/loggers/transcription_log_observer.py

/**
 * Transcription logging observer for Pipecat.
 *
 * This module provides an observer that logs transcription frames to the
 * console, allowing developers to monitor speech-to-text activity in real-time.
 */

import { InterimTranscriptionFrame, TranscriptionFrame } from "../../frames/frames.ts";
import { STTService } from "../../services/stt_service.ts";
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

/**
 * Observer to log transcription activity to the console.
 *
 * Monitors and logs all transcription frames from STT services, including both
 * final transcriptions and interim results. This allows developers to track
 * speech recognition activity and debug transcription issues.
 *
 * Only processes frames from STTService instances to avoid logging unrelated
 * transcription frames from other sources.
 */
export class TranscriptionLogObserver extends BaseObserver {
  /**
   * Handle frame push events and log transcription frames.
   *
   * Logs TranscriptionFrame and InterimTranscriptionFrame instances with
   * timestamps and user information for debugging purposes.
   *
   * @param data Frame push event data containing source, frame, and timestamp.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    const src = data.source;
    const frame = data.frame;
    const timestamp = data.timestamp;

    if (!(src instanceof STTService)) {
      return;
    }

    const timeSec = (timestamp / 1_000_000_000).toFixed(2);

    const arrow = "→";

    if (frame instanceof TranscriptionFrame) {
      logger.debug(
        `💬 ${src} ${arrow} TRANSCRIPTION: ${reprStr(frame.text)} from ${reprStr(frame.userId)} at ${timeSec}s`,
      );
    } else if (frame instanceof InterimTranscriptionFrame) {
      logger.debug(
        `💬 ${src} ${arrow} INTERIM TRANSCRIPTION: ${reprStr(frame.text)} from ${reprStr(frame.userId)} at ${timeSec}s`,
      );
    }
  }
}
