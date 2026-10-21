// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import type { ProcessSpawner, SpawnedProcess } from "../src/index.ts";

export interface FakeProcess extends SpawnedProcess {
  cmd: string[];
  written: Uint8Array[];
  killed: boolean;
  /** Feed the recorder's stdout. */
  emit(chunk: Uint8Array): void;
  /** End the recorder's stdout, as if it exited. */
  finish(code?: number): void;
}

export interface FakeSpawner {
  spawner: ProcessSpawner;
  processes: FakeProcess[];
}

/**
 * A spawner that starts no processes. `installed` lists the programs that "exist": starting another
 * rejects like a missing executable does. `--version` style probes exit with 0.
 */
export function fakeSpawner(installed: string[] = ["sox"]): FakeSpawner {
  const processes: FakeProcess[] = [];
  const spawner: ProcessSpawner = async (cmd, options) => {
    if (!installed.includes(cmd[0] as string)) {
      throw Object.assign(new Error(`spawn ${cmd[0]} ENOENT`), { code: "ENOENT" });
    }
    const probe = cmd.length === 2 && (cmd[1] === "--version" || cmd[1] === "-version");
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    const queue: Array<Uint8Array | null> = [];
    let wake: (() => void) | null = null;
    const proc: FakeProcess = {
      cmd,
      written: [],
      killed: false,
      stdout: options.stdout
        ? {
            async *[Symbol.asyncIterator]() {
              while (true) {
                while (queue.length === 0) await new Promise<void>((r) => (wake = r));
                const next = queue.shift();
                if (next === null || next === undefined) return;
                yield next;
              }
            },
          }
        : null,
      async write(chunk) {
        proc.written.push(chunk.slice());
      },
      async closeStdin() {},
      kill() {
        proc.killed = true;
        queue.push(null);
        wake?.();
        resolveExit(null);
      },
      exited,
      stderrTail: () => "",
      emit(chunk) {
        queue.push(chunk);
        wake?.();
      },
      finish(code = 0) {
        queue.push(null);
        wake?.();
        resolveExit(code);
      },
    };
    if (probe) resolveExit(0);
    else processes.push(proc);
    return proc;
  };
  return { spawner, processes };
}
