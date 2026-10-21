export const appName = "pipedog";
export const docsRoute = "/docs";

/** The pipedog repository (not Pipecat's). PIPEDOG_REPO_URL overrides it, for a fork. */
export const repoUrl: string =
  process.env.PIPEDOG_REPO_URL || "https://github.com/polvallverdu/pipedog";

/** Where the docs content lives in the repository, for "Open in GitHub" links. */
export const contentDir = "apps/docs/content/docs";

/** The Next.js basePath: "/pipedog" on GitHub Pages, empty locally. Same as next.config.mjs. */
export const basePath = process.env.DOCS_BASE_PATH ?? "";

/**
 * The site's absolute URL, used in llms.txt and the page actions, which hand links to tools that
 * run elsewhere. DOCS_SITE_ORIGIN overrides the GitHub Pages origin.
 */
export const siteUrl = `${process.env.DOCS_SITE_ORIGIN ?? "https://polvallverdu.github.io"}${basePath}`;

export const upstreamUrl = "https://github.com/pipecat-ai/pipecat";
export const upstreamDocsUrl = "https://github.com/pipecat-ai/docs";

/**
 * The Markdown version of a page: its URL plus ".md", as on Pipecat's docs.
 * `/docs` is `/docs.md`, `/docs/concepts/frames` is `/docs/concepts/frames.md`. The build writes
 * these files (see scripts/markdown-files.ts); this is the path without basePath.
 */
export function markdownPath(pageUrl: string): string {
  return `${pageUrl.replace(/\/$/, "")}.md`;
}

/** The route the Markdown is rendered at during the build, before it is moved to `markdownPath`. */
export const markdownRoute = "/llms.mdx";
