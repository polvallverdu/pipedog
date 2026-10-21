// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// After `next build`: write small HTML redirects for pages that moved, so old links (READMEs,
// issues, search results) keep working. A static export has no server-side redirects. Targets
// are relative, so they work under any basePath.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const out = join(import.meta.dir, "../out");

/** Old path under /docs -> new path under /docs. */
const moved: Record<string, string> = {
  workers: "deployment/cloudflare-workers",
  "turn-detection": "concepts/turn-detection",
  runtimes: "guides/runtimes",
  "coming-from-pipecat": "guides/coming-from-pipecat",
};

for (const [from, to] of Object.entries(moved)) {
  const target = `../${to}/`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Moved</title>
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${target}">
<script>location.replace(${JSON.stringify(target)} + location.hash)</script>
</head>
<body><p>This page moved to <a href="${target}">${to}</a>.</p></body>
</html>
`;
  await mkdir(join(out, "docs", from), { recursive: true });
  await writeFile(join(out, "docs", from, "index.html"), html);
}
console.log(`redirects: ${Object.keys(moved).length} moved pages`);
