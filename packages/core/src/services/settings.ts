// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/settings.py

/**
 * Settings infrastructure for Pipecat AI services.
 *
 * Each service type has a settings class (`LLMSettings`, `TTSSettings`,
 * `STTSettings`, or a service-specific subclass). The same class is used in
 * two distinct modes:
 *
 * **Store mode** — the service's `this._settings` object that holds the full
 * current state. Every field must have a real value; `NOT_GIVEN` is never
 * valid here. Services that don't support an inherited field should set it to
 * `null`. `validateComplete()` (called automatically in `AIService.start()`)
 * enforces this invariant.
 *
 * **Delta mode** — a sparse update object carried by an
 * `*UpdateSettingsFrame`. Only the fields the caller wants to change are set;
 * all others remain at their default of `NOT_GIVEN`. `applyUpdate()` merges a
 * delta into a store, skipping any `NOT_GIVEN` fields.
 *
 * Key helpers:
 *
 * - `NOT_GIVEN` / `isGiven()` — sentinel and check for "field not provided
 *   in this delta".
 * - `applyUpdate(delta)` — merge a delta into a store, returning changed
 *   fields.
 * - `fromMapping(dict)` — build a delta from a plain dict.
 * - `validateComplete()` — assert that a store has no `NOT_GIVEN` fields.
 * - `extra` dict — overflow for service-specific keys that don't map to a
 *   declared field.
 *
 * Porting notes:
 * - Python dataclass fields are class fields. `dataclasses.fields()` is the
 *   instance's own enumerable keys (declaration order, base class first).
 * - With `useDefineForClassFields`, a subclass's field initializers run after
 *   the base constructor, so every settings subclass that declares fields
 *   must end its constructor with `this._assignOptions(options)`:
 *
 *   ```ts
 *   export class MySettings extends LLMSettings {
 *     voice: string | null | NotGiven = NOT_GIVEN;
 *     constructor(options: MySettingsOptions = {}) {
 *       super(options);
 *       this._assignOptions(options);
 *     }
 *   }
 *   ```
 * - An option left `undefined` stays `NOT_GIVEN`; `null` is a real value.
 */

import type { Language } from "../transcriptions/language.ts";
import type { UserTurnCompletionConfig } from "../turns/user_turn_completion_mixin.ts";
import { logger } from "../utils/logger.ts";
import { isGiven, NOT_GIVEN, type NotGiven } from "../utils/types.ts";

// In a settings object `NOT_GIVEN` means "this field was not included in the
// delta": distinct from `null`, which is a valid stored value typically meaning
// "this service doesn't support this field". Every delta field defaults to it so
// deltas stay sparse and `applyUpdate` can skip untouched fields. It must
// never appear in a store-mode object — see `validateComplete()`.

/** Convert a snake_case key to camelCase (`voice_id` → `voiceId`). */
function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Python `==` for settings values: structural equality for arrays, plain
 * objects and class instances (dataclasses compare field by field).
 */
export function settingsValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => settingsValuesEqual(v, bb[i]));
  }
  if (a instanceof Map) {
    const bb = b as Map<unknown, unknown>;
    if (a.size !== bb.size) return false;
    for (const [k, v] of a) {
      if (!bb.has(k) || !settingsValuesEqual(v, bb.get(k))) return false;
    }
    return true;
  }
  if (a instanceof Set) {
    const bb = b as Set<unknown>;
    return a.size === bb.size && [...a].every((v) => bb.has(v));
  }
  if (ArrayBuffer.isView(a)) {
    const aa = a as unknown as ArrayLike<unknown>;
    const bb = b as unknown as ArrayLike<unknown>;
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
    return true;
  }
  if (a instanceof Date) return a.getTime() === (b as Date).getTime();
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every((k) => Object.hasOwn(rb, k) && settingsValuesEqual(ra[k], rb[k]));
}

/** `copy.deepcopy` for settings values. Keeps prototypes and the `NOT_GIVEN` singleton. */
function deepCopy<T>(value: T, memo = new Map<unknown, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  if ((value as unknown) === NOT_GIVEN) return value;
  if (memo.has(value)) return memo.get(value) as T;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    memo.set(value, out);
    for (const v of value) out.push(deepCopy(v, memo));
    return out as T;
  }
  if (value instanceof Map) {
    const out = new Map();
    memo.set(value, out);
    for (const [k, v] of value) out.set(deepCopy(k, memo), deepCopy(v, memo));
    return out as T;
  }
  if (value instanceof Set) {
    const out = new Set();
    memo.set(value, out);
    for (const v of value) out.add(deepCopy(v, memo));
    return out as T;
  }
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (ArrayBuffer.isView(value)) {
    return (value as unknown as { slice(): unknown }).slice() as T;
  }
  const out = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  memo.set(value, out);
  for (const key of Object.keys(value)) {
    out[key] = deepCopy((value as Record<string, unknown>)[key], memo);
  }
  return out as T;
}

export interface ServiceSettingsOptions {
  /**
   * AI model identifier (e.g. `"gpt-4o"`, `"eleven_flash_v2_5"`).
   *
   * Defaults to `NOT_GIVEN` for delta mode. In store mode, set to a model
   * string or `null` if the service has no model concept.
   */
  model?: string | null | NotGiven;
  /** Catch-all for service-specific keys that have no declared field. */
  extra?: Record<string, unknown>;
}

/**
 * Base class for runtime-updatable service settings.
 *
 * These settings capture the subset of a service's configuration that can be
 * changed **while the pipeline is running** (e.g. switching the model or
 * changing the voice). They are *not* meant to capture every constructor
 * parameter — only those that support live updates via
 * `*UpdateSettingsFrame`.
 *
 * Every AI service type (LLM, TTS, STT) extends this with its own fields.
 * Each instance operates in one of two modes (see module docs):
 *
 * - **Store mode** (`this._settings`): holds the full current state. Every
 *   field must be a real value — `NOT_GIVEN` is never valid. Use `null` for
 *   inherited fields the service doesn't support. Enforced at runtime by
 *   `validateComplete()`.
 * - **Delta mode** (`*UpdateSettingsFrame`): a sparse update. Only fields the
 *   caller wants to change are set; all others stay at the default
 *   `NOT_GIVEN` and are skipped by `applyUpdate()`.
 *
 * - `model`: the model identifier used by the service. Set to `null` in
 *   store mode if the service has no model concept.
 * - `extra`: overflow dict for service-specific keys that don't map to a
 *   declared field.
 */
export class ServiceSettings {
  // -- common fields -------------------------------------------------------

  /**
   * AI model identifier (e.g. `"gpt-4o"`, `"eleven_flash_v2_5"`).
   *
   * Defaults to `NOT_GIVEN` for delta mode. In store mode, set to a model
   * string or `null` if the service has no model concept.
   */
  model: string | null | NotGiven = NOT_GIVEN;

  /** Catch-all for service-specific keys that have no declared field. */
  extra: Record<string, unknown> = {};

  // -- class-level configuration -------------------------------------------

  /**
   * Map of alternative key names to canonical field names.
   *
   * For example `{ voice_id: "voice" }` lets callers use either spelling.
   * Subclasses should override this as needed.
   */
  static _aliases: Record<string, string> = {};

  constructor(options: ServiceSettingsOptions = {}) {
    if (options.extra !== undefined) this.extra = options.extra;
    this._assignOptions(options);
  }

  /**
   * Copy the given options onto the declared fields of this object. A key
   * that is `undefined` leaves its field at `NOT_GIVEN`. Settings subclasses
   * that declare fields call this at the end of their constructor (see the
   * module docs).
   */
  protected _assignOptions(options: object): void {
    const self = this as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(options)) {
      if (key === "extra" || value === undefined) continue;
      if (Object.hasOwn(this, key)) self[key] = value;
    }
  }

  /** Names of the declared fields (`dataclasses.fields()`), without `extra`. */
  protected _fieldNames(): string[] {
    return Object.keys(this).filter((name) => name !== "extra");
  }

  // -- public API ----------------------------------------------------------

  /**
   * Return a dict of only the fields that are not `NOT_GIVEN`.
   *
   * Primarily useful for delta-mode objects to inspect which fields were set.
   * For a store-mode object this returns all declared fields (since none
   * should be `NOT_GIVEN`).
   *
   * Skips the `extra` field itself but merges its entries into the returned
   * dict at the top level.
   *
   * @returns Dictionary mapping field names to their provided values.
   */
  givenFields(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const self = this as unknown as Record<string, unknown>;
    for (const name of this._fieldNames()) {
      const val = self[name];
      if (isGiven(val)) result[name] = val;
    }
    Object.assign(result, this.extra);
    return result;
  }

  /**
   * Merge a delta-mode object into this store-mode object.
   *
   * Only fields in `delta` that are **given** (i.e. not `NOT_GIVEN`) are
   * considered. A field is "changed" if its new value differs from the
   * current value.
   *
   * The `extra` dicts are merged: keys present in the delta overwrite keys in
   * the target.
   *
   * @param delta A delta-mode settings object of the same type.
   * @returns A dict mapping each changed field name to its **pre-update**
   *   value. Use `Object.keys(changed)` for the set of names, or index with
   *   `changed.field` to inspect the old value.
   *
   * @example
   * // store-mode object (all fields given)
   * const current = new TTSSettings({ voice: "alice", language: "en" });
   * // delta-mode object (only voice is set)
   * const delta = new TTSSettings({ voice: "bob" });
   * const changed = current.applyUpdate(delta);
   * // changed == { voice: "alice" }
   * // current.voice == "bob", current.language == "en"
   */
  applyUpdate(delta: this): Record<string, unknown> {
    const changed: Record<string, unknown> = {};
    const self = this as unknown as Record<string, unknown>;
    const other = delta as unknown as Record<string, unknown>;
    for (const name of this._fieldNames()) {
      const newVal = Object.hasOwn(other, name) ? other[name] : NOT_GIVEN;
      if (!isGiven(newVal)) continue;
      const oldVal = self[name];
      if (!settingsValuesEqual(oldVal, newVal)) {
        self[name] = newVal;
        changed[name] = oldVal;
      }
    }

    // Merge extra
    for (const [key, newVal] of Object.entries(delta.extra)) {
      const oldVal = Object.hasOwn(this.extra, key) ? this.extra[key] : NOT_GIVEN;
      if (!settingsValuesEqual(oldVal, newVal)) {
        this.extra[key] = newVal;
        changed[key] = oldVal;
      }
    }

    return changed;
  }

  /**
   * Build a **delta-mode** settings object from a plain dictionary.
   *
   * The returned object is a delta: only the keys present in `settings` are
   * set; all other fields remain `NOT_GIVEN`.
   *
   * Keys are matched to fields by name. Keys listed in `_aliases` are
   * translated to their canonical name first. A snake_case key also matches
   * its camelCase field (`system_instruction` → `systemInstruction`), so dicts
   * written with upstream's spelling keep working. Any remaining
   * unrecognized keys are placed into `extra`.
   *
   * @param settings A dictionary of setting names to values.
   * @returns A new delta-mode settings instance.
   *
   * @example
   * const delta = TTSSettings.fromMapping({ voice_id: "alice", speed: 1.2 });
   * // delta.voice == "alice"  (via alias)
   * // delta.language is NOT_GIVEN  (not in the dict)
   * // delta.extra == { speed: 1.2 }
   */
  static fromMapping<T extends ServiceSettings>(
    this: new (
      options?: object,
    ) => T,
    settings: Record<string, unknown>,
  ): T {
    // The subclass `fromMapping` is called on (Python's `cls`), not
    // `ServiceSettings`: its fields and aliases decide where keys go.
    // biome-ignore lint/complexity/noThisInStatic: polymorphic static, like Python's classmethod.
    const cls = this as unknown as typeof ServiceSettings & (new (options?: object) => T);
    const fieldNames = new Set(new cls()._fieldNames());
    const kwargs: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(settings)) {
      // Resolve aliases first
      const canonical = cls._aliases[key] ?? key;
      if (fieldNames.has(canonical)) {
        kwargs[canonical] = value;
      } else if (fieldNames.has(snakeToCamel(canonical))) {
        kwargs[snakeToCamel(canonical)] = value;
      } else {
        extra[key] = value;
      }
    }

    const instance = new cls(kwargs);
    instance.extra = extra;
    return instance;
  }

  /**
   * Check that this is a valid store-mode object (no `NOT_GIVEN` fields).
   *
   * Called automatically by `AIService.start()` to catch fields that a service
   * forgot to initialize in its constructor. Can also be called manually after
   * constructing a store-mode settings object.
   *
   * Logs an error naming every uninitialized field. Failure to initialize all
   * fields may or may not cause runtime issues — it depends on whether and how
   * the service actually reads the field — but it indicates a deviation from
   * expectations and should be fixed.
   */
  validateComplete(): void {
    const self = this as unknown as Record<string, unknown>;
    const missing = this._fieldNames().filter((name) => !isGiven(self[name]));
    if (missing.length > 0) {
      const names = missing.join(", ");
      logger.error(
        `${this.constructor.name}: the following fields are NOT_GIVEN: ${names}. ` +
          "All settings fields should be initialized in the service's " +
          "constructor (use null for unsupported fields).",
      );
    }
  }

  /**
   * Return a deep copy of this settings instance.
   *
   * @returns A new settings object with the same field values.
   */
  copy(): this {
    return deepCopy(this);
  }
}

// ---------------------------------------------------------------------------
// Service-specific settings
// ---------------------------------------------------------------------------

export interface ImageGenSettingsOptions extends ServiceSettingsOptions {}

/**
 * Runtime-updatable settings for image generation services.
 *
 * Used in both store and delta mode — see `ServiceSettings`.
 *
 * - `model`: image generation model identifier.
 */
export class ImageGenSettings extends ServiceSettings {}

export interface VisionSettingsOptions extends ServiceSettingsOptions {}

/**
 * Runtime-updatable settings for vision services.
 *
 * Used in both store and delta mode — see `ServiceSettings`.
 *
 * - `model`: vision model identifier.
 */
export class VisionSettings extends ServiceSettings {}

export interface LLMSettingsOptions extends ServiceSettingsOptions {
  /** System instruction/prompt for the model. */
  systemInstruction?: string | null | NotGiven;
  /** Sampling temperature. */
  temperature?: number | null | NotGiven;
  /** Maximum tokens to generate. */
  maxTokens?: number | null | NotGiven;
  /** Nucleus sampling probability. */
  topP?: number | null | NotGiven;
  /** Top-k sampling parameter. */
  topK?: number | null | NotGiven;
  /** Frequency penalty. */
  frequencyPenalty?: number | null | NotGiven;
  /** Presence penalty. */
  presencePenalty?: number | null | NotGiven;
  /** Random seed for reproducibility. */
  seed?: number | null | NotGiven;
  /**
   * Enable LLM-based turn completion detection to suppress bot responses when
   * the user was cut off mid-thought. Set by
   * `LLMTurnCompletionUserTurnStopStrategy`, which is also what waits on the
   * resulting verdict. Not meant to be set by application code; use
   * `userTurnStrategies: new FilterIncompleteUserTurnStrategies()` on
   * `LLMUserAggregatorParams` instead.
   */
  filterIncompleteUserTurns?: boolean | null | NotGiven;
  /**
   * Configuration for turn completion behavior when
   * `filterIncompleteUserTurns` is enabled. Set by the user turn strategy;
   * pass the config to `FilterIncompleteUserTurnStrategies({ config })`.
   */
  userTurnCompletionConfig?: UserTurnCompletionConfig | null | NotGiven;
  /**
   * Whether a model with no thinking configured runs at its provider's
   * default. Services that otherwise send each model its lowest thinking
   * setting, for the fastest responses, send none. `BackendLLMWorker` sets it
   * on its LLM. Defaults to false.
   */
  useProviderThinkingDefault?: boolean | NotGiven;
}

/**
 * Runtime-updatable settings for LLM services.
 *
 * Used in both store and delta mode — see `ServiceSettings`.
 *
 * These fields are common across LLM providers. Not every provider supports
 * every field; in store mode, set unsupported fields to `null` (e.g. a
 * service that doesn't support `seed` should initialize it as `seed: null`).
 *
 * - `model`: LLM model identifier.
 * - `systemInstruction`: system instruction/prompt for the model.
 * - `temperature`: sampling temperature.
 * - `maxTokens`: maximum tokens to generate.
 * - `topP`: nucleus sampling probability.
 * - `topK`: top-k sampling parameter.
 * - `frequencyPenalty`: frequency penalty.
 * - `presencePenalty`: presence penalty.
 * - `seed`: random seed for reproducibility.
 * - `filterIncompleteUserTurns`: enable LLM-based turn completion detection.
 *   Set by `LLMTurnCompletionUserTurnStopStrategy` over an
 *   `LLMUpdateSettingsFrame`; application code configures it through
 *   `FilterIncompleteUserTurnStrategies` instead.
 * - `userTurnCompletionConfig`: configuration for turn completion behavior
 *   when `filterIncompleteUserTurns` is enabled. Set by the user turn
 *   strategy, like `filterIncompleteUserTurns`.
 * - `useProviderThinkingDefault`: whether a model with no thinking configured
 *   runs at its provider's default. Defaults to false.
 */
export class LLMSettings extends ServiceSettings {
  systemInstruction: string | null | NotGiven = NOT_GIVEN;
  temperature: number | null | NotGiven = NOT_GIVEN;
  maxTokens: number | null | NotGiven = NOT_GIVEN;
  topP: number | null | NotGiven = NOT_GIVEN;
  topK: number | null | NotGiven = NOT_GIVEN;
  frequencyPenalty: number | null | NotGiven = NOT_GIVEN;
  presencePenalty: number | null | NotGiven = NOT_GIVEN;
  seed: number | null | NotGiven = NOT_GIVEN;
  // Upstream deprecates setting these from application code (1.7.0), but the
  // user turn strategy still drives turn completion through them.
  filterIncompleteUserTurns: boolean | null | NotGiven = NOT_GIVEN;
  userTurnCompletionConfig: UserTurnCompletionConfig | null | NotGiven = NOT_GIVEN;
  useProviderThinkingDefault: boolean | NotGiven = NOT_GIVEN;

  constructor(options: LLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface TTSSettingsOptions extends ServiceSettingsOptions {
  /** Voice identifier or name. */
  voice?: string | null | NotGiven;
  /** Language for speech synthesis. */
  language?: Language | string | null | NotGiven;
}

/**
 * Runtime-updatable settings for TTS services.
 *
 * Used in both store and delta mode — see `ServiceSettings`.
 *
 * In store mode, set unsupported fields to `null` (e.g. `language: null` if
 * the service doesn't expose a language setting).
 *
 * - `model`: TTS model identifier.
 * - `voice`: voice identifier or name.
 * - `language`: language for speech synthesis. The union type reflects the
 *   *input* side: callers may pass a `Language` value or a raw string in a
 *   delta. However, the **stored** value (in store mode) is always a
 *   service-specific string or `null` — `TTSService._updateSettings` converts
 *   `Language` values via `languageToServiceLanguage()` before writing, and
 *   constructors do the same at construction time.
 */
export class TTSSettings extends ServiceSettings {
  voice: string | null | NotGiven = NOT_GIVEN;
  language: Language | string | null | NotGiven = NOT_GIVEN;

  static override _aliases: Record<string, string> = { voice_id: "voice", voiceId: "voice" };

  constructor(options: TTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface STTSettingsOptions extends ServiceSettingsOptions {
  /** Language for speech recognition. */
  language?: Language | string | null | NotGiven;
}

/**
 * Runtime-updatable settings for STT services.
 *
 * Used in both store and delta mode — see `ServiceSettings`.
 *
 * In store mode, set unsupported fields to `null` (e.g. `language: null` if
 * the service auto-detects language).
 *
 * - `model`: STT model identifier.
 * - `language`: language for speech recognition. The union type reflects the
 *   *input* side: callers may pass a `Language` value or a raw string in a
 *   delta. However, the **stored** value (in store mode) is always a
 *   service-specific string or `null` — `STTService._updateSettings` converts
 *   `Language` values via `languageToServiceLanguage()` before writing, and
 *   constructors do the same at construction time.
 */
export class STTSettings extends ServiceSettings {
  language: Language | string | null | NotGiven = NOT_GIVEN;

  constructor(options: STTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}
