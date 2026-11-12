// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_tts_metadata.py

/** Tests for the metadata a TTSService broadcasts at start. */

import { expect, test } from "bun:test";

import { BaseExpressionAdapter } from "../src/adapters/tts/base_expression_adapter.ts";
import {
  DeliveryScope,
  ExpressionCapabilities,
  ExpressionTerm,
} from "../src/expressive/expression.ts";
import { type Frame, TTSMetadataFrame, TTSUpdateSettingsFrame } from "../src/frames/frames.ts";
import { PipelineParams } from "../src/pipeline/worker.ts";
import { TTSSettings } from "../src/services/settings.ts";
import { TTSService, type TTSServiceOptions } from "../src/services/tts_service.ts";
import { runTest } from "../src/tests/utils.ts";

const CAPABILITIES = new ExpressionCapabilities({
  sounds: [new ExpressionTerm({ name: "laugh", description: "Something is genuinely funny." })],
  delivery: [new ExpressionTerm({ name: "cheerful" }), new ExpressionTerm({ name: "whisper" })],
  pauseRangeMs: [100, 3000],
  emphasis: true,
  deliveryScope: DeliveryScope.SENTENCE,
});

const EXPRESSIVE = new PipelineParams({ enableExpressiveConversation: true });

class DeclaringAdapter extends BaseExpressionAdapter {
  #capabilities: ExpressionCapabilities | null;

  constructor(capabilities: ExpressionCapabilities | null) {
    super();
    this.#capabilities = capabilities;
  }

  override capabilities(): ExpressionCapabilities | null {
    return this.#capabilities;
  }
}

/** A TTS service that never speaks, declaring the given capabilities. */
class SilentTTSService extends TTSService {
  protected _declaringAdapter: DeclaringAdapter;

  constructor(capabilities: ExpressionCapabilities | null = null, options: TTSServiceOptions = {}) {
    super({ sampleRate: 16000, ...options });
    this._declaringAdapter = new DeclaringAdapter(capabilities);
  }

  override getExpressionAdapter(): BaseExpressionAdapter {
    return this._declaringAdapter;
  }

  override async *runTts(_text: string, _contextId: string): AsyncGenerator<Frame | null, void> {}
}

test("test_metadata_is_broadcast_both_ways_at_start", async () => {
  // The LLM sits upstream of the TTS, so the metadata goes both ways.
  const tts = new SilentTTSService();
  const [down, up] = await runTest(tts, {
    framesToSend: [],
    expectedDownFrames: [TTSMetadataFrame],
    expectedUpFrames: [TTSMetadataFrame],
    pipelineParams: EXPRESSIVE,
  });

  expect((down[0] as TTSMetadataFrame).serviceName).toBe(tts.name);
  expect((up[0] as TTSMetadataFrame).serviceName).toBe(tts.name);
});

test("test_a_service_declares_no_expression_by_default", async () => {
  const [down] = await runTest(new SilentTTSService(), {
    framesToSend: [],
    pipelineParams: EXPRESSIVE,
  });

  expect((down[0] as TTSMetadataFrame).expression).toBeNull();
});

test("test_a_service_broadcasts_the_expression_it_declares", async () => {
  const [down] = await runTest(new SilentTTSService(CAPABILITIES), {
    framesToSend: [],
    pipelineParams: EXPRESSIVE,
  });

  expect((down[0] as TTSMetadataFrame).expression).toEqual(CAPABILITIES);
});

test("test_nothing_is_broadcast_without_expressive_conversation", async () => {
  const [down, up] = await runTest(new SilentTTSService(CAPABILITIES), { framesToSend: [] });

  expect([...down, ...up].filter((f) => f instanceof TTSMetadataFrame)).toEqual([]);
});

/** A TTS service that performs expression only on its "expressive" model. */
class ModelTTSService extends SilentTTSService {
  override getExpressionAdapter(): BaseExpressionAdapter {
    if (this._settings.model === "expressive") {
      return this._declaringAdapter;
    }
    return new DeclaringAdapter(null);
  }
}

test("test_a_model_change_that_changes_the_expression_is_broadcast", async () => {
  const [down, up] = await runTest(new ModelTTSService(CAPABILITIES), {
    framesToSend: [new TTSUpdateSettingsFrame({ delta: new TTSSettings({ model: "expressive" }) })],
    pipelineParams: EXPRESSIVE,
  });

  const metadata = up.filter((f): f is TTSMetadataFrame => f instanceof TTSMetadataFrame);
  expect(metadata.map((f) => f.expression)).toEqual([null, CAPABILITIES]);
  expect(
    down
      .filter((f): f is TTSMetadataFrame => f instanceof TTSMetadataFrame)
      .map((f) => f.expression),
  ).toEqual([null, CAPABILITIES]);
});

test("test_a_change_that_keeps_the_expression_is_not_broadcast", async () => {
  const [, up] = await runTest(new ModelTTSService(CAPABILITIES), {
    framesToSend: [new TTSUpdateSettingsFrame({ delta: new TTSSettings({ model: "plain" }) })],
    pipelineParams: EXPRESSIVE,
  });

  expect(up.filter((f) => f instanceof TTSMetadataFrame).length).toBe(1);
});
