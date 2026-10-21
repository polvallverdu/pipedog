# @pipedog/serializer-genesys

`GenesysAudioHookSerializer` for pipedog, a port of Pipecat's `pipecat.serializers.genesys`. It
speaks Genesys Cloud's [AudioHook](https://developer.genesys.cloud/devapps/audiohook) protocol, so
a contact-center flow can hand a call to a bot:

- Binary μ-law audio at 8 kHz both ways, resampled to and from the pipeline's rate. With stereo
  (`external` and `internal` channels), only the caller's (left) channel goes to the pipeline.
- The protocol handshake answered automatically: `open` → `opened` (with the configured languages
  and `startPaused`), `ping` → `pong`, `close` → `closed`, all as `OutputTransportMessageUrgentFrame`s.
- `pause` stops audio until you send `createResumedResponse()`; `update` refreshes the
  participant; `dtmf` becomes `InputDTMFFrame`.
- Architect variables: `inputVariables` from `open`, and `setOutputVariables()` for the `closed`
  and `disconnect` messages.
- An `InterruptionFrame` sends a barge-in event; `EndFrame` or `CancelFrame` sends `disconnect`.
- Events: `on_open`, `on_close`, `on_ping`, `on_pause`, `on_update`, `on_error`, `on_dtmf`.

```sh
bun add @pipedog/serializer-genesys @pipedog/transport-websocket
```

## Runtimes

| class | Bun | Node | Deno | Cloudflare Workers |
|---|:-:|:-:|:-:|:-:|
| `GenesysAudioHookSerializer` | ✅ | ✅ | ✅ | ✅ |

## Example

```ts
import { AudioHookChannel, GenesysAudioHookSerializer } from "@pipedog/serializer-genesys/genesys";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";

const serializer = new GenesysAudioHookSerializer({
  params: new GenesysAudioHookSerializer.InputParams({
    channel: AudioHookChannel.EXTERNAL,
    supportedLanguages: ["en-US", "es-ES"],
    selectedLanguage: "en-US",
  }),
});
const transport = new FastAPIWebsocketTransport(
  websocket,
  new FastAPIWebsocketParams({
    audioInEnabled: true,
    audioOutEnabled: true,
    serializer,
    fixedAudioPacketSize: 1600, // Genesys rate-limits (429) small audio messages
  }),
);
serializer.setOutputVariables({ intent: "billing", resolved: true });
```

## Wire compatibility

`test/golden.test.ts` replays AudioHook sessions recorded from upstream Pipecat
(`tools/golden/telephony.py`) step by step: every response message (sequence numbers, `clientseq`,
ISO 8601 positions rounded as Python's `f"{x:.3f}"`), frame and state change, and the audio
byte-identical at 8 kHz, mono and stereo.

Differences from upstream: positions are kept as integer microseconds (upstream's `timedelta`), and
log lines print dicts as Python `repr()` from a JSON value (no tuples or sets).

## License

BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily).
