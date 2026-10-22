// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** Helpers for the CLI tests: run the CLI in process with captured output, and scripted prompts. */

import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../src/_io.ts";
import type { InitDeps } from "../src/init.ts";
import { run } from "../src/main.ts";
import type { Choice, Prompter } from "../src/questions.ts";

/** A fresh empty temp directory (resolved, so it compares equal to what the CLI prints). */
export function tmpDir(prefix = "pipedog-cli-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function read(...parts: string[]): string {
  return readFileSync(join(...parts), "utf8");
}

export interface CliResult {
  code: number;
  /** Everything written to stdout and stderr, in order. */
  output: string;
  stdout: string;
  stderr: string;
}

/** A prompter that answers from a script, in order; `null` is a cancelled prompt. */
export class ScriptedPrompter implements Prompter {
  readonly asked: string[] = [];
  readonly infos: string[] = [];
  readonly #answers: unknown[];

  constructor(answers: unknown[] = []) {
    this.#answers = [...answers];
  }

  #next(message: string): unknown {
    this.asked.push(message);
    if (this.#answers.length === 0) throw new Error(`unexpected prompt: ${message}`);
    return this.#answers.shift();
  }

  async text(message: string, options?: { initialValue?: string }): Promise<string | null> {
    const answer = this.#next(message);
    return answer === "default" ? (options?.initialValue ?? "") : (answer as string | null);
  }

  async select<T extends string>(message: string, choices: Choice<T>[]): Promise<T | null> {
    const answer = this.#next(message) as T | null;
    if (answer !== null && !choices.some((c) => c.value === answer)) {
      throw new Error(`'${answer}' isn't a choice of '${message}': ${choices.map((c) => c.value)}`);
    }
    return answer;
  }

  async confirm(message: string): Promise<boolean | null> {
    return this.#next(message) as boolean | null;
  }

  info(message: string): void {
    this.infos.push(message);
  }

  /** Answers left unused. */
  get remaining(): number {
    return this.#answers.length;
  }
}

export interface CliOptions {
  cwd?: string;
  interactive?: boolean;
  prompter?: Prompter;
  deps?: Partial<InitDeps>;
}

/** Run `pipedog <argv>` in process, capturing its output. */
export async function cli(argv: string[], options: CliOptions = {}): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const all: string[] = [];
  const io: Io = {
    out: (line) => {
      stdout.push(line);
      all.push(line);
    },
    err: (line) => {
      stderr.push(line);
      all.push(line);
    },
    interactive: options.interactive ?? false,
    cwd: options.cwd ?? process.cwd(),
  };
  const code = await run(argv, io, {
    version: "9.9.9",
    ...(options.prompter ? { prompter: options.prompter } : {}),
    ...options.deps,
  });
  return {
    code,
    output: all.join("\n"),
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
  };
}

/** A complete non-interactive web/cascade invocation, minus the destination. */
export const SERVICE_FLAGS = [
  "--bot-type",
  "web",
  "-t",
  "smallwebrtc",
  "-m",
  "cascade",
  "--stt",
  "deepgram_stt",
  "--llm",
  "openai_llm",
  "--tts",
  "cartesia_tts",
];
