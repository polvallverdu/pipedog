// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: the runtime's real process spawner (Bun.spawn,
// Deno.Command or node:child_process) runs `cat` as a pipe (stdin to stdout, exit code, a missing
// program), the tool detection either finds sox/ffmpeg or reports LocalAudioToolNotFoundError, and the
// recorder command lines are built. No audio device is opened.

import {
  defaultSpawner,
  detectAudioTool,
  LocalAudioToolNotFoundError,
  playCommand,
  recordCommand,
} from "@pipedog/transport-local";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`transport-local smoke: ${message}`);
}

export default async function smoke(): Promise<void> {
  const spawner = defaultSpawner();

  // stdin -> stdout through a real child process.
  const proc = await spawner(["cat"], { stdin: true, stdout: true });
  const input = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
  const read = (async () => {
    const parts: number[] = [];
    for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) parts.push(...chunk);
    return parts;
  })();
  await proc.write(input.slice(0, 2000));
  await proc.write(input.slice(2000));
  await proc.closeStdin();
  const output = await read;
  check(output.length === input.length, `cat echoed ${output.length} bytes`);
  check(
    output.every((b, i) => b === input[i]),
    "cat echoed different bytes",
  );
  check((await proc.exited) === 0, "cat exit code");

  // kill()
  const sleeper = await spawner(["cat"], { stdin: true, stdout: true });
  sleeper.kill();
  await sleeper.exited;

  // a program that does not exist
  let missing = false;
  try {
    await spawner(["pipedog-no-such-program"], { stdin: false, stdout: false });
  } catch {
    missing = true;
  }
  check(missing, "starting a missing program should reject");

  // tool detection: found, or a clear error
  try {
    const tool = await detectAudioTool({ spawner });
    check(tool === "sox" || tool === "ffmpeg", `tool ${tool}`);
  } catch (e) {
    check(e instanceof LocalAudioToolNotFoundError, `detection error ${e}`);
  }

  check(recordCommand("sox", { sampleRate: 16000, channels: 1 })[0] === "sox", "record command");
  check(
    playCommand("ffmpeg", { sampleRate: 16000, channels: 1, platform: "linux" }).includes("pulse"),
    "play command",
  );
}
