// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/sarvam/_sdk.py

/**
 * SDK identification headers for Sarvam.
 *
 * DIVERGENCE: upstream's `Pipecat/<version> Python/<version>` becomes
 * `Pipedog/<version> <runtime>/<version>`.
 */

import { version as pipecatVersion } from "@pipedog/core";

function runtimeName(): string {
  const g = globalThis as {
    Bun?: { version: string };
    Deno?: { version: { deno: string } };
    process?: { versions?: { node?: string } };
  };
  if (g.Bun) return `Bun/${g.Bun.version}`;
  if (g.Deno) return `Deno/${g.Deno.version.deno}`;
  const node = g.process?.versions?.node;
  if (node) return `Node/${node}`;
  return "JS";
}

/** SDK identification headers for upstream providers. */
export function sdkHeaders(): Record<string, string> {
  return {
    "User-Agent": `Pipedog/${pipecatVersion()} ${runtimeName()}`,
  };
}
