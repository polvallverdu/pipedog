// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_service_init.py

/**
 * Tests for service settings and initialization patterns.
 *
 * Settings objects operate in two modes:
 *
 * - **Store mode** (`this._settings`): the live state inside a service.
 *   Every field must hold a real value (`null` is fine, `NOT_GIVEN` is not).
 * - **Delta mode** (`new FooSettings()` with no args): a sparse update.
 *   Every field must default to `NOT_GIVEN` so `applyUpdate()` skips
 *   untouched fields and doesn't accidentally overwrite the store.
 *
 * These tests verify both sides of that contract automatically:
 *
 * 1. **Delta defaults** — Instantiate every `ServiceSettings` subclass with
 *    no arguments and assert that every field is `NOT_GIVEN`. Catches the
 *    bug where a field defaults to `null` instead of `NOT_GIVEN`, which
 *    would cause partial deltas to silently overwrite unrelated store values.
 *
 * 2. **Store completeness** — Instantiate every concrete service with dummy
 *    args and assert that `_settings` contains no `NOT_GIVEN` values.
 *    This is the same check that `validateComplete()` runs in `start()`,
 *    but caught here at unit-test time without needing a running pipeline.
 *    Catches services that forget to initialize a field in default settings.
 *
 * All Settings and Service classes are auto-discovered; new services are
 * covered automatically with no per-service maintenance.
 *
 * Discovery differs from upstream in mechanism only: JS has no
 * `__subclasses__()` / `pkgutil.walk_packages`, so every module whose upstream
 * path is under `src/pipecat/services/` is imported (its TS path comes from
 * `porting/manifest.json`, since provider modules live in their own packages),
 * skipping modules that fail to import, and the exported classes are walked.
 */

import { describe, expect, test } from "bun:test";

import { rethrowIfCancelled } from "@pipecat-ts/asyncio";

import { AIService } from "../src/services/ai_service.ts";
import { ServiceSettings } from "../src/services/settings.ts";
import { isGiven } from "../src/utils/types.ts";

// Modules that define abstract base service classes (not concrete services).
const _BASE_MODULES = new Set([
  "pipecat.services.ai_service",
  "pipecat.services.llm_service",
  "pipecat.services.stt_service",
  "pipecat.services.tts_service",
  "pipecat.services.image_gen_service",
  "pipecat.services.vision_service",
]);

// ---------------------------------------------------------------------------
// Auto-discovery
// ---------------------------------------------------------------------------

type AnyClass = abstract new (...args: any[]) => any;

interface ManifestModule {
  module: string;
  upstream: string;
  ts: string;
}

const REPO_ROOT = new URL("../../../", import.meta.url);

/** Module name -> exported classes, for every importable services module. */
const SERVICE_MODULES = new Map<string, AnyClass[]>();

/**
 * Classes declared `abstract` in their TS source. Python refuses to
 * instantiate an ABC with abstract methods (TypeError); JS has no such runtime
 * check, so the declaration is read from the source instead.
 */
const ABSTRACT_CLASSES = new Set<AnyClass>();

/** Import every module under pipecat.services (skipping missing modules). */
async function _importAllServiceModules(): Promise<void> {
  const manifest = (await Bun.file(new URL("porting/manifest.json", REPO_ROOT)).json()) as {
    modules: ManifestModule[];
  };
  for (const mod of manifest.modules) {
    if (!mod.upstream.startsWith("src/pipecat/services/")) continue;
    const url = new URL(mod.ts, REPO_ROOT);
    let exports: Record<string, unknown>;
    let source: string;
    try {
      exports = await import(url.href);
      source = await Bun.file(url).text();
    } catch (e) {
      rethrowIfCancelled(e);
      continue;
    }
    const classes = Object.values(exports).filter(
      (v): v is AnyClass => typeof v === "function" && v.prototype !== undefined,
    );
    SERVICE_MODULES.set(mod.module, classes);
    for (const cls of classes) {
      if (new RegExp(`\\babstract\\s+class\\s+${cls.name}\\b`).test(source)) {
        ABSTRACT_CLASSES.add(cls);
      }
    }
  }
}

await _importAllServiceModules();

/** All discovered strict subclasses of `cls`. */
function _allSubclasses(cls: AnyClass): Set<AnyClass> {
  const result = new Set<AnyClass>();
  for (const classes of SERVICE_MODULES.values()) {
    for (const sub of classes) {
      if (sub !== cls && sub.prototype instanceof cls) result.add(sub);
    }
  }
  return result;
}

function _byName(a: AnyClass, b: AnyClass): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

const ALL_SETTINGS_CLASSES = [..._allSubclasses(ServiceSettings)].sort(_byName);
if (ALL_SETTINGS_CLASSES.length === 0) throw new Error("No settings classes discovered");

// ---------------------------------------------------------------------------
// Service instantiation helpers
// ---------------------------------------------------------------------------

/**
 * Try to instantiate a service with dummy values for required args.
 *
 * Upstream inspects the `__init__` signature and passes "test" for every
 * required keyword-only parameter. TS options objects carry no runtime
 * signature, so the service is built with an empty options object. Services
 * that need required args or fail for other reasons will throw and be skipped
 * by the test. Abstract classes throw a TypeError, as Python does for an ABC
 * with abstract methods.
 */
function _tryInstantiate(cls: AnyClass): unknown {
  if (ABSTRACT_CLASSES.has(cls)) {
    throw new TypeError(`Can't instantiate abstract class ${cls.name}`);
  }
  return new (cls as any)({});
}

/**
 * Return concrete (non-abstract) service classes under pipecat.services.
 *
 * Pure class-hierarchy walk with no instantiation. Construction happens in
 * the test setup, which skips services that can't be built with dummy args
 * (e.g. those that need real credentials).
 */
function _concreteServiceClasses(): AnyClass[] {
  // Skip abstract base classes defined in framework modules.
  const baseClasses = new Set<AnyClass>();
  for (const name of _BASE_MODULES) {
    for (const cls of SERVICE_MODULES.get(name) ?? []) baseClasses.add(cls);
  }
  return [..._allSubclasses(AIService)].filter((cls) => !baseClasses.has(cls)).sort(_byName);
}

const ALL_SERVICE_CLASSES = _concreteServiceClasses();

// ---------------------------------------------------------------------------
// 1. Settings defaults: delta-mode safety
// ---------------------------------------------------------------------------

describe("test_delta_defaults_are_not_given", () => {
  for (const settingsCls of ALL_SETTINGS_CLASSES) {
    /**
     * Every field must default to NOT_GIVEN so empty deltas are no-ops.
     *
     * A field that defaults to null instead of NOT_GIVEN will cause
     * applyUpdate() to overwrite the corresponding store value whenever
     * a partial delta is applied.
     */
    test(`test_delta_defaults_are_not_given[${settingsCls.name}]`, () => {
      const instance = new (settingsCls as any)() as Record<string, unknown>;
      for (const name of Object.keys(instance)) {
        if (name === "extra") continue;
        const val = instance[name];
        expect(
          isGiven(val),
          `${settingsCls.name}.${name} defaults to ${String(val)}, expected NOT_GIVEN`,
        ).toBe(false);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Service construction: store-mode completeness
// ---------------------------------------------------------------------------

describe("test_service_settings_complete", () => {
  if (ALL_SERVICE_CLASSES.length === 0) {
    // Upstream asserts at collection time that concrete services exist. None
    // of the provider service modules (pipecat.services.<provider>.*, e.g.
    // pipecat.services.openai.llm, pipecat.services.deepgram.stt) are ported yet.
    test.todo(
      "test_service_settings_complete: no concrete services discovered; " +
        "pipecat.services.<provider>.* modules are not ported yet",
    );
    return;
  }
  for (const serviceCls of ALL_SERVICE_CLASSES) {
    const name = `test_service_settings_complete[${serviceCls.name}]`;
    let svc: unknown;
    try {
      svc = _tryInstantiate(serviceCls);
    } catch (e) {
      rethrowIfCancelled(e);
      // Cannot instantiate with dummy args (needs real args or credentials).
      test.skip(name, () => {});
      continue;
    }
    if (typeof svc !== "object" || svc === null || !("_settings" in svc)) {
      // Service has no _settings.
      test.skip(name, () => {});
      continue;
    }
    /**
     * After construction, _settings must have no NOT_GIVEN values.
     *
     * This is what validateComplete() checks in start(). Catching it
     * here means we don't need a running pipeline to find missing defaults.
     */
    test(name, () => {
      const settings = (svc as { _settings: Record<string, unknown> })._settings;
      for (const field of Object.keys(settings)) {
        if (field === "extra") continue;
        const val = settings[field];
        expect(
          isGiven(val),
          `${serviceCls.name}._settings.${field} is NOT_GIVEN after construction`,
        ).toBe(true);
      }
    });
  }
});
