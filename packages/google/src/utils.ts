// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/google/utils.py

/**
 * Utility functions for Google services.
 *
 * Porting notes:
 * - `pipecat.version()` is `version()` from `@pipedog/core` (the pipedog
 *   version, which every @pipedog package shares). The header value keeps
 *   upstream's `pipecat/<version>` shape.
 * - Python's three cases map to: `null`/`undefined`, a plain object (a dict),
 *   and any other object with a `headers` property (an `HttpOptions`
 *   instance). In JS an `HttpOptions` is usually a plain object too, so it
 *   takes the dict branch and is copied rather than modified in place.
 */

import { version as pipecatVersion } from "@pipedog/core";

/** HTTP options as accepted by the Google SDK clients (`headers` is the only key read here). */
export interface GoogleClientHttpOptions {
  headers?: Record<string, string> | null;
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Updates httpOptions with the x-goog-api-client header.
 *
 * @param httpOptions The existing httpOptions, which can be null, a
 *   dictionary, or an object with a `headers` attribute.
 * @returns The updated httpOptions.
 */
export function updateGoogleClientHttpOptions<T>(httpOptions: T): T | GoogleClientHttpOptions {
  const clientHeader: Record<string, string> = {
    "x-goog-api-client": `pipecat/${pipecatVersion()}`,
  };

  if (httpOptions === null || httpOptions === undefined) {
    return { headers: clientHeader };
  }
  if (isPlainObject(httpOptions)) {
    // Create a copy to avoid modifying the original dictionary if it's reused elsewhere
    const copy: Record<string, unknown> = { ...httpOptions };
    if ("headers" in copy) {
      // Python's dict.copy() is shallow, so the headers dict is updated in place.
      Object.assign(copy.headers as Record<string, string>, clientHeader);
    } else {
      copy.headers = clientHeader;
    }
    return copy as T;
  }
  if (typeof httpOptions === "object" && "headers" in httpOptions) {
    // We can't easily copy an arbitrary object, so we modify it in place.
    // This assumes the object is mutable and it's safe to do so.
    const obj = httpOptions as { headers: Record<string, string> | null | undefined };
    if (obj.headers === null || obj.headers === undefined) {
      obj.headers = clientHeader;
    } else {
      Object.assign(obj.headers, clientHeader);
    }
  }

  return httpOptions;
}
