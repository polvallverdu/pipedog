import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // A static site, for GitHub Pages. DOCS_BASE_PATH is "/pipedog" for a project page.
  output: "export",
  basePath: process.env.DOCS_BASE_PATH ?? "",
  trailingSlash: true,
  // Next 16 writes AGENTS.md / CLAUDE.md on `next dev` otherwise.
  agentRules: false,
  // Twoslash and AutoTypeTable run at MDX compile time only (source.config.ts);
  // keep the TypeScript 7 native compiler out of the server bundle.
  serverExternalPackages: ["typescript"],
};

// The build moves each page's Markdown to /docs/<slug>.md (scripts/markdown-files.ts). A static
// export can't rewrite, so only `next dev` serves those URLs through a rewrite.
if (process.env.NODE_ENV === "development") {
  config.rewrites = async () => [
    { source: "/docs.md", destination: "/llms.mdx/docs/content.md" },
    { source: "/docs/:slug*.md", destination: "/llms.mdx/docs/:slug*/content.md" },
  ];
}

export default withMDX(config);
