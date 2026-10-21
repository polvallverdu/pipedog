import { notFound } from "next/navigation";
import { docsLlms, source } from "@/lib/source";

// Each page's Markdown, rendered at build time to out/llms.mdx/docs/<slug>/content.md.
// scripts/markdown-files.ts then moves it next to the page, as /docs/<slug>.md.
export const dynamic = "force-static";
export const revalidate = false;

export async function GET(_request: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  // Drop the trailing "content.md".
  const page = source.getPage(slug?.slice(0, -1) ?? []);
  if (!page) notFound();

  return new Response(await docsLlms.page(page), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

export function generateStaticParams() {
  return source.generateParams().map((item) => ({ slug: [...(item.slug ?? []), "content.md"] }));
}
