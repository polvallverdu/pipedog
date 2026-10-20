import { Banner } from "fumadocs-ui/components/banner";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./global.css";

export const metadata: Metadata = {
  title: {
    template: "%s | pipecat-ts (unofficial)",
    default: "pipecat-ts (unofficial)",
  },
  description:
    "Documentation for pipecat-ts, an unofficial TypeScript port of Pipecat for Bun, Node, Deno and Cloudflare Workers.",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>
          <Banner id="unofficial-notice">
            pipecat-ts is an unofficial community port of Pipecat, not affiliated with Daily.
          </Banner>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
