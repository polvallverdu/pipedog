# @pipedog/transport-livekit

LiveKit for pipedog: a port of Pipecat's `pipecat.transports.livekit` (`LiveKitTransport`,
`LiveKitRESTHelper`). The bot joins a LiveKit room as a participant, on your own LiveKit server or
LiveKit Cloud, with audio in and out, video in (camera and screen share) and out, data messages
(RTVI travels over them), participant events and SIP DTMF.

```sh
bun add @pipedog/transport-livekit @livekit/rtc-node
```

Media runs on LiveKit's Node SDK, [`@livekit/rtc-node`](https://www.npmjs.com/package/@livekit/rtc-node)
(1.1.0 or newer in 1.x), an optional peer dependency. It loads a native addon, so it is imported
only when the transport is set up: importing this package works everywhere. Access tokens are
signed with [`livekit-server-sdk`](https://www.npmjs.com/package/livekit-server-sdk), which is
plain JavaScript.

## Runtimes

| | Bun | Node ≥ 22 | Deno | Cloudflare Workers |
|---|---|---|---|---|
| `LiveKitTransport` | ✅ | ✅ | ✅ (`--allow-all`) | ❌ |
| `LiveKitRESTHelper` | ✅ | ✅ | ✅ | not verified |

`@livekit/rtc-node` ships prebuilt binaries for macOS (arm64, x64), Linux with glibc (x64, arm64)
and Windows (x64). There is none for musl (Alpine), and Workers can't load native code.

## Usage

You need a LiveKit server (or LiveKit Cloud), its API key and secret, and a token for the bot:

```ts
import { configure } from "@pipedog/runner/livekit";
import { LiveKitParams, LiveKitTransport } from "@pipedog/transport-livekit/transport";

// LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_ROOM_NAME
const [url, token, roomName] = await configure();
const transport = new LiveKitTransport({
  url,
  token,
  roomName,
  params: new LiveKitParams({ audioInEnabled: true, audioOutEnabled: true }),
});
// new Pipeline([transport.input(), stt, ..., tts, transport.output()])
```

With the development runner, `bun bot.ts -t livekit` mints the tokens for each `/start` and
`createTransport()` builds the transport.

Docs: [LiveKit](https://polvallverdu.github.io/pipedog/docs/transports/livekit/).

## Differences from upstream

- `new LiveKitTransport({ url, token, roomName, params })` takes one options object.
- `LiveKitRESTHelper` takes an optional `fetch` instead of an aiohttp session, and signs its token
  with `livekit-server-sdk`.
- Connecting retries 3 times, 4 s apart, and throws the last error (tenacity throws `RetryError`).
- `rtc.ts` holds the lazily loaded SDK; `setRtc()` lets an application (or a test) provide its own.

## Tests

`bun test packages/transport-livekit` runs the ported unit tests (mocked rooms, as upstream) and an
end-to-end test that starts `livekit/livekit-server` in Docker and runs a bot on Bun, Node and Deno
against it. Without Docker (or with `PIPEDOG_E2E=0`) the end-to-end test is skipped; set
`PIPEDOG_LIVEKIT_URL`, `PIPEDOG_LIVEKIT_API_KEY` and `PIPEDOG_LIVEKIT_API_SECRET` to use a server
of your own.
