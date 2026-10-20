// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// WebSocket end-to-end runs across runtimes. A server (the echo bot of
// apps.ts behind SingleClientWebsocketServerTransport on Bun, Node `ws` or
// Deno; behind FastAPIWebsocketTransport on a WebSocketPair in a workerd
// Worker or Durable Object; or upstream Pipecat's server) and a client
// (WebsocketClientTransport on Bun, Node or Deno, with the global WebSocket;
// or upstream Pipecat's client) exchange audio and transport messages with
// the protobuf serializer.
//
//   bun packages/transport-websocket/test/e2e/run.ts [--server bun,node,...] [--client bun,...]
//
// A runtime whose binary is missing is skipped. Upstream Python runs only
// when PIPEDOG_UPSTREAM_PYTHON points to a Python with pipecat installed.
// packages/transport-websocket/test/e2e_runtimes.test.ts runs this matrix.

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { BunPlugin, Subprocess } from "bun";

export const ROOT = resolve(import.meta.dir, "../../../..");
const HERE = import.meta.dir;
// Under the transport package's node_modules, so a bundle's `import("ws")`
// finds its `ws` dev dependency as an installed app would.
const OUT = join(ROOT, "packages/transport-websocket/node_modules/.cache/pipedog-e2e");
/** A compatibility date workerd 1.20261005.1 supports. */
const COMPATIBILITY_DATE = "2026-10-01";

export const SERVERS = [
  "bun",
  "node",
  "deno",
  "hono-bun",
  "hono-node",
  "hono-deno",
  "workerd",
  "workerd-do",
  "upstream",
] as const;
export const CLIENTS = ["bun", "node", "deno", "workerd", "upstream"] as const;
export type ServerKind = (typeof SERVERS)[number];
export type ClientKind = (typeof CLIENTS)[number];

export interface E2EResult {
  ok: boolean;
  detail: string;
  result?: unknown;
}

function which(bin: string): string | null {
  return Bun.which(bin);
}

function workerdBin(): string | null {
  const bin = join(ROOT, "node_modules", ".bin", "workerd");
  return existsSync(bin) ? bin : null;
}

function upstreamPython(): string | null {
  const py = process.env.PIPEDOG_UPSTREAM_PYTHON;
  return py && existsSync(py) ? py : null;
}

/** Why a server or client can't run here, or null if it can. */
export function unavailable(kind: ServerKind | ClientKind): string | null {
  switch (kind) {
    case "bun":
    case "hono-bun":
      return null;
    case "node":
    case "hono-node":
      return which("node") ? null : "node not on PATH";
    case "deno":
    case "hono-deno":
      return which("deno") ? null : "deno not on PATH";
    case "workerd":
    case "workerd-do":
      return workerdBin() ? null : "workerd not installed";
    case "upstream":
      return upstreamPython() ? null : "PIPEDOG_UPSTREAM_PYTHON not set";
  }
}

const bundles = new Map<string, Promise<string>>();
/** The Wasm modules of the workerd bundle, as workerd module names. */
const workerdWasm: string[] = [];

/**
 * Turns `.wasm` imports into workerd Wasm modules copied next to the bundle
 * (workerd can't compile Wasm from bytes), as tools/compat does.
 */
function wasmModulesPlugin(dir: string, modules: string[]): BunPlugin {
  return {
    name: "workerd-wasm-modules",
    setup(build) {
      build.onResolve({ filter: /\.wasm(\?module)?$/ }, (args) => {
        const spec = args.path.replace(/\?module$/, "");
        const abs = Bun.resolveSync(spec, dirname(args.importer));
        const name = `wasm/${modules.length}-${basename(abs)}`;
        mkdirSync(join(dir, "wasm"), { recursive: true });
        copyFileSync(abs, join(dir, name));
        modules.push(name);
        return { path: `./${name}`, external: true };
      });
    },
  };
}

type Entry = "entry.ts" | "hono_entry.ts" | "worker.ts";

/** Bundle an entry once per target (Node and Deno can't resolve the workspace's TS sources). */
function bundle(target: "node" | "deno" | "workerd", entry: Entry = "entry.ts"): Promise<string> {
  const key = `${target}-${entry.replace(/\.ts$/, "")}`;
  let p = bundles.get(key);
  if (!p) {
    p = (async () => {
      const dir = join(OUT, key);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const out = await Bun.build({
        entrypoints: [join(HERE, entry)],
        outdir: dir,
        naming: "bundle.mjs",
        target: target === "node" ? "node" : "browser",
        format: "esm",
        conditions:
          target === "deno"
            ? ["deno"]
            : target === "workerd"
              ? ["workerd", "worker", "browser"]
              : [],
        // The Hono entry imports its Node adapter only on Node.
        external: ["node:*", "cloudflare:*", ...(target === "deno" ? ["@hono/node-*"] : [])],
        throw: false,
        plugins: target === "workerd" ? [wasmModulesPlugin(dir, workerdWasm)] : [],
      });
      if (!out.success) {
        throw new Error(`bundling ${key} failed:\n${out.logs.map((l) => l.message).join("\n")}`);
      }
      return join(dir, "bundle.mjs");
    })();
    bundles.set(key, p);
  }
  return p;
}

export function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

/** Collects a process's output and resolves when a line matches. */
class Proc {
  readonly proc: Subprocess<"ignore", "pipe", "pipe">;
  output = "";
  #waiters: { re: RegExp; resolve: (m: RegExpMatchArray) => void }[] = [];
  readonly done: Promise<number>;

  constructor(cmd: string[], env: Record<string, string> = {}, cwd = ROOT) {
    this.proc = Bun.spawn(cmd, {
      cwd,
      env: { ...process.env, PIPEDOG_LOG_LEVEL: "WARNING", ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        this.output += decoder.decode(chunk, { stream: true });
        this.#check();
      }
    };
    const pumped = Promise.all([pump(this.proc.stdout), pump(this.proc.stderr)]);
    this.done = pumped.then(() => this.proc.exited);
  }

  /** Add output from outside the process (e.g. a Worker's HTTP answer). */
  append(text: string): void {
    this.output += text;
    this.#check();
  }

  #check(): void {
    this.#waiters = this.#waiters.filter((w) => {
      const m = this.output.match(w.re);
      if (m) w.resolve(m);
      return !m;
    });
  }

  waitFor(re: RegExp, timeoutMs: number): Promise<RegExpMatchArray | null> {
    return new Promise((resolve) => {
      const m = this.output.match(re);
      if (m) return resolve(m);
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.#waiters.push({
        re,
        resolve: (x) => {
          clearTimeout(timer);
          resolve(x);
        },
      });
      void this.done.then(() => {
        clearTimeout(timer);
        resolve(this.output.match(re));
      });
    });
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {
      // Already gone.
    }
  }
}

async function processCommand(
  runtime: "bun" | "node" | "deno",
  env: Record<string, string>,
  entry: Entry = "entry.ts",
): Promise<{ cmd: string[]; env: Record<string, string> }> {
  switch (runtime) {
    case "bun":
      return { cmd: [process.execPath, "run", join(HERE, entry)], env };
    case "node":
      return { cmd: ["node", await bundle("node", entry)], env };
    case "deno":
      return {
        cmd: ["deno", "run", "-A", "--no-config", "--no-lock", await bundle("deno", entry)],
        env,
      };
  }
}

function workerdConfig(port: number): string {
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .echoWorker),
    # Lets the client end reach servers on 127.0.0.1.
    (name = "net", network = (allow = ["public", "private", "local"])),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);

const echoWorker :Workerd.Worker = (
  modules = [
    ${[
      '(name = "bundle.mjs", esModule = embed "bundle.mjs")',
      ...workerdWasm.map((w) => `(name = ${JSON.stringify(w)}, wasm = embed ${JSON.stringify(w)})`),
    ].join(",\n    ")}
  ],
  compatibilityDate = "${COMPATIBILITY_DATE}",
  globalOutbound = "net",
  durableObjectNamespaces = [(className = "EchoBot", uniqueKey = "pipedog-e2e-echo")],
  durableObjectStorage = (inMemory = void),
  bindings = [(name = "ECHO", durableObjectNamespace = "EchoBot")],
);
`;
}

/** Start workerd with the e2e Worker on `port` and wait until it answers. */
async function startWorkerd(port: number, timeoutMs: number): Promise<Proc> {
  const bundlePath = await bundle("workerd", "worker.ts");
  const dir = join(bundlePath, "..");
  const config = join(dir, `config-${port}.capnp`);
  await Bun.write(config, workerdConfig(port));
  const proc = new Proc([workerdBin() as string, "serve", config], {}, dir);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) break;
    } catch {
      await Bun.sleep(50);
    }
  }
  return proc;
}

interface RunningServer {
  uri: string;
  proc: Proc;
  /** Whether the server exits by itself once its client leaves. */
  exitsAfterClient: boolean;
}

async function startServer(
  kind: ServerKind,
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<RunningServer> {
  const port = freePort();
  if (kind === "workerd" || kind === "workerd-do") {
    const proc = await startWorkerd(port, timeoutMs);
    const path = kind === "workerd-do" ? "/do" : "/";
    return { uri: `ws://127.0.0.1:${port}${path}`, proc, exitsAfterClient: false };
  }
  let proc: Proc;
  let path = "";
  if (kind === "hono-bun" || kind === "hono-node" || kind === "hono-deno") {
    const runtime = kind.slice("hono-".length) as "bun" | "node" | "deno";
    const { cmd, env } = await processCommand(runtime, { E2E_PORT: `${port}` }, "hono_entry.ts");
    proc = new Proc(cmd, env);
    path = "/ws";
  } else if (kind === "upstream") {
    proc = new Proc([upstreamPython() as string, join(HERE, "upstream.py"), "server", `${port}`]);
  } else {
    const { cmd, env } = await processCommand(kind, {
      E2E_ROLE: "server",
      E2E_PORT: `${port}`,
      ...extraEnv,
    });
    proc = new Proc(cmd, env);
  }
  const ready = await proc.waitFor(/E2E_READY/, timeoutMs);
  if (!ready) {
    proc.kill();
    throw new Error(`${kind} server did not start:\n${proc.output}`);
  }
  return { uri: `ws://127.0.0.1:${port}${path}`, proc, exitsAfterClient: true };
}

async function startClient(
  kind: ClientKind,
  uri: string,
  extraEnv: Record<string, string> = {},
): Promise<Proc> {
  if (kind === "upstream") {
    return new Proc([upstreamPython() as string, join(HERE, "upstream.py"), "client", uri]);
  }
  if (kind === "workerd") {
    // The Worker answers with the result; print it as the process clients do.
    const port = freePort();
    const proc = await startWorkerd(port, 20_000);
    void fetch(`http://127.0.0.1:${port}/client?uri=${encodeURIComponent(uri)}`)
      .then((res) => res.text())
      .then((text) => {
        proc.append(`E2E_RESULT ${text}\n`);
        proc.kill();
      })
      .catch((e) => {
        proc.append(`E2E_ERROR ${e}\n`);
        proc.kill();
      });
    return proc;
  }
  const { cmd, env } = await processCommand(kind, {
    E2E_ROLE: "client",
    E2E_URI: uri,
    ...extraEnv,
  });
  return new Proc(cmd, env);
}

/** Run one server/client pair. */
export async function runPair(
  server: ServerKind,
  client: ClientKind,
  timeoutMs = 20_000,
): Promise<E2EResult> {
  let srv: RunningServer | null = null;
  let cli: Proc | null = null;
  try {
    srv = await startServer(server, timeoutMs);
    cli = await startClient(client, srv.uri);
    const m = await cli.waitFor(/E2E_RESULT ([^\n]*)\n/, timeoutMs);
    const code = await Promise.race([cli.done, Bun.sleep(timeoutMs).then(() => null)]);
    const result = m ? JSON.parse(m[1] as string) : undefined;
    // workerd keeps serving after the Worker answered; it is killed, not exited.
    let ok = !!result?.ok && (client === "workerd" || code === 0);
    let detail = "";
    if (srv.exitsAfterClient) {
      // The server's pipeline must end cleanly once its client is gone.
      const srvCode = await Promise.race([srv.proc.done, Bun.sleep(timeoutMs).then(() => null)]);
      if (srvCode !== 0) {
        ok = false;
        detail += `server exit code ${srvCode}\n`;
      }
    }
    if (/E2E_ERROR/.test(srv.proc.output)) {
      ok = false;
      detail += "server reported an error\n";
    }
    if (!ok) {
      detail += `client exit ${code}\n--- client output\n${cli.output}\n--- server output\n${srv.proc.output}`;
    }
    return { ok, detail, result };
  } catch (e) {
    return {
      ok: false,
      detail: `${e instanceof Error ? e.message : String(e)}\n${cli?.output ?? ""}\n${srv?.proc.output ?? ""}`,
    };
  } finally {
    cli?.kill();
    srv?.proc.kill();
  }
}

/**
 * The origin check of `SingleClientWebsocketServerTransport` on a runtime's
 * server: a client with a disallowed Origin can't connect, an allowed one can.
 */
export async function runOriginCheck(
  server: "bun" | "node" | "deno",
  timeoutMs = 20_000,
): Promise<E2EResult> {
  const allowed = "https://allowed.example";
  let srv: RunningServer | null = null;
  const procs: Proc[] = [];
  try {
    srv = await startServer(server, timeoutMs, { E2E_ALLOWED_ORIGINS: allowed });
    const rejected = await startClient("bun", srv.uri, { E2E_ORIGIN: "https://evil.example" });
    procs.push(rejected);
    const r1 = await rejected.waitFor(/E2E_RESULT ([^\n]*)\n/, timeoutMs);
    const rejectedResult = r1 ? JSON.parse(r1[1] as string) : undefined;
    const accepted = await startClient("bun", srv.uri, { E2E_ORIGIN: allowed });
    procs.push(accepted);
    const r2 = await accepted.waitFor(/E2E_RESULT ([^\n]*)\n/, timeoutMs);
    const acceptedResult = r2 ? JSON.parse(r2[1] as string) : undefined;
    const ok = rejectedResult?.audioReceived === 0 && acceptedResult?.ok === true;
    return {
      ok,
      detail: ok
        ? ""
        : `rejected client:\n${rejected.output}\naccepted client:\n${accepted.output}\nserver:\n${srv.proc.output}`,
      result: { rejected: rejectedResult, accepted: acceptedResult },
    };
  } catch (e) {
    return { ok: false, detail: `${e instanceof Error ? e.message : String(e)}` };
  } finally {
    for (const p of procs) p.kill();
    srv?.proc.kill();
  }
}

if (import.meta.main) {
  const { parseArgs } = await import("node:util");
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      server: { type: "string", multiple: true },
      client: { type: "string", multiple: true },
      verbose: { type: "boolean", short: "v", default: false },
    },
  });
  const split = (xs: string[] | undefined) => (xs ?? []).flatMap((x) => x.split(","));
  const servers = (split(values.server).length ? split(values.server) : SERVERS) as ServerKind[];
  const clients = (split(values.client).length ? split(values.client) : CLIENTS) as ClientKind[];
  let failures = 0;
  const pairs: [ServerKind, ClientKind][] = [];
  for (const s of servers)
    for (const c of clients) if (!(s === "upstream" && c === "upstream")) pairs.push([s, c]);
  const results = await Promise.all(
    pairs.map(async ([s, c]) => {
      const skip = unavailable(s) ?? unavailable(c);
      if (skip) return { s, c, line: `skip  ${s} <- ${c}: ${skip}` };
      const t0 = performance.now();
      const r = await runPair(s, c);
      if (!r.ok) failures++;
      const ms = Math.round(performance.now() - t0);
      return {
        s,
        c,
        line: `${r.ok ? "ok  " : "FAIL"}  ${s} <- ${c} (${ms} ms)${!r.ok || values.verbose ? `\n${r.detail}` : ""}`,
      };
    }),
  );
  for (const r of results) console.log(r.line);
  process.exit(failures ? 1 : 0);
}
