import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Logo } from "@/components/logo";
import { repoUrl } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Logo />,
    },
    githubUrl: repoUrl,
    links: [
      { text: "Docs", url: "/docs", active: "nested-url" },
      { text: "Services", url: "/docs/services" },
      { text: "Performance", url: "/docs/performance" },
      { text: "Roadmap", url: "/docs/roadmap" },
    ],
  };
}
