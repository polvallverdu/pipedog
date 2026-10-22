// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: runs `pipedog init` as a user would, on each runtime, into
// a temp directory (a cascade bot with an eval transport and two transports), and checks what it
// wrote.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../src/_io.ts";
import { run } from "../src/main.ts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`cli smoke: ${message}`);
}

export default async function smoke(): Promise<void> {
  const lines: string[] = [];
  const io: Io = {
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    interactive: false,
    cwd: process.cwd(),
  };

  check((await run(["init", "--list-options"], io)) === 0, "--list-options");
  check(JSON.parse(lines.join("\n")).transports.web.includes("smallwebrtc"), "web transports");

  const dir = mkdtempSync(join(tmpdir(), "pipedog-cli-smoke-"));
  try {
    lines.length = 0;
    const code = await run(
      [
        "init",
        dir,
        "--name",
        "smoke",
        "-t",
        "smallwebrtc",
        "-t",
        "twilio",
        "-m",
        "cascade",
        "--stt",
        "deepgram_stt",
        "--llm",
        "openai_llm",
        "--tts",
        "cartesia_tts",
        "--eval",
      ],
      io,
    );
    // Twilio is a telephony transport and SmallWebRTC a web one: the bot type is inferred.
    check(code === 0, `init exited with ${code}: ${lines.join("\n")}`);
    const bot = readFileSync(join(dir, "server", "bot.ts"), "utf8");
    check(bot.includes("DeepgramSTTService") && bot.includes("createTransport"), "bot.ts");
    const pkg = JSON.parse(readFileSync(join(dir, "server", "package.json"), "utf8"));
    check(pkg.name === "smoke", "package.json");
    check(readFileSync(join(dir, "CLAUDE.md"), "utf8").trim() === "@AGENTS.md", "CLAUDE.md");
    const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    check(mcp.mcpServers.pipedog.args[1] === "@pipedog/mcp", ".mcp.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
