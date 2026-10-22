// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A tiny MCP server over stdio, built with the official SDK, for the end-to-end tests:
//
//   bun test/fixtures/stdio_server.ts

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createToolServer } from "./servers.ts";

await createToolServer().connect(new StdioServerTransport());
