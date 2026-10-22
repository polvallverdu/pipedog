// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The stdio transport of the MCP SDK: it spawns the server as a child process (through
 * `cross-spawn` and `node:child_process`), so it works on Bun, Node and Deno only.
 *
 * `mcp_service.ts` loads this module on use, by its package name, so that the export condition
 * `workerd` can swap it for `stdio_transport.workerd.ts`: a Workers bundle then never pulls
 * `cross-spawn` in.
 */

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** What it takes to start a stdio server. */
export interface StdioTransportOptions {
  command: string;
  args: string[];
  env: Record<string, string> | null;
  cwd: string | null;
}

/** Create the transport. The process starts when the client connects. */
export function createStdioTransport(options: StdioTransportOptions): Transport {
  return new StdioClientTransport({
    command: options.command,
    args: options.args,
    ...(options.env ? { env: options.env } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
}
