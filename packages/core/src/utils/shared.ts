// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/shared.py

/**
 * Decorators for operations on a resource shared by several owners.
 *
 * An input and an output transport share a single client, so both set it up,
 * both join its room, and both tear it down. Processors are set up and cleaned
 * up concurrently, so those calls overlap.
 *
 * Decorate the paired operations with `acquires` and `releases` and the work
 * runs once: the first owner to acquire runs the body while the rest wait for
 * it, and only the last owner to release runs the undo.
 *
 * The returned decorators work both as standard (TC39) method decorators and
 * as plain functions, since runtimes that strip types (Node) do not run
 * decorator syntax:
 *
 * @example
 * class Client {
 *   async setup(): Promise<void> { ... }
 *   async cleanup(): Promise<void> { ... }
 *   static {
 *     this.prototype.setup = acquires("client")(this.prototype.setup);
 *     this.prototype.cleanup = releases("client")(this.prototype.cleanup);
 *   }
 * }
 */

import { Lock } from "@pipecat-ts/asyncio";

/** How many owners hold a resource, and the lock serializing them. */
class SharedResource {
  owners = 0;
  lock = new Lock();
  // What acquiring raised, if it did, so later owners fail the same way.
  error: unknown = null;
  hasError = false;
}

// Upstream keeps the state in the instance's `__dict__`; a WeakMap keeps it
// per instance without touching the object.
const RESOURCES = new WeakMap<object, Map<string, SharedResource>>();

/**
 * Get the named resource's state, creating it on first use.
 *
 * The state lives with the instance so a class doesn't need to initialize it,
 * and so two instances of the same class count their owners separately.
 */
function sharedResource(obj: object, name: string): SharedResource {
  let resources = RESOURCES.get(obj);
  if (!resources) {
    resources = new Map();
    RESOURCES.set(obj, resources);
  }
  let resource = resources.get(name);
  if (!resource) {
    resource = new SharedResource();
    resources.set(name, resource);
  }
  return resource;
}

type AsyncMethod<This, A extends unknown[], T> = (this: This, ...args: A) => Promise<T>;

/**
 * Run the decorated method for the first owner to acquire `name`.
 *
 * Owners that arrive while the first is still running wait for it to finish,
 * so no caller continues against a half-built resource. Later owners return
 * `null` without running the method again.
 *
 * A method that throws leaves the resource unbuilt, and every owner of it is
 * told: the error is re-thrown to each one that arrives later, rather than the
 * method being attempted again. So the owners of a resource share its verdict,
 * and a pair of processors sharing a client either both come up or both fail.
 *
 * Note: the lock is not reentrant, so a method must not call another method
 * that acquires the same resource.
 *
 * @param name The resource being acquired. Names are per instance, so paired
 *   operations on the same object (e.g. `setup`/`cleanup` and `join`/`leave`)
 *   count their owners separately.
 */
export function acquires(name: string) {
  return function decorator<This extends object, A extends unknown[], T>(
    func: AsyncMethod<This, A, T>,
    _context?: unknown,
  ): AsyncMethod<This, A, T | null> {
    return async function wrapper(this: This, ...args: A): Promise<T | null> {
      const resource = sharedResource(this, name);
      return await resource.lock.run(async () => {
        if (resource.hasError) {
          throw resource.error;
        }
        resource.owners += 1;
        if (resource.owners === 1) {
          try {
            return await func.apply(this, args);
          } catch (e) {
            // Nothing was built, so nothing is owned and nothing is released
            // later. Upstream catches BaseException, so cancellation counts too.
            resource.owners -= 1;
            resource.error = e;
            resource.hasError = true;
            throw e;
          }
        }
        return null;
      });
    };
  };
}

/**
 * Run the decorated method for the last owner to release `name`.
 *
 * Every other owner returns `null`, as does a release that no acquire
 * matched.
 *
 * Note: the lock is not reentrant, so a method must not call another method
 * that releases the same resource.
 *
 * @param name The resource being released, matching the `acquires` name.
 */
export function releases(name: string) {
  return function decorator<This extends object, A extends unknown[], T>(
    func: AsyncMethod<This, A, T>,
    _context?: unknown,
  ): AsyncMethod<This, A, T | null> {
    return async function wrapper(this: This, ...args: A): Promise<T | null> {
      const resource = sharedResource(this, name);
      return await resource.lock.run(async () => {
        if (resource.owners === 0) {
          return null;
        }
        resource.owners -= 1;
        if (resource.owners === 0) {
          return await func.apply(this, args);
        }
        return null;
      });
    };
  };
}
