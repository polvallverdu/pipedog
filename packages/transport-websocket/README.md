# @pipedog/transport-websocket

WebSocket transports for pipedog: a port of Pipecat's `pipecat.transports.websocket`
(`client`, `server`, `fastapi`, `rtvi_client`). The transports sit on a small runtime-agnostic
socket (`WebsocketConnection`), with servers for `Bun.serve`, `Deno.serve` and Node's `ws`, and
adapters for a Cloudflare `WebSocketPair` and Hono.

```sh
bun add @pipedog/transport-websocket @pipedog/serializer-protobuf
npm i @pipedog/transport-websocket @pipedog/serializer-protobuf ws   # Node: `ws` to listen
```

`ws` is an optional peer dependency, needed only to **listen** on Node
(`SingleClientWebsocketServerTransport` or `websocketServe()`). Clients use the global
`WebSocket` everywhere, and Bun and Deno listen with their own servers.

## Runtimes

| class / function | Bun | Node | Deno | Cloudflare Workers |
|---|:-:|:-:|:-:|:-:|
| `SingleClientWebsocketServerTransport` (`/server`) | ✅ `Bun.serve` | ✅ with `ws` | ✅ `Deno.serve` | ❌ can't listen on a port |
| `websocketServe()` (`/serve`) | ✅ | ✅ with `ws` | ✅ | ❌ throws, pointing to `WebSocketPair` |
| `FastAPIWebsocketTransport` (`/fastapi`), bring your own socket | ✅ | ✅ | ✅ | ✅ `WebSocketPair`, in a Worker or a Durable Object |
| `honoWebsocket()` (`/hono`) | ✅ `hono/bun` | ✅ `@hono/node-ws` | ✅ `hono/deno` | ✅ `hono/cloudflare-workers` |
| `WebsocketClientTransport` (`/client`) | ✅ | ✅ | ✅ | ✅ |
| `RTVIClientTransport` (`/rtvi_client`) | ✅ | ✅ | ✅ | ✅ |

These are tested, not assumed:

- `test/e2e_runtimes.test.ts` runs a real echo pipeline with the protobuf serializer, exchanging
  audio and transport messages, for every pair of server and client. The servers are
  `SingleClientWebsocketServerTransport` on Bun, Node (`ws`) and Deno; `FastAPIWebsocketTransport`
  behind Hono on all three; and `FastAPIWebsocketTransport` on a `WebSocketPair` in a workerd
  Worker and in a Durable Object. The clients are `WebsocketClientTransport` on Bun, Node, Deno
  and workerd. The test also checks the server's `Origin` check on each runtime.
- With `PIPEDOG_UPSTREAM_PYTHON` set to a Python that has upstream Pipecat installed, the same
  test also runs upstream's `WebsocketClientTransport` against each of our servers, and our
  clients against upstream's `SingleClientWebsocketServerTransport`.
- `compat/smoke.ts` (`bun run compat`) runs every class on every runtime it claims.

Run the matrix by hand with `bun packages/transport-websocket/test/e2e/run.ts [--server …] [--client …]`.

## The socket

Upstream's transports talk to the `websockets` package (client and server) and to Starlette's
`WebSocket` (FastAPI). Here they talk to `WebsocketConnection`, which offers both APIs:
`recv()`, `send()`, `close()`, `state` and async iteration, plus `receive()`, `sendBytes()`,
`sendText()`, `clientState` and `applicationState`. You get one in one of two ways:

- `WebsocketConnection.fromWebSocket(ws, { headers })` wraps any standard `WebSocket`: the global
  client, Deno's upgraded socket, a Node `ws` socket, or the server half of a `WebSocketPair`.
- `new WebsocketConnection({ send, close }, { headers })` takes anything else. Feed it events
  with `feedMessage(data)` and `feedClose(code, reason)`. This is how Bun's `ServerWebSocket`
  and Hono's callbacks are wired.

Pass the upgrade request's `headers`: `FastAPIWebsocketTransport` checks `allowedOrigins`
(default: the `PIPECAT_ALLOWED_ORIGINS` env var) against its `Origin`.

## Examples

The server examples share this bot. It runs one pipeline per connection; put your STT, LLM and
TTS between input and output.

```ts
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";
import {
  type FastAPIWebSocket,
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";

export async function runBot(websocket: FastAPIWebSocket): Promise<void> {
  const transport = new FastAPIWebsocketTransport(
    websocket,
    new FastAPIWebsocketParams({
      audioInEnabled: true,
      audioOutEnabled: true,
      serializer: new ProtobufFrameSerializer(),
    }),
  );
  const worker = new PipelineWorker(
    new Pipeline([transport.input(), /* stt, llm, tts, ... */ transport.output()]),
  );
  transport.eventHandler("on_client_disconnected", async () => {
    await worker.cancel();
  });
  const runner = new WorkerRunner({ handleSigint: false });
  await runner.addWorkers(worker);
  await runner.run();
}
```

### Single-client server (Bun, Node with `ws`, Deno)

This is upstream's `SingleClientWebsocketServerTransport`: it listens itself and serves one
client at a time.

```ts
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";
import {
  SingleClientWebsocketServerParams,
  SingleClientWebsocketServerTransport,
} from "@pipedog/transport-websocket/server";

const transport = new SingleClientWebsocketServerTransport(
  new SingleClientWebsocketServerParams({
    audioInEnabled: true,
    audioOutEnabled: true,
    serializer: new ProtobufFrameSerializer(),
  }),
  { host: "0.0.0.0", port: 8765 },
);
transport.eventHandler("on_client_connected", async (_transport, websocket) => {
  console.log("client connected", websocket.remoteAddress);
});
// new PipelineWorker(new Pipeline([transport.input(), ..., transport.output()])) and run it.
```

To serve many clients, use `websocketServe()` (same runtimes) and give each connection its own
pipeline:

```ts
import { websocketServe } from "@pipedog/transport-websocket/serve";

const server = await websocketServe({ handler: runBot, host: "0.0.0.0", port: 8765 });
// ... later: closes open connections (1001) and waits for their handlers.
await server.close();
```

### Bun.serve

```ts
import { WebsocketConnection } from "@pipedog/transport-websocket/socket";

Bun.serve<{ connection: WebsocketConnection | null; headers: Headers }>({
  port: 8765,
  fetch(req, server) {
    if (server.upgrade(req, { data: { connection: null, headers: req.headers } })) return;
    return new Response("expected a WebSocket", { status: 426 });
  },
  websocket: {
    open(ws) {
      const connection = new WebsocketConnection(
        { send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) },
        { headers: ws.data.headers },
      );
      ws.data.connection = connection;
      void runBot(connection);
    },
    message(ws, message) {
      ws.data.connection?.feedMessage(message);
    },
    close(ws, code, reason) {
      ws.data.connection?.feedClose(code, reason);
    },
  },
});
```

### Node (`ws`)

```ts
import { WebsocketConnection } from "@pipedog/transport-websocket/socket";
import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8765 });
wss.on("connection", (socket, req) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  void runBot(WebsocketConnection.fromWebSocket(socket, { headers }));
});
```

### Deno.serve

```ts
import { WebsocketConnection } from "@pipedog/transport-websocket/socket";

Deno.serve({ port: 8765 }, (req) => {
  // Copy what you need before upgrading: the request is closed afterwards.
  const headers = new Headers(req.headers);
  const { socket, response } = Deno.upgradeWebSocket(req);
  const connection = WebsocketConnection.fromWebSocket(socket, { headers });
  socket.addEventListener("open", () => void runBot(connection));
  return response;
});
```

### Cloudflare Workers (`WebSocketPair`)

```ts
import { WebsocketConnection } from "@pipedog/transport-websocket/socket";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected a WebSocket", { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const connection = WebsocketConnection.fromWebSocket(server, { headers: request.headers });
    ctx.waitUntil(runBot(connection));
    return new Response(null, { status: 101, webSocket: client });
  },
};
```

In a Durable Object, do the same in the object's `fetch()`; the object stays alive while the
socket is open, so it needs no `waitUntil`. The test suite runs both under workerd. Workers have
CPU-time limits, so keep heavy local models (VAD, turn detection) off the hot path or use their
WASM backends.

### Hono (Bun, Node, Deno, Workers)

`honoWebsocket()` turns Hono's WebSocket callbacks into a `WebsocketConnection` and runs your
handler in its own task. It needs nothing from Hono at runtime, so it works with every adapter:

```ts
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun"; // or "hono/deno", "hono/cloudflare-workers"
import { honoWebsocket } from "@pipedog/transport-websocket/hono";

const app = new Hono();
app.get(
  "/ws",
  upgradeWebSocket((c) => honoWebsocket(runBot, { headers: c.req.raw.headers })),
);
Bun.serve({ port: 8765, fetch: app.fetch, websocket });
```

On Node, use `@hono/node-server` and `@hono/node-ws`:

```ts
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
app.get("/ws", upgradeWebSocket((c) => honoWebsocket(runBot, { headers: c.req.raw.headers })));
injectWebSocket(serve({ fetch: app.fetch, port: 8765 }));
```

### Client

```ts
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";
import {
  WebsocketClientParams,
  WebsocketClientTransport,
} from "@pipedog/transport-websocket/client";

const transport = new WebsocketClientTransport(
  "ws://localhost:8765",
  new WebsocketClientParams({
    audioInEnabled: true,
    audioOutEnabled: true,
    addWavHeader: false, // upstream's default is true
    serializer: new ProtobufFrameSerializer(), // the default
    additionalHeaders: { Authorization: "Bearer …" }, // not in browsers
  }),
);
transport.eventHandler("on_connected", async () => console.log("connected"));
```

`RTVIClientTransport` (`/rtvi_client`) is a client that talks RTVI to a bot. It sends
`client-ready`, fires `on_bot_ready` when the bot answers, and uses `RTVIClientSerializer` from
`@pipedog/serializer-rtvi-client`.

### Telephony media streams (Telnyx)

Telephony providers connect to your server. Read the `start` event, then build the serializer
from it. See [`@pipedog/serializer-telnyx`](../serializer-telnyx) for a complete example.

## Wire compatibility

The protobuf serializer is byte-identical to upstream's (golden vectors in
`@pipedog/serializer-protobuf`). It interoperates both ways with upstream Pipecat's WebSocket
client and server, and with the official browser client, `@pipecat-ai/websocket-transport`.
That client, version 1.7.2, was run headless against `SingleClientWebsocketServerTransport`, and
mic audio, RTVI requests and responses, and server messages all round-tripped.

## Differences from upstream

- Upstream's server listens with `websockets.serve`. Here the server comes from
  `websocketServe()`, which picks the runtime's own server; pass your own with the transport's
  `serve` option.
- The FastAPI transport takes any `FastAPIWebSocket`, which `WebsocketConnection` implements, in
  place of a Starlette `WebSocket`.
- The deprecated `WebsocketServer*` aliases are not ported.
- Binary messages are `Uint8Array`, never `Buffer`.

## License

BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily).
