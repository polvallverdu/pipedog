// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_speechmatics_stt.py

/**
 * Unit tests for the Speechmatics STT service.
 *
 * These run fully offline: no network, no live STT session. They cover the
 * non-trivial, decision-carrying logic in `stt.ts`: model resolution, settings
 * precedence, turn-mode gating, the segment to frame mapping, the
 * `sendMessage` contract, and the reconnect loop. Each test locks one
 * behavior; changing that behavior in the source should break the test.
 *
 * Porting notes:
 * - Tests of deprecated upstream behavior (`operating_point`, `InputParams`,
 *   `_apply_legacy_params`, `_check_deprecated_args`) are skipped: those APIs
 *   are not ported.
 * - Upstream monkeypatches the SDK client class and `asyncio.sleep`; here the
 *   service's `_createClient` and `_sleep` seams are replaced on the instance.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { InterimTranscriptionFrame, TranscriptionFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";

import { Model, Segment } from "../src/agent_stt.ts";
import {
  _DEFAULT_TURN_DETECTION_MODE,
  _isAuthRejection,
  _resolveModel,
  SpeechmaticsSTTService,
  TurnDetectionMode,
} from "../src/stt.ts";

type Any = any;

// Keep credential resolution deterministic: no ambient Speechmatics env vars
// leak into construction, so `apiKey` is the only source under test.
beforeEach(() => {
  delete process.env.SPEECHMATICS_API_KEY;
  delete process.env.SPEECHMATICS_RT_URL;
});

function _service(options: Record<string, unknown> = {}): SpeechmaticsSTTService {
  const service = new SpeechmaticsSTTService({
    apiKey: "test-key",
    sampleRate: 16000,
    ...options,
  });
  // setup() resolves the sample rate; these tests never run it, so mirror what it does.
  (service as Any)._sampleRate = 16000;
  return service;
}

// ---------------------------------------------------------------------------
// _resolveModel: model resolution
// ---------------------------------------------------------------------------

describe("resolve_model", () => {
  test("test_resolve_model_prefers_model_over_none_operating_point", () => {
    // `model` is the canonical field. Upstream also takes an `operating_point`
    // alias; it is deprecated and not ported, so `model` is the only input.
    expect(_resolveModel("linden-1")).toBe("linden-1");
  });

  test.skip("test_resolve_model_conflicting_values_raise", () => {
    // DIVERGENCE: `operating_point` is deprecated upstream (1.10.0) and not ported,
    // so there are no two values to conflict.
  });

  test.skip("test_resolve_model_operating_point_only_warns_and_is_used", () => {
    // DIVERGENCE: `operating_point` is deprecated upstream (1.10.0) and not ported.
  });

  test("test_resolve_model_defaults_when_neither_given", () => {
    // With nothing specified, the SDK default model must be chosen, not null,
    // which would later fail assertGiven in _buildConfig.
    expect(_resolveModel(null)).toBe(Model.LINDEN_1);
  });

  test("test_resolve_model_returns_wire_string_for_enum_input", () => {
    // A `Model` member must be reduced to its wire string, since the SDK
    // config is compared/serialized by string value.
    const resolved = _resolveModel(Model.LINDEN_1);
    expect(resolved).toBe("linden-1");
    expect(typeof resolved).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// _apply_legacy_params: deprecated InputParams -> canonical Settings migration
// ---------------------------------------------------------------------------

describe("apply_legacy_params", () => {
  test.skip("test_apply_legacy_params_copies_shared_fields", () => {
    // DIVERGENCE: `InputParams` and `_apply_legacy_params` are deprecated upstream and not ported.
  });

  test.skip("test_apply_legacy_params_returns_encoding_without_setting_it_on_settings", () => {
    // DIVERGENCE: `InputParams` and `_apply_legacy_params` are deprecated upstream and not ported.
  });

  test.skip("test_apply_legacy_params_speaker_format_default_depends_on_diarization", () => {
    // DIVERGENCE: `InputParams` and `_apply_legacy_params` are deprecated upstream and not ported.
  });
});

// ---------------------------------------------------------------------------
// _check_deprecated_args: legacy kwarg handling
// ---------------------------------------------------------------------------

describe("check_deprecated_args", () => {
  test.skip("test_check_deprecated_args_migrates_renamed_kwarg", () => {
    // DIVERGENCE: the legacy constructor keyword arguments are deprecated upstream and not ported.
  });

  test.skip("test_check_deprecated_args_pops_recognized_kwargs", () => {
    // DIVERGENCE: the legacy constructor keyword arguments are deprecated upstream and not ported.
  });

  test.skip("test_check_deprecated_args_no_replacement_kwarg_does_not_crash", () => {
    // DIVERGENCE: the legacy constructor keyword arguments are deprecated upstream and not ported.
  });

  test.skip("test_check_deprecated_args_ignores_unknown_kwargs", () => {
    // DIVERGENCE: the legacy constructor keyword arguments are deprecated upstream and not ported.
  });
});

// ---------------------------------------------------------------------------
// Construction: validation, defaults, precedence, model resolution
// ---------------------------------------------------------------------------

describe("construction", () => {
  test("test_missing_api_key_raises", () => {
    // No key (and none in the environment) must fail loudly at construction rather
    // than defer to an opaque auth failure at connect time.
    expect(() => new SpeechmaticsSTTService({ apiKey: null, sampleRate: 16000 })).toThrow();
  });

  test("test_default_turn_detection_mode", () => {
    // The default drives turn-frame emission and endpointing behavior downstream, so it
    // is pinned here rather than left to whatever the settings class happens to hold.
    expect((_service() as Any)._settings.turnDetectionMode).toBe(_DEFAULT_TURN_DETECTION_MODE);
    expect(_DEFAULT_TURN_DETECTION_MODE).toBe(TurnDetectionMode.EXTERNAL);
  });

  test.skip("test_settings_take_precedence_over_deprecated_params", () => {
    // DIVERGENCE: the deprecated `params` argument is not ported.
  });

  test.skip("test_operating_point_resolved_into_model", () => {
    // DIVERGENCE: `operating_point` is deprecated upstream (1.10.0) and not ported.
  });

  test("test_diarization_config_built_when_enabled", () => {
    // Enabling diarization with a knob must produce a wire diarization config carrying
    // that knob: the path that actually turns on speaker attribution.
    const service = _service({
      settings: new SpeechmaticsSTTService.Settings({ enableDiarization: true, maxSpeakers: 2 }),
    });
    expect((service as Any)._config.diarization).toBe("speaker");
    expect((service as Any)._config.speakerDiarizationConfig.maxSpeakers).toBe(2);
  });

  test("test_punctuation_overrides_reach_the_wire_config", () => {
    // Agent STT accepts punctuation_overrides as in the RT API, so a configured value
    // must be sent.
    const overrides = { permitted_marks: [".", ","] };
    const service = _service({
      settings: new SpeechmaticsSTTService.Settings({ punctuationOverrides: overrides }),
    });
    expect((service as Any)._config.punctuationOverrides).toEqual(overrides);
    expect((service as Any)._config.toDict().punctuation_overrides).toEqual(overrides);
    expect((_service() as Any)._config.punctuationOverrides).toBeNull();
  });

  test("test_emit_sentences_reaches_the_wire_config_only_when_set", () => {
    // Unset means the service default (turn-level segments), so the key stays off the wire.
    expect("emit_sentences" in (_service() as Any)._config.toDict()).toBe(false);

    const service = _service({
      settings: new SpeechmaticsSTTService.Settings({ emitSentences: true }),
    });
    expect((service as Any)._config.toDict().emit_sentences).toBe(true);
  });

  test("test_no_diarization_leaves_config_empty", () => {
    // With diarization off, neither the diarization flag nor a speaker config may be
    // sent: otherwise the engine would attempt attribution it was not asked for.
    const service = _service();
    expect((service as Any)._config.diarization).toBeNull();
    expect((service as Any)._config.speakerDiarizationConfig).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Turn-mode gating: the single source of "does the service own turns?"
// ---------------------------------------------------------------------------

describe("turn_mode_gating", () => {
  test("test_service_closes_turns_true_for_vad", () => {
    // VAD mode means the service endpoints and emits turn frames; the gate must say so.
    const service = _service({
      settings: new SpeechmaticsSTTService.Settings({ turnDetectionMode: TurnDetectionMode.VAD }),
    });
    expect((service as Any)._serviceClosesTurns).toBe(true);
  });

  test("test_service_closes_turns_false_for_external", () => {
    // EXTERNAL mode hands endpointing to the caller; the gate must be false so turn
    // frames, turn-event subscriptions, and processing metrics stay off.
    const service = _service({
      settings: new SpeechmaticsSTTService.Settings({
        turnDetectionMode: TurnDetectionMode.EXTERNAL,
      }),
    });
    expect((service as Any)._serviceClosesTurns).toBe(false);
  });

  test("test_metadata_frame_routes_should_interrupt_to_external_strategies", () => {
    // When the service closes turns it proposes the boundaries, and the strategies it
    // recommends own the interruption, so `shouldInterrupt` must reach them.
    const frame = _service({
      shouldInterrupt: false,
      settings: new SpeechmaticsSTTService.Settings({ turnDetectionMode: TurnDetectionMode.VAD }),
    }).serviceMetadataFrame();
    expect(frame.userTurnStrategies).toBeInstanceOf(ExternalUserTurnStrategies);
    expect((frame.userTurnStrategies as ExternalUserTurnStrategies).enableInterruptions).toBe(
      false,
    );
  });

  test("test_metadata_frame_recommends_no_strategies_in_external_mode", () => {
    // In EXTERNAL mode Pipecat owns endpointing, so no strategies are recommended.
    const frame = _service({
      settings: new SpeechmaticsSTTService.Settings({
        turnDetectionMode: TurnDetectionMode.EXTERNAL,
      }),
    }).serviceMetadataFrame();
    expect(frame.userTurnStrategies).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sendMessage contract
// ---------------------------------------------------------------------------

describe("send_message", () => {
  test("test_send_message_without_connection_raises", async () => {
    // The documented contract: sending with no live session raises. Without this the
    // call silently no-ops (or defers a null-deref into a background task).
    const service = _service(); // never connected, so _client is null
    await expect(service.sendMessage("SomeMessage")).rejects.toThrow();
  });

  test("test_send_message_propagates_send_failure", async () => {
    // A failure from a live client must reach the caller: sendMessage awaits the
    // underlying send, so its errors propagate instead of being swallowed in a task.
    const failingClient = {
      async sendMessage(_payload: unknown) {
        throw new Error("bad payload");
      },
    };

    const service = _service();
    (service as Any)._client = failingClient;

    await expect(service.sendMessage("SomeMessage")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// _segmentToFrame: pure Segment -> Pipecat frame mapping
// ---------------------------------------------------------------------------

describe("segment_to_frame", () => {
  test("test_segment_to_frame_final_vs_interim_type", () => {
    // `finalized` selects the frame type; downstream aggregators treat final and
    // interim transcripts differently, so the mapping must honor it.
    const service = _service();
    const segment = new Segment({ transcript: "hello", speaker: "S1" });

    const final = service._segmentToFrame(segment, { finalized: true });
    const interim = service._segmentToFrame(segment, { finalized: false });
    expect(final).toBeInstanceOf(TranscriptionFrame);
    expect(interim).toBeInstanceOf(InterimTranscriptionFrame);
  });

  test("test_segment_to_frame_applies_speaker_format", () => {
    // The configured speakerActiveFormat must shape the emitted text and the speaker
    // must become the frame's userId: that is how per-speaker context reaches the LLM.
    const service = _service({
      settings: new SpeechmaticsSTTService.Settings({
        speakerActiveFormat: "@{speaker_id}: {text}",
      }),
    });
    const frame = service._segmentToFrame(new Segment({ transcript: "hi", speaker: "S1" }), {
      finalized: true,
    });

    expect(frame.text).toBe("@S1: hi");
    expect(frame.userId).toBe("S1");
  });
});

// ---------------------------------------------------------------------------
// _localeToSpeechmaticsLocale: regional output locale mapping
// ---------------------------------------------------------------------------

describe("locale", () => {
  test("test_locale_maps_regional_variant", () => {
    // A regional English variant must map to its Speechmatics output locale code.
    expect(_service()._localeToSpeechmaticsLocale("en", Language.EN_GB)).toBe("en-GB");
  });

  test("test_locale_none_without_regional_variant", () => {
    // A base language with no regional variant must yield no output locale, so the
    // engine is not handed a spurious locale.
    expect(_service()._localeToSpeechmaticsLocale("en", Language.EN)).toBeNull();
  });

  test("test_unsupported_regional_variant_constructs_and_falls_back", () => {
    // An English variant with no Speechmatics output locale is built from the
    // constructor, so the fallback path must not touch anything not yet set up.
    const service = _service({
      settings: new SpeechmaticsSTTService.Settings({ language: Language.EN_IN }),
    });
    expect((service as Any)._config.language).toBe("en");
    expect((service as Any)._config.outputLocale).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reconnect: the self-healing for connect/send failures. It runs inside
// STTService._reconnect(), which buffers and replays audio for the whole call.
// ---------------------------------------------------------------------------

/** Drive `_doReconnect` through `outcomes`, one per attempt, without sleeping. */
function _stubReconnectAttempts(
  service: SpeechmaticsSTTService,
  outcomes: boolean[],
): { n: number; sleep: ReturnType<typeof mock> } {
  const sleepMock = mock(async (_seconds: number) => {});
  (service as Any)._sleep = sleepMock;
  (service as Any)._disconnect = mock(async () => {});
  const attempts = { n: 0, sleep: sleepMock };

  (service as Any)._openConnection = async (_options?: { reportError?: boolean }) => {
    attempts.n += 1;
    return outcomes[attempts.n - 1];
  };
  return attempts;
}

describe("reconnect", () => {
  test("test_do_reconnect_retries_until_success", async () => {
    // A transient drop must be retried: the core guarantee that one failure does not
    // permanently deafen the session.
    const service = _service();
    const attempts = _stubReconnectAttempts(service, [false, false, true]);

    await (service as Any)._doReconnect();

    expect(attempts.n).toBe(3);
  });

  test("test_do_reconnect_reports_permanent_error_once_attempts_are_exhausted", async () => {
    // Retries are bounded, and exhausting them must be reported as a permanent error so
    // the service is marked unusable instead of silently dropping audio into no client.
    const service = _service();
    const pushError = mock(async (..._args: unknown[]) => {});
    (service as Any).pushError = pushError;
    const attempts = _stubReconnectAttempts(
      service,
      new Array(service.RECONNECT_MAX_ATTEMPTS).fill(false),
    );

    await (service as Any)._doReconnect();

    expect(attempts.n).toBe(service.RECONNECT_MAX_ATTEMPTS);
    expect(pushError).toHaveBeenCalledTimes(1);
    expect((pushError.mock.calls[0] as Any)[1].forceTreatAsPermanent).toBe(true);
    expect((service as Any)._closed).toBe(true);
  });

  test("test_do_reconnect_stops_when_session_is_rejected", async () => {
    // A rejected session (`_closed`) will not clear on retry, so the loop must stop at
    // once rather than spinning against a permanent error.
    const service = _service();
    const attempts = _stubReconnectAttempts(service, [false, true]);
    const openConnection = (service as Any)._openConnection;

    (service as Any)._openConnection = async (options?: { reportError?: boolean }) => {
      (service as Any)._closed = true; // what _failPermanently does
      return await openConnection(options);
    };

    await (service as Any)._doReconnect();

    expect(attempts.n).toBe(1);
  });

  test("test_do_reconnect_makes_no_attempt_once_closed", async () => {
    // A cancel that lands during the backoff sleep closes the service; the next loop
    // iteration must not reopen a connection (and its message task) after that.
    const service = _service();
    const attempts = _stubReconnectAttempts(service, [true]);
    (service as Any)._closed = true;

    await (service as Any)._doReconnect();

    expect(attempts.n).toBe(0);
  });

  test("test_do_reconnect_does_not_sleep_after_final_attempt", async () => {
    // The backoff sleeps between attempts, never after the last one, so exhaustion is
    // reported as soon as it is known.
    const service = _service();
    (service as Any).pushError = mock(async () => {});
    const attempts = _stubReconnectAttempts(
      service,
      new Array(service.RECONNECT_MAX_ATTEMPTS).fill(false),
    );

    await (service as Any)._doReconnect();

    expect(attempts.sleep).toHaveBeenCalledTimes(service.RECONNECT_MAX_ATTEMPTS - 1);
  });

  test("test_connect_does_not_reconnect_after_rejection", async () => {
    // A rejected session on the initial connect is permanent; _connect must not
    // request the reconnect loop, which would attempt (and fail) the handshake again.
    const service = _service();
    const scheduleReconnect = mock(() => {});
    (service as Any)._scheduleReconnect = scheduleReconnect;

    (service as Any)._openConnection = async (_options?: unknown) => {
      (service as Any)._closed = true; // what _failPermanently does
      return false;
    };

    await (service as Any)._connect();

    expect(scheduleReconnect).not.toHaveBeenCalled();
  });

  test("test_connect_retries_a_transient_failure_in_the_background", async () => {
    // A transient failure on the initial connect must enter the reconnect loop without
    // blocking start(), or the StartFrame would wait out the whole backoff sequence.
    const service = _service();
    const scheduleReconnect = mock(() => {});
    (service as Any)._scheduleReconnect = scheduleReconnect;
    (service as Any)._openConnection = mock(async () => false);

    await (service as Any)._connect();

    expect(scheduleReconnect).toHaveBeenCalledTimes(1);
  });

  test("test_server_error_rejecting_the_request_is_permanent", async () => {
    // A server Error that rejects the request (bad config, no authorisation) would fail
    // a fresh session the same way, so it must be reported as permanent, not reconnected.
    const service = _service();
    const pushError = mock(async (..._args: unknown[]) => {});
    (service as Any).pushError = pushError;
    const scheduleReconnect = mock(() => {});
    (service as Any)._scheduleReconnect = scheduleReconnect;

    await (service as Any)._handleError({ message: "Error", type: "not_authorised", reason: "no" });

    expect((pushError.mock.calls[0] as Any)[1].forceTreatAsPermanent).toBe(true);
    expect((service as Any)._closed).toBe(true);
    expect(scheduleReconnect).not.toHaveBeenCalled();
  });

  test("test_server_error_ending_the_session_reconnects", async () => {
    // A server Error that only ends the session (a timeout, an internal error) must be
    // reported as recoverable and followed by a background reconnect.
    const service = _service();
    const pushError = mock(async (..._args: unknown[]) => {});
    (service as Any).pushError = pushError;
    const scheduleReconnect = mock(() => {});
    (service as Any)._scheduleReconnect = scheduleReconnect;

    await (service as Any)._handleError({ message: "Error", type: "session_timeout" });

    expect((pushError.mock.calls[0] as Any)[1]?.forceTreatAsPermanent).not.toBe(true);
    expect((service as Any)._closed).toBe(false);
    expect(scheduleReconnect).toHaveBeenCalledTimes(1);
  });

  test("test_disconnect_drains_message_queue", async () => {
    // Messages buffered from one session must not survive into the next. The consumer
    // task is cancelled on disconnect, so anything left queued would be replayed by the
    // fresh consumer started on reconnect (the queue is reused). Disconnect must clear it.
    const service = _service();
    // Simulate messages the client buffered but the (now-cancelled) consumer never drained.
    (service as Any)._sttMsgQueue.putNowait({ message: "AddSegment", stale: true });
    (service as Any)._sttMsgQueue.putNowait({ message: "EndOfTurn", stale: true });
    expect((service as Any)._sttMsgQueue.qsize()).toBe(2);

    await (service as Any)._disconnect(); // no client/tasks set: exercises the drain path only

    expect((service as Any)._sttMsgQueue.empty()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _isAuthRejection: classifying a rejected credential out of the generic
// ConnectionError so a bad key is fatal, not retried forever.
// ---------------------------------------------------------------------------

class _FakeResponse {
  status_code: number;
  constructor(statusCode: number) {
    this.status_code = statusCode;
  }
}

/** Shape of websockets>=13 InvalidStatus: status on `.response.status_code`. */
class _NewStyleInvalidStatus extends Error {
  response: _FakeResponse;
  constructor(statusCode: number) {
    super(`server rejected WebSocket connection: HTTP ${statusCode}`);
    this.response = new _FakeResponse(statusCode);
  }
}

/** Shape of legacy websockets InvalidStatusCode: status on `.status_code`. */
class _LegacyInvalidStatusCode extends Error {
  status_code: number;
  constructor(statusCode: number) {
    super(`server rejected WebSocket connection: HTTP ${statusCode}`);
    this.status_code = statusCode;
  }
}

describe("is_auth_rejection", () => {
  for (const status of [401, 403]) {
    test(`test_is_auth_rejection_new_style_status[${status}]`, () => {
      // A websockets>=13 handshake rejection exposes the status on `.response.status_code`.
      expect(_isAuthRejection(new _NewStyleInvalidStatus(status))).toBe(true);
    });
  }

  for (const status of [401, 403]) {
    test(`test_is_auth_rejection_legacy_status[${status}]`, () => {
      // The legacy websockets handshake rejection exposes it on `.status_code`.
      expect(_isAuthRejection(new _LegacyInvalidStatusCode(status))).toBe(true);
    });
  }

  test("test_is_auth_rejection_reads_chained_cause", () => {
    // The SDK re-wraps the handshake error in a ConnectionError; the status must still be
    // found through the exception chain (cause), not just the top exception.
    const wrapped = new Error("WebSocket connection error", {
      cause: new _NewStyleInvalidStatus(401),
    });
    expect(_isAuthRejection(wrapped)).toBe(true);
  });

  test("test_is_auth_rejection_message_fallback", () => {
    // When only the status text survives (no structured attribute), the message is used.
    expect(
      _isAuthRejection(
        new Error("WebSocket connection error: server rejected connection: HTTP 403"),
      ),
    ).toBe(true);
  });

  test("test_is_auth_rejection_false_for_transient_drop", () => {
    // A plain network drop carries no auth status and must stay retryable (not fatal).
    expect(_isAuthRejection(new Error("WebSocket connection error: timed out"))).toBe(false);
  });

  test("test_is_auth_rejection_false_for_other_http_status", () => {
    // A non-auth handshake status (e.g. 500) is not an auth rejection.
    expect(_isAuthRejection(new _NewStyleInvalidStatus(500))).toBe(false);
  });
});

/** Minimal AgentSttClient stand-in whose connect() raises a chosen error. */
function _stubClient(error: Error) {
  return () => ({
    on() {},
    async connect() {
      throw error;
    },
  });
}

function _connectionErrorWithStatus(status: number): Error {
  return new Error("WebSocket connection error", { cause: new _NewStyleInvalidStatus(status) });
}

describe("open_connection", () => {
  test("test_open_connection_auth_rejection_is_permanent", async () => {
    // A 401 handshake rejection must stop the session (permanent error, no reconnect),
    // not fall into the retryable branch that reconnects forever.
    const service = _service();
    const pushError = mock(async (..._args: unknown[]) => {});
    (service as Any).pushError = pushError;
    (service as Any)._createClient = _stubClient(_connectionErrorWithStatus(401));

    const ok = await service._openConnection({ reportError: true });

    expect(ok).toBe(false);
    expect((service as Any)._closed).toBe(true); // _failPermanently ran -> no reconnect
    expect(pushError).toHaveBeenCalledTimes(1);
    expect((pushError.mock.calls[0] as Any)[1].forceTreatAsPermanent).toBe(true);
  });

  test("test_open_connection_unsupported_sample_rate_is_permanent", async () => {
    // A pipeline rate the service does not accept fails every attempt the same way, so it
    // must stop the session with a permanent error before a client is built, not raise the
    // client's error out of start().
    const service = _service();
    (service as Any)._sampleRate = 24000;
    const pushError = mock(async (..._args: unknown[]) => {});
    (service as Any).pushError = pushError;
    const createClient = mock(() => ({}));
    (service as Any)._createClient = createClient;

    const ok = await service._openConnection({ reportError: true });

    expect(ok).toBe(false);
    expect((service as Any)._closed).toBe(true);
    expect(createClient).not.toHaveBeenCalled();
    expect((pushError.mock.calls[0] as Any)[1].forceTreatAsPermanent).toBe(true);
  });

  for (const rate of [8000, 16000]) {
    test(`test_open_connection_supported_sample_rate_connects[${rate}]`, async () => {
      // Both rates the service accepts must reach the client's AudioFormat unchanged.
      const service = _service();
      (service as Any)._sampleRate = rate;
      const createClient = mock((_options: Any) => ({ on() {}, connect: async () => {} }));
      (service as Any)._createClient = createClient;
      (service as Any).createTask = mock(() => null);

      const ok = await service._openConnection({ reportError: true });

      expect(ok).toBe(true);
      expect((createClient.mock.calls[0] as Any)[0].audioFormat.sampleRate).toBe(rate);
    });
  }

  test("test_open_connection_transient_drop_stays_retryable", async () => {
    // A plain connection drop must remain retryable (surfaced, but not fatal) so the
    // reconnect loop can heal it.
    const service = _service();
    const pushError = mock(async (..._args: unknown[]) => {});
    (service as Any).pushError = pushError;
    (service as Any)._createClient = _stubClient(
      new Error("WebSocket connection error: timed out"),
    );

    const ok = await service._openConnection({ reportError: true });

    expect(ok).toBe(false);
    expect((service as Any)._closed).toBe(false); // still retryable
    expect(pushError).toHaveBeenCalledTimes(1);
    expect((pushError.mock.calls[0] as Any)[1]?.forceTreatAsPermanent).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _updateSettings: runtime model re-resolution
//
// `_buildConfig` reads only `model`, so a runtime settings update must rebuild
// the config before the reconnect it triggers, or the reconnect would reopen
// the *same* configuration: an audio gap that changes nothing, silently.
// ---------------------------------------------------------------------------

/** Neutralize the connection side effects so _updateSettings exercises only the settings/config logic. */
function _stubReconnect(service: SpeechmaticsSTTService): void {
  (service as Any)._disconnect = mock(async () => {});
  (service as Any)._requestReconnect = mock(async () => {});
  (service as Any).setUsable = mock(async () => {});
}

describe("update_settings", () => {
  test.skip("test_update_settings_operating_point_reresolves_into_model", () => {
    // DIVERGENCE: `operating_point` is deprecated upstream (1.10.0) and not ported.
  });

  test.skip("test_update_settings_operating_point_does_not_clash_with_resolved_model", () => {
    // DIVERGENCE: `operating_point` is deprecated upstream (1.10.0) and not ported.
  });

  test("test_update_settings_model_reresolves_into_model", async () => {
    // Changing `model` directly at runtime must take effect in the rebuilt config.
    const service = _service();
    _stubReconnect(service);

    await (service as Any)._updateSettings(
      new SpeechmaticsSTTService.Settings({ model: "linden-2" }),
    );

    expect((service as Any)._settings.model).toBe("linden-2");
    expect((service as Any)._config.model).toBe("linden-2");
  });

  test("test_update_settings_reopens_a_closed_service", async () => {
    // A rejected session leaves the service closed; a settings update that needs a
    // reconnect must clear that so the new settings get a chance to connect.
    const service = _service();
    _stubReconnect(service);
    (service as Any)._closed = true;

    await (service as Any)._updateSettings(
      new SpeechmaticsSTTService.Settings({ language: Language.ES }),
    );

    expect((service as Any)._closed).toBe(false);
    expect((service as Any)._requestReconnect).toHaveBeenCalledTimes(1);
  });

  test("test_update_settings_unrelated_field_leaves_model_untouched", async () => {
    // An update that does not touch `model` must not re-resolve it.
    const service = _service(); // model resolved to linden-1
    _stubReconnect(service);

    await (service as Any)._updateSettings(
      new SpeechmaticsSTTService.Settings({ domain: "finance" }),
    );

    expect((service as Any)._settings.model).toBe("linden-1");
    expect((service as Any)._settings.domain).toBe("finance");
  });
});
