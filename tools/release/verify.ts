// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Rehearse a release without touching the repo: build, stage each publishable
// package in its npm form, `npm pack` it, install all tarballs into a fresh
// project, and import every export from plain Node (no TypeScript, no Bun).
//
//   bun tools/release/verify.ts

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkPublishManifest,
  type Manifest,
  preparePackageDir,
  publishablePackages,
  publishManifest,
  ROOT,
} from "./manifest.ts";

const OUT = join(ROOT, "node_modules", ".cache", "release-verify");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "stage"), { recursive: true });
mkdirSync(join(OUT, "tarballs"), { recursive: true });

async function sh(cmd: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}:\n${e}\n${o}`);
  return o;
}

console.log("building...");
await sh(
  [
    "bunx",
    "tsc",
    "-b",
    "--force",
    ...[...publishablePackages().values()].map((p) => join(p.dir, "tsconfig.json")),
  ],
  ROOT,
);

const pkgs = publishablePackages();
const versions = new Map([...pkgs].map(([n, p]) => [n, p.manifest.version as string]));
const tarballs: string[] = [];
const published: Manifest[] = [];
let problems = 0;
for (const [name, p] of pkgs) {
  const m = publishManifest(p.manifest, versions);
  for (const issue of checkPublishManifest(m)) {
    problems++;
    console.error(`❌ ${name}: ${issue}`);
  }
  const stage = join(OUT, "stage", name.split("/")[1] as string);
  mkdirSync(stage, { recursive: true });
  for (const entry of [...(p.manifest.files ?? []), "README.md", "THIRD_PARTY_LICENSES.md"]) {
    const from = join(p.dir, entry);
    if (existsSync(from)) cpSync(from, join(stage, entry), { recursive: true });
  }
  preparePackageDir(stage, p.manifest, versions);
  const tgz = (
    await sh(["npm", "pack", "--silent", "--pack-destination", join(OUT, "tarballs")], stage)
  )
    .trim()
    .split("\n")
    .pop() as string;
  tarballs.push(join(OUT, "tarballs", tgz));
  published.push(m);
  console.log(`packed ${tgz}`);
}

// Install the tarballs like a user would, and import every export subpath.
const app = join(OUT, "app");
mkdirSync(app, { recursive: true });
writeFileSync(
  join(app, "package.json"),
  JSON.stringify({ name: "verify-app", private: true, type: "module" }),
);
await sh(["npm", "install", "--no-audit", "--no-fund", "--loglevel=error", ...tarballs], app);

const imports: string[] = [];
for (const m of published) {
  const dir = join(app, "node_modules", m.name);
  for (const [key, target] of Object.entries(m.exports ?? {})) {
    if (key.endsWith(".wasm") || key.endsWith(".onnx") || key === "./package.json") continue;
    if (key.includes("*")) {
      // Every file the wildcard covers, e.g. "./*" -> dist/**/*.js
      const t = (
        typeof target === "string" ? target : (target as { default: string }).default
      ) as string;
      const [prefix, suffix] = t.replace("./", "").split("*") as [string, string];
      const walk = (rel: string): string[] =>
        readdirSync(join(dir, prefix, rel), { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? walk(join(rel, e.name))
            : e.name.endsWith(suffix)
              ? [join(rel, e.name).slice(0, -suffix.length)]
              : [],
        );
      for (const sub of walk(""))
        imports.push(`${m.name}/${key.replace("./", "").replace("*", sub)}`);
    } else {
      imports.push(key === "." ? m.name : `${m.name}/${key.slice(2)}`);
    }
  }
}
writeFileSync(
  join(app, "check.mjs"),
  `const specs = ${JSON.stringify(imports)};\nlet failed = 0;\nfor (const s of specs) { try { await import(s); } catch (e) { failed++; console.error("❌ import " + s + ": " + (e && e.message)); } }\nconsole.log((specs.length - failed) + "/" + specs.length + " imports ok");\nif (failed) process.exit(1);\n`,
);
writeFileSync(
  join(app, "smoke.mjs"),
  `import { runTest } from "@pipedog/core/tests/utils";\nimport { TextFrame } from "@pipedog/core/frames/frames";\nimport { FrameProcessor } from "@pipedog/core/processors/frame_processor";\nimport { createTask, sleep, CancelledError } from "@pipedog/asyncio";\nimport { segment } from "@pipedog/sentencex-wasm";\nimport { initResampler } from "@pipedog/resampler-wasm";\nclass Pass extends FrameProcessor { async processFrame(f, d) { await super.processFrame(f, d); await this.pushFrame(f, d); } }\nconst [down] = await runTest(new Pass(), { framesToSend: [new TextFrame({ text: "hi" })], expectedDownFrames: [TextFrame] });\nif (down[0].text !== "hi") throw new Error("pipeline");\nconst t = createTask(() => sleep(10)); t.cancel(); try { await t; throw new Error("no cancel"); } catch (e) { if (!(e instanceof CancelledError)) throw e; }\nif (segment("en", "Dr. Smith arrived. He sat.").length !== 2) throw new Error("sentencex");\nconst r = await initResampler(); if (!r) throw new Error("resampler");\nconsole.log("smoke ok: pipeline, cancellation, sentencex, resampler");\n`,
);
let ok = true;
for (const script of ["check.mjs", "smoke.mjs"]) {
  try {
    console.log((await sh(["node", script], app)).trim());
  } catch (e) {
    ok = false;
    console.error(String(e));
  }
}
const tarballFiles = (
  await sh(
    ["sh", "-c", `for t in ${tarballs.map((t) => `'${t}'`).join(" ")}; do tar tzf "$t"; done`],
    OUT,
  )
).split("\n");
for (const required of ["package/LICENSE", "package/NOTICE"]) {
  const count = tarballFiles.filter((f) => f === required).length;
  if (count !== tarballs.length) {
    ok = false;
    console.error(`❌ ${required} in ${count}/${tarballs.length} tarballs`);
  }
}
// Packages that bundle compiled third-party code must ship its notices.
for (const [name, p] of pkgs) {
  if (!existsSync(join(p.dir, "THIRD_PARTY_LICENSES.md"))) continue;
  const tgz = tarballs.find((t) => t.includes(name.replace("@", "").replace("/", "-")));
  const listed = tgz ? (await sh(["tar", "tzf", tgz], OUT)).split("\n") : [];
  if (!listed.includes("package/THIRD_PARTY_LICENSES.md")) {
    ok = false;
    console.error(`❌ ${name}: THIRD_PARTY_LICENSES.md missing from the tarball`);
  }
}
if (tarballFiles.some((f) => f.startsWith("package/src/") || f.endsWith(".map"))) {
  ok = false;
  console.error("❌ a tarball contains src/ or source maps");
}
if (problems || !ok) process.exit(1);
console.log(`release verified: ${tarballs.length} packages`);
