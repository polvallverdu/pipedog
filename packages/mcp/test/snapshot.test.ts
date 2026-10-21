// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateSnapshot, readDocsPages } from "../scripts/snapshot.ts";
import { extractDeclarations } from "../src/api.ts";
import { parseLlmsIndex, slugFromUrl, splitLlmsFull } from "../src/snapshot.ts";

const SITE = "https://example.test/pipedog";

const LLMS_TXT = `# pipedog

> pipedog is a port.

Every page is also available as Markdown: append \`.md\` to its URL. All pages in one file: ${SITE}/llms-full.txt


- **Get started**
- [Introduction](${SITE}/docs.md): The home page.
- [Quickstart](${SITE}/docs/quickstart.md): First pipeline.

- **Services**
- [Supported services](${SITE}/docs/services.md): Every service.
- Speech-to-text
  - [Deepgram](${SITE}/docs/services/stt/deepgram.md): Streaming STT.

  - **Coming soon**
  - [Gladia](${SITE}/docs/services/stt/gladia.md): Not ported to pipedog yet.
- Text-to-speech
  - [Cartesia \\[beta\\]](${SITE}/docs/services/tts/cartesia.md)

- **Transports**
- [WebSocket](${SITE}/docs/transports/websocket.md): WebSocket transport.
- **Coming soon**
- [Daily](${SITE}/docs/transports/daily.md): Not ported to pipedog yet.
- **Serializers**
- [Twilio](${SITE}/docs/serializers/twilio.md): Twilio media streams.
`;

const tmp: string[] = [];
afterAll(() => {
  for (const dir of tmp) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function page(title: string, slugPath: string, body: string): string {
  return `# ${title}\n\n> ${title} page.\n\nSource: ${SITE}/docs${slugPath}/\n\n${body}\n`;
}

describe("parseLlmsIndex", () => {
  const entries = parseLlmsIndex(LLMS_TXT);
  const bySlug = new Map(entries.map((e) => [e.slug, e]));

  test("every page, in order, with slugs and URLs", () => {
    expect(entries.map((e) => e.slug)).toEqual([
      "index",
      "quickstart",
      "services",
      "services/stt/deepgram",
      "services/stt/gladia",
      "services/tts/cartesia",
      "transports/websocket",
      "transports/daily",
      "serializers/twilio",
    ]);
    expect(bySlug.get("index")).toMatchObject({
      title: "Introduction",
      url: `${SITE}/docs/`,
      markdownUrl: `${SITE}/docs.md`,
    });
    expect(bySlug.get("services/stt/deepgram")).toMatchObject({
      url: `${SITE}/docs/services/stt/deepgram/`,
      markdownUrl: `${SITE}/docs/services/stt/deepgram.md`,
      description: "Streaming STT.",
    });
  });

  test("sections, groups and coming soon", () => {
    expect(bySlug.get("quickstart")).toMatchObject({ section: "Get started", group: null });
    expect(bySlug.get("services")).toMatchObject({ section: "Services", group: null });
    expect(bySlug.get("services/stt/deepgram")).toMatchObject({
      section: "Services",
      group: "Speech-to-text",
      comingSoon: false,
    });
    expect(bySlug.get("services/stt/gladia")?.comingSoon).toBe(true);
    // A new group ends the nested "Coming soon".
    expect(bySlug.get("services/tts/cartesia")).toMatchObject({
      group: "Text-to-speech",
      comingSoon: false,
      title: "Cartesia [beta]",
      description: "",
    });
    // A top-level "Coming soon" keeps the section.
    expect(bySlug.get("transports/websocket")?.comingSoon).toBe(false);
    expect(bySlug.get("transports/daily")).toMatchObject({
      section: "Transports",
      comingSoon: true,
    });
    expect(bySlug.get("serializers/twilio")).toMatchObject({
      section: "Serializers",
      comingSoon: false,
    });
  });

  test("slugFromUrl", () => {
    expect(slugFromUrl(`${SITE}/docs.md`, SITE)).toBe("index");
    expect(slugFromUrl(`${SITE}/docs/`, SITE)).toBe("index");
    expect(slugFromUrl(`${SITE}/docs/concepts/frames/#x`, SITE)).toBe("concepts/frames");
    expect(slugFromUrl("https://elsewhere.test/docs/x.md", SITE)).toBeNull();
  });
});

describe("splitLlmsFull", () => {
  test("splits at each page's title and Source line", () => {
    const a = page("Introduction", "", "Intro body.\n\n# Not a page\n\nmore");
    const b = `# Quickstart\n\n\n\nSource: ${SITE}/docs/quickstart/\n\n\`\`\`sh\n# a shell comment\n\`\`\``;
    const pages = splitLlmsFull([a.trimEnd(), b].join("\n\n"), SITE);
    expect([...pages.keys()]).toEqual(["index", "quickstart"]);
    expect(pages.get("index")).toBe(a.trimEnd());
    expect(pages.get("quickstart")).toBe(b);
  });
});

describe("extractDeclarations", () => {
  const dts = `/**
 * Module notes.
 */
import { type Base } from "./base.ts";
/** Options for \`Widget\`. */
export interface WidgetOptions extends BaseOptions {
    /** A size, e.g. \`{ w: 1 }\`. */
    size?: { w: number };
    label: string;
}
/** A widget. */
export declare class Widget extends Base {
    #private;
    constructor(options: WidgetOptions);
    get size(): number;
}
declare class Hidden {
    x: number;
}
export declare function makeWidget(options?: WidgetOptions): Widget;
export declare function makeWidget(size: number): Widget;
export declare const Kind: {
    readonly A: "a";
};
export type Kind = (typeof Kind)[keyof typeof Kind];
export * from "./other.ts";
export { a, b as c } from "./letters.ts";
//# sourceMappingURL=widget.d.ts.map
`;
  const { declarations, starExports, namedExports } = extractDeclarations(dts);

  test("finds each exported declaration with its JSDoc", () => {
    expect(declarations.map((d) => `${d.kind} ${d.name}`)).toEqual([
      "interface WidgetOptions",
      "class Widget",
      "function makeWidget",
      "function makeWidget",
      "const Kind",
      "type Kind",
    ]);
    const widget = declarations.find((d) => d.name === "Widget");
    expect(widget?.doc).toBe("A widget.");
    expect(widget?.text).toStartWith(
      "/** A widget. */\nexport declare class Widget extends Base {",
    );
    expect(widget?.text).toEndWith("}");
    expect(widget?.text).not.toContain("#private");
    expect(declarations[0]?.text).toContain("label: string;\n}");
  });

  test("re-exports", () => {
    expect(starExports).toEqual(["./other.ts"]);
    expect(namedExports.get("a")).toEqual(["./letters.ts", "a"]);
    expect(namedExports.get("c")).toEqual(["./letters.ts", "b"]);
  });
});

describe("generateSnapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "pipedog-mcp-snapshot-"));
  tmp.push(root);
  const out = join(root, "out");
  const packages = join(root, "packages");
  const llms = `# pipedog\n\nAll pages in one file: ${SITE}/llms-full.txt\n\n- **Get started**\n- [Introduction](${SITE}/docs.md): Home.\n- **Services**\n- STT\n  - [Deepgram](${SITE}/docs/services/stt/deepgram.md): STT.\n`;
  write(out, {
    "llms.txt": llms,
    "docs.md": page("Introduction", "", "Welcome."),
    "docs/services/stt/deepgram.md": page(
      "Deepgram",
      "/services/stt/deepgram",
      "## Usage [#usage]\n\nnew DeepgramSTTService()",
    ),
  });
  write(packages, {
    "widgets/package.json": JSON.stringify({
      name: "@pipedog/widgets",
      version: "1.2.3",
      exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
    }),
    "widgets/dist/index.d.ts": 'export * from "./widget.ts";\n',
    "widgets/dist/widget.d.ts":
      "/** A widget. */\nexport declare class Widget {\n    constructor(options: WidgetOptions);\n}\nexport interface WidgetOptions {\n    size?: number;\n}\n",
    "widgets/dist/internal/thing.d.ts": "export declare const notExported = 1;\n",
    "rootonly/package.json": JSON.stringify({
      name: "@pipedog/rootonly",
      exports: { ".": "./src/index.ts" },
    }),
    "rootonly/dist/index.d.ts": 'export { helper } from "./impl.ts";\n',
    "rootonly/dist/impl.d.ts":
      "export declare function helper(): void;\nexport declare function internal(): void;\n",
    "private/package.json": JSON.stringify({ name: "@pipedog/private", private: true }),
  });

  test("pages from the docs build, API from the .d.ts", () => {
    const snapshot = generateSnapshot({
      docsOut: out,
      packagesDir: packages,
      expectedSiteUrl: SITE,
      version: "9.9.9",
    });
    expect(snapshot).toMatchObject({ format: 1, version: "9.9.9", siteUrl: SITE });
    expect(snapshot.llmsTxt).toBe(llms);
    expect(snapshot.pages.map((p) => [p.slug, p.section, p.group])).toEqual([
      ["index", "Get started", null],
      ["services/stt/deepgram", "Services", "STT"],
    ]);
    expect(snapshot.pages[1]?.markdown).toContain("new DeepgramSTTService()");

    const api = Object.fromEntries(snapshot.api.map((e) => [e.name, e]));
    // `rootonly`'s `internal` is not reachable from its exports.
    expect(Object.keys(api).sort()).toEqual(["Widget", "WidgetOptions", "helper", "notExported"]);
    // "./*" covers subdirectories too, as in Node.
    expect(api.notExported?.module).toBe("@pipedog/widgets/internal/thing");
    expect(api.Widget).toMatchObject({
      kinds: ["class"],
      package: "@pipedog/widgets",
      module: "@pipedog/widgets/widget",
      alsoFrom: ["@pipedog/widgets"],
    });
    expect(api.Widget?.text).toContain("constructor(options: WidgetOptions);");
    // Only importable through the package root's named re-export.
    expect(api.helper).toMatchObject({ module: "@pipedog/rootonly", alsoFrom: [] });
  });

  test("refuses docs built for another site", () => {
    expect(() => generateSnapshot({ docsOut: out, packagesDir: null })).toThrow(/built for/);
  });

  test("refuses a page listed in llms.txt without its Markdown", () => {
    const broken = join(root, "broken");
    write(broken, {
      "llms.txt": `${llms}  - [Gone](${SITE}/docs/services/stt/gone.md)\n`,
      "docs.md": "# x",
    });
    expect(() => readDocsPages(broken)).toThrow(/without Markdown/);
  });

  test("refuses a package without .d.ts", () => {
    write(packages, {
      "nodist/package.json": JSON.stringify({
        name: "@pipedog/nodist",
        exports: { ".": "./src/index.ts" },
      }),
    });
    expect(() =>
      generateSnapshot({ docsOut: out, packagesDir: packages, expectedSiteUrl: null }),
    ).toThrow(/no \.d\.ts/);
    rmSync(join(packages, "nodist"), { recursive: true });
  });
});
