// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_tts_reconnect.py

/**
 * Tests for how websocket TTS services handle a replaced provider connection.
 *
 * Providers keep context state per connection, so replacing a connection ends
 * every open audio context, and a turn in progress continues under a new context
 * ID. Reopening a closed connection to send the text at hand leaves audio contexts
 * alone.
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";

import { sleep } from "@pipedog/asyncio";

import {
  type Frame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  TextFrame,
  TTSAudioRawFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSUpdateSettingsFrame,
} from "../src/frames/frames.ts";
import type { ServiceSettings } from "../src/services/settings.ts";
import { TTSSettings } from "../src/services/settings.ts";
import { WebsocketTTSService } from "../src/services/tts_service.ts";
import type { WebsocketClientConnection } from "../src/services/websocket_service.ts";
import * as websocketServiceModule from "../src/services/websocket_service.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";

const _SAMPLE_RATE = 16000;

const originalWebsocketServiceModule = { ...websocketServiceModule };

// _fake_websocket_connect (autouse fixture): replace websocket_connect.
beforeEach(() => {
  const fakeConnect = async (..._args: unknown[]) => ({}) as unknown as WebsocketClientConnection;
  mock.module("../src/services/websocket_service.ts", () => ({
    ...originalWebsocketServiceModule,
    websocketConnect: fakeConnect,
  }));
});

afterEach(() => {
  mock.module("../src/services/websocket_service.ts", () => originalWebsocketServiceModule);
});

interface MockWebsocketTTSServiceOptions {
  reconnectAfter?: number | null;
  reconnectByDisconnecting?: boolean;
  firstAudio?: Uint8Array | null;
  connectLazily?: boolean;
}

/**
 * Websocket-style service whose audio arrives after runTts returns.
 *
 * Each sentence's audio is tagged with the sentence's position. After the
 * audio for `reconnectAfter` arrives, the service replaces its connection.
 * Like several real services, it also replaces its connection when a setting
 * changes.
 *
 * @param options.reconnectAfter The sentence after which to replace the
 *   connection, or null.
 * @param options.reconnectByDisconnecting Replace the connection with
 *   `_disconnect()` and `_connect()`, as settings changes and failed sends do,
 *   rather than through `_reconnectWebsocket`.
 * @param options.firstAudio Audio for the first sentence, if not the default.
 * @param options.connectLazily Open the connection in the first runTts call,
 *   the way services reconnect after the provider closed an idle connection.
 */
class MockWebsocketTTSService extends WebsocketTTSService {
  _reconnectAfter: number | null;
  _reconnectByDisconnecting: boolean;
  _firstAudio: Uint8Array | null;
  _needsConnection: boolean;
  _sentences = 0;

  constructor(options: MockWebsocketTTSServiceOptions = {}) {
    super({
      pushTextFrames: false,
      pushStopFrames: true,
      sampleRate: _SAMPLE_RATE,
      stopFrameTimeoutS: 0.3,
    });
    this._reconnectAfter = options.reconnectAfter === undefined ? 1 : options.reconnectAfter;
    this._reconnectByDisconnecting = options.reconnectByDisconnecting ?? false;
    this._firstAudio = options.firstAudio ?? null;
    this._needsConnection = options.connectLazily ?? false;
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  async _connectWebsocket(): Promise<void> {}

  async _disconnectWebsocket(): Promise<void> {}

  async _receiveMessages(): Promise<void> {}

  override async _verifyConnection(): Promise<boolean> {
    return true;
  }

  protected override async _updateSettings(
    delta: ServiceSettings,
  ): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if (Object.keys(changed).length > 0) {
      await this._disconnect();
      await this._connect();
    }
    return changed;
  }

  async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    void text;
    this._sentences += 1;
    const sentence = this._sentences;
    if (!this.audioContextAvailable(contextId)) {
      await this.createAudioContext(contextId);
      yield new TTSStartedFrame({ contextId });
    }
    if (this._needsConnection) {
      this._needsConnection = false;
      await this._websocketConnect("ws://test");
    }

    const deliver = async () => {
      await sleep(0.02);
      let audio = repeat(new Uint8Array([sentence, 0]), 160);
      if (sentence === 1 && this._firstAudio !== null) {
        audio = this._firstAudio;
      }
      await this.appendToAudioContext(
        contextId,
        new TTSAudioRawFrame({ audio, sampleRate: _SAMPLE_RATE, numChannels: 1, contextId }),
      );
      if (sentence === this._reconnectAfter) {
        await sleep(0.05);
        if (this._reconnectByDisconnecting) {
          await this._disconnect();
          await this._connect();
        } else {
          await this._reconnectWebsocket(1);
        }
      }
    };

    this.createTask(() => deliver(), `deliver_${sentence}`);
    yield null;
  }
}

function repeat(chunk: Uint8Array, times: number): Uint8Array {
  const out = new Uint8Array(chunk.length * times);
  for (let i = 0; i < times; i++) out.set(chunk, i * chunk.length);
  return out;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function _speakTwoSentences(
  service: MockWebsocketTTSService,
  between: Frame[] | null = null,
): Promise<Frame[]> {
  // "One." is released when "Two" arrives, and "Two." when the turn ends, so
  // anything that happens after sentence 1 comes before sentence 2.
  const [downFrames] = await runTest(service, {
    framesToSend: [
      new LLMFullResponseStartFrame(),
      new TextFrame({ text: "One. " }),
      new TextFrame({ text: "Two" }),
      new SleepFrame({ sleep: 0.15 }),
      ...(between ?? []),
      new SleepFrame({ sleep: 0.15 }),
      new TextFrame({ text: "." }),
      new LLMFullResponseEndFrame(),
      new SleepFrame({ sleep: 0.6 }),
    ],
  });
  return downFrames;
}

function _assertTurnContinuedUnderNewContext(downFrames: Frame[]): void {
  const audio = _audioBySentence(downFrames);
  expect(new Set(audio.keys())).toEqual(new Set([1, 2]));
  const firstContext = audio.get(1)![0]!.contextId;
  const secondContext = audio.get(2)![0]!.contextId;
  expect(firstContext).not.toEqual(secondContext);
  // The old context is stopped before the new one starts.
  const events = downFrames
    .filter((f) => f instanceof TTSStartedFrame || f instanceof TTSStoppedFrame)
    .map((f) => [f.constructor.name, (f as TTSStartedFrame | TTSStoppedFrame).contextId]);
  expect(events).toEqual([
    ["TTSStartedFrame", firstContext],
    ["TTSStoppedFrame", firstContext],
    ["TTSStartedFrame", secondContext],
    ["TTSStoppedFrame", secondContext],
  ]);
}

function _audioBySentence(frames: Frame[]): Map<number, TTSAudioRawFrame[]> {
  const audio = new Map<number, TTSAudioRawFrame[]>();
  for (const frame of frames) {
    if (frame instanceof TTSAudioRawFrame) {
      const key = frame.audio[0]!;
      if (!audio.has(key)) audio.set(key, []);
      audio.get(key)!.push(frame);
    }
  }
  return audio;
}

test("test_reconnect_continues_turn_under_new_context", async () => {
  const service = new MockWebsocketTTSService();

  const downFrames = await _speakTwoSentences(service);

  _assertTurnContinuedUnderNewContext(downFrames);
});

test("test_disconnect_and_connect_continues_turn_under_new_context", async () => {
  const service = new MockWebsocketTTSService({ reconnectByDisconnecting: true });

  const downFrames = await _speakTwoSentences(service);

  _assertTurnContinuedUnderNewContext(downFrames);
});

test("test_settings_change_mid_turn_continues_turn_under_new_context", async () => {
  const service = new MockWebsocketTTSService({ reconnectAfter: null });

  const downFrames = await _speakTwoSentences(service, [
    new TTSUpdateSettingsFrame({ delta: new TTSSettings({ voice: "other-voice" }) }),
  ]);

  _assertTurnContinuedUnderNewContext(downFrames);
});

test("test_reconnect_flushes_held_partial_sample", async () => {
  const firstAudio = concat(repeat(new Uint8Array([1, 0]), 160), new Uint8Array([1]));
  const service = new MockWebsocketTTSService({ firstAudio });

  const downFrames = await _speakTwoSentences(service);

  const audio = _audioBySentence(downFrames);
  expect(concat(...audio.get(1)!.map((f) => f.audio))).toEqual(
    concat(firstAudio, new Uint8Array([0])),
  );
  expect(audio.get(2)!.every((f) => f.audio.length % 2 === 0)).toBe(true);
});

test("test_lazy_connection_keeps_the_context_it_sends_to", async () => {
  const service = new MockWebsocketTTSService({ reconnectAfter: null, connectLazily: true });

  const downFrames = await _speakTwoSentences(service);

  const audio = _audioBySentence(downFrames);
  expect(new Set(audio.keys())).toEqual(new Set([1, 2]));
  expect(audio.get(1)![0]!.contextId).toEqual(audio.get(2)![0]!.contextId);
});
