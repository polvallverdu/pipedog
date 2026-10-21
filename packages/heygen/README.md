# @pipedog/heygen

HeyGen video avatars for pipedog, a port of Pipecat's `pipecat.services.heygen`:

- `HeyGenVideoService`: a pipeline service placed after the TTS. The avatar speaks the TTS audio,
  and its video and audio come back downstream as `OutputImageRawFrame` and
  `SpeechOutputAudioRawFrame`.
- `HeyGenClient`: the session (HTTP), control WebSocket and LiveKit room behind the service and
  `@pipedog/transport-heygen`.
- `LiveAvatarApi` (LiveAvatar, `api.liveavatar.com`) and `HeyGenApi` (Interactive Avatar,
  `api.heygen.com`): the session APIs.

Subpaths mirror upstream: `@pipedog/heygen/video`, `/client`, `/api_liveavatar`,
`/api_interactive_avatar` and `/base_api`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/heygen @livekit/rtc-node
```

`@livekit/rtc-node` is an optional peer dependency with a native addon. Its prebuilt binaries
cover macOS (arm64, x64), Linux with glibc (x64, arm64) and Windows (x64); there is none for musl
(Alpine). It is loaded when the client sets up, not on import.

You need a LiveAvatar API key (or a HeyGen API key for the Interactive Avatar API). HeyGen hosts
the LiveKit room.

## Runtimes

| | Bun | Node ≥ 22 | Deno | Cloudflare Workers |
|---|---|---|---|---|
| `LiveAvatarApi`, `HeyGenApi` | ✅ | ✅ | ✅ | not verified (`fetch` only) |
| `HeyGenVideoService`, `HeyGenClient` | ✅ | ✅ | ✅ | ❌ (native addon) |

## Usage

```ts
import { LiveAvatarNewSessionRequest } from "@pipedog/heygen/api_liveavatar";
import { ServiceType } from "@pipedog/heygen/client";
import { HeyGenVideoService } from "@pipedog/heygen/video";

const heygen = new HeyGenVideoService({
  apiKey: process.env.HEYGEN_LIVE_AVATAR_API_KEY!,
  serviceType: ServiceType.LIVE_AVATAR,
  sessionRequest: new LiveAvatarNewSessionRequest({ avatarId: "<avatar id>" }),
});

// new Pipeline([transport.input(), stt, userAggregator, llm, tts, heygen, transport.output(), ...])
```

Docs: https://polvallverdu.github.io/pipedog/docs/services/video/heygen
