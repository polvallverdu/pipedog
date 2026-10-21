import * as Twoslash from "fumadocs-twoslash/ui";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { TypeTable } from "fumadocs-ui/components/type-table";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";
import { basePath } from "@/lib/shared";
import { CompatTable } from "./compat-table";
import { StatusReport } from "./status-report";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ...Twoslash,
    Step,
    Steps,
    Tab,
    Tabs,
    TypeTable,
    CompatTable,
    StatusReport,
    ...components,
  } satisfies MDXComponents;
}

// Links to files the site serves (llms.txt, the .md pages) must be plain anchors: the default
// link is a Next <Link>, whose client-side navigation treats /llms.txt as a route and 404s. A
// plain anchor gets no automatic basePath, so add it.
const FILE_HREF = /^\/[^?#]*\.(txt|md|json|xml)([?#]|$)/;

export function FileLink({ href, ...props }: ComponentProps<"a">) {
  if (href && FILE_HREF.test(href)) return <a href={`${basePath}${href}`} {...props} />;
  const Link = defaultMdxComponents.a;
  return <Link href={href} {...props} />;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
