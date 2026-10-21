// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// After `next build`: move each page's Markdown from out/llms.mdx/docs/<slug>/content.md to
// out/docs/<slug>.md, next to the page, so that every page's URL plus ".md" is its Markdown
// (as on Pipecat's docs). A static export can't rewrite URLs, so the files move instead.

import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const out = join(import.meta.dir, "../out");
const from = join(out, "llms.mdx/docs");

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

if (!(await stat(from).catch(() => null))) {
  console.error(
    `markdown-files: ${relative(process.cwd(), from)} is missing; run next build first`,
  );
  process.exit(1);
}

let count = 0;
for await (const file of files(from)) {
  if (!file.endsWith("/content.md")) continue;
  const slug = relative(from, dirname(file));
  const target = slug ? join(out, "docs", `${slug}.md`) : join(out, "docs.md");
  await mkdir(dirname(target), { recursive: true });
  await rename(file, target);
  count++;
}
await rm(join(out, "llms.mdx"), { recursive: true, force: true });
console.log(`markdown-files: ${count} pages as Markdown`);
