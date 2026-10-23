// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// One-time npm setup for every publishable @pipedog/* package, run by a
// maintainer on their own machine (it uses your npm login):
//
//   1. publish a placeholder (0.0.0) for each package
//      that doesn't exist on npm yet: npm only lets you configure trusted
//      publishing on a package that exists;
//   2. add the GitHub Actions trusted publisher (repo, release.yml, environment
//      "npm") to each package that doesn't have it yet.
//
// Safe to re-run: existing packages and trust entries are skipped.
//
//   bun tools/release/setup-npm.ts                     do it
//   bun tools/release/setup-npm.ts --dry-run           show what it would do
//   bun tools/release/setup-npm.ts cloudflare effect   only these packages
//                                                      (with or without "@pipedog/")
//
// New packages later: add them to packages/, run this again.
//
// How it is ordered, and why (see trust.ts):
//
// - Which packages exist is asked of the registry directly, all at once, and needs no login.
// - Placeholders come next, one at a time, because npm may ask for a one-time password.
// - All the trusted-publisher work comes last and back to back. npm asks for 2FA on the first
//   `npm trust` call and offers "skip 2FA for the next 5 minutes" on its page: tick it, and the
//   rest of the packages run without another prompt. One npm@12 is installed up front, since
//   starting a new `npx` for every call would eat that window.
// - `npm trust list` is checked first, so packages that already trust this workflow are skipped.
//   (It also needs 2FA, which the first version of this script didn't know.)

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishablePackages } from "./manifest.ts";
import { ensureTrust, pool, type TrustIo, type TrustOutcome } from "./trust.ts";

const REPO = "polvallverdu/pipedog";
const WORKFLOW = "release.yml";
const ENVIRONMENT = "npm";
// Plain 0.0.0: npm reserves the "-stage" suffix, and it must sort below the
// first real release. It is `latest` until that release replaces it.
const PLACEHOLDER = "0.0.0";
// `npm trust` needs npm >= 12.
const NPM_VERSION = "12.2.0";
const dryRun = process.argv.includes("--dry-run");
/** Package names given on the command line: only those are set up. */
const only = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"))
  .map((a) => (a.startsWith("@pipedog/") ? a : `@pipedog/${a}`));

/** Run a command attached to the terminal (npm may ask for an OTP). */
function run(cmd: string[], cwd?: string): number {
  console.log(`  $ ${cmd.join(" ")}`);
  if (dryRun) return 0;
  return Bun.spawnSync(cmd, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    .exitCode;
}

/** Run a command quietly and return its output (exit code 0 or not). */
function capture(cmd: string[]): { ok: boolean; code: number; out: string } {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return {
    ok: p.exitCode === 0,
    code: p.exitCode,
    out: `${p.stdout.toString()}${p.stderr.toString()}`,
  };
}

/** Whether the registry has the package. A plain GET: public, so no login or `npm view` needed. */
async function existsOnNpm(name: string): Promise<boolean> {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/vnd.npm.install-v1+json" } });
      await res.body?.cancel();
      if (res.status === 404) return false;
      if (res.ok) return true;
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (attempt >= 3) throw new Error(`could not check ${name} on the registry: ${e}`);
      await Bun.sleep(500 * attempt);
    }
  }
}

/** npm@12 installed once, so each `npm trust` call is a plain `node` start. */
function installNpm(): { cmd: string[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pipedog-npm-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const installed = capture([
    "npm",
    "install",
    "--prefix",
    dir,
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    `npm@${NPM_VERSION}`,
  ]);
  const cli = join(dir, "node_modules", "npm", "bin", "npm-cli.js");
  if (installed.ok && existsSync(cli)) return { cmd: ["node", cli], cleanup };
  console.log(`  could not install npm@${NPM_VERSION} locally, falling back to npx (slower)`);
  return { cmd: ["npx", "-y", `npm@${NPM_VERSION}`], cleanup };
}

const who = capture(["npm", "whoami"]);
if (!who.ok) {
  console.error("Not logged in to npm. Run `npm login` first.");
  process.exit(1);
}
console.log(`npm user: ${who.out.trim()}${dryRun ? " (dry run: nothing will change)" : ""}\n`);

const all = [...publishablePackages()];
const unknown = only.filter((name) => !all.some(([n]) => n === name));
if (unknown.length > 0) {
  console.error(`Not a publishable package: ${unknown.join(", ")}`);
  process.exit(1);
}
const pkgs = only.length > 0 ? all.filter(([name]) => only.includes(name)) : all;
const summary: string[] = [];
let failures = 0;

// 1. Which packages exist (no 2FA, all at once).
console.log(`Checking ${pkgs.length} packages on the registry...`);
const present = await pool(pkgs, 16, ([name]) => existsOnNpm(name));
const missing = pkgs.filter((_, i) => !present[i]);
console.log(
  `  ${pkgs.length - missing.length} exist, ${missing.length} need a placeholder${
    missing.length ? `: ${missing.map(([n]) => n.replace("@pipedog/", "")).join(", ")}` : ""
  }\n`,
);

// 2. Placeholders, one at a time (npm may ask for a one-time password).
const justCreated = new Set<string>();
for (const [name, { manifest }] of missing) {
  console.log(name);
  const dir = mkdtempSync(join(tmpdir(), "pipedog-placeholder-"));
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: PLACEHOLDER,
        description: `Placeholder for ${name}. Releases are published from GitHub Actions; see ${manifest.homepage ?? `https://github.com/${REPO}`}`,
        license: manifest.license,
        repository: manifest.repository,
        homepage: manifest.homepage,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(dir, "README.md"),
    `# ${name}\n\nPlaceholder version. Install a released version instead: \`npm install ${name}@latest\`.\n\nPart of [pipedog](https://github.com/${REPO}).\n`,
  );
  const code = run(["npm", "publish", "--access", "public"], dir);
  rmSync(dir, { recursive: true, force: true });
  if (code !== 0) {
    failures++;
    summary.push(`❌ ${name}: placeholder publish failed`);
  } else {
    justCreated.add(name);
  }
  console.log();
}

// 3. Trusted publishers, back to back.
const toConfigure = pkgs.filter(([name]) => !summary.some((s) => s.includes(`${name}:`)));
console.log(
  `Trusted publishers for ${toConfigure.length} packages. npm will ask you to approve 2FA in the\n` +
    `browser on the first one: tick "skip 2FA for the next 5 minutes", and don't wait around after.\n`,
);
const npm = installNpm();
const trustArgs = [
  "--file",
  WORKFLOW,
  "--repository",
  REPO,
  "--environment",
  ENVIRONMENT,
  "--allow-publish",
  "--yes",
];
const io: TrustIo = {
  list: (name) => {
    const r = capture([...npm.cmd, "trust", "list", name, "--json"]);
    return { code: r.code, out: r.out };
  },
  authenticate: (name) => {
    run([...npm.cmd, "trust", "list", name]);
  },
  set: (name) => {
    console.log(`  $ npm trust github ${name} ${trustArgs.join(" ")}`);
    const r = capture([...npm.cmd, "trust", "github", name, ...trustArgs]);
    return { code: r.code, out: r.out };
  },
  setInteractive: (name) => run([...npm.cmd, "trust", "github", name, ...trustArgs]),
  sleep: (ms) => (dryRun ? Promise.resolve() : Bun.sleep(ms)),
  log: (message) => console.log(message),
};

const ICON: Record<TrustOutcome, string> = {
  configured: "✅",
  already: "✅",
  assumed: "⚠️",
  other: "⚠️",
  planned: "➡️",
  failed: "❌",
};
const LABEL: Record<TrustOutcome, string> = {
  configured: "trusted publisher set",
  already: "already trusted",
  assumed: "assumed already set",
  other: "different trusted publisher",
  planned: "would set the trusted publisher",
  failed: "failed",
};

try {
  for (const [name] of toConfigure) {
    const { outcome, note } = await ensureTrust(
      name,
      { repo: REPO, workflow: WORKFLOW, justCreated: justCreated.has(name), dryRun },
      io,
    );
    console.log(`${name}: ${LABEL[outcome]}${note ? ` (${note})` : ""}`);
    summary.push(`${ICON[outcome]} ${name}${note ? `: ${note}` : ""}`);
    if (outcome === "failed" || outcome === "other") failures++;
  }
} finally {
  npm.cleanup();
}

console.log(`\n${summary.join("\n")}`);
if (failures) {
  console.log(
    `\n${failures} step(s) need attention. Fix the cause and run this again; finished steps are skipped.`,
  );
  process.exit(1);
}
console.log(
  dryRun
    ? "\nDry run only. Run without --dry-run to apply."
    : "\nAll packages ready. Merge the Version Packages PR to publish the release.",
);
