// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_gemini_stt.py

/**
 * Tests for Gemini Live STT transcription handling and config building.
 *
 * PORTING NOTES:
 * - Upstream builds the service with `object.__new__` (skipping `__init__`).
 *   Here the service is constructed normally with a dummy API key (the
 *   google-genai client does no I/O until a Live session is opened), then the
 *   same fields are overwritten as upstream does.
 * - Server messages use the JS SDK's camelCase field names
 *   (`serverContent`, `interimInputTranscription`, `languageCode`).
 * - The JS SDK's `Session.sendRealtimeInput()` is synchronous and takes a
 *   single params object, so the fake sessions record that object and the
 *   failing one throws synchronously. Audio `Blob.data` is base64 in the JS
 *   SDK, so it is decoded before comparing with the sent bytes.
 * - `Modality.TEXT` → the `"TEXT"` string the JS SDK uses.
 * - `patch.object(STTService, "_update_settings", AsyncMock(...))` →
 *   `spyOn(STTService.prototype, "_updateSettings")`.
 */

import { describe, expect, mock, spyOn, test } from "bun:test";
import {
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import { STTService } from "@pipedog/core/services/stt_service";
import { Language } from "@pipedog/core/transcriptions/language";
import { GeminiSTTService, type GeminiSTTSettingsOptions } from "../src/gemini_live/stt.ts";

type Internals = any;

type TranscriptionCall = [string, boolean, Language | null];

function makeService(
  settingsOptions: GeminiSTTSettingsOptions = {},
): [Internals, Frame[], TranscriptionCall[]] {
  const service: Internals = new GeminiSTTService({ apiKey: "test" });
  service._name = "GeminiSTTService#0";
  service._userId = "user";
  service._settings = new GeminiSTTService.Settings({
    model: "gemini-3.5-transcribe-live",
    language: null,
    languages: [],
    languageAuto: null,
    adaptationPhrases: null,
  });
  service._settings.applyUpdate(new GeminiSTTService.Settings(settingsOptions));

  service._session = null;
  service._sampleRate = 16000;

  const frames: Frame[] = [];
  const transcriptions: TranscriptionCall[] = [];

  service.pushFrame = async (frame: Frame) => {
    frames.push(frame);
  };
  service.stopProcessingMetrics = async () => {};
  service._handleTranscription = async (
    transcript: string,
    isFinal: boolean,
    language: Language | null = null,
  ) => {
    transcriptions.push([transcript, isFinal, language]);
  };

  return [service, frames, transcriptions];
}

function interimMessage({ text, languageCode }: { text: string; languageCode?: string | null }) {
  const transcription = { text, languageCode: languageCode ?? null };
  return {
    serverContent: { interimInputTranscription: transcription, inputTranscription: null },
  };
}

function finalMessage({ text, languageCode }: { text: string; languageCode?: string | null }) {
  const transcription = { text, languageCode: languageCode ?? null };
  return {
    serverContent: { interimInputTranscription: null, inputTranscription: transcription },
  };
}

function b64decode(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe("test_gemini_stt", () => {
  test("test_interim_transcriptions_emit_interim_frames", async () => {
    const [service, frames, transcriptions] = makeService();

    for (const message of [
      interimMessage({ text: "hello" }),
      interimMessage({ text: "hello there" }),
    ]) {
      await service._handleServerMessage(message);
    }

    expect(frames.every((f) => f instanceof InterimTranscriptionFrame)).toBe(true);
    expect(frames.map((f) => (f as InterimTranscriptionFrame).text)).toEqual([
      "hello",
      "hello there",
    ]);
    expect(transcriptions).toEqual([]);
  });

  test("test_input_transcription_emits_finalized_frame", async () => {
    const [service, frames, transcriptions] = makeService();

    for (const message of [
      interimMessage({ text: "hello" }),
      finalMessage({ text: "hello there" }),
      finalMessage({ text: "again" }),
    ]) {
      await service._handleServerMessage(message);
    }

    expect(frames[0]).toBeInstanceOf(InterimTranscriptionFrame);
    expect(frames[1]).toBeInstanceOf(TranscriptionFrame);
    expect((frames[1] as TranscriptionFrame).text).toBe("hello there");
    expect((frames[1] as TranscriptionFrame).finalized).toBe(true);
    expect(frames[2]).toBeInstanceOf(TranscriptionFrame);
    expect((frames[2] as TranscriptionFrame).text).toBe("again");
    expect(transcriptions).toEqual([
      ["hello there", true, null],
      ["again", true, null],
    ]);
  });

  test("test_empty_and_missing_transcriptions_are_ignored", async () => {
    const [service, frames] = makeService();

    await service._handleServerMessage(interimMessage({ text: "" }));
    await service._handleServerMessage(finalMessage({ text: "" }));
    await service._handleServerMessage({ serverContent: null });

    expect(frames).toEqual([]);
  });

  test("test_language_code_mapping", async () => {
    const [service, frames, transcriptions] = makeService();

    await service._handleServerMessage(finalMessage({ text: "hola", languageCode: "es-ES" }));
    await service._handleServerMessage(
      finalMessage({ text: "??", languageCode: "not-a-language" }),
    );

    expect((frames[0] as TranscriptionFrame).language).toBe(Language.ES_ES);
    expect((frames[1] as TranscriptionFrame).language).toBeNull();
    expect(transcriptions).toEqual([
      ["hola", true, Language.ES_ES],
      ["??", true, null],
    ]);
  });

  test("test_build_live_config_defaults_to_language_auto", () => {
    const [service] = makeService();

    const config = service._buildLiveConfig();

    expect(config.responseModalities).toEqual(["TEXT"]);
    expect(config.inputAudioTranscription.languageAuto).not.toBeUndefined();
    expect(config.inputAudioTranscription.languageAuto).not.toBeNull();
    expect(config.inputAudioTranscription.languageHints ?? null).toBeNull();
    expect(config.inputAudioTranscription.adaptationPhrases ?? null).toBeNull();
  });

  test("test_build_live_config_languages_become_hints", () => {
    const [service] = makeService({ languages: [Language.ES_ES, Language.EN_US] });

    const config = service._buildLiveConfig();

    expect(config.inputAudioTranscription.languageAuto ?? null).toBeNull();
    expect(config.inputAudioTranscription.languageHints.languageCodes).toEqual(["es-ES", "en-US"]);
  });

  test("test_build_live_config_single_language_becomes_hint", () => {
    const [service] = makeService({ language: "fr-FR" });

    const config = service._buildLiveConfig();

    expect(config.inputAudioTranscription.languageAuto ?? null).toBeNull();
    expect(config.inputAudioTranscription.languageHints.languageCodes).toEqual(["fr-FR"]);
  });

  test("test_build_live_config_hints_win_over_explicit_auto", () => {
    const [service] = makeService({ languages: [Language.ES_ES], languageAuto: true });

    const config = service._buildLiveConfig();

    expect(config.inputAudioTranscription.languageAuto ?? null).toBeNull();
    expect(config.inputAudioTranscription.languageHints.languageCodes).toEqual(["es-ES"]);
  });

  test("test_build_live_config_auto_disabled_without_hints", () => {
    const [service] = makeService({ languageAuto: false });

    const config = service._buildLiveConfig();

    expect(config.inputAudioTranscription.languageAuto ?? null).toBeNull();
    expect(config.inputAudioTranscription.languageHints ?? null).toBeNull();
  });

  test("test_build_live_config_adaptation_phrases", () => {
    const [service] = makeService({ adaptationPhrases: ["oatmilk"] });

    const config = service._buildLiveConfig();

    expect(config.inputAudioTranscription.adaptationPhrases).toEqual(["oatmilk"]);
  });

  test("test_build_live_config_keeps_automatic_activity_detection", () => {
    const [service] = makeService();

    expect(service._buildLiveConfig().realtimeInputConfig ?? null).toBeNull();
  });

  /** Attach a fake live session, returning the calls it records. */
  function makeSession(service: Internals): Record<string, Internals>[] {
    const calls: Record<string, Internals>[] = [];

    const sendRealtimeInput = (params: Record<string, Internals>) => {
      calls.push(params);
    };

    service._session = { sendRealtimeInput };
    return calls;
  }

  async function drain(generator: AsyncGenerator<unknown>): Promise<void> {
    for await (const _ of generator) {
      // drain
    }
  }

  test("test_streams_audio_continuously", async () => {
    const [service] = makeService();
    const calls = makeSession(service);

    await drain(service.runStt(new Uint8Array([0x01, 0x02])));
    await drain(service.runStt(new Uint8Array([0x03, 0x04])));

    expect(calls.map((c) => b64decode(c.audio.data))).toEqual([
      new Uint8Array([0x01, 0x02]),
      new Uint8Array([0x03, 0x04]),
    ]);
  });

  test("test_finalization_signal_sends_audio_stream_end", async () => {
    const [service] = makeService();
    const calls = makeSession(service);

    await drain(service.runStt(bytes("speech")));
    await service._sendFinalizationSignal();
    await drain(service.runStt(bytes("more speech")));

    expect(b64decode(calls[0]!.audio.data)).toEqual(bytes("speech"));
    expect(calls[1]).toEqual({ audioStreamEnd: true });
    expect(b64decode(calls[2]!.audio.data)).toEqual(bytes("more speech"));
  });

  test("test_finalization_signal_without_session_is_a_noop", async () => {
    const [service] = makeService();

    await service._sendFinalizationSignal();
  });

  /** Attach a live session whose sends fail, returning the attempts it records. */
  function makeFailingSession(service: Internals): Record<string, Internals>[] {
    const attempts: Record<string, Internals>[] = [];

    const sendRealtimeInput = (params: Record<string, Internals>) => {
      attempts.push(params);
      throw new Error("gone");
    };

    service._session = { sendRealtimeInput };
    return attempts;
  }

  test("test_finalization_signal_failure_reconnects", async () => {
    const [service] = makeService();
    service._requestReconnect = mock(async () => {});
    makeFailingSession(service);

    await service._sendFinalizationSignal();

    expect(service._session).toBeNull();
    expect(service._requestReconnect).toHaveBeenCalledTimes(1);
  });

  test("test_audio_send_failure_reconnects", async () => {
    const [service] = makeService();
    service._requestReconnect = mock(async () => {});
    makeFailingSession(service);

    await drain(service.runStt(bytes("speech")));

    expect(service._session).toBeNull();
    expect(service._requestReconnect).toHaveBeenCalledTimes(1);
  });

  test("test_audio_after_a_send_failure_is_not_retried_on_the_dead_session", async () => {
    const [service] = makeService();
    service._requestReconnect = mock(async () => {});
    const attempts = makeFailingSession(service);

    await drain(service.runStt(bytes("one")));
    await drain(service.runStt(bytes("two")));

    expect(attempts.length).toBe(1);
    expect(service._requestReconnect).toHaveBeenCalledTimes(1);
  });

  test("test_update_settings_requests_reconnect_only_on_change", async () => {
    const [service] = makeService();
    service._requestReconnect = mock(async () => {});
    const proto = STTService.prototype as Internals;

    let spy = spyOn(proto, "_updateSettings").mockImplementation(async () => ({ languages: [] }));
    try {
      await service._updateSettings(new GeminiSTTService.Settings({ languages: [Language.FR] }));
    } finally {
      spy.mockRestore();
    }
    expect(service._requestReconnect).toHaveBeenCalledTimes(1);

    service._requestReconnect.mockClear();
    spy = spyOn(proto, "_updateSettings").mockImplementation(async () => ({}));
    try {
      await service._updateSettings(new GeminiSTTService.Settings());
    } finally {
      spy.mockRestore();
    }
    expect(service._requestReconnect).not.toHaveBeenCalled();
  });
});
