// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

// Replaces <RuntimeMatrix pkg="@pipedog/..." /> with a Markdown table of that package's runtime
// support: one row per runtime, whether it works there, and what it needs. The data is the
// package's `pipecat.runtimes` and `pipecat.compat` fields (written by the compat harness), read at
// build time. Being a plain table, it shows in the HTML pages and in the Markdown exports
// (llms.txt, the .md pages) alike.

import { RUNTIME_LABELS, RUNTIMES, readPackageCompat } from "./compat";

interface Node {
  type: string;
  name?: string;
  value?: string;
  attributes?: { type: string; name: string; value?: unknown }[];
  children?: Node[];
}

const text = (value: string): Node => ({ type: "text", value });
const code = (value: string): Node => ({ type: "inlineCode", value });
const cell = (...children: Node[]): Node => ({ type: "tableCell", children });
const row = (...cells: Node[]): Node => ({ type: "tableRow", children: cells });

function matrix(pkgName: string): Node[] {
  const pkg = readPackageCompat().find((p) => p.name === pkgName);
  if (!pkg) throw new Error(`RuntimeMatrix: unknown package ${pkgName}`);
  const rows = RUNTIMES.map((r) => {
    const verified = pkg.runtimes.includes(r);
    const works =
      verified && pkg.partial.includes(r)
        ? "⚠️ partly"
        : verified
          ? "✅ yes"
          : pkg.unsupported.includes(r)
            ? "❌ no"
            : "— not verified";
    const needs = [pkg.needs.all, pkg.needs[r]].filter(Boolean).join(" ") || "Nothing.";
    return row(cell(text(RUNTIME_LABELS[r])), cell(text(works)), cell(text(needs)));
  });
  return [
    {
      type: "table",
      align: [null, null, null],
      children: [
        row(cell(text("Runtime")), cell(text("Works")), cell(text("What it needs"))),
        ...rows,
      ],
    } as Node,
    {
      type: "paragraph",
      children: [
        text("Generated from "),
        code("pipecat.runtimes"),
        text(" and "),
        code("pipecat.compat"),
        text(" in "),
        code(`${pkg.dir}/package.json`),
        text(": ✅ means the compat smoke test passes on that runtime."),
      ],
    },
  ];
}

function walk(node: Node): void {
  if (!node.children) return;
  const next: Node[] = [];
  for (const child of node.children) {
    if (child.type === "mdxJsxFlowElement" && child.name === "RuntimeMatrix") {
      const attr = child.attributes?.find((a) => a.name === "pkg");
      if (typeof attr?.value !== "string")
        throw new Error('RuntimeMatrix needs pkg="@pipedog/..."');
      next.push(...matrix(attr.value));
    } else {
      walk(child);
      next.push(child);
    }
  }
  node.children = next;
}

export function remarkRuntimeMatrix() {
  return (tree: Node) => walk(tree);
}
