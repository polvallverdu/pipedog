// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/markdown_text_filter.py

/**
 * Markdown text filter for removing Markdown formatting from text.
 *
 * This module provides a text filter that converts Markdown content to plain
 * text while preserving structure and handling special cases like code blocks
 * and tables.
 *
 * DIVERGENCE: upstream converts Markdown to HTML with the Python-Markdown
 * package. Core takes no runtime dependencies, so `markdownToHtml` below is a
 * small built-in converter that follows Python-Markdown's rules for the
 * constructs that matter here (paragraphs, headers, rules, lists, quotes,
 * indented code, tables, code spans, links, images, emphasis, escapes and raw
 * HTML). Exotic Markdown (reference links, nested lists) may convert
 * differently.
 */

import { BaseTextFilter } from "./base_text_filter.ts";

/** Configuration parameters for Markdown text filtering. */
export interface MarkdownTextFilterInputParamsOptions {
  /** Whether to apply Markdown filtering. Defaults to true. */
  enableTextFilter?: boolean | null;
  /** Whether to remove code blocks from the text. Defaults to false. */
  filterCode?: boolean | null;
  /** Whether to remove table content from the text. Defaults to false. */
  filterTables?: boolean | null;
  /** Whether to remove repeated sequences from the text. Defaults to true. */
  filterRepeatedSequences?: boolean | null;
}

/**
 * Configuration parameters for Markdown text filtering
 * (`MarkdownTextFilter.InputParams` upstream).
 *
 * - `enableTextFilter`: whether to apply Markdown filtering. Defaults to true.
 * - `filterCode`: whether to remove code blocks from the text. Defaults to false.
 * - `filterTables`: whether to remove table content from the text. Defaults to false.
 * - `filterRepeatedSequences`: whether to remove repeated sequences from the
 *   text. Defaults to true.
 */
export class MarkdownTextFilterInputParams {
  enableTextFilter: boolean | null;
  filterCode: boolean | null;
  filterTables: boolean | null;
  filterRepeatedSequences: boolean | null;

  constructor(options: MarkdownTextFilterInputParamsOptions = {}) {
    this.enableTextFilter =
      options.enableTextFilter !== undefined ? options.enableTextFilter : true;
    this.filterCode = options.filterCode !== undefined ? options.filterCode : false;
    this.filterTables = options.filterTables !== undefined ? options.filterTables : false;
    this.filterRepeatedSequences =
      options.filterRepeatedSequences !== undefined ? options.filterRepeatedSequences : true;
  }
}

/** Options for `MarkdownTextFilter`. */
export interface MarkdownTextFilterOptions {
  /** Configuration parameters for filtering behavior. */
  params?: MarkdownTextFilterInputParams | null;
}

/** `snake_case` -> `camelCase`, so settings keyed either way are accepted. */
function camelCase(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Text filter that removes Markdown formatting from text content.
 *
 * Converts Markdown to plain text while preserving the overall structure,
 * including leading and trailing spaces. Handles special cases like asterisks
 * and table formatting. Supports selective filtering of code blocks and
 * tables based on configuration.
 */
export class MarkdownTextFilter extends BaseTextFilter {
  /** Configuration parameters for Markdown text filtering. */
  static InputParams = MarkdownTextFilterInputParams;

  protected _settings: MarkdownTextFilterInputParams;
  protected _inCodeBlock = false;
  protected _inTable = false;
  protected _interrupted = false;

  /**
   * Initialize the Markdown text filter.
   *
   * @param options.params Configuration parameters for filtering behavior.
   */
  constructor(options: MarkdownTextFilterOptions = {}) {
    super(options);
    this._settings = options.params ?? new MarkdownTextFilterInputParams();
  }

  /**
   * Update the filter's configuration settings.
   *
   * Keys may be given as upstream writes them (`enable_text_filter`) or in
   * camelCase (`enableTextFilter`).
   *
   * @param settings Dictionary of setting names to values for configuration.
   */
  override async updateSettings(settings: Readonly<Record<string, unknown>>): Promise<void> {
    const target = this._settings as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(settings)) {
      const name = camelCase(key);
      if (Object.hasOwn(target, name)) {
        target[name] = value;
      }
    }
  }

  /**
   * Apply Markdown filtering transformations to the input text.
   *
   * @param text The input text containing Markdown formatting to be filtered.
   * @returns The filtered text with Markdown formatting removed or converted.
   */
  override async filter(text: string): Promise<string> {
    if (this._settings.enableTextFilter) {
      // Strip markdown headers to plain text before the newline collapse
      // below. The converter can't recognize a header once the collapse
      // injects a leading space, so we normalize headers ourselves.
      // First, drop blank lines before a header (keeping the marker) so
      // the collapse doesn't turn them into a leading space.
      let filteredText = text.replace(/\n\s*\n(#{1,6}[ \t])/g, "\n$1");
      // Then strip the leading marker and any "closed" trailing marker
      // (e.g. ## Title ##), leaving just the header text. The trailing
      // marker's surrounding spaces are absorbed only when the marker is
      // present, so genuine trailing whitespace (needed for word-by-word
      // streaming) is preserved on open headers.
      filteredText = filteredText.replace(/^#{1,6}[ \t]+(.*?)(?:[ \t]+#+[ \t]*)?$/gm, "$1");

      // Remove newlines and replace with a space only when there's no text before or after
      filteredText = filteredText.replace(/^\s*\n/gm, " ");

      // Remove backticks from inline code, but not from code blocks
      filteredText = filteredText.replace(/(?<!`)`([^`\n]+)`(?!`)/g, "$1");

      // Remove repeated sequences of 5 or more characters
      if (this._settings.filterRepeatedSequences) {
        filteredText = filteredText.replace(/(\S)(\1{4,})/gu, "");
      }

      // Preserve numbered list items with a unique marker, §NUM§
      filteredText = filteredText.replace(/^(\p{Nd}+\.)\s/u, "§NUM§$1 ");

      // Preserve leading/trailing spaces with a unique marker, §
      // Critical for word-by-word streaming in bot-tts-text
      filteredText = filteredText.replace(/^( +)|\s+$/gm, (m) => "§".repeat(m.length));

      // Remove space placeholders before tables, so that tables are converted to HTML
      // correctly
      filteredText = filteredText.replace(/§\| /g, "| ");

      // Convert markdown to HTML
      filteredText = markdownToHtml(filteredText, { tables: !!this._settings.filterTables });

      // Remove tables
      if (this._settings.filterTables) {
        filteredText = this.removeTables(filteredText);
      }

      // Remove HTML tags
      filteredText = filteredText.replace(/<[^<]+?>/g, "");

      // Replace HTML entities
      filteredText = filteredText.replaceAll("&nbsp;", " ");
      filteredText = filteredText.replaceAll("&lt;", "<");
      filteredText = filteredText.replaceAll("&gt;", ">");
      filteredText = filteredText.replaceAll("&amp;", "&");

      // Remove double asterisks (consecutive without any exceptions)
      filteredText = filteredText.replace(/\*\*/g, "");

      // Remove single asterisks at the start or end of words
      filteredText = filteredText.replace(/(^|\s)\*|\*($|\s)/g, "$1$2");

      // Remove Markdown table formatting
      filteredText = filteredText.replace(/\|/g, "");
      filteredText = filteredText.replace(/^\s*[-:]+\s*$/gm, "");

      // Remove code blocks
      if (this._settings.filterCode) {
        filteredText = this._removeCodeBlocks(filteredText);
      }

      // Restore numbered list items
      filteredText = filteredText.replaceAll("§NUM§", "");

      // Restore leading and trailing spaces
      filteredText = filteredText.replace(/§/g, " ");

      // Make links more readable
      filteredText = filteredText.replace(/https?:\/\//g, "");

      return filteredText;
    }
    return text;
  }

  /**
   * Handle interruption events in the processing pipeline.
   *
   * Resets the filter state and clears any tracking variables for code
   * blocks and tables.
   */
  override async handleInterruption(): Promise<void> {
    this._interrupted = true;
    this._inCodeBlock = false;
    this._inTable = false;
  }

  /**
   * Reset the filter state after an interruption has been handled.
   *
   * Clears the interrupted flag to restore normal operation.
   */
  override async resetInterruption(): Promise<void> {
    this._interrupted = false;
  }

  //
  // Filter code
  //

  /**
   * Remove code blocks from the input text.
   *
   * Handles interruptions and delegates to specific methods based on the
   * current state.
   */
  protected _removeCodeBlocks(text: string): string {
    if (this._interrupted) {
      this._inCodeBlock = false;
      return text;
    }

    // Pattern to match three consecutive backticks (code block delimiter)
    const codeBlockPattern = "```";
    const index = text.indexOf(codeBlockPattern);
    const match = index === -1 ? null : { start: index, end: index + codeBlockPattern.length };

    if (this._inCodeBlock) {
      return this._handleInCodeBlock(match, text);
    }

    return this._handleNotInCodeBlock(match, text, codeBlockPattern);
  }

  /**
   * Handle text when currently inside a code block.
   *
   * If we find the end of the block, return text after it. Otherwise, skip
   * the content.
   */
  protected _handleInCodeBlock(match: { start: number; end: number } | null, text: string): string {
    if (match) {
      this._inCodeBlock = false;
      return text.slice(match.end).trim();
    }
    return ""; // Skip content inside code block
  }

  /** Handle text when not currently inside a code block. */
  protected _handleNotInCodeBlock(
    match: { start: number; end: number } | null,
    text: string,
    codeBlockPattern: string,
  ): string {
    if (!match) {
      return text; // No code block found, return original text
    }

    const startIndex = match.start;
    if (startIndex === 0 || /^\s+$/.test(text.slice(0, startIndex))) {
      return this._handleStartOfCodeBlock(text, startIndex);
    }
    return this._handleCodeBlockWithinText(text, codeBlockPattern);
  }

  /**
   * Handle the case where a code block starts.
   *
   * Return any text before the code block and set the state to inside a code
   * block.
   */
  protected _handleStartOfCodeBlock(text: string, startIndex: number): string {
    this._inCodeBlock = true;
    return text.slice(0, startIndex).trim();
  }

  /**
   * Handle code blocks found within text content.
   *
   * If it's a complete code block, remove it and return surrounding text. If
   * it's the start of a code block, return text before it and set state.
   */
  protected _handleCodeBlockWithinText(text: string, codeBlockPattern: string): string {
    const parts = text.split(codeBlockPattern);
    if (parts.length > 2) {
      return `${parts[0]} ${parts[parts.length - 1]}`.trim();
    }
    this._inCodeBlock = true;
    return (parts[0] as string).trim();
  }

  //
  // Filter tables
  //

  /**
   * Remove HTML tables from the input text.
   *
   * Handles cases where both start and end tags are in the same input, as
   * well as tables that span multiple text chunks.
   *
   * @param text The text containing HTML tables to remove.
   * @returns The text with tables removed.
   */
  removeTables(text: string): string {
    if (this._interrupted) {
      this._inTable = false;
      return text;
    }

    // Remove complete tables
    text = text.replace(/<table>[\s\S]*?<\/table>/gi, "");

    // Handle partial tables at the start
    if (this._inTable) {
      const match = /^[\s\S]*<\/table>/i.exec(text);
      if (match) {
        this._inTable = false;
        return text.slice(match[0].length).trim();
      }
      return ""; // Still inside a table, remove all content
    }

    // Handle partial tables at the end
    const match = /<table>[\s\S]*/i.exec(text);
    if (match) {
      this._inTable = true;
      return text.slice(0, match.index).trim();
    }

    return text.trim();
  }
}

//
// Markdown -> HTML (a small stand-in for Python-Markdown's `Markdown.convert`).
//

const STX = "\u0002";
const ETX = "\u0003";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Characters Python-Markdown lets a backslash escape. */
const ESCAPED_CHARS = new Set("\\`*_{}[]()>#+-.!".split(""));

/** Inline Markdown -> HTML, applied pattern by pattern as Python-Markdown does. */
function inlineToHtml(text: string): string {
  const stash: string[] = [];
  const put = (html: string): string => {
    stash.push(html);
    return `${STX}${stash.length - 1}${ETX}`;
  };

  // Code spans (highest priority): the content is literal.
  text = text.replace(/(?<!\\)(`+)([\s\S]+?)(?<!`)\1(?!`)/g, (_, _ticks, code: string) =>
    put(`<code>${escapeHtml(code.trim())}</code>`),
  );
  // Backslash escapes.
  text = text.replace(/\\([\s\S])/g, (m, ch: string) =>
    ESCAPED_CHARS.has(ch) ? put(escapeHtml(ch)) : m,
  );
  // Automatic links and e-mail addresses.
  text = text.replace(/<((?:[Ff]|[Hh][Tt])[Tt][Pp][Ss]?:\/\/[^<>]*)>/g, (_, url: string) =>
    put(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`),
  );
  // Python-Markdown obfuscates e-mail addresses as numeric character
  // references; they survive tag stripping as such.
  text = text.replace(/<([^<> !]+@[^@<> ]+)>/g, (_, email: string) => {
    const names: Record<number, string> = { 34: "quot", 38: "amp", 60: "lt", 62: "gt" };
    const obfuscated = [...email]
      .map((ch) => {
        const cp = ch.codePointAt(0) as number;
        return `&${names[cp] ?? `#${cp}`};`;
      })
      .join("");
    return put(`<a href="mailto:${obfuscated}">${obfuscated}</a>`);
  });
  // Raw inline HTML and entities pass through untouched.
  text = text.replace(/<(\/?[a-zA-Z][^<>@ ]*( [^<>]*)?|!--(?:(?!<!--|-->)[\s\S])*--)>/g, (m) =>
    put(m),
  );
  text = text.replace(/&(?:#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z0-9]+);/g, (m) => put(m));

  // Everything left is text.
  text = escapeHtml(text);

  // Lone asterisks and underscores surrounded by space are not emphasis.
  text = text.replace(/(^|(?<=\s))(\*{1,3}|_{1,3})(?=\s|$)/g, (m) => put(m));

  // Images, then links.
  text = text.replace(
    /!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
    (_, alt: string, src: string) => put(`<img alt="${alt}" src="${src}" />`),
  );
  text = text.replace(
    /\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
    (_, label: string, href: string) => `<a href="${href}">${label}</a>`,
  );

  // Emphasis, asterisks first (they work mid-word), then "smart" underscores.
  text = text.replace(/\*\*\*([\s\S]+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  text = text.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(
    /(?<![\p{L}\p{N}_])___(?!_)([\s\S]+?)(?<!_)___(?![\p{L}\p{N}_])/gu,
    "<strong><em>$1</em></strong>",
  );
  text = text.replace(
    /(?<![\p{L}\p{N}_])__(?!_)([\s\S]+?)(?<!_)__(?![\p{L}\p{N}_])/gu,
    "<strong>$1</strong>",
  );
  text = text.replace(
    /(?<![\p{L}\p{N}_])_(?!_)([\s\S]+?)(?<!_)_(?![\p{L}\p{N}_])/gu,
    "<em>$1</em>",
  );

  // Hard line breaks.
  text = text.replace(/ {2,}\n/g, "<br />\n");

  // Put the stashed pieces back (they may nest).
  const placeholder = new RegExp(`${STX}(\\d+)${ETX}`, "g");
  while (placeholder.test(text)) {
    placeholder.lastIndex = 0;
    text = text.replace(placeholder, (_, i: string) => stash[Number(i)] ?? "");
  }
  return text;
}

/** Split a table row into cells, dropping the border pipes. */
function splitTableRow(row: string): string[] {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
  return r.split(/(?<!\\)\|/).map((c) => c.trim());
}

function isTable(block: string): boolean {
  const rows = block.split("\n").map((r) => r.replace(/^ +| +$/g, ""));
  if (rows.length < 2) return false;
  const header0 = rows[0] as string;
  const border = header0.startsWith("|") || /(?<!\\)\|$/.test(header0);
  const columns = splitTableRow(header0).length;
  if (columns <= 1 && !border) return false;
  const separator = splitTableRow(rows[1] as string);
  return separator.length === columns && /^[|:\- ]*$/.test(separator.join("")) && rows[1] !== "";
}

function tableToHtml(block: string): string {
  const rows = block.split("\n");
  const header = splitTableRow(rows[0] as string);
  const cell = (tag: string, text: string) => `<${tag}>${inlineToHtml(text)}</${tag}>`;
  const out = ["<table>", "<thead>", "<tr>"];
  for (const h of header) out.push(cell("th", h));
  out.push("</tr>", "</thead>", "<tbody>");
  for (const row of rows.slice(2)) {
    const cells = splitTableRow(row);
    out.push("<tr>");
    for (let i = 0; i < header.length; i++) out.push(cell("td", cells[i] ?? ""));
    out.push("</tr>");
  }
  out.push("</tbody>", "</table>");
  return out.join("\n");
}

const LIST_ITEM_RE = /^[ ]{0,3}(?:\d+\.|[*+-])[ ]+([\s\S]*)$/;
const OLIST_RE = /^[ ]{0,3}\d+\.[ ]+/;
const ULIST_RE = /^[ ]{0,3}[*+-][ ]+/;
const HR_RE = /^[ ]{0,3}(?:(?:-+[ ]{0,2}){3,}|(?:_+[ ]{0,2}){3,}|(?:\*+[ ]{0,2}){3,})[ ]*$/m;
const HASH_HEADER_RE = /(?:^|\n)(#{1,6})((?:\\[\s\S]|[^\\])*?)#*(?:\n|$)/;
const SETEXT_RE = /^.*?\n[=-]+[ ]*(?:\n|$)/;
const QUOTE_RE = /(^|\n)[ ]{0,3}>[ ]?(.*)/;

function listToHtml(block: string, ordered: boolean): string {
  const items: string[] = [];
  for (const line of block.split("\n")) {
    const m = LIST_ITEM_RE.exec(line);
    if (m && !line.startsWith("    ")) {
      items.push(m[1] as string);
    } else if (items.length > 0) {
      const continuation = line.startsWith("    ") ? line.slice(4) : line;
      items[items.length - 1] = `${items[items.length - 1]}\n${continuation}`;
    } else {
      items.push(line);
    }
  }
  const tag = ordered ? "ol" : "ul";
  return [`<${tag}>`, ...items.map((item) => `<li>${inlineToHtml(item)}</li>`), `</${tag}>`].join(
    "\n",
  );
}

/** Block-level Markdown -> HTML for one block (text between blank lines). */
function blockToHtml(block: string, options: { tables: boolean }, out: string[]): void {
  if (!block.trim()) return;

  if (options.tables && isTable(block)) {
    out.push(tableToHtml(block));
    return;
  }

  if (block.startsWith("    ")) {
    const code = block
      .split("\n")
      .map((l) => (l.startsWith("    ") ? l.slice(4) : l))
      .join("\n");
    out.push(`<pre><code>${escapeHtml(code.replace(/\n+$/, ""))}\n</code></pre>`);
    return;
  }

  const hash = HASH_HEADER_RE.exec(block);
  if (hash) {
    const before = block.slice(0, hash.index);
    const after = block.slice(hash.index + hash[0].length);
    if (before) blockToHtml(before, options, out);
    const level = (hash[1] as string).length;
    out.push(`<h${level}>${inlineToHtml((hash[2] as string).trim())}</h${level}>`);
    if (after) blockToHtml(after, options, out);
    return;
  }

  if (SETEXT_RE.test(block)) {
    const lines = block.split("\n");
    const level = (lines[1] as string).startsWith("=") ? 1 : 2;
    out.push(`<h${level}>${inlineToHtml((lines[0] as string).trim())}</h${level}>`);
    const rest = lines.slice(2).join("\n");
    if (rest) blockToHtml(rest, options, out);
    return;
  }

  const hr = HR_RE.exec(block);
  if (hr) {
    const before = block.slice(0, hr.index).replace(/\n$/, "");
    const after = block.slice(hr.index + hr[0].length).replace(/^\n/, "");
    if (before) blockToHtml(before, options, out);
    out.push("<hr />");
    if (after) blockToHtml(after, options, out);
    return;
  }

  if (OLIST_RE.test(block) || ULIST_RE.test(block)) {
    out.push(listToHtml(block, OLIST_RE.test(block)));
    return;
  }

  const quote = QUOTE_RE.exec(block);
  if (quote) {
    const before = block.slice(0, quote.index);
    if (before) blockToHtml(before, options, out);
    const quoted = block
      .slice(quote.index)
      .replace(/^\n/, "")
      .split("\n")
      .map((l) => l.replace(/^[ ]{0,3}>[ ]?/, ""))
      .join("\n");
    const inner: string[] = [];
    for (const b of quoted.split(/\n[ ]*\n/)) blockToHtml(b, options, inner);
    out.push(["<blockquote>", ...inner, "</blockquote>"].join("\n"));
    return;
  }

  out.push(`<p>${inlineToHtml(block.replace(/^\s+/, ""))}</p>`);
}

/**
 * Convert Markdown to HTML following Python-Markdown's rules for the common
 * constructs. With `tables`, pipe tables become `<table>` elements (the
 * "tables" extension upstream).
 */
function markdownToHtml(source: string, options: { tables: boolean }): string {
  if (!source.trim()) return "";
  source = source.replace(new RegExp(`[${STX}${ETX}]`, "g"), "");
  source = source.replace(/\r\n?/g, "\n");
  // Expand tabs to 4-column stops.
  source = source
    .split("\n")
    .map((line) => {
      let col = 0;
      let res = "";
      for (const ch of line) {
        if (ch === "\t") {
          const n = 4 - (col % 4);
          res += " ".repeat(n);
          col += n;
        } else {
          res += ch;
          col += 1;
        }
      }
      return res;
    })
    .join("\n");
  source = source.replace(/(?<=\n) +\n/g, "\n");

  const out: string[] = [];
  for (const block of source.split(/\n\n+/)) {
    blockToHtml(block.replace(/^\n+|\n+$/g, ""), options, out);
  }
  return out.join("\n").trim();
}
