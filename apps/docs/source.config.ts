import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { transformerTwoslash } from "fumadocs-twoslash";
import { createFileSystemTypesCache } from "fumadocs-twoslash/cache-fs";
import {
  createFileSystemGeneratorCache,
  createGenerator,
  remarkAutoTypeTable,
} from "fumadocs-typescript";

// Reads the pipecat-ts sources (packages/*/src) through tsconfig.api.json.
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

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [[remarkAutoTypeTable, { generator }]],
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
