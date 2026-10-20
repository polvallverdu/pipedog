// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/security/allowed_origins.py

/** Origin validation utilities. */

import { getEnv } from "../env.ts";

/**
 * Return allowed origins from the `PIPECAT_ALLOWED_ORIGINS` env var.
 *
 * Parses a comma-separated list of origin strings. Returns an empty list
 * (allow all) when the variable is unset or empty.
 */
export function defaultAllowedOrigins(): string[] {
  const val = getEnv("PIPECAT_ALLOWED_ORIGINS") ?? "";
  return val
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o);
}

/**
 * Return whether `origin` is permitted by `allowedOrigins`.
 *
 * @param origin The value of the `Origin` header, or an empty string if absent.
 * @param allowedOrigins List of allowed origin strings. An empty list allows
 *   all origins. When non-empty, a missing or disallowed origin is rejected.
 */
export function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  if (allowedOrigins.length === 0) {
    return true;
  }
  return new Set(allowedOrigins.map((o) => o.toLowerCase())).has(origin.toLowerCase());
}
