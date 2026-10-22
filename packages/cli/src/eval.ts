// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/cli/commands/eval.py

/**
 * `pipedog eval`: mounts the eval commands of `@pipedog/evals`.
 *
 * The eval commands themselves (`run`, `judge`, `suite`) are ported in `@pipedog/evals`, as
 * `packages/evals/src/cli.ts` (the `pipedog-eval` bin), and this package doesn't duplicate them.
 * Upstream's `main.py` mounts `eval_app` as a sub-command; here the sub-command is that package's
 * `evalApp`, imported on first use. `@pipedog/evals` is an optional peer dependency: its
 * harness, scenarios and LLM judge are not needed to scaffold a project, so a project that
 * doesn't run evals installs none of it. When it's missing, `pipedog eval` says how to install it.
 */

import type { Io } from "./_io.ts";

/** The hint printed when `@pipedog/evals` isn't installed. */
export const EVALS_INSTALL_HINT =
  "`pipedog eval` needs the optional @pipedog/evals package, which isn't installed.\n\n" +
  "Install it next to the CLI:\n\n" +
  "  • In your project (the CLI runs from its node_modules):\n" +
  "        bun add -d @pipedog/evals      # or: npm install --save-dev @pipedog/evals\n\n" +
  "  • Or run it without installing the CLI:\n" +
  "        bunx @pipedog/evals            # the pipedog-eval bin, with the same commands\n";

type EvalApp = (argv: string[]) => Promise<number>;

/** The module that holds the eval CLI, loaded by name so the CLI doesn't require the package. */
export const EVALS_CLI_MODULE = "@pipedog/evals/cli";

/** Whether `e` is the failure to resolve `@pipedog/evals` itself (not an error inside it). */
function isMissingEvals(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: string }).code;
  const message = e.message;
  const notFound =
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    /Cannot find (package|module)|Could not resolve|Module not found/i.test(message);
  return notFound && message.includes("@pipedog/evals");
}

export interface RunEvalOptions {
  io?: Pick<Io, "err">;
  /** Loads `evalApp`; defaults to importing `@pipedog/evals/cli` (for tests). */
  load?: () => Promise<{ evalApp: EvalApp }>;
}

/**
 * Run `pipedog eval <argv>`.
 *
 * @param argv The arguments after `eval` (`run scenarios/ -v`).
 * @returns The process's exit code.
 */
export async function runEval(argv: string[], options: RunEvalOptions = {}): Promise<number> {
  const err = options.io?.err ?? ((line: string) => console.error(line));
  let evalApp: EvalApp;
  try {
    const load =
      options.load ??
      (async () => (await import(/* @vite-ignore */ EVALS_CLI_MODULE)) as { evalApp: EvalApp });
    ({ evalApp } = await load());
  } catch (e) {
    if (isMissingEvals(e)) {
      err(EVALS_INSTALL_HINT);
      return 1;
    }
    throw e;
  }
  return await evalApp(argv);
}
