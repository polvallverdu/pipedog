// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/worker_ready_decorator.py

/** Decorator for marking methods as worker-ready handlers. */

type AnyFn = (...args: any[]) => any;

/** A function marked by `workerReady()`. */
export type WorkerReadyHandler<F extends AnyFn = AnyFn> = F & { workerReadyName: string };

/**
 * Mark a method as a handler for a specific worker becoming ready.
 *
 * Decorated methods are automatically collected by `BaseWorker` at
 * initialization. When the worker starts, it calls `watchWorkers` for the
 * decorated handlers. When a watched worker registers, the decorated method
 * is called with the ready data.
 *
 * The returned decorator works both as a standard (TC39) method decorator and
 * as a plain function, since runtimes that strip types (Node) do not run
 * decorator syntax.
 *
 * @example
 * class MyWorker extends BaseWorker {
 *   async onGreeterReady(data: WorkerReadyData): Promise<void> {
 *     await this.activateWorker("greeter", { args: ... });
 *   }
 *   static {
 *     workerReady({ name: "greeter" })(this.prototype.onGreeterReady);
 *   }
 * }
 *
 * @param options.name The name of the worker to watch.
 */
export function workerReady(options: { name: string }) {
  const { name } = options;

  return function decorator<F extends AnyFn>(fn: F, _context?: unknown): F {
    (fn as WorkerReadyHandler<F>).workerReadyName = name;
    return fn;
  };
}

/**
 * Collect all `workerReady` decorated bound methods from an object.
 *
 * Walks the prototype chain from the object's own class up, so an override in
 * a subclass shadows the parent's method of the same name.
 *
 * @returns A map from worker name to the bound method.
 * @throws Error If two handlers watch the same worker name.
 */
export function _collectWorkerReadyHandlers(obj: object): Map<string, AnyFn> {
  const seen = new Set<string>();
  const handlers = new Map<string, AnyFn>();
  const handlerNames = new Map<string, string>();
  let proto: object | null = Object.getPrototypeOf(obj);
  while (proto !== null && proto !== Object.prototype) {
    for (const attrName of Object.getOwnPropertyNames(proto)) {
      if (seen.has(attrName)) {
        continue;
      }
      seen.add(attrName);
      const descriptor = Object.getOwnPropertyDescriptor(proto, attrName);
      // Skip accessors so collecting never runs a getter.
      const val = descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (typeof val === "function" && typeof val.workerReadyName === "string") {
        const workerName: string = val.workerReadyName;
        if (handlers.has(workerName)) {
          const existing = handlerNames.get(workerName);
          throw new Error(
            `Duplicate @worker_ready handler for '${workerName}': ` +
              `'${attrName}' conflicts with '${existing}'`,
          );
        }
        const method = (obj as Record<string, AnyFn>)[attrName] as AnyFn;
        handlers.set(workerName, method.bind(obj));
        handlerNames.set(workerName, attrName);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return handlers;
}
