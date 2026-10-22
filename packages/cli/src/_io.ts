// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Where the commands write, and how they end. Upstream prints with `rich` and ends with
 * `typer.Exit`; here every command takes an `Io`, so tests capture what it says, and ends by
 * throwing an `Exit` that `main` turns into the process's exit code.
 */

export interface Io {
  /** A line on standard output. */
  out(line: string): void;
  /** A line on standard error. */
  err(line: string): void;
  /** Whether a person can answer prompts: a terminal on both ends. */
  interactive: boolean;
  /** The directory relative paths are resolved against. */
  cwd: string;
}

/** The real terminal. */
export function processIo(): Io {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    cwd: process.cwd(),
  };
}

/** Ends the command with `code` (upstream's `typer.Exit`). */
export class Exit extends Error {
  override name = "Exit";
  readonly code: number;

  constructor(code = 0) {
    super(`exit ${code}`);
    this.code = code;
  }
}
