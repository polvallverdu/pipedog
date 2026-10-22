// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The `workerd` build of `stdio_transport.ts`. A Worker cannot start a process, so a stdio server
 * is refused with a message that says what to use instead.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { StdioTransportOptions } from "./stdio_transport.ts";

export type { StdioTransportOptions };

export function createStdioTransport(_options: StdioTransportOptions): Transport {
  throw new Error(
    "MCP stdio servers need a child process, which Cloudflare Workers do not have. " +
      "Use a server reachable over streamable HTTP or SSE (StreamableHttpParameters or SseServerParameters).",
  );
}
