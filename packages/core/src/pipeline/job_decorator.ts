// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/job_decorator.py

/** Decorator for marking worker methods as job handlers. */

type AnyFn = (...args: any[]) => any;

/** A function marked by `job()`. */
export type JobHandler<F extends AnyFn = AnyFn> = F & {
  isJobHandler: true;
  jobName: string;
  jobSequential: boolean;
};

/**
 * Mark a worker method as a job handler.
 *
 * Decorated methods are automatically collected by `BaseWorker` at
 * initialization and dispatched when matching job requests arrive. Each
 * request runs in its own task so the bus message loop is never blocked.
 *
 * The returned decorator works both as a standard (TC39) method decorator and
 * as a plain function, since runtimes that strip types (Node) do not run
 * decorator syntax.
 *
 * @example
 * class MyWorker extends BaseWorker {
 *   async onResearch(message: BusJobRequestMessage): Promise<void> { ... }
 *   async onWrite(message: BusJobRequestMessage): Promise<void> { ... }
 *   static {
 *     job({ name: "research" })(this.prototype.onResearch);
 *     job({ name: "write", sequential: true })(this.prototype.onWrite);
 *   }
 * }
 *
 * @param options.name Job name to match. The handler only receives requests
 *   with a matching name.
 * @param options.sequential When true, requests with this name run one at a
 *   time in FIFO order. Concurrent requests wait for the previous one to
 *   finish before running. When false (the default), multiple requests run
 *   concurrently. The wait time counts against the requester's timeout, so a
 *   slow predecessor can cause queued requests to time out before they start.
 */
export function job(options: { name: string; sequential?: boolean }) {
  const name = options.name;
  const sequential = options.sequential ?? false;

  return function decorator<F extends AnyFn>(fn: F, _context?: unknown): F {
    const handler = fn as JobHandler<F>;
    handler.isJobHandler = true;
    handler.jobName = name;
    handler.jobSequential = sequential;
    return fn;
  };
}

/**
 * Collect all `job` decorated bound methods from an object.
 *
 * Walks the prototype chain from the object's own class up, so an override in
 * a subclass shadows the parent's method of the same name.
 *
 * @returns A map from job name to the bound method. Each bound method keeps
 *   the `jobSequential` flag of the decorated function.
 * @throws Error If two handlers handle the same job name.
 */
export function _collectJobHandlers(obj: object): Map<string, AnyFn> {
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
      if (typeof val === "function" && val.isJobHandler === true) {
        const jobName: string = val.jobName;
        if (handlers.has(jobName)) {
          const existing = handlerNames.get(jobName);
          throw new Error(
            `Duplicate @job handler for '${jobName}': ` +
              `'${attrName}' conflicts with '${existing}'`,
          );
        }
        const method = (obj as Record<string, AnyFn>)[attrName] as AnyFn;
        // Python's bound method still exposes the function's attributes
        // (`handler.job_sequential`); copy them onto the bound function.
        const bound = method.bind(obj) as JobHandler;
        bound.isJobHandler = true;
        bound.jobName = jobName;
        bound.jobSequential = val.jobSequential;
        handlers.set(jobName, bound);
        handlerNames.set(jobName, attrName);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return handlers;
}
