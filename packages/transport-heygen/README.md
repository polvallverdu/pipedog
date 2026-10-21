# @pipedog/transport-heygen

The HeyGen transport for pipedog, a port of Pipecat's `pipecat.transports.heygen.transport`:
`HeyGenTransport` starts a HeyGen avatar session (LiveAvatar or Interactive Avatar) and joins the
bot to the avatar's LiveKit room. The user joins the same room and sees the avatar; the bot hears
the user and sends its speech to the avatar.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/heygen @pipedog/transport-heygen @livekit/rtc-node
```

`@livekit/rtc-node` is an optional peer dependency with a native addon, with prebuilt binaries for
macOS (arm64, x64), Linux with glibc (x64, arm64) and Windows (x64), and none for musl (Alpine).
It runs on Bun, Node ≥ 22 and Deno, not on Cloudflare Workers.

## Usage

```ts
import { LiveAvatarNewSessionRequest } from "@pipedog/heygen/api_liveavatar";
import { ServiceType } from "@pipedog/heygen/client";
import { HeyGenParams, HeyGenTransport } from "@pipedog/transport-heygen/transport";

const transport = new HeyGenTransport({
  apiKey: process.env.HEYGEN_LIVE_AVATAR_API_KEY!,
  serviceType: ServiceType.LIVE_AVATAR,
  sessionRequest: new LiveAvatarNewSessionRequest({ avatarId: "<avatar id>" }),
  params: new HeyGenParams(),
});

transport.eventHandler("on_client_connected", async (_transport, participant) => {
  console.log(`${participant} joined`);
});

// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), assistantAggregator])
```

Docs: https://polvallverdu.github.io/pipedog/docs/services/video/heygen
