// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_assemblyai_stt.py

/**
 * Tests for the AssemblyAI streaming STT service connection parameters.
 *
 * Porting notes:
 * - `monkeypatch.setattr(service, "_connect", fake)` and
 *   `service._send_update_configuration = fake` become assigning the
 *   instance property.
 * - `frame_processor_setup` (tests/frame_processor_helpers.py) is ported locally.
 * - loguru's `logger.add(sink, level="WARNING")` becomes `logger.addSink`.
 * - `_send_update_configuration(**fields)` takes the fields as one dict.
 * - `test_deprecated_connection_params_default_to_universal_3_6_pro` exercises
 *   `AssemblyAIConnectionParams`, deprecated upstream and not ported: skipped.
 */

import { describe, expect, test } from "bun:test";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import { ProposedUserStartedSpeakingFrame } from "@pipedog/core/frames/frames";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "@pipedog/core/processors/frame_processor";
import { Language } from "@pipedog/core/transcriptions/language";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { type BaseTaskManager, TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { LOG_LEVELS, type LogLevel, logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { TerminationMessage } from "../src/models.ts";
import { AssemblyAISTTService, isU3ProModel } from "../src/stt.ts";

type Dict = Record<string, any>;

/** Local port of upstream tests/frame_processor_helpers.py `frame_processor_setup`. */
function frameProcessorSetup(
  taskManager: BaseTaskManager,
  options: Partial<FrameProcessorSetupOptions> = {},
): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    ...options,
    taskManager,
  });
}

/** Build the WebSocket URL and return its parsed query parameters. */
function _query(service: AssemblyAISTTService): Record<string, string[]> {
  const params = new URL(service._buildWsUrl()).searchParams;
  const out: Record<string, string[]> = {};
  for (const key of new Set(params.keys())) {
    out[key] = params.getAll(key);
  }
  return out;
}

/** Set the service up with the given input sample rate, without connecting. */
async function _setupService(service: AssemblyAISTTService, sampleRate: number): Promise<void> {
  (service as any)._connect = async () => {};
  await service.setup(frameProcessorSetup(new TaskManager(), { audioInSampleRate: sampleRate }));
}

/** Capture WARNING-and-above log messages while `fn` runs. */
async function captureWarnings(fn: () => unknown): Promise<string> {
  const previous = (Object.keys(LOG_LEVELS) as LogLevel[])
    .sort((a, b) => LOG_LEVELS[a] - LOG_LEVELS[b])
    .find((l) => logger.isEnabledFor(l));
  logger.setLevel("TRACE");
  let out = "";
  const remove = logger.addSink((record) => {
    if (LOG_LEVELS[record.level] >= LOG_LEVELS.WARNING) out += `${record.message}\n`;
  });
  try {
    await fn();
  } finally {
    remove();
    if (previous) logger.setLevel(previous);
  }
  return out;
}

/** Replace `_sendUpdateConfiguration` with a recorder. */
function _recordSends(service: AssemblyAISTTService): Dict[] {
  const sent: Dict[] = [];
  (service as any)._sendUpdateConfiguration = async (fields: Dict) => {
    sent.push(fields);
  };
  return sent;
}

const Settings = AssemblyAISTTService.Settings;

test("test_sample_rate_inherits_setup_when_omitted", async () => {
  const service = new AssemblyAISTTService({ apiKey: "test-key" });

  await _setupService(service, 8000);

  expect(service.sampleRate).toBe(8000);
  expect(_query(service).sample_rate).toEqual(["8000"]);
});

test("test_explicit_sample_rate_overrides_setup", async () => {
  const service = new AssemblyAISTTService({ apiKey: "test-key", sampleRate: 16000 });

  await _setupService(service, 8000);

  expect(service.sampleRate).toBe(16000);
  expect(_query(service).sample_rate).toEqual(["16000"]);
});

test("test_default_model_is_universal_3_6_pro", () => {
  // universal-3-6-pro is the default model sent to AssemblyAI.
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  expect(_query(service).speech_model).toEqual(["universal-3-6-pro"]);
});

test.skip("test_deprecated_connection_params_default_to_universal_3_6_pro", () => {
  // Skipped: tests `AssemblyAIConnectionParams` / `connection_params`, deprecated upstream
  // (since 0.0.105) and not ported.
});

test("test_continuous_partials_defaults_to_true_for_u3_pro", () => {
  // universal-3-6-pro is the default U3 Pro model; continuous_partials should be on by default.
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  expect(_query(service).continuous_partials).toEqual(["true"]);
});

test("test_continuous_partials_can_be_disabled", () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ continuousPartials: false }),
  });
  expect(_query(service).continuous_partials).toEqual(["false"]);
});

test("test_continuous_partials_omitted_for_universal_streaming", () => {
  // continuous_partials is a U3Pro-only parameter and must not be sent otherwise.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "universal-streaming-english" }),
  });
  expect("continuous_partials" in _query(service)).toBe(false);
});

test("test_interruption_delay_omitted_by_default", () => {
  // Unset means "use the server default": the param should not be sent.
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  expect("interruption_delay" in _query(service)).toBe(false);
});

test("test_interruption_delay_sent_for_u3_rt_pro", () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ interruptionDelay: 300 }),
  });
  expect(_query(service).interruption_delay).toEqual(["300"]);
});

test("test_interruption_delay_omitted_for_universal_streaming", () => {
  // interruption_delay is a U3Pro-only parameter.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "universal-streaming-english", interruptionDelay: 300 }),
  });
  expect("interruption_delay" in _query(service)).toBe(false);
});

describe("test_interruption_delay_boundaries_allowed", () => {
  for (const value of [0, 1000]) {
    test(`[${value}]`, () => {
      const service = new AssemblyAISTTService({
        apiKey: "test-key",
        settings: new Settings({ interruptionDelay: value }),
      });
      expect(_query(service).interruption_delay).toEqual([String(value)]);
    });
  }
});

describe("test_interruption_delay_out_of_range_raises", () => {
  for (const value of [-1, 1001]) {
    test(`[${value}]`, () => {
      expect(
        () =>
          new AssemblyAISTTService({
            apiKey: "test-key",
            settings: new Settings({ interruptionDelay: value }),
          }),
      ).toThrow();
    });
  }
});

// --- u3-rt-pro family detection ---

describe("test_is_u3_pro_model", () => {
  const cases: [string | null, boolean][] = [
    ["u3-rt-pro", true],
    ["u3-rt-pro-beta-1", true],
    ["universal-3-5-pro", true],
    ["universal-3-6-pro", true],
    ["universal-streaming-english", false],
    ["universal-streaming-multilingual", false],
    [null, false],
  ];
  for (const [model, expected] of cases) {
    test(`[${model}-${expected}]`, () => {
      expect(isU3ProModel(model)).toBe(expected);
    });
  }
});

test("test_u3_pro_features_sent_for_beta_variant", () => {
  // The u3-rt-pro-beta-1 variant gets the same U3 Pro-only params as u3-rt-pro.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({
      model: "u3-rt-pro-beta-1",
      agentContext: "May I take your order?",
      previousContextNTurns: 5,
      interruptionDelay: 300,
    }),
  });
  const q = _query(service);
  expect(q.speech_model).toEqual(["u3-rt-pro-beta-1"]);
  expect(q.agent_context).toEqual(["May I take your order?"]);
  expect(q.previous_context_n_turns).toEqual(["5"]);
  expect(q.interruption_delay).toEqual(["300"]);
  expect(q.continuous_partials).toEqual(["true"]);
});

test("test_beta_variant_allows_assemblyai_turn_detection_mode", () => {
  // vadForceTurnEndpoint=false requires a u3-rt-pro family model; beta-1 qualifies.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "u3-rt-pro-beta-1" }),
    vadForceTurnEndpoint: false,
  });
  expect(isU3ProModel((service as any)._settings.model)).toBe(true);
});

test("test_update_agent_context_works_for_beta_variant", async () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "u3-rt-pro-beta-1" }),
  });
  const sent = _recordSends(service);

  await service.updateAgentContext("hello");

  expect(sent).toEqual([{ agent_context: "hello" }]);
});

// --- universal-3-5-pro (U3 Pro family) ---

test("test_u3_pro_features_sent_for_universal_3_5_pro", () => {
  // universal-3-5-pro supports every u3-rt-pro param.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({
      model: "universal-3-5-pro",
      agentContext: "May I take your order?",
      previousContextNTurns: 5,
      interruptionDelay: 300,
    }),
  });
  const q = _query(service);
  expect(q.speech_model).toEqual(["universal-3-5-pro"]);
  expect(q.agent_context).toEqual(["May I take your order?"]);
  expect(q.previous_context_n_turns).toEqual(["5"]);
  expect(q.interruption_delay).toEqual(["300"]);
  expect(q.continuous_partials).toEqual(["true"]);
});

test("test_universal_3_5_pro_allows_assemblyai_turn_detection_mode", () => {
  // vadForceTurnEndpoint=false requires a U3 Pro family model; u3.5 qualifies.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "universal-3-5-pro" }),
    vadForceTurnEndpoint: false,
  });
  expect(isU3ProModel((service as any)._settings.model)).toBe(true);
});

test("test_update_agent_context_works_for_universal_3_5_pro", async () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "universal-3-5-pro" }),
  });
  const sent = _recordSends(service);

  await service.updateAgentContext("hello");

  expect(sent).toEqual([{ agent_context: "hello" }]);
});

// --- universal-3-6-pro (U3 Pro family; universal-3-5-pro upgraded) ---

test("test_u3_pro_features_sent_for_universal_3_6_pro", () => {
  // universal-3-6-pro is universal-3-5-pro upgraded and supports every u3-rt-pro param.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({
      model: "universal-3-6-pro",
      agentContext: "May I take your order?",
      previousContextNTurns: 5,
      interruptionDelay: 300,
    }),
  });
  const q = _query(service);
  expect(q.speech_model).toEqual(["universal-3-6-pro"]);
  expect(q.agent_context).toEqual(["May I take your order?"]);
  expect(q.previous_context_n_turns).toEqual(["5"]);
  expect(q.interruption_delay).toEqual(["300"]);
  expect(q.continuous_partials).toEqual(["true"]);
});

test("test_universal_3_6_pro_allows_assemblyai_turn_detection_mode", () => {
  // vadForceTurnEndpoint=false requires a U3 Pro family model; u3.6 qualifies.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "universal-3-6-pro" }),
    vadForceTurnEndpoint: false,
  });
  expect(isU3ProModel((service as any)._settings.model)).toBe(true);
});

test("test_update_agent_context_works_for_universal_3_6_pro", async () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "universal-3-6-pro" }),
  });
  const sent = _recordSends(service);

  await service.updateAgentContext("hello");

  expect(sent).toEqual([{ agent_context: "hello" }]);
});

// --- agent_context (context carryover) connection parameter ---

test("test_agent_context_omitted_by_default", () => {
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  expect("agent_context" in _query(service)).toBe(false);
});

test("test_agent_context_sent_for_u3_rt_pro", () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ agentContext: "May I take your order?" }),
  });
  expect(_query(service).agent_context).toEqual(["May I take your order?"]);
});

test("test_agent_context_omitted_for_universal_streaming", () => {
  // agent_context (context carryover) is a u3-rt-pro-only parameter.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({
      model: "universal-streaming-english",
      agentContext: "May I take your order?",
    }),
  });
  expect("agent_context" in _query(service)).toBe(false);
});

test("test_agent_context_clipped_in_url", () => {
  // Values longer than the limit are clipped to the last 1500 characters.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ agentContext: "a".repeat(2000) }),
  });
  expect(_query(service).agent_context).toEqual(["a".repeat(1500)]);
});

// --- previous_context_n_turns (context carryover window) ---

test("test_previous_context_n_turns_omitted_by_default", () => {
  // Unset means "use the server default": the param should not be sent.
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  expect("previous_context_n_turns" in _query(service)).toBe(false);
});

test("test_previous_context_n_turns_sent_for_u3_rt_pro", () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ previousContextNTurns: 5 }),
  });
  expect(_query(service).previous_context_n_turns).toEqual(["5"]);
});

test("test_previous_context_n_turns_zero_disables_carryover", () => {
  // 0 disables carryover entirely and must be sent (not treated as "unset").
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ previousContextNTurns: 0 }),
  });
  expect(_query(service).previous_context_n_turns).toEqual(["0"]);
});

test("test_previous_context_n_turns_omitted_for_universal_streaming", () => {
  // Context carryover is a u3-rt-pro-only feature.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "universal-streaming-english", previousContextNTurns: 5 }),
  });
  expect("previous_context_n_turns" in _query(service)).toBe(false);
});

describe("test_previous_context_n_turns_boundaries_allowed", () => {
  for (const value of [0, 100]) {
    test(`[${value}]`, () => {
      const service = new AssemblyAISTTService({
        apiKey: "test-key",
        settings: new Settings({ previousContextNTurns: value }),
      });
      expect(_query(service).previous_context_n_turns).toEqual([String(value)]);
    });
  }
});

describe("test_previous_context_n_turns_out_of_range_raises", () => {
  for (const value of [-1, 101]) {
    test(`[${value}]`, () => {
      expect(
        () =>
          new AssemblyAISTTService({
            apiKey: "test-key",
            settings: new Settings({ previousContextNTurns: value }),
          }),
      ).toThrow();
    });
  }
});

// --- voice_focus / voice_focus_threshold ---

test("test_voice_focus_omitted_by_default", () => {
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  const q = _query(service);
  expect("voice_focus" in q).toBe(false);
  expect("voice_focus_threshold" in q).toBe(false);
});

test("test_voice_focus_sent_for_u3_rt_pro", () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ voiceFocus: "near-field", voiceFocusThreshold: 0.5 }),
  });
  const q = _query(service);
  expect(q.voice_focus).toEqual(["near-field"]);
  expect(q.voice_focus_threshold).toEqual(["0.5"]);
});

test("test_voice_focus_sent_for_universal_3_5_pro", () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "universal-3-5-pro", voiceFocus: "far-field" }),
  });
  expect(_query(service).voice_focus).toEqual(["far-field"]);
});

test("test_voice_focus_omitted_for_universal_streaming", () => {
  // voice_focus is a U3 Pro-only parameter.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({
      model: "universal-streaming-english",
      voiceFocus: "far-field",
      voiceFocusThreshold: 0.5,
    }),
  });
  const q = _query(service);
  expect("voice_focus" in q).toBe(false);
  expect("voice_focus_threshold" in q).toBe(false);
});

describe("test_voice_focus_threshold_boundaries_allowed", () => {
  // Python's str(0.0) / str(1.0).
  for (const [value, text] of [
    [0.0, "0.0"],
    [1.0, "1.0"],
  ] as const) {
    test(`[${text}]`, () => {
      const service = new AssemblyAISTTService({
        apiKey: "test-key",
        settings: new Settings({ voiceFocus: "near-field", voiceFocusThreshold: value }),
      });
      expect(_query(service).voice_focus_threshold).toEqual([text]);
    });
  }
});

describe("test_voice_focus_threshold_out_of_range_raises", () => {
  for (const value of [-0.1, 1.1]) {
    test(`[${value}]`, () => {
      expect(
        () =>
          new AssemblyAISTTService({
            apiKey: "test-key",
            settings: new Settings({ voiceFocus: "near-field", voiceFocusThreshold: value }),
          }),
      ).toThrow();
    });
  }
});

// --- mode (latency/accuracy preset) ---

test("test_mode_omitted_by_default", () => {
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  expect("mode" in _query(service)).toBe(false);
});

test("test_mode_sent_for_u3_rt_pro", () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ mode: "max_accuracy" }),
  });
  expect(_query(service).mode).toEqual(["max_accuracy"]);
});

test("test_mode_sent_for_universal_3_5_pro", () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "universal-3-5-pro", mode: "min_latency" }),
  });
  expect(_query(service).mode).toEqual(["min_latency"]);
});

test("test_mode_omitted_for_universal_streaming", () => {
  // mode is a U3 Pro-only parameter.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "universal-streaming-english", mode: "max_accuracy" }),
  });
  expect("mode" in _query(service)).toBe(false);
});

describe("test_mode_values_accepted", () => {
  for (const value of ["min_latency", "balanced", "max_accuracy"] as const) {
    test(`[${value}]`, () => {
      const service = new AssemblyAISTTService({
        apiKey: "test-key",
        settings: new Settings({ mode: value }),
      });
      expect(_query(service).mode).toEqual([value]);
    });
  }
});

// --- language_code ---

test("test_language_code_omitted_by_default", () => {
  // Unset means "not sent": no steering, current behavior preserved.
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  expect("language_code" in _query(service)).toBe(false);
});

test("test_language_code_sent_when_set", () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ languageCode: "es" }),
  });
  expect(_query(service).language_code).toEqual(["es"]);
});

test("test_language_code_sent_for_universal_streaming", () => {
  // language_code is not U3 Pro-only; it is forwarded for any model.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "universal-streaming-english", languageCode: "en" }),
  });
  expect(_query(service).language_code).toEqual(["en"]);
});

test("test_language_code_with_language_detection_warns", async () => {
  // Declaring a language and detecting one are independent server-side; setting
  // both warns about which is in effect and forwards both.
  let service!: AssemblyAISTTService;
  const log = await captureWarnings(() => {
    service = new AssemblyAISTTService({
      apiKey: "test-key",
      settings: new Settings({ languageCode: "es", languageDetection: true }),
    });
  });
  expect(_query(service).language_code).toEqual(["es"]);
  expect(_query(service).language_detection).toEqual(["true"]);
  expect(log).toContain("independent");
});

// --- language_codes ---

// One past AssemblyAI's 10-language cap, all resolving to distinct base codes.
const OVER_LIMIT_LANGUAGES = [
  Language.EN,
  Language.ES,
  Language.DE,
  Language.FR,
  Language.IT,
  Language.PT,
  Language.TR,
  Language.NL,
  Language.SV,
  Language.NO,
  Language.DA,
];

test("test_language_codes_omitted_by_default", () => {
  // Unset means "not sent": no steering.
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  expect("language_codes" in _query(service)).toBe(false);
});

describe("test_language_codes_sent_json_encoded", () => {
  const cases: [Language[], string[]][] = [
    [[Language.ES], ["es"]],
    [
      [Language.EN, Language.ES],
      ["en", "es"],
    ],
    [
      [Language.EN, Language.ES, Language.FR],
      ["en", "es", "fr"],
    ],
  ];
  for (const [languages, expected] of cases) {
    test(`[${expected.join(",")}]`, () => {
      const service = new AssemblyAISTTService({
        apiKey: "test-key",
        settings: new Settings({ languageCodes: languages }),
      });
      expect(_query(service).language_codes).toEqual([pyJsonDumps(expected)]);
    });
  }
});

describe("test_language_codes_covers_universal_3_6_pro_additions", () => {
  // universal-3-6-pro inherits universal-3-5-pro's full T1+T2+T3 language set;
  // these are verified-map entries, not the unlisted-language fallback.
  const cases: [Language, string][] = [
    [Language.UR, "ur"],
    [Language.RU, "ru"],
    [Language.KO, "ko"],
    [Language.CA, "ca"],
    [Language.GL, "gl"],
    [Language.RO, "ro"],
    [Language.ET, "et"],
    [Language.FA, "fa"],
    [Language.YUE, "yue"],
    [Language.AF, "af"],
    [Language.MR, "mr"],
    [Language.ZU, "zu"],
    [Language.XH, "xh"],
    [Language.NN, "nn"],
  ];
  for (const [language, expected] of cases) {
    test(`[${language}-${expected}]`, async () => {
      let query!: Record<string, string[]>;
      const log = await captureWarnings(() => {
        const service = new AssemblyAISTTService({
          apiKey: "test-key",
          settings: new Settings({ languageCodes: [language] }),
        });
        query = _query(service);
      });

      expect(query.language_codes).toEqual([pyJsonDumps([expected])]);
      expect(log).not.toContain("not verified");
    });
  }
});

describe("test_language_codes_sent_for_u3_pro_models_only", () => {
  // Steering is prompt-based, so only the U3 Pro family accepts it.
  for (const model of ["universal-streaming-multilingual", "u3-rt-pro-beta-1"]) {
    test(`[${model}]`, async () => {
      let service!: AssemblyAISTTService;
      const log = await captureWarnings(() => {
        service = new AssemblyAISTTService({
          apiKey: "test-key",
          settings: new Settings({ model, languageCodes: [Language.EN, Language.ES] }),
        });
      });

      if (isU3ProModel(model)) {
        expect(_query(service).language_codes).toEqual([pyJsonDumps(["en", "es"])]);
        expect(log).not.toContain("language_codes is only supported");
      } else {
        expect("language_codes" in _query(service)).toBe(false);
        expect(log).toContain("language_codes is only supported by U3 Pro models");
      }
    });
  }
});

test("test_language_codes_with_language_detection_warns", async () => {
  // Declaring languages and detecting one are independent server-side; setting
  // both warns about which is in effect and forwards both.
  let service!: AssemblyAISTTService;
  const log = await captureWarnings(() => {
    service = new AssemblyAISTTService({
      apiKey: "test-key",
      settings: new Settings({ languageCodes: [Language.ES], languageDetection: true }),
    });
  });
  expect(_query(service).language_codes).toEqual([pyJsonDumps(["es"])]);
  expect(_query(service).language_detection).toEqual(["true"]);
  expect(log).toContain("independent");
});

test("test_language_code_and_language_codes_together_warns", async () => {
  // The two names are aliases for one server parameter, which binds
  // language_codes and ignores language_code. Both are still forwarded.
  let service!: AssemblyAISTTService;
  const log = await captureWarnings(() => {
    service = new AssemblyAISTTService({
      apiKey: "test-key",
      settings: new Settings({
        languageCode: "es",
        languageCodes: [Language.EN, Language.ES],
      }),
    });
  });
  const query = _query(service);
  expect(query.language_code).toEqual(["es"]);
  expect(query.language_codes).toEqual([pyJsonDumps(["en", "es"])]);
  expect(log).toContain("ignoring language_code");
});

test("test_language_codes_over_limit_raises", () => {
  // AssemblyAI rejects an over-long list at connect time; fail where it was set.
  expect(
    () =>
      new AssemblyAISTTService({
        apiKey: "test-key",
        settings: new Settings({ languageCodes: OVER_LIMIT_LANGUAGES }),
      }),
  ).toThrow(/at most 10 languages/);
});

test("test_language_codes_regional_variants_resolve_to_base_codes", () => {
  // AssemblyAI declares base ISO codes, so variants of one language collapse
  // to a single code while declaration order is preserved.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({
      languageCodes: [Language.ES_MX, Language.EN_US, Language.EN_GB],
    }),
  });
  expect(_query(service).language_codes).toEqual([pyJsonDumps(["es", "en"])]);
});

test("test_language_codes_unlisted_language_forwarded", () => {
  // Which languages are supported is the server's call, so one outside the
  // verified map is forwarded as its base code rather than rejected here.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ languageCodes: [Language.PL] }),
  });
  expect(_query(service).language_codes).toEqual([pyJsonDumps(["pl"])]);
});

test("test_language_codes_at_limit_allowed", () => {
  const languages = [
    Language.EN,
    Language.ES,
    Language.DE,
    Language.FR,
    Language.IT,
    Language.PT,
    Language.TR,
    Language.NL,
    Language.SV,
    Language.NO,
  ];
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ languageCodes: languages }),
  });
  const expected = ["en", "es", "de", "fr", "it", "pt", "tr", "nl", "sv", "no"];
  expect(_query(service).language_codes).toEqual([pyJsonDumps(expected)]);
});

// --- prompt + keyterms_prompt ---

test("test_prompt_and_keyterms_sent_together_for_universal_3_5_pro", () => {
  // U3 Pro models accept both parameters in the same session; the server
  // is the authority on their compatibility.
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({
      model: "universal-3-5-pro",
      prompt: "Some context for the session.",
      keytermsPrompt: ["alpha", "beta"],
    }),
  });
  const query = _query(service);
  expect(query.prompt).toEqual(["Some context for the session."]);
  expect(query.keyterms_prompt).toEqual([pyJsonDumps(["alpha", "beta"])]);
});

test("test_prompt_and_keyterms_sent_together_for_u3_rt_pro", () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({
      model: "u3-rt-pro",
      prompt: "Some context for the session.",
      keytermsPrompt: ["alpha", "beta"],
    }),
  });
  const query = _query(service);
  expect(query.prompt).toEqual(["Some context for the session."]);
  expect(query.keyterms_prompt).toEqual([pyJsonDumps(["alpha", "beta"])]);
});

test("test_prompt_and_keyterms_raise_for_universal_streaming", () => {
  expect(
    () =>
      new AssemblyAISTTService({
        apiKey: "test-key",
        settings: new Settings({
          model: "universal-streaming-english",
          prompt: "Some context for the session.",
          keytermsPrompt: ["alpha", "beta"],
        }),
      }),
  ).toThrow(/only supported by U3 Pro models/);
});

test("test_prompt_alone_raises_for_universal_streaming", () => {
  expect(
    () =>
      new AssemblyAISTTService({
        apiKey: "test-key",
        settings: new Settings({
          model: "universal-streaming-english",
          prompt: "Some context for the session.",
        }),
      }),
  ).toThrow(/only supported by U3 Pro models/);
});

// --- update_agent_context() ---

test("test_update_agent_context_clips_and_sends", async () => {
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  const sent = _recordSends(service);

  await service.updateAgentContext("a".repeat(2000));

  // Stored (so a reconnect re-seeds it) and sent via UpdateConfiguration, clipped.
  expect((service as any)._settings.agentContext).toBe("a".repeat(1500));
  expect(sent).toEqual([{ agent_context: "a".repeat(1500) }]);
});

test("test_update_agent_context_noop_for_non_u3", async () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "universal-streaming-english" }),
  });
  const sent = _recordSends(service);

  await service.updateAgentContext("hello");

  expect(sent).toEqual([]);
  expect((service as any)._settings.agentContext).toBeNull();
});

test("test_update_agent_context_ignores_empty_text", async () => {
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  const sent = _recordSends(service);

  await service.updateAgentContext("");

  expect(sent).toEqual([]);
});

// --- _update_settings routing for hot-updatable fields ---

/** Stub out network methods; return (sent UpdateConfigurations, reconnects). */
function _stubConnection(service: AssemblyAISTTService): [Dict[], string[]] {
  const sent = _recordSends(service);
  const reconnects: string[] = [];
  (service as any)._disconnect = async () => {
    reconnects.push("disconnect");
  };
  (service as any)._connect = async () => {
    reconnects.push("connect");
  };
  return [sent, reconnects];
}

test("test_update_settings_agent_context_only_sends_without_reconnect", async () => {
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  const [sent, reconnects] = _stubConnection(service);

  const delta = new Settings({ agentContext: "a".repeat(2000) });
  await (service as any)._updateSettings(delta);

  // Hot update: clipped UpdateConfiguration, no reconnect.
  expect(sent).toEqual([{ agent_context: "a".repeat(1500) }]);
  expect(reconnects).toEqual([]);
});

test("test_update_settings_agent_context_not_sent_for_non_u3", async () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "universal-streaming-english" }),
  });
  const [sent, reconnects] = _stubConnection(service);

  const delta = new Settings({ agentContext: "hello" });
  await (service as any)._updateSettings(delta);

  // agent_context is u3-rt-pro-only; nothing goes to the server.
  expect(sent).toEqual([]);
  expect(reconnects).toEqual([]);
});

test("test_update_settings_language_codes_only_sends_without_reconnect", async () => {
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  const [sent, reconnects] = _stubConnection(service);

  const delta = new Settings({ languageCodes: [Language.EN, Language.ES] });
  await (service as any)._updateSettings(delta);

  // Hot update: UpdateConfiguration carries the resolved codes, no reconnect.
  expect(sent).toEqual([{ language_codes: ["en", "es"] }]);
  expect(reconnects).toEqual([]);
});

test("test_update_settings_language_codes_empty_list_clears_steering", async () => {
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  const [sent, reconnects] = _stubConnection(service);

  const delta = new Settings({ languageCodes: [] });
  await (service as any)._updateSettings(delta);

  // An empty list is the server's "clear steering back to the model default".
  expect(sent).toEqual([{ language_codes: [] }]);
  expect(reconnects).toEqual([]);
});

describe("test_update_settings_language_codes_not_sent_for_non_u3", () => {
  for (const model of ["universal-streaming-english", "universal-streaming-multilingual"]) {
    test(`[${model}]`, async () => {
      const service = new AssemblyAISTTService({
        apiKey: "test-key",
        settings: new Settings({ model }),
      });
      const [sent, reconnects] = _stubConnection(service);

      const log = await captureWarnings(async () => {
        const delta = new Settings({ languageCodes: [Language.ES] });
        await (service as any)._updateSettings(delta);
      });

      // Steering is U3 Pro-only; the server would discard this, so don't send it,
      // and don't reconnect either, since those models aren't steered at all.
      expect(sent).toEqual([]);
      expect(reconnects).toEqual([]);
      expect(log).toContain("only supported by U3 Pro models");
    });
  }
});

test("test_update_settings_language_codes_non_u3_warns_once", async () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "universal-streaming-english" }),
  });
  _stubConnection(service);

  const log = await captureWarnings(async () => {
    await (service as any)._updateSettings(new Settings({ languageCodes: [Language.ES] }));
    await (service as any)._updateSettings(new Settings({ languageCodes: [Language.FR] }));
  });

  // A language-switching bot would otherwise warn on every attempt.
  expect(log.split("only supported by U3 Pro models").length - 1).toBe(1);
});

test("test_update_settings_language_codes_with_agent_context_sends_both", async () => {
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  const [sent, reconnects] = _stubConnection(service);

  const delta = new Settings({ agentContext: "Hello.", languageCodes: [Language.ES] });
  await (service as any)._updateSettings(delta);

  // Both fields are hot-updatable, so neither triggers a reconnect.
  expect(sent).toEqual([{ agent_context: "Hello." }, { language_codes: ["es"] }]);
  expect(reconnects).toEqual([]);
});

test("test_update_settings_language_codes_over_limit_ignored", async () => {
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  const [sent, reconnects] = _stubConnection(service);

  const log = await captureWarnings(async () => {
    const delta = new Settings({ languageCodes: OVER_LIMIT_LANGUAGES });
    await (service as any)._updateSettings(delta);
  });

  // AssemblyAI closes the session on an over-long list, so it is never sent.
  expect(sent).toEqual([]);
  expect(reconnects).toEqual([]);
  expect(log).toContain("at most 10 languages");
});

test("test_update_settings_language_codes_over_limit_leaves_settings_intact", async () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ languageCodes: [Language.ES] }),
  });
  _stubConnection(service);

  await (service as any)._updateSettings(new Settings({ languageCodes: OVER_LIMIT_LANGUAGES }));

  // A rejected list must not reach _settings, which a reconnect rebuilds from.
  expect(_query(service).language_codes).toEqual([pyJsonDumps(["es"])]);
});

test("test_update_settings_over_limit_language_codes_still_reconnects_for_other_fields", async () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ languageCodes: [Language.ES] }),
  });
  const [sent, reconnects] = _stubConnection(service);

  const delta = new Settings({
    model: "u3-rt-pro",
    languageCodes: OVER_LIMIT_LANGUAGES,
  });
  await (service as any)._updateSettings(delta);

  // Dropping language_codes leaves the connect-time model change to reconnect,
  // and the rebuilt URL carries the previous steering.
  expect(reconnects).toEqual(["disconnect", "connect"]);
  expect(sent).toEqual([]);
  expect(_query(service).language_codes).toEqual([pyJsonDumps(["es"])]);
});

test("test_update_settings_mixed_delta_reconnects_without_update_configuration", async () => {
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  const [sent, reconnects] = _stubConnection(service);

  const delta = new Settings({ agentContext: "hello", vadThreshold: 0.5 });
  await (service as any)._updateSettings(delta);

  // Connect-time field changed -> reconnect; the new connection's URL
  // re-seeds agent_context, so no separate UpdateConfiguration is sent.
  expect(sent).toEqual([]);
  expect(reconnects).toEqual(["disconnect", "connect"]);
  expect(service._buildWsUrl()).toContain("agent_context");
});

// --- _process_assistant_turn ---

test("test__process_assistant_turn_delegates_to_update_agent_context", async () => {
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  const sent = _recordSends(service);

  await (service as any)._processAssistantTurn("Hello there.");

  expect(sent).toEqual([{ agent_context: "Hello there." }]);
  expect((service as any)._settings.agentContext).toBe("Hello there.");
});

test("test__process_assistant_turn_noop_for_non_u3", async () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ model: "universal-streaming-english" }),
  });
  const sent = _recordSends(service);

  await (service as any)._processAssistantTurn("Hello.");

  expect(sent).toEqual([]);
});

test("test__process_assistant_turn_noop_when_carryover_disabled", async () => {
  const service = new AssemblyAISTTService({
    apiKey: "test-key",
    settings: new Settings({ previousContextNTurns: 0 }),
  });
  const sent = _recordSends(service);

  await (service as any)._processAssistantTurn("Hello.");

  expect(sent).toEqual([]);
});

test("test_speech_started_proposes_turn_without_interrupting", async () => {
  // The service proposes the turn; the user turn strategies decide it and own
  // the interruption, so nothing is interrupted from here.
  const service = new AssemblyAISTTService({ apiKey: "test-key", vadForceTurnEndpoint: false });
  const events: [string, unknown][] = [];

  (service as any).broadcastFrame = async (frameCls: unknown) => {
    events.push(["broadcast", frameCls]);
  };
  (service as any).broadcastInterruption = async () => {
    events.push(["interruption", null]);
  };

  await (service as any)._handleSpeechStarted(null);

  expect(events).toEqual([["broadcast", ProposedUserStartedSpeakingFrame]]);
});

test("test_termination_acknowledges_without_ending_pipeline", async () => {
  // The server sends Termination in reply to our Terminate, including on a
  // settings-triggered reconnect, so it must not end the pipeline.
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  const pushed: unknown[] = [];

  (service as any).pushFrame = async (frame: unknown) => {
    pushed.push(frame);
  };

  const message = new TerminationMessage({
    type: "Termination",
    audioDurationSeconds: 1,
    sessionDurationSeconds: 2,
  });
  await (service as any)._handleTermination(message);

  expect((service as any)._terminationEvent.isSet()).toBe(true);
  expect(pushed).toEqual([]);
});

test("test_should_interrupt_rides_on_recommended_strategies", () => {
  // shouldInterrupt no longer gates a local broadcast; it configures the
  // strategies the service recommends via its metadata frame.
  for (const shouldInterrupt of [true, false]) {
    const service = new AssemblyAISTTService({
      apiKey: "test-key",
      vadForceTurnEndpoint: false,
      shouldInterrupt,
    });
    const strategies = service.serviceMetadataFrame().userTurnStrategies;
    expect(strategies).toBeInstanceOf(ExternalUserTurnStrategies);
    expect((strategies as ExternalUserTurnStrategies).enableInterruptions).toBe(shouldInterrupt);
  }
});
