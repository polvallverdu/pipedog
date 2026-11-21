// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import type { Metadata } from "next";
import Link from "next/link";
import { blogPostsByDate } from "@/lib/source";
import { formatPostDate } from "./format";

export const metadata: Metadata = {
  title: "Blog",
  description: "Announcements and write-ups from pipedog.",
};

export default function BlogIndex() {
  const posts = blogPostsByDate();
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:py-16">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Blog</h1>
      <p className="mt-2 text-fd-muted-foreground">Announcements and write-ups from pipedog.</p>
      <ul className="mt-10 flex flex-col gap-4">
        {posts.map((post) => (
          <li key={post.url}>
            <Link
              href={post.url}
              className="block rounded-xl border bg-fd-card p-5 transition-colors hover:bg-fd-accent"
            >
              <p className="text-sm text-fd-muted-foreground">
                <time dateTime={post.data.date}>
                  {formatPostDate(post.data.date, post.data.lang)}
                </time>
                {post.data.lang === "es" ? " · Español" : null}
              </p>
              <h2 className="mt-1 text-lg font-semibold">{post.data.title}</h2>
              {post.data.description ? (
                <p className="mt-1 text-fd-muted-foreground">{post.data.description}</p>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
