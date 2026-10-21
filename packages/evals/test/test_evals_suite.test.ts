// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_evals_suite.py

// Tests for the eval suite's manifest parsing, per-run log capture, and run updates.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { monotonic, sleep } from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import {
  EvalExpectationResult,
  EvalScriptResult,
  EvalScriptTurnResult,
  EvalSimulationMetricScore,
  EvalSimulationResult,
  EvalSimulationTurnVerdict,
} from "../src/results.ts";
import { EvalKind } from "../src/scenario.ts";
import {
  _appendResult,
  _Process,
  _RunFiles,
  _resultFromDict,
  _resultToDict,
  _simulationResultFromDict,
  capturePipelineLogs,
  contextualize,
  DEFAULT_CONCURRENCY,
  DEFAULT_SPAWN,
  EvalManifest,
  EvalRun,
  EvalSuite,
} from "../src/suite.ts";

const MANIFEST = `
bots_dir: bots
scenarios_dir: my-scenarios
concurrency: 2
runs_dir: out
record: true
suite:
  - bot: voice/voice-a.py
    scenarios: [simple_math, multi_turn]
  - bot: vision/vision-b.py
    runner_body:
      path: bodies/cat.yaml
    scenarios: [other/special.yaml]
`;

/** A fresh temporary directory, symlinks resolved (`Path(tmp).resolve()`). */
function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "evals-suite-")));
}

function manifestOf(runs: EvalRun[], concurrency: number, extra: Partial<EvalManifest> = {}) {
  return new EvalManifest({
    runs,
    spawn: DEFAULT_SPAWN,
    python: process.execPath,
    concurrency,
    repeat: 1,
    basePort: 7900,
    runsDir: null,
    record: false,
    cacheDir: null,
    ...extra,
  });
}

describe("TestEvalManifestLoad", () => {
  let base: string;
  let manifestPath: string;

  beforeEach(() => {
    base = tempDir();
    manifestPath = path.join(base, "manifest.yaml");
    fs.writeFileSync(manifestPath, MANIFEST);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  test("test_paths_resolve_relative_to_manifest", async () => {
    const m = await EvalManifest.load(manifestPath);
    expect(m.concurrency).toEqual(2);
    expect(m.record).toBe(true);
    expect(m.runsDir).toEqual(path.join(base, "out"));
    expect(m.runs.length).toEqual(3); // 2 + 1 scenarios

    const first = m.runs[0]!;
    expect(first.bot).toEqual("voice/voice-a.py");
    expect(first.botPath).toEqual(path.join(base, "bots", "voice", "voice-a.py"));
    // Bare scenario names resolve under scenarios_dir, with .yaml appended.
    expect(first.scenario).toEqual("simple_math");
    expect(first.scenarioPath).toEqual(path.join(base, "my-scenarios", "simple_math.yaml"));
  });

  test("test_scenario_paths_resolve_relative_to_manifest", async () => {
    const m = await EvalManifest.load(manifestPath);
    const special = m.runs[2]!;
    // A path-like scenario bypasses scenarios_dir and resolves to the manifest.
    expect(special.scenario).toEqual("special");
    expect(special.scenarioPath).toEqual(path.join(base, "other", "special.yaml"));
    expect(special.runnerBodyPath).toEqual(path.join(base, "bodies", "cat.yaml"));
    expect(special.runnerBody).toBeNull();
  });

  test("test_runner_body_given_inline", async () => {
    fs.writeFileSync(
      manifestPath,
      "suite:\n" +
        "  - bot: a.py\n" +
        "    runner_body:\n" +
        "      data: {model: gpt-4o-mini, question: hi}\n" +
        "    scenarios: [x]\n",
    );
    const run = (await EvalManifest.load(manifestPath)).runs[0]!;
    expect(run.runnerBody).toEqual({ model: "gpt-4o-mini", question: "hi" });
    expect(run.runnerBodyPath).toBeNull();
  });

  // Deprecated upstream (`runner_body: <file>`, since 1.11.0, removed in 2.0.0):
  // not ported, so a bare string is rejected like any other bad value.
  test.skip("test_bare_runner_body_path_is_deprecated", () => {});

  test("test_runner_body_must_be_a_path_or_data", async () => {
    for (const bad of [
      "{path: a.yaml, data: {}}",
      "{}",
      "{file: a.yaml}",
      "[a.yaml]",
      "{data: a.yaml}",
    ]) {
      fs.writeFileSync(
        manifestPath,
        `suite:\n  - bot: a.py\n    runner_body: ${bad}\n    scenarios: [x]\n`,
      );
      await expect(EvalManifest.load(manifestPath)).rejects.toThrow("'runner_body:'");
    }
  });

  test("test_defaults", async () => {
    fs.writeFileSync(path.join(base, "minimal.yaml"), "suite: []\n");
    const m = await EvalManifest.load(path.join(base, "minimal.yaml"));
    expect(m.concurrency).toEqual(DEFAULT_CONCURRENCY);
    expect(m.spawn).toEqual(DEFAULT_SPAWN);
    expect(m.record).toBe(false);
    expect(m.runsDir).toBeNull();
    expect(m.runs).toEqual([]);
  });

  test("test_overrides_win", async () => {
    const m = await EvalManifest.load(manifestPath, {
      concurrency: 8,
      record: false,
      spawn: "x {bot}",
    });
    expect(m.concurrency).toEqual(8);
    expect(m.record).toBe(false);
    expect(m.spawn).toEqual("x {bot}");
  });

  test("test_an_entry_caps_its_own_concurrency", async () => {
    fs.writeFileSync(
      manifestPath,
      "suite:\n" +
        "  - bot: a.py\n    concurrency: 2\n    scenarios: [x, y]\n" +
        "  - bot: b.py\n    scenarios: [x]\n" +
        "  - bot: a.py\n    scenarios: [z]\n",
    );
    const m = await EvalManifest.load(manifestPath, { concurrency: 8 });
    expect(m.runs.map((r) => r.concurrency)).toEqual([2, 2, null, null]);
    expect(m.runs.map((r) => r.entry)).toEqual([0, 0, 1, 2]);
    // The command line's cap is the suite's, not the entry's.
    expect(m.concurrency).toEqual(8);
  });

  test("test_entry_concurrency_must_be_a_positive_integer", async () => {
    for (const bad of ["0", "-1", "two", "true", "1.5"]) {
      fs.writeFileSync(
        manifestPath,
        `suite:\n  - bot: a.py\n    concurrency: ${bad}\n    scenarios: [x]\n`,
      );
      await expect(EvalManifest.load(manifestPath)).rejects.toThrow("'concurrency:'");
    }
  });
});

describe("TestCapturePipelineLogs", () => {
  test("test_writes_sections_per_pipeline", async () => {
    const logsDir = tempDir();
    try {
      await capturePipelineLogs(logsDir, "run1", { name: "simple_math", enabled: true }, () => {
        contextualize({ eval_pipeline: "judge" }, () => {
          logger.debug("judge line");
        });
        logger.debug("harness line");
      });

      const content = fs.readFileSync(path.join(logsDir, "run1.debug.log"), "utf8");
      expect(content).toContain("===== judge logs: simple_math =====");
      expect(content).toContain("judge line");
      expect(content).toContain("===== harness logs: simple_math =====");
      expect(content).toContain("harness line");
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });

  test("test_disabled_writes_nothing", async () => {
    const logsDir = tempDir();
    try {
      await capturePipelineLogs(logsDir, "run1", { name: "x", enabled: false }, () => {
        logger.debug("dropped");
      });
      expect(fs.readdirSync(logsDir)).toEqual([]);
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });

  test("test_concurrent_runs_do_not_mix", async () => {
    const logsDir = tempDir();
    try {
      // Logs emitted under a different eval_run id must not land in run1's file.
      await capturePipelineLogs(logsDir, "run1", { name: "a", enabled: true }, () => {
        logger.debug("mine");
        contextualize({ eval_run: "run2" }, () => {
          logger.debug("theirs");
        });
      });
      const content = fs.readFileSync(path.join(logsDir, "run1.debug.log"), "utf8");
      expect(content).toContain("mine");
      expect(content).not.toContain("theirs");
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });
});

// `on_update` handlers see each run enter `running` and reach `done`.
describe("TestSuiteUpdateEvent", () => {
  let logsDir: string;
  let suite: EvalSuite;

  beforeEach(() => {
    logsDir = tempDir();
    // A bot path that doesn't exist: the run errors out before spawning
    // anything, which is enough to drive both status changes.
    const run = new EvalRun({
      bot: "missing.py",
      scenario: "none",
      scenarioPath: path.join(logsDir, "none.yaml"),
      botPath: path.join(logsDir, "missing.py"),
    });
    suite = new EvalSuite(manifestOf([run], 1, { runsDir: logsDir }));
  });

  afterEach(() => {
    fs.rmSync(logsDir, { recursive: true, force: true });
  });

  test("test_event_handler_receives_runs", async () => {
    const seen: [unknown, string][] = [];

    suite.eventHandler("on_update", async (source: unknown, run: EvalRun) => {
      seen.push([source, run.status]);
    });

    await suite.run(logsDir);

    expect(seen.every(([source]) => source === suite)).toBe(true);
    expect(seen.map(([, status]) => status)).toEqual(["running", "done"]);
  });

  // Deprecated upstream (`EvalSuite.run(on_update=...)` and the
  // `use_cache=`/`default_timeout_ms=` knobs, since 1.9.0): not ported.
  test.skip("test_callback_is_deprecated_and_still_called", () => {});
  test.skip("test_deprecated_knobs_still_work", () => {});
  test.skip("test_callback_stays_scoped_to_the_call_it_was_passed_to", () => {});
});

// The suite keeps `concurrency` runs going; an entry's own cap limits its runs in flight.
describe("TestBotConcurrency", () => {
  let logsDir: string;

  beforeEach(() => {
    logsDir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(logsDir, { recursive: true, force: true });
  });

  function makeSuite(runs: EvalRun[], concurrency: number, repeat = 1): EvalSuite {
    return new EvalSuite(manifestOf(runs, concurrency, { repeat }));
  }

  /** Stand in for the bot and the harness, recording the most runs held at once per `key` (the bot) and in all. */
  function countOverlap(
    suite: EvalSuite,
    hold = 0.05,
    key: (run: EvalRun) => string | number = (run) => run.bot,
  ): Map<string | number, number> {
    const active = new Map<string | number, number>();
    const peak = new Map<string | number, number>([["total", 0]]);

    const s = suite as any;
    s._spawnBot = async (run: EvalRun) => {
      const k = key(run);
      active.set(k, (active.get(k) ?? 0) + 1);
      peak.set(k, Math.max(peak.get(k) ?? 0, active.get(k)!));
      const total = [...active.values()].reduce((a, b) => a + b, 0);
      peak.set("total", Math.max(peak.get("total")!, total));
      await sleep(hold);
      active.set(k, active.get(k)! - 1);
      return null;
    };
    s._runHarness = async () => null;
    s._finish = async (run: EvalRun) => {
      run.status = "done";
    };
    s._missingFile = () => null;
    return peak;
  }

  function makeRuns(bots: Record<string, number>, caps: Record<string, number> = {}): EvalRun[] {
    const runs: EvalRun[] = [];
    Object.entries(bots).forEach(([bot, count], entry) => {
      for (let i = 0; i < count; i++) {
        runs.push(
          new EvalRun({
            bot,
            scenario: `s${i}`,
            scenarioPath: path.join(logsDir, "s.yaml"),
            botPath: path.join(logsDir, bot),
            concurrency: caps[bot] ?? null,
            entry,
          }),
        );
      }
    });
    return runs;
  }

  test("test_one_entry_fills_every_slot", async () => {
    const runs = makeRuns({ "a.py": 10 });
    const suite = makeSuite(runs, 4);
    const peak = countOverlap(suite);

    await suite.run(logsDir);

    expect(peak.get("a.py")).toEqual(4);
    expect(runs.map((r) => r.status)).toEqual(Array(10).fill("done"));
  });

  test("test_an_entry_cap_limits_its_runs_in_flight", async () => {
    const runs = makeRuns({ "capped.py": 3, "plain.py": 3 }, { "capped.py": 1 });
    const suite = makeSuite(runs, 4);
    const peak = countOverlap(suite);

    await suite.run(logsDir);

    expect(peak.get("capped.py")).toEqual(1);
    expect(peak.get("total")).toEqual(4);
    expect(runs.map((r) => r.status)).toEqual(Array(6).fill("done"));
  });

  test("test_an_entry_cap_holds_across_attempts", async () => {
    const runs: EvalRun[] = [];
    for (const attempt of [1, 2, 3]) {
      ["capped.py", "plain.py"].forEach((bot, entry) => {
        runs.push(
          new EvalRun({
            bot,
            scenario: "s",
            scenarioPath: path.join(logsDir, "s.yaml"),
            botPath: path.join(logsDir, bot),
            concurrency: bot === "capped.py" ? 1 : null,
            entry,
            attempt,
          }),
        );
      });
    }
    const suite = makeSuite(runs, 2, 3);
    const peak = countOverlap(suite);

    await suite.run(logsDir);

    expect(peak.get("capped.py")).toEqual(1);
    expect(peak.get("total")).toEqual(2);
    expect(runs.map((r) => r.status)).toEqual(Array(6).fill("done"));
  });

  test("test_an_entry_cap_leaves_another_entry_for_the_same_bot_alone", async () => {
    const runs: EvalRun[] = [];
    for (const entry of [0, 1]) {
      for (let i = 0; i < 3; i++) {
        runs.push(
          new EvalRun({
            bot: "a.py",
            scenario: `s${entry}${i}`,
            scenarioPath: path.join(logsDir, "s.yaml"),
            botPath: path.join(logsDir, "a.py"),
            concurrency: entry === 0 ? 1 : null,
            entry,
          }),
        );
      }
    }
    const suite = makeSuite(runs, 4);
    const peak = countOverlap(suite, 0.05, (run) => run.entry);

    await suite.run(logsDir);

    expect(peak.get(0)).toEqual(1);
    expect(peak.get(1)).toEqual(3);
    expect(peak.get("total")).toEqual(4);
    expect(runs.map((r) => r.status)).toEqual(Array(6).fill("done"));
  });

  test("test_runs_are_taken_in_manifest_order", async () => {
    const runs = (
      [
        [0, "a.py", "s1"],
        [0, "a.py", "s2"],
        [0, "a.py", "s3"],
        [1, "b.py", "s1"],
        [2, "c.py", "s1"],
        [2, "c.py", "s2"],
        [3, "a.py", "s4"],
      ] as const
    ).map(
      ([entry, bot, scenario]) =>
        new EvalRun({
          bot,
          scenario,
          scenarioPath: path.join(logsDir, "s.yaml"),
          botPath: path.join(logsDir, bot),
          entry,
        }),
    );
    const suite = makeSuite(runs, 1);
    const started: [string, string][] = [];

    const s = suite as any;
    s._spawnBot = async (run: EvalRun) => {
      started.push([run.bot, run.scenario]);
      return null;
    };
    s._runHarness = async () => null;
    s._finish = async (run: EvalRun) => {
      run.status = "done";
    };
    s._missingFile = () => null;

    await suite.run(logsDir);

    // One at a time, each entry's scenarios run together, in manifest
    // order, and a bot's second entry waits for its place.
    expect(started).toEqual([
      ["a.py", "s1"],
      ["a.py", "s2"],
      ["a.py", "s3"],
      ["b.py", "s1"],
      ["c.py", "s1"],
      ["c.py", "s2"],
      ["a.py", "s4"],
    ]);
  });
});

describe("TestRunFiles", () => {
  test("test_prefix_carries_the_bot_and_the_name_when_the_entry_has_one", () => {
    const logs = "/logs";
    const run = new EvalRun({ bot: "turns/bot.py", scenario: "scripted/turn", scenarioPath: "x" });
    expect(_RunFiles.forRun(run, logs, null).prefix).toEqual("turns_bot.py__scripted__turn");
    const named = new EvalRun({
      bot: "turns/bot.py",
      name: "groq/llama",
      scenario: "scripted/turn",
      scenarioPath: "x",
    });
    expect(_RunFiles.forRun(named, logs, null).prefix).toEqual(
      "turns_bot.py__groq_llama__scripted__turn",
    );
    const repeated = new EvalRun({
      bot: "turns/bot.py",
      name: "groq/llama",
      scenario: "turn",
      scenarioPath: "x",
      attempts: 2,
      attempt: 2,
    });
    expect(_RunFiles.forRun(repeated, logs, null).prefix).toEqual(
      "turns_bot.py__groq_llama__turn__002",
    );
  });
});

// An inline body reaches the bot as a file; a body file sets the bot's directory.
describe("TestSpawnWithRunnerBody", () => {
  let base: string;
  let bot: string;

  beforeEach(() => {
    base = tempDir();
    fs.mkdirSync(path.join(base, "bodies"));
    // The "bot" records its argv and working directory, then exits.
    // DIVERGENCE: a JS bot run by the current runtime, where upstream's is a Python script.
    bot = path.join(base, "bot.js");
    fs.writeFileSync(
      bot,
      "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n",
    );
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  async function spawn(run: EvalRun): Promise<{ argv: string[]; cwd: string }> {
    const suite = new EvalSuite(
      manifestOf([run], 1, { spawn: "{python} {bot} --port {port}", python: process.execPath }),
    );
    const files = _RunFiles.forRun(run, path.join(base, "logs"), null);
    fs.mkdirSync(path.dirname(files.log), { recursive: true });
    const proc = (await suite._spawnBot(run, 7900, files))!;
    await proc.wait();
    return JSON.parse(fs.readFileSync(files.log, "utf8"));
  }

  test("test_inline_body_is_written_for_the_bot", async () => {
    const run = new EvalRun({
      bot: "bot.js",
      scenario: "x",
      scenarioPath: path.join(base, "x.yaml"),
      botPath: bot,
      runnerBody: { model: "gpt-4o-mini" },
    });
    const seen = await spawn(run);
    expect(seen.argv.slice(0, 2)).toEqual(["--port", "7900"]);
    expect(seen.argv[2]).toEqual("--runner-body");
    const bodyPath = seen.argv[3]!;
    expect(path.dirname(bodyPath)).toEqual(path.join(base, "logs"));
    expect(JSON.parse(fs.readFileSync(bodyPath, "utf8"))).toEqual({ model: "gpt-4o-mini" });
    // No body file to anchor it, so the bot runs where the suite does.
    expect(seen.cwd).toEqual(process.cwd());
  });

  test("test_body_file_is_the_bots_directory", async () => {
    const body = path.join(base, "bodies", "cat.yaml");
    fs.writeFileSync(body, "image_path: cat.jpg\n");
    const run = new EvalRun({
      bot: "bot.js",
      scenario: "x",
      scenarioPath: path.join(base, "x.yaml"),
      botPath: bot,
      runnerBodyPath: body,
    });
    const seen = await spawn(run);
    expect(seen.argv.slice(2)).toEqual(["--runner-body", body]);
    expect(fs.realpathSync(seen.cwd)).toEqual(path.dirname(body));
  });
});

// A run's bot is terminated as soon as the run ends: its dev runner outlives the session.
describe("TestStopBot", () => {
  test("test_running_bot_is_terminated_promptly", async () => {
    const proc = await _Process.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"]);
    const started = monotonic();

    await EvalSuite._stopBot(proc);

    expect(proc.returncode).not.toBeNull();
    expect(monotonic() - started).toBeLessThan(5);
  });

  test("test_exited_bot_is_left_alone", async () => {
    const proc = await _Process.spawn([process.execPath, "-e", "0"]);
    await proc.wait();

    await EvalSuite._stopBot(proc);

    expect(proc.returncode).toEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Simulations in a manifest's scenarios: list, and their results.jsonl records.
// ---------------------------------------------------------------------------

const SIMULATION = (name: string, runs: number) => `
name: ${name}
simulator: {service: openai}
scenarios:
  - name: ${name}
    persona: "A caller."
    goal: "Get it done."
    success: "it got done"
    runs: ${runs}
`;

const SCRIPT = (name: string) => `name: ${name}\nscenarios:\n  - name: ${name}\n    turns: []\n`;

describe("TestManifestSimulations", () => {
  let base: string;

  beforeEach(() => {
    base = tempDir();
    fs.mkdirSync(path.join(base, "scenarios"));
    fs.writeFileSync(path.join(base, "scenarios", "book.yaml"), SIMULATION("book", 3));
    fs.writeFileSync(path.join(base, "scenarios", "once.yaml"), SIMULATION("once", 1));
    fs.writeFileSync(path.join(base, "scenarios", "greet.yaml"), SCRIPT("greet"));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  async function manifest(text: string, overrides: Parameters<typeof EvalManifest.load>[1] = {}) {
    const p = path.join(base, "manifest.yaml");
    fs.writeFileSync(p, text);
    return await EvalManifest.load(p, overrides);
  }

  test("test_the_file_says_which_kind_a_scenario_is_and_how_often_it_runs", async () => {
    const m = await manifest("suite:\n  - bot: bot.py\n    scenarios: [greet, book, once]\n");
    const byName = new Map<string, EvalRun[]>();
    for (const run of m.runs) {
      byName.set(run.scenario, [...(byName.get(run.scenario) ?? []), run]);
    }
    expect(byName.get("book/book")!.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(byName.get("once/once")!.map((r) => r.attempt)).toEqual([1]);
    expect(byName.get("greet/greet")!.map((r) => r.attempt)).toEqual([1]);
    const book = byName.get("book/book")![0]!;
    expect(book.kind).toEqual("simulation");
    expect(book.attempts).toEqual(3);
    expect(book.sweep).toBe(false); // its runs are a requirement
    expect(book.scenarioPath).toEqual(path.join(base, "scenarios", "book.yaml"));
    const greet = byName.get("greet/greet")![0]!;
    expect(greet.kind).toEqual("script");
    expect(greet.attempts).toEqual(1);
    expect(greet.sweep).toBe(false);
    // Attempt-major: every scenario's first attempt precedes any second one.
    expect(m.runs.map((r) => r.attempt)).toEqual([1, 1, 1, 2, 3]);
  });

  test("test_repeat_overrides_a_simulations_runs", async () => {
    const m = await manifest("suite:\n  - bot: bot.py\n    scenarios: [book]\n", { repeat: 2 });
    expect(m.runs.map((r) => r.attempt)).toEqual([1, 2]);
    expect(m.runs[0]!.attempts).toEqual(2);
    // A repeat makes the suite a measurement.
    expect(m.runs.every((r) => r.sweep)).toBe(true);
  });

  // Set on the command line or in the manifest, 1 means one run, not the file's three.
  test("test_a_repeat_of_one_is_an_override_too", async () => {
    let m = await manifest("suite:\n  - bot: bot.py\n    scenarios: [book]\n", { repeat: 1 });
    expect(m.runs.map((r) => r.attempt)).toEqual([1]);
    m = await manifest("repeat: 1\nsuite:\n  - bot: bot.py\n    scenarios: [book]\n");
    expect(m.runs.map((r) => r.attempt)).toEqual([1]);
  });

  test("test_a_folder_in_a_name_stays_under_the_scenarios_dir", async () => {
    fs.mkdirSync(path.join(base, "scenarios", "scripted"));
    fs.writeFileSync(path.join(base, "scenarios", "scripted", "greet.yaml"), SCRIPT("greet"));
    const m = await manifest("suite:\n  - bot: bot.py\n    scenarios: [scripted/greet]\n");
    const run = m.runs[0]!;
    expect(run.scenario).toEqual("greet/greet");
    expect(run.scenarioPath).toEqual(path.join(base, "scenarios", "scripted", "greet.yaml"));
  });

  test("test_the_suite_filters_by_kind", async () => {
    const m = await manifest("suite:\n  - bot: bot.py\n    scenarios: [greet, book]\n");
    const runs = new EvalSuite(m).filter({ kind: EvalKind.SIMULATION });
    expect(new Set(runs.map((r) => r.scenario))).toEqual(new Set(["book/book"]));
    expect(runs.length).toEqual(3);
  });

  // Its kind can't be read, so it runs once as a scenario and reports the error.
  test("test_a_missing_scenario_still_gets_a_run", async () => {
    const m = await manifest("suite:\n  - bot: bot.py\n    scenarios: [nope]\n");
    expect(m.runs.length).toEqual(1);
    expect(m.runs[0]!.scenario).toEqual("nope");
    expect(m.runs[0]!.kind).toEqual("script");
    expect(m.runs[0]!.attempts).toEqual(1);
  });

  // Each scenario runs under its own name and as its own kind.
  test("test_a_file_contributes_a_run_per_scenario", async () => {
    fs.writeFileSync(
      path.join(base, "scenarios", "mixed.yaml"),
      "name: mixed\n" +
        "scenarios:\n" +
        "  - name: hi\n    turns: []\n" +
        "  - name: call\n    persona: p\n    goal: g\n    success: s\n    runs: 2\n",
    );
    const m = await manifest("suite:\n  - bot: bot.py\n    scenarios: [greet, mixed]\n");
    const first = m.runs.filter((r) => r.attempt === 1);
    expect(first.map((r) => r.scenario)).toEqual(["greet/greet", "mixed/hi", "mixed/call"]);
    expect(first.map((r) => r.kind)).toEqual(["script", "script", "simulation"]);
    expect(first.map((r) => r.attempts)).toEqual([1, 1, 2]);
    expect(first.slice(1).every((r) => path.basename(r.scenarioPath) === "mixed.yaml")).toBe(true);
    // A scenario's name is a file stem without the slash.
    expect(first[1]!.stem).toEqual("mixed__hi");
  });

  test("test_the_suite_filters_by_scenario_name_or_either_half", async () => {
    fs.writeFileSync(
      path.join(base, "scenarios", "mixed.yaml"),
      "name: mixed\nscenarios:\n  - name: hi\n    turns: []\n  - name: bye\n    turns: []\n",
    );
    const m = await manifest("suite:\n  - bot: bot.py\n    scenarios: [greet, mixed]\n");
    const names = (runs: EvalRun[]) => runs.map((r) => r.scenario);
    expect(names(new EvalSuite(m).filter({ scenario: "mixed/hi" }))).toEqual(["mixed/hi"]);
    expect(names(new EvalSuite(m).filter({ scenario: "hi" }))).toEqual(["mixed/hi"]);
    expect(names(new EvalSuite(m).filter({ scenario: "mixed" }))).toEqual([
      "mixed/hi",
      "mixed/bye",
    ]);
    expect(names(new EvalSuite(m).filter({ scenario: "greet" }))).toEqual(["greet/greet"]);
  });

  test("test_a_run_loads_its_own_scenario", async () => {
    fs.writeFileSync(
      path.join(base, "scenarios", "mixed.yaml"),
      "name: mixed\nscenarios:\n  - name: hi\n    turns: []\n  - name: bye\n    turns: []\n",
    );
    const m = await manifest("suite:\n  - bot: bot.py\n    scenarios: [mixed]\n");
    // Built from a loaded file, the runs hold their scenarios already.
    expect(m.runs.every((r) => r.loaded !== null)).toBe(true);
    const loadedNames = [];
    for (const r of m.runs) loadedNames.push((await r.load()).name);
    expect(loadedNames).toEqual(["mixed/hi", "mixed/bye"]);
    // A run that only knows its file and name reads the file.
    const p = m.runs[0]!.scenarioPath;
    expect(
      (await new EvalRun({ bot: "b", scenario: "mixed/bye", scenarioPath: p }).load()).name,
    ).toEqual("mixed/bye");
    await expect(
      new EvalRun({ bot: "b", scenario: "mixed/nope", scenarioPath: p }).load(),
    ).rejects.toThrow("no scenario called 'mixed/nope'");
  });

  test("test_an_entry_name_labels_its_runs", async () => {
    const m = await manifest(
      "suite:\n" +
        "  - bot: bot.py\n    name: openai/gpt-4o-mini\n    scenarios: [greet]\n" +
        "  - bot: bot.py\n    name: groq/llama\n    scenarios: [greet]\n" +
        "  - bot: other.py\n    scenarios: [greet]\n",
    );
    expect(m.runs.map((r) => r.label)).toEqual(["openai/gpt-4o-mini", "groq/llama", "other.py"]);
    expect(m.runs.map((r) => r.name)).toEqual(["openai/gpt-4o-mini", "groq/llama", null]);
    expect(m.runs.map((r) => r.bot)).toEqual(["bot.py", "bot.py", "other.py"]);
    // The pattern filter sees the name and the bot path alike.
    expect(new EvalSuite(m).filter({ pattern: "groq" }).map((r) => r.label)).toEqual([
      "groq/llama",
    ]);
    expect(new EvalSuite(m).filter({ pattern: "bot.py" }).length).toEqual(2);
  });

  test("test_two_entries_may_not_run_a_scenario_under_one_label", async () => {
    await expect(
      manifest(
        "suite:\n  - bot: bot.py\n    scenarios: [greet]\n  - bot: bot.py\n    scenarios: [greet]\n",
      ),
    ).rejects.toThrow("'bot.py' runs 'greet/greet' twice");
    // The same bot on different scenarios is fine, as is a named second entry.
    await manifest(
      "suite:\n  - bot: bot.py\n    scenarios: [greet]\n  - bot: bot.py\n    scenarios: [book]\n",
    );
    await manifest(
      "suite:\n  - bot: bot.py\n    scenarios: [greet]\n" +
        "  - bot: bot.py\n    name: again\n    scenarios: [greet]\n",
    );
  });

  test("test_an_entry_name_must_be_a_non_empty_string", async () => {
    for (const bad of ['""', "3", "[a]"]) {
      await expect(
        manifest(`suite:\n  - bot: bot.py\n    name: ${bad}\n    scenarios: [greet]\n`),
      ).rejects.toThrow("'name:'");
    }
  });

  // Deprecated upstream (a flat scenario file without `scenarios:`, since
  // 1.11.0, removed in 2.0.0): not ported.
  test.skip("test_a_flat_file_still_loads_and_warns", () => {});
});

describe("TestScenarioRecords", () => {
  function result(): EvalScriptResult {
    return new EvalScriptResult({
      scenarioName: "greet",
      passed: true,
      failures: [],
      turns: [
        new EvalScriptTurnResult({
          turnIndex: 0,
          status: "passed",
          expectations: [
            new EvalExpectationResult({
              expectationIndex: 0,
              eventName: "llm_marker",
              passed: true,
              matched: "◐",
            }),
            new EvalExpectationResult({
              expectationIndex: 1,
              eventName: "llm_response",
              passed: true,
              matched: "Hi",
            }),
          ],
          durationMs: 50,
        }),
      ],
      durationMs: 60,
    });
  }

  test("test_result_roundtrips_through_the_worker_json", () => {
    const r = result();
    const rebuilt = _resultFromDict(pyJsonLoads(pyJsonDumps(_resultToDict(r))) as any);
    expect(rebuilt).toEqual(r);
  });

  test("test_results_jsonl_record_keeps_what_each_expectation_matched", async () => {
    const base = tempDir();
    try {
      const run = new EvalRun({
        bot: "voice/x.py",
        name: "openai/gpt-4o-mini",
        scenario: "greet",
        scenarioPath: path.join(base, "greet.yaml"),
        status: "done",
        result: result(),
      });
      await _appendResult(path.join(base, "results.jsonl"), run, "voice_x.py__greet", base, null);
      const record = pyJsonLoads(fs.readFileSync(path.join(base, "results.jsonl"), "utf8")) as any;
      expect(record.passed).toBe(true);
      expect([record.bot, record.name]).toEqual(["voice/x.py", "openai/gpt-4o-mini"]);
      expect(record.turns[0].expectations).toEqual([
        { expectation_index: 0, event_name: "llm_marker", passed: true, matched: "◐" },
        { expectation_index: 1, event_name: "llm_response", passed: true, matched: "Hi" },
      ]);
      expect(record).not.toHaveProperty("events_seen");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("TestSimulationRecords", () => {
  test("test_result_roundtrips_through_the_worker_json", () => {
    const result = new EvalSimulationResult({
      simulationName: "book",
      succeeded: true,
      reason: "booked",
      metrics: [
        new EvalSimulationMetricScore({
          name: "politeness",
          score: 0.5,
          passed: false,
          reason: "turn 2: curt",
          minScore: 1.0,
          criterion: "stays polite",
          verdicts: [
            new EvalSimulationTurnVerdict({ turn: 1, passed: true, reason: "warm" }),
            new EvalSimulationTurnVerdict({
              turn: 2,
              passed: false,
              reason: "curt",
              verdict: "no",
              confidence: 0.9,
              probabilities: { meets: 0.1, fails: 0.9 },
            }),
          ],
        }),
      ],
      messages: [{ role: "user", content: "hi" }],
      conversation: [
        { role: "user", content: "hi" },
        { role: "tool_call", name: "book", arguments: {}, cancelled: false },
      ],
      turns: 2,
      endedBy: "end_call",
      endCall: { success: true, reason: "done" },
      durationMs: 1234,
      confidence: 0.8,
      probabilities: { yes: 0.8, no: 0.2 },
      success: "the bot booked a table",
    });
    const rebuilt = _simulationResultFromDict(
      pyJsonLoads(pyJsonDumps(_resultToDict(result))) as any,
    );
    expect(rebuilt).toEqual(result);
  });

  test("test_results_jsonl_record_for_a_simulation_run", async () => {
    const base = tempDir();
    try {
      const run = new EvalRun({
        bot: "flows/x.py",
        scenario: "book",
        scenarioPath: path.join(base, "book.yaml"),
        kind: EvalKind.SIMULATION,
        attempts: 3,
        attempt: 2,
        status: "done",
        durationMs: 1234,
        result: new EvalSimulationResult({
          simulationName: "book",
          succeeded: false,
          reason: "no table",
          turns: 3,
          endedBy: "bot",
          eventsSeen: [{ type: "llm_started" }],
          success: "the bot booked a table",
          metrics: [
            new EvalSimulationMetricScore({
              name: "politeness",
              score: 1.0,
              criterion: "stays polite",
            }),
          ],
        }),
      });
      await _appendResult(
        path.join(base, "results.jsonl"),
        run,
        "flows_x.py__book__002",
        base,
        null,
      );
      const record = pyJsonLoads(fs.readFileSync(path.join(base, "results.jsonl"), "utf8")) as any;
      expect(record.scenario).toEqual("book");
      expect(record.name).toEqual("flows/x.py");
      expect(record.kind).toEqual("simulation");
      expect(record.attempt).toEqual(2);
      expect(record.passed).toBe(false);
      expect(record.succeeded).toBe(false);
      expect(record.ended_by).toEqual("bot");
      expect(record.reason).toEqual("no table");
      expect(record.success).toEqual("the bot booked a table");
      expect(record.metrics[0].criterion).toEqual("stays polite");
      expect(record.events_seen).toEqual([{ type: "llm_started" }]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("TestSimulationConversationFile", () => {
  test("test_a_finished_simulation_writes_its_conversation_and_the_record_points_to_it", async () => {
    const conversation = [
      { role: "user", content: "A table at six." },
      { role: "tool_call", name: "book", arguments: { time: "6" }, cancelled: false },
      { role: "assistant", content: "Booked." },
    ];
    const base = tempDir();
    try {
      const run = new EvalRun({
        bot: "flows/x.py",
        scenario: "book",
        scenarioPath: path.join(base, "book.yaml"),
        kind: EvalKind.SIMULATION,
        result: new EvalSimulationResult({
          simulationName: "book",
          succeeded: true,
          conversation,
        }),
      });
      const suite = new EvalSuite(manifestOf([run], 1));
      const files = _RunFiles.forRun(run, base, null);
      await suite._finish(run, files, null, null, path.join(base, "results.jsonl"), base, null);
      expect(JSON.parse(fs.readFileSync(files.conversation, "utf8"))).toEqual(conversation);
      const record = pyJsonLoads(fs.readFileSync(path.join(base, "results.jsonl"), "utf8")) as any;
      expect(record.artifacts.conversation).toEqual(files.conversation);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

// Each entry gets its own queue, in manifest order, with its cap.
describe("TestEntryQueues", () => {
  function run(
    label: string,
    scenario: string,
    entry: number,
    attempt = 1,
    concurrency: number | null = null,
  ): EvalRun {
    return new EvalRun({
      bot: "bot.py",
      name: label,
      scenario,
      loaded: null,
      botPath: "bot.py",
      scenarioPath: `${scenario}.yaml`,
      entry,
      attempt,
      concurrency,
    });
  }

  test("test_one_queue_per_entry_in_manifest_order", () => {
    const runs = [
      run("a", "s1", 0),
      run("a", "s2", 0),
      run("b", "s1", 1),
      run("a", "s3", 2),
      run("c", "s1", 3),
    ];
    const queues = EvalSuite._entryQueues(runs);
    // A label's second entry is a queue of its own, in its manifest place.
    expect(queues.map(([, , q]) => q.map((r) => [r.label, r.scenario]))).toEqual([
      [
        ["a", "s1"],
        ["a", "s2"],
      ],
      [["b", "s1"]],
      [["a", "s3"]],
      [["c", "s1"]],
    ]);
    expect(queues.map(([entry, cap]) => [entry, cap])).toEqual([
      [0, null],
      [1, null],
      [2, null],
      [3, null],
    ]);
  });

  test("test_attempts_form_their_own_queues_attempt_major", () => {
    const runs = [
      run("a", "s1", 0, 1),
      run("a", "s2", 0, 1),
      run("b", "s1", 1, 1),
      run("a", "s1", 0, 2),
      run("a", "s2", 0, 2),
      run("b", "s1", 1, 2),
    ];
    const queues = EvalSuite._entryQueues(runs);
    expect(queues.map(([, , q]) => q.map((r) => [r.label, r.scenario, r.attempt]))).toEqual([
      [
        ["a", "s1", 1],
        ["a", "s2", 1],
      ],
      [["b", "s1", 1]],
      [
        ["a", "s1", 2],
        ["a", "s2", 2],
      ],
      [["b", "s1", 2]],
    ]);
  });

  test("test_each_entry_has_its_own_cap_and_none_without_one", () => {
    const runs = [run("a", "s1", 0, 1, 3), run("a", "s2", 1, 1, 2), run("b", "s1", 2)];
    expect(EvalSuite._entryQueues(runs).map(([, cap]) => cap)).toEqual([3, 2, null]);
  });
});
