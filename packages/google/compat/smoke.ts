// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat.
//
// Everywhere (bun, node, deno, workerd):
// - imports every module of the package. The Node-only Cloud SDKs
//   (`@google-cloud/speech`, `@google-cloud/text-to-speech`) are optional
//   peers that tools/compat hides by default, so a static import of either
//   anywhere in the graph fails this smoke test;
// - constructs every class (the Cloud classes load their SDK lazily, so
//   constructing them needs no SDK);
// - runs `GeminiTTSService` (Gemini API backend) through the real
//   `@google/genai` client against an in-process fake `fetch` (SSE), and
//   `GeminiSTTService` through the real Live client against an in-process
//   fake WebSocket that speaks enough of BidiGenerateContent.
//
// Where the Cloud SDKs resolve (`--with-optional-peers`) and the runtime has
// Node's http2 (not workerd): runs `GoogleSTTService`, `GoogleHttpTTSService`,
// `GoogleTTSService` and `GeminiTTSService` (GCP backend) through the real
// SDK clients against an in-process gRPC server built from the SDK's own
// grpc-js and protobuf types.

import {
  ErrorFrame,
  type Frame,
  InputAudioRawFrame,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { LLMSearchResponseFrame } from "@pipedog/google/frames";
import { GeminiSTTService } from "@pipedog/google/gemini_live/stt";
import { GoogleSTTService, GoogleSTTSettings } from "@pipedog/google/stt";
import {
  GeminiTTSService,
  GeminiTTSSettings,
  GoogleHttpTTSService,
  GoogleTTSService,
} from "@pipedog/google/tts";
import { updateGoogleClientHttpOptions } from "@pipedog/google/utils";

type Any = any;

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`google smoke: ${message}`);
}

const CREDENTIALS = JSON.stringify({
  type: "service_account",
  project_id: "smoke-project",
  client_email: "smoke@smoke-project.iam.gserviceaccount.com",
  private_key: "not-a-real-key",
});

const PCM = Uint8Array.from({ length: 1200 }, (_, i) => (i * 5) & 0xff);

function runtime(): "bun" | "node" | "deno" | "workerd" {
  const g = globalThis as Any;
  if (g.navigator?.userAgent === "Cloudflare-Workers") return "workerd";
  if (g.Deno) return "deno";
  if (g.Bun) return "bun";
  return "node";
}

function concatAudio(frames: Frame[]): Uint8Array {
  const chunks = frames.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  const out = new Uint8Array(chunks.reduce((n, f) => n + f.audio.length, 0));
  let o = 0;
  for (const f of chunks) {
    out.set(f.audio, o);
    o += f.audio.length;
  }
  return out;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// ---------------------------------------------------------------------------
// Gemini API: TTS over a fake fetch (SSE)

async function geminiTts(): Promise<void> {
  const requests: { url: string; body: Any }[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    const sse = [PCM.subarray(0, 500), PCM.subarray(500)]
      .map((data) => ({
        candidates: [{ content: { parts: [{ inlineData: { data: bytesToBase64(data) } }] } }],
      }))
      .map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`)
      .join("");
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  };
  const tts = new GeminiTTSService({
    apiKey: "smoke-key",
    httpOptions: { baseUrl: "https://gemini.invalid", fetch: fakeFetch as Any },
    settings: new GeminiTTSSettings({ voice: "Puck" }),
  });
  const [down] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hello." })] });
  check(requests.length === 1, `gemini tts: ${requests.length} requests`);
  check(
    requests[0]!.url.includes("/models/gemini-3.1-flash-tts-preview:streamGenerateContent"),
    `gemini tts url ${requests[0]!.url}`,
  );
  check(
    requests[0]!.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName ===
      "Puck",
    "gemini tts voice",
  );
  check(sameBytes(concatAudio(down), PCM), "gemini tts audio");
}

// ---------------------------------------------------------------------------
// Gemini Live: STT over a fake WebSocket

/** The server half of a fake Live socket: answers setup and transcribes. */
function liveServer(conn: {
  onopen: () => void;
  onmessage: (e: { data: string }) => void;
  onclose: (e: { code: number; reason: string }) => void;
}) {
  const reply = (m: unknown) => queueMicrotask(() => conn.onmessage({ data: JSON.stringify(m) }));
  const sent: Any[] = [];
  return {
    sent,
    open: () => queueMicrotask(() => conn.onopen()),
    receive(raw: string) {
      const m = JSON.parse(raw);
      sent.push(m);
      if (m.setup) reply({ setupComplete: {} });
      if (m.realtimeInput?.audioStreamEnd) {
        reply({ serverContent: { inputTranscription: { text: "hola", languageCode: "es-ES" } } });
      }
    },
    close: () => queueMicrotask(() => conn.onclose({ code: 1000, reason: "" })),
  };
}

let lastLive: ReturnType<typeof liveServer> | null = null;

/** A browser-style WebSocket, for the SDK's web build (workerd, deno). */
class FakeBrowserWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  readonly url: string;
  #server: ReturnType<typeof liveServer>;
  constructor(url: string) {
    this.url = url;
    this.#server = liveServer({
      onopen: () => this.onopen?.(),
      onmessage: (e) => this.onmessage?.(e),
      onclose: (e) => this.onclose?.(e),
    });
    lastLive = this.#server;
    this.#server.open();
  }
  send(data: string) {
    this.#server.receive(data);
  }
  close() {
    this.#server.close();
  }
}

/** A `WebSocketFactory` for the SDK's node build (node, bun), which uses `ws`. */
const fakeFactory = {
  create(_url: string, _headers: Record<string, string>, callbacks: Any) {
    let server: ReturnType<typeof liveServer>;
    return {
      connect() {
        server = liveServer(callbacks);
        lastLive = server;
        server.open();
      },
      send: (m: string) => server.receive(m),
      close: () => server.close(),
    };
  },
};

async function geminiLiveStt(): Promise<void> {
  class SmokeGeminiSTT extends GeminiSTTService {
    protected override _createClient(): void {
      super._createClient();
      const live = (this._client as Any).live;
      if (live.webSocketFactory?.constructor?.name !== "BrowserWebSocketFactory") {
        live.webSocketFactory = fakeFactory;
      }
    }
  }
  const g = globalThis as Any;
  const realWebSocket = g.WebSocket;
  g.WebSocket = FakeBrowserWebSocket;
  try {
    const stt = new SmokeGeminiSTT({ apiKey: "smoke-key", sampleRate: 16000 });
    const [down] = await runTest(stt, {
      framesToSend: [
        new VADUserStartedSpeakingFrame(),
        new InputAudioRawFrame({ audio: PCM.subarray(0, 320), sampleRate: 16000, numChannels: 1 }),
        new SleepFrame({ sleep: 0.05 }),
        new VADUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.1 }),
      ],
    });
    const sent = lastLive?.sent ?? [];
    check(sent[0]?.setup?.model === "models/gemini-3.5-transcribe-live", "live setup");
    check(sent[1]?.realtimeInput?.audio?.mimeType === "audio/pcm;rate=16000", "live audio");
    check(sent[2]?.realtimeInput?.audioStreamEnd === true, "live stream end");
    const final = down.find((f) => f instanceof TranscriptionFrame) as TranscriptionFrame;
    check(final?.text === "hola" && final.language === "es-ES", "live transcription");
  } finally {
    g.WebSocket = realWebSocket;
  }
}

// ---------------------------------------------------------------------------
// Cloud Speech / Text-to-Speech over an in-process gRPC server

// Variable specifiers, as in the sources: never bundled.
const SPEECH = "@google-cloud/speech";
const TEXT_TO_SPEECH = "@google-cloud/text-to-speech";

async function importSdk(name: string): Promise<Any> {
  const mod = await import(/* @vite-ignore */ name);
  return mod.v1 || mod.v2 ? mod : mod.default;
}

/** A plain-text gRPC server for `service` using the SDK's own grpc-js and protobuf types. */
async function grpcServer(
  grpc: Any,
  service: string,
  methods: Record<
    string,
    { req: Any; res: Any; stream: boolean; handler: (call: Any, cb?: Any) => void }
  >,
): Promise<{ port: number; stop: () => void }> {
  const server = new grpc.Server();
  const definition: Any = {};
  const impl: Any = {};
  for (const [name, m] of Object.entries(methods)) {
    definition[name] = {
      path: `/${service}/${name}`,
      requestStream: m.stream,
      responseStream: m.stream,
      requestSerialize: (x: Any) => m.req.encode(m.req.fromObject(x)).finish(),
      requestDeserialize: (b: Uint8Array) => m.req.decode(b),
      responseSerialize: (x: Any) => m.res.encode(m.res.fromObject(x)).finish(),
      responseDeserialize: (b: Uint8Array) => m.res.decode(b),
    };
    impl[name] = m.handler;
  }
  server.addService(definition, impl);
  const port: number = await new Promise((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e: Any, p: number) =>
      e ? reject(e) : resolve(p),
    ),
  );
  return { port, stop: () => server.forceShutdown() };
}

function clientOptions(sdkClient: Any, port: number): Record<string, unknown> {
  // The SDK's grpc-js: channel credentials are checked with `instanceof`.
  const grpc = sdkClient._gaxGrpc.grpc;
  return { apiEndpoint: "127.0.0.1", port, sslCreds: grpc.credentials.createInsecure() };
}

async function cloudSpeech(): Promise<void> {
  const speech = await importSdk(SPEECH);
  const probe = new speech.v2.SpeechClient({ apiEndpoint: "127.0.0.1", port: 1 });
  const grpc = probe._gaxGrpc.grpc;
  const v2 = speech.protos.google.cloud.speech.v2;
  const seen: Any[] = [];
  const server = await grpcServer(grpc, "google.cloud.speech.v2.Speech", {
    StreamingRecognize: {
      req: v2.StreamingRecognizeRequest,
      res: v2.StreamingRecognizeResponse,
      stream: true,
      handler: (call) => {
        call.on("data", (req: Any) => {
          seen.push(req);
          if (req.audio?.length) {
            call.write({ results: [{ alternatives: [{ transcript: "hello" }], isFinal: true }] });
          }
        });
        call.on("end", () => call.end());
      },
    },
  });
  try {
    const stt = new GoogleSTTService({
      credentials: CREDENTIALS,
      sampleRate: 16000,
      clientOptions: clientOptions(probe, server.port),
      settings: new GoogleSTTSettings({ model: "chirp_3" }),
    });
    const [down] = await runTest(stt, {
      framesToSend: [
        new InputAudioRawFrame({ audio: PCM.subarray(0, 320), sampleRate: 16000, numChannels: 1 }),
        new SleepFrame({ sleep: 0.3 }),
      ],
    });
    check(
      seen[0]?.recognizer === "projects/smoke-project/locations/global/recognizers/_",
      "speech recognizer",
    );
    check(seen[0]?.streamingConfig?.config?.model === "chirp_3", "speech model");
    const final = down.find((f) => f instanceof TranscriptionFrame) as TranscriptionFrame;
    check(final?.text === "hello", "speech transcription");
  } finally {
    server.stop();
  }
}

async function cloudTextToSpeech(): Promise<void> {
  const sdk = await importSdk(TEXT_TO_SPEECH);
  const probe = new sdk.v1.TextToSpeechClient({ apiEndpoint: "127.0.0.1", port: 1 });
  const grpc = probe._gaxGrpc.grpc;
  const v1 = sdk.protos.google.cloud.texttospeech.v1;
  const wav = new Uint8Array(44 + PCM.length);
  wav.set(PCM, 44);
  const streamed: Any[] = [];
  const server = await grpcServer(grpc, "google.cloud.texttospeech.v1.TextToSpeech", {
    SynthesizeSpeech: {
      req: v1.SynthesizeSpeechRequest,
      res: v1.SynthesizeSpeechResponse,
      stream: false,
      handler: (_call, cb) => cb(null, { audioContent: wav }),
    },
    StreamingSynthesize: {
      req: v1.StreamingSynthesizeRequest,
      res: v1.StreamingSynthesizeResponse,
      stream: true,
      handler: (call) => {
        const requests: Any[] = [];
        streamed.push(requests);
        call.on("data", (req: Any) => {
          requests.push(req);
          if (req.input) call.write({ audioContent: PCM });
        });
        call.on("end", () => call.end());
      },
    },
  });
  try {
    const options = { credentials: CREDENTIALS, clientOptions: clientOptions(probe, server.port) };
    const services: [string, Any][] = [
      ["GoogleHttpTTSService", new GoogleHttpTTSService({ ...options, sampleRate: 24000 })],
      ["GoogleTTSService", new GoogleTTSService({ ...options, sampleRate: 24000 })],
      ["GeminiTTSService (GCP)", new GeminiTTSService(options)],
    ];
    for (const [name, tts] of services) {
      const [down] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hi." })] });
      check(sameBytes(concatAudio(down), PCM), `${name} audio`);
    }
    check(streamed.length === 2, "streaming calls");
    check(streamed[0][0].streamingConfig.voice.name === "en-US-Chirp3-HD-Charon", "chirp voice");
    check(
      streamed[1][0].streamingConfig.voice.modelName === "gemini-3.1-flash-tts-preview",
      "gemini",
    );
  } finally {
    server.stop();
  }
}

// ---------------------------------------------------------------------------

export default async function smoke(): Promise<Record<string, string>> {
  const rt = runtime();

  // Every class constructs on every runtime; the Cloud ones need no SDK for that.
  new GoogleSTTService({ credentials: CREDENTIALS });
  new GoogleHttpTTSService({ credentials: CREDENTIALS });
  new GoogleTTSService({ credentials: CREDENTIALS });
  new GeminiTTSService({ credentials: CREDENTIALS });
  new GeminiTTSService({ apiKey: "smoke-key" });
  new GeminiSTTService({ apiKey: "smoke-key" });
  check(new LLMSearchResponseFrame({}) instanceof LLMSearchResponseFrame, "frames");
  check(updateGoogleClientHttpOptions(null).headers !== undefined, "utils");

  await geminiTts();
  await geminiLiveStt();

  const ran: Record<string, string> = { gemini: "ok" };
  // Whether the Cloud SDKs load here. tools/compat hides optional peers from
  // the bundler, but the sources import the SDKs with a variable specifier
  // (so bundles never contain them), which only the runtime resolves; so ask
  // the runtime. On workerd they never load.
  const sdkLoads = async (name: string) =>
    import(/* @vite-ignore */ name).then(
      () => true,
      () => false,
    );
  const cloud = rt !== "workerd" && (await sdkLoads(SPEECH)) && (await sdkLoads(TEXT_TO_SPEECH));
  if (cloud) {
    await cloudSpeech();
    await cloudTextToSpeech();
    ran.cloud = "ok";
  } else {
    // Without the SDK a Cloud class reports it through the pipeline instead
    // of crashing.
    const tts = new GoogleHttpTTSService({ credentials: CREDENTIALS });
    const [, up] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hi." })] });
    const error = up.find((f) => f instanceof ErrorFrame) as ErrorFrame | undefined;
    check(
      error?.error.includes(`Missing module: ${TEXT_TO_SPEECH}`),
      `cloud tts without SDK: ${error?.error}`,
    );
    ran.cloud = "missing SDK reported";
  }
  return ran;
}
