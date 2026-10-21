import { llms, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";
import { docs } from "@/.source/server";
import { docsRoute, markdownPath, siteUrl } from "./shared";

export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

export type DocsPage = NonNullable<ReturnType<typeof source.getPage>>;

/** Absolute URLs for a page: the HTML page and its Markdown. */
export function pageUrls(page: { url: string }) {
  return {
    html: `${siteUrl}${page.url}/`,
    markdown: `${siteUrl}${markdownPath(page.url)}`,
  };
}

/** Point the site-relative links in Markdown at the absolute Markdown versions of the pages. */
function absoluteLinks(markdown: string): string {
  return markdown.replace(/\]\((\/docs(?:\/[^)#\s]*)?)(#[^)\s]*)?\)/g, (_, path: string, hash) =>
    hash ? `](${siteUrl}${path.replace(/\/$/, "")}/${hash})` : `](${siteUrl}${markdownPath(path)})`,
  );
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

interface TypeTableEntry {
  name: string;
  description?: string;
  type?: string;
  simplifiedType?: string;
  required?: boolean;
  deprecated?: boolean;
}

const cell = (text: string) =>
  text
    .replace(/\s*\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();

/**
 * `<auto-type-table>` compiles to a `<TypeTable type="{json}">` element, which is unreadable in
 * Markdown. Render it as a Markdown table instead.
 */
function typeTablesToMarkdown(markdown: string): string {
  return markdown.replace(/<TypeTable\s[^>]*?type="([^"]*)"[^>]*?\/>/g, (element, json: string) => {
    let entries: TypeTableEntry[];
    try {
      entries = (JSON.parse(decodeEntities(json)) as { entries: TypeTableEntry[] }).entries;
    } catch {
      return element;
    }
    const rows = entries.map(
      (entry) =>
        `| \`${entry.name}\` | \`${cell(entry.type ?? entry.simplifiedType ?? "")}\` | ${entry.required ? "yes" : "no"} | ${entry.deprecated ? "Deprecated. " : ""}${cell(entry.description ?? "")} |`,
    );
    return ["| Option | Type | Required | Description |", "|---|---|---|---|", ...rows].join("\n");
  });
}

/** llms.txt, llms-full.txt and the per-page Markdown. */
export const docsLlms = llms(source, {
  renderPage: async (page) => {
    const urls = pageUrls(page);
    const body = typeTablesToMarkdown(await page.data.getText("processed"));
    return absoluteLinks(
      [
        `# ${page.data.title}`,
        "",
        page.data.description ? `> ${page.data.description}` : "",
        "",
        `Source: ${urls.html}`,
        "",
        body,
      ].join("\n"),
    );
  },
});

/** llms.txt: every page, by section, with absolute links to its Markdown. */
export async function llmsIndex(): Promise<string> {
  const index = absoluteLinks(await docsLlms.index());
  return [
    index.replace(
      /^# .*\n/,
      (title) =>
        `${title}\n> pipedog is an unofficial TypeScript port of Pipecat, the framework for real-time voice and multimodal AI agents, for Bun, Node, Deno and Cloudflare Workers.\n\nEvery page is also available as Markdown: append \`.md\` to its URL. All pages in one file: ${siteUrl}/llms-full.txt\n`,
    ),
  ].join("\n");
}
