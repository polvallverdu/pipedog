import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AttributionNotice } from "@/components/attribution";
import { FileLink, getMDXComponents } from "@/components/mdx";
import { basePath, contentDir, markdownPath, repoUrl, siteUrl } from "@/lib/shared";
import { pageUrls, source } from "@/lib/source";

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

export default async function Page(props: PageProps) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  // The page actions prefix relative URLs with import.meta.env.BASE_URL, which the Next build
  // also sets, so a basePath-prefixed path came out as /pipedog/pipedog/... An absolute URL is
  // left alone. Locally there is no basePath and the plain path works.
  const markdownUrl = basePath ? `${siteUrl}${markdownPath(page.url)}` : markdownPath(page.url);

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row flex-wrap gap-2 items-center border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl}>Copy page</MarkdownCopyButton>
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`${repoUrl}/blob/main/${contentDir}/${page.path}`}
          pageUrl={pageUrls(page).html}
        />
      </div>
      <DocsBody>
        <MDX components={getMDXComponents({ a: createRelativeLink(source, page, FileLink) })} />
        <AttributionNotice />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { types: { "text/markdown": `${basePath}${markdownPath(page.url)}` } },
  };
}
