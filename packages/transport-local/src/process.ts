// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Spawning a child process on Bun (`Bun.spawn`), Deno (`Deno.Command`) and Node
 * (`node:child_process`), behind one small interface. No native addon: the local audio
 * transport talks to `sox` or `ffmpeg` through the child's stdin and stdout pipes.
 *
 * The three runtimes' types are not imported (the package has no `@types/*`); the few members
 * used are declared here.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";

/** A running child process, as far as the transport needs it. */
export interface SpawnedProcess {
  /** The child's stdout, when it was piped. */
  stdout: AsyncIterable<Uint8Array> | null;
  /** Write to the child's stdin (resolves once the data is accepted: backpressure). */
  write(chunk: Uint8Array): Promise<void>;
  /** Close the child's stdin. */
  closeStdin(): Promise<void>;
  /** Kill the child (no-op if it has exited). */
  kill(): void;
  /** Resolves with the exit code (null if killed by a signal). */
  exited: Promise<number | null>;
  /** The last bytes the child wrote to stderr, as text. */
  stderrTail(): string;
}

export interface SpawnOptions {
  /** Pipe the child's stdin (else it is ignored). */
  stdin: boolean;
  /** Pipe the child's stdout (else it is ignored). */
  stdout: boolean;
}

/** Starts `cmd[0]` with the rest as arguments. Rejects if the program cannot be started. */
export type ProcessSpawner = (cmd: string[], options: SpawnOptions) => Promise<SpawnedProcess>;

const STDERR_TAIL_BYTES = 4096;

/** Keep the last `STDERR_TAIL_BYTES` of what a stream emits. */
async function collectTail(
  stream: AsyncIterable<Uint8Array> | null | undefined,
  into: { text: string },
): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) {
      into.text = (into.text + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
    }
  } catch (e) {
    rethrowIfCancelled(e);
    // the process went away: nothing more to collect
  }
}

interface BunSubprocess {
  stdin?: { write(chunk: Uint8Array): unknown; flush(): unknown; end(): unknown };
  stdout?: AsyncIterable<Uint8Array>;
  stderr?: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  exitCode: number | null;
  kill(): void;
}

const spawnWithBun: ProcessSpawner = async (cmd, options) => {
  const bun = (globalThis as unknown as { Bun: { spawn(cmd: string[], o: object): BunSubprocess } })
    .Bun;
  const proc = bun.spawn(cmd, {
    stdin: options.stdin ? "pipe" : "ignore",
    stdout: options.stdout ? "pipe" : "ignore",
    stderr: "pipe",
  });
  const tail = { text: "" };
  void collectTail(proc.stderr, tail);
  return {
    stdout: options.stdout ? (proc.stdout ?? null) : null,
    async write(chunk) {
      if (!proc.stdin) return;
      await proc.stdin.write(chunk);
      await proc.stdin.flush();
    },
    async closeStdin() {
      await proc.stdin?.end();
    },
    kill() {
      if (proc.exitCode === null) proc.kill();
    },
    exited: proc.exited,
    stderrTail: () => tail.text,
  };
};

interface DenoChild {
  stdin: { getWriter(): { write(c: Uint8Array): Promise<void>; close(): Promise<void> } };
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  status: Promise<{ code: number }>;
  kill(): void;
}

const spawnWithDeno: ProcessSpawner = async (cmd, options) => {
  const deno = (
    globalThis as unknown as {
      Deno: {
        Command: new (program: string, o: object) => { spawn(): DenoChild };
      };
    }
  ).Deno;
  const child = new deno.Command(cmd[0] as string, {
    args: cmd.slice(1),
    stdin: options.stdin ? "piped" : "null",
    stdout: options.stdout ? "piped" : "null",
    stderr: "piped",
  }).spawn();
  const tail = { text: "" };
  void collectTail(child.stderr, tail);
  const writer = options.stdin ? child.stdin.getWriter() : null;
  let done = false;
  const exited = child.status.then(
    (s) => {
      done = true;
      return s.code;
    },
    () => {
      done = true;
      return null;
    },
  );
  return {
    stdout: options.stdout ? child.stdout : null,
    async write(chunk) {
      await writer?.write(chunk);
    },
    async closeStdin() {
      await writer?.close().catch(() => {});
    },
    kill() {
      if (done) return;
      try {
        child.kill();
      } catch {
        // already exited
      }
    },
    exited,
    stderrTail: () => tail.text,
  };
};

interface NodeChild {
  stdin: {
    write(chunk: Uint8Array, cb: (err?: Error | null) => void): boolean;
    end(): void;
    on(event: "error", cb: (e: Error) => void): void;
  } | null;
  stdout: AsyncIterable<Uint8Array> | null;
  stderr: AsyncIterable<Uint8Array> | null;
  once(event: string, cb: (...args: never[]) => void): void;
  kill(): boolean;
  exitCode: number | null;
}

const spawnWithNode: ProcessSpawner = async (cmd, options) => {
  // A variable specifier keeps bundlers (and Workers builds) away from the import.
  const specifier = "node:child_process";
  const { spawn } = (await import(specifier)) as {
    spawn(program: string, args: string[], o: object): NodeChild;
  };
  const child = spawn(cmd[0] as string, cmd.slice(1), {
    stdio: [options.stdin ? "pipe" : "ignore", options.stdout ? "pipe" : "ignore", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve as () => void);
    child.once("error", reject as (e: Error) => void);
  });
  // Later errors (EPIPE after the child exits) must not crash the process.
  child.stdin?.on("error", () => {});
  child.once("error", (() => {}) as () => void);
  const tail = { text: "" };
  void collectTail(child.stderr, tail);
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", ((code: number | null) => resolve(code)) as () => void);
  });
  return {
    stdout: options.stdout ? child.stdout : null,
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        if (!child.stdin) return resolve();
        child.stdin.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
    },
    async closeStdin() {
      child.stdin?.end();
    },
    kill() {
      if (child.exitCode === null) child.kill();
    },
    exited,
    stderrTail: () => tail.text,
  };
};

/**
 * The spawner for the current runtime: `Bun.spawn`, `Deno.Command` or
 * `node:child_process`.
 *
 * @throws If the runtime cannot start processes (Cloudflare Workers, browsers).
 */
export function defaultSpawner(): ProcessSpawner {
  const g = globalThis as {
    Bun?: unknown;
    Deno?: unknown;
    process?: { versions?: { node?: string } };
  };
  if (g.Bun) return spawnWithBun;
  if (g.Deno) return spawnWithDeno;
  if (g.process?.versions?.node) return spawnWithNode;
  throw new Error(
    "The local audio transport spawns sox or ffmpeg, so it needs Node, Bun or Deno; this runtime cannot start processes",
  );
}
