// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The API lookup behind `get_api`. The snapshot generator reads every exported declaration from
 * the packages' generated `.d.ts` (`extractDeclarations`); at runtime `describeApi` finds a
 * symbol and prints its signature, constructor and options interfaces.
 */

import type { ApiEntry, ApiKind, DocPage } from "./snapshot.ts";

export interface Declaration {
  name: string;
  kind: ApiKind;
  doc: string;
  text: string;
}

export interface ModuleDeclarations {
  declarations: Declaration[];
  /** `export * from "./x.ts"`: the relative specifiers. */
  starExports: string[];
  /** `export { A, B as C } from "./x.ts"`: exported name -> [specifier, original name]. */
  namedExports: Map<string, [string, string]>;
}

const DECLARATION =
  /^export (?:declare )?(?:abstract )?(class|interface|function|type|const|let|var|enum|namespace) ([A-Za-z_$][\w$]*)/;

/**
 * Find the end of the statement that starts at `start`: the `;` at depth 0, or the `}` that
 * closes the first block of a class, interface, enum or namespace. Skips strings and comments.
 */
function statementEnd(src: string, start: number, block: boolean): number {
  let depth = 0;
  let opened = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 1;
    } else if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? src.length : end;
    } else if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
    } else if (c === "{" || c === "(" || c === "[") {
      depth++;
      if (c === "{") opened = true;
    } else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (block && opened && depth === 0 && c === "}") return i + 1;
    } else if (c === ";" && depth === 0) {
      return i + 1;
    } else if (c === "\n" && depth === 0 && !block && src[i + 1] !== " " && opened) {
      return i;
    }
  }
  return src.length;
}

function cleanDoc(comment: string): string {
  return comment
    .replace(/^\/\*\*\s?/, "")
    .replace(/\s*\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
}

/** Every top-level exported declaration in a `.d.ts` file, with its JSDoc, and its re-exports. */
export function extractDeclarations(dts: string): ModuleDeclarations {
  const declarations: Declaration[] = [];
  const starExports: string[] = [];
  const namedExports = new Map<string, [string, string]>();
  let pendingDoc: { text: string; start: number } | null = null;
  let i = 0;
  while (i < dts.length) {
    const lineEnd = dts.indexOf("\n", i) === -1 ? dts.length : dts.indexOf("\n", i);
    const line = dts.slice(i, lineEnd);
    if (line.startsWith("/**")) {
      const end = dts.indexOf("*/", i);
      const stop = end === -1 ? dts.length : end + 2;
      pendingDoc = { text: dts.slice(i, stop), start: i };
      i = dts.indexOf("\n", stop) === -1 ? dts.length : dts.indexOf("\n", stop) + 1;
      continue;
    }
    if (line.startsWith("//")) {
      i = lineEnd + 1;
      continue;
    }
    const star = line.match(/^export \* from ["']([^"']+)["'];?/);
    const named = line.match(/^export (?:type )?\{([^}]*)\} from ["']([^"']+)["'];?/);
    const decl = line.match(DECLARATION);
    if (star) {
      starExports.push(star[1] as string);
    } else if (named) {
      for (const spec of (named[1] as string).split(",")) {
        const [orig, alias] = spec
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/);
        if (orig) namedExports.set((alias ?? orig).trim(), [named[2] as string, orig.trim()]);
      }
    }
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("}")) {
      const block = decl
        ? ["class", "interface", "enum", "namespace"].includes(decl[1] as string)
        : false;
      const end = statementEnd(dts, i, block);
      if (decl) {
        const kind = (decl[1] === "let" || decl[1] === "var" ? "const" : decl[1]) as ApiKind;
        declarations.push({
          name: decl[2] as string,
          kind,
          doc: pendingDoc ? cleanDoc(pendingDoc.text) : "",
          text: `${pendingDoc ? `${pendingDoc.text}\n` : ""}${dts.slice(i, end)}`
            .replace(/^\s*#private;\n/gm, "")
            .trimEnd(),
        });
      }
      pendingDoc = null;
      i = dts.indexOf("\n", end) === -1 ? dts.length : dts.indexOf("\n", end) + 1;
      continue;
    }
    i = lineEnd + 1;
  }
  return { declarations, starExports, namedExports };
}

const MAX_DECLARATION_LINES = 200;
const MAX_MATCHES = 5;

/** The options/params types a constructor or function takes, by name. */
function parameterTypes(text: string, known: Map<string, ApiEntry[]>): string[] {
  const signatures =
    text.match(/(?:constructor|function \w+(?:<[^>]*>)?)\s*\(([^;]*)\)\s*[:;]/g) ?? [];
  const names = new Set<string>();
  for (const sig of signatures) {
    for (const id of sig.match(/\b[A-Z][A-Za-z0-9]*\b/g) ?? []) {
      if (known.get(id)?.some((e) => e.kinds.includes("interface") || e.kinds.includes("type")))
        names.add(id);
    }
  }
  return [...names];
}

function extendsOf(text: string): string[] {
  const header = text.match(/^export (?:declare )?(?:abstract )?(?:class|interface)[^{]*/m)?.[0];
  const clause = header?.match(/\bextends\s+(.+?)(?:\s+implements\b|$)/s)?.[1];
  if (!clause) return [];
  return clause
    .split(",")
    .map((s) => s.trim().match(/^[A-Za-z_$][\w$.]*/)?.[0] ?? "")
    .filter(Boolean);
}

function constructorLines(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => /^\s+(?:protected |private )?constructor\(/.test(l))
    .map((l) => l.trim());
}

function cap(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= MAX_DECLARATION_LINES) return text;
  return `${lines.slice(0, MAX_DECLARATION_LINES).join("\n")}\n    // … ${lines.length - MAX_DECLARATION_LINES} more lines`;
}

function importLine(e: ApiEntry): string {
  const typeOnly = e.kinds.every((k) => k === "interface" || k === "type");
  return `import ${typeOnly ? "type " : ""}{ ${e.name} } from "${e.module}";`;
}

/** The chain of parents (`extends`) of an interface or class, nearest first. */
function ancestry(entry: ApiEntry, known: Map<string, ApiEntry[]>): string[] {
  const chain: string[] = [];
  let current: ApiEntry | undefined = entry;
  while (current && chain.length < 10) {
    const parent = extendsOf(current.text)[0];
    if (!parent || chain.includes(parent)) break;
    chain.push(parent);
    current = pick(known.get(parent), current.package);
  }
  return chain;
}

/** Prefer the declaration in the same package, then @pipedog/core. */
function pick(entries: ApiEntry[] | undefined, pkg: string): ApiEntry | undefined {
  if (!entries?.length) return undefined;
  return (
    entries.find((e) => e.package === pkg) ??
    entries.find((e) => e.package === "@pipedog/core") ??
    entries[0]
  );
}

export class ApiIndex {
  readonly byName = new Map<string, ApiEntry[]>();
  readonly entries: ApiEntry[];
  readonly pages: DocPage[];

  constructor(entries: ApiEntry[], pages: DocPage[] = []) {
    this.entries = entries;
    this.pages = pages;
    for (const e of entries) {
      const list = this.byName.get(e.name) ?? [];
      list.push(e);
      this.byName.set(e.name, list);
    }
  }

  /** Exact matches, then case-insensitive ones. `@pipedog/x:Name` or `@pipedog/x/mod:Name` narrows. */
  find(symbol: string): ApiEntry[] {
    let query = symbol.trim();
    let scope: string | null = null;
    const scoped = query.match(/^(@pipedog\/[^:\s]+)[:#.](\w+)$/);
    if (scoped) {
      scope = scoped[1] as string;
      query = scoped[2] as string;
    }
    const inScope = (e: ApiEntry) =>
      !scope || e.module === scope || e.package === scope || e.alsoFrom.includes(scope);
    const exact = (this.byName.get(query) ?? []).filter(inScope);
    if (exact.length) return exact;
    const lower = query.toLowerCase();
    return this.entries.filter((e) => e.name.toLowerCase() === lower && inScope(e));
  }

  /** Names that contain the query, for "did you mean". */
  suggest(symbol: string, limit = 10): string[] {
    const lower = symbol.trim().toLowerCase();
    if (!lower) return [];
    const names = [...this.byName.keys()].filter((n) => n.toLowerCase().includes(lower));
    names.sort((a, b) => a.length - b.length || a.localeCompare(b));
    return names.slice(0, limit);
  }

  /** Pages that mention the name, e.g. the service's docs page. */
  pagesMentioning(name: string, limit = 5): DocPage[] {
    const word = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`);
    return this.pages
      .filter((p) => word.test(p.markdown))
      .sort((a, b) => count(b.markdown, name) - count(a.markdown, name))
      .slice(0, limit);
  }

  /** Markdown for `get_api`: signature, constructor, options interfaces and where it's documented. */
  describe(symbol: string): { found: boolean; text: string } {
    const matches = this.find(symbol);
    if (matches.length === 0) {
      const suggestions = this.suggest(symbol);
      return {
        found: false,
        text: `No exported symbol named \`${symbol}\` in the @pipedog/* packages.${
          suggestions.length
            ? ` Did you mean: ${suggestions.map((s) => `\`${s}\``).join(", ")}?`
            : " Try search_docs to find it in the docs."
        }`,
      };
    }
    const parts = matches.slice(0, MAX_MATCHES).map((e) => this.#describeOne(e));
    if (matches.length > MAX_MATCHES) {
      parts.push(
        `${matches.length - MAX_MATCHES} more declarations named \`${symbol}\`: ${matches
          .slice(MAX_MATCHES)
          .map((e) => `\`${e.module}\``)
          .join(", ")}`,
      );
    }
    return { found: true, text: parts.join("\n\n---\n\n") };
  }

  #describeOne(e: ApiEntry): string {
    const out: string[] = [`## ${e.name} (${e.kinds.join(", ")}, ${e.package})`, ""];
    out.push("```ts", importLine(e), "```");
    if (e.alsoFrom.length)
      out.push(`Also exported from ${e.alsoFrom.map((m) => `\`${m}\``).join(", ")}.`);
    const parents = ancestry(e, this.byName);
    if (parents.length) out.push("", `Extends: ${parents.map((p) => `\`${p}\``).join(" → ")}`);
    const ctors = constructorLines(e.text);
    if (e.kinds.includes("class") && ctors.length) {
      out.push("", "### Constructor", "", "```ts", ...ctors, "```");
    }
    const optionTypes = parameterTypes(e.text, this.byName).filter((n) => n !== e.name);
    for (const name of optionTypes) {
      const opt = pick(this.byName.get(name), e.package);
      if (!opt) continue;
      const optParents = ancestry(opt, this.byName);
      out.push(
        "",
        `### ${name}${optParents.length ? ` (extends ${optParents.map((p) => `\`${p}\``).join(" → ")})` : ""}`,
        "",
        `From \`${opt.module}\`.${optParents.length ? ` Inherited options: call get_api on \`${optParents[0]}\`.` : ""}`,
        "",
        "```ts",
        cap(opt.text),
        "```",
      );
    }
    out.push("", "### Declaration", "", "```ts", cap(e.text), "```");
    const pages = this.pagesMentioning(e.name);
    if (pages.length) {
      out.push(
        "",
        `Documented in: ${pages.map((p) => `\`${p.slug}\` (${p.title})`).join(", ")}. Read one with read_page.`,
      );
    }
    return out.join("\n");
  }
}

function count(text: string, word: string): number {
  return text.split(word).length - 1;
}
