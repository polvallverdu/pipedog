// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/deprecation.py

/**
 * Deprecation marker conventions for the Pipecat framework.
 *
 * Every deprecation is emitted with a message that follows the same canonical
 * template so it is machine-parseable (see `DEPRECATION_MESSAGE_RE`) and
 * consistent for readers:
 *
 *     `Subject` is deprecated since X.Y.Z and will be removed in A.B.C. Use `Replacement` instead.
 *
 * where the removal version `A.B.C` is a concrete semantic version (e.g.
 * `2.0.0`) — we commit to the release that removes it rather than saying "a
 * future release" — and the second sentence is `No replacement.` when there is
 * nothing to migrate to, stated explicitly and never omitted. Additional
 * sentences may follow.
 *
 * Symbols (classes, functions, methods, properties) are marked with the
 * `@deprecated` JSDoc tag, which TypeScript tooling and IDEs flag statically,
 * and warn at runtime with `warnDeprecated`. Everything else — parameters,
 * fields, module moves, behavior/value changes — warns with `warnDeprecated`.
 *
 * Porting notes: pipedog does not port deprecated upstream APIs, so the
 * PEP 702 `deprecated` decorator re-export, `renamed_init_field` (a dataclass
 * constructor rewriter for renamed fields) and the deprecated
 * `warn_deprecated_read` are not ported.
 */

import { logger } from "./logger.ts";

/**
 * The canonical deprecation message, for symbol and hand-written warnings
 * alike. Kept consistent and parseable so the developer-facing message agrees
 * with the docstring directive.
 */
export const DEPRECATION_MESSAGE_RE =
  /^`(?<subject>[^`]+)` is deprecated since (?<version>\d+\.\d+\.\d+) and will be removed in (?<removal>\d+\.\d+\.\d+)\. (?:Use (?<replacement>.+) instead\.|No replacement\.)/;

/**
 * Call sites already warned about by `warnDeprecated`, identified by message
 * and source location (`message\u0000location`).
 *
 * The record lasts for the life of the process, so a test asserting on one of
 * these warnings clears it first.
 */
export const _warnedSites = new Set<string>();

// The stack line naming the caller `stacklevel` frames up from warnDeprecated's caller.
function callSite(stacklevel: number): string {
  const stack = new Error().stack;
  if (!stack) return "";
  const lines = stack.split("\n").filter((line) => /^\s+at\s|@/.test(line));
  // `lines` drops the message line: 0 is callSite, 1 warnDeprecated, 2 the caller.
  return lines[1 + stacklevel]?.trim() ?? "";
}

/**
 * Warn once per call site that something deprecated was used.
 *
 * Many of Pipecat's deprecations are detected inside Pipecat, as a pipeline
 * runs, so the warning is always logged, and a per-site record keeps it to one
 * warning per call site: a deprecated field read wherever its object travels,
 * or a check on every frame, would otherwise repeat without bound.
 *
 * @param message The warning message, following `DEPRECATION_MESSAGE_RE`.
 * @param stacklevel Counted from the caller: `1` names the line that calls this
 *   function, `2` its caller.
 */
export function warnDeprecated(message: string, stacklevel = 1): void {
  const site = `${message}\u0000${callSite(stacklevel)}`;
  if (_warnedSites.has(site)) {
    return;
  }
  _warnedSites.add(site);
  logger.warning(`DeprecationWarning: ${message}`);
}
