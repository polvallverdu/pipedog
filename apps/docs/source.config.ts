import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineCollections, defineConfig, defineDocs } from "fumadocs-mdx/config";
import { transformerTwoslash } from "fumadocs-twoslash";
import { createFileSystemTypesCache } from "fumadocs-twoslash/cache-fs";
import {
  createFileSystemGeneratorCache,
  createGenerator,
  remarkAutoTypeTable,
} from "fumadocs-typescript";
import { z } from "zod";
import { remarkRuntimeMatrix } from "./lib/remark-runtime-matrix";
import { remarkStripLicense } from "./lib/remark-strip-license";

// Reads the pipedog sources (packages/*/src) through tsconfig.api.json.
const generator = createGenerator({
  tsconfigPath: "./tsconfig.api.json",
  cache: createFileSystemGeneratorCache(".next/cache/fumadocs-typescript"),
});

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

/**
 * Blog posts: content/blog/<slug>.mdx, served at /blog/<slug>. Not part of the docs tree, llms.txt
 * or the Markdown copies: posts are dated announcements, the docs are the reference.
 */
export const blogPosts = defineCollections({
  type: "doc",
  dir: "content/blog",
  schema: pageSchema.extend({
    author: z.string(),
    date: z.iso.date(),
    lang: z.enum(["en", "es"]).default("en"),
    /** The slug of the same post in the other language. */
    translation: z.string().optional(),
  }),
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [[remarkAutoTypeTable, { generator }], remarkStripLicense, remarkRuntimeMatrix],
    rehypeCodeOptions: {
      ...rehypeCodeDefaultOptions,
      themes: { light: "github-light", dark: "github-dark" },
      langs: ["ts", "tsx", "js", "json", "bash", "sh", "python", "toml", "jsonc"],
      transformers: [
        ...(rehypeCodeDefaultOptions.transformers ?? []),
        transformerTwoslash({
          typesCache: createFileSystemTypesCache(),
          twoslashOptions: {
            compilerOptions: {
              target: "ES2023",
              module: "ESNext",
              moduleResolution: "Bundler",
              lib: ["ES2023", "DOM", "DOM.Iterable"],
              strict: true,
              allowImportingTsExtensions: true,
              noEmit: true,
              skipLibCheck: true,
              types: [],
            },
          },
        }),
      ],
    },
  },
});
