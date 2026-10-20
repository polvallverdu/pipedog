// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Python multiple inheritance (`class C(A, B)`) maps to a class-factory mixin:
// `class C extends B(A)`. `defineMixin` brands every class the factory
// produces so `x instanceof B` keeps working like `isinstance(x, B)`.
//
//   export interface AudioRawFrame { audio: Uint8Array; ... }
//   export const AudioRawFrame = defineMixin("AudioRawFrame", <B extends Ctor>(Base: B) => {
//     abstract class AudioRawFrameMixin extends Base { ... }
//     return AudioRawFrameMixin;
//   });
//   export class OutputAudioRawFrame extends AudioRawFrame(DataFrame) { ... }
//   frame instanceof AudioRawFrame // true
//
// Constructors take one options object (Python's **kwargs), so a mixin reads
// its own keys from `args[0]` and forwards everything to `super(...args)`.

// biome-ignore lint/suspicious/noExplicitAny: mixin constructors must accept any arguments.
export type Ctor<T = object> = abstract new (...args: any[]) => T;

export type Mixin<F extends (base: Ctor) => Ctor, I> = F & {
  [Symbol.hasInstance](value: unknown): value is I;
};

export function defineMixin<I, F extends <B extends Ctor>(base: B) => Ctor>(
  name: string,
  factory: F,
): Mixin<F, I> {
  const brand = Symbol.for(`pipecat.mixin.${name}`);
  const apply = ((base: Ctor) => {
    const cls = factory(base);
    Object.defineProperty(cls.prototype, brand, { value: true });
    return cls;
  }) as unknown as F;
  Object.defineProperty(apply, "name", { value: name });
  Object.defineProperty(apply, Symbol.hasInstance, {
    value: (value: unknown) =>
      typeof value === "object" &&
      value !== null &&
      (value as Record<symbol, unknown>)[brand] === true,
  });
  return apply as Mixin<F, I>;
}

const virtualBases = new WeakMap<Function, Set<Function>>();

/**
 * Make `instanceof parent` true for instances of `child` without `child`
 * extending it, like Python's `ABC.register`. Use it when upstream inherits
 * from two concrete classes, e.g. `InputTextRawFrame(SystemFrame, TextFrame)`:
 * `class InputTextRawFrame extends SystemFrame` + `addVirtualBase(InputTextRawFrame, TextFrame)`.
 * The child must declare the parent's fields itself.
 */
export function addVirtualBase(child: Function, parent: Function): void {
  let children = virtualBases.get(parent);
  if (!children) {
    children = new Set();
    virtualBases.set(parent, children);
    Object.defineProperty(parent, Symbol.hasInstance, {
      value(this: Function, value: unknown): boolean {
        if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
        const registered = virtualBases.get(this);
        if (!registered) return false;
        for (const c of registered) {
          if (Function.prototype[Symbol.hasInstance].call(c, value)) return true;
        }
        return false;
      },
    });
  }
  children.add(child);
}
