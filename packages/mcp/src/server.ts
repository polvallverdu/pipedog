// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** The MCP server: the docs tools and a `pipedog://docs/<slug>` resource per page. */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Docs } from "./docs.ts";
import { VERSION } from "./version.ts";

export interface ServerOptions {
  /** Resolves to the docs to answer from (it may be fetched on first use, in live mode). */
  docs: () => Promise<Docs>;
}

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  ...(isError ? { isError: true } : {}),
});

export const RESOURCE_PREFIX = "pipedog://docs/";

const INSTRUCTIONS = `Documentation for pipedog, the TypeScript port of Pipecat (real-time voice and multimodal AI agents for Bun, Node, Deno and Cloudflare Workers; packages @pipedog/*).
Use search_docs to find the page for a task, read_page to read it in full, list_pages to browse by section, and get_api for an exported class or function's constructor options and signature. Prefer these docs over memory of Pipecat (Python): names are camelCased and options are objects.`;

export function createServer(options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: "pipedog-docs", title: "pipedog docs", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "list_pages",
    {
      title: "List docs pages",
      description:
        "List the pipedog docs pages with their slugs, titles and descriptions, by section. Optionally only one section: a sidebar section (e.g. 'Services', 'Frameworks', 'Deployment'), a group ('Speech-to-text') or a slug prefix ('services/stt').",
      inputSchema: {
        section: z
          .string()
          .optional()
          .describe("Only pages in this section, group or slug prefix."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ section }) => {
      const docs = await options.docs();
      const pages = docs.list(section);
      if (pages.length === 0) {
        return text(
          `No pages in section "${section}". Sections: ${docs.sections().join(", ")}. A slug prefix such as "services/stt" also works.`,
          true,
        );
      }
      const lines: string[] = [];
      let current = "";
      for (const p of pages) {
        const heading = p.group ? `${p.section} / ${p.group}` : p.section;
        if (heading !== current) {
          lines.push("", `## ${heading}`);
          current = heading;
        }
        lines.push(
          `- \`${p.slug}\`: ${p.title}${p.comingSoon ? " (coming soon, not ported)" : ""}${p.description ? ` - ${p.description}` : ""}`,
        );
      }
      return text(
        `${pages.length} pages (pipedog ${docs.version}, ${docs.source}). Read one with read_page(slug).\n${lines.join("\n")}`,
      );
    },
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search the docs",
      description:
        "Keyword search over the pipedog docs (BM25 over page sections). Returns the best sections with their page slug, title, heading and a snippet. Use read_page on a slug for the full page.",
      inputSchema: {
        query: z.string().min(1).describe("Words to look for, e.g. 'deepgram interim results'."),
        limit: z.number().int().min(1).max(50).optional().describe("How many results (default 8)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const docs = await options.docs();
      const results = docs.search(query, limit ?? 8);
      if (results.length === 0) {
        return text(`No results for "${query}". Try other words, or list_pages.`);
      }
      const lines = results.map(
        (r, i) =>
          `${i + 1}. ${r.title}${r.heading !== r.title ? ` > ${r.heading}` : ""}\n   slug: ${r.slug}${r.anchor ? `#${r.anchor}` : ""}\n   ${r.snippet}`,
      );
      return text(lines.join("\n\n"));
    },
  );

  server.registerTool(
    "read_page",
    {
      title: "Read a docs page",
      description:
        "Read a pipedog docs page as Markdown, by slug (e.g. 'services/stt/deepgram', 'concepts/frames', 'index' for the home page). A page URL or its .md URL also works.",
      inputSchema: {
        slug: z.string().describe("The page slug from list_pages or search_docs."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const docs = await options.docs();
      const page = docs.page(slug);
      if (!page) {
        const similar = docs.similar(slug);
        return text(
          `No page "${slug}".${similar.length ? ` Did you mean: ${similar.join(", ")}?` : ""} Use list_pages or search_docs to find slugs.`,
          true,
        );
      }
      return text(page.markdown);
    },
  );

  server.registerTool(
    "get_api",
    {
      title: "Look up an API",
      description:
        "Look up an exported class, function, interface or type of the @pipedog/* packages (e.g. 'DeepgramSTTService', 'PipelineWorker', 'createTask'). Returns the import path, the constructor and its options interface, the full declaration from the package's .d.ts, and the docs pages that mention it.",
      inputSchema: {
        symbol: z
          .string()
          .min(1)
          .describe(
            "The exported name. '@pipedog/<pkg>:Name' picks one package when several export the name.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ symbol }) => {
      const docs = await options.docs();
      if (docs.snapshot.api.length === 0) {
        return text("The API index is not available in this snapshot. Use search_docs.", true);
      }
      const result = docs.api.describe(symbol);
      return text(result.text, !result.found);
    },
  );

  server.registerResource(
    "docs-page",
    new ResourceTemplate(`${RESOURCE_PREFIX}{+slug}`, {
      list: async () => {
        const docs = await options.docs();
        return {
          resources: docs.pages.map((p) => ({
            uri: `${RESOURCE_PREFIX}${p.slug}`,
            name: p.slug,
            title: p.title,
            description: p.description,
            mimeType: "text/markdown",
          })),
        };
      },
    }),
    {
      title: "pipedog docs page",
      description: "A page of the pipedog docs, as Markdown.",
      mimeType: "text/markdown",
    },
    async (uri, { slug }) => {
      const docs = await options.docs();
      const page = docs.page(String(slug));
      if (!page) throw new Error(`No docs page ${uri.href}`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: page.markdown }] };
    },
  );

  server.registerResource(
    "llms-txt",
    "pipedog://llms.txt",
    {
      title: "pipedog llms.txt",
      description: "The docs index: every page by section, with its description.",
      mimeType: "text/plain",
    },
    async (uri) => {
      const docs = await options.docs();
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: docs.snapshot.llmsTxt }] };
    },
  );

  return server;
}
