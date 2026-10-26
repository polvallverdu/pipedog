# @pipedog/audio-ducking

Ducking for pipedog: the bot's voice drops while the user talks over it, so it sounds like the bot
heard them, and comes back when they stop, when the overlap becomes an interruption, or when the
bot stops. Not in upstream Pipecat.

The output transport queues the bot's audio well before it plays, so the gain is applied where
the audio leaves: `AudioDuckingFilter` is an output audio filter (`audioOutFilter`), which works
with any transport or serializer. Its `observer` ducks it from the user's voice activity.

```ts
import { AudioDuckingFilter } from "@pipedog/audio-ducking";

const ducking = new AudioDuckingFilter({ duckedGain: 0.35 });
const params = new TransportParams({ audioOutEnabled: true, audioOutFilter: ducking });
const worker = new PipelineWorker(pipeline, { observers: [ducking.observer] });
```

- `VADUserStartedSpeakingFrame` ducks; `VADUserStoppedSpeakingFrame`, `InterruptionFrame` and
  `BotStoppedSpeakingFrame` restore. `duck()` and `restore()` can be called directly.
- The gain ramps over the first chunk after a change, so there is no click.
- `FilterUpdateSettingsFrame({ settings: { duckedGain } })` changes the gain at runtime, and
  `FilterEnableFrame` turns ducking on and off.

## Runtimes

| | Bun | Node ≥ 22 | Deno | Cloudflare Workers |
|---|---|---|---|---|
| `AudioDuckingFilter` | ✅ | ✅ | ✅ | ✅ |

Needs: nothing. Pure TypeScript.
