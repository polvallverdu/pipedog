// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/logger.py

/** Frame logging utilities for debugging and monitoring frame flow in Pipecat pipelines. */

import {
  BotSpeakingFrame,
  type Frame,
  InputAudioRawFrame,
  OutputAudioRawFrame,
  UserSpeakingFrame,
} from "../frames/frames.ts";
import { logger } from "../utils/logger.ts";
import { FrameDirection, FrameProcessor } from "./frame_processor.ts";

type FrameType = abstract new (...args: any[]) => Frame;

// loguru renders `<color>...</>` markup as ANSI escapes (`logger.opt(ansi=True)`).
// Our logger has no markup, so the common loguru color names are mapped here.
const ANSI_COLORS: Record<string, string> = {
  black: "30",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  white: "37",
  "light-black": "90",
  "light-red": "91",
  "light-green": "92",
  "light-yellow": "93",
  "light-blue": "94",
  "light-magenta": "95",
  "light-cyan": "96",
  "light-white": "97",
  bold: "1",
  dim: "2",
  italic: "3",
  underline: "4",
};

function colorize(color: string, msg: string): string {
  const code = ANSI_COLORS[color.toLowerCase()];
  return code ? `\u001b[${code}m${msg}\u001b[0m` : msg;
}

export interface FrameLoggerOptions {
  /** Color name for log message formatting (e.g. "red"). If null, no coloring is applied. */
  color?: string | null;
  /**
   * Frame types to exclude from logging. Defaults to common high-frequency
   * frames like audio and speaking frames.
   */
  ignoredFrameTypes?: readonly FrameType[];
}

/**
 * A frame processor that logs frame information for debugging purposes.
 *
 * This processor intercepts frames passing through the pipeline and logs their
 * details with configurable formatting and filtering. Useful for debugging
 * frame flow and understanding pipeline behavior.
 */
export class FrameLogger extends FrameProcessor {
  protected _prefix: string;
  protected _color: string | null;
  protected _ignoredFrameTypes: readonly FrameType[];

  /**
   * Initialize the frame logger.
   *
   * @param prefix Text prefix to add to log messages. Defaults to "Frame".
   * @param options.color Color for log message formatting. If null, no coloring is applied.
   * @param options.ignoredFrameTypes Frame types to exclude from logging.
   */
  constructor(prefix = "Frame", options: FrameLoggerOptions = {}) {
    super();
    this._prefix = prefix;
    this._color = options.color ?? null;
    this._ignoredFrameTypes = options.ignoredFrameTypes ?? [
      BotSpeakingFrame,
      UserSpeakingFrame,
      InputAudioRawFrame,
      OutputAudioRawFrame,
    ];
  }

  /**
   * Process and log frame information.
   *
   * @param frame The frame to process and potentially log.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (
      this._ignoredFrameTypes.length > 0 &&
      !this._ignoredFrameTypes.some((t) => frame instanceof t)
    ) {
      const dir = direction === FrameDirection.UPSTREAM ? "<" : ">";
      let msg = `${dir} ${this._prefix}: ${frame}`;
      if (this._color) {
        msg = colorize(this._color, msg);
      }
      logger.debug(msg);
    }

    await this.pushFrame(frame, direction);
  }
}
