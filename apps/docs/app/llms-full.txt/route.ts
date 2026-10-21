import { docsLlms } from "@/lib/source";

// Written to out/llms-full.txt at build time: the docs are a static site.
export const dynamic = "force-static";
export const revalidate = false;

export async function GET() {
  return new Response(await docsLlms.full(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
