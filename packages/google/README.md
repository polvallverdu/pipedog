# @pipedog/google

Google speech services for pipedog: a port of Pipecat's `pipecat.services.google` speech
services. Cloud Speech-to-Text V2 (including Chirp 3), Cloud Text-to-Speech (including Chirp 3
HD streaming), Gemini TTS, and Gemini Live transcription (`gemini-3.5-transcribe-live`).

```sh
bun add @pipedog/google
# Cloud Speech-to-Text (GoogleSTTService):
bun add @google-cloud/speech
# Cloud Text-to-Speech (GoogleHttpTTSService, GoogleTTSService, GeminiTTSService on GCP):
bun add @google-cloud/text-to-speech
```

## Which SDK each class needs

| class | module | client | install |
|---|---|---|---|
| `GoogleSTTService` | `@pipedog/google/stt` | Cloud Speech V2, gRPC | `@google-cloud/speech` |
| `GoogleHttpTTSService` | `@pipedog/google/tts` | Cloud TTS `SynthesizeSpeech`, gRPC | `@google-cloud/text-to-speech` |
| `GoogleTTSService` | `@pipedog/google/tts` | Cloud TTS `StreamingSynthesize`, gRPC | `@google-cloud/text-to-speech` |
| `GeminiTTSService` (GCP credentials) | `@pipedog/google/tts` | Cloud TTS `StreamingSynthesize`, gRPC | `@google-cloud/text-to-speech` |
| `GeminiTTSService` (`apiKey`) | `@pipedog/google/tts` | Gemini API, `fetch` | nothing extra (`@google/genai` is a dependency) |
| `GeminiSTTService` (`apiKey`) | `@pipedog/google/gemini_live/stt` | Gemini Live, `WebSocket` | nothing extra |
| `GeminiSTTService` (`vertexai`) | `@pipedog/google/gemini_live/stt` | Vertex AI Live, `WebSocket` | nothing extra (Google Cloud credentials or ADC) |

Google offers Cloud Speech streaming and Cloud TTS streaming over gRPC only, so those classes use
Google's Node SDKs, which are **optional peer dependencies**. They are loaded with `import()` the
first time a Cloud class connects or synthesizes. Importing a module, or using a Gemini class,
never loads them. A Cloud class whose SDK is missing reports `Missing module: …` as an error frame
and does not crash the process. (Despite its name, upstream's `GoogleHttpTTSService` also uses the
gRPC client, so this port does too.)

## Runtimes

| | Bun | Node ≥ 22 | Deno 2 | Cloudflare Workers |
|---|---|---|---|---|
| `GoogleSTTService` | ✅ | ✅ | ✅ | ❌ (gRPC over http2) |
| `GoogleHttpTTSService` | ✅ | ✅ | ✅ | ❌ (gRPC over http2) |
| `GoogleTTSService` | ✅ | ✅ | ✅ | ❌ (gRPC over http2) |
| `GeminiTTSService` (GCP) | ✅ | ✅ | ✅ | ❌ (gRPC over http2) |
| `GeminiTTSService` (Gemini API) | ✅ | ✅ | ✅ | ✅ |
| `GeminiSTTService` (Gemini API) | ✅ | ✅ | ✅ | ✅ |
| `GeminiSTTService` (Vertex AI) | ✅ | ✅ | ✅ | ❌ (google-auth-library) |

`compat/smoke.ts` checks each class on each runtime marked ✅. It runs real requests through the
real SDKs against in-process fakes (a gRPC server built from the SDK's own protobuf types, a fake
`fetch` serving server-sent events, and a fake Live WebSocket). On Workers it also checks that
the package imports cleanly and that the Cloud classes report the missing SDK.

## Chirp 3 speech-to-text

```ts
import { Language } from "@pipedog/core/transcriptions/language";
import { GoogleSTTService } from "@pipedog/google/stt";

const stt = new GoogleSTTService({
  credentialsPath: "/path/to/service-account.json", // or credentials: "<json>", or ADC
  location: "us", // Chirp 3 is regional
  settings: new GoogleSTTService.Settings({
    model: "chirp_3",
    languages: [Language.EN_US, Language.ES_ES],
    adaptation: { phrase_sets: [{ phrases: [{ value: "pipecat", boost: 15 }] }] },
    denoiserConfig: { denoise_audio: true },
  }),
});
```

The stream reconnects before Google's 5-minute limit (`STREAMING_LIMIT`, 4 minutes). It also
reconnects when Google aborts an idle stream.

## Chirp 3 HD text-to-speech (streaming)

```ts
import { GoogleTTSService } from "@pipedog/google/tts";

const tts = new GoogleTTSService({
  credentialsPath: "/path/to/service-account.json",
  settings: new GoogleTTSService.Settings({ voice: "en-US-Chirp3-HD-Charon", language: "en-US" }),
});
```

`GoogleHttpTTSService` takes the same credentials and makes one synthesis request per sentence.
It also accepts non-Chirp voices with SSML prosody (`pitch`, `rate`, `volume`, `emphasis`,
`googleStyle`).

## Gemini TTS

```ts
import { GeminiTTSService } from "@pipedog/google/tts";

// Gemini API (runs everywhere, including Workers):
const tts = new GeminiTTSService({
  apiKey: process.env.GOOGLE_API_KEY,
  settings: new GeminiTTSService.Settings({
    model: "gemini-3.8-flash-tts",
    voice: "Kore",
    prompt: "Warm and upbeat", // sent as speechMetadata.style on Gemini 3.8 models
  }),
});

// Or Cloud Text-to-Speech (GCP credentials, Node SDK):
const gcpTts = new GeminiTTSService({
  credentialsPath: "/path/to/service-account.json",
  settings: new GeminiTTSService.Settings({ model: "gemini-2.5-flash-tts", voice: "Kore" }),
});
```

Output is always 24 kHz.

## Gemini 3.5 transcribe (Live) speech-to-text

```ts
import { Language } from "@pipedog/core/transcriptions/language";
import { GeminiSTTService } from "@pipedog/google/gemini_live/stt";

const stt = new GeminiSTTService({
  apiKey: process.env.GOOGLE_API_KEY!,
  settings: new GeminiSTTService.Settings({
    // model defaults to "gemini-3.5-transcribe-live"; no languages = auto-detect
    languages: [Language.ES_ES],
    adaptationPhrases: ["oatmilk"],
    mode: "SMART",
  }),
});
```

Put a VAD before this service. On `VADUserStoppedSpeakingFrame` it sends `audioStreamEnd`, so the
final transcript arrives right away. The model performs best with 16 kHz mono PCM.

## Differences from upstream

- With `credentialsPath` or Application Default Credentials, `GoogleSTTService` reads credentials
  and the project ID on first connect rather than in the constructor, because reading them is
  asynchronous in JS. The Cloud TTS classes resolve ADC on the first request.
- `clientOptions` (all Cloud classes) is a pipedog addition. Its options go to the SDK client
  (`apiEndpoint`, `port`, `sslCreds`, …), e.g. for an emulator or a proxy.
- The JS SDKs put requests on the wire differently from Python's, with the same meaning. The
  gRPC clients send proto3 `false` defaults explicitly. The Gemini API client sends the API key as
  the `key` query parameter on Live, and uses camelCase JSON. On Live, `x-goog-api-client` is
  `pipecat/<version>` alone, where Python appends it to the SDK's own value.
- Deprecated upstream APIs (`InputParams`, `params`, `setLanguages()`, `updateOptions()`, …)
  are not ported. `GoogleSTTSettings.languageCodes` is kept, for codes such as `"auto"` (Chirp's
  language detection) that `Language` cannot express.
- pipedog additions: `finalizeOnVadStop` on `GoogleSTTService` (half-close the stream on
  `VADUserStoppedSpeakingFrame` for a final in about 0.6 s instead of 1.5 s), `client` and
  `bufferOnlyStartup` on `GoogleTTSService` and `GeminiTTSService`, and
  `GeminiTTSSettings.speakingRate`. A gRPC CANCELLED error (an interrupted or cancelled call)
  ends the stream quietly in the Cloud services instead of being reported.
- More pipedog additions: `sharedClient` and `prewarm()` on the Cloud classes (one gRPC client
  per endpoint and credentials in the process, connected at start-up),
  `GoogleSTTService.setLanguageCodes()` (reconnects when the bot starts speaking), and
  `retryOnBlocked` on `GeminiTTSService` (retries a sentence blocked for Google's usage
  guidelines). The Google TTS services work with the TTS audio cache (`audioCache`,
  `warmAudioCache()`), keyed also by `voiceCloningKey` and the Gemini backend.
