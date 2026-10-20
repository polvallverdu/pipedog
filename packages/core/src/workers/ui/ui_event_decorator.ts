// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/workers/ui/ui_event_decorator.py

/** Decorator for marking worker methods as UI event handlers. */

type AnyFn = (...args: any[]) => any;

/** A function marked by `uiEvent()`. */
export type UIEventHandler<F extends AnyFn = AnyFn> = F & {
  isUiEventHandler: true;
  uiEventName: string;
};

/**
 * Mark a worker method as a handler for a named UI event.
 *
 * On `UIWorker` subclasses, decorated methods are automatically dispatched
 * when a `BusUIEventMessage` with a matching `name` arrives.
 *
 * The returned decorator works both as a standard (TC39) method decorator and
 * as a plain function, since runtimes that strip types (Node) do not run
 * decorator syntax.
 *
 * @example
 * class MyUIWorker extends UIWorker {
 *   async onNav(message: BusUIEventMessage): Promise<void> {
 *     const view = (message.payload as Record<string, unknown>).view;
 *     ...
 *   }
 *   static {
 *     uiEvent("nav_click")(this.prototype.onNav);
 *   }
 * }
 *
 * @param name The UI event name to match.
 */
export function uiEvent(name: string) {
  return function decorator<F extends AnyFn>(fn: F, _context?: unknown): F {
    const handler = fn as UIEventHandler<F>;
    handler.isUiEventHandler = true;
    handler.uiEventName = name;
    return fn;
  };
}

/**
 * Collect all `uiEvent` decorated bound methods from an object.
 *
 * Walks the prototype chain so that overridden methods in subclasses take
 * precedence over base-class definitions.
 *
 * @returns A map from event name to the bound method.
 * @throws Error If two handlers share the same event name.
 */
export function _collectUiEventHandlers(obj: object): Map<string, AnyFn> {
  const seen = new Set<string>();
  const handlers = new Map<string, AnyFn>();
  // event name -> defining method name, for errors
  const sourceNames = new Map<string, string>();
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
      if (typeof val === "function" && val.isUiEventHandler === true) {
        const eventName: string = val.uiEventName;
        if (handlers.has(eventName)) {
          throw new Error(
            `Duplicate @ui_event handler for '${eventName}': ` +
              `'${attrName}' conflicts with '${sourceNames.get(eventName)}'`,
          );
        }
        handlers.set(eventName, (val as AnyFn).bind(obj));
        sourceNames.set(eventName, attrName);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return handlers;
}
