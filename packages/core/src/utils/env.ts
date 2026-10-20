// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/env.py

/**
 * Environment variable helpers.
 *
 * This module provides small, centralized parsing helpers for environment variables.
 */

/**
 * Read an environment variable (Python's `os.getenv`), or `undefined` when it
 * is not set or the runtime has no process environment (e.g. Cloudflare
 * Workers without `nodejs_compat`).
 */
export function getEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.[name];
}

/** Raised when an environment variable value cannot be parsed. */
export class InvalidEnvVarValueError extends Error {
  override name = "InvalidEnvVarValueError";
  /** The environment variable's name. */
  readonly envName: string;
  readonly value: string;
  readonly expected: string;

  /** Initialize an InvalidEnvVarValueError. */
  constructor(options: { name: string; value: string; expected: string }) {
    super(
      `Invalid value for env var '${options.name}': '${options.value}'. Expected ${options.expected}.`,
    );
    // `name` is taken by Error, so the variable's name is `envName`.
    this.envName = options.name;
    this.value = options.value;
    this.expected = options.expected;
  }
}

const TRUTHY = new Set(["1", "true", "yes", "y", "on"]);
const FALSY = new Set(["0", "false", "no", "n", "off", ""]);

/**
 * Interpret an environment variable as a boolean.
 *
 * - If the variable is **not set**, returns `defaultValue`.
 * - If the variable is set to a recognized boolean string, returns the parsed value.
 * - Otherwise, throws `InvalidEnvVarValueError`.
 *
 * Recognized values (case-insensitive, whitespace ignored):
 * - Truthy: "1", "true", "yes", "y", "on"
 * - Falsy:  "0", "false", "no", "n", "off", ""
 */
export function envTruthy(name: string, defaultValue = false): boolean {
  const raw = getEnv(name);
  if (raw === undefined) {
    return defaultValue;
  }

  const val = raw.trim().toLowerCase();
  if (TRUTHY.has(val)) return true;
  if (FALSY.has(val)) return false;

  throw new InvalidEnvVarValueError({ name, value: raw, expected: "true or false" });
}
