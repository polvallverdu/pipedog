import { Banner } from "fumadocs-ui/components/banner";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Analytics } from "@/components/analytics";
import { siteUrl } from "@/lib/shared";
import "./global.css";

// Self-hosted by next/font at build time: no request to Google from the browser.
const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: {
    template: "%s | pipedog",
    default: "pipedog: real-time voice AI in TypeScript",
  },
  description:
    "Documentation for pipedog, an unofficial TypeScript port of Pipecat for Bun, Node, Deno and Cloudflare Workers.",
  metadataBase: new URL(`${siteUrl}/`),
  // The link preview (public/og.png, also the repository's social preview in .github/assets).
  openGraph: {
    siteName: "pipedog",
    type: "website",
    images: [
      {
        url: "og.png",
        width: 1280,
        height: 640,
        alt: "pipedog: real-time voice AI agents, in TypeScript",
      },
    ],
  },
  twitter: { card: "summary_large_image", images: ["og.png"] },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fdfcfa" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1117" },
  ],
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider search={{ options: { type: "static" } }}>
          <Banner id="unofficial-notice">
            pipedog is an unofficial community port of Pipecat, not affiliated with Daily.
          </Banner>
          {children}
        </RootProvider>
        <Analytics />
      </body>
    </html>
  );
}
