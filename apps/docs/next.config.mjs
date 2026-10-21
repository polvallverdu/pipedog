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

export default withMDX(config);
