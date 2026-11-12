// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_minimax_tts_expression.py

/** Tests for MiniMax TTS in expressive conversation. */

import { describe, expect, test } from "bun:test";
import { BaseExpressionAdapter } from "@pipedog/core/adapters/tts/base_expression_adapter";
import {
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
} from "@pipedog/core/frames/frames";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import { runTest } from "@pipedog/core/tests/utils";
import { MiniMaxExpressionAdapter } from "../src/minimax_adapter.ts";
import { MiniMaxHttpTTSService, type MiniMaxTTSSettingsOptions } from "../src/tts.ts";

type Dict = Record<string, any>;

/**
 * Records each request's payload and answers it with a failing response, so a
 * request is recorded without audio. Upstream: `_RecordingSession` (an aiohttp
 * session) returning `_RejectingResponse` (status 400).
 */
class _RecordingSession {
  payloads: Dict[] = [];

  fetch: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
    this.payloads.push(JSON.parse(String(init?.body)) as Dict);
    return new Response(null, { status: 400 });
  }) as typeof fetch;
}

function _service(
  session: _RecordingSession,
  settings: MiniMaxTTSSettingsOptions = {},
): MiniMaxHttpTTSService {
  return new MiniMaxHttpTTSService({
    apiKey: "key",
    groupId: "group",
    fetch: session.fetch,
    settings: new MiniMaxHttpTTSService.Settings(settings),
  });
}

describe("TestMiniMaxExpressionAdapter", () => {
  test("test_sounds_and_pauses", () => {
    const adapter = new MiniMaxExpressionAdapter();
    expect(adapter.formatSound("laughs")).toBe("(laughs)");
    expect(adapter.formatPause(600)).toBe("<#0.6#>");
    expect(adapter.formatText("Hi.", ["happy"], null)).toBe("Hi.");
  });

  test("test_vocabulary_is_fixed", () => {
    // MiniMax reads an interjection outside its list aloud.
    const capabilities = new MiniMaxExpressionAdapter().capabilities();
    expect(capabilities.allowsFreeText).toBeFalsy();
  });
});

test.each([
  ["speech-2.8-turbo", MiniMaxExpressionAdapter],
  ["speech-2.8-hd", MiniMaxExpressionAdapter],
  ["speech-2.6-turbo", BaseExpressionAdapter],
] as const)("test_expression_adapter_follows_the_model[%s]", (model, adapter) => {
  const service = _service(new _RecordingSession(), { model });
  expect(service.getExpressionAdapter().constructor).toBe(adapter);
});

test("test_each_request_sends_the_emotion_of_its_delivery", async () => {
  const session = new _RecordingSession();
  await runTest(_service(session, { emotion: "calm" }), {
    framesToSend: [
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({
        text: "<<happy>> Great news. [[laughs]] It's back. <<neutral>> Anything else?",
      }),
      new LLMFullResponseEndFrame(),
    ],
    pipelineParams: new PipelineParams({ enableExpressiveConversation: true }),
  });

  // The baseline is the configured emotion.
  expect(session.payloads.map((p) => [p.text, p.voice_setting.emotion])).toEqual([
    ["Great news.", "happy"],
    ["(laughs)It's back.", "happy"],
    ["Anything else?", "calm"],
  ]);
});

test("test_each_request_sends_the_speed_of_its_delivery", async () => {
  const session = new _RecordingSession();
  await runTest(_service(session, { emotion: "calm", speed: 1.0 }), {
    framesToSend: [
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "<<calm>> It's <<slow: A B 7 4>>. Anything else?" }),
      new LLMFullResponseEndFrame(),
    ],
    pipelineParams: new PipelineParams({ enableExpressiveConversation: true }),
  });

  expect(
    session.payloads.map((p) => [p.text, p.voice_setting.emotion, p.voice_setting.speed]),
  ).toEqual([
    ["It's A B 7 4.", "calm", 0.75],
    ["Anything else?", "calm", 1.0],
  ]);
});
