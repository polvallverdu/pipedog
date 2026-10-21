---
"@pipedog/audio-smart-turn": minor
"@pipedog/audio-rnnoise-filter": minor
"@pipedog/audio-soundfile-mixer": minor
"@pipedog/transport-whatsapp": minor
"@pipedog/transport-local": minor
---

Five more upstream modules.

- `@pipedog/audio-smart-turn`: `HttpSmartTurnAnalyzer`, Smart Turn over HTTP. It needs only `fetch`, so it runs on every runtime, Workers included, and takes a `fetch` option where upstream takes an aiohttp session.
- `@pipedog/audio-rnnoise-filter` (new): `RNNoiseFilter`. RNNoise 0.2 runs as WebAssembly (the module `@jitsi/rnnoise-wasm` builds, 1.4 MB, shipped in the package) instead of the native `pyrnnoise`, so it works on Bun, Node, Deno and Cloudflare Workers.
- `@pipedog/audio-soundfile-mixer` (new): `SoundfileMixer`. WAV only, parsed in pure TypeScript instead of libsndfile. Sounds can be bytes, a URL or a path (a path needs a filesystem).
- `@pipedog/transport-whatsapp` (new): `WhatsAppClient` and `WhatsAppApi` for WhatsApp Business calling: Meta's webhooks, HMAC signature checks, `pre_accept`, `accept`, `reject` and `terminate`, on SmallWebRTC. Whole calls run on Bun, Node and Deno. On Workers only the webhook verification, signature check and API calls work.
- `@pipedog/transport-local` (new): `LocalAudioTransport`, the machine's microphone and speakers through `sox` or `ffmpeg` child processes, with no native addon. Bun, Node and Deno only. It throws a clear error when neither tool is installed.

Docs: a new Audio filters & mixers section, the HTTP Smart Turn section of the turn detection page, WhatsApp and Local audio transport pages, and a per-package runtime matrix that also says what each runtime needs. Not ported, on purpose: `local_smart_turn_v2`, `local_coreml_smart_turn` (Smart Turn v3 replaces them) and the Tkinter transport.
