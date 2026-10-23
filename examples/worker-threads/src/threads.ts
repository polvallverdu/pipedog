// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * One message port for worker threads on Bun, Node and Deno.
 *
 * Bun and Deno have the web `Worker` (a module worker; `postMessage` and
 * `message` events); Node has `worker_threads` (`Worker`, `parentPort`, Node
 * events). `spawnThread()` and `parentThread()` give both sides the same small
 * interface, with transferable `ArrayBuffer`s, so the rest of the code doesn't
 * care which runtime it is on.
 */

const g = globalThis as any;

export interface ThreadPort {
  /** Posts a message; buffers in `transfer` move to the other thread instead of being copied. */
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  /** Adds a message listener; returns a function that removes it. */
  addListener(listener: (message: any) => void): () => void;
  /** Called when the thread fails (the worker side never reports this). */
  onError(listener: (error: Error) => void): void;
  /** Stops the thread (on the worker side: closes the port); resolves once it has stopped. */
  terminate(): Promise<void>;
}

/** Node's event-emitter side of `worker_threads.Worker` (typed as the web `Worker` under Bun's types). */
interface NodeEvents {
  on(event: string, listener: (value: any) => void): void;
  off(event: string, listener: (value: any) => void): void;
}

/** Whether this code runs in a worker thread. */
export async function isWorkerThread(): Promise<boolean> {
  if (g.Bun) return !g.Bun.isMainThread;
  if (g.Deno) return typeof g.WorkerGlobalScope !== "undefined" && g instanceof g.WorkerGlobalScope;
  const wt = await import("node:worker_threads");
  return !wt.isMainThread;
}

/** Starts the module at `url` in a new worker thread. */
export async function spawnThread(url: URL | string): Promise<ThreadPort> {
  if (g.Bun || g.Deno) {
    const worker = new Worker(url, { type: "module" });
    return {
      postMessage: (message, transfer = []) => worker.postMessage(message, transfer),
      addListener: (listener) => {
        const handler = (e: MessageEvent) => listener(e.data);
        worker.addEventListener("message", handler);
        return () => worker.removeEventListener("message", handler);
      },
      onError: (listener) => {
        worker.addEventListener("error", (e: ErrorEvent) => {
          e.preventDefault?.();
          listener(e.error instanceof Error ? e.error : new Error(String(e.message)));
        });
      },
      terminate: async () => worker.terminate(),
    };
  }
  const { Worker: NodeWorker } = await import("node:worker_threads");
  const worker = new NodeWorker(
    typeof url === "string" ? new URL(url) : url,
  ) as unknown as NodeEvents & {
    postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
    terminate(): Promise<number>;
  };
  return {
    postMessage: (message, transfer = []) => worker.postMessage(message, transfer),
    addListener: (listener) => {
      worker.on("message", listener);
      return () => worker.off("message", listener);
    },
    onError: (listener) => {
      worker.on("error", listener);
    },
    terminate: async () => {
      await worker.terminate();
    },
  };
}

/** The port to the thread that started this one, or `null` on the main thread. */
export async function parentThread(): Promise<ThreadPort | null> {
  if (!(await isWorkerThread())) return null;
  if (g.Bun || g.Deno) {
    return {
      postMessage: (message, transfer = []) => g.postMessage(message, transfer),
      addListener: (listener) => {
        const handler = (e: MessageEvent) => listener(e.data);
        g.addEventListener("message", handler);
        return () => g.removeEventListener("message", handler);
      },
      onError: () => {},
      terminate: async () => g.close(),
    };
  }
  const { parentPort } = await import("node:worker_threads");
  const port = parentPort!;
  return {
    postMessage: (message, transfer = []) => port.postMessage(message, transfer),
    addListener: (listener) => {
      port.on("message", listener);
      return () => port.off("message", listener);
    },
    onError: () => {},
    terminate: async () => port.close(),
  };
}

/** Logical cores: a sensible number of worker threads. */
export function coreCount(): number {
  return g.navigator?.hardwareConcurrency ?? 1;
}
