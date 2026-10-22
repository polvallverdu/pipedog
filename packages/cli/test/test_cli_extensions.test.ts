// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/cli/test_cli_extensions.py

// Tests for the `pipedog` entry point: its commands, `--version`, and the mount of `pipedog eval`.
//
// DIVERGENCE: upstream's file tests the plugin machinery (`pipecat_cli.extensions` entry points,
// the `cloud` stub, a broken plugin being skipped), which has no counterpart. What the entry
// point does here is under "NEW": the commands it has, and how `eval` is delegated to
// `@pipedog/evals` without being duplicated.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVALS_INSTALL_HINT, runEval } from "../src/eval.ts";
import { VERSION } from "../src/templates/assets.ts";
import { cli } from "./helpers.ts";

describe("TestExtensions", () => {
  // The plugin entry points (`pipecat_cli.extensions`) and the Pipecat Cloud stub aren't ported.
  test.skip("test_installed_extension_is_mounted", () => {});
  test.skip("test_broken_extension_is_skipped_with_a_warning", () => {});
  test.skip("test_non_typer_extension_is_skipped", () => {});
  test.skip("test_known_extension_stub_prints_how_to_enable_it", () => {});
  test.skip("test_stub_keeps_the_other_installed_plugins_in_the_hint", () => {});
});

describe("NEW: the pipedog command", () => {
  test("--version prints this package's version", async () => {
    const result = await cli(["--version"]);
    expect(result.code).toEqual(0);
    expect(result.stdout).toContain(VERSION);
    expect(VERSION).toEqual(
      JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version,
    );
    expect((await cli(["-v"])).stdout).toContain(VERSION);
  });

  test("--help lists init and eval", async () => {
    const result = await cli(["--help"]);
    expect(result.code).toEqual(0);
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("eval");
  });

  test("no command shows the help and exits 2", async () => {
    const result = await cli([]);
    expect(result.code).toEqual(2);
    expect(result.stdout).toContain("Usage: pipedog");
  });

  test("an unknown command is an error", async () => {
    const result = await cli(["deploy"]);
    expect(result.code).toEqual(2);
    expect(result.stderr).toContain("No such command 'deploy'");
  });

  test("the bin is `pipedog`, and the only one, so npx and bunx pick it", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    expect(Object.keys(pkg.bin)).toEqual(["pipedog"]);
  });
});

describe("NEW: pipedog eval", () => {
  test("delegates to the evals CLI, with the arguments after `eval`", async () => {
    const calls: string[][] = [];
    const code = await runEval(["run", "scenarios/", "-v"], {
      load: async () => ({
        evalApp: async (argv) => {
          calls.push(argv);
          return 3;
        },
      }),
    });
    expect(code).toEqual(3);
    expect(calls).toEqual([["run", "scenarios/", "-v"]]);
  });

  test("says how to install @pipedog/evals when it is missing", async () => {
    const errors: string[] = [];
    const code = await runEval(["run"], {
      io: { err: (line) => errors.push(line) },
      load: async () => {
        throw Object.assign(new Error("Cannot find package '@pipedog/evals' from '/x/main.ts'"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
    });
    expect(code).toEqual(1);
    expect(errors.join("\n")).toEqual(EVALS_INSTALL_HINT);
    expect(EVALS_INSTALL_HINT).toContain("bun add -d @pipedog/evals");
  });

  test("a failure inside the evals package is not mistaken for it missing", async () => {
    await expect(
      runEval(["run"], {
        io: { err: () => {} },
        load: async () => {
          throw Object.assign(new Error("Cannot find package 'yaml' from '/x/evals/scenario.ts'"), {
            code: "ERR_MODULE_NOT_FOUND",
          });
        },
      }),
    ).rejects.toThrow("yaml");
  });

  test("runs the real evals CLI when it is installed", async () => {
    // `pipedog eval --help` is `pipedog-eval --help`: the same code, not a copy.
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await cli(["eval", "--help"]).then((r) => r.code);
    } finally {
      process.stdout.write = write;
    }
    expect(code).toEqual(0);
    expect(out.join("")).toContain("run");
    expect(out.join("")).toContain("suite");
    expect(out.join("")).toContain("judge");
  });

  test("the CLI doesn't contain a copy of the eval commands", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "eval.ts"), "utf8");
    expect(src).toContain("@pipedog/evals/cli");
    expect(src.split("\n").length).toBeLessThan(120);
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    // An optional peer, not a dependency.
    expect(pkg.dependencies["@pipedog/evals"]).toBeUndefined();
    expect(pkg.peerDependencies["@pipedog/evals"]).toBeDefined();
    expect(pkg.peerDependenciesMeta["@pipedog/evals"].optional).toBe(true);
  });
});
