// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/startup.py

/**
 * Shared loader for `PIPECAT_SETUP_FILES` hooks.
 *
 * Each file listed in the `PIPECAT_SETUP_FILES` environment variable (separated
 * by the platform path separator) may export one or both of the following
 * async functions:
 *
 * - `setup_worker_runner(runner)` — invoked once per `WorkerRunner` before its
 *   spawned workers start.
 * - `setup_pipeline_worker(worker)` — invoked once per `PipelineWorker` while
 *   the worker sets up its pipeline.
 *
 * The camelCase spelling (`setupWorkerRunner`, `setupPipelineWorker`) is
 * accepted too.
 *
 * Setup files are imported at most once per process; module-level state (for
 * example, a shared debugger instance referenced by both hooks) is preserved
 * across hook invocations.
 *
 * Porting notes: setup files are ES modules loaded with dynamic `import()`, so
 * this works where the runtime can import from the file system (Bun, Node,
 * Deno). On runtimes without a file system or environment variables
 * (Cloudflare Workers) `PIPECAT_SETUP_FILES` is simply unset. The deprecated
 * `setup_pipeline_task` fallback name is not ported.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "./logger.ts";

type SetupModule = Record<string, unknown>;

const moduleCache = new Map<string, SetupModule>();

interface ProcessLike {
  env?: Record<string, string | undefined>;
  platform?: string;
  cwd?: () => string;
}

function proc(): ProcessLike | undefined {
  return (globalThis as { process?: ProcessLike }).process;
}

function pathSeparator(): string {
  return proc()?.platform === "win32" ? ";" : ":";
}

/** Resolve a setup file path to an absolute path (URLs are kept as-is). */
function resolvePath(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return new URL(path).href;
  const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(path);
  if (path.startsWith("/") || isWindowsAbsolute) {
    return fileUrlToPath(
      new URL(`file://${isWindowsAbsolute ? "/" : ""}${path.replaceAll("\\", "/")}`),
    );
  }
  const cwd = (proc()?.cwd?.() ?? "/").replaceAll("\\", "/");
  const base = cwd.startsWith("/") ? `file://${cwd}/` : `file:///${cwd}/`;
  return fileUrlToPath(new URL(path.replaceAll("\\", "/"), base));
}

/** Convert a normalized `file:` URL back to a file system path. */
function fileUrlToPath(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return /^\/[a-zA-Z]:\//.test(path) ? path.slice(1) : path;
}

/** Convert a resolved setup file path to a URL usable with `import()`. */
function importUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  const url = new URL("file://");
  url.pathname = path.startsWith("/") ? path : `/${path}`;
  return url.href;
}

/** Absolute paths of the files listed in `PIPECAT_SETUP_FILES`. */
export function _setupFilePaths(): string[] {
  return (proc()?.env?.PIPECAT_SETUP_FILES ?? "")
    .split(pathSeparator())
    .filter((f) => f)
    .map((f) => resolvePath(f));
}

async function loadModule(path: string): Promise<SetupModule | null> {
  const cached = moduleCache.get(path);
  if (cached !== undefined) {
    return cached;
  }

  let module: SetupModule;
  try {
    module = (await import(/* @vite-ignore */ importUrl(path))) as SetupModule;
  } catch (e) {
    rethrowIfCancelled(e);
    logger.error(`error loading setup file ${path}: ${e instanceof Error ? e.message : e}`);
    return null;
  }

  moduleCache.set(path, module);
  return module;
}

function camelCase(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export interface RunSetupHookOptions {
  /** Object passed to the hook function. */
  target: unknown;
  /** Name of the async function to call in each setup file (e.g. `"setup_worker_runner"`). */
  functionName: string;
}

/**
 * Run `functionName(target)` from every `PIPECAT_SETUP_FILES` module.
 *
 * @param options.target Object passed to the hook function.
 * @param options.functionName Name of the async function to call in each
 *   setup file. Its camelCase spelling is accepted too.
 */
export async function runSetupHook(options: RunSetupHookOptions): Promise<void> {
  const { target, functionName } = options;
  for (const path of _setupFilePaths()) {
    const module = await loadModule(path);
    if (module === null) {
      continue;
    }
    try {
      const fn = module[functionName] ?? module[camelCase(functionName)];
      if (typeof fn === "function") {
        logger.debug(`${target} running ${functionName} from ${path}`);
        await fn(target);
      } else {
        logger.warning(`${target} setup file ${path} has no ${functionName} function`);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(
        `${target} error running ${functionName} from ${path}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
}
