// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/cli/main.py

/**
 * pipedog CLI entry point.
 *
 * `run` is the bin's target (`pipedog`): it runs `init` and `eval`, and shows `--help` and
 * `--version`. Upstream builds a Typer app lazily, so a bare install is import-safe, and degrades
 * to an install hint when the optional `cli` extra is missing; a JavaScript CLI has no extras,
 * and `@pipedog/evals` (the one optional dependency) is imported only by `pipedog eval`.
 *
 * DIVERGENCE: not ported, because they are Python packaging specific or tied to Pipecat's
 * services: the `pipecat_cli.extensions` entry-point plugins and the `cloud` stub (Pipecat
 * Cloud), the `pc` alias, and the Context Hub's stale-index warning (`hub_status.py`, skipped).
 * The removed `create` command's pointer to `init` is kept, as the bin is new here but Pipecat's
 * muscle memory is not.
 */

import { type Io, processIo } from "./_io.ts";
import { runEval } from "./eval.ts";
import { type InitDeps, initCommand } from "./init.ts";
import { VERSION } from "./templates/assets.ts";

export const MAIN_HELP = `Usage: pipedog [OPTIONS] COMMAND [ARGS]...

pipedog CLI - Build AI voice agents with ease. Command-line tools for building pipedog apps.

Options:
  -v, --version  Show version and exit
  -h, --help     Show this message and exit

Commands:
  init   Initialize a new pipedog project, and optionally scaffold it.
  eval   Run behavioral evals against a bot (needs @pipedog/evals).

Run \`pipedog <command> --help\` for a command's options.
`;

/** Printed for `pipedog create`: upstream's removed command (folded into `init`). */
export const CREATE_REMOVED_HINT =
  "`pipedog create` doesn't exist. Use `pipedog init` instead. It scaffolds a project from flags or a config file, e.g.\n\n" +
  "    pipedog init . --bot-type web -t smallwebrtc --stt deepgram_stt --llm openai_llm --tts cartesia_tts\n\n" +
  "Run `pipedog init --help` or `pipedog init --list-options` for details.";

/**
 * Run the CLI.
 *
 * @param argv The arguments after the program name.
 * @param io Where to write (default: the terminal).
 * @param deps The prompts and release `init` uses, for tests.
 * @returns The process's exit code.
 */
export async function run(
  argv: readonly string[] = process.argv.slice(2),
  io: Io = processIo(),
  deps: Partial<InitDeps> = {},
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    io.out(MAIN_HELP.trimEnd());
    return 2;
  }
  switch (command) {
    case "-h":
    case "--help":
      io.out(MAIN_HELP.trimEnd());
      return 0;
    case "-v":
    case "--version":
      io.out(`pipedog CLI version: ${VERSION}`);
      return 0;
    case "init":
      return await initCommand(rest, { ...deps, io });
    case "eval":
      return await runEval(rest, { io });
    case "create":
      io.err(CREATE_REMOVED_HINT);
      return 1;
    default:
      io.err(`${MAIN_HELP}\nError: No such command '${command}'.`);
      return 2;
  }
}
