// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_gemini_tts.py

/**
 * Tests for GeminiTTSService (GenAI and GCP backends).
 *
 * PORTING NOTES:
 * - `@patch("google.genai.Client")` → `patchGenaiClient(mock)`: a spy on
 *   `GeminiTTSService.prototype._createClient` that returns the mock for the
 *   GenAI backend (where upstream builds `genai.Client`).
 * - `@patch("google.cloud.texttospeech_v1.TextToSpeechAsyncClient")` (and
 *   `Credentials.from_service_account_info`) → `patchGcpClient(mock)`: a spy on
 *   `GoogleBaseTTSService.prototype._createClient`, the GCP client factory.
 *   Credentials JSON is only parsed in JS, so nothing else needs patching.
 * - `@patch("pipecat.services.google.tts.logger")` → `spyOn(logger, "warning")`.
 * - `patch.dict(os.environ, ...)` → setting `process.env` for the block.
 * - The GenAI JS SDK takes camelCase request fields (`responseModalities`,
 *   `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`,
 *   `speechMetadata.style`) and `inlineData` in responses.
 * - `requires_speech_metadata`: the JS SDK always supports `speechMetadata`,
 *   so those tests always run.
 */

import { afterEach, expect, type Mock, mock, spyOn, test } from "bun:test";
import {
  AggregatedTextFrame,
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { logger } from "@pipedog/core/utils/logger";
import { GeminiTTSService, GoogleBaseTTSService } from "../src/tts.ts";

type Internals = {
  _useGenai: boolean;
  _apiKey: string | null;
  _createClient: (credentials: string | null, credentialsPath: string | null) => unknown;
  _closeClient: () => Promise<void>;
  _updateSettings: (delta: unknown) => Promise<Record<string, unknown>>;
};

function internals(tts: GeminiTTSService): Internals {
  return tts as unknown as Internals;
}

function mockChunk(data: Uint8Array) {
  return { candidates: [{ content: { parts: [{ inlineData: { data } }] } }] };
}

function bytes(value: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function repeat(pattern: number[], times: number): Uint8Array {
  const out = new Uint8Array(pattern.length * times);
  for (let i = 0; i < times; i++) out.set(pattern, i * pattern.length);
  return out;
}

/** Minimal 44-byte RIFF/WAVE header for 16-bit mono PCM. */
function makeWavHeader(sampleRate = 24000, dataSize = 4800): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) header[offset + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  return header;
}

const restorers: (() => void)[] = [];

afterEach(() => {
  while (restorers.length > 0) restorers.pop()?.();
});

/** `@patch("google.genai.Client")`: the GenAI backend gets `client`. */
function patchGenaiClient(client: unknown): void {
  const proto = GeminiTTSService.prototype as unknown as Internals;
  const original = proto._createClient;
  const spy = spyOn(proto, "_createClient").mockImplementation(function (
    this: Internals,
    credentials,
    credentialsPath,
  ) {
    return this._useGenai ? client : original.call(this, credentials, credentialsPath);
  });
  restorers.push(() => spy.mockRestore());
}

/** `@patch("google.cloud.texttospeech_v1.TextToSpeechAsyncClient")`. */
function patchGcpClient(client: unknown): void {
  const proto = GoogleBaseTTSService.prototype as unknown as Internals;
  const spy = spyOn(proto, "_createClient").mockReturnValue(client);
  restorers.push(() => spy.mockRestore());
}

/** `@patch("pipecat.services.google.tts.logger")`. */
function patchLoggerWarning(): Mock<(message: string) => void> {
  const spy = spyOn(logger, "warning").mockImplementation(() => {});
  restorers.push(() => spy.mockRestore());
  return spy;
}

function warningsOf(warning: Mock<(message: string) => void>): string {
  return warning.mock.calls.map((call) => String(call[0])).join(" ");
}

/** `patch.dict(os.environ, env)`. */
function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function frameTypes(frames: Frame[]): unknown[] {
  return frames.map((f) => f.constructor);
}

test("test_genai_backend_success", async () => {
  // Setup mocks for GenAI Client
  const mockStream = mock(async (_params: unknown) =>
    (async function* () {
      yield mockChunk(bytes(0x00, 4800));
      yield mockChunk(bytes(0x01, 4800));
    })(),
  );
  patchGenaiClient({ models: { generateContentStream: mockStream } });

  // Initialize GeminiTTSService with apiKey explicitly triggering GenAI
  const tts = new GeminiTTSService({
    apiKey: "test-api-key",
    settings: new GeminiTTSService.Settings({
      model: "gemini-3.1-flash-tts-preview",
      voice: "Charon",
    }),
  });

  expect(internals(tts)._useGenai).toBe(true);
  expect(internals(tts)._apiKey).toBe("test-api-key");

  // Run test pipeline
  const framesToSend = [new TTSSpeakFrame({ text: "Hello world." })];

  const framesReceived = await runTest(tts, { framesToSend });
  const downFrames = framesReceived[0];
  const types = frameTypes(downFrames);

  expect(types).toContain(AggregatedTextFrame);
  expect(types).toContain(TTSStartedFrame);
  expect(types).toContain(TTSStoppedFrame);
  expect(types).toContain(TTSTextFrame);
  expect(types).toContain(TTSAudioRawFrame);

  const audioFrames = downFrames.filter((f) => f instanceof TTSAudioRawFrame);
  expect(audioFrames.length).toBeGreaterThanOrEqual(1);
  for (const aFrame of audioFrames) {
    expect(aFrame.sampleRate).toBe(24000);
  }
});

test("test_env_var_does_not_select_genai_backend", () => {
  // GOOGLE_API_KEY in the env must not flip a credentialed service onto GenAI.
  //
  // The env var is commonly set for other Google services (e.g. the LLM), so it
  // must not silently override an explicit `credentials` GCP configuration.
  patchGcpClient({});

  const tts = withEnv(
    { GOOGLE_API_KEY: "env-key" },
    () => new GeminiTTSService({ credentials: '{"type": "service_account"}' }),
  );

  expect(internals(tts)._useGenai).toBe(false);
  // The key is only resolved for the GenAI backend; on GCP it stays unset.
  expect(internals(tts)._apiKey).toBeNull();
});

test("test_use_genai_true_resolves_env_api_key", () => {
  // `useGenai: true` selects GenAI and resolves the key from the env.
  patchGenaiClient({});

  const tts = withEnv(
    { GOOGLE_API_KEY: "env-key" },
    () => new GeminiTTSService({ useGenai: true }),
  );

  expect(internals(tts)._useGenai).toBe(true);
  expect(internals(tts)._apiKey).toBe("env-key");
});

test("test_use_genai_false_overrides_api_key", () => {
  // An explicit `useGenai: false` wins even when an `apiKey` is passed.
  patchGcpClient({});

  const tts = new GeminiTTSService({
    useGenai: false,
    apiKey: "explicit-key",
    credentials: '{"type": "service_account"}',
  });

  expect(internals(tts)._useGenai).toBe(false);
  expect(internals(tts)._apiKey).toBeNull();
});

test("test_close_client_closes_genai_session", async () => {
  // The GenAI client's async session is closed; the GCP path is a no-op.
  const aclose = mock(async () => {});
  patchGenaiClient({ aclose });

  const tts = new GeminiTTSService({ apiKey: "test-api-key" });
  await internals(tts)._closeClient();

  expect(aclose).toHaveBeenCalledTimes(1);
});

test("test_warns_for_unsupported_genai_settings_at_init", () => {
  // GenAI ignores prompt/style (pre-3.8) and multi-speaker; warn once at construction.
  const warning = patchLoggerWarning();
  patchGenaiClient({});

  new GeminiTTSService({
    apiKey: "test-api-key",
    settings: new GeminiTTSService.Settings({ prompt: "Speak clearly", multiSpeaker: true }),
  });

  const warnings = warningsOf(warning);
  expect(warnings).toContain("Prompt");
  expect(warnings).toContain("Multi-speaker");
});

test("test_no_prompt_warning_for_genai_38_model", () => {
  // Gemini 3.8 TTS models support prompt (as speechMetadata.style); multi-speaker still warns.
  const warning = patchLoggerWarning();
  patchGenaiClient({});

  new GeminiTTSService({
    apiKey: "test-api-key",
    settings: new GeminiTTSService.Settings({
      model: "gemini-3.8-flash-tts",
      prompt: "Speak clearly",
      multiSpeaker: true,
    }),
  });

  const warnings = warningsOf(warning);
  expect(warnings).not.toContain("Prompt");
  expect(warnings).toContain("Multi-speaker");
});

test("test_no_warning_for_voice_design_id", () => {
  // Voice design `voice_...` IDs are never in the prebuilt list; don't warn about them.
  const warning = patchLoggerWarning();
  patchGenaiClient({});

  new GeminiTTSService({
    apiKey: "test-api-key",
    settings: new GeminiTTSService.Settings({ voice: "voice_abc123" }),
  });

  const warnings = warningsOf(warning);
  expect(warnings).not.toContain("not in known voices list");
});

test("test_update_settings_warns_for_unsupported_genai_prompt", async () => {
  // A runtime settings change to an unsupported field warns on the GenAI backend.
  const warning = patchLoggerWarning();
  patchGenaiClient({});

  const tts = new GeminiTTSService({ apiKey: "test-api-key" });
  warning.mockClear();

  await internals(tts)._updateSettings(
    new GeminiTTSService.Settings({ prompt: "Now use a style" }),
  );

  const warnings = warningsOf(warning);
  expect(warnings).toContain("Prompt");
});

test("test_update_settings_no_prompt_warning_on_genai_38", async () => {
  // A runtime prompt change doesn't warn when the current model is 3.8-family.
  const warning = patchLoggerWarning();
  patchGenaiClient({});

  const tts = new GeminiTTSService({
    apiKey: "test-api-key",
    settings: new GeminiTTSService.Settings({ model: "gemini-3.8-flash-tts" }),
  });
  warning.mockClear();

  await internals(tts)._updateSettings(
    new GeminiTTSService.Settings({ prompt: "Now use a style" }),
  );

  const warnings = warningsOf(warning);
  expect(warnings).not.toContain("Prompt");
});

test("test_no_genai_warning_on_gcp_backend", () => {
  // The GCP backend supports prompt/multi-speaker, so it must not warn about them.
  const warning = patchLoggerWarning();
  patchGcpClient({});

  new GeminiTTSService({
    credentials: '{"type": "service_account"}',
    settings: new GeminiTTSService.Settings({ prompt: "Speak clearly", multiSpeaker: true }),
  });

  const warnings = warningsOf(warning);
  expect(warnings).not.toContain("Prompt");
  expect(warnings).not.toContain("Multi-speaker");
});

test("test_gcp_backend_success", async () => {
  // Setup mocks for GCP Client; mock chunk responses
  async function* mockGenerator() {
    yield { audioContent: bytes(0x02, 4800) };
    yield { audioContent: bytes(0x03, 4800) };
  }

  const mockStreamingSynthesize = mock(async (_requests: unknown) => mockGenerator());
  patchGcpClient({ streamingSynthesize: mockStreamingSynthesize });

  // Initialize GeminiTTSService using credentials triggering GCP client
  const tts = new GeminiTTSService({
    credentials: '{"type": "service_account"}',
    settings: new GeminiTTSService.Settings({
      model: "gemini-3.1-flash-tts-preview",
      voice: "Charon",
      prompt: "Speak clearly",
    }),
  });

  expect(internals(tts)._useGenai).toBe(false);

  // Run test pipeline
  const framesToSend = [new TTSSpeakFrame({ text: "Hello world." })];

  const framesReceived = await runTest(tts, { framesToSend });
  const downFrames = framesReceived[0];
  const types = frameTypes(downFrames);

  expect(types).toContain(AggregatedTextFrame);
  expect(types).toContain(TTSStartedFrame);
  expect(types).toContain(TTSStoppedFrame);
  expect(types).toContain(TTSTextFrame);
  expect(types).toContain(TTSAudioRawFrame);

  const audioFrames = downFrames.filter((f) => f instanceof TTSAudioRawFrame);
  expect(audioFrames.length).toBeGreaterThanOrEqual(1);
});

test("test_genai_38_request_shape", async () => {
  // 3.8 models send the prompt as a structured speechMetadata.style annotation.
  const mockStream = mock(async (_params: unknown) =>
    (async function* () {
      yield mockChunk(bytes(0x00, 4800));
    })(),
  );
  patchGenaiClient({ models: { generateContentStream: mockStream } });

  const tts = new GeminiTTSService({
    apiKey: "test-api-key",
    settings: new GeminiTTSService.Settings({
      model: "gemini-3.8-flash-tts",
      voice: "Puck",
      prompt: "Whispering, slow",
    }),
  });

  await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hello world." })] });

  const kwargs = mockStream.mock.lastCall?.[0] as any;
  expect(kwargs.model).toBe("gemini-3.8-flash-tts");

  const part = kwargs.contents[0].parts[0];
  expect(part.text).toBe("Hello world.");
  expect(part.speechMetadata.style).toBe("Whispering, slow");

  const config = kwargs.config;
  expect(config.responseModalities).toEqual(["AUDIO"]);
  expect(config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Puck");
});

test("test_genai_38_strips_wav_header", async () => {
  // A RIFF header on a 3.8 response is stripped rather than played as audio.
  const payload = repeat([0x01, 0x02], 2400);

  const mockStream = mock(async (_params: unknown) =>
    (async function* () {
      yield mockChunk(concat(makeWavHeader(24000, payload.length), payload));
      yield mockChunk(repeat([0x03, 0x04], 2400));
    })(),
  );
  patchGenaiClient({ models: { generateContentStream: mockStream } });

  const tts = new GeminiTTSService({
    apiKey: "test-api-key",
    settings: new GeminiTTSService.Settings({ model: "gemini-3.8-flash-tts", voice: "Puck" }),
  });

  const framesReceived = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello world." })],
  });
  const downFrames = framesReceived[0];

  const audio = concat(
    ...downFrames.filter((f) => f instanceof TTSAudioRawFrame).map((f) => f.audio),
  );
  const riff = new TextEncoder().encode("RIFF");
  expect(Array.from(audio.slice(0, 4))).not.toEqual(Array.from(riff));
  expect(audio).toEqual(concat(payload, repeat([0x03, 0x04], 2400)));
});

// DIVERGENCE: upstream gates Gemini 3.8 models on the installed Python SDK
// exposing `google.genai.types.SpeechMetadata` and reports the service unusable
// otherwise. The JS SDK passes request objects through, so the port always
// supports `speechMetadata` (`GENAI_SUPPORTS_SPEECH_METADATA` is a constant)
// and there is no older SDK to simulate.
test.skip("test_genai_38_requires_new_sdk", async () => {
  const generateContentStream = mock(async () => (async function* () {})());
  patchGenaiClient({ models: { generateContentStream } });

  const tts = new GeminiTTSService({
    apiKey: "test-api-key",
    settings: new GeminiTTSService.Settings({ model: "gemini-3.8-flash-tts", voice: "Puck" }),
  });

  const framesReceived = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello world." })],
  });

  const upFrames = framesReceived[1];
  const errors = upFrames.filter((f) => f instanceof ErrorFrame).map((f) => f.error);
  expect(errors.some((error) => error.includes("google-genai >= 2.25.0"))).toBe(true);
  expect(tts.isUsable).toBe(false);
  expect(generateContentStream).not.toHaveBeenCalled();
});
