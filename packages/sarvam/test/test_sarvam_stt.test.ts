// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_sarvam_stt.py

/**
 * Tests for the Sarvam STT services.
 *
 * Porting notes:
 * - `monkeypatch.setattr(service, name, fake)` → assigning the instance
 *   property; `monkeypatch.setattr(Class, name, fake)` → `spyOn` on the
 *   prototype, restored in a `finally`.
 * - `websockets.asyncio.server.serve` → `Bun.serve` with WebSocket handlers.
 * - `frame_processor_setup` (tests/frame_processor_helpers.py) is ported
 *   locally.
 * - `_FakeSarvamMessage` stood in for the SDK's parsed response object. This
 *   port has no SDK, so a response is the parsed JSON dict
 *   (`{type: "data", data: {transcript, language_code}}`).
 * - `test_legacy_sdk_carries_keyterms_on_every_connection` patched the SDK's
 *   `websockets_client_connect`; here a local WebSocket server receives the
 *   handshake, so it checks the real wire query and headers.
 * - The deprecated `Settings.language_code` tests are skipped: that setting is
 *   not ported.
 * - `test_endpointing_is_not_a_setting`: Python raises `TypeError` for the
 *   unknown keyword; TypeScript rejects it at compile time (checked with
 *   `@ts-expect-error`) and the settings class never declares the field.
 * - `test_connect_uses_subscription_key_and_user_agent`: the User-Agent travels
 *   in `additionalHeaders` (there is no `user_agent_header` option), and the
 *   call is intercepted on `_websocketConnect`, which applies the close
 *   timeout, so the `close_timeout` check has nothing left to assert.
 * - `test_string_language_setting_does_not_use_enum_converter` patched the
 *   module function; here the service's `languageToServiceLanguage` is spied.
 * - `test_dropped_connection_is_reopened` gives the reconnect backoff a short
 *   floor so the test does not wait out the default.
 * - `_FakeSarvamRealtime`: `websocket.transport.abort()` → `terminate()`. A
 *   Bun server keeps delivering messages while a handler awaits, so a dropped
 *   connection ignores the audio that arrives during its pre-drop pause.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { sleep } from "@pipedog/asyncio";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  ErrorFrame,
  type Frame,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  MetricsFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  STTUpdateSettingsFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { STTUsageMetricsData } from "@pipedog/core/metrics/metrics";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import {
  FrameDirection,
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "@pipedog/core/processors/frame_processor";
import * as RTVI from "@pipedog/core/processors/frameworks/rtvi/models";
import { RTVIProcessor } from "@pipedog/core/processors/frameworks/rtvi/processor";
import { STTSettings } from "@pipedog/core/services/settings";
import { WebsocketSTTService } from "@pipedog/core/services/stt_service";
import {
  ConnectionClosedError,
  State,
  type WebsocketData,
} from "@pipedog/core/services/websocket_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { type BaseTaskManager, TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import type { ServerWebSocket } from "bun";
import { sdkHeaders } from "../src/_sdk.ts";
import {
  MODEL_CONFIGS,
  SarvamRealtimeSTTService,
  SarvamRealtimeSTTSettings,
  SarvamSTTService,
} from "../src/stt.ts";

type Dict = Record<string, any>;

/** Local port of upstream tests/frame_processor_helpers.py `frame_processor_setup`. */
function frameProcessorSetup(
  taskManager: BaseTaskManager,
  options: Partial<FrameProcessorSetupOptions> = {},
): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    ...options,
    taskManager,
  });
}

class _FakeWebsocket {
  state: State;
  sent: string[] = [];
  closed = false;
  readonly #messages: WebsocketData[];

  constructor(messages: WebsocketData[] = [], options: { state?: State } = {}) {
    this.#messages = messages;
    this.state = options.state ?? State.OPEN;
  }

  async send(message: string): Promise<void> {
    this.sent.push(message);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.state = State.CLOSED;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<WebsocketData, void, unknown> {
    for (const message of this.#messages) {
      yield message;
    }
  }
}

const _SESSION_BEGIN = JSON.stringify({ event: "session.begin", request_id: "test-request" });

function _query(
  service: SarvamRealtimeSTTService,
  options: { sampleRate?: number } = {},
): Record<string, string[]> {
  // The URL is only built after StartFrame resolves the rate, so mirror what
  // STTService.start() does here.
  const svc = service as any;
  svc._sampleRate = svc._initSampleRate || (options.sampleRate ?? 16000);
  return _parseQuery(service._buildWsUrl());
}

function _parseQuery(url: string): Record<string, string[]> {
  const params = new URL(url).searchParams;
  const out: Record<string, string[]> = {};
  for (const key of new Set(params.keys())) {
    out[key] = params.getAll(key);
  }
  return out;
}

/** Byte count for `seconds` of 16-bit mono audio. */
function _secondsToBytes(seconds: number, options: { sampleRate?: number } = {}): number {
  return Math.trunc(seconds * (options.sampleRate ?? 16000) * 2);
}

async function _consume(generator: AsyncGenerator<unknown, void, unknown>): Promise<void> {
  for await (const _ of generator) {
    // drain
  }
}

const _noop = async (..._args: unknown[]): Promise<void> => {};

function _capture(frames: unknown[]) {
  return async (frame: unknown, ..._args: unknown[]) => {
    frames.push(frame);
  };
}

const _captureClass = _capture;

function _legacyData(transcript: string, languageCode: string | null = null): Dict {
  return { type: "data", data: { transcript, language_code: languageCode } };
}

test("test_supported_models", () => {
  // The sunset saarika:v2.5 and saaras:v2.5 models are no longer offered.
  expect(new Set(Object.keys(MODEL_CONFIGS))).toEqual(new Set(["saaras:v3", "saaras:v4"]));
});

test("test_default_model", () => {
  // Constructing without a model picks up the latest one.
  const service: any = new SarvamSTTService({ apiKey: "test-key" });
  expect(service._settings.model).toBe("saaras:v4");
});

test("test_sunset_model_raises", () => {
  // A model that was removed reports what it can be replaced with.
  expect(
    () =>
      new SarvamSTTService({
        apiKey: "test-key",
        settings: new SarvamSTTService.Settings({ model: "saaras:v2.5" }),
      }),
  ).toThrow("saaras:v3, saaras:v4");
});

test("test_sarvam_vad_signals_recommend_external_strategies", () => {
  // With `vadSignals` on, Sarvam's boundaries are what drive turns.
  const service = new SarvamSTTService({
    apiKey: "test-key",
    settings: new SarvamSTTService.Settings({ model: "saaras:v3", vadSignals: true }),
  });
  const strategies = service.serviceMetadataFrame().userTurnStrategies;
  expect(strategies).toBeInstanceOf(ExternalUserTurnStrategies);
});

test("test_sarvam_without_vad_signals_recommends_no_strategies", () => {
  // Without them Sarvam proposes no turns, so the defaults stand.
  const service = new SarvamSTTService({ apiKey: "test-key" });
  expect(service.serviceMetadataFrame().userTurnStrategies).toBeNull();
});

test("test_default_configuration_leaves_language_unset", async () => {
  // No configured language and no language_code on the message -- Sarvam's own
  // "unknown" auto-detect placeholder -- leaves the frame's language unset
  // rather than guessing one.
  const service: any = new SarvamSTTService({ apiKey: "test-key" });
  const pushed: any[] = [];
  service.pushFrame = _capture(pushed);

  await service._handleMessage(_legacyData("Hello there"));

  expect(pushed).toHaveLength(1);
  expect(pushed[0].language).toBeNull();
});

test("test_unrecognized_language_code_leaves_language_unset", async () => {
  // An unrecognized code leaves the frame language unset and warns once.
  const service: any = new SarvamSTTService({ apiKey: "test-key" });
  const pushed: any[] = [];
  service.pushFrame = _capture(pushed);

  await service._handleMessage(_legacyData("first", "new-IN"));
  await service._handleMessage(_legacyData("second", "new-IN"));

  expect(pushed[0].language).toBeNull();
  expect(pushed[1].language).toBeNull();
  expect(service._unmappedLanguageCodesWarned).toEqual(new Set(["new-IN"]));
});

test("test_recognized_language_code_is_mapped", async () => {
  // A language_code the table does have an entry for still resolves normally.
  const service: any = new SarvamSTTService({ apiKey: "test-key" });
  const pushed: any[] = [];
  service.pushFrame = _capture(pushed);

  await service._handleMessage(_legacyData("नमस्ते", "hi-IN"));

  expect(pushed[0].language).toBe(Language.HI_IN);
});

describe("test_previously_missing_codes_now_map", () => {
  // Supported Sarvam locale codes resolve to exact Language members.
  test.each([
    ["ur-IN", Language.UR_IN],
    ["mai-IN", Language.MAI_IN],
    ["sd-IN", Language.SD_IN],
    ["kok-IN", Language.KOK_IN],
    ["ne-IN", Language.NE_IN],
    ["ks-IN", Language.KS_IN],
    ["sa-IN", Language.SA_IN],
    ["sat-IN", Language.SAT_IN],
    ["mni-IN", Language.MNI_IN],
    ["brx-IN", Language.BRX_IN],
    ["doi-IN", Language.DOI_IN],
  ])("%s", (languageCode, language) => {
    const service = new SarvamSTTService({ apiKey: "test-key" });
    expect(languageCode).toBe(language);
    expect(service._mapLanguageCodeToEnum(languageCode)).toBe(language);
  });
});

test("test_configured_language_is_used_when_message_has_none", () => {
  // An explicitly configured language is honored when the message carries none.
  const service = new SarvamSTTService({
    apiKey: "test-key",
    settings: new SarvamSTTService.Settings({ language: Language.EN_IN }),
  });
  expect(service._mapLanguageCodeToEnum(service._getLanguageString())).toBe(Language.EN_IN);
});

describe("test_base_language_settings_use_sarvam_locale_codes", () => {
  test.each([
    [Language.HI, "hi-IN", "hi-IN"],
    [Language.OR, "od-IN", "or-IN"],
    [Language.NE, "ne-IN", "ne-IN"],
    [Language.SA, "sa-IN", "sa-IN"],
    [Language.KOK, "kok-IN", "kok-IN"],
    [Language.MAI, "mai-IN", "mai-IN"],
    [Language.SD, "sd-IN", "sd-IN"],
    [Language.UR, "ur-IN", "ur-IN"],
  ])("%s", (language, legacyCode, realtimeCode) => {
    const legacy = new SarvamSTTService({
      apiKey: "test-key",
      settings: new SarvamSTTService.Settings({ language }),
    });
    const realtime = new SarvamRealtimeSTTService({
      apiKey: "test-key",
      settings: new SarvamRealtimeSTTService.Settings({ language }),
    });

    expect(legacy._getLanguageString()).toBe(legacyCode);
    expect(_query(realtime).language_code).toEqual([realtimeCode]);
  });
});

test("test_realtime_unrecognized_language_is_passed_through", async () => {
  const service: any = new SarvamRealtimeSTTService({
    apiKey: "test-key",
    settings: new SarvamRealtimeSTTService.Settings({ language: "new-IN" }),
  });
  expect(_query(service).language_code).toEqual(["new-IN"]);

  service._websocket = new _FakeWebsocket();
  await service._updateSettings(new STTSettings({ language: "next-IN" }));
  expect(service._websocket.sent.map((message: string) => JSON.parse(message))).toEqual([
    { event: "config.update", language_code: "next-IN" },
  ]);
  expect(service._settings.language).toBe("next-IN");
});

test("test_realtime_raw_language_through_pipeline_and_websocket", async () => {
  const queries: Record<string, string[]>[] = [];
  const messages: Dict[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      queries.push(_parseQuery(request.url));
      if (srv.upgrade(request)) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(_ws, raw) {
        messages.push(JSON.parse(String(raw)));
      },
    },
  });
  let service: any;
  try {
    service = new SarvamRealtimeSTTService({
      apiKey: "test-key",
      baseUrl: `ws://127.0.0.1:${server.port}/speech-to-text/realtime`,
      settings: new SarvamRealtimeSTTService.Settings({ language: "ne-IN" }),
    });
    await runTest(service, {
      framesToSend: [
        new STTUpdateSettingsFrame({ delta: new STTSettings({ language: "ks-IN" }) }),
        new STTUpdateSettingsFrame({ delta: new STTSettings({ language: null }) }),
        new STTUpdateSettingsFrame({ delta: new STTSettings({ language: "new-IN" }) }),
      ],
    });
    await Bun.sleep(50);
  } finally {
    server.stop(true);
  }

  expect(queries[0]?.language_code).toEqual(["ne-IN"]);
  expect(messages.filter((message) => message.event === "config.update")).toEqual([
    { event: "config.update", language_code: "ks-IN" },
    { event: "config.update", language_code: "auto" },
    { event: "config.update", language_code: "new-IN" },
  ]);
  expect(service._settings.language).toBe("new-IN");
});

describe("test_settings_fields_cannot_be_constructor_kwargs", () => {
  test.each([
    ["streamType", "balanced"],
    ["mode", "translate"],
  ])("%s", (field, value) => {
    expect(
      () => new SarvamRealtimeSTTService({ apiKey: "test-key", [field]: value } as any),
    ).toThrow("settings:");
    expect(
      () => new SarvamRealtimeSTTService({ apiKey: "test-key", [field]: value } as any),
    ).toThrow(TypeError);
  });
});

test("test_settings_values_are_applied_via_settings", () => {
  const service = new SarvamRealtimeSTTService({
    apiKey: "test-key",
    settings: new SarvamRealtimeSTTService.Settings({
      streamType: "balanced",
      mode: "translate",
    }),
  });

  const query = _query(service);

  expect(query.stream_type).toEqual(["balanced"]);
  expect(query.mode).toEqual(["translate"]);
});

test("test_connection_only_values_are_applied_via_constructor_arguments", () => {
  const service = new SarvamRealtimeSTTService({
    apiKey: "test-key",
    sampleRate: 8000,
    returnTimestamps: true,
    prefixPaddingMs: 200,
  });

  const query = _query(service);

  expect(query.sample_rate).toEqual(["8000"]);
  expect(query.return_timestamps).toEqual(["true"]);
  expect(query.prefix_padding_ms).toEqual(["200"]);
});

test("test_default_url_uses_realtime_contract_params", () => {
  const service = new SarvamRealtimeSTTService({ apiKey: "test-key" });

  const query = _query(service);

  expect(service._buildWsUrl().startsWith("wss://api.sarvam.ai/speech-to-text-realtime/ws?")).toBe(
    true,
  );
  expect(query.language_code).toEqual(["en-IN"]);
  expect(query.stream_type).toEqual(["balanced"]);
  expect(query.endpointing).toEqual(["vad"]);
  expect(query.encoding).toEqual(["linear16"]);
  expect(query.sample_rate).toEqual(["16000"]);
  expect(query.model).toEqual(["saaras:v3-realtime"]);
  expect(query.mode).toEqual(["transcribe"]);
  expect(query.return_timestamps).toEqual(["false"]);
});

test("test_validation_accepts_auto_language_and_modes", () => {
  const service = new SarvamRealtimeSTTService({
    apiKey: "test-key",
    settings: new SarvamRealtimeSTTService.Settings({
      language: null,
      mode: "translate",
      threshold: 0.4,
      silenceDurationMs: 700,
    }),
  });

  const query = _query(service);

  expect(query.language_code).toEqual(["auto"]);
  expect(query.mode).toEqual(["translate"]);
  expect(query.threshold).toEqual(["0.4"]);
  expect(query.silence_duration_ms).toEqual(["700"]);
});

test("test_string_language_setting_does_not_use_enum_converter", () => {
  const spy = spyOn(SarvamRealtimeSTTService.prototype, "languageToServiceLanguage");
  try {
    const service = new SarvamRealtimeSTTService({
      apiKey: "test-key",
      settings: new SarvamRealtimeSTTService.Settings({ language: "hi-IN" }),
    });

    expect(_query(service).language_code).toEqual(["hi-IN"]);
    // Resolved through the enum path rather than forwarded as a raw string.
    expect(spy.mock.calls.map((call) => call[0])).toContain(Language.HI_IN);
  } finally {
    spy.mockRestore();
  }
});

test("test_invalid_realtime_settings_raise", () => {
  // Only the settings this integration itself depends on are checked here.
  expect(
    () =>
      new SarvamRealtimeSTTService({
        apiKey: "test-key",
        settings: new SarvamRealtimeSTTService.Settings({ model: "saaras:v3" }),
      }),
  ).toThrow();
});

test("test_unusable_sample_rate_raises", () => {
  // The audio path has to produce this rate, so it can't wait for the wire.
  expect(() => new SarvamRealtimeSTTService({ apiKey: "test-key", sampleRate: 44100 })).toThrow(
    "44100",
  );
});

describe("test_sarvam_vocabulary_is_left_to_the_server", () => {
  // Sarvam rejects these on the wire, and the rejection reaches the app.
  //
  // Repeating its vocabulary here would block values Sarvam adds later, so
  // construction has to accept anything it does not itself depend on.
  test.each([
    ["language fr-FR", () => new SarvamRealtimeSTTService.Settings({ language: "fr-FR" })],
    [
      "stream_type slow",
      () => new SarvamRealtimeSTTService.Settings({ streamType: "slow" as any }),
    ],
    ["mode sing", () => new SarvamRealtimeSTTService.Settings({ mode: "sing" as any })],
    ["threshold 1.1", () => new SarvamRealtimeSTTService.Settings({ threshold: 1.1 })],
  ])("%s", (_name, makeSettings) => {
    new SarvamRealtimeSTTService({ apiKey: "test-key", settings: makeSettings() });
  });
});

test("test_endpointing_is_not_a_setting", () => {
  // The mode picks the turn strategies, which are announced once at startup.
  //
  // Leaving it out of `Settings` is what makes a mid-session switch -- which the
  // user aggregator would never see -- impossible to express.
  // @ts-expect-error `endpointing` is not a settings option.
  const settings = new SarvamRealtimeSTTService.Settings({ endpointing: "manual" });
  expect("endpointing" in settings).toBe(false);
});

test("test_connect_uses_subscription_key_and_user_agent", async () => {
  const captured: Dict = {};
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  service._websocketConnect = async (url: string, options: Dict) => {
    captured.url = url;
    captured.options = options;
    return new _FakeWebsocket();
  };

  await service._connectWebsocket();

  expect(captured.url).toBe(service._buildWsUrl());
  expect(captured.options.additionalHeaders).toEqual({
    "API-SUBSCRIPTION-KEY": "test-key",
    "User-Agent": sdkHeaders()["User-Agent"],
  });
});

test("test_failed_connect_leaves_the_service_usable", async () => {
  // A socket that never opened can still be opened on a later attempt.
  //
  // `_tryReconnect` skips a service that has stopped being usable, so
  // reporting the failure as permanent would bar the retry that could fix it.
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  service._websocketConnect = async () => {
    throw new Error("no route to host");
  };
  service.pushFrame = _noop;

  await service._connectWebsocket();

  expect(service._websocket).toBeNull();
  expect(service.isUsable).toBe(true);
});

describe("test_client_sends_50ms_chunks_regardless_of_stream_type", () => {
  test.each(["fast", "balanced", "simulated"] as const)("%s", async (streamType) => {
    const service: any = new SarvamRealtimeSTTService({
      apiKey: "test-key",
      settings: new SarvamRealtimeSTTService.Settings({ streamType }),
    });
    service._websocket = new _FakeWebsocket();
    service._sampleRate = 16000;

    // 16 kHz linear16 => 1600 bytes per 50 ms.
    await _consume(service.runStt(new Uint8Array(800).fill(1)));
    expect(service._websocket.sent).toEqual([]);

    await _consume(service.runStt(new Uint8Array(800).fill(2)));

    const expectedAudio = new Uint8Array(1600);
    expectedAudio.fill(1, 0, 800);
    expectedAudio.fill(2, 800);
    expect(service._websocket.sent).toEqual([
      pyJsonDumps({ event: "audio_input", audio: bytesToBase64(expectedAudio) }),
    ]);
  });
});

test("test_manual_endpointing_sends_speech_boundaries", async () => {
  const service: any = new SarvamRealtimeSTTService({
    apiKey: "test-key",
    endpointing: "manual",
  });
  service._websocket = new _FakeWebsocket();
  service.pushFrame = _noop;

  await service.processFrame(new VADUserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM);
  await service.processFrame(new VADUserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM);

  expect(service._websocket.sent).toEqual([
    pyJsonDumps({ event: "speech_start" }),
    pyJsonDumps({ event: "speech_end" }),
  ]);
});

test("test_manual_endpointing_flushes_buffered_audio_before_speech_end", async () => {
  const service: any = new SarvamRealtimeSTTService({
    apiKey: "test-key",
    endpointing: "manual",
  });
  service._websocket = new _FakeWebsocket();
  service._sampleRate = 16000;
  service.pushFrame = _noop;

  // Less than one 50 ms chunk, so it stays buffered until the turn ends.
  await _consume(service.runStt(new Uint8Array(400).fill(1)));
  expect(service._websocket.sent).toEqual([]);

  await service.processFrame(new VADUserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM);

  expect(service._websocket.sent).toEqual([
    pyJsonDumps({ event: "audio_input", audio: bytesToBase64(new Uint8Array(400).fill(1)) }),
    pyJsonDumps({ event: "speech_end" }),
  ]);
  expect(service._audioBuffer.length).toBe(0);
});

test("test_partial_transcript_emits_interim_frame", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const pushed: any[] = [];
  service.pushFrame = _capture(pushed);

  await service._handleMessage({
    event: "transcript.partial",
    utterance_idx: 7,
    text: "हेलो",
    language: "hi",
  });
  await service._handleMessage({ event: "transcript.partial", text: "" });

  expect(pushed).toHaveLength(1);
  expect(pushed[0].constructor.name).toBe("InterimTranscriptionFrame");
  expect(pushed[0].text).toBe("हेलो");
  expect(pushed[0].language).toBe(Language.HI_IN);
  expect(pushed[0].result.utterance_idx).toBe(7);
  expect(pushed[0].result.language).toBe("hi");
});

test("test_speech_end_emits_eos_before_delayed_final", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const pushed: any[] = [];
  const broadcasted: unknown[] = [];
  service.pushFrame = _capture(pushed);
  service.broadcastFrame = _captureClass(broadcasted);
  service.startTtfbMetrics = _noop;
  service.stopTtfbMetrics = _noop;

  service._sampleRate = 16000;
  service._audioPositionBytes = _secondsToBytes(1.25);
  await service._handleMessage({ event: "vad.speech_start", utterance_idx: 3 });
  await service._handleMessage({ event: "vad.speech_end", utterance_idx: 3 });
  await service._handleMessage({ event: "transcript.final", utterance_idx: 3, text: "हेलो।" });

  expect(broadcasted).toEqual([ProposedUserStartedSpeakingFrame, ProposedUserStoppedSpeakingFrame]);
  expect(pushed).toHaveLength(1);
  expect(pushed[0]).toBeInstanceOf(TranscriptionFrame);
  expect(pushed[0].text).toBe("हेलो।");
  expect(pushed[0].result.speech_end_audio_position_s).toBe(1.25);
});

test("test_duplicate_speech_end_does_not_emit_duplicate_eos", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const broadcasted: unknown[] = [];
  service.broadcastFrame = _captureClass(broadcasted);
  service.startTtfbMetrics = _noop;

  await service._handleMessage({ event: "vad.speech_start", utterance_idx: 1 });
  await service._handleMessage({ event: "vad.speech_end", utterance_idx: 1 });
  await service._handleMessage({ event: "vad.speech_end", utterance_idx: 1 });

  expect(broadcasted).toEqual([ProposedUserStartedSpeakingFrame, ProposedUserStoppedSpeakingFrame]);
});

test("test_post_eos_partial_is_interim_without_changing_eos_timing", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const pushed: any[] = [];
  const broadcasted: unknown[] = [];
  service.pushFrame = _capture(pushed);
  service.broadcastFrame = _captureClass(broadcasted);
  service.startTtfbMetrics = _noop;
  service.stopTtfbMetrics = _noop;

  service._sampleRate = 16000;
  service._audioPositionBytes = _secondsToBytes(2.0);
  await service._handleMessage({ event: "vad.speech_start", utterance_idx: 2 });
  await service._handleMessage({ event: "vad.speech_end", utterance_idx: 2 });
  await service._handleMessage({ event: "transcript.partial", utterance_idx: 2, text: "हेल" });
  await service._handleMessage({ event: "transcript.final", utterance_idx: 2, text: "हेलो।" });

  expect(broadcasted).toEqual([ProposedUserStartedSpeakingFrame, ProposedUserStoppedSpeakingFrame]);
  expect(pushed.map((frame) => frame.constructor.name)).toEqual([
    "InterimTranscriptionFrame",
    "TranscriptionFrame",
  ]);
  expect(pushed.at(-1).result.speech_end_audio_position_s).toBe(2.0);
});

test("test_config_updated_and_pong_are_noops", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const pushed: any[] = [];
  service.pushFrame = _capture(pushed);

  await service._handleMessage({ event: "config.updated", applied: ["language_code"] });
  await service._handleMessage({ event: "pong" });

  expect(pushed).toEqual([]);
});

test("test_nonfatal_error_emits_raw_payload", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const pushedErrors: [string, Dict | undefined][] = [];
  service.pushError = async (errorMsg: string, options?: Dict) => {
    pushedErrors.push([errorMsg, options]);
  };

  await service._handleMessage({
    event: "error",
    code: "transient_warning",
    message: "retrying",
    is_fatal: false,
  });

  expect(pushedErrors[0]?.[0]).toBe(
    'Sarvam realtime STT error: {"event": "error", "code": "transient_warning", ' +
      '"message": "retrying", "is_fatal": false}',
  );
  expect(pushedErrors[0]?.[1]?.exception).toBeUndefined();
  expect(pushedErrors[0]?.[1]?.forceTreatAsPermanent ?? false).toBe(false);
});

test("test_sarvam_error_reaches_rtvi_client", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const rtvi: any = new RTVIProcessor();
  const clientMessages: unknown[] = [];

  rtvi.pushTransportMessage = async (message: unknown) => {
    clientMessages.push(message);
  };
  service.pushError = async (errorMsg: string, options?: Dict) => {
    await rtvi._sendErrorFrame(
      new ErrorFrame({ error: errorMsg, exception: options?.exception, processor: service }),
    );
  };
  const payload = {
    event: "error",
    code: "transient_warning",
    message: "retrying",
    is_fatal: false,
    diagnostic: { attempt: 2 },
  };

  await service._handleMessage(payload);

  expect(clientMessages).toEqual([
    new RTVI.Error({
      data: new RTVI.ErrorData({
        error:
          'Sarvam realtime STT error: {"event": "error", ' +
          '"code": "transient_warning", "message": "retrying", ' +
          '"is_fatal": false, "diagnostic": {"attempt": 2}}',
        fatal: false,
      }),
    }),
  ]);
});

test("test_session_begin_logs_request_id_at_info", async () => {
  const { logger } = await import("@pipedog/core/utils/logger");
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const info = spyOn(logger, "info").mockImplementation(() => {});
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  try {
    await service._handleMessage({ event: "session.begin", request_id: "request-123" });

    expect(info.mock.calls.map((call) => call[0])).toEqual([
      `${service} Sarvam realtime session.begin request_id=request-123`,
    ]);
    expect(debug.mock.calls).toEqual([]);
  } finally {
    info.mockRestore();
    debug.mockRestore();
  }
});

test("test_config_update_sends_without_reconnect", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  service._websocket = new _FakeWebsocket();

  await service.updateConfig({
    language_code: "auto",
    mode: "translate",
    prompt: "prefer glossary",
  });

  expect(service._websocket.sent).toEqual([
    pyJsonDumps({
      event: "config.update",
      language_code: "auto",
      mode: "translate",
      prompt: "prefer glossary",
    }),
  ]);
});

test("test_update_config_rejects_a_field_sarvam_has_no_setting_for", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  service._websocket = new _FakeWebsocket();

  await expect(service.updateConfig({ langauge_code: "hi-IN" })).rejects.toThrow("langauge_code");

  expect(service._websocket.sent).toEqual([]);
});

describe("test_connection_only_fields_rejected_by_update_config", () => {
  // Connection-time values are constructor arguments, so `Settings` has none.
  //
  // That leaves nothing for a `config.update` to carry them in, which is what
  // keeps them from reaching a stream that cannot apply them.
  test.each([
    ["sample_rate", "sampleRate", 8000],
    ["return_timestamps", "returnTimestamps", true],
    ["prefix_padding_ms", "prefixPaddingMs", 200],
    ["endpointing", "endpointing", "manual"],
  ])("%s", async (field, settingsName, value) => {
    expect(Object.keys(new SarvamRealtimeSTTSettings())).not.toContain(settingsName);

    const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
    service._websocket = new _FakeWebsocket();

    await expect(service.updateConfig({ [field]: value })).rejects.toThrow(field);

    expect(service._websocket.sent).toEqual([]);
  });
});

test("test_update_config_keeps_the_settings_store_in_step", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  service._websocket = new _FakeWebsocket();

  await service.updateConfig({ mode: "translate" });
  expect(service._settings.mode).toBe("translate");

  // Without the write-back this diffs against a stale "transcribe" and sends
  // nothing, stranding the server in translate mode.
  service._websocket.sent.length = 0;
  await service._updateSettings(new SarvamRealtimeSTTService.Settings({ mode: "transcribe" }));

  expect(service._websocket.sent).toEqual([
    pyJsonDumps({ event: "config.update", mode: "transcribe" }),
  ]);
  expect(service._settings.mode).toBe("transcribe");
});

test("test_stream_type_change_is_left_to_the_server", async () => {
  const service: any = new SarvamRealtimeSTTService({
    apiKey: "test-key",
    settings: new SarvamRealtimeSTTService.Settings({ streamType: "simulated" }),
  });
  service._websocket = new _FakeWebsocket();

  await service._updateSettings(new SarvamRealtimeSTTService.Settings({ streamType: "fast" }));

  expect(service._websocket.sent).toEqual([
    pyJsonDumps({ event: "config.update", stream_type: "fast" }),
  ]);
  expect(service._settings.streamType).toBe("fast");
});

test("test_language_delta_is_sent_as_language_code", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  service._websocket = new _FakeWebsocket();

  await service._updateSettings(
    new SarvamRealtimeSTTService.Settings({ language: Language.HI_IN }),
  );

  expect(service._websocket.sent).toEqual([
    pyJsonDumps({ event: "config.update", language_code: "hi-IN" }),
  ]);
  expect(service._settings.language).toBe("hi-IN");
});

test("test_base_settings_delta_still_derives_a_language_code", async () => {
  // `STTUpdateSettingsFrame({ delta: new STTSettings(...) })` carries no Sarvam fields.
  //
  // Widening the delta is what lets a caller who never imports the Sarvam
  // settings change the language and have it reach the server.
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  service._websocket = new _FakeWebsocket();

  await service._updateSettings(new STTSettings({ language: Language.HI_IN }));

  expect(service._websocket.sent).toEqual([
    pyJsonDumps({ event: "config.update", language_code: "hi-IN" }),
  ]);
  expect(service._settings.language).toBe("hi-IN");
});

test("test_sample_rate_defaults_to_the_pipeline_rate", () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });

  expect(service._initSampleRate).toBeNull();
  expect(_query(service, { sampleRate: 8000 }).sample_rate).toEqual(["8000"]);
});

test("test_explicit_sample_rate_pins_the_rate", () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key", sampleRate: 8000 });

  expect(service._initSampleRate).toBe(8000);
});

test("test_unsupported_resolved_sample_rate_reports_and_skips_connect", async () => {
  // An unusable pipeline rate has to surface as an error frame.
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const pushedErrors: [string, ErrorCategory | null | undefined][] = [];
  const connects: boolean[] = [];

  service.pushError = async (errorMsg: string, options?: Dict) => {
    pushedErrors.push([errorMsg, options?.category]);
  };
  service._connect = async () => {
    connects.push(true);
  };
  const setupSpy = spyOn(WebsocketSTTService.prototype as any, "setup").mockImplementation(
    async () => {},
  );
  try {
    service._sampleRate = 44100;

    await service.setup(frameProcessorSetup(new TaskManager()));
  } finally {
    setupSpy.mockRestore();
  }

  expect(pushedErrors).toHaveLength(1);
  expect(pushedErrors[0]?.[0]).toContain("sample_rate");
  // Permanent, since the rate holds for the session: the service loses its
  // usability so the switcher stops handing it audio.
  expect(pushedErrors[0]?.[1]).toBe(ErrorCategory.INVALID_REQUEST);
  expect(pushedErrors[0]?.[1]?.isPermanent).toBe(true);
  expect(connects).toEqual([]);
});

test("test_unsupported_resolved_sample_rate_costs_the_service_its_usability", async () => {
  // The verdict has to reach `isUsable`, which is what a switcher reads.
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });

  service._connect = async () => {};
  service.pushFrame = _noop;
  const setupSpy = spyOn(WebsocketSTTService.prototype as any, "setup").mockImplementation(
    async () => {},
  );
  try {
    service._sampleRate = 44100;

    await service.setup(frameProcessorSetup(new TaskManager()));
  } finally {
    setupSpy.mockRestore();
  }

  expect(service.isUsable).toBe(false);
});

test("test_keepalive_uses_the_ping_event", async () => {
  // Sarvam's socket only accepts JSON events.
  //
  // The inherited keepalive writes raw PCM, which this endpoint rejects.
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  service._websocket = new _FakeWebsocket();

  await service._sendKeepalive(new Uint8Array(640));

  expect(service._websocket.sent).toEqual([pyJsonDumps({ event: "ping" })]);
});

describe("test_final_transcript_reports_usage", () => {
  // Usage is a per-utterance billing event.
  //
  // Leaving it to the teardown flush reports one lump sum, and a cancelled
  // session reports nothing at all.
  test.each(["hello", "   "])("final text %p", async (finalText) => {
    const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
    service._setup = frameProcessorSetup(new TaskManager(), { enableUsageMetrics: true });
    service._sttUsagePendingSeconds = 2.5;
    const pushed: any[] = [];
    service.pushFrame = _capture(pushed);

    await service._handleMessage({ event: "transcript.final", text: finalText });

    const usage = pushed
      .filter((frame) => frame instanceof MetricsFrame)
      .flatMap((frame: MetricsFrame) => frame.data)
      .filter((data) => data instanceof STTUsageMetricsData);
    expect(usage.map((data: any) => data.value.audioSeconds)).toEqual([2.5]);
    expect(service._sttUsagePendingSeconds).toBe(0.0);
  });
});

test("test_provider_vad_events_are_ignored_under_manual_endpointing", async () => {
  // The pipeline owns turn boundaries in manual mode.
  //
  // Acting on server VAD telemetry too would give the aggregator two competing
  // sets of boundaries for the same utterance.
  const service: any = new SarvamRealtimeSTTService({
    apiKey: "test-key",
    endpointing: "manual",
  });
  const broadcasted: unknown[] = [];
  service.pushFrame = _noop;
  service.broadcastFrame = _captureClass(broadcasted);
  service.startTtfbMetrics = _noop;

  await service._handleMessage({ event: "vad.speech_start" });
  await service._handleMessage({ event: "vad.speech_end" });

  expect(broadcasted).toEqual([]);
});

test("test_vad_params_are_omitted_for_manual_endpointing", () => {
  const service = new SarvamRealtimeSTTService({
    apiKey: "test-key",
    endpointing: "manual",
    prefixPaddingMs: 200,
    settings: new SarvamRealtimeSTTService.Settings({
      threshold: 0.4,
      silenceDurationMs: 700,
      minSpeechDurationMs: 120,
    }),
  });

  const query = _query(service);

  for (const param of [
    "threshold",
    "silence_duration_ms",
    "min_speech_duration_ms",
    "prefix_padding_ms",
  ]) {
    expect(param in query).toBe(false);
  }
});

describe("test_speech_cycle_emits_no_processing_metrics", () => {
  // A processing window anchored to the speech boundary measures nothing useful.
  //
  // It would time how long the user talked, and the interruption raised on
  // speech start closes it immediately anyway.
  test.each(["hello", "   "])("final text %p", async (finalText) => {
    const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
    service._enableMetrics = true;
    const pushed: any[] = [];
    service.pushFrame = _capture(pushed);
    service.broadcastFrame = _noop;

    await service._handleMessage({ event: "vad.speech_start" });
    await service._handleMessage({ event: "vad.speech_end" });
    await service._handleMessage({ event: "transcript.final", text: finalText });

    expect(pushed.filter((frame) => frame instanceof MetricsFrame)).toEqual([]);
  });
});

test("test_ttfb_is_anchored_to_the_vad_stop_frame", async () => {
  // TTFB has to run from the real end of speech, like every other STT service.
  //
  // Sarvam's own `vad.speech_end` only arrives once the server's silence window
  // has elapsed, so timing from it would report a shorter interval than the
  // rest of the services do. The VAD frame carries the stop delay needed to
  // place the actual boundary.
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const ttfbStarts: unknown[] = [];
  service.pushFrame = _noop;
  service.broadcastFrame = _noop;
  // The base class arms a timeout task; this service has no task manager.
  service.createTask = () => null;
  service.startTtfbMetrics = async (options: { startTime?: number } = {}) => {
    ttfbStarts.push(options.startTime);
  };

  // The provider boundary alone must not start the measurement.
  await service._handleMessage({ event: "vad.speech_start" });
  await service._handleMessage({ event: "vad.speech_end" });
  expect(ttfbStarts).toEqual([]);

  const frame = new VADUserStoppedSpeakingFrame({ stopSecs: 0.2, timestamp: 1000.0 });
  await service.processFrame(frame, FrameDirection.DOWNSTREAM);

  expect(ttfbStarts).toEqual([1000.0 - 0.2]);
});

test("test_session_end_mid_utterance_completes_the_turn", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const broadcasted: unknown[] = [];
  service.pushFrame = _noop;
  service.broadcastFrame = _captureClass(broadcasted);
  service.startTtfbMetrics = _noop;

  await service._handleMessage({ event: "vad.speech_start" });
  await service._handleMessage({ event: "session.end", audio_duration_s: 1.0 });

  expect(broadcasted).toEqual([ProposedUserStartedSpeakingFrame, ProposedUserStoppedSpeakingFrame]);
});

test("test_socket_drop_mid_utterance_completes_the_turn", async () => {
  // A dropped socket must still close the turn.
  //
  // With reconnection off, the boundary can never arrive on its own and
  // external turn aggregation would wait on it forever.
  const service: any = new SarvamRealtimeSTTService({
    apiKey: "test-key",
    reconnectOnError: false,
  });
  const broadcasted: unknown[] = [];
  service.pushFrame = _noop;
  service.broadcastFrame = _captureClass(broadcasted);
  service.startTtfbMetrics = _noop;
  service.pushError = _noop;
  // The socket dies after speech starts, with no matching `vad.speech_end`.
  service._websocket = new _FakeWebsocket([
    _SESSION_BEGIN,
    JSON.stringify({ event: "vad.speech_start" }),
  ]);

  await service._receiveTaskHandler(async () => {});

  expect(broadcasted).toEqual([ProposedUserStartedSpeakingFrame, ProposedUserStoppedSpeakingFrame]);
});

test("test_disconnect_tolerates_socket_closing_during_flush", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  service._sampleRate = 16000;

  class _ClosingWebsocket extends _FakeWebsocket {
    override async send(_message: string): Promise<void> {
      throw new Error("socket went away");
    }
  }

  service._websocket = new _ClosingWebsocket();
  service._audioBuffer = new Uint8Array(400).fill(1);
  service.pushError = _noop;

  await service._disconnect();

  expect(service._websocket).toBeNull();
});

test("test_confidence_defaults_to_one_when_not_numeric", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const pushed: any[] = [];
  service.pushFrame = _capture(pushed);

  await service._handleMessage({ event: "transcript.partial", text: "hi" });
  await service._handleMessage({ event: "transcript.final", text: "hi", confidence: 0.42 });

  expect(pushed[0].result.confidence).toBe(1.0);
  expect(pushed[1].result.confidence).toBe(0.42);
});

describe("test_deprecated_language_code_sets_language", () => {
  // DIVERGENCE: `Settings.language_code` is deprecated upstream (1.13.0) and
  // not ported; `language` (with `null` for `auto`) replaces it.
  test.skip.each([
    ["hi-IN", "hi-IN"],
    ["auto", null],
  ])("%s", () => {});
});

test.skip("test_deprecated_language_code_delta_is_sent_as_language", () => {
  // DIVERGENCE: `Settings.language_code` is deprecated upstream and not ported.
});

test("test_service_metadata_recommends_external_turn_strategies_in_vad_mode", () => {
  const service = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const frame = service.serviceMetadataFrame();
  expect(frame.userTurnStrategies).toBeInstanceOf(ExternalUserTurnStrategies);
});

describe("test_should_interrupt_reaches_the_turn_strategies", () => {
  // The strategies own the interruption, so the setting has to travel to them.
  //
  // Keeping it in the service would leave a pipeline that pins its own
  // `ExternalUserTurnStrategies` interrupting regardless.
  test.each([true, false])("%p", (shouldInterrupt) => {
    const service = new SarvamRealtimeSTTService({ apiKey: "test-key", shouldInterrupt });
    const strategies = service.serviceMetadataFrame().userTurnStrategies as any;
    expect(strategies.enableInterruptions).toBe(shouldInterrupt);
  });
});

test("test_service_metadata_leaves_turn_strategies_unset_in_manual_mode", () => {
  const service = new SarvamRealtimeSTTService({ apiKey: "test-key", endpointing: "manual" });
  const frame = service.serviceMetadataFrame();
  expect(frame.userTurnStrategies).toBeNull();
});

describe("test_reconnect_on_error_defaults_on_and_can_be_turned_off", () => {
  test.each([
    [{}, true],
    [{ reconnectOnError: false }, false],
  ])("%p", (options, expected) => {
    const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key", ...options });
    expect(service._reconnectOnError).toBe(expected);
  });
});

describe("test_receive_errors_are_reported_without_reconnect", () => {
  test.each([
    ["ConnectionClosedError", () => new ConnectionClosedError(1006, "Abnormal closure")],
    ["RuntimeError", () => new Error("unexpected receive failure")],
  ])("%s", async (_name, makeError) => {
    const service: any = new SarvamRealtimeSTTService({
      apiKey: "test-key",
      reconnectOnError: false,
    });
    let reportCalls = 0;
    const reportError = async () => {
      reportCalls += 1;
    };
    let reconnects = 0;
    service._receiveMessages = async () => {
      throw makeError();
    };
    service._tryReconnect = async () => {
      reconnects += 1;
      return false;
    };

    await service._receiveTaskHandler(reportError);

    expect(reconnects).toBe(0);
    expect(reportCalls).toBe(1);
    // With reconnection off, a dropped socket ends transcription for the
    // session and a switcher has to stop handing this service audio.
    expect(service.isUsable).toBe(false);
  });
});

test("test_intentional_disconnect_leaves_the_service_usable", async () => {
  // Teardown ends the same loop, and must not be read as a failure.
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  service._receiveMessages = async () => {
    throw new ConnectionClosedError(1006, "Abnormal closure");
  };
  service._disconnecting = true;

  await service._receiveTaskHandler(async () => {});

  expect(service.isUsable).toBe(true);
});

test("test_sarvam_error_is_reported_without_reconnect", async () => {
  const service: any = new SarvamRealtimeSTTService({
    apiKey: "test-key",
    reconnectOnError: false,
  });
  let reportCalls = 0;
  const reportError = async () => {
    reportCalls += 1;
  };
  let reconnects = 0;
  const pushedErrors: [string, Dict | undefined][] = [];

  service._websocket = new _FakeWebsocket([
    _SESSION_BEGIN,
    JSON.stringify({
      event: "error",
      code: "invalid_subscription_key",
      message: "Invalid subscription key",
      is_fatal: true,
    }),
  ]);
  service._tryReconnect = async () => {
    reconnects += 1;
    return false;
  };
  service.pushError = async (errorMsg: string, options?: Dict) => {
    pushedErrors.push([errorMsg, options]);
  };

  await service._receiveTaskHandler(reportError);

  expect(pushedErrors[0]?.[1]?.forceTreatAsPermanent ?? false).toBe(false);
  expect(reconnects).toBe(0);
  expect(reportCalls).toBe(1);
});

/**
 * Stream 1 s of audio to a local stand-in for the realtime endpoint.
 *
 * Each connection answers 500 ms of audio with one final transcript. The
 * first connection is then closed with `closeFirst` (a close code and reason).
 */
async function _runAgainstLocalSarvam(options: { closeFirst: [number, string] }): Promise<{
  service: any;
  handshakes: number;
  transcripts: string[];
}> {
  let handshakes = 0;

  const server = Bun.serve<{ connection: number; chunks: number }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      handshakes += 1;
      if (srv.upgrade(request, { data: { connection: handshakes, chunks: 0 } })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send(_SESSION_BEGIN);
      },
      message(ws, raw) {
        if (JSON.parse(String(raw)).event !== "audio_input") return;
        ws.data.chunks += 1;
        if (ws.data.chunks === 10) {
          const text = `hello from connection ${ws.data.connection}`;
          ws.send(JSON.stringify({ event: "transcript.final", text }));
          if (ws.data.connection === 1) {
            ws.close(options.closeFirst[0], options.closeFirst[1]);
          }
        }
      },
    },
  });

  let service: any;
  let down: Frame[];
  try {
    service = new SarvamRealtimeSTTService({
      apiKey: "test-key",
      baseUrl: `ws://127.0.0.1:${server.port}/ws`,
      sampleRate: 8000,
      // DIVERGENCE: a short backoff floor, so a failed first attempt does not
      // hold the test for the default four seconds.
      reconnectBackoffMinWait: 0.05,
      reconnectBackoffMaxWait: 0.1,
    });
    const frames: Frame[] = [];
    for (let i = 0; i < 50; i++) {
      frames.push(
        new InputAudioRawFrame({ audio: new Uint8Array(320), sampleRate: 8000, numChannels: 1 }),
        new SleepFrame({ sleep: 0.02 }),
      );
    }
    [down] = await runTest(service, {
      framesToSend: frames,
      pipelineParams: new PipelineParams({ audioInSampleRate: 8000 }),
    });
  } finally {
    server.stop(true);
  }

  const transcripts = down
    .filter((frame): frame is TranscriptionFrame => frame instanceof TranscriptionFrame)
    .map((frame) => frame.text);
  return { service, handshakes, transcripts };
}

test("test_dropped_connection_is_reopened", async () => {
  // Sarvam documents 1011 as an internal error to retry with backoff.
  const { service, handshakes, transcripts } = await _runAgainstLocalSarvam({
    closeFirst: [1011, "internal server error"],
  });

  expect(handshakes).toBe(2);
  expect(transcripts).toEqual(["hello from connection 1", "hello from connection 2"]);
  expect(service.isUsable).toBe(true);
});

/** A local stand-in for the realtime endpoint, counting audio per connection. */
class _FakeSarvamRealtime {
  // Open an utterance on the first connection just before dropping it.
  dropMidUtterance = false;
  // Send the utterance's final before dropping, so nothing is left pending.
  finalBeforeDrop = false;
  // Continue speaking on the second connection: a new utterance.
  resumeUtterance = false;
  dropFirstAfter: number | null = null;
  // Reject every handshake after this many.
  rejectAfter: number | null = null;
  // Open an utterance on the first connection after this many audio chunks;
  // it is never finalized.
  openUtteranceAfter: number | null = null;
  // How many connections, from the first, never get session.begin; null for all.
  unconfirmed: number | null = 0;
  // Close every connection as Sarvam does for a rejected parameter.
  rejectSettings = false;
  handshakes = 0;
  audioPerConnection: number[] = [];

  constructor(
    options: Partial<
      Pick<
        _FakeSarvamRealtime,
        | "dropMidUtterance"
        | "finalBeforeDrop"
        | "resumeUtterance"
        | "dropFirstAfter"
        | "rejectAfter"
        | "openUtteranceAfter"
        | "unconfirmed"
        | "rejectSettings"
      >
    > = {},
  ) {
    Object.assign(this, options);
  }

  processRequest(): Response | null {
    this.handshakes += 1;
    if (this.rejectAfter !== null && this.handshakes > this.rejectAfter) {
      return new Response("unavailable\n", { status: 503 });
    }
    return null;
  }

  open(websocket: ServerWebSocket<_FakeConnection>): void {
    websocket.data.index = this.audioPerConnection.length;
    this.audioPerConnection.push(0);
    if (this.rejectSettings) {
      websocket.data.done = true;
      websocket.close(4000, "Invalid model");
      return;
    }
    if (this.unconfirmed !== null && websocket.data.index >= this.unconfirmed) {
      websocket.send(_SESSION_BEGIN);
    }
  }

  async message(websocket: ServerWebSocket<_FakeConnection>, raw: string | Buffer): Promise<void> {
    const data = websocket.data;
    if (data.done || JSON.parse(String(raw)).event !== "audio_input") {
      return;
    }
    const index = data.index;
    this.audioPerConnection[index]! += 1;
    const count = this.audioPerConnection[index];
    if (index === 0 && count === this.openUtteranceAfter) {
      _FakeSarvamRealtime._send(websocket, "vad.speech_start");
      _FakeSarvamRealtime._send(websocket, "transcript.partial", "hello there");
    }
    if (index === 1 && this.resumeUtterance && count === 3) {
      _FakeSarvamRealtime._send(websocket, "vad.speech_start");
      _FakeSarvamRealtime._send(websocket, "vad.speech_end");
      _FakeSarvamRealtime._send(websocket, "transcript.final", "how are you");
    }
    if (index === 0 && count === this.dropFirstAfter) {
      data.done = true;
      if (this.dropMidUtterance) {
        _FakeSarvamRealtime._send(websocket, "vad.speech_start");
        _FakeSarvamRealtime._send(websocket, "transcript.partial", "hello");
        _FakeSarvamRealtime._send(websocket, "transcript.partial", "hello there");
        if (this.finalBeforeDrop) {
          _FakeSarvamRealtime._send(websocket, "vad.speech_end");
          _FakeSarvamRealtime._send(websocket, "transcript.final", "hello there");
        }
        await sleep(0.05);
      }
      websocket.terminate();
    }
  }

  static _send(
    websocket: ServerWebSocket<_FakeConnection>,
    event: string,
    text: string | null = null,
  ): void {
    const message: Dict = { event };
    if (text !== null) {
      message.text = text;
    }
    websocket.send(JSON.stringify(message));
  }
}

type _FakeConnection = { index: number; done: boolean };

async function _runFakeSarvam(
  server: _FakeSarvamRealtime,
  seconds: number,
  configure?: (service: any) => void,
): Promise<[any, Frame[], Frame[]]> {
  const s = Bun.serve<_FakeConnection>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      const rejected = server.processRequest();
      if (rejected) return rejected;
      if (srv.upgrade(request, { data: { index: -1, done: false } })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open: (ws) => server.open(ws),
      message: (ws, raw) => server.message(ws, raw),
    },
  });
  let service: any;
  let down: Frame[];
  let up: Frame[];
  try {
    service = new SarvamRealtimeSTTService({
      apiKey: "test-key",
      baseUrl: `ws://127.0.0.1:${s.port}/ws`,
      sampleRate: 8000,
    });
    if (configure) {
      configure(service);
    }
    const frames: Frame[] = [];
    for (let i = 0; i < Math.trunc(seconds / 0.02); i++) {
      frames.push(
        new InputAudioRawFrame({ audio: new Uint8Array(320), sampleRate: 8000, numChannels: 1 }),
        new SleepFrame({ sleep: 0.02 }),
      );
    }
    [down, up] = await runTest(service, {
      framesToSend: frames,
      pipelineParams: new PipelineParams({ audioInSampleRate: 8000, enableUsageMetrics: true }),
    });
    // Give a connection still being served time to record what it received.
    await sleep(0.1);
  } finally {
    s.stop(true);
  }
  return [service, down, up];
}

function _transcripts(down: Frame[]): [string, boolean][] {
  return down
    .filter((f): f is TranscriptionFrame => f instanceof TranscriptionFrame)
    .map((f) => [f.text, f.finalized]);
}

test("test_an_utterance_cut_short_by_a_drop_ends_with_its_partial_transcript", async () => {
  const server = new _FakeSarvamRealtime({ dropFirstAfter: 10, dropMidUtterance: true });

  const [, down] = await _runFakeSarvam(server, 1.0);

  expect(_transcripts(down)).toEqual([["hello there", false]]);
  const stops = down.flatMap((f, i) => (f instanceof ProposedUserStoppedSpeakingFrame ? [i] : []));
  const transcript = down.findIndex((f) => f instanceof TranscriptionFrame);
  expect(stops.length).toBe(1);
  // The same order as a normal utterance: the boundary, then its transcript.
  expect(stops[0]!).toBeLessThan(transcript);
  // Usage is reported ahead of the transcript, for the STT span it closes.
  expect(
    down
      .slice(0, transcript)
      .some(
        (f) => f instanceof MetricsFrame && f.data.some((d) => d instanceof STTUsageMetricsData),
      ),
  ).toBe(true);
  expect(server.audioPerConnection.length).toBe(2);
});

test("test_a_finalized_utterance_is_not_repeated_after_a_drop", async () => {
  const server = new _FakeSarvamRealtime({
    dropFirstAfter: 10,
    dropMidUtterance: true,
    finalBeforeDrop: true,
  });

  const [, down] = await _runFakeSarvam(server, 1.0);

  expect(_transcripts(down)).toEqual([["hello there", true]]);
});

test("test_speech_continuing_after_a_drop_becomes_a_new_utterance", async () => {
  const server = new _FakeSarvamRealtime({
    dropFirstAfter: 10,
    dropMidUtterance: true,
    resumeUtterance: true,
  });

  const [, down] = await _runFakeSarvam(server, 1.0);

  expect(_transcripts(down)).toEqual([
    ["hello there", false],
    ["how are you", true],
  ]);
  expect(down.filter((f) => f instanceof ProposedUserStoppedSpeakingFrame).length).toBe(2);
});

test("test_an_utterance_ends_when_reconnecting_gives_up", async () => {
  const fastBackoff = (service: any) => {
    service._reconnectBackoffMinWait = 0.01;
    service._reconnectBackoffMaxWait = 0.01;
  };

  const server = new _FakeSarvamRealtime({
    dropFirstAfter: 10,
    dropMidUtterance: true,
    rejectAfter: 1,
  });

  const [service, down] = await _runFakeSarvam(server, 1.0, fastBackoff);

  expect(_transcripts(down)).toEqual([["hello there", false]]);
  expect(down.filter((f) => f instanceof ProposedUserStoppedSpeakingFrame).length).toBe(1);
  expect(service.isUsable).toBe(false);
});

test("test_stopping_mid_utterance_pushes_no_partial_transcript", async () => {
  const server = new _FakeSarvamRealtime({ openUtteranceAfter: 5 });

  const [, down] = await _runFakeSarvam(server, 0.4);

  expect(_transcripts(down)).toEqual([]);
});

test("test_an_unconfirmed_connection_is_retried", async () => {
  const previous = SarvamRealtimeSTTService._CONNECTION_TIMEOUT;
  SarvamRealtimeSTTService._CONNECTION_TIMEOUT = 0.1;
  try {
    const server = new _FakeSarvamRealtime({ unconfirmed: 1 });

    const [service] = await _runFakeSarvam(server, 0.5);

    expect(server.handshakes).toBe(2);
    expect(server.audioPerConnection[1]!).toBeGreaterThan(0);
    expect(service.isUsable).toBe(true);
  } finally {
    SarvamRealtimeSTTService._CONNECTION_TIMEOUT = previous;
  }
});

test("test_connections_that_never_confirm_are_given_up_after_three", async () => {
  const previous = SarvamRealtimeSTTService._CONNECTION_TIMEOUT;
  SarvamRealtimeSTTService._CONNECTION_TIMEOUT = 0.1;
  try {
    const server = new _FakeSarvamRealtime({ unconfirmed: null });

    const stableBeforeTimeout = (service: any) => {
      // As in production, the wait for session.begin outlasts the time after
      // which a connection counts as stable rather than a quick failure.
      service._quickFailureTracker.minStableDuration = 0.05;
    };

    const [service] = await _runFakeSarvam(server, 1.0, stableBeforeTimeout);

    expect(server.handshakes).toBe(3);
    expect(service.isUsable).toBe(false);
  } finally {
    SarvamRealtimeSTTService._CONNECTION_TIMEOUT = previous;
  }
});

test("test_rejected_settings_are_not_retried", async () => {
  const server = new _FakeSarvamRealtime({ rejectSettings: true });

  const [service, , up] = await _runFakeSarvam(server, 0.5);

  expect(server.handshakes).toBe(1);
  expect(service.isUsable).toBe(false);
  const errors = up.filter((f): f is ErrorFrame => f instanceof ErrorFrame);
  expect(errors[0]!.category).toBe(ErrorCategory.INVALID_REQUEST);
  expect(errors[0]!.error).toContain("Invalid model");
});

test("test_connected_fires_once_the_session_begins", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const events: [string, string | null][] = [];

  service._callEventHandler = async (name: string, ..._args: unknown[]) => {
    events.push([name, service._requestId]);
  };
  service._websocket = new _FakeWebsocket([_SESSION_BEGIN]);

  await service._receiveMessages();

  expect(events).toEqual([["on_connected", "test-request"]]);
});

test("test_a_connection_closed_before_the_session_begins_is_not_connected", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const events: string[] = [];

  service._callEventHandler = async (name: string, ..._args: unknown[]) => {
    events.push(name);
  };
  service._websocket = new _FakeWebsocket([]);

  await service._receiveMessages();

  expect(events).toEqual([]);
  expect(service._connectionEstablishedEvent.isSet()).toBe(false);
});

test("test_undecodable_messages_are_skipped", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const pushed: unknown[] = [];
  service.pushFrame = _capture(pushed);
  service._callEventHandler = _noop;
  const partial = JSON.stringify({ event: "transcript.partial", text: "hello" });
  service._websocket = new _FakeWebsocket([
    _SESSION_BEGIN,
    new Uint8Array([0x00, 0x01]),
    "not json",
    partial,
  ]);

  await service._receiveMessages();

  expect(
    pushed
      .filter((f): f is InterimTranscriptionFrame => f instanceof InterimTranscriptionFrame)
      .map((f) => f.text),
  ).toEqual(["hello"]);
});

test("test_reconnect_restarts_the_audio_position", async () => {
  // A new session's speech-end position counts from its own start.
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  service.pushFrame = _noop;
  service.broadcastFrame = _noop;
  const spy = spyOn(WebsocketSTTService.prototype as any, "_reconnectWebsocket").mockImplementation(
    async () => true,
  );
  try {
    service._sampleRate = 16000;
    service._audioPositionBytes = _secondsToBytes(3.0);

    await service._reconnectWebsocket(1);
    service._audioPositionBytes += _secondsToBytes(0.5);
    await service._handleMessage({ event: "vad.speech_start" });
    await service._handleMessage({ event: "vad.speech_end" });
  } finally {
    spy.mockRestore();
  }

  expect(service._speechEndAudioPositionS).toBe(0.5);
});

describe("test_reconnect_reopens_an_open_manual_turn", () => {
  // Sarvam ignores a `speech_end` whose `speech_start` went to the old session.
  test.each([
    [[VADUserStartedSpeakingFrame], true],
    [[VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame], false],
  ] as const)("%#", async (boundaries, resent) => {
    const service: any = new SarvamRealtimeSTTService({
      apiKey: "test-key",
      endpointing: "manual",
    });
    service.pushFrame = _noop;
    service._websocket = new _FakeWebsocket();
    for (const Boundary of boundaries) {
      await service.processFrame(new Boundary(), FrameDirection.DOWNSTREAM);
    }

    const newWebsocket = new _FakeWebsocket();
    const spy = spyOn(
      WebsocketSTTService.prototype as any,
      "_reconnectWebsocket",
    ).mockImplementation(async () => {
      service._websocket = newWebsocket;
      return true;
    });
    try {
      await service._reconnectWebsocket(1);
    } finally {
      spy.mockRestore();
    }

    const expected = resent ? [pyJsonDumps({ event: "speech_start" })] : [];
    expect(newWebsocket.sent).toEqual(expected);
  });
});

test("test_error_preserves_raw_payload", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  const pushedErrors: [string, Dict | undefined][] = [];

  service.pushError = async (errorMsg: string, options?: Dict) => {
    pushedErrors.push([errorMsg, options]);
  };

  const payload = {
    event: "error",
    code: "invalid_subscription_key",
    message: "Invalid subscription key",
    is_fatal: true,
    status_code: 1003,
  };
  await service._handleMessage(payload);

  expect(pushedErrors.length).toBeGreaterThan(0);
  expect(pushedErrors[0]?.[0]).toContain("invalid_subscription_key");
  expect(pushedErrors[0]?.[1]?.exception).toBeUndefined();
  expect(pushedErrors[0]?.[1]?.forceTreatAsPermanent ?? false).toBe(false);
});

test("test_realtime_keyterms_are_json_encoded_and_copied", () => {
  const terms = [
    "New Delhi",
    "नाम",
    'quote" & plus+',
    "x".repeat(64),
    ...Array.from({ length: 46 }, (_, i) => `term${i}`),
  ];
  const service = new SarvamRealtimeSTTService({
    apiKey: "test-key",
    settings: new SarvamRealtimeSTTService.Settings({ model: "saaras:v4" }),
    keyterms: terms,
  });
  const expected = [...terms];
  terms.push("not part of the connection");
  const query = _query(service);
  expect(JSON.parse(query.keyterms?.[0] as string)).toEqual(expected);
  expect(query.model).toEqual(["saaras:v4"]);
  expect(query.language_code).toEqual(["en-IN"]);
  expect("keyterms" in _query(new SarvamRealtimeSTTService({ apiKey: "test-key" }))).toBe(false);
});

describe("test_legacy_sdk_carries_keyterms_on_every_connection", () => {
  test.each([[null], [[]], [["New Delhi", "नाम", 'quote" & plus+']]] as (string[] | null)[][])(
    "keyterms %p",
    async (keyterms) => {
      const queries: Record<string, string[]>[] = [];
      const headers: (string | null)[] = [];

      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request, srv) {
          queries.push(_parseQuery(request.url));
          headers.push(request.headers.get("User-Agent"));
          if (srv.upgrade(request)) return undefined;
          return new Response("upgrade failed", { status: 400 });
        },
        websocket: { message() {} },
      });
      try {
        const service: any = new SarvamSTTService({
          apiKey: "test-key",
          sampleRate: 16000,
          keyterms,
          baseUrl: `ws://127.0.0.1:${server.port}/speech-to-text/ws`,
        });
        const expected = keyterms !== null ? [...keyterms] : null;
        if (keyterms !== null) {
          keyterms.push("not part of the connection");
        }
        await service.setup(frameProcessorSetup(new TaskManager()));
        try {
          expect(service._socketClient).not.toBeNull();
          await service._disconnect();
          await service._connect();
          expect(service._socketClient).not.toBeNull();
          await service._disconnect();
        } finally {
          await service.cleanup();
        }
        expect(queries).toHaveLength(2);
        for (const query of queries) {
          if (expected === null) {
            expect("keyterms" in query).toBe(false);
          } else {
            expect(JSON.parse(query.keyterms?.[0] as string)).toEqual(expected);
          }
          expect(query.model).toEqual(["saaras:v4"]);
          expect(query.sample_rate).toEqual(["16000"]);
        }
        expect(headers.every((h) => h === sdkHeaders()["User-Agent"])).toBe(true);
      } finally {
        server.stop(true);
      }
    },
  );
});

test("test_realtime_websocket_receives_keyterms", async () => {
  const queries: Record<string, string[]>[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      queries.push(_parseQuery(request.url));
      if (srv.upgrade(request)) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: { message() {} },
  });
  try {
    const service: any = new SarvamRealtimeSTTService({
      apiKey: "test-key",
      baseUrl: `ws://127.0.0.1:${server.port}`,
      settings: new SarvamRealtimeSTTService.Settings({ model: "saaras:v4" }),
      keyterms: ["New Delhi", "नाम"],
    });
    await service._connectWebsocket();
    await service._disconnectWebsocket();
  } finally {
    server.stop(true);
  }
  expect(JSON.parse(queries[0]?.keyterms?.[0] as string)).toEqual(["New Delhi", "नाम"]);
});

test("test_keyterms_cannot_be_updated_mid_stream", async () => {
  const service: any = new SarvamRealtimeSTTService({ apiKey: "test-key" });
  await expect(service.updateConfig({ keyterms: ["Sarvam"] })).rejects.toThrow("keyterms");
});
