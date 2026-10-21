import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// The search index is exported at build time, so the docs stay a static site.
export const dynamic = "force-static";
export const revalidate = false;

export const { staticGET: GET } = createFromSource(source);
