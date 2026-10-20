// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/concepts/frames.mdx. Type-checked on every docs build.

// #region custom-frame
import { DataFrame, type Frame, SystemFrame, TextFrame } from "@pipecat-ts/core/frames/frames";

export interface AsteriskCommandFrameOptions {
  /** The command to send to the telephony transport. */
  command: string;
}

/** A custom command sent downstream to a telephony transport. */
export class AsteriskCommandFrame extends DataFrame {
  command: string;

  constructor(options: AsteriskCommandFrameOptions) {
    super(options);
    this.command = options.command;
  }
}
// #endregion custom-frame

// #region uninterruptible-frame
/** Like AsteriskCommandFrame, but survives user interruptions. */
export class CriticalCommandFrame extends DataFrame {
  override interruptible = false;
  command: string;

  constructor(options: AsteriskCommandFrameOptions) {
    super(options);
    this.command = options.command;
  }
}
// #endregion uninterruptible-frame

// #region per-frame-interruptible
const frame = new TextFrame({ text: "Important" });
frame.interruptible = false; // This specific frame survives interruption.
// #endregion per-frame-interruptible

// #region categories
export function describe(f: Frame): string {
  if (f instanceof SystemFrame) return "system: high priority, never dropped by interruptions";
  if (f.interruptible) return "data/control: queued in order, dropped by interruptions";
  return "data/control: queued in order, survives interruptions";
}
// #endregion categories

console.log(describe(frame));
