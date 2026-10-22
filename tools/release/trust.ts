// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The decisions behind setup-npm.ts, with the terminal and the npm process injected so they can
// be tested without touching npm.
//
// What npm does that shapes this (https://docs.npmjs.com/cli/v12/commands/npm-trust):
//
// - `npm trust list` needs 2FA like the commands that change things. Run quietly it fails with
//   EOTP, which the first version of the script read as "no trusted publisher yet", so it tried to
//   set one on every package, including the ones that had it.
// - The registry allows one trusted publisher per package, so setting it again is an error.
// - The first `npm trust` call needs 2FA, and the browser page offers "skip 2FA for the next 5
//   minutes". Inside that window the rest run without a prompt, so they should be back to back.

export type TrustState = "ours" | "other" | "none" | "otp" | "error";

const OTP = /EOTP|one-time password/i;

/** The end of the JSON value that starts at `start`, found by matching brackets outside strings. */
function jsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * The first JSON value in a command's output. The output is stdout followed by stderr, so the
 * JSON can have `npm warn` lines after it (npm prints a Node version warning there) as well as
 * before it; a value starts at the beginning of a line.
 */
function parseJson(output: string): unknown {
  for (const match of output.matchAll(/^[[{]/gm)) {
    const start = match.index ?? 0;
    const end = jsonEnd(output, start);
    if (end < 0) continue;
    try {
      return JSON.parse(output.slice(start, end));
    } catch {
      // not JSON after all: try the next line that looks like a start
    }
  }
  return undefined;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/** What `npm trust list <package> --json` says about a package. */
export function classifyTrustList(
  exitCode: number,
  output: string,
  repo: string,
  workflow: string,
): TrustState {
  if (OTP.test(output)) return "otp";
  if (exitCode !== 0) return /E404|not found|no trust|no trusted/i.test(output) ? "none" : "error";
  const json = parseJson(output);
  if (json === undefined) return "error";
  const all = strings(json);
  if (all.length === 0) return "none";
  return all.some((s) => s.includes(repo)) && all.some((s) => s.includes(workflow))
    ? "ours"
    : "other";
}

/** Why `npm trust github` failed. */
export function classifySetFailure(output: string): "otp" | "exists" | "error" {
  if (OTP.test(output)) return "otp";
  if (/already|exists|only supports one|conflict|409/i.test(output)) return "exists";
  return "error";
}

export interface TrustIo {
  /** `npm trust list <name> --json`, quiet. */
  list(name: string): { code: number; out: string };
  /** `npm trust list <name>` attached to the terminal, so the user can finish 2FA in the browser. */
  authenticate(name: string): void;
  /** `npm trust github <name> ...`, quiet. */
  set(name: string): { code: number; out: string };
  /** The same attached to the terminal, for when 2FA is asked mid-run. Returns the exit code. */
  setInteractive(name: string): number;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

export type TrustOutcome = "configured" | "already" | "assumed" | "other" | "planned" | "failed";

/** Pause after a list and after a set. npm suggests 2 s between calls, to stay under rate limits. */
export const LIST_GAP_MS = 1000;
export const SET_GAP_MS = 2000;

/**
 * Make sure `name` trusts `repo`'s `workflow`, asking npm only what is needed.
 *
 * @param justCreated The package was just published as a placeholder, so it has nothing to list.
 */
export async function ensureTrust(
  name: string,
  options: { repo: string; workflow: string; justCreated: boolean; dryRun: boolean },
  io: TrustIo,
): Promise<{ outcome: TrustOutcome; note?: string }> {
  const { repo, workflow } = options;
  let state: TrustState = "none";

  if (!options.justCreated) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = io.list(name);
      state = classifyTrustList(r.code, r.out, repo, workflow);
      if (state !== "otp") break;
      io.log(
        '  npm wants 2FA. Approve it in the browser, and tick "skip 2FA for the next 5 minutes".',
      );
      io.authenticate(name);
    }
    if (!options.dryRun) await io.sleep(LIST_GAP_MS);
  }

  if (state === "ours") return { outcome: "already" };
  if (state === "other") {
    return {
      outcome: "other",
      note: `has a trusted publisher that isn't ${repo} / ${workflow}; replace it with npm trust revoke`,
    };
  }
  if (options.dryRun) return { outcome: "planned" };

  const result = io.set(name);
  let kind: "ok" | "otp" | "exists" | "error" =
    result.code === 0 ? "ok" : classifySetFailure(result.out);
  if (kind === "otp") {
    kind = io.setInteractive(name) === 0 ? "ok" : "error";
  }
  await io.sleep(SET_GAP_MS);

  if (kind === "ok") return { outcome: "configured" };
  if (kind === "exists") {
    return {
      outcome: "assumed",
      note: "npm says a trusted publisher already exists; assuming it is this repo's, which it didn't let me check",
    };
  }
  return { outcome: "failed", note: result.out.trim().split("\n").slice(-3).join(" | ") };
}

/** Run `fn` over `items`, at most `limit` at a time, keeping the order of the results. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
