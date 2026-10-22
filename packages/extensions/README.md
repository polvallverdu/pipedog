# @pipedog/extensions

Pipecat's extensions (`pipecat.extensions`) for pipedog:

- `IVRNavigator` / `IVRProcessor`: an LLM navigates a phone menu. It classifies the other side as a
  person or an IVR, then presses keys with `<dtmf>` tags (as `OutputDTMFUrgentFrame`s) and reports
  `on_ivr_status_changed` (`detected`, `completed`, `stuck`, `wait`).
- `VoicemailDetector` / `TTSGate`: tells a person from a voicemail on outbound calls with any
  `BaseClassifier`, holding the bot's speech until it knows.

```sh
bun add @pipedog/extensions
```

## Runtimes

| | Bun | Node | Deno | Cloudflare Workers |
|---|:-:|:-:|:-:|:-:|
| `IVRNavigator`, `IVRProcessor`, `VoicemailDetector`, `TTSGate` | ✅ | ✅ | ✅ | ✅ |

Pure frame logic, no I/O. The smoke test runs the IVR processor and the detector with a scripted
classifier in a pipeline on every runtime.

## Example

```ts
import { IVRNavigator, VoicemailDetector } from "@pipedog/extensions";

const navigator = new IVRNavigator({ llm, ivrPrompt: "Reach billing and ask for an agent." });
navigator.addEventHandler("on_ivr_status_changed", async (_processor, status) => {});

const voicemail = new VoicemailDetector({ classifier });
// Pipeline([... stt, voicemail.detector(), aggregators.user(), llm, tts, voicemail.gate(), ...])
```

The [Telephony extensions](https://polvallverdu.github.io/pipedog/docs/telephony/extensions/) page
has complete pipelines.

## Differences from upstream

- `VoicemailDetector`'s deprecated `llm` and `customSystemPrompt` parameters are not ported:
  `classifier` is required.
- `IVRStatus` is an `as const` object, so `status.value` is just `status`.

## Telephony

`test/dtmf_integration.test.ts` checks the IVR against the Twilio and Telnyx serializers' DTMF
frames, core's `DTMFAggregator` and core's DTMF tones. Not run against a live IVR or carrier.

## License

BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily).
