import Link from "next/link";
import { AttributionNotice } from "@/components/attribution";

export default function HomePage() {
  return (
    <main className="flex flex-col flex-1 items-center justify-center px-6 py-16 text-center">
      <h1 className="text-4xl font-bold mb-4">pipedog</h1>
      <p className="text-lg text-fd-muted-foreground max-w-2xl mb-8">
        An unofficial TypeScript port of Pipecat, the framework for real-time voice and multimodal
        conversational AI. Same frames, processors, pipelines and wire protocols, for Bun, Node,
        Deno and Cloudflare Workers.
      </p>
      <div className="flex flex-wrap gap-3 justify-center">
        <Link
          href="/docs"
          className="rounded-lg bg-fd-primary text-fd-primary-foreground px-5 py-2.5 font-medium"
        >
          Read the docs
        </Link>
        <Link href="/docs/quickstart" className="rounded-lg border px-5 py-2.5 font-medium">
          Quickstart
        </Link>
        <Link
          href="/docs/coming-from-pipecat"
          className="rounded-lg border px-5 py-2.5 font-medium"
        >
          Coming from Pipecat (Python)
        </Link>
      </div>
      <AttributionNotice className="max-w-2xl mt-16" />
    </main>
  );
}
