// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_google_thinking_defaults.py

/** Tests for the lowest-thinking defaults in GoogleLLMService. */

import { expect, spyOn, test } from "bun:test";

import { ThinkingLevel } from "@google/genai";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LOG_LEVELS, type LogLevel, logger } from "@pipedog/core/utils/logger";

import { GoogleLLMService } from "../src/llm.ts";
import { GoogleVertexLLMService } from "../src/vertex/llm.ts";

// Access to protected members (`_buildGenerationParams`, `_settings`, `_client`,
// `_updateSettings`, `_location`), as upstream does.
type Internals = any;

/**
 * Collect log output at `level` and above while calling `build`, one line per
 * record, formatted as loguru's `format` would (`{level}` and `{message}`).
 */
function _captureLogs(level: LogLevel, withLevel: boolean, build: () => void): string {
  const lines: string[] = [];
  const remove = logger.addSink((record) => {
    if (LOG_LEVELS[record.level] >= LOG_LEVELS[level]) {
      lines.push(withLevel ? `${record.level} ${record.message}` : record.message);
    }
  });
  try {
    build();
  } finally {
    remove();
  }
  return lines.map((line) => `${line}\n`).join("");
}

function _splitlines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

/** Return the thinking config the service applies for a model, if any. */
function _appliedThinkingConfig(model: string): Record<string, unknown> | null {
  const service: Internals = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({ model }),
  });

  const params = service._buildGenerationParams();

  return params.thinking_config ?? null;
}

/** Return the WARNING-level log output produced while calling build. */
function _warningsFrom(build: () => unknown): string {
  return _captureLogs("WARNING", false, () => {
    build();
  });
}

/** Return what building params logs, at INFO and above, for each model in turn. */
function _logLines(...models: string[]): string[] {
  const service: Internals = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({ model: models[0] }),
  });
  const output = _captureLogs("INFO", true, () => {
    for (const model of models) {
      service._settings.model = model;
      service._buildGenerationParams();
      service._buildGenerationParams();
    }
  });
  return _splitlines(output);
}

// --- default thinking config per model --------------------------------------

test("test_gemini_25_flash_disables_thinking_with_a_budget", () => {
  // The 2.5 series takes a budget, and zero turns thinking off.
  expect(_appliedThinkingConfig("gemini-2.5-flash")).toEqual({ thinking_budget: 0 });
  expect(_appliedThinkingConfig("gemini-2.5-flash-lite")).toEqual({ thinking_budget: 0 });
});

test("test_gemini_25_pro_gets_its_minimum_budget", () => {
  // 2.5 Pro can't turn thinking off, and 128 tokens is the least it accepts.
  expect(_appliedThinkingConfig("gemini-2.5-pro")).toEqual({ thinking_budget: 128 });
});

test.each(["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemma-4-31b-it"])(
  "test_models_that_accept_it_use_the_minimal_level[%s]",
  (model) => {
    // Gemini 3 and Gemma 4 models take a level, and minimal is the lowest.
    expect(_appliedThinkingConfig(model)).toEqual({ thinking_level: "minimal" });
  },
);

test("test_gemini_31_pro_uses_the_lowest_level_it_accepts", () => {
  // 3.1 Pro doesn't support minimal, so it gets low instead.
  expect(_appliedThinkingConfig("gemini-3.1-pro-preview")).toEqual({ thinking_level: "low" });
});

test("test_gemini_37_flash_uses_the_lowest_level_it_accepts", () => {
  // 3.7 Flash rejects minimal outright, so it gets low instead.
  expect(_appliedThinkingConfig("gemini-3.7-flash")).toEqual({ thinking_level: "low" });
});

test("test_gemini_38_flash_uses_the_lowest_level_it_accepts", () => {
  // 3.8 Flash rejects minimal outright, so it gets low instead.
  expect(_appliedThinkingConfig("gemini-3.8-flash")).toEqual({ thinking_level: "low" });
});

test("test_gemini_4_argon_uses_the_lowest_level_it_accepts", () => {
  // 4 Argon rejects minimal outright, so it gets low instead.
  expect(_appliedThinkingConfig("gemini-4-argon")).toEqual({ thinking_level: "low" });
});

test("test_every_id_form_of_a_listed_model_is_recognized", () => {
  // Resource paths and version suffixes name the same model.
  expect(_appliedThinkingConfig("models/gemini-3.6-flash")).toEqual({
    thinking_level: "minimal",
  });
  expect(_appliedThinkingConfig("publishers/google/models/gemini-3.6-flash")).toEqual({
    thinking_level: "minimal",
  });
  expect(_appliedThinkingConfig("gemini-2.5-flash-001")).toEqual({ thinking_budget: 0 });
});

test("test_unlisted_models_run_at_googles_default", () => {
  // Only listed models get a thinking default, so a new model is never guessed at.
  for (const model of ["gemini-3.9-flash", "gemini-flash-latest", "gemini-3.1-flash-image"]) {
    expect(_appliedThinkingConfig(model), model).toBeNull();
  }
});

test("test_thinking_config_in_extra_is_left_alone", () => {
  // A thinking config passed through extra wins too.
  const service: Internals = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({
      model: "gemini-3.6-flash",
      extra: { thinking_config: { thinking_level: "high" } },
    }),
  });

  const params = service._buildGenerationParams();

  expect(params.thinking_config).toEqual({ thinking_level: "high" });
});

test("test_the_applied_default_is_logged_once_per_model", () => {
  // The developer learns what Pipecat sent, and when to change it, once per model.
  const lines = _logLines("gemini-3.6-flash", "gemini-3.8-flash");

  expect(lines.length).toBe(2);
  expect(lines.every((line) => line.startsWith("INFO"))).toBe(true);
  expect(lines[0]).toContain("thinking_config={'thinking_level': 'minimal'} to gemini-3.6-flash,");
  expect(lines[0]).toContain("multistep reasoning");
  expect(lines[0]).toContain("set `thinking` in GoogleLLMService.Settings");
  expect(lines[1]).toContain("to gemini-3.8-flash,");
});

test.each(["gemini-3.9-flash", "gemini-flash-latest", "gemma-4-e4b-it"])(
  "test_an_unlisted_model_that_can_think_is_warned_about_once[%s]",
  (model) => {
    // A model without a default may think before replying, so the developer hears.
    const lines = _logLines(model);

    expect(lines.length).toBe(1);
    expect(lines[0]?.startsWith("WARNING")).toBe(true);
    expect(lines[0]).toContain(`no thinking default for ${model}`);
  },
);

test.each(["gemini-2.0-flash", "gemini-3.1-flash-image"])(
  "test_nothing_is_logged_for_a_model_that_cant_think[%s]",
  (model) => {
    // Models without thinking have no latency to recover.
    expect(_logLines(model)).toEqual([]);
  },
);

test("test_nothing_is_logged_when_thinking_is_configured", () => {
  // An explicit setting is the developer's choice, and needs no comment.
  const service: Internals = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({
      model: "gemini-3.9-flash",
      thinking: new GoogleLLMService.ThinkingConfig({ thinkingLevel: "low" }),
    }),
  });
  const output = _captureLogs("INFO", false, () => {
    service._buildGenerationParams();
  });

  expect(output).toBe("");
});

test("test_a_configured_thinking_config_is_left_alone", () => {
  // An explicit thinking config wins over the low-latency default.
  const service: Internals = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({
      model: "gemini-3.7-flash",
      thinking: new GoogleLLMService.ThinkingConfig({ thinkingLevel: "high" }),
    }),
  });

  const params = service._buildGenerationParams();

  expect(params.thinking_config).toEqual({ thinking_level: "high" });
});

// --- every inference path ----------------------------------------------------

test("test_run_inference_applies_the_thinking_default", async () => {
  // Out-of-band inference gets the same default as the in-pipeline path.
  const service: Internals = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({
      model: "gemini-3.6-flash",
      systemInstruction: "You are helpful.",
    }),
  });
  const response = { candidates: [] };

  const generate = spyOn(service._client.models, "generateContent").mockResolvedValue(
    response as never,
  );
  let callArgs: Internals;
  try {
    await service.runInference(new LLMContext({ messages: [{ role: "user", content: "hi" }] }));
    callArgs = generate.mock.calls.at(-1)?.[0];
  } finally {
    generate.mockRestore();
  }

  const config = callArgs.config;
  expect(config.thinkingConfig.thinkingLevel).toBe(ThinkingLevel.MINIMAL);
});

// --- warning on a budget that may not control thinking ----------------------

test("test_thinking_budget_on_a_gemini_3_model_warns", () => {
  // Gemini 3 takes a level, so a budget set on one may not apply.
  const output = _warningsFrom(
    () =>
      new GoogleLLMService({
        apiKey: "test-key",
        settings: new GoogleLLMService.Settings({
          model: "gemini-3.6-flash",
          thinking: new GoogleLLMService.ThinkingConfig({ thinkingBudget: 0 }),
        }),
      }),
  );

  expect(output).toContain("thinking_budget");
  expect(output).toContain("gemini-3.6-flash");
  expect(output).toContain("thinking_level");
});

test("test_thinking_budget_on_a_gemma_4_model_warns", () => {
  // Gemma 4 takes a level too.
  const output = _warningsFrom(
    () =>
      new GoogleLLMService({
        apiKey: "test-key",
        settings: new GoogleLLMService.Settings({
          model: "models/gemma-4-31b-it",
          thinking: new GoogleLLMService.ThinkingConfig({ thinkingBudget: 0 }),
        }),
      }),
  );

  expect(output).toContain("thinking_budget");
});

test("test_thinking_budget_on_a_gemini_4_model_warns", () => {
  // Gemini 4 takes a level, and rejects a budget.
  const output = _warningsFrom(
    () =>
      new GoogleLLMService({
        apiKey: "test-key",
        settings: new GoogleLLMService.Settings({
          model: "gemini-4-argon",
          thinking: new GoogleLLMService.ThinkingConfig({ thinkingBudget: 0 }),
        }),
      }),
  );

  expect(output).toContain("thinking_budget");
});

test("test_thinking_budget_on_a_gemini_25_model_does_not_warn", () => {
  // The 2.5 series honors a budget, so there is nothing to warn about.
  const output = _warningsFrom(
    () =>
      new GoogleLLMService({
        apiKey: "test-key",
        settings: new GoogleLLMService.Settings({
          model: "gemini-2.5-flash",
          thinking: new GoogleLLMService.ThinkingConfig({ thinkingBudget: 0 }),
        }),
      }),
  );

  expect(output).not.toContain("thinking_budget");
});

test("test_thinking_level_on_a_gemini_3_model_does_not_warn", () => {
  // A level is the right control for Gemini 3.
  const output = _warningsFrom(
    () =>
      new GoogleLLMService({
        apiKey: "test-key",
        settings: new GoogleLLMService.Settings({
          model: "gemini-3.6-flash",
          thinking: new GoogleLLMService.ThinkingConfig({ thinkingLevel: "low" }),
        }),
      }),
  );

  expect(output).not.toContain("thinking_budget");
});

test("test_switching_to_a_gemini_3_model_at_runtime_warns", async () => {
  // Changing the model re-checks the thinking configuration against it.
  const service: Internals = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({
      model: "gemini-2.5-flash",
      thinking: new GoogleLLMService.ThinkingConfig({ thinkingBudget: 0 }),
    }),
  });

  const lines: string[] = [];
  const remove = logger.addSink((record) => {
    if (LOG_LEVELS[record.level] >= LOG_LEVELS.WARNING) {
      lines.push(record.message);
    }
  });
  try {
    await service._updateSettings(new GoogleLLMService.Settings({ model: "gemini-3.6-flash" }));
  } finally {
    remove();
  }

  expect(lines.join("\n")).toContain("thinking_budget");
});

// --- Vertex defaults --------------------------------------------------

function _vertexService(options: Record<string, unknown> = {}): Internals {
  const getCredentials = spyOn(GoogleVertexLLMService, "_getCredentials").mockReturnValue(
    null as never,
  );
  const createClient = spyOn(GoogleVertexLLMService.prototype, "createClient").mockImplementation(
    () => {},
  );
  try {
    return new GoogleVertexLLMService({ projectId: "test-project", ...options });
  } finally {
    getCredentials.mockRestore();
    createClient.mockRestore();
  }
}

test("test_vertex_defaults_to_gemini_3_on_the_global_endpoint", () => {
  // Vertex serves the Gemini 3 series only from global, so both defaults pair.
  const service = _vertexService();

  expect(service._settings.model).toBe("gemini-3.8-flash");
  expect(service._location).toBe("global");
});

test("test_vertex_shares_the_thinking_defaults", () => {
  // The Vertex service picks its thinking default from the same per-model table.
  const service = _vertexService({
    settings: new GoogleVertexLLMService.Settings({ model: "gemini-3.7-flash" }),
  });

  const params = service._buildGenerationParams();

  expect(params.thinking_config).toEqual({ thinking_level: "low" });
});

test("test_vertex_warns_on_a_thinking_budget_for_gemini_3", () => {
  // The warning covers the Vertex service too.
  const output = _warningsFrom(() =>
    _vertexService({
      settings: new GoogleVertexLLMService.Settings({
        model: "gemini-3.6-flash",
        thinking: new GoogleVertexLLMService.ThinkingConfig({ thinkingBudget: 0 }),
      }),
    }),
  );

  expect(output).toContain("thinking_budget");
});

// --- use_provider_thinking_default -------------------------------------------

test("test_use_provider_thinking_default_runs_at_googles_default", () => {
  // The setting sends no default and logs the reason at DEBUG.
  const service: Internals = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({
      model: "gemini-3.6-flash",
      useProviderThinkingDefault: true,
    }),
  });
  let params: Record<string, unknown> = {};
  const output = _captureLogs("DEBUG", true, () => {
    params = service._buildGenerationParams();
    service._buildGenerationParams();
  });
  const lines = _splitlines(output);

  expect("thinking_config" in params).toBe(false);
  expect(lines.length).toBe(1);
  expect(lines[0]?.startsWith("DEBUG")).toBe(true);
  expect(lines[0]).toContain("use_provider_thinking_default is set, so gemini-3.6-flash runs");
});
