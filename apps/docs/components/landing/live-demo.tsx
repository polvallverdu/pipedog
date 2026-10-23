// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

"use client";

/**
 * The live voice demo, embedded: an iframe of the demo's own page (examples/landing-demo, a
 * SvelteKit page served by its Cloudflare Worker), at NEXT_PUBLIC_DEMO_URL. The iframe follows
 * the site's theme (?theme= at load, then a postMessage on every toggle) and takes the height
 * the page reports. Without a demo URL at build time, a placeholder stands in: the static site
 * never shows a broken frame.
 */

import { ArrowUpRight, Mic } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const DEMO_URL = process.env.NEXT_PUBLIC_DEMO_URL?.replace(/\/+$/, "") ?? "";

function currentTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function LiveDemo() {
  const frame = useRef<HTMLIFrameElement>(null);
  // Decided in the browser: the theme isn't known when the page is prerendered.
  const [src, setSrc] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  // The iframe's color-scheme must match its page's, or the browser paints it an opaque backdrop.
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    if (!DEMO_URL) return;
    const origin = new URL(DEMO_URL).origin;
    setSrc(`${DEMO_URL}/?embed=1&theme=${currentTheme()}`);
    setTheme(currentTheme());

    // The site toggles the theme with a class on <html>: pass it on.
    const observer = new MutationObserver(() => {
      setTheme(currentTheme());
      frame.current?.contentWindow?.postMessage(
        { type: "pipedog-theme", theme: currentTheme() },
        origin,
      );
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.data?.type !== "pipedog-demo-height") return;
      const h = Number(event.data.height);
      if (Number.isFinite(h) && h > 200 && h < 4000) setHeight(h);
    };
    window.addEventListener("message", onMessage);
    return () => {
      observer.disconnect();
      window.removeEventListener("message", onMessage);
    };
  }, []);

  if (!DEMO_URL) return <DemoPlaceholder />;

  return (
    <div className="relative">
      {src ? (
        <iframe
          ref={frame}
          src={src}
          title="pipedog live voice demo"
          allow="microphone; autoplay"
          loading="lazy"
          className={`block w-full rounded-[1.25rem] border-0 bg-transparent ${
            // Until the page reports its height: about what it is at each width.
            height === null ? "h-[640px] max-[960px]:h-[980px] max-[640px]:h-[1180px]" : ""
          }`}
          style={{ height: height ?? undefined, colorScheme: theme }}
        />
      ) : (
        <div className="h-[640px] rounded-[1.25rem] border bg-fd-card" />
      )}
      <p className="mt-3 text-center text-xs text-fd-muted-foreground">
        Opens your microphone when you press it.{" "}
        <a
          href={DEMO_URL}
          className="inline-flex items-center gap-0.5 font-medium text-fd-foreground underline decoration-fd-primary/50 underline-offset-4 hover:decoration-fd-primary"
        >
          Open it full page <ArrowUpRight className="size-3" />
        </a>
      </p>
    </div>
  );
}

function DemoPlaceholder() {
  return (
    <div className="relative overflow-hidden rounded-3xl border bg-fd-card px-6 py-12 text-center sm:px-12">
      <div aria-hidden className="pd-glow pointer-events-none absolute inset-0" />
      <span className="relative mx-auto inline-flex size-14 items-center justify-center rounded-full bg-fd-muted text-fd-muted-foreground">
        <Mic className="size-6" />
      </span>
      <p className="relative mt-4 font-medium">The live demo is coming soon.</p>
      <p className="relative mx-auto mt-2 max-w-md text-sm text-fd-muted-foreground">
        A voice agent you can talk to, running on Cloudflare Workers and Durable Objects. Until it's
        on, run it yourself from the repository.
      </p>
      <a
        href="https://github.com/polvallverdu/pipedog/tree/main/examples/landing-demo"
        className="relative mt-5 inline-flex items-center gap-1 rounded-xl border bg-fd-background px-4 py-2 text-sm font-medium transition-colors hover:bg-fd-accent"
      >
        examples/landing-demo <ArrowUpRight className="size-3.5" />
      </a>
    </div>
  );
}
