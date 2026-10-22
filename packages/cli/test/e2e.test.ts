// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// End to end: the `pipedog` command as a user runs it, with the generated projects checked
// against the real packages of this workspace.
//
// - `init` runs non-interactively, with flags, into a temp directory. On Bun, and on Node (which
//   runs the TypeScript sources itself): the two write the same files.
// - The project is installed with `bun install` (its third-party dependencies, from the registry
//   or Bun's cache) and its `@pipedog/*` dependencies are linked to this workspace's packages, as
//   `bun link` would. They aren't installed from the registry, since this release isn't on it yet;
//   the test checks that each `@pipedog/*` range matches the workspace package's version.
// - `tsc --noEmit` type-checks the generated project: every import path and option name is
//   checked against the sources. A diagnostic in a dependency's own source (the workspace packages
//   export TypeScript) isn't the project's, and is not counted.
// - Every service the registry offers is generated and type-checked, in one `tsc` run.
// - The project's bot is started with `bun bot.ts` against mock OpenAI APIs (test-mocks), and a
//   scripted conversation runs through the real `pipedog eval run`: init -> install -> start ->
//   eval, with no API key.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { type MockOpenAI, startMockOpenAI } from "../../../examples/test-mocks/src/mock_openai.ts";
import { ProjectGenerator } from "../src/project.ts";
import { ProjectConfig, type ProjectConfigOptions } from "../src/questions.ts";
import { ServiceRegistry } from "../src/service_metadata.ts";

const REPO = resolve(import.meta.dir, "../../..");
const PACKAGES = join(REPO, "packages");
const CLI = join(PACKAGES, "cli", "src", "__main__.ts");
const VERSION: string = JSON.parse(
  readFileSync(join(PACKAGES, "cli", "package.json"), "utf8"),
).version;
const MINUTES = 60_000;

const roots: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pipedog-e2e-")));
  roots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function sh(cmd: string[], cwd: string, env: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

const hasNode = Bun.which("node") !== null;
const nodeMajorMinor = (() => {
  const node = Bun.which("node");
  if (!node) return [0, 0];
  const out = Bun.spawnSync([node, "--version"]).stdout.toString().trim();
  const [major, minor] = out.slice(1).split(".").map(Number);
  return [major ?? 0, minor ?? 0] as const;
})();
// Node runs TypeScript without a flag from 22.18.
const nodeRunsTypeScript =
  hasNode &&
  ((nodeMajorMinor[0] ?? 0) > 22 ||
    ((nodeMajorMinor[0] ?? 0) === 22 && (nodeMajorMinor[1] ?? 0) >= 18));

/** Every file under `dir`, relative, with its content. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else {
        out[relative(dir, path)] = readFileSync(path, "utf8");
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Install a generated server's third-party dependencies, and link its `@pipedog/*` ones to the
 * workspace. Returns the linked package names.
 */
async function install(server: string): Promise<string[]> {
  const pkgPath = join(server, "package.json");
  const original = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(original);
  const linked: string[] = [];
  for (const section of ["dependencies", "devDependencies"]) {
    for (const [name, range] of Object.entries<string>(pkg[section] ?? {})) {
      if (!name.startsWith("@pipedog/")) continue;
      const dir = join(PACKAGES, name.split("/")[1] as string);
      const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
      expect(range, `${name} in ${pkgPath}`).toEqual(`^${version}`);
      linked.push(name);
      delete pkg[section][name];
    }
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  const result = await sh(["bun", "install"], server);
  expect(result.code, result.stderr).toEqual(0);
  writeFileSync(pkgPath, original);
  link(server, linked);
  return linked;
}

function link(dir: string, names: Iterable<string>): void {
  mkdirSync(join(dir, "node_modules", "@pipedog"), { recursive: true });
  for (const name of names) {
    const target = join(dir, "node_modules", name);
    if (!existsSync(target)) symlinkSync(join(PACKAGES, name.split("/")[1] as string), target);
  }
}

/** The errors of `tsc --noEmit` in `project` that are in its own files. */
async function typecheck(project: string, extraArgs: string[] = []): Promise<string[]> {
  const tsc = join(project, "node_modules", ".bin", "tsc");
  const result = await sh([tsc, "--noEmit", "--pretty", "false", ...extraArgs], project);
  const diagnostics = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .filter((line) => /error TS\d+:/.test(line));
  // A path that climbs out of the project is a dependency's own source (the workspace packages
  // export TypeScript).
  return diagnostics.filter((line) => !line.startsWith("..") && !line.startsWith("/"));
}

async function init(args: string[], cwd: string, runtime: "bun" | "node" = "bun"): Promise<Run> {
  const cmd = runtime === "bun" ? ["bun", CLI] : ["node", CLI];
  return await sh([...cmd, "init", ...args], cwd);
}

describe("init, on Bun and on Node", () => {
  const FLAGS = [
    "--transport",
    "smallwebrtc",
    "--transport",
    "websocket",
    "--mode",
    "cascade",
    "--stt",
    "deepgram_stt",
    "--llm",
    "openai_llm",
    "--tts",
    "cartesia_tts",
    "--client-framework",
    "vanilla",
    "--eval",
    "--recording",
    "--transcription",
    "--observability",
    "--dockerfile",
    "--name",
    "demo",
  ];

  test("writes the project, the guides and the MCP config", async () => {
    const dir = temp();
    const result = await init([dir, ...FLAGS], REPO);
    expect(result.code, result.stderr).toEqual(0);
    for (const file of [
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      ".gitignore",
      ".mcp.json",
      ".cursor/mcp.json",
      ".vscode/mcp.json",
      "server/bot.ts",
      "server/package.json",
      "server/tsconfig.json",
      "server/.env.example",
      "server/Dockerfile",
      "server/evals/starter_text.yaml",
      "client/package.json",
      "client/src/config.js",
    ]) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers.pipedog).toEqual({
      command: "npx",
      args: ["-y", "@pipedog/mcp"],
    });
  });

  test.skipIf(!nodeRunsTypeScript)(
    "Node runs the CLI's sources and writes the same files",
    async () => {
      const a = temp();
      const b = temp();
      const withBun = await init([a, ...FLAGS], REPO, "bun");
      const withNode = await init([b, ...FLAGS], REPO, "node");
      expect(withBun.code, withBun.stderr).toEqual(0);
      expect(withNode.code, withNode.stderr).toEqual(0);
      const bunTree = tree(a);
      const nodeTree = tree(b);
      expect(Object.keys(nodeTree).sort()).toEqual(Object.keys(bunTree).sort());
      for (const [file, content] of Object.entries(bunTree)) {
        expect(nodeTree[file], file).toEqual(content);
      }
    },
  );

  test.skipIf(!nodeRunsTypeScript)(
    "`--version` and `--list-options` agree on Bun and Node",
    async () => {
      const bun = await sh(["bun", CLI, "init", "--list-options"], REPO);
      const node = await sh(["node", CLI, "init", "--list-options"], REPO);
      expect(node.stdout).toEqual(bun.stdout);
      expect((await sh(["node", CLI, "--version"], REPO)).stdout).toContain(VERSION);
    },
  );
});

describe("generated projects install and type-check", () => {
  const cases: { name: string; args: string[] }[] = [
    {
      name: "Bun, SmallWebRTC + WebSocket, cascade, every feature",
      args: [
        "-t",
        "smallwebrtc",
        "-t",
        "websocket",
        "-m",
        "cascade",
        "--stt",
        "deepgram_stt",
        "--llm",
        "openai_llm",
        "--tts",
        "cartesia_tts",
        "--eval",
        "--recording",
        "--transcription",
        "--observability",
        "--video-input",
        "--video-output",
        "--client-framework",
        "vanilla",
      ],
    },
    {
      name: "Node, SmallWebRTC, realtime (OpenAI)",
      args: [
        "-t",
        "smallwebrtc",
        "-m",
        "realtime",
        "--realtime",
        "openai_realtime",
        "--runtime",
        "node",
      ],
    },
    {
      name: "Bun, Twilio and SmallWebRTC for local testing, cascade",
      args: [
        "-t",
        "twilio",
        "-t",
        "smallwebrtc",
        "-m",
        "cascade",
        "--stt",
        "deepgram_stt",
        "--llm",
        "anthropic_llm",
        "--tts",
        "elevenlabs_tts",
      ],
    },
    {
      name: "Bun, LiveKit, cascade, a video avatar",
      args: [
        "-t",
        "livekit",
        "-m",
        "cascade",
        "--stt",
        "deepgram_stt",
        "--llm",
        "openai_llm",
        "--tts",
        "cartesia_tts",
        "--video",
        "heygen_video",
      ],
    },
  ];

  for (const { name, args } of cases) {
    test(
      name,
      async () => {
        const dir = temp();
        const result = await init([dir, ...args, "--name", "e2e-bot"], REPO);
        expect(result.code, result.stderr).toEqual(0);
        const server = join(dir, "server");
        await install(server);
        const errors = await typecheck(server);
        expect(errors).toEqual([]);
      },
      5 * MINUTES,
    );
  }
});

describe("the type check can fail", () => {
  test(
    "a wrong option or import in the bot is reported",
    async () => {
      // A control: without it, a type check that reads nothing would pass for every project.
      const dir = temp();
      const result = await init(
        [
          dir,
          "-t",
          "smallwebrtc",
          "-m",
          "realtime",
          "--realtime",
          "openai_realtime",
          "--runtime",
          "node",
        ],
        REPO,
      );
      expect(result.code, result.stderr).toEqual(0);
      const server = join(dir, "server");
      await install(server);
      expect(await typecheck(server)).toEqual([]);
      const bot = readFileSync(join(server, "bot.ts"), "utf8");
      writeFileSync(
        join(server, "bot.ts"),
        `${bot}\nimport { Nothing } from "@pipedog/openai/nothing";\nnew OpenAIRealtimeLLMService({ notAnOption: 1 });\nvoid Nothing;\n`,
      );
      const errors = await typecheck(server);
      expect(errors.some((e) => e.startsWith("bot.ts(") && e.includes("TS2307"))).toBe(true);
      expect(errors.some((e) => e.startsWith("bot.ts(") && e.includes("notAnOption"))).toBe(true);
    },
    5 * MINUTES,
  );
});

describe("every service the registry offers type-checks", () => {
  test(
    "a bot for each service, in one tsc run",
    async () => {
      const root = temp();
      const names: string[] = [];
      const generate = async (name: string, options: Partial<ProjectConfigOptions>) => {
        const config = new ProjectConfig({
          projectName: name,
          botType: "web",
          transports: ["smallwebrtc"],
          mode: "cascade",
          sttService: "deepgram_stt",
          llmService: "openai_llm",
          ttsService: "cartesia_tts",
          runtime: "node",
          ...options,
        });
        await new ProjectGenerator(config, { out: () => {}, version: VERSION }).generate(
          join(root, name),
          {
            nonInteractive: true,
            inPlace: true,
          },
        );
        names.push(name);
      };

      for (const t of ServiceRegistry.WEBRTC_TRANSPORTS) {
        await generate(`transport-${t.value}`, { transports: [t.value], enableEval: true });
      }
      for (const t of ServiceRegistry.TELEPHONY_TRANSPORTS) {
        await generate(`transport-${t.value}`, { botType: "telephony", transports: [t.value] });
      }
      for (const s of ServiceRegistry.STT_SERVICES)
        await generate(`stt-${s.value}`, { sttService: s.value });
      for (const s of ServiceRegistry.LLM_SERVICES)
        await generate(`llm-${s.value}`, { llmService: s.value });
      for (const s of ServiceRegistry.TTS_SERVICES)
        await generate(`tts-${s.value}`, { ttsService: s.value });
      for (const s of ServiceRegistry.REALTIME_SERVICES) {
        await generate(`realtime-${s.value}`, {
          mode: "realtime",
          sttService: null,
          llmService: null,
          ttsService: null,
          realtimeService: s.value,
        });
      }
      for (const s of ServiceRegistry.VIDEO_SERVICES) {
        await generate(`video-${s.value}`, { videoService: s.value, videoOutput: true });
      }
      await generate("features", {
        recording: true,
        transcription: true,
        enableObservability: true,
        enableEval: true,
        videoInput: true,
        videoOutput: true,
      });

      // One install for all of them: the union of their third-party dependencies.
      const dependencies: Record<string, string> = {};
      const linked = new Set<string>();
      for (const name of names) {
        const pkg = JSON.parse(readFileSync(join(root, name, "server", "package.json"), "utf8"));
        for (const section of ["dependencies", "devDependencies"]) {
          for (const [dep, range] of Object.entries<string>(pkg[section] ?? {})) {
            if (dep.startsWith("@pipedog/")) {
              const dir = join(PACKAGES, dep.split("/")[1] as string);
              const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
              expect(range, `${dep} in ${name}`).toEqual(`^${version}`);
              linked.add(dep);
            } else {
              dependencies[dep] = range;
            }
          }
        }
      }
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "all", private: true, dependencies }, null, 2),
      );
      const result = await sh(["bun", "install"], root);
      expect(result.code, result.stderr).toEqual(0);
      link(root, linked);
      writeFileSync(
        join(root, "tsconfig.json"),
        readFileSync(join(root, "features", "server", "tsconfig.json"), "utf8").replace(
          '"include": [\n    "*.ts"\n  ]',
          '"include": ["*/server/bot.ts"]',
        ),
      );
      // The run reads every bot (a tsconfig that matched nothing would pass for all of them).
      const listed = await sh([join(root, "node_modules", ".bin", "tsc"), "--listFilesOnly"], root);
      const bots = listed.stdout
        .split("\n")
        .filter((f) => f.startsWith(root) && f.endsWith("/server/bot.ts"));
      expect(bots.length).toEqual(names.length);
      expect(names.length).toBeGreaterThan(60);
      const errors = await typecheck(root);
      expect(errors).toEqual([]);
    },
    10 * MINUTES,
  );
});

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

describe("a generated bot runs, and `pipedog eval` talks to it", () => {
  let openai: MockOpenAI;
  beforeAll(() => {
    openai = startMockOpenAI();
  });
  afterAll(() => openai.stop());

  const SCENARIO = `name: capital
scenarios:
  - name: capital
    turns:
      # The bot greets first (the mock chat model answers with its greeting).
      - expect:
          - event: response
            text_contains: voice assistant
      - user: "What is the capital of Germany?"
        expect:
          - event: response
            text_contains: Berlin
`;

  const runtimes: ("bun" | "node")[] = ["bun", ...(nodeRunsTypeScript ? (["node"] as const) : [])];
  for (const runtime of runtimes) {
    test(
      `${runtime}: init, install, start, eval`,
      async () => {
        const dir = temp();
        const result = await init(
          [
            dir,
            "-t",
            "smallwebrtc",
            "-m",
            "cascade",
            "--stt",
            "openai_stt",
            "--llm",
            "openai_llm",
            "--tts",
            "openai_tts",
            "--eval",
            "--runtime",
            runtime,
            "--name",
            "mock-bot",
          ],
          REPO,
        );
        expect(result.code, result.stderr).toEqual(0);
        const server = join(dir, "server");
        await install(server);
        writeFileSync(join(server, "evals", "capital.yaml"), SCENARIO);

        const port = await freePort();
        const bot = Bun.spawn([runtime, "bot.ts", "--host", "127.0.0.1", "--port", String(port)], {
          cwd: server,
          env: {
            ...process.env,
            OPENAI_API_KEY: "test-key",
            OPENAI_BASE_URL: openai.baseUrl,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const output: string[] = [];
        const drain = async (stream: ReadableStream<Uint8Array>) => {
          for await (const chunk of stream) output.push(new TextDecoder().decode(chunk));
        };
        void drain(bot.stdout);
        void drain(bot.stderr);
        try {
          // Wait for the runner to listen.
          let up = false;
          for (let i = 0; i < 300 && !up; i++) {
            try {
              up = (await fetch(`http://127.0.0.1:${port}/status`)).ok;
            } catch {
              await Bun.sleep(100);
            }
          }
          expect(up, `the bot didn't start:\n${output.join("")}`).toBe(true);

          // The same runner serves the prebuilt client, as the README says.
          const client = await fetch(`http://127.0.0.1:${port}/client/`);
          expect(client.status).toEqual(200);

          // `pipedog eval run`, from the generated project, through the real CLI.
          const evalRun = await sh(
            [
              "bun",
              CLI,
              "eval",
              "run",
              "evals/capital.yaml",
              "--bot-url",
              `ws://127.0.0.1:${port}/ws`,
              "--logs-dir",
              join(dir, "logs"),
            ],
            server,
            { OPENAI_BASE_URL: openai.baseUrl },
          );
          expect(
            evalRun.code,
            `${evalRun.stdout}\n${evalRun.stderr}\nbot:\n${output.join("")}`,
          ).toEqual(0);
          // The mock model was asked the question, through the bot's pipeline.
          expect(openai.asked.some((q) => q.includes("capital of Germany"))).toBe(true);
        } finally {
          bot.kill();
          await bot.exited;
        }
      },
      5 * MINUTES,
    );
  }

  test(
    "a bot without its keys says which are missing",
    async () => {
      const dir = temp();
      const result = await init(
        [
          dir,
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
          "--eval",
          "--name",
          "nokeys",
        ],
        REPO,
      );
      expect(result.code, result.stderr).toEqual(0);
      const server = join(dir, "server");
      await install(server);
      writeFileSync(join(server, "evals", "capital.yaml"), SCENARIO);
      const port = await freePort();
      const bot = Bun.spawn(["bun", "bot.ts", "--host", "127.0.0.1", "--port", String(port)], {
        cwd: server,
        env: { ...process.env, DEEPGRAM_API_KEY: "", OPENAI_API_KEY: "", CARTESIA_API_KEY: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output: string[] = [];
      const drain = async (stream: ReadableStream<Uint8Array>) => {
        for await (const chunk of stream) output.push(new TextDecoder().decode(chunk));
      };
      void drain(bot.stdout);
      void drain(bot.stderr);
      try {
        for (let i = 0; i < 300; i++) {
          try {
            if ((await fetch(`http://127.0.0.1:${port}/status`)).ok) break;
          } catch {
            await Bun.sleep(100);
          }
        }
        // A session fails with the names of the variables.
        const evalRun = await sh(
          [
            "bun",
            CLI,
            "eval",
            "run",
            "evals/capital.yaml",
            "--bot-url",
            `ws://127.0.0.1:${port}/ws`,
            "--logs-dir",
            join(dir, "logs"),
          ],
          server,
        );
        expect(evalRun.code).not.toEqual(0);
        await Bun.sleep(300);
        expect(output.join("")).toContain(
          "Missing environment variables: DEEPGRAM_API_KEY, OPENAI_API_KEY, CARTESIA_API_KEY",
        );
      } finally {
        bot.kill();
        await bot.exited;
      }
    },
    5 * MINUTES,
  );
});
