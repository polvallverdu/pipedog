// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ServerCodeBlock } from "fumadocs-ui/components/codeblock.rsc";
import { ArrowRight, ArrowUpRight, Boxes, Cable, Gauge, Plug, Terminal, Zap } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AttributionNotice } from "@/components/attribution";
import { CopyCommand } from "@/components/copy-command";
import { PipelineDiagram } from "@/components/landing/pipeline-diagram";
import { Logo } from "@/components/logo";
import { compatibleLlm, ported } from "@/data/providers";
import { repoUrl } from "@/lib/shared";

// Counted from the repository at build time, so the page can't drift from it.
const packagesDir = join(process.cwd(), "../../packages");
const packageCount = readdirSync(packagesDir, { withFileTypes: true }).filter((d) =>
  d.isDirectory(),
).length;
const serviceSections = ["llm", "stt", "tts", "s2s", "image", "video"] as const;
const providerPackages = [
  ...new Set([
    ...serviceSections.flatMap((s) => ported[s].map((p) => p.pkg)),
    ...compatibleLlm.map((p) => p.pkg),
  ]),
].sort();
const counts = {
  llm: ported.llm.length,
  stt: ported.stt.length,
  tts: ported.tts.length,
  s2s: ported.s2s.length,
  transports: ported.transports.length,
  serializers: ported.serializers.length,
};

// From the README quickstart (the voice bot), unchanged; the transport and the aggregators are
// set up above this in the full file.
const pipelineCode = `import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { OpenAISTTService } from "@pipedog/openai/stt";
import { OpenAITTSService } from "@pipedog/openai/tts";

// … apiKey, the transport and the context aggregators, as in the full bot

const stt = new OpenAISTTService({ apiKey });
const llm = new OpenAILLMService({
  apiKey,
  settings: new OpenAILLMSettings({
    systemInstruction: "You are a helpful voice assistant. Keep replies short; they are spoken.",
  }),
});
const tts = new OpenAITTSService({ apiKey, sampleRate: 24000 });

const pipeline = new Pipeline([
  transport.input(),
  stt,
  aggregators.user(),
  llm,
  tts,
  transport.output(),
  aggregators.assistant(),
]);`;

const runtimes = [
  { name: "Bun", note: "runs the TypeScript directly", dot: "bg-amber-200 dark:bg-amber-100" },
  { name: "Node.js", note: "22 or later", dot: "bg-emerald-500" },
  { name: "Deno", note: "npm: specifiers", dot: "bg-fd-foreground" },
  { name: "Cloudflare Workers", note: "with nodejs_compat", dot: "bg-orange-500" },
];

const stats = [
  {
    value: "2.5–3.4×",
    label: "frame throughput",
    detail: "of Pipecat on CPython 3.13, on every runtime",
  },
  {
    value: "5–7×",
    label: "lower per-frame latency",
    detail: "on Bun, Node and Deno",
  },
  {
    value: "~45 ms",
    label: "cold start",
    detail: "on Bun, against 401 ms on CPython",
  },
  {
    value: String(packageCount),
    label: "packages",
    detail: "released together under @pipedog",
  },
];

export default function HomePage() {
  return (
    <main className="relative flex flex-1 flex-col overflow-x-clip">
      {/* Hero */}
      <section className="relative">
        <div aria-hidden className="pd-grid-bg pointer-events-none absolute inset-0 -z-10" />
        <div aria-hidden className="pd-glow pointer-events-none absolute inset-0 -z-10" />
        <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pt-14 pb-16 sm:px-6 md:pt-20 lg:grid-cols-[1.1fr_1fr] lg:gap-16 lg:pt-24 lg:pb-24">
          <div className="flex flex-col items-start">
            <Link
              href="/docs/guides/coming-from-pipecat"
              className="group mb-6 inline-flex items-center gap-2 rounded-full border bg-fd-card/80 py-1 ps-1 pe-3 text-xs text-fd-muted-foreground backdrop-blur transition-colors hover:text-fd-foreground"
            >
              <span className="rounded-full bg-fd-primary/12 px-2 py-0.5 font-medium text-fd-primary">
                Pipecat
              </span>
              ported to TypeScript, API-compatible
              <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <h1 className="text-[2.6rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl lg:text-[4.25rem]">
              Real-time voice agents, <span className="pd-gradient-text">in TypeScript.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg text-pretty text-fd-muted-foreground">
              pipedog runs Pipecat's frame pipelines (transport, speech-to-text, LLM,
              text-to-speech) on Bun, Node, Deno and Cloudflare Workers. Same classes, same frames,
              same wire protocols.
            </p>
            <div className="mt-8 w-full max-w-md">
              <CopyCommand command="bunx @pipedog/cli init" />
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link
                href="/docs"
                className="inline-flex items-center gap-2 rounded-xl bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground shadow-sm transition-[filter,transform] hover:brightness-110 active:translate-y-px"
              >
                Get started
                <ArrowRight className="size-4" />
              </Link>
              <a
                href={repoUrl}
                className="inline-flex items-center gap-2 rounded-xl border bg-fd-card/80 px-5 py-2.5 font-medium backdrop-blur transition-colors hover:bg-fd-accent"
              >
                <GitHubIcon className="size-4" />
                GitHub
              </a>
            </div>
          </div>
          <PipelineDiagram />
        </div>
      </section>

      {/* Performance */}
      <section className="border-y bg-fd-card/50">
        <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-4">
            {stats.map((s) => (
              <div key={s.label} className="flex flex-col">
                <dt className="order-2 mt-1 text-sm font-medium">{s.label}</dt>
                <dd className="order-1 font-mono text-3xl font-semibold tracking-tight text-fd-primary sm:text-4xl">
                  {s.value}
                </dd>
                <dd className="order-3 mt-0.5 text-xs text-fd-muted-foreground">{s.detail}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-8 text-xs text-fd-muted-foreground">
            The same 10-processor pipeline in pipedog and in Pipecat, on one machine.{" "}
            <Link
              href="/docs/performance"
              className="font-medium text-fd-foreground underline underline-offset-4 decoration-fd-primary/50 hover:decoration-fd-primary"
            >
              Methodology and full results
            </Link>
          </p>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 md:py-24">
        <SectionHeading
          eyebrow="Why pipedog"
          title="Pipecat's architecture, where your app already runs."
        />
        <div className="mt-12 grid gap-4 md:grid-cols-6">
          <Feature
            className="md:col-span-3"
            icon={<Zap />}
            title="Runs everywhere"
            href="/docs/guides/runtimes"
          >
            <p>
              The core is runtime-agnostic: no <code>node:*</code> imports, no <code>Buffer</code>.
              Support per package is recorded from real runs, not by hand.
            </p>
            <ul className="mt-5 grid gap-2 sm:grid-cols-2">
              {runtimes.map((r) => (
                <li
                  key={r.name}
                  className="flex items-start gap-2.5 rounded-lg border bg-fd-background px-3 py-2"
                >
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${r.dot}`} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-fd-foreground">{r.name}</span>
                    <span className="block text-xs">{r.note}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Feature>
          <Feature
            className="md:col-span-3"
            icon={<Plug />}
            title="Pipecat-compatible"
            href="/docs/guides/coming-from-pipecat"
          >
            <p>
              The same frames, processors, events and wire protocols, with camelCase members.
              Pipecat's client SDKs (<code>@pipecat-ai/client-js</code>, voice-ui-kit) connect to a
              pipedog bot unchanged.
            </p>
            <div className="mt-5 overflow-hidden rounded-lg border bg-fd-background font-mono text-[0.75rem] leading-relaxed">
              <div className="flex gap-3 border-b px-3 py-2">
                <span className="w-6 shrink-0 text-fd-muted-foreground select-none">py</span>
                <span className="min-w-0 break-words">
                  from pipecat.pipeline.worker import PipelineWorker
                </span>
              </div>
              <div className="flex gap-3 px-3 py-2">
                <span className="w-6 shrink-0 text-fd-primary select-none">ts</span>
                <span className="min-w-0 break-words text-fd-foreground">
                  import {"{ PipelineWorker }"} from "@pipedog/core/pipeline/worker"
                </span>
              </div>
            </div>
          </Feature>
          <Feature
            className="md:col-span-4"
            icon={<Boxes />}
            title={`${providerPackages.length} provider packages`}
            href="/docs/services"
          >
            <p>
              {counts.llm} LLM, {counts.stt} speech-to-text, {counts.tts} text-to-speech and{" "}
              {counts.s2s} speech-to-speech services, plus local models on ONNX Runtime. Install
              only the ones you use.
            </p>
            <ul className="mt-5 flex flex-wrap gap-1.5">
              {providerPackages.map((pkg) => (
                <li
                  key={pkg}
                  className="rounded-md border bg-fd-background px-2 py-0.5 font-mono text-[0.7rem]"
                >
                  {pkg.replace("@pipedog/", "")}
                </li>
              ))}
            </ul>
          </Feature>
          <Feature
            className="md:col-span-2"
            icon={<Cable />}
            title="Transports & telephony"
            href="/docs/transports"
          >
            <p>
              {counts.transports} transports (WebSocket, SmallWebRTC, LiveKit, WhatsApp, local
              audio) and {counts.serializers} serializers, among them Twilio, Telnyx, Plivo, Exotel,
              Vonage and Genesys.
            </p>
          </Feature>
          <Feature
            className="md:col-span-2"
            icon={<Terminal />}
            title="Batteries included"
            href="/docs/cli"
          >
            <p>
              The <code>pipedog</code> CLI scaffolds a project. The development runner, Pipecat
              Flows and evals are ported too.
            </p>
          </Feature>
          <Feature
            className="md:col-span-2"
            icon={<Gauge />}
            title="Less overhead"
            href="/docs/performance"
          >
            <p>
              Bundled with <code>bun build</code> to a few MB. Cold starts in tens of milliseconds,
              so a voice agent fits serverless and the edge.
            </p>
          </Feature>
          <Feature
            className="md:col-span-2"
            icon={<BookIcon />}
            title="Docs for your agent"
            href="/docs/guides/llms"
          >
            <p>
              llms.txt, every page as Markdown, and <code>@pipedog/mcp</code>, a local MCP server
              with these docs and every package's API.
            </p>
          </Feature>
        </div>
      </section>

      {/* Code */}
      <section className="border-t bg-fd-card/40">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-20 sm:px-6 md:py-24 lg:grid-cols-[0.7fr_1.3fr] lg:gap-12">
          <div>
            <SectionHeading eyebrow="A bot is a list" title="Processors in, frames through." />
            <p className="mt-5 text-fd-muted-foreground">
              Each service is a frame processor. Put them in a{" "}
              <code className="font-mono text-sm text-fd-foreground">Pipeline</code> in the order
              audio and text should travel, hand it to a worker, and connect a client. Swap a
              service for another provider's, or for a local model, and the rest stays.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/docs/voice-bot"
                className="inline-flex items-center gap-2 rounded-xl bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground hover:brightness-110"
              >
                Build the voice bot
                <ArrowRight className="size-4" />
              </Link>
              <Link
                href="/docs/quickstart"
                className="inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium hover:bg-fd-accent"
              >
                Quickstart, no API keys
              </Link>
            </div>
          </div>
          <div className="min-w-0 [&_figure]:my-0 [&_figure]:shadow-xl [&_pre]:text-[0.75rem]">
            <ServerCodeBlock
              code={pipelineCode}
              lang="ts"
              themes={{ light: "github-light", dark: "github-dark" }}
              codeblock={{ title: "bot.ts (excerpt)" }}
            />
          </div>
        </div>
      </section>

      {/* Call to action */}
      <section className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 md:py-24">
        <div className="relative overflow-hidden rounded-3xl border bg-fd-card px-6 py-12 text-center sm:px-12">
          <div aria-hidden className="pd-glow pointer-events-none absolute inset-0" />
          <h2 className="relative text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Ship a voice agent today.
          </h2>
          <p className="relative mx-auto mt-4 max-w-xl text-fd-muted-foreground">
            The CLI writes the bot, its client and a guide for your coding agent, for the services
            you pick.
          </p>
          <div className="relative mx-auto mt-8 max-w-sm text-start">
            <CopyCommand command="bunx @pipedog/cli init" />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="mt-auto border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6">
          <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-center">
            <Logo />
            <nav
              aria-label="Footer"
              className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-fd-muted-foreground"
            >
              <Link href="/docs" className="hover:text-fd-foreground">
                Docs
              </Link>
              <Link href="/docs/quickstart" className="hover:text-fd-foreground">
                Quickstart
              </Link>
              <Link href="/docs/services" className="hover:text-fd-foreground">
                Services
              </Link>
              <Link href="/docs/performance" className="hover:text-fd-foreground">
                Performance
              </Link>
              <Link href="/docs/roadmap" className="hover:text-fd-foreground">
                Roadmap
              </Link>
              <a href={repoUrl} className="inline-flex items-center gap-1 hover:text-fd-foreground">
                GitHub <ArrowUpRight className="size-3" />
              </a>
            </nav>
          </div>
          <AttributionNotice className="mt-0" />
        </div>
      </footer>
    </main>
  );
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <p className="font-mono text-xs font-medium tracking-widest text-fd-primary uppercase">
        {eyebrow}
      </p>
      <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        {title}
      </h2>
    </div>
  );
}

function Feature({
  icon,
  title,
  href,
  className,
  children,
}: {
  icon: ReactNode;
  title: string;
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`group relative flex flex-col rounded-2xl border bg-fd-card p-6 text-sm text-fd-muted-foreground transition-colors hover:border-fd-primary/40 [&_code]:font-mono [&_code]:text-[0.8em] [&_code]:text-fd-foreground ${className ?? ""}`}
    >
      <div className="mb-4 flex items-center justify-between">
        <span className="inline-flex size-9 items-center justify-center rounded-lg bg-fd-primary/10 text-fd-primary [&_svg]:size-4.5">
          {icon}
        </span>
        <Link
          href={href}
          aria-label={`${title}: read more`}
          className="rounded-md p-1 text-fd-muted-foreground transition-colors after:absolute after:inset-0 after:rounded-2xl hover:text-fd-primary group-hover:text-fd-primary"
        >
          <ArrowUpRight className="size-4" />
        </Link>
      </div>
      <h3 className="mb-2 text-base font-semibold text-fd-foreground">{title}</h3>
      {children}
    </div>
  );
}

function BookIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </svg>
  );
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.16 0 1.1-.01 1.99-.01 2.27 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
