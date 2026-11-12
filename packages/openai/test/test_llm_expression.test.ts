// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_llm_expression.py

/**
 * Tests for the expression an LLM service is taught by the TTS service it feeds.
 *
 * Porting notes:
 * - loguru's `logger.add(sink, level="WARNING")` becomes `logger.addSink`,
 *   keeping records at WARNING or above.
 * - `llm._settings` is protected in TS; it is read through `llm.settings`.
 */

import { expect, test } from "bun:test";
import {
  ExpressionCapabilities,
  ExpressionSound,
  ExpressionTerm,
} from "@pipedog/core/expressive/expression";
import { expressionInstructions } from "@pipedog/core/expressive/instructions";
import { PerceptionCapabilities, PerceptionTerm } from "@pipedog/core/expressive/perception";
import { ExpressionGuidance, ExpressionPolicy } from "@pipedog/core/expressive/policy";
import {
  ExpressionMetadataFrame,
  type Frame,
  PerceptionMetadataFrame,
  TTSMetadataFrame,
} from "@pipedog/core/frames/frames";
import type { BasePipeline } from "@pipedog/core/pipeline/base_pipeline";
import { LLMSwitcher } from "@pipedog/core/pipeline/llm_switcher";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { runTest } from "@pipedog/core/tests/utils";
import { LOG_LEVELS, logger } from "@pipedog/core/utils/logger";
import { OpenAILLMService } from "../src/llm.ts";

const EXPRESSIVE = new PipelineParams({ enableExpressiveConversation: true });

const CALM_HAPPY = new ExpressionCapabilities({
  delivery: [new ExpressionTerm({ name: "calm" }), new ExpressionTerm({ name: "happy" })],
  pauseRangeMs: [100, 3000],
});
const LAUGHTER = new ExpressionCapabilities({
  sounds: [new ExpressionTerm({ name: "laughter" })],
  serviceVocabulary: { [ExpressionSound.LAUGH]: ["laughter"] },
});

function _llm(name: string | null = null): OpenAILLMService {
  return new OpenAILLMService({
    apiKey: "test",
    name,
    settings: new OpenAILLMService.Settings({ systemInstruction: "APP" }),
  });
}

function _systemInstruction(llm: OpenAILLMService): unknown {
  return (llm.settings as unknown as { systemInstruction: unknown }).systemInstruction;
}

function _expressive(policy: ExpressionPolicy): PipelineParams {
  return new PipelineParams({ enableExpressiveConversation: true, expressionPolicy: policy });
}

function _metadata(expression: ExpressionCapabilities | null): TTSMetadataFrame {
  return new TTSMetadataFrame({ serviceName: "tts", expression });
}

/** Send frames up to the LLM, as a TTS service downstream of it would. */
async function _sendUp(
  llm: OpenAILLMService,
  frames: Frame[],
  params: PipelineParams | null = EXPRESSIVE,
): Promise<Frame[]> {
  const [, up] = await runTest(llm, {
    framesToSend: frames,
    framesToSendDirection: FrameDirection.UPSTREAM,
    pipelineParams: params,
  });
  return up;
}

/** loguru's `logger.add(sink, level="WARNING")` for the duration of `fn`. */
async function _collectWarnings(fn: () => unknown): Promise<string[]> {
  const warnings: string[] = [];
  const remove = logger.addSink((record) => {
    if (LOG_LEVELS[record.level] >= LOG_LEVELS.WARNING) {
      warnings.push(record.message);
    }
  });
  try {
    await fn();
  } finally {
    remove();
  }
  return warnings;
}

test("test_the_tts_expression_is_taught_after_the_prompt", async () => {
  const llm = _llm();

  const up = await _sendUp(llm, [_metadata(CALM_HAPPY)]);

  expect(_systemInstruction(llm)).toBe(`APP\n\n${expressionInstructions(CALM_HAPPY)}`);
  expect(up.filter((f) => f instanceof TTSMetadataFrame).length).toBeGreaterThan(0);
});

test("test_nothing_is_taught_without_expressive_conversation", async () => {
  const llm = _llm();

  await _sendUp(llm, [_metadata(CALM_HAPPY)], null);

  expect(_systemInstruction(llm)).toBe("APP");
});

test("test_the_latest_tts_replaces_what_is_taught", async () => {
  const llm = _llm();

  await _sendUp(llm, [_metadata(CALM_HAPPY), _metadata(LAUGHTER)]);

  expect(_systemInstruction(llm)).toBe(`APP\n\n${expressionInstructions(LAUGHTER)}`);
});

test("test_a_tts_that_performs_nothing_is_taught_nothing", async () => {
  const llm = _llm();

  await _sendUp(llm, [_metadata(CALM_HAPPY), _metadata(null)]);

  expect(_systemInstruction(llm)).toBe("APP");
});

test("test_the_policy_shapes_what_is_taught", async () => {
  const policy = new ExpressionPolicy({
    guidance: [ExpressionGuidance.MATCH_STYLE],
    delivery: ["calm"],
  });
  const llm = _llm();

  await _sendUp(llm, [_metadata(CALM_HAPPY)], _expressive(policy));

  expect(_systemInstruction(llm)).toBe(`APP\n\n${expressionInstructions(CALM_HAPPY, policy)}`);
});

test("test_every_llm_in_a_switcher_is_taught_the_policy", async () => {
  const policy = new ExpressionPolicy({ guidance: [ExpressionGuidance.MATCH_STYLE] });
  const [first, second] = [_llm("first"), _llm("second")];

  // Sent up as the TTS service after the switcher would, while the first is active.
  await runTest(new LLMSwitcher([first, second]), {
    framesToSend: [_metadata(CALM_HAPPY)],
    framesToSendDirection: FrameDirection.UPSTREAM,
    pipelineParams: _expressive(policy),
  });

  const taught = `APP\n\n${expressionInstructions(CALM_HAPPY, policy)}`;
  expect(_systemInstruction(first)).toBe(taught);
  expect(_systemInstruction(second)).toBe(taught);
});

async function _policyWarnings(
  policy: ExpressionPolicy,
  ...metadata: TTSMetadataFrame[]
): Promise<string[]> {
  const warnings = await _collectWarnings(() => _sendUp(_llm(), metadata, _expressive(policy)));
  return warnings.filter((w) => w.includes("expression policy"));
}

test("test_policy_tags_the_tts_cant_perform_are_warned_about", async () => {
  const policy = new ExpressionPolicy({
    delivery: ["neutral", "calm", "relieved"],
    sounds: ["sighs"],
  });

  const warnings = await _policyWarnings(policy, _metadata(CALM_HAPPY));

  // Every service returns to its baseline, so neutral is never left out.
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("can't perform <<relieved>>, [[sighs]] from the expression policy");
});

test("test_a_policy_the_tts_performs_none_of_is_warned_about", async () => {
  const policy = new ExpressionPolicy({
    guidance: [ExpressionGuidance.MATCH_STYLE],
    sounds: ["sighs"],
  });

  const warnings = await _policyWarnings(policy, _metadata(null));

  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("performs none of the expression policy's tags");
});

test("test_a_policy_warning_is_given_once_until_it_changes", async () => {
  const policy = new ExpressionPolicy({ delivery: ["calm", "relieved"] });

  const warnings = await _policyWarnings(
    policy,
    _metadata(CALM_HAPPY),
    _metadata(CALM_HAPPY),
    _metadata(LAUGHTER),
  );

  expect(warnings.length).toBe(2);
  expect(warnings[0]).toContain("can't perform <<relieved>> from");
  expect(warnings[1]).toContain("can't perform <<calm>>, <<relieved>> from");
});

test("test_a_policy_without_expressive_conversation_is_warned_about", async () => {
  const warnings = await _collectWarnings(() => {
    // Upstream passes the LLM itself as the pipeline.
    new PipelineWorker(_llm() as unknown as BasePipeline, {
      params: new PipelineParams({ expressionPolicy: new ExpressionPolicy() }),
    });
  });

  // The option is named `expressionPolicy` in TS, and so is the warning.
  expect(warnings.some((w) => w.includes("expressionPolicy has no effect"))).toBe(true);
});

const TONE = new PerceptionCapabilities({
  signals: [new PerceptionTerm({ name: "tone", labels: ["positive", "neutral", "frustrated"] })],
});

test("test_the_perception_upstream_is_taught_with_the_tts_expression", async () => {
  const llm = _llm();

  await runTest(llm, {
    framesToSend: [new PerceptionMetadataFrame({ serviceName: "tone", perception: TONE })],
    pipelineParams: EXPRESSIVE,
  });
  await _sendUp(llm, [_metadata(CALM_HAPPY)]);

  expect(_systemInstruction(llm)).toBe(
    `APP\n\n${expressionInstructions(CALM_HAPPY, null, { perception: TONE })}`,
  );
});

test("test_perception_without_tts_expression_is_taught_without_presets_or_warnings", async () => {
  const llm = _llm();
  const policy = new ExpressionPolicy({
    guidance: [ExpressionGuidance.MATCH_STYLE, "Apologize once."],
    sounds: ["sighs"],
  });
  const warnings = await _collectWarnings(() =>
    runTest(llm, {
      framesToSend: [new PerceptionMetadataFrame({ serviceName: "tone", perception: TONE })],
      pipelineParams: _expressive(policy),
    }),
  );

  expect(_systemInstruction(llm)).toBe(
    `APP\n\n${expressionInstructions(null, null, { perception: TONE })}\n\nApologize once.`,
  );
  expect(warnings.filter((w) => w.includes("expression policy"))).toEqual([]);
});

test("test_perception_is_not_taught_without_expressive_conversation", async () => {
  const llm = _llm();

  await runTest(llm, {
    framesToSend: [new PerceptionMetadataFrame({ serviceName: "tone", perception: TONE })],
  });

  expect(_systemInstruction(llm)).toBe("APP");
});

test("test_every_llm_in_a_switcher_is_taught_the_perception", async () => {
  const [first, second] = [_llm("first"), _llm("second")];

  // Sent down as a perception producer before the switcher would, while the first is active.
  await runTest(new LLMSwitcher([first, second]), {
    framesToSend: [new PerceptionMetadataFrame({ serviceName: "tone", perception: TONE })],
    pipelineParams: EXPRESSIVE,
  });

  const taught = `APP\n\n${expressionInstructions(null, null, { perception: TONE })}`;
  expect(_systemInstruction(first)).toBe(taught);
  expect(_systemInstruction(second)).toBe(taught);
});

const TAGGER = new ExpressionMetadataFrame({ serviceName: "tagger" });

test("test_a_tagger_after_the_llm_leaves_it_taught_no_tags", async () => {
  const policy = new ExpressionPolicy({
    guidance: [ExpressionGuidance.MATCH_STYLE, "Apologize once."],
    sounds: ["sighs"],
  });
  const llm = _llm();
  let up: Frame[] = [];
  const warnings = await _collectWarnings(async () => {
    await runTest(llm, {
      framesToSend: [new PerceptionMetadataFrame({ serviceName: "tone", perception: TONE })],
      pipelineParams: _expressive(policy),
    });
    up = await _sendUp(llm, [TAGGER, _metadata(CALM_HAPPY)], _expressive(policy));
  });

  // The tagger follows the policy's presets; the LLM keeps the developer's own lines.
  expect(_systemInstruction(llm)).toBe(
    `APP\n\n${expressionInstructions(null, null, { perception: TONE })}\n\nApologize once.`,
  );
  expect(warnings.filter((w) => w.includes("expression policy"))).toEqual([]);
  expect(up.filter((f) => f instanceof ExpressionMetadataFrame).length).toBeGreaterThan(0);
});

test("test_a_tagger_announced_after_the_tts_unteaches_its_tags", async () => {
  const llm = _llm();

  await _sendUp(llm, [_metadata(CALM_HAPPY), TAGGER]);

  expect(_systemInstruction(llm)).toBe("APP");
});

test("test_an_llm_before_a_tagger_without_a_reading_is_given_no_guidance", async () => {
  const policy = new ExpressionPolicy({
    guidance: [ExpressionGuidance.MATCH_STYLE, "Apologize once."],
  });
  const llm = _llm();

  await _sendUp(llm, [TAGGER, _metadata(CALM_HAPPY)], _expressive(policy));

  // With no tags to write and no reading to act on, the LLM has no part to play.
  expect(_systemInstruction(llm)).toBe("APP");
});

test("test_every_llm_in_a_switcher_learns_of_the_tagger", async () => {
  const [first, second] = [_llm("first"), _llm("second")];

  // Sent up as a tagger and TTS service after the switcher would, while the first is active.
  await runTest(new LLMSwitcher([first, second]), {
    framesToSend: [TAGGER, _metadata(CALM_HAPPY)],
    framesToSendDirection: FrameDirection.UPSTREAM,
    pipelineParams: EXPRESSIVE,
  });

  expect(_systemInstruction(first)).toBe("APP");
  expect(_systemInstruction(second)).toBe("APP");
});
