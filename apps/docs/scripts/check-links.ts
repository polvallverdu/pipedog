// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// After the build: every internal link in the static site must reach a file in out/. Checks
// the HTML pages (href and src under basePath, and #anchors on docs pages) and the Markdown
// files and llms.txt (absolute links to the site). Fails the build on a broken link.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const out = join(import.meta.dir, "../out");
const basePath = process.env.DOCS_BASE_PATH ?? "";
const siteOrigin = process.env.DOCS_SITE_ORIGIN ?? "https://polvallverdu.github.io";
const siteUrl = `${siteOrigin}${basePath}`;

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

const exists = async (path: string) => (await stat(path).catch(() => null))?.isFile() ?? false;

/** The file a site path is served from, or null. */
async function resolve(path: string): Promise<string | null> {
  const decoded = decodeURIComponent(path);
  const candidates = decoded.endsWith("/")
    ? [join(out, decoded, "index.html")]
    : [join(out, decoded), join(out, decoded, "index.html"), join(out, `${decoded}.html`)];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return null;
}

const idsCache = new Map<string, Set<string>>();
async function ids(file: string): Promise<Set<string>> {
  let set = idsCache.get(file);
  if (!set) {
    const html = await readFile(file, "utf8");
    set = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string));
    idsCache.set(file, set);
  }
  return set;
}

const broken: string[] = [];
let checked = 0;

async function check(from: string, link: string, checkAnchor: boolean) {
  const [pathAndQuery, hash] = link.split("#", 2) as [string, string | undefined];
  const path = pathAndQuery.split("?")[0] as string;
  if (!path.startsWith(`${basePath}/`) && path !== basePath) {
    broken.push(`${from}: ${link} (outside basePath "${basePath}")`);
    return;
  }
  checked++;
  const target = await resolve(path.slice(basePath.length) || "/");
  if (!target) {
    broken.push(`${from}: ${link}`);
    return;
  }
  if (checkAnchor && hash && target.endsWith(".html") && path.includes("/docs")) {
    if (!(await ids(target)).has(decodeURIComponent(hash)))
      broken.push(`${from}: ${link} (no #${hash})`);
  }
}

for await (const file of files(out)) {
  const from = relative(out, file);
  if (file.endsWith(".html")) {
    const html = await readFile(file, "utf8");
    for (const [, attr, value] of html.matchAll(/\s(href|src)="([^"]*)"/g)) {
      const link = (value as string).replaceAll("&amp;", "&");
      if (!link.startsWith("/") || link.startsWith("//")) continue;
      await check(from, link, attr === "href");
    }
  } else if (file.endsWith(".md") || file.endsWith(".txt")) {
    const text = await readFile(file, "utf8");
    for (const [link] of text.matchAll(
      new RegExp(`${siteUrl.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}[^)\\s"'\`>]*`, "g"),
    )) {
      await check(from, link.slice(siteOrigin.length), true);
    }
  }
}

if (broken.length) {
  console.error(`check-links: ${broken.length} broken link(s):`);
  for (const line of broken) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`check-links: ${checked} internal links ok`);
