// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_fish_tts.py

/** Unit tests for Fish Audio TTS. */

import { describe, expect, test } from "bun:test";
import { decode, encode } from "@msgpack/msgpack";
import { NOT_GIVEN } from "@pipedog/core/utils/types";
import { FishAudioTTSService } from "../src/tts.ts";

// Tests reach into protected members.
type Any = any;

describe("TestFishAudioTTS", () => {
  test("test_one_silent_context_writes_off_the_service", () => {
    const service: Any = new FishAudioTTSService({
      apiKey: "key",
      maxConsecutiveZeroAudioContexts: 1,
    });

    expect(service._maxConsecutiveZeroAudioContexts).toBe(1);
  });

  test("test_the_silent_context_limit_can_be_raised", () => {
    const service: Any = new FishAudioTTSService({
      apiKey: "key",
      maxConsecutiveZeroAudioContexts: 4,
    });

    expect(service._maxConsecutiveZeroAudioContexts).toBe(4);
  });

  /** A websocket that records what is sent. */
  function recordingSocket() {
    const sent: Uint8Array[] = [];
    return {
      sent,
      send: async (data: Uint8Array) => {
        sent.push(data);
      },
      close: async () => {},
      state: 1,
    };
  }

  /** Connect with a mocked socket and return the start message's request. */
  async function startRequest(settings?: InstanceType<typeof FishAudioTTSService.Settings>) {
    const service: Any = new FishAudioTTSService({ apiKey: "key", settings });
    const websocket = recordingSocket();
    service._websocketConnect = async () => websocket;

    await service._connectWebsocket();

    const message = decode(websocket.sent.at(-1)!) as Record<string, any>;
    expect(message.event).toBe("start");
    return message.request as Record<string, any>;
  }

  /** Connect with a mocked socket and return the handshake headers. */
  async function connectHeaders(settings?: InstanceType<typeof FishAudioTTSService.Settings>) {
    const service: Any = new FishAudioTTSService({ apiKey: "key", settings });
    let headers: Record<string, string> = {};
    service._websocketConnect = async (_url: string, options: Any) => {
      headers = options.additionalHeaders;
      return recordingSocket();
    };

    await service._connectWebsocket();

    return headers;
  }

  test("test_default_model_is_s2_1_pro", async () => {
    const headers = await connectHeaders();

    expect(headers.model).toBe("s2.1-pro");
  });

  test("test_drama_3_model_is_sent_in_handshake", async () => {
    const headers = await connectHeaders(new FishAudioTTSService.Settings({ model: "drama-3" }));

    expect(headers.model).toBe("drama-3");
  });

  test("test_start_message_omits_unset_request_settings", async () => {
    const request = await startRequest();

    for (const name of ["chunk_length", "min_chunk_length", "condition_on_previous_chunks"]) {
      expect(name in request).toBe(false);
    }
    expect(request.prosody).toEqual({ speed: 1.0, volume: 0 });
  });

  test("test_start_message_carries_set_request_settings", async () => {
    const request = await startRequest(
      new FishAudioTTSService.Settings({
        chunkLength: 150,
        minChunkLength: 20,
        conditionOnPreviousChunks: false,
        prosodyNormalizeLoudness: false,
      }),
    );

    expect(request.chunk_length).toBe(150);
    expect(request.min_chunk_length).toBe(20);
    expect(request.condition_on_previous_chunks).toBe(false);
    expect(request.prosody.normalize_loudness).toBe(false);
    expect("normalize_loudness" in request).toBe(false);
  });

  test("test_nested_prosody_mapping_leaves_missing_keys_unset", () => {
    const delta: Any = FishAudioTTSService.Settings.fromMapping({ prosody: { speed: 1.2 } });

    expect(delta.prosodySpeed).toBe(1.2);
    expect(delta.prosodyVolume).toBe(NOT_GIVEN);
    expect(delta.prosodyNormalizeLoudness).toBe(NOT_GIVEN);
  });

  test("test_nested_prosody_mapping_carries_normalize_loudness", () => {
    const delta: Any = FishAudioTTSService.Settings.fromMapping({
      prosody: { normalize_loudness: false },
    });

    expect(delta.prosodyNormalizeLoudness).toBe(false);
  });

  /** A websocket stand-in that yields the given messages, then ends. */
  class _Messages {
    #messages: Uint8Array[];

    constructor(messages: Iterable<Uint8Array>) {
      this.#messages = [...messages];
    }

    async *[Symbol.asyncIterator]() {
      while (this.#messages.length > 0) {
        yield this.#messages.shift()!;
      }
    }
  }

  test("test_short_audio_chunks_are_kept", async () => {
    // A decoded chunk is PCM, so a short one is real audio (an utterance's tail).
    const service: Any = new FishAudioTTSService({ apiKey: "key" });
    const chunks = [
      new Uint8Array(320).map((_, i) => (i % 2 === 0 ? 1 : 0)),
      new Uint8Array(2048).map((_, i) => (i % 2 === 0 ? 2 : 0)),
    ];
    service._websocket = new _Messages(
      chunks.map((chunk) => encode({ event: "audio", audio: chunk })),
    );
    service.getActiveAudioContextId = () => "ctx";
    service.stopTtfbMetrics = async () => {};
    const appended: Uint8Array[] = [];
    service.appendToAudioContext = async (_contextId: string, frame: Any) => {
      appended.push(frame.audio);
    };

    await service._receiveMessages();

    expect(appended.map((a) => Array.from(a))).toEqual(chunks.map((c) => Array.from(c)));
  });
});
