// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_openai_compatible_api_key.py

/**
 * OpenAI-compatible services never send `OPENAI_API_KEY` to another provider.
 *
 * Porting notes:
 * - Python finds every subclass with `__subclasses__()` after importing every
 *   `services/*\/llm.py` and `stt.py`. JS has no subclass registry, so this
 *   walks the exports of the ported packages that hold OpenAI-compatible
 *   services. `@pipedog/whisper` exports only the base class, which is reached
 *   through `OpenAISTTService`'s prototype chain.
 * - The provider packages are imported by relative path: a test-only
 *   dependency on each of them would be a `workspace:` devDependency, which
 *   the published manifest can't carry.
 * - `test_api_key_argument_is_required`: Python raises TypeError for the
 *   missing keyword argument. TypeScript rejects the call at compile time; at
 *   runtime the missing options object raises TypeError too.
 * - The services not ported yet are `test.todo`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import * as openaiPkg from "@pipedog/openai";
import { BaseOpenAILLMService } from "@pipedog/openai/base_llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { OpenAISTTService } from "@pipedog/openai/stt";

import * as basetenPkg from "../../baseten/src/index.ts";
import { BasetenLLMService } from "../../baseten/src/llm.ts";
import * as cerebrasPkg from "../../cerebras/src/index.ts";
import { CerebrasLLMService } from "../../cerebras/src/llm.ts";
import * as crusoePkg from "../../crusoe/src/index.ts";
import { CrusoeLLMService } from "../../crusoe/src/llm.ts";
import * as deepseekPkg from "../../deepseek/src/index.ts";
import { DeepSeekLLMService } from "../../deepseek/src/llm.ts";
import * as fireworksPkg from "../../fireworks/src/index.ts";
import { FireworksLLMService } from "../../fireworks/src/llm.ts";
import * as grokPkg from "../../grok/src/index.ts";
import * as groqPkg from "../../groq/src/index.ts";
import { GroqLLMService } from "../../groq/src/llm.ts";
import { GroqSTTService } from "../../groq/src/stt.ts";
import * as mistralPkg from "../../mistral/src/index.ts";
import { MistralLLMService } from "../../mistral/src/llm.ts";
import * as nebiusPkg from "../../nebius/src/index.ts";
import { NebiusLLMService } from "../../nebius/src/llm.ts";
import * as novitaPkg from "../../novita/src/index.ts";
import { NovitaLLMService } from "../../novita/src/llm.ts";
import * as ollamaPkg from "../../ollama/src/index.ts";
import { OLLamaLLMService } from "../../ollama/src/llm.ts";
import * as openrouterPkg from "../../openrouter/src/index.ts";
import { OpenRouterLLMService } from "../../openrouter/src/llm.ts";
import * as perplexityPkg from "../../perplexity/src/index.ts";
import { PerplexityLLMService } from "../../perplexity/src/llm.ts";
import * as qwenPkg from "../../qwen/src/index.ts";
import { QwenLLMService } from "../../qwen/src/llm.ts";
import * as sambanovaPkg from "../../sambanova/src/index.ts";
import { SambaNovaLLMService } from "../../sambanova/src/llm.ts";
import * as togetherPkg from "../../together/src/index.ts";
import { TogetherLLMService } from "../../together/src/llm.ts";
import * as xaiPkg from "../../xai/src/index.ts";
import { GrokLLMService } from "../../xai/src/llm.ts";
import * as azurePkg from "../src/index.ts";
import { AzureLLMService } from "../src/llm.ts";

type AnyService = new (options?: any) => unknown;

const PROVIDER_SERVICES: AnyService[] = [
  BasetenLLMService,
  CerebrasLLMService,
  CrusoeLLMService,
  DeepSeekLLMService,
  FireworksLLMService,
  GrokLLMService,
  GroqLLMService,
  GroqSTTService,
  MistralLLMService,
  NebiusLLMService,
  NovitaLLMService,
  OpenRouterLLMService,
  PerplexityLLMService,
  QwenLLMService,
  SambaNovaLLMService,
  TogetherLLMService,
];

const PROVIDER_SERVICES_UNPORTED = [
  "InceptionLLMService (pipecat.services.inception.llm)",
  "SarvamLLMService (pipecat.services.sarvam.llm)",
];

const BaseWhisperSTTService = Object.getPrototypeOf(OpenAISTTService) as abstract new (
  ...args: never[]
) => unknown;

// Services that may take no key: OpenAI's own read OPENAI_API_KEY by design,
// and the rest never hand the OpenAI client a missing key.
// (Upstream also lists NvidiaLLMService, not ported yet.)
const KEY_OPTIONAL_SERVICES = new Set<unknown>([
  AzureLLMService,
  OLLamaLLMService,
  OpenAILLMService,
  OpenAISTTService,
]);

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "openai-key";
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
});

function isSubclassOf(cls: unknown, base: abstract new (...args: never[]) => unknown): boolean {
  return typeof cls === "function" && cls !== base && cls.prototype instanceof base;
}

type WithClient = { _client: { apiKey: string } };

test("test_every_provider_service_requires_api_key", () => {
  const modules: Record<string, unknown>[] = [
    openaiPkg,
    azurePkg,
    basetenPkg,
    cerebrasPkg,
    crusoePkg,
    deepseekPkg,
    fireworksPkg,
    grokPkg,
    groqPkg,
    mistralPkg,
    nebiusPkg,
    novitaPkg,
    ollamaPkg,
    openrouterPkg,
    perplexityPkg,
    qwenPkg,
    sambanovaPkg,
    togetherPkg,
    xaiPkg,
  ];

  const services = new Set<unknown>();
  for (const mod of modules) {
    for (const value of Object.values(mod)) {
      if (isSubclassOf(value, BaseOpenAILLMService) || isSubclassOf(value, BaseWhisperSTTService)) {
        services.add(value);
      }
    }
  }
  // The walk must find the services it is checking.
  for (const cls of [AzureLLMService, OpenAILLMService, OpenAISTTService, ...PROVIDER_SERVICES]) {
    expect(services.has(cls)).toBe(true);
  }

  const unflagged = [...services]
    .filter((cls) => !KEY_OPTIONAL_SERVICES.has(cls))
    .filter((cls) => {
      const c = cls as { _requiresApiKey?: boolean };
      return !(Object.hasOwn(c, "_requiresApiKey") && c._requiresApiKey);
    })
    .map((cls) => (cls as { name: string }).name)
    .sort();
  expect(unflagged).toEqual([]);
});

describe("test_api_key_argument_is_required", () => {
  for (const cls of [GroqSTTService, OpenRouterLLMService] as AnyService[]) {
    test(cls.name, () => {
      expect(() => new cls()).toThrow(TypeError);
    });
  }
});

describe("test_missing_api_key_raises", () => {
  for (const cls of PROVIDER_SERVICES) {
    for (const apiKey of [null, ""]) {
      test(`${cls.name} with api_key ${JSON.stringify(apiKey)}`, () => {
        expect(() => new cls({ apiKey })).toThrow("requires an api_key");
      });
    }
  }
  for (const name of PROVIDER_SERVICES_UNPORTED) {
    test.todo(`${name} with api_key null and ""`);
  }
});

describe("test_explicit_api_key_is_used", () => {
  for (const cls of PROVIDER_SERVICES) {
    test(cls.name, () => {
      const service = new cls({ apiKey: "provider-key" }) as WithClient;
      expect(service._client.apiKey).toBe("provider-key");
    });
  }
  for (const name of PROVIDER_SERVICES_UNPORTED) {
    test.todo(name);
  }
  test.todo("NvidiaLLMService (pipecat.services.nvidia.llm)");
});

test("test_openai_services_read_openai_api_key", () => {
  expect((new OpenAILLMService() as unknown as WithClient)._client.apiKey).toBe("openai-key");
  expect((new OpenAISTTService() as unknown as WithClient)._client.apiKey).toBe("openai-key");
});

test.todo(
  "test_nvidia_local_nim_without_key_does_not_use_openai_key (needs pipecat.services.nvidia.llm)",
);

test.todo("test_nvidia_local_nim_without_any_key_constructs (needs pipecat.services.nvidia.llm)");
