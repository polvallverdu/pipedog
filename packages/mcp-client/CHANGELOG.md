# @pipedog/mcp-client

## 0.11.0

### Patch Changes

- Updated dependencies [[`96b2e45`](https://github.com/polvallverdu/pipedog/commit/96b2e4550f18d47a683ea635c33db458b0acb5dd), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`bddb1c5`](https://github.com/polvallverdu/pipedog/commit/bddb1c568cfd5b0e9818bc19538b73d5fc83cd40), [`a25889f`](https://github.com/polvallverdu/pipedog/commit/a25889fdb51beffacee1e5e26404dafad662b7d2), [`f57c63e`](https://github.com/polvallverdu/pipedog/commit/f57c63e8b670789bb15574e4ebe3a4ede1eb61c8), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191)]:
  - @pipedog/core@0.11.0
  - @pipedog/asyncio@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [[`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e)]:
  - @pipedog/core@0.10.0
  - @pipedog/asyncio@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/asyncio@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Minor Changes

- [#57](https://github.com/polvallverdu/pipedog/pull/57) [`6df8a35`](https://github.com/polvallverdu/pipedog/commit/6df8a3562f404d91869e74b83772ee107ffa2721) Thanks [@polvallverdu](https://github.com/polvallverdu)! - New package: `MCPClient`, a port of Pipecat's `pipecat.services.mcp_service`. It connects to an MCP server and gives its tools to an LLM service as function-call tools.
  
  - Built on the official `@modelcontextprotocol/sdk` (1.32.1, the version `@pipedog/mcp` pins). Not to be confused with `@pipedog/mcp`, the docs server.
  - Transports: streamable HTTP and SSE run over `fetch` on Bun, Node, Deno and Cloudflare Workers. stdio starts the server as a child process, so it needs Bun, Node or Deno; on Workers it is refused with a clear error, and the stdio code is a separate module that Worker bundles never include.
  - The API follows upstream in camelCase: `tools()`, `start()`, `close()`, `toolsFilter`, `toolsOutputFilters` and `toolsArguments` (fixed arguments hidden from the model). The schemas `tools()` returns carry their handlers, so the LLM service registers them and closes the connection at teardown. One persistent session serves every call; a call that finds it gone reports the error to the model and the next call connects again.
  - Differences: the constructor takes an options object; `async with` is `await using` or `scoped()`; the deprecated `register_tools`, `get_tools_schema` and `register_tools_schema` are not ported; the HTTP parameters take a `fetch` option; `tools()` follows the server's pagination cursor.
  
  Docs: an MCP client service page with a runtime matrix.

### Patch Changes

- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0
  - @pipedog/asyncio@0.7.0
