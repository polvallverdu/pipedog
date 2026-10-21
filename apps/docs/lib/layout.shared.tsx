import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName, repoUrl } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <span className="font-semibold">{appName}</span>,
    },
    githubUrl: repoUrl,
    links: [
      { text: "Docs", url: "/docs", active: "nested-url" },
      { text: "Services", url: "/docs/services" },
      { text: "Roadmap", url: "/docs/roadmap" },
    ],
  };
}
