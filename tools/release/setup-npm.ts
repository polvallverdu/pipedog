// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// One-time npm setup for every publishable @pipedog/* package, run by a
// maintainer on their own machine (it uses your npm login):
//
//   1. publish a placeholder (0.0.0-stage, dist-tag "stage") for each package
//      that doesn't exist on npm yet: npm only lets you configure trusted
//      publishing on a package that exists;
//   2. add the GitHub Actions trusted publisher (repo, release.yml, environment
//      "npm") to each package that doesn't have it yet.
//
// Safe to re-run: existing packages and trust entries are skipped.
//
//   bun tools/release/setup-npm.ts            do it
//   bun tools/release/setup-npm.ts --dry-run  show what it would do
//
// New packages later: add them to packages/, run this again.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishablePackages } from "./manifest.ts";

const REPO = "polvallverdu/pipedog";
const WORKFLOW = "release.yml";
const ENVIRONMENT = "npm";
const PLACEHOLDER = "0.0.0-stage";
// `npm trust` needs npm >= 12.
const NPM_TRUST = ["npx", "-y", "npm@12.2.0"];
const dryRun = process.argv.includes("--dry-run");

/** Run a command attached to the terminal (npm may ask for an OTP). */
function run(cmd: string[], cwd?: string): number {
  console.log(`  $ ${cmd.join(" ")}`);
  if (dryRun) return 0;
  return Bun.spawnSync(cmd, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    .exitCode;
}

/** Run a command quietly and return its output (exit code 0 or not). */
function capture(cmd: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: `${p.stdout.toString()}${p.stderr.toString()}` };
}

const who = capture(["npm", "whoami"]);
if (!who.ok) {
  console.error("Not logged in to npm. Run `npm login` first.");
  process.exit(1);
}
console.log(`npm user: ${who.out.trim()}${dryRun ? " (dry run: nothing will change)" : ""}\n`);

const pkgs = publishablePackages();
const summary: string[] = [];
let failures = 0;

for (const [name, { manifest }] of pkgs) {
  console.log(`${name}`);

  // 1. Placeholder, if the package doesn't exist yet.
  const exists = capture(["npm", "view", name, "name", "--prefer-online"]).ok;
  if (exists) {
    console.log("  exists on npm, no placeholder needed");
  } else {
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
    const code = run(["npm", "publish", "--access", "public", "--tag", "stage"], dir);
    rmSync(dir, { recursive: true, force: true });
    if (code !== 0) {
      failures++;
      summary.push(`❌ ${name}: placeholder publish failed`);
      continue;
    }
  }

  // 2. Trusted publisher, if not configured yet.
  const list =
    dryRun && !exists
      ? { ok: true, out: "" }
      : capture([...NPM_TRUST, "trust", "list", name, "--json"]);
  const configured = list.ok && list.out.includes(REPO) && list.out.includes(WORKFLOW);
  if (configured) {
    console.log(`  trusted publisher already set (${REPO}, ${WORKFLOW})`);
    summary.push(`✅ ${name}`);
  } else {
    const code = run([
      ...NPM_TRUST,
      "trust",
      "github",
      name,
      "--file",
      WORKFLOW,
      "--repository",
      REPO,
      "--environment",
      ENVIRONMENT,
      "--allow-publish",
      "--yes",
    ]);
    if (code !== 0) {
      failures++;
      summary.push(`❌ ${name}: trusted publisher setup failed`);
    } else {
      summary.push(`✅ ${name}`);
    }
  }
  console.log();
}

console.log(summary.join("\n"));
if (failures) {
  console.log(
    `\n${failures} step(s) failed. Fix the cause and run this again; finished steps are skipped.`,
  );
  process.exit(1);
}
console.log(
  dryRun
    ? "\nDry run only. Run without --dry-run to apply."
    : "\nAll packages ready. Merge the Version Packages PR to publish the release.",
);
