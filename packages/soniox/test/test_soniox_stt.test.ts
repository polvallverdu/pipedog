// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_soniox_stt.py

/**
 * Tests for the Soniox STT service.
 *
 * Porting notes:
 * - `monkeypatch.setattr(service, "push_frame", fake)` becomes assigning the
 *   instance property; patching `websocket_connect` becomes replacing the
 *   service's `_websocketConnect`.
 * - `frame_processor_setup` (tests/frame_processor_helpers.py) is ported
 *   locally.
 * - `_FakeWebsocket` keeps the same shape: a `send` mock, a `state`, a `close`
 *   and an async iterator over canned messages.
 */

import { describe, expect, mock, test } from "bun:test";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  CancelFrame,
  EndFrame,
  type Frame,
  InterimTranscriptionFrame,
  MetricsFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { STTUsageMetricsData } from "@pipedog/core/metrics/metrics";
import {
  FrameDirection,
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "@pipedog/core/processors/frame_processor";
import { STTSettings } from "@pipedog/core/services/settings";
import { State } from "@pipedog/core/services/websocket_service";
import { Language } from "@pipedog/core/transcriptions/language";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { type BaseTaskManager, TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import {
  _languageFromTokens,
  END_TOKEN,
  languageToSonioxLanguage,
  SonioxSTTService,
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

class FakeWebsocket {
  state: State;
  closed = false;
  send: ReturnType<typeof mock>;
  _messages: string[];

  constructor(
    messages: string[],
    options: { state?: State; sendSideEffect?: (m: unknown) => Promise<void> } = {},
  ) {
    this._messages = messages;
    this.state = options.state ?? State.OPEN;
    this.send = mock(options.sendSideEffect ?? (async (_m: unknown) => {}));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.state = State.CLOSED;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string, void, unknown> {
    for (const message of this._messages) {
      yield message;
    }
  }
}

const dumps = (o: unknown): string => JSON.stringify(o);

/** Make `service._websocketConnect` return `websocket`, recording the call. */
function patchConnect(service: SonioxSTTService, websocket: FakeWebsocket): Dict {
  const captured: Dict = {};
  (service as any)._websocketConnect = async (uri: string, options: Dict = {}) => {
    captured.uri = uri;
    Object.assign(captured, options);
    return websocket;
  };
  return captured;
}

test("test_connect_sends_api_key_on_the_handshake", async () => {
  const websocket = new FakeWebsocket([], { state: State.OPEN });
  const service = new SonioxSTTService({ apiKey: "test-key" });
  const captured = patchConnect(service, websocket);

  await service._connectWebsocket();

  expect(captured.additionalHeaders).toEqual({ Authorization: "Bearer test-key" });
  // The handshake is the only carrier; the config message no longer repeats the key.
  expect(JSON.parse(websocket.send.mock.calls[0]?.[0] as string)).not.toHaveProperty("api_key");
});

test("test_connect_failure_clears_stale_websocket_without_raising", async () => {
  const service = new SonioxSTTService({ apiKey: "test-key" });
  (service as any)._websocketConnect = async () => {
    throw new Error("connection failed");
  };
  (service as any).pushError = async () => {};
  service._websocket = new FakeWebsocket([], { state: State.CLOSED }) as any;

  await service._connectWebsocket();

  expect(service._websocket).toBeNull();
});

test("test_language_from_tokens_uses_single_recognized_language", () => {
  const tokens = [
    { text: "Hello", language: "en" },
    { text: " world", language: "en" },
  ];

  expect(_languageFromTokens(tokens)).toBe(Language.EN);
});

test("test_language_from_tokens_uses_most_common_language", () => {
  const tokens = [
    { text: "Ik", language: "nl" },
    { text: " zoek", language: "nl" },
    { text: " computer", language: "en" },
  ];

  expect(_languageFromTokens(tokens)).toBe(Language.NL);
});

test("test_language_from_tokens_skips_unknown_language", () => {
  const tokens = [
    { text: "Hello", language: "en" },
    { text: "!", language: "klingon" },
  ];

  expect(_languageFromTokens(tokens)).toBe(Language.EN);
});

test("test_language_from_tokens_skips_missing_language", () => {
  const tokens = [{ text: "Hello", language: "en" }, { text: " wereld" }];

  expect(_languageFromTokens(tokens)).toBe(Language.EN);
});

test("test_language_from_tokens_ignores_unknown_and_missing_languages", () => {
  const tokens = [{ text: "Hello", language: "klingon" }, { text: " world" }, { text: "!" }];

  expect(_languageFromTokens(tokens)).toBeNull();
});

test("test_language_from_tokens_uses_first_language_on_tie", () => {
  const tokens = [
    { text: "Hello", language: "en" },
    { text: " wereld", language: "nl" },
  ];

  expect(_languageFromTokens(tokens)).toBe(Language.EN);
});

test("test_receive_messages_sets_final_transcription_language", async () => {
  const service = new SonioxSTTService({ apiKey: "test-key" });
  const pushedFrames: Frame[] = [];
  const tracedTranscriptions: [string, boolean, Language | null][] = [];

  const messages = [
    dumps({
      tokens: [
        { text: "Ik", is_final: true, language: "nl" },
        { text: " zoek", is_final: true, language: "nl" },
        { text: " computer", is_final: true, language: "en" },
        { text: END_TOKEN, is_final: true },
      ],
    }),
    dumps({ tokens: [], finished: true }),
  ];

  service._websocket = new FakeWebsocket(messages) as any;
  (service as any).pushFrame = async (frame: Frame) => {
    pushedFrames.push(frame);
  };
  (service as any)._handleTranscription = async (
    transcript: string,
    isFinal: boolean,
    language: Language | null = null,
  ) => {
    tracedTranscriptions.push([transcript, isFinal, language]);
  };

  await service._receiveMessages();

  const finalFrames = pushedFrames.filter((f) => f instanceof TranscriptionFrame);
  expect(finalFrames).toHaveLength(1);
  const frame = finalFrames[0] as TranscriptionFrame;
  expect(frame.text).toBe("Ik zoek computer");
  expect(frame.language).toBe(Language.NL);
  expect(frame.finalized).toBe(true);
  expect(frame.result).toEqual([
    { text: "Ik", is_final: true, language: "nl" },
    { text: " zoek", is_final: true, language: "nl" },
    { text: " computer", is_final: true, language: "en" },
  ]);
  expect(tracedTranscriptions).toEqual([["Ik zoek computer", true, Language.NL]]);
});

type Event = [string, unknown];

/** Create a service that records pushes, broadcasts, and interruptions in order. */
function instrumentedService(events: Event[], options: Dict = {}): SonioxSTTService {
  const service = new SonioxSTTService({ apiKey: "test-key", ...options });
  const svc = service as any;
  svc.pushFrame = async (frame: Frame) => {
    events.push(["push", frame.constructor]);
  };
  svc.broadcastFrame = async (frameCls: unknown) => {
    events.push(["broadcast", frameCls]);
  };
  svc.broadcastInterruption = async () => {
    events.push(["interruption", null]);
  };
  svc._handleTranscription = async () => {};
  return service;
}

test("test_service_metadata_recommends_external_turn_strategies_in_soniox_mode", () => {
  const service = new SonioxSTTService({ apiKey: "test-key", vadForceTurnEndpoint: false });
  const frame = service.serviceMetadataFrame();
  expect(frame.userTurnStrategies).toBeInstanceOf(ExternalUserTurnStrategies);
});

test("test_service_metadata_leaves_turn_strategies_unset_in_pipecat_mode", () => {
  const service = new SonioxSTTService({ apiKey: "test-key" });
  const frame = service.serviceMetadataFrame();
  expect(frame.userTurnStrategies ?? null).toBeNull();
});

test("test_soniox_turn_detection_emits_turn_frames", async () => {
  const events: Event[] = [];
  const service = instrumentedService(events, { vadForceTurnEndpoint: false });

  const messages = [
    dumps({ tokens: [{ text: "Hel", is_final: false }] }),
    dumps({
      tokens: [
        { text: "Hello.", is_final: true },
        { text: END_TOKEN, is_final: true },
      ],
    }),
    dumps({ tokens: [], finished: true }),
  ];
  service._websocket = new FakeWebsocket(messages) as any;

  await service._receiveMessages();

  expect(events).toEqual([
    // Turn opens on the first token, before any transcription frames.
    ["broadcast", ProposedUserStartedSpeakingFrame],
    ["push", InterimTranscriptionFrame],
    // Endpoint: finalized transcript first, then the turn closes.
    ["push", TranscriptionFrame],
    ["broadcast", ProposedUserStoppedSpeakingFrame],
  ]);
  expect((service as any)._userTurnOpen).toBe(false);
});

test("test_soniox_turn_detection_never_interrupts_directly", async () => {
  // The service proposes turns; the strategies own the interruption.
  const events: Event[] = [];
  const service = instrumentedService(events, { vadForceTurnEndpoint: false });

  const messages = [
    dumps({ tokens: [{ text: "Hel", is_final: false }] }),
    dumps({ tokens: [], finished: true }),
  ];
  service._websocket = new FakeWebsocket(messages) as any;

  await service._receiveMessages();

  expect(events).toContainEqual(["broadcast", ProposedUserStartedSpeakingFrame]);
  expect(events).not.toContainEqual(["interruption", null]);
});

test("test_soniox_should_interrupt_rides_on_recommended_strategies", () => {
  // should_interrupt no longer gates a local broadcast; it configures the
  // strategies the service recommends via its metadata frame.
  for (const shouldInterrupt of [true, false]) {
    const service = new SonioxSTTService({
      apiKey: "test-key",
      vadForceTurnEndpoint: false,
      shouldInterrupt,
    });
    const strategies = service.serviceMetadataFrame().userTurnStrategies;
    expect(strategies).toBeInstanceOf(ExternalUserTurnStrategies);
    expect((strategies as ExternalUserTurnStrategies).enableInterruptions).toBe(shouldInterrupt);
  }
});

test("test_soniox_pipecat_mode_recommends_no_strategies", () => {
  // In the default mode Soniox proposes no turns, so the defaults stand.
  const service = new SonioxSTTService({ apiKey: "test-key", vadForceTurnEndpoint: true });
  expect(service.serviceMetadataFrame().userTurnStrategies ?? null).toBeNull();
});

test("test_soniox_turn_detection_reopens_turn_after_end_token", async () => {
  const events: Event[] = [];
  const service = instrumentedService(events, { vadForceTurnEndpoint: false });

  // A single message can close one turn and start the next.
  const messages = [
    dumps({
      tokens: [
        { text: "Hello.", is_final: true },
        { text: END_TOKEN, is_final: true },
        { text: "And", is_final: false },
      ],
    }),
    dumps({ tokens: [], finished: true }),
  ];
  service._websocket = new FakeWebsocket(messages) as any;

  await service._receiveMessages();

  expect(events).toEqual([
    ["broadcast", ProposedUserStartedSpeakingFrame],
    ["push", TranscriptionFrame],
    ["broadcast", ProposedUserStoppedSpeakingFrame],
    // Tokens after the endpoint open a new turn.
    ["broadcast", ProposedUserStartedSpeakingFrame],
    ["push", InterimTranscriptionFrame],
    // The finished message closes the still-open turn.
    ["broadcast", ProposedUserStoppedSpeakingFrame],
  ]);
});

test("test_soniox_turn_detection_no_duplicate_started_across_messages", async () => {
  const events: Event[] = [];
  const service = instrumentedService(events, { vadForceTurnEndpoint: false });

  const messages = [
    dumps({ tokens: [{ text: "Hel", is_final: false }] }),
    dumps({ tokens: [{ text: "Hello", is_final: true }] }),
    dumps({ tokens: [], finished: true }),
  ];
  service._websocket = new FakeWebsocket(messages) as any;

  await service._receiveMessages();

  const started = events.filter(
    ([kind, cls]) => kind === "broadcast" && cls === ProposedUserStartedSpeakingFrame,
  );
  expect(started).toHaveLength(1);
});

test("test_pipecat_mode_emits_no_turn_frames", async () => {
  const events: Event[] = [];
  const service = instrumentedService(events);

  const messages = [
    dumps({ tokens: [{ text: "Hel", is_final: false }] }),
    dumps({
      tokens: [
        { text: "Hello.", is_final: true },
        { text: END_TOKEN, is_final: true },
      ],
    }),
    dumps({ tokens: [], finished: true }),
  ];
  service._websocket = new FakeWebsocket(messages) as any;

  await service._receiveMessages();

  expect(events).toEqual([
    ["push", InterimTranscriptionFrame],
    ["push", TranscriptionFrame],
  ]);
});

test("test_vad_start_opens_turn_before_tokens", async () => {
  const events: Event[] = [];
  const service = instrumentedService(events, { vadForceTurnEndpoint: false });

  // The local VAD signal is the fast path: the turn opens before any token.
  await service.processFrame(new VADUserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM);

  expect(events).toEqual([
    ["push", VADUserStartedSpeakingFrame], // re-pushed by the base STTService
    ["broadcast", ProposedUserStartedSpeakingFrame],
  ]);

  // Tokens arriving later must not open a second turn.
  const messages = [
    dumps({
      tokens: [
        { text: "Hello.", is_final: true },
        { text: END_TOKEN, is_final: true },
      ],
    }),
    dumps({ tokens: [], finished: true }),
  ];
  service._websocket = new FakeWebsocket(messages) as any;

  await service._receiveMessages();

  const started = events.filter(
    ([kind, cls]) => kind === "broadcast" && cls === ProposedUserStartedSpeakingFrame,
  );
  expect(started).toHaveLength(1);
  expect(events.slice(-2)).toEqual([
    ["push", TranscriptionFrame],
    ["broadcast", ProposedUserStoppedSpeakingFrame],
  ]);
});

test("test_vad_stop_does_not_close_turn", async () => {
  const events: Event[] = [];
  const service = instrumentedService(events, { vadForceTurnEndpoint: false });

  // The Soniox endpoint owns the turn close: a VAD stop (e.g. a mid-turn
  // pause) must not close it.
  await service.processFrame(new VADUserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM);
  await service.processFrame(new VADUserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM);

  expect(events).not.toContainEqual(["broadcast", ProposedUserStoppedSpeakingFrame]);
  expect((service as any)._userTurnOpen).toBe(true);
});

test("test_pipecat_mode_vad_frames_emit_no_turn_frames", async () => {
  const events: Event[] = [];
  const service = instrumentedService(events);

  await service.processFrame(new VADUserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM);
  await service.processFrame(new VADUserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM);

  expect(events).toEqual([
    ["push", VADUserStartedSpeakingFrame],
    ["push", VADUserStoppedSpeakingFrame],
  ]);
});

test("test_soniox_turn_detection_error_closes_open_turn", async () => {
  const events: Event[] = [];
  const service = instrumentedService(events, { vadForceTurnEndpoint: false });
  (service as any).pushError = async () => {
    events.push(["error", null]);
  };

  const messages = [
    dumps({ tokens: [{ text: "Hel", is_final: false }] }),
    dumps({ tokens: [], error_code: 500, error_message: "boom" }),
    dumps({ tokens: [], finished: true }),
  ];
  service._websocket = new FakeWebsocket(messages) as any;

  await service._receiveMessages();

  expect(events).toEqual([
    ["broadcast", ProposedUserStartedSpeakingFrame],
    ["push", InterimTranscriptionFrame],
    ["broadcast", ProposedUserStoppedSpeakingFrame],
    ["error", null],
  ]);
});

test("test_endpoint_transcript_emits_usage_before_transcription_frame", async () => {
  const service = new SonioxSTTService({ apiKey: "test-key" });
  (service as any)._setup = frameProcessorSetup(new TaskManager(), { enableUsageMetrics: true });
  const pushedFrames: Frame[] = [];

  (service as any).pushFrame = async (frame: Frame) => {
    pushedFrames.push(frame);
  };
  (service as any)._handleTranscription = async () => {};

  // Simulate audio previously submitted to the service.
  (service as any)._sttUsagePendingSeconds = 2.5;

  const messages = [
    dumps({
      tokens: [
        { text: "Hello.", is_final: true },
        { text: END_TOKEN, is_final: true },
      ],
    }),
    dumps({ tokens: [], finished: true }),
  ];
  service._websocket = new FakeWebsocket(messages) as any;

  await service._receiveMessages();

  const frameTypes = pushedFrames.map((f) => f.constructor);
  expect(frameTypes).toContain(MetricsFrame);
  expect(frameTypes).toContain(TranscriptionFrame);
  // Usage must precede the transcript so tracing can attach it to the span
  // the finalized TranscriptionFrame closes.
  expect(frameTypes.indexOf(MetricsFrame)).toBeLessThan(frameTypes.indexOf(TranscriptionFrame));

  const metricsFrame = pushedFrames[frameTypes.indexOf(MetricsFrame)] as MetricsFrame;
  const data = metricsFrame.data[0];
  expect(data).toBeInstanceOf(STTUsageMetricsData);
  expect((data as STTUsageMetricsData).value.audioSeconds).toBe(2.5);
  expect((service as any)._sttUsagePendingSeconds).toBe(0.0);
});

test("test_receive_messages_allows_final_transcription_without_language", async () => {
  const service = new SonioxSTTService({ apiKey: "test-key" });
  const pushedFrames: Frame[] = [];
  const tracedTranscriptions: [string, boolean, Language | null][] = [];

  const messages = [
    dumps({
      tokens: [
        { text: "Tell", is_final: true },
        { text: " me", is_final: true },
        { text: " a", is_final: true },
        { text: " joke.", is_final: true },
        { text: END_TOKEN, is_final: true },
      ],
    }),
    dumps({ tokens: [], finished: true }),
  ];

  service._websocket = new FakeWebsocket(messages) as any;
  (service as any).pushFrame = async (frame: Frame) => {
    pushedFrames.push(frame);
  };
  (service as any)._handleTranscription = async (
    transcript: string,
    isFinal: boolean,
    language: Language | null = null,
  ) => {
    tracedTranscriptions.push([transcript, isFinal, language]);
  };

  await service._receiveMessages();

  const finalFrames = pushedFrames.filter((f) => f instanceof TranscriptionFrame);
  expect(finalFrames).toHaveLength(1);
  const frame = finalFrames[0] as TranscriptionFrame;
  expect(frame.text).toBe("Tell me a joke.");
  expect(frame.language ?? null).toBeNull();
  expect(frame.finalized).toBe(true);
  expect(tracedTranscriptions).toEqual([["Tell me a joke.", true, null]]);
});

/** Build a service holding an open fake socket, without touching the network. */
function connectedService(): [SonioxSTTService, FakeWebsocket] {
  const service = new SonioxSTTService({ apiKey: "test-key" });
  (service as any)._setup = frameProcessorSetup(new TaskManager());
  const websocket = new FakeWebsocket([]);
  service._websocket = websocket as any;
  return [service, websocket];
}

function sentPayloads(websocket: FakeWebsocket): unknown[] {
  return websocket.send.mock.calls.map((call) => call[0]);
}

describe("stop and cancel", () => {
  test("test_stop_sends_end_of_audio_while_the_socket_is_open", async () => {
    const [service, websocket] = connectedService();

    await service.stop(new EndFrame());

    expect(sentPayloads(websocket)).toEqual([""]);
    expect(websocket.closed).toBe(true);
  });

  test("test_stop_disconnects_once", async () => {
    const [service] = connectedService();
    const original = service._disconnectWebsocket.bind(service);
    const spy = mock(original);
    service._disconnectWebsocket = spy;

    await service.stop(new EndFrame());

    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("test_cancel_does_not_send_end_of_audio", async () => {
    const [service, websocket] = connectedService();

    await service.cancel(new CancelFrame());

    expect(sentPayloads(websocket)).toEqual([]);
    expect(websocket.closed).toBe(true);
  });

  test("test_stop_completes_teardown_when_the_end_of_audio_send_fails", async () => {
    const [service, websocket] = connectedService();
    websocket.send = mock(async () => {
      throw new Error("transient send failure");
    });
    const svc = service as any;
    const spy = mock(svc._flushSttUsageMetrics.bind(service));
    svc._flushSttUsageMetrics = spy;

    await service.stop(new EndFrame());

    // The send is best-effort: everything after it still has to run.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(svc._disconnecting).toBe(true);
    expect(websocket.closed).toBe(true);
  });
});

test("test_language_update_reconnects_with_that_language_as_the_hint", async () => {
  const websocket = new FakeWebsocket([]);
  const service = new SonioxSTTService({
    apiKey: "test-key",
    settings: new SonioxSTTService.Settings({ languageHints: [Language.FI] }),
  });
  patchConnect(service, websocket);
  const reconnect = mock(async () => {});
  (service as any)._requestReconnect = reconnect;

  await (service as any)._updateSettings(new STTSettings({ language: Language.SV }));
  await service._connectWebsocket();

  const config = JSON.parse(websocket.send.mock.calls.at(-1)?.[0] as string);
  expect(config.language_hints).toEqual(["sv"]);
  expect(reconnect).toHaveBeenCalledTimes(1);
});

test("test_language_update_leaves_the_callers_delta_unchanged", async () => {
  const service = new SonioxSTTService({
    apiKey: "test-key",
    settings: new SonioxSTTService.Settings({ languageHints: [Language.FI] }),
  });
  (service as any)._requestReconnect = mock(async () => {});
  const delta = new STTSettings({ language: Language.SV });

  await (service as any)._updateSettings(delta);

  expect(delta.language).toBe(Language.SV);
  expect("languageHints" in delta).toBe(false);
});

test("test_constructor_language_connects_with_that_language_as_the_hint", async () => {
  const websocket = new FakeWebsocket([]);
  const service = new SonioxSTTService({
    apiKey: "test-key",
    settings: new SonioxSTTService.Settings({ language: Language.SV }),
  });
  patchConnect(service, websocket);

  await service._connectWebsocket();

  const config = JSON.parse(websocket.send.mock.calls.at(-1)?.[0] as string);
  expect(config.language_hints).toEqual(["sv"]);
});

test("test_language_update_outside_the_language_enum_does_not_raise", async () => {
  const service = new SonioxSTTService({
    apiKey: "test-key",
    settings: new SonioxSTTService.Settings({ languageHints: [Language.FI] }),
  });
  (service as any)._requestReconnect = mock(async () => {});

  await (service as any)._updateSettings(new STTSettings({ language: "zh-Hant" }));

  expect((service as any)._settings.languageHints).toEqual([Language.FI]);
});

test("test_language_hints_given_with_a_language_are_kept", () => {
  const service = new SonioxSTTService({
    apiKey: "test-key",
    settings: new SonioxSTTService.Settings({
      language: Language.FI,
      languageHints: [Language.FI, Language.SV],
    }),
  });

  expect((service as any)._settings.languageHints).toEqual([Language.FI, Language.SV]);
});

test("test_soniox_error_code_sets_category", async () => {
  const events: Event[] = [];
  const service = instrumentedService(events);
  const categories: (ErrorCategory | null)[] = [];

  (service as any).pushError = async (_msg: string, options: Dict = {}) => {
    categories.push(options.category ?? null);
  };

  const messages = [
    dumps({ tokens: [], error_code: 402, error_message: "balance exhausted" }),
    dumps({ tokens: [], error_code: 401, error_message: "invalid key" }),
    dumps({ tokens: [], error_message: "no code" }),
  ];
  service._websocket = new FakeWebsocket(messages) as any;

  await service._receiveMessages();

  expect(categories).toEqual([ErrorCategory.QUOTA, ErrorCategory.AUTHENTICATION, null]);
});

for (const language of [Language.NB, Language.NB_NO]) {
  test(`test_norwegian_bokmal_maps_to_soniox_norwegian[${language}]`, () => {
    expect(languageToSonioxLanguage(language)).toBe("no");
  });
}
