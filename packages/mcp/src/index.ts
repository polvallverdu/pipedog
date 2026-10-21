// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A local MCP server with the pipedog docs. Run it with `npx -y @pipedog/mcp`; this entry point
 * is for embedding it (it does not start anything when imported).
 */

export { ApiIndex, extractDeclarations } from "./api.ts";
export { Docs, type DocsSource, type PageSummary } from "./docs.ts";
export { DEFAULT_LIVE_TIMEOUT_MS, type LiveOptions, loadLiveSnapshot } from "./live.ts";
export { docsLoader, type LoadOptions, loadDocs } from "./load.ts";
export { SearchIndex, type SearchResult, splitSections, tokenize } from "./search.ts";
export { createServer, RESOURCE_PREFIX, type ServerOptions } from "./server.ts";
export {
  type ApiEntry,
  type ApiKind,
  BUNDLED_SNAPSHOT_URL,
  DEFAULT_SITE_URL,
  type DocPage,
  parseLlmsIndex,
  readSnapshot,
  type Snapshot,
  slugFromUrl,
  splitLlmsFull,
} from "./snapshot.ts";
export { VERSION } from "./version.ts";
