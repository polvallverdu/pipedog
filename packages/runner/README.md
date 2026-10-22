# @pipedog/runner

Pipecat's runner (`pipecat.runner`) for pipedog: a bot written against Pipecat's development
runner keeps its shape. Export `bot(runnerArgs)`, call `main()`, and pick the transport with
`createTransport()`.

- `main()` (`@pipedog/runner/run`): the development server, with upstream's CLI (`-t webrtc`,
  `-t twilio|telnyx|plivo|exotel`, `--proxy`, `--host`, `--port`, `--esp32`, `--ice-servers`,
  `--ws-auth`, `--allowed-origins`, `-u`, `-f`, `--runner-body`, `-v`). It serves the prebuilt
  Pipecat client at `/client` (`/` redirects there), `/start`, `/status`, SmallWebRTC's
  `/api/offer` (and `/sessions/{id}/api/offer`), the telephony WebSocket at `/ws`, the TwiML or
  TeXML webhook at `POST /`, `/ws-client`, and file uploads and downloads.
- `createRunnerApp()` builds the same server as a fetch handler to mount in Hono, SvelteKit and
  others; `serve()` (`@pipedog/runner/serve`) listens on Bun, Node (with `ws`) or Deno.
- `createTransport(runnerArgs, transportParams)` (`@pipedog/runner/utils`) builds the transport the
  runner arguments call for. For a phone call it reads the provider's handshake (Telnyx's
  `connected` then `start`, ...), builds the provider's serializer with the stream and call IDs,
  and exposes them as `runnerArgs.callData`. A caller who hangs up before the handshake completes
  is a `TelephonyCallEndedError`, with `runnerArgs.handshake` set to
  `{ status: "closed", messagesReceived }`.
- The runner arguments: `RunnerArguments`, `SmallWebRTCRunnerArguments`,
  `WebSocketRunnerArguments`, `LiveKitRunnerArguments`, and, for API parity,
  `DailyRunnerArguments`, `VonageRunnerArguments` and `MOQRunnerArguments`.
- `@pipedog/runner/livekit`: LiveKit access tokens (`generateToken`, `generateTokenWithAgent`,
  `generateSessionTokens`, `configure`), signed with `livekit-server-sdk`. With `-t livekit`,
  `POST /start` mints a bot and a user token and starts the bot with `LiveKitRunnerArguments`;
  `createTransport()` then needs `@pipedog/transport-livekit` (an optional peer) and
  `@livekit/rtc-node`.
- `--whatsapp`: mounts `GET`/`POST /whatsapp` (Meta's webhook verification and call events) on
  `@pipedog/transport-whatsapp` (an optional peer). It needs `WHATSAPP_APP_SECRET`,
  `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN` and `WHATSAPP_WEBHOOK_VERIFICATION_TOKEN`. Each call
  starts the bot with `SmallWebRTCRunnerArguments`, and `runnerArgs.body` is the call.
- `parseTelephonyWebsocket()`, `telephonyHandshake()` and the `CallData` types.

```sh
bun add @pipedog/runner
```

## Example

```ts
// bot.ts: run with `bun bot.ts -t webrtc`, or `bun bot.ts -t telnyx --proxy mybot.ngrok.io`
import { TransportParams } from "@pipedog/core/transports/base_transport";
import type { RunnerArguments } from "@pipedog/runner/types";
import { createTransport } from "@pipedog/runner/utils";
import { FastAPIWebsocketParams } from "@pipedog/transport-websocket/fastapi";

const transportParams = {
  webrtc: () => new TransportParams({ audioInEnabled: true, audioOutEnabled: true }),
  telnyx: () => new FastAPIWebsocketParams({ audioInEnabled: true, audioOutEnabled: true }),
};

export async function bot(runnerArgs: RunnerArguments) {
  const transport = await createTransport(runnerArgs, transportParams);
  // build and run the pipeline with transport.input() and transport.output()
}

if (import.meta.main) {
  const { main } = await import("@pipedog/runner/run");
  await main();
}
```

See the [Development runner](https://polvallverdu.github.io/pipedog/docs/runner) docs page for
the routes, mounting the app in a framework, and a Python-to-TypeScript mapping.

## Runtimes

| export | Bun | Node | Deno | Cloudflare Workers |
|---|:-:|:-:|:-:|:-:|
| `createTransport`, `parseTelephonyWebsocket`, `telephonyHandshake`, the runner arguments | ✅ | ✅ | ✅ | ✅ (WebSocket and telephony; WebRTC isn't available there) |
| `main`, `serve` | ✅ | ✅ with `ws` | ✅ | ❌ can't listen |
| `createRunnerApp` (fetch handler) | ✅ | ✅ | ✅ | not tested |

## The prebuilt client

Upstream serves `PipecatPrebuiltUI` from the `pipecat-ai-prebuilt` Python package
([pipecat-ai/pipecat-prebuilt](https://github.com/pipecat-ai/pipecat-prebuilt)). Its build is only
published in that wheel; there is no npm or CDN build. This package ships the wheel's built client
unmodified in `prebuilt/` (release 1.3.0, BSD-2-Clause, Copyright (c) 2025–2026 Daily, with its
`THIRD_PARTY_NOTICES.txt`), refreshed with `bun tools/runner/sync-prebuilt.ts`.

## Differences from upstream

- Daily (`-t daily`, `--direct`, the dial-in webhook), MOQ, the Vonage Video Connector
  (`-t vonage`) aren't ported: selecting them fails with a clear message. Their
  argument classes exist for type parity. The MOQ flags and the deprecated `--folder` and
  `-t eval` aren't ported.
- A hang-up mid-handshake is `TelephonyCallEndedError` (a `TelephonyHandshakeError`, upstream's
  `ValueError`) whether zero or one message arrived; upstream fails with "Missing transport params
  for 'unknown'" after one. The runner logs it at info level.
- The server is a fetch handler instead of a FastAPI app; startup hooks are `lifespan` functions
  that may return a cleanup. Bots add routes to the module-level `app` as upstream bots do.
- The CLI parser is a small `ArgumentParser` with argparse's semantics; `runnerArgs.cliArgs` keeps
  argparse's `dest` names (`ice_servers`, `ws_auth`).
- The WebSocket token helpers and `_resolveDownloadPath` are async (WebCrypto, lazy `node:fs`).
- The parse is cached per socket in a `WeakMap`; `call_data["call_id"]` is
  `callData.getItem("call_id")`.

## License

BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). The prebuilt client in
`prebuilt/` is BSD 2-Clause, Copyright (c) 2025–2026 Daily; see `prebuilt/LICENSE`.
