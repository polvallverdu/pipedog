// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

// Source files pulled in with <include> carry the repo's license header, which
// is noise in a code sample. Drop a leading run of `// Copyright`, `// SPDX`
// and `// Ported from` lines (and the blank `//` lines between them). A code
// block whose meta contains `keep-header` is left alone.

interface Node {
  type: string;
  value?: string;
  meta?: string | null;
  children?: Node[];
}

const HEADER_LINE = /^\/\/(\s*$|\s+(Copyright|SPDX-License-Identifier|Ported from)\b)/;

export function stripLicenseHeader(code: string): string {
  const lines = code.split("\n");
  let i = 0;
  while (i < lines.length && HEADER_LINE.test(lines[i] ?? "")) i++;
  if (i === 0 || !lines.slice(0, i).some((l) => /Copyright|SPDX/.test(l))) return code;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  return lines.slice(i).join("\n");
}

function walk(node: Node): void {
  if (node.type === "code" && typeof node.value === "string") {
    if (!node.meta?.includes("keep-header")) node.value = stripLicenseHeader(node.value);
  }
  for (const child of node.children ?? []) walk(child);
}

export function remarkStripLicense() {
  return (tree: Node) => walk(tree);
}
