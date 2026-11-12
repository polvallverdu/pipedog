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
 * - `@pipedog/nvidia` has no index; its `llm` and `omni/llm` modules are walked.
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
import * as inceptionPkg from "../../inception/src/index.ts";
import { InceptionLLMService } from "../../inception/src/llm.ts";
import * as mistralPkg from "../../mistral/src/index.ts";
import { MistralLLMService } from "../../mistral/src/llm.ts";
import * as nebiusPkg from "../../nebius/src/index.ts";
import { NebiusLLMService } from "../../nebius/src/llm.ts";
import * as novitaPkg from "../../novita/src/index.ts";
import { NovitaLLMService } from "../../novita/src/llm.ts";
import * as nvidiaLlmMod from "../../nvidia/src/llm.ts";
import { NvidiaLLMService } from "../../nvidia/src/llm.ts";
import * as nvidiaOmniLlmMod from "../../nvidia/src/omni/llm.ts";
import { NvidiaOmniLLMService } from "../../nvidia/src/omni/llm.ts";
import * as ollamaPkg from "../../ollama/src/index.ts";
import { OLLamaLLMService } from "../../ollama/src/llm.ts";
import * as openrouterPkg from "../../openrouter/src/index.ts";
import { OpenRouterLLMService } from "../../openrouter/src/llm.ts";
import * as perplexityPkg from "../../perplexity/src/index.ts";
import * as qwenPkg from "../../qwen/src/index.ts";
import { QwenLLMService } from "../../qwen/src/llm.ts";
import * as sambanovaPkg from "../../sambanova/src/index.ts";
import { SambaNovaLLMService } from "../../sambanova/src/llm.ts";
import * as sarvamPkg from "../../sarvam/src/index.ts";
import { SarvamLLMService } from "../../sarvam/src/llm.ts";
import * as smallestPkg from "../../smallest/src/index.ts";
import { SmallestLLMService } from "../../smallest/src/llm.ts";
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
  InceptionLLMService,
  MistralLLMService,
  NebiusLLMService,
  NovitaLLMService,
  OpenRouterLLMService,
  // PerplexityLLMService: deprecated upstream (1.13.0), not ported.
  QwenLLMService,
  SambaNovaLLMService,
  SarvamLLMService,
  SmallestLLMService,
  TogetherLLMService,
];

const BaseWhisperSTTService = Object.getPrototypeOf(OpenAISTTService) as abstract new (
  ...args: never[]
) => unknown;

// Services that may take no key: OpenAI's own read OPENAI_API_KEY by design,
// and the rest never hand the OpenAI client a missing key.
const KEY_OPTIONAL_SERVICES = new Set<unknown>([
  AzureLLMService,
  NvidiaLLMService,
  NvidiaOmniLLMService,
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
    inceptionPkg,
    mistralPkg,
    nebiusPkg,
    novitaPkg,
    nvidiaLlmMod,
    nvidiaOmniLlmMod,
    ollamaPkg,
    openrouterPkg,
    perplexityPkg,
    qwenPkg,
    sambanovaPkg,
    sarvamPkg,
    smallestPkg,
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
  for (const cls of [...KEY_OPTIONAL_SERVICES, ...PROVIDER_SERVICES]) {
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
});

describe("test_explicit_api_key_is_used", () => {
  for (const cls of [...PROVIDER_SERVICES, NvidiaLLMService] as AnyService[]) {
    test(cls.name, () => {
      const service = new cls({ apiKey: "provider-key" }) as WithClient;
      expect(service._client.apiKey).toBe("provider-key");
    });
  }
});

test("test_openai_services_read_openai_api_key", () => {
  expect((new OpenAILLMService() as unknown as WithClient)._client.apiKey).toBe("openai-key");
  expect((new OpenAISTTService() as unknown as WithClient)._client.apiKey).toBe("openai-key");
});

test("test_nvidia_local_nim_without_key_does_not_use_openai_key", () => {
  const service = new NvidiaLLMService({
    baseUrl: "http://localhost:8000/v1",
  }) as unknown as WithClient;
  expect(service._client.apiKey).not.toBe("openai-key");
});

test("test_nvidia_local_nim_without_any_key_constructs", () => {
  delete process.env.OPENAI_API_KEY;
  new NvidiaLLMService({ baseUrl: "http://localhost:8000/v1" });
});
