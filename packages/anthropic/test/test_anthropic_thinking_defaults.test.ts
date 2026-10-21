// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_anthropic_thinking_defaults.py

/** Tests for the lowest-thinking default and effort setting in AnthropicLLMService. */

import { expect, mock, test } from "bun:test";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LOG_LEVELS, type LogLevel, logger } from "@pipedog/core/utils/logger";
import { AnthropicLLMService } from "../src/llm.ts";

type Params = Record<string, any>;

/** Access the service's protected members, as upstream's tests do. */
function internals(service: AnthropicLLMService): any {
  return service as any;
}

/**
 * Capture log records at `level` and above, formatted with `format`, while
 * `fn` runs (loguru's `logger.add(sink, level=..., format=...)`).
 */
function _captureLog(
  level: LogLevel,
  format: (level: LogLevel, message: string) => string,
  fn: () => void,
): string {
  // loguru's sink level applies whatever the global level is.
  const previous = (Object.keys(LOG_LEVELS) as LogLevel[])
    .sort((a, b) => LOG_LEVELS[a] - LOG_LEVELS[b])
    .find((l) => logger.isEnabledFor(l));
  logger.setLevel("TRACE");
  let out = "";
  const remove = logger.addSink((record) => {
    if (LOG_LEVELS[record.level] >= LOG_LEVELS[level]) {
      out += `${format(record.level, record.message)}\n`;
    }
  });
  try {
    fn();
  } finally {
    remove();
    if (previous) logger.setLevel(previous);
  }
  return out;
}

/** Split like Python's `str.splitlines()`. */
function splitlines(s: string): string[] {
  return s === "" ? [] : s.replace(/\n$/, "").split("\n");
}

/** Return the request params after the service applies its default for a model. */
function _appliedDefault(model: string, params: Params | null = null): Params {
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({ model }),
  });
  const p = params !== null ? params : {};

  internals(service)._maybeApplyThinkingDefault(p);

  return p;
}

/** Return the thinking config the service applies for a model, if any. */
function _appliedThinking(model: string): Params | undefined {
  return _appliedDefault(model).thinking;
}

/** Return what applying the default logs, at INFO and above, for each model in turn. */
function _logLines(...models: string[]): string[] {
  const out = _captureLog(
    "INFO",
    (level, message) => `${level} ${message}`,
    () => {
      const service = new AnthropicLLMService({
        apiKey: "test-key",
        settings: new AnthropicLLMService.Settings({ model: models[0] }),
      });
      for (const model of models) {
        internals(service)._settings.model = model;
        internals(service)._maybeApplyThinkingDefault({});
        internals(service)._maybeApplyThinkingDefault({});
      }
    },
  );
  return splitlines(out);
}

/** Return the request params run_inference sends for a service. */
async function _request(
  service: AnthropicLLMService,
  options: { responseSchema?: Record<string, unknown> } = {},
): Promise<Params> {
  const create = mock(async (_params: Params, _options?: unknown) => ({ content: [] }));
  internals(service)._client = { beta: { messages: { create } } };

  await service.runInference(
    new LLMContext({ messages: [{ role: "user", content: "hi" }] }),
    options,
  );

  return create.mock.calls.at(-1)![0];
}

// --- default thinking config per model --------------------------------------

test.each([
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-5-5",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
])("test_models_that_allow_it_get_thinking_disabled[%s]", (model) => {
  // Turning thinking off is the lowest setting wherever a model allows it.
  expect(_appliedDefault(model)).toEqual({ thinking: { type: "disabled" } });
});

test("test_sonnet_5_5_gets_between_tools", () => {
  // Sonnet 5.5 rejects "disabled"; "between_tools" is its lowest setting.
  expect(_appliedDefault("claude-sonnet-5-5")).toEqual({ thinking: { type: "between_tools" } });
});

test.each(["claude-opus-5-5", "claude-fable-5-1", "claude-fable-5"])(
  "test_models_that_always_think_get_low_effort[%s]",
  (model) => {
    // Models whose thinking can't be turned off get the lowest effort instead.
    expect(_appliedDefault(model)).toEqual({ output_config: { effort: "low" } });
  },
);

test("test_low_effort_joins_a_response_schema_in_output_config", () => {
  // The effort default doesn't displace a response schema already in output_config.
  const outputFormat = { type: "json_schema", schema: { type: "object" } };
  const params: Params = { output_config: { format: outputFormat } };

  _appliedDefault("claude-opus-5-5", params);

  expect(params.output_config).toEqual({ format: outputFormat, effort: "low" });
});

test("test_every_id_form_of_a_model_is_recognized", () => {
  // Bedrock prefixes, Vertex versions and dated snapshots name the same model.
  for (const model of [
    "anthropic.claude-sonnet-5",
    "us.anthropic.claude-sonnet-5",
    "claude-sonnet-5@20260630",
    "claude-sonnet-5-20260630",
    "claude-haiku-4-5-20251001",
    "anthropic.claude-haiku-4-5-20251001-v1:0",
  ]) {
    expect(_appliedThinking(model), model).toEqual({ type: "disabled" });
  }
});

test("test_unlisted_models_run_at_anthropics_default", () => {
  // Only listed models get a thinking default, so a new model is never guessed at.
  for (const model of ["claude-sonnet-6", "claude-mythos-5", "claude-3-5-sonnet-20241022"]) {
    expect(_appliedDefault(model), model).toEqual({});
  }
});

// --- explicit configuration wins --------------------------------------------

test("test_a_configured_thinking_config_is_left_alone", async () => {
  // An explicit thinking config wins over the low-latency default.
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({
      model: "claude-sonnet-5",
      thinking: new AnthropicLLMService.ThinkingConfig({ type: "adaptive", display: "summarized" }),
    }),
  });

  const request = await _request(service);

  expect(request.thinking).toEqual({ type: "adaptive", display: "summarized" });
});

test("test_thinking_passed_through_extra_is_left_alone", async () => {
  // A thinking config in extra wins too.
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({
      model: "claude-sonnet-5",
      extra: { thinking: { type: "adaptive" } },
    }),
  });

  const request = await _request(service);

  expect(request.thinking).toEqual({ type: "adaptive" });
});

test("test_a_configured_effort_replaces_the_thinking_default", async () => {
  // Effort and thinking together decide how much the model thinks, so either one wins.
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({ model: "claude-sonnet-5", effort: "low" }),
  });

  const request = await _request(service);

  expect("thinking" in request).toBe(false);
  expect(request.output_config).toEqual({ effort: "low" });
});

test("test_effort_passed_through_extra_replaces_the_thinking_default", async () => {
  // An effort in extra wins too.
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({
      model: "claude-sonnet-5",
      extra: { output_config: { effort: "low" } },
    }),
  });

  const request = await _request(service);

  expect("thinking" in request).toBe(false);
  expect(request.output_config).toEqual({ effort: "low" });
});

// --- effort setting ------------------------------------------------------------

test("test_effort_is_omitted_when_unset", async () => {
  // Without an effort setting, only a default can add one.
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({ model: "claude-sonnet-5" }),
  });

  const request = await _request(service);

  expect("output_config" in request).toBe(false);
});

test("test_effort_and_response_schema_share_output_config", async () => {
  // A response schema doesn't displace the effort setting, nor the reverse.
  const schema = { type: "object", properties: { ok: { type: "boolean" } } };
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({ model: "claude-opus-5-5", effort: "medium" }),
  });

  const request = await _request(service, { responseSchema: schema });

  expect(request.output_config).toEqual({
    effort: "medium",
    format: { type: "json_schema", schema },
  });
});

// --- logging -------------------------------------------------------------------

test("test_the_applied_default_is_logged_once_per_model", () => {
  // The developer learns what Pipecat sent, and when to change it, once per model.
  const lines = _logLines("claude-sonnet-5", "claude-sonnet-5-20260630", "claude-opus-5-5");

  expect(lines.length).toEqual(3);
  expect(lines.every((line) => line.startsWith("INFO"))).toBe(true);
  expect(lines[0]).toContain("thinking={'type': 'disabled'} to claude-sonnet-5,");
  expect(lines[0]).toContain("multistep reasoning");
  expect(lines[0]).toContain("set `thinking` or `effort`");
  expect(lines[1]).toContain("to claude-sonnet-5-20260630,");
  expect(lines[2]).toContain("output_config={'effort': 'low'} to claude-opus-5-5,");
});

test("test_an_unlisted_claude_model_is_warned_about_once", () => {
  // A Claude model without a default may think before replying, so the developer hears.
  const lines = _logLines("claude-sonnet-6");

  expect(lines.length).toEqual(1);
  expect(lines[0]!.startsWith("WARNING")).toBe(true);
  expect(lines[0]).toContain("no thinking default for claude-sonnet-6");
});

test("test_nothing_is_logged_for_a_model_id_that_names_no_claude_model", () => {
  // A Bedrock inference profile ARN doesn't say which model it runs.
  const profile = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123";
  expect(_logLines(profile)).toEqual([]);
});

test("test_nothing_is_logged_when_reasoning_is_configured", () => {
  // An explicit setting is the developer's choice, and needs no comment.
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({ model: "claude-sonnet-6" }),
  });
  const out = _captureLog(
    "INFO",
    (_level, message) => message,
    () => {
      internals(service)._maybeApplyThinkingDefault({ thinking: { type: "adaptive" } });
      internals(service)._maybeApplyThinkingDefault({ output_config: { effort: "low" } });
    },
  );

  expect(out).toEqual("");
});

// --- use_provider_thinking_default -------------------------------------------

test("test_use_provider_thinking_default_runs_at_anthropics_default", () => {
  // The setting sends no default and logs the reason at DEBUG.
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({
      model: "claude-opus-5-5",
      useProviderThinkingDefault: true,
    }),
  });
  const params: Params = {};
  const out = _captureLog(
    "DEBUG",
    (level, message) => `${level} ${message}`,
    () => {
      internals(service)._maybeApplyThinkingDefault(params);
      internals(service)._maybeApplyThinkingDefault(params);
    },
  );
  const lines = splitlines(out);

  expect(params).toEqual({});
  expect(lines.length).toEqual(1);
  expect(lines[0]!.startsWith("DEBUG")).toBe(true);
  expect(lines[0]).toContain("use_provider_thinking_default is set, so claude-opus-5-5 runs");
});

// --- every inference path ----------------------------------------------------

test("test_run_inference_applies_the_thinking_default", async () => {
  // Out-of-band inference gets the same default as the in-pipeline path.
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({ model: "claude-sonnet-5" }),
  });

  const request = await _request(service);

  expect(request.thinking).toEqual({ type: "disabled" });
});

test("test_streaming_applies_the_thinking_default_and_effort", async () => {
  // The in-pipeline request carries the default, and the effort setting when set.
  const requests: Params[] = [];

  const fakeStream = async (_apiCall: unknown, params: Params) => {
    requests.push(params);

    async function* noEvents() {}

    return noEvents();
  };

  const dropFrame = async (_frame: unknown, _direction?: unknown) => {};

  for (const settings of [
    new AnthropicLLMService.Settings({ model: "claude-sonnet-5" }),
    new AnthropicLLMService.Settings({ model: "claude-sonnet-5-5", effort: "low" }),
  ]) {
    const service = new AnthropicLLMService({ apiKey: "test-key", settings });
    const s = internals(service);
    s.pushFrame = dropFrame;
    s.runFunctionCalls = mock(async () => {});
    s._createMessageStream = fakeStream;
    await s._processContext(new LLMContext());
  }

  expect(requests[0]!.thinking).toEqual({ type: "disabled" });
  expect("output_config" in requests[0]!).toBe(false);
  expect("thinking" in requests[1]!).toBe(false);
  expect(requests[1]!.output_config).toEqual({ effort: "low" });
});
