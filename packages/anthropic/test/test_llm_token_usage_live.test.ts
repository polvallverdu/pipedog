// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_llm_token_usage_live.py

/**
 * Live checks of the token usage LLM services report, against the real provider APIs.
 *
 * Each service answers one prompt in a real pipeline, and the usage it reports must
 * follow Pipecat's convention: `completionTokens` holds every generated token,
 * `reasoningTokens` is the part spent reasoning, and `totalTokens` is the input
 * plus the output. Services whose models reason are asked to, so their reasoning
 * count is checked too.
 *
 * The checks call paid APIs, so they run only when `PIPECAT_LIVE_TESTS` is set, and
 * each one only when its service's credentials are in the environment or the
 * repository's `.env`:
 *
 *     PIPECAT_LIVE_TESTS=1 bun test packages/anthropic/test/test_llm_token_usage_live.test.ts
 *
 * Credentials read from `.env` are set only for the check that needs them.
 *
 * A failure means either Pipecat misreads the provider's usage or the provider changed
 * what it reports. A model the provider has retired fails as an error from the service;
 * update the model named in the case.
 *
 * PORTING NOTES:
 * - Services from other packages are imported lazily by relative path (this package
 *   does not depend on them), as upstream imports them inside each factory.
 * - `dotenv_values` → a minimal `KEY=VALUE` parser of the repository's `.env`.
 *   Note Bun itself auto-loads a `.env` in the working directory into `process.env`.
 * - `monkeypatch.setenv` → set `process.env` and restore it after the check.
 * - `pytest.skip` inside the test → the credentials check runs at collection time and
 *   the case is registered with `test.skipIf`.
 * - The `perplexity` case uses `PerplexityLLMService`, which is deprecated upstream and
 *   not ported, so it is skipped.
 * - The `nvidia` case is a `test.todo` until `pipecat.services.nvidia.llm` is ported.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rethrowIfCancelled } from "@pipedog/asyncio";
import { AdapterType, ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import { ErrorFrame, type Frame, LLMContextFrame, MetricsFrame } from "@pipedog/core/frames/frames";
import { type LLMTokenUsage, LLMUsageMetricsData } from "@pipedog/core/metrics/metrics";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import type { LLMService } from "@pipedog/core/services/llm_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";

const LIVE = Boolean(process.env.PIPECAT_LIVE_TESTS);

const _DOTENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");

const REASONING_PROMPT =
  "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. " +
  "How much does the ball cost? Think it through, then answer in one short sentence.";
const CODE_EXECUTION_PROMPT =
  "Use code execution to compute the sum of the first 50 prime numbers. " +
  "Reply with just the number.";

type Make = () => Promise<LLMService>;

/**
 * One service to check.
 *
 * - `id`: Test id.
 * - `env`: Environment variables the service needs; the case skips without them.
 * - `optionalEnv`: Environment variables the service uses when they are set.
 * - `make`: Builds the service.
 * - `expectsReasoning`: Whether the model reasons and the provider reports it,
 *   so `reasoningTokens` must be positive.
 * - `netPrompt`: Whether `promptTokens` is net of the cache counts, so the
 *   total adds them back.
 * - `prompt`: What the user asks.
 * - `tools`: Provider-specific tools to offer the model.
 * - `wait`: Seconds to wait for a response that arrives outside
 *   `processFrame`, as on a realtime connection.
 * - `startTimeout`: Seconds to wait for the pipeline to start.
 * - `checksProviderTotal`: Whether the provider's own total is reliable
 *   and must match the reported one. Applies to `GoogleLLMService`,
 *   which computes its total rather than passing Google's through.
 */
interface _CaseOptions {
  id: string;
  env: readonly string[];
  make: Make;
  optionalEnv?: readonly string[];
  expectsReasoning?: boolean;
  netPrompt?: boolean;
  prompt?: string;
  tools?: Partial<Record<AdapterType, Record<string, unknown>[]>>;
  wait?: number;
  startTimeout?: number;
  checksProviderTotal?: boolean;
}

class _Case {
  id: string;
  env: readonly string[];
  make: Make;
  optionalEnv: readonly string[];
  expectsReasoning: boolean;
  netPrompt: boolean;
  prompt: string;
  tools: Partial<Record<AdapterType, Record<string, unknown>[]>>;
  wait: number;
  startTimeout: number;
  checksProviderTotal: boolean;

  constructor(options: _CaseOptions) {
    this.id = options.id;
    this.env = options.env;
    this.make = options.make;
    this.optionalEnv = options.optionalEnv ?? [];
    this.expectsReasoning = options.expectsReasoning ?? false;
    this.netPrompt = options.netPrompt ?? false;
    this.prompt = options.prompt ?? REASONING_PROMPT;
    this.tools = options.tools ?? {};
    this.wait = options.wait ?? 0.0;
    this.startTimeout = options.startTimeout ?? 5.0;
    this.checksProviderTotal = options.checksProviderTotal ?? false;
  }
}

/** Build an OpenAI-compatible service with its default model. */
function _openaiCompatible(
  module: string,
  cls: string,
  env: string,
  kwargs: Record<string, unknown> = {},
): Make {
  return async () => {
    const mod = await import(module);
    const serviceCls = mod[cls];
    return new serviceCls({ apiKey: process.env[env], ...kwargs });
  };
}

async function _openai(): Promise<LLMService> {
  const { OpenAILLMService } = await import("../../openai/src/llm.ts");
  return new OpenAILLMService({
    apiKey: process.env.OPENAI_API_KEY as string,
    settings: new OpenAILLMService.Settings({ model: "gpt-5-mini" }),
  }) as unknown as LLMService;
}

async function _openaiResponses(): Promise<LLMService> {
  const { OpenAIResponsesLLMService, OpenAIResponsesReasoningConfig } = await import(
    "../../openai/src/responses/llm.ts"
  );
  return new OpenAIResponsesLLMService({
    apiKey: process.env.OPENAI_API_KEY as string,
    settings: new OpenAIResponsesLLMService.Settings({
      model: "gpt-5-mini",
      reasoning: new OpenAIResponsesReasoningConfig({ effort: "low" }),
    }),
  }) as unknown as LLMService;
}

async function _openaiResponsesHttp(): Promise<LLMService> {
  const { OpenAIResponsesHttpLLMService, OpenAIResponsesReasoningConfig } = await import(
    "../../openai/src/responses/llm.ts"
  );
  return new OpenAIResponsesHttpLLMService({
    apiKey: process.env.OPENAI_API_KEY as string,
    settings: new OpenAIResponsesHttpLLMService.Settings({
      model: "gpt-5-mini",
      reasoning: new OpenAIResponsesReasoningConfig({ effort: "low" }),
    }),
  }) as unknown as LLMService;
}

async function _azure(): Promise<LLMService> {
  const { AzureLLMService } = await import("../../azure/src/llm.ts");
  return new AzureLLMService({
    apiKey: process.env.AZURE_CHATGPT_API_KEY as string,
    endpoint: process.env.AZURE_CHATGPT_ENDPOINT as string,
    settings: new AzureLLMService.Settings({ model: process.env.AZURE_CHATGPT_MODEL as string }),
  }) as unknown as LLMService;
}

async function _grok(): Promise<LLMService> {
  const { GrokLLMService, GrokLLMSettings } = await import("../../xai/src/llm.ts");
  return new GrokLLMService({
    apiKey: process.env.XAI_API_KEY as string,
    settings: new GrokLLMSettings({ model: "grok-4.6", reasoningEffort: "low" }),
  }) as unknown as LLMService;
}

async function _anthropic(): Promise<LLMService> {
  const { AnthropicLLMService } = await import("../src/llm.ts");
  return new AnthropicLLMService({
    apiKey: process.env.ANTHROPIC_API_KEY as string,
    settings: new AnthropicLLMService.Settings({
      model: "claude-sonnet-4-6",
      maxTokens: 4096,
      thinking: new AnthropicLLMService.ThinkingConfig({ type: "enabled", budgetTokens: 1024 }),
    }),
  }) as unknown as LLMService;
}

async function _bedrock(): Promise<LLMService> {
  const { AWSBedrockLLMService } = await import("../../aws/src/llm.ts");
  return new AWSBedrockLLMService({
    awsAccessKey: process.env.AWS_ACCESS_KEY_ID as string,
    awsSecretKey: process.env.AWS_SECRET_ACCESS_KEY as string,
    awsSessionToken: process.env.AWS_SESSION_TOKEN ?? null,
    awsRegion: process.env.AWS_REGION as string,
  }) as unknown as LLMService;
}

function _google(model: string): Make {
  return async () => {
    const { GoogleLLMService } = await import("../../google/src/llm.ts");
    return new GoogleLLMService({
      apiKey: process.env.GOOGLE_API_KEY as string,
      settings: new GoogleLLMService.Settings({ model }),
    }) as unknown as LLMService;
  };
}

async function _geminiLive(): Promise<LLMService> {
  const { GeminiLiveLLMService } = await import("../../google/src/gemini_live/llm.ts");
  return new GeminiLiveLLMService({
    apiKey: process.env.GOOGLE_API_KEY as string,
    settings: new GeminiLiveLLMService.Settings({
      model: "models/gemini-3.8-live-extended-thinking",
      thinking: { thinkingLevel: "HIGH" } as any,
    }),
  }) as unknown as LLMService;
}

const _COMPAT_CLASSES: Record<string, string> = {
  baseten: "BasetenLLMService",
  cerebras: "CerebrasLLMService",
  crusoe: "CrusoeLLMService",
  deepseek: "DeepSeekLLMService",
  fireworks: "FireworksLLMService",
  groq: "GroqLLMService",
  inception: "InceptionLLMService",
  mistral: "MistralLLMService",
  nebius: "NebiusLLMService",
  novita: "NovitaLLMService",
  nvidia: "NvidiaLLMService",
  openrouter: "OpenRouterLLMService",
  perplexity: "PerplexityLLMService",
  qwen: "QwenLLMService",
  sambanova: "SambaNovaLLMService",
  sarvam: "SarvamLLMService",
  smallest: "SmallestLLMService",
  together: "TogetherLLMService",
};

/** A case for an OpenAI-compatible service run with its default model. */
function _compat(name: string, env: string): _Case {
  return new _Case({
    id: name,
    env: [env],
    make: _openaiCompatible(
      resolve(dirname(fileURLToPath(import.meta.url)), `../../${name}/src/llm.ts`),
      _COMPAT_CLASSES[name] as string,
      env,
    ),
  });
}

const CASES: _Case[] = [
  new _Case({ id: "openai", env: ["OPENAI_API_KEY"], make: _openai, expectsReasoning: true }),
  new _Case({
    id: "openai_responses",
    env: ["OPENAI_API_KEY"],
    make: _openaiResponses,
    expectsReasoning: true,
  }),
  new _Case({
    id: "openai_responses_http",
    env: ["OPENAI_API_KEY"],
    make: _openaiResponsesHttp,
    expectsReasoning: true,
  }),
  new _Case({
    id: "azure",
    env: ["AZURE_CHATGPT_API_KEY", "AZURE_CHATGPT_ENDPOINT", "AZURE_CHATGPT_MODEL"],
    make: _azure,
  }),
  new _Case({ id: "grok", env: ["XAI_API_KEY"], make: _grok, expectsReasoning: true }),
  new _Case({
    id: "anthropic",
    env: ["ANTHROPIC_API_KEY"],
    make: _anthropic,
    expectsReasoning: true,
    netPrompt: true,
  }),
  new _Case({
    id: "bedrock",
    env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
    make: _bedrock,
    optionalEnv: ["AWS_SESSION_TOKEN"],
    netPrompt: true,
  }),
  new _Case({
    id: "google",
    env: ["GOOGLE_API_KEY"],
    make: _google("gemini-2.5-pro"),
    expectsReasoning: true,
    checksProviderTotal: true,
  }),
  new _Case({
    id: "google_code_execution",
    env: ["GOOGLE_API_KEY"],
    make: _google("gemini-3.8-flash"),
    prompt: CODE_EXECUTION_PROMPT,
    tools: { [AdapterType.GEMINI]: [{ code_execution: {} }] },
    checksProviderTotal: true,
  }),
  new _Case({
    id: "gemini_live",
    env: ["GOOGLE_API_KEY"],
    make: _geminiLive,
    expectsReasoning: true,
    wait: 25.0,
    startTimeout: 15.0,
  }),
  ...Object.keys(_COMPAT_CLASSES).map((name) => _compat(name, `${name.toUpperCase()}_API_KEY`)),
];

/** Record the totals Google reports as GoogleLLMService streams a response. */
function _recordGoogleTotals(service: LLMService): number[] {
  const totals: number[] = [];
  const s = service as any;
  const streamContent = s._streamContent.bind(s);

  s._streamContent = async (context: LLMContext, ...rest: unknown[]) => {
    const stream = await streamContent(context, ...rest);

    async function* chunks() {
      for await (const chunk of stream) {
        if (chunk.usageMetadata?.totalTokenCount) {
          totals.push(chunk.usageMetadata.totalTokenCount);
        }
        yield chunk;
      }
    }

    return chunks();
  };
  return totals;
}

/**
 * Run the case's prompt through the service.
 *
 * @returns The usage the service reported, and the totals the provider reported
 *   when the case checks them.
 */
async function _reportedUsage(c: _Case): Promise<[LLMTokenUsage[], number[]]> {
  const service = await c.make();
  const providerTotals = c.checksProviderTotal ? _recordGoogleTotals(service) : [];
  const context = new LLMContext({ messages: [{ role: "user", content: c.prompt }] as any });
  if (Object.keys(c.tools).length > 0) {
    context.setTools(new ToolsSchema({ standardTools: [], customTools: c.tools }));
  }
  const frames: Frame[] = [new LLMContextFrame({ context })];
  if (c.wait) {
    frames.push(new SleepFrame({ sleep: c.wait }));
  }

  const [down, up] = await runTest(service, {
    framesToSend: frames,
    pipelineParams: new PipelineParams({ enableMetrics: true, enableUsageMetrics: true }),
    startTimeout: c.startTimeout,
  });

  const errors = [...down, ...up].filter((f) => f instanceof ErrorFrame).map((f) => f.error);
  expect(errors, `${c.id} reported errors: ${errors}`).toEqual([]);
  const reports: LLMTokenUsage[] = [];
  for (const frame of down) {
    if (!(frame instanceof MetricsFrame)) continue;
    for (const data of frame.data) {
      if (data instanceof LLMUsageMetricsData) reports.push(data.value);
    }
  }
  return [reports, providerTotals];
}

/** A minimal `dotenv_values`: `KEY=VALUE` lines, `#` comments, optional quotes. */
function _dotenvValues(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    rethrowIfCancelled(e);
    return {};
  }
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] as string).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[m[1] as string] = value;
  }
  return values;
}

const dotenv = LIVE ? _dotenvValues(_DOTENV_PATH) : {};

for (const c of CASES) {
  const name = `test_reported_token_usage_follows_the_convention[${c.id}]`;

  if (c.id === "nvidia") {
    test.todo(`${name} (pipecat.services.nvidia.llm is not ported)`);
    continue;
  }
  if (c.id === "perplexity") {
    // PerplexityLLMService is deprecated upstream and not ported.
    test.skip(name, () => {});
    continue;
  }

  const missing = c.env.filter((n) => !(process.env[n] || dotenv[n]));

  test.skipIf(!LIVE || missing.length > 0)(
    name,
    async () => {
      const saved: Record<string, string | undefined> = {};
      for (const n of [...c.env, ...c.optionalEnv]) {
        const value = process.env[n] || dotenv[n];
        if (value) {
          saved[n] = process.env[n];
          process.env[n] = value;
        }
      }
      try {
        const [reports, providerTotals] = await _reportedUsage(c);

        expect(reports.length, `${c.id} reported no token usage`).toBeGreaterThan(0);
        for (const usage of reports) {
          expect(usage.promptTokens).toBeGreaterThan(0);
          expect(usage.completionTokens).toBeGreaterThan(0);

          let expectedTotal = usage.promptTokens + usage.completionTokens;
          if (c.netPrompt) {
            expectedTotal +=
              (usage.cacheReadInputTokens || 0) + (usage.cacheCreationInputTokens || 0);
          }
          expect(usage.totalTokens).toBe(expectedTotal);

          if (usage.reasoningTokens !== null && usage.reasoningTokens !== undefined) {
            expect(usage.reasoningTokens).toBeLessThanOrEqual(usage.completionTokens);
          }
        }

        if (c.checksProviderTotal) {
          // The last chunk's usage is the final count for the response.
          expect(providerTotals.length, `${c.id}: the provider reported no total`).toBeGreaterThan(
            0,
          );
          expect(reports[reports.length - 1]?.totalTokens).toBe(
            providerTotals[providerTotals.length - 1],
          );
        }

        if (c.expectsReasoning) {
          expect(
            reports.some((usage) => Boolean(usage.reasoningTokens)),
            `${c.id} reported no reasoning tokens: ${JSON.stringify(reports)}`,
          ).toBe(true);
        }
      } finally {
        for (const [n, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[n];
          else process.env[n] = v;
        }
      }
    },
    // The pipeline's own timeouts bound the run; allow for slow providers and `wait`.
    (c.wait + c.startTimeout + 60) * 1000,
  );
}
