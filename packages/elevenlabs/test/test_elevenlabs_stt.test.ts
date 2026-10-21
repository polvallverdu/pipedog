// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_elevenlabs_stt.py

import { describe, expect, test } from "bun:test";
import { type Frame, TranscriptionFrame } from "@pipedog/core/frames/frames";
import type { WebsocketConnectOptions } from "@pipedog/core/services/websocket_service";
import { Language } from "@pipedog/core/transcriptions/language";
import {
  audioFormatFromSampleRate,
  CommitStrategy,
  ElevenLabsRealtimeSTTService,
  ElevenLabsSTTService,
  languageToElevenlabsLanguage,
} from "../src/stt.ts";

// Tests reach into protected members.
type Any = any;

const COMMITTED_TEXT = "Hello. This is a test of the speech-to-text service.";

const PLAIN_COMMITTED_MESSAGE = {
  message_type: "committed_transcript",
  text: COMMITTED_TEXT,
};

const TIMESTAMPED_COMMITTED_MESSAGE = {
  message_type: "committed_transcript_with_timestamps",
  text: COMMITTED_TEXT,
  language_code: "en",
  words: [{ text: "Hello.", start: 0.0, end: 0.5, type: "word" }],
};

/** Collect the TranscriptionFrames a service pushes. */
function _captureTranscriptions(service: Any): TranscriptionFrame[] {
  const captured: TranscriptionFrame[] = [];

  service.pushFrame = async (frame: Frame, _direction?: unknown) => {
    if (frame instanceof TranscriptionFrame) {
      captured.push(frame);
    }
  };
  return captured;
}

/**
 * Replace the service's websocket connect with a fake that records its
 * arguments (upstream monkeypatches `websocket_service.websocket_connect`,
 * which `_websocketConnect()` wraps).
 */
function _fakeWebsocketConnect(service: Any, captured: Record<string, unknown>): void {
  service._websocketConnect = async (url: string, options: WebsocketConnectOptions = {}) => {
    captured.url = url;
    captured.headers = options.additionalHeaders;
    return {};
  };
}

/** Python `urllib.parse.parse_qs`: each key maps to the list of its values. */
function parseQs(query: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, value] of new URLSearchParams(query)) {
    if (value === "") {
      continue; // parse_qs drops blank values by default
    }
    result[key] ??= [];
    result[key].push(value);
  }
  return result;
}

describe("test_elevenlabs_stt", () => {
  test("test_elevenlabs_stt_sends_keyterms_multipart_fields", async () => {
    const captured: { headers: Record<string, string | null>; fields: [string, string][] } = {
      headers: {},
      fields: [],
    };

    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== "/v1/speech-to-text") {
          return new Response("not found", { status: 404 });
        }
        captured.headers["xi-api-key"] = request.headers.get("xi-api-key");
        const form = await request.formData();

        for (const [name, value] of form) {
          if (name === "file") {
            await (value as Blob).arrayBuffer();
          } else {
            captured.fields.push([name, value as string]);
          }
        }

        return Response.json({ text: "hello", language_code: "eng", words: [] });
      },
    });
    const baseUrl = `http://${server.hostname}:${server.port}`;

    let result: Record<string, unknown>;
    try {
      const service: Any = new ElevenLabsSTTService({
        apiKey: "test-key",
        baseUrl,
        settings: new ElevenLabsSTTService.Settings({
          language: Language.EN,
          keyterms: ["Pipecat", "Scribe V2"],
        }),
      });

      result = await service._transcribeAudio(new TextEncoder().encode("RIFF"));
    } finally {
      server.stop(true);
    }

    expect(result.text).toEqual("hello");
    expect(captured.headers["xi-api-key"]).toEqual("test-key");
    expect(captured.fields).toContainEqual(["model_id", "scribe_v2"]);
    expect(captured.fields).toContainEqual(["language_code", "eng"]);
    expect(
      captured.fields.filter(([name]) => name === "keyterms").map(([, value]) => value),
    ).toEqual(["Pipecat", "Scribe V2"]);
  });

  test("test_elevenlabs_realtime_websocket_url_includes_keyterms", async () => {
    const captured: Record<string, unknown> = {};

    const service: Any = new ElevenLabsRealtimeSTTService({
      apiKey: "test-key",
      baseUrl: "example.test",
      commitStrategy: CommitStrategy.VAD,
      sampleRate: 16000,
      includeTimestamps: true,
      settings: new ElevenLabsRealtimeSTTService.Settings({
        language: Language.EN,
        keyterms: ["Pipecat", "Scribe V2"],
        vadThreshold: 0.7,
      }),
    });
    _fakeWebsocketConnect(service, captured);
    service._audioFormat = audioFormatFromSampleRate(16000);

    await service._connectWebsocket();

    const parsed = new URL(captured.url as string);
    const query = parseQs(parsed.search.slice(1));
    expect(parsed.protocol).toEqual("wss:");
    expect(parsed.host).toEqual("example.test");
    expect(parsed.pathname).toEqual("/v1/speech-to-text/realtime");
    expect(query.model_id).toEqual(["scribe_v2_realtime"]);
    expect(query.language_code).toEqual(["eng"]);
    expect(query.audio_format).toEqual(["pcm_16000"]);
    expect(query.commit_strategy).toEqual(["vad"]);
    expect(query.include_timestamps).toEqual(["true"]);
    expect(query.vad_threshold).toEqual(["0.7"]);
    expect(query.keyterms).toEqual(["Pipecat", "Scribe V2"]);
    expect(captured.headers).toEqual({ "xi-api-key": "test-key" });
  });

  test.each([
    [Language.EN, "eng"],
    [Language.EN_US, "eng"],
    [Language.ES_MX, "spa"],
    [Language.YUE, "yue"],
  ])(
    "test_language_to_elevenlabs_language_resolves_regional_variants[%s-%s]",
    (language, expected) => {
      expect(languageToElevenlabsLanguage(language)).toEqual(expected);
    },
  );

  test("test_elevenlabs_realtime_converts_language_on_settings_update", async () => {
    const service: Any = new ElevenLabsRealtimeSTTService({
      apiKey: "test-key",
      settings: new ElevenLabsRealtimeSTTService.Settings({ language: Language.EN_US }),
    });
    expect(service._settings.language).toEqual("eng");

    await service._updateSettings(
      new ElevenLabsRealtimeSTTService.Settings({ language: Language.ES_MX }),
    );
    expect(service._settings.language).toEqual("spa");
  });

  test("test_elevenlabs_realtime_websocket_url_includes_filter_background_audio", async () => {
    const captured: Record<string, unknown> = {};

    // Background filtering applies under either commit strategy, unlike the VAD tuning params.
    const service: Any = new ElevenLabsRealtimeSTTService({
      apiKey: "test-key",
      baseUrl: "example.test",
      commitStrategy: CommitStrategy.MANUAL,
      sampleRate: 16000,
      settings: new ElevenLabsRealtimeSTTService.Settings({ filterBackgroundAudio: true }),
    });
    _fakeWebsocketConnect(service, captured);
    service._audioFormat = audioFormatFromSampleRate(16000);

    await service._connectWebsocket();

    const query = parseQs(new URL(captured.url as string).search.slice(1));
    expect(query.commit_strategy).toEqual(["manual"]);
    expect(query.filter_background_audio).toEqual(["true"]);
  });

  test("test_elevenlabs_realtime_websocket_url_omits_unset_filter_background_audio", async () => {
    const captured: Record<string, unknown> = {};

    const service: Any = new ElevenLabsRealtimeSTTService({
      apiKey: "test-key",
      baseUrl: "example.test",
      sampleRate: 16000,
    });
    _fakeWebsocketConnect(service, captured);
    service._audioFormat = audioFormatFromSampleRate(16000);

    await service._connectWebsocket();

    const query = parseQs(new URL(captured.url as string).search.slice(1));
    expect("filter_background_audio" in query).toBe(false);
  });

  test("test_elevenlabs_realtime_language_detection_emits_single_final", async () => {
    // Language detection turns on the timestamped message, which alone carries language.
    const service: Any = new ElevenLabsRealtimeSTTService({
      apiKey: "test-key",
      sampleRate: 16000,
      includeLanguageDetection: true,
    });
    const captured = _captureTranscriptions(service);

    // The server sends the timestamped message first in this configuration.
    await service._processResponse(TIMESTAMPED_COMMITTED_MESSAGE);
    await service._processResponse(PLAIN_COMMITTED_MESSAGE);

    expect(captured.length).toEqual(1);
    expect(captured[0]!.text).toEqual(COMMITTED_TEXT);
    expect(captured[0]!.language).toEqual("en" as Language);
  });

  test("test_elevenlabs_realtime_timestamps_emits_single_final", async () => {
    const service: Any = new ElevenLabsRealtimeSTTService({
      apiKey: "test-key",
      sampleRate: 16000,
      includeTimestamps: true,
    });
    const captured = _captureTranscriptions(service);

    await service._processResponse(PLAIN_COMMITTED_MESSAGE);
    await service._processResponse(TIMESTAMPED_COMMITTED_MESSAGE);

    expect(captured.length).toEqual(1);
    expect(captured[0]!.text).toEqual(COMMITTED_TEXT);
  });

  test("test_elevenlabs_realtime_both_options_emit_single_final", async () => {
    const service: Any = new ElevenLabsRealtimeSTTService({
      apiKey: "test-key",
      sampleRate: 16000,
      includeTimestamps: true,
      includeLanguageDetection: true,
    });
    const captured = _captureTranscriptions(service);

    await service._processResponse(PLAIN_COMMITTED_MESSAGE);
    await service._processResponse(TIMESTAMPED_COMMITTED_MESSAGE);

    expect(captured.length).toEqual(1);
    expect(captured[0]!.language).toEqual("en" as Language);
  });

  test("test_elevenlabs_realtime_plain_committed_emitted_without_options", async () => {
    // Without either option the server sends only the plain message, so it must be emitted.
    const service: Any = new ElevenLabsRealtimeSTTService({
      apiKey: "test-key",
      sampleRate: 16000,
    });
    const captured = _captureTranscriptions(service);

    await service._processResponse(PLAIN_COMMITTED_MESSAGE);

    expect(captured.length).toEqual(1);
    expect(captured[0]!.text).toEqual(COMMITTED_TEXT);
    expect(captured[0]!.language).toBeNull();
  });
});
