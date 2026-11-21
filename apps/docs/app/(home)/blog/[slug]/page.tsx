// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/components/mdx";
import { blog } from "@/lib/source";
import { formatPostDate } from "../format";

interface PageProps {
  params: Promise<{ slug: string }>;
}

const labels = {
  en: { back: "All posts", by: "By", other: "Leer en español" },
  es: { back: "Todas las entradas", by: "Por", other: "Read in English" },
} as const;

export default async function BlogPost(props: PageProps) {
  const { slug } = await props.params;
  const post = blog.getPage([slug]);
  if (!post) notFound();
  const MDX = post.data.body;
  const t = labels[post.data.lang];
  const translation = post.data.translation ? blog.getPage([post.data.translation]) : undefined;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:py-16" lang={post.data.lang}>
      <Link href="/blog" className="text-sm text-fd-muted-foreground hover:text-fd-foreground">
        ← {t.back}
      </Link>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">{post.data.title}</h1>
      {post.data.description ? (
        <p className="mt-3 text-lg text-fd-muted-foreground">{post.data.description}</p>
      ) : null}
      <p className="mt-4 flex flex-wrap gap-x-3 text-sm text-fd-muted-foreground">
        <span>
          {t.by} {post.data.author}
        </span>
        <span aria-hidden>·</span>
        <time dateTime={post.data.date}>{formatPostDate(post.data.date, post.data.lang)}</time>
        {translation ? (
          <>
            <span aria-hidden>·</span>
            <Link href={translation.url} className="text-fd-primary hover:underline">
              {t.other}
            </Link>
          </>
        ) : null}
      </p>
      <article className="prose mt-10 max-w-none">
        <MDX components={getMDXComponents()} />
      </article>
    </main>
  );
}

export function generateStaticParams() {
  return blog.getPages().map((post) => ({ slug: post.slugs[0] }));
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { slug } = await props.params;
  const post = blog.getPage([slug]);
  if (!post) notFound();
  return {
    title: post.data.title,
    description: post.data.description,
    authors: [{ name: post.data.author }],
    openGraph: {
      type: "article",
      title: post.data.title,
      description: post.data.description,
      publishedTime: post.data.date,
      authors: [post.data.author],
      locale: post.data.lang === "es" ? "es_ES" : "en_US",
      images: [{ url: "/og.png", width: 1280, height: 640 }],
    },
    twitter: { card: "summary_large_image", images: ["/og.png"] },
  };
}
