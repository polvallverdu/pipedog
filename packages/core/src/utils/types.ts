// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/types.py

/**
 * Types shared across Pipecat, independent of any provider SDK.
 *
 * The `NOT_GIVEN` sentinel lives here so that settings, contexts and anything
 * else needing "this value was not provided" share one meaning. Provider SDKs
 * ship their own equivalents; those belong to the SDK and are translated at the
 * adapter boundary rather than used inside Pipecat.
 */

/**
 * Sentinel type meaning "this value was not provided".
 *
 * Distinct from `null`, which is a meaningful value in most of the places
 * this is used (typically "this service doesn't support this field").
 * `NOT_GIVEN` is the singleton instance; test for it with `isGiven()`
 * rather than comparing directly.
 *
 * DIVERGENCE: upstream makes the sentinel falsy (`__bool__` returns False) so
 * `value or default` treats a missing value as absent. JavaScript objects are
 * always truthy, so use `isGiven(value) ? value : fallback` instead.
 */
export class NotGiven {
  static #instance: NotGiven | null = null;

  /** Return the singleton instance, creating it on first use. */
  constructor() {
    if (NotGiven.#instance !== null) {
      // biome-ignore lint/correctness/noConstructorReturn: singleton, as upstream's __new__.
      return NotGiven.#instance;
    }
    NotGiven.#instance = this;
  }

  /** Return the sentinel's name. */
  toString(): string {
    return "NOT_GIVEN";
  }

  toJSON(): string {
    return "NOT_GIVEN";
  }
}

/** Singleton sentinel meaning "this value was not provided". */
export const NOT_GIVEN: NotGiven = new NotGiven();

/**
 * Check whether a value was explicitly provided.
 *
 * Also acts as a type guard: inside a true branch, the value is narrowed to
 * exclude `NotGiven` (e.g. `string | null | NotGiven` becomes `string | null`).
 *
 * @example
 * if (isGiven(delta.voice)) {
 *   // caller wants to change the voice
 * }
 *
 * @param value The value to check.
 * @returns `true` if `value` is anything other than `NOT_GIVEN`.
 */
export function isGiven<T>(value: T | NotGiven): value is T {
  return !(value instanceof NotGiven);
}

/**
 * Extract a value that must have been provided.
 *
 * Intended for reads where `NOT_GIVEN` should never appear, such as a
 * store-mode settings object (see `services/settings`). Narrows away
 * `NotGiven` at the type level and throws at runtime if that invariant is
 * violated.
 *
 * @example
 * const resolvedModel = assertGiven(this._settings.model); // narrowed string | null
 *
 * @param value The value to extract.
 * @returns The value, narrowed to exclude `NotGiven`.
 * @throws Error If `value` is `NOT_GIVEN` (upstream: RuntimeError).
 */
export function assertGiven<T>(value: T | NotGiven): T {
  if (!isGiven(value)) {
    throw new Error("Expected a value, got NOT_GIVEN");
  }
  return value;
}

/**
 * Extract a value that must have been provided and must not be empty.
 *
 * Like `assertGiven()`, but also rejects `null` (and `undefined`) and the
 * empty string, which is what an unset or blank environment variable
 * produces. Use it for settings a service cannot work without, such as a
 * local model or voice that no provider will validate on its behalf.
 *
 * @example
 * const voice = requireGiven(this._settings.voice, "Piper TTS voice"); // narrowed string
 *
 * @param value The value to extract.
 * @param what How to name the value in the error, e.g. `"Piper TTS voice"`.
 * @returns The value, narrowed to exclude `NotGiven` and `null`.
 * @throws Error If `value` is `NOT_GIVEN` (upstream: RuntimeError).
 * @throws Error If `value` is `null` or an empty string (upstream: ValueError).
 */
export function requireGiven<T>(value: T | null | undefined | NotGiven, what: string): T {
  const given = assertGiven(value);
  if (given === null || given === undefined || (given as unknown) === "") {
    throw new Error(`${what} must be specified`);
  }
  return given;
}
