// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_realtime_service_tool_sync.py

/**
 * Realtime services auto-register handlers from their service-configured tools.
 *
 * Some realtime services also accept tools configured directly on the service —
 * flat (Gemini Live `tools`, AWS Nova Sonic `tools`, Ultravox
 * `oneShotSelectedTools`) or nested (the OpenAI/Grok/Inworld realtime
 * `sessionProperties.tools`) — as an alternative to advertising them through
 * the `LLMContext`. The base service falls back to
 * `LLMService._serviceTools()` when the context advertises no tools, so a
 * handler bundled on a service-configured `FunctionSchema` (or a direct
 * function) registers without a separate `registerFunction` call, mirroring how
 * the base service syncs from the context's tools on every `LLMContextFrame`.
 *
 * Upstream imports each service with `pytest.importorskip` (per service) so a
 * provider whose optional dependencies aren't installed is skipped. Here each
 * module is loaded with a dynamic import; while a module is unported its tests
 * are `test.todo` naming it.
 */

import { describe, expect, mock, test } from "bun:test";
import { toolOptions } from "../src/adapters/schemas/direct_function.ts";
import { FunctionSchema } from "../src/adapters/schemas/function_schema.ts";
import { ToolsSchema } from "../src/adapters/schemas/tools_schema.ts";
import { LLMContext, NOT_GIVEN } from "../src/processors/aggregators/llm_context.ts";
import type { FunctionCallParams } from "../src/services/llm_service.ts";

// The service modules live in their own (not yet ported) packages.
type AnyModule = any;
type AnyService = any;

/** pytest.importorskip: the module, or null when it can't be loaded (unported). */
async function importOrSkip(path: string): Promise<AnyModule | null> {
  try {
    return await import(path);
  } catch {
    return null;
  }
}

const MODULES = {
  openAiRealtimeAdapter: {
    name: "pipecat.adapters.services.open_ai_realtime_adapter",
    path: "../../openai/src/open_ai_realtime_adapter.ts",
  },
  geminiLive: {
    name: "pipecat.services.google.gemini_live.llm",
    path: "../../google/src/gemini_live/llm.ts",
  },
  novaSonic: {
    name: "pipecat.services.aws.nova_sonic.llm",
    path: "../../aws/src/nova_sonic/llm.ts",
  },
  ultravox: {
    name: "pipecat.services.ultravox.llm",
    path: "../../ultravox/src/llm.ts",
  },
  openaiRealtime: {
    name: "pipecat.services.openai.realtime.llm",
    path: "../../openai/src/realtime/llm.ts",
  },
  openaiRealtimeEvents: {
    name: "pipecat.services.openai.realtime.events",
    path: "../../openai/src/realtime/events.ts",
  },
  grokRealtime: {
    name: "pipecat.services.xai.realtime.llm",
    path: "../../xai/src/realtime/llm.ts",
  },
  grokRealtimeEvents: {
    name: "pipecat.services.xai.realtime.events",
    path: "../../xai/src/realtime/events.ts",
  },
  azureVoiceLive: {
    name: "pipecat.services.azure.voice_live.llm",
    path: "../../azure/src/voice_live/llm.ts",
  },
  azureVoiceLiveEvents: {
    name: "pipecat.services.azure.voice_live.events",
    path: "../../azure/src/voice_live/events.ts",
  },
  inworldRealtime: {
    name: "pipecat.services.inworld.realtime.llm",
    path: "../../inworld/src/realtime/llm.ts",
  },
  inworldRealtimeEvents: {
    name: "pipecat.services.inworld.realtime.events",
    path: "../../inworld/src/realtime/events.ts",
  },
} as const;

type ModuleKey = keyof typeof MODULES;

const loaded: Partial<Record<ModuleKey, AnyModule | null>> = {};
for (const key of Object.keys(MODULES) as ModuleKey[]) {
  loaded[key] = await importOrSkip(MODULES[key].path);
}

/** A `test` when all the modules loaded, else a `test.todo` naming the missing ones. */
function testWith(keys: readonly ModuleKey[], name: string, fn: () => Promise<void>): void {
  const missing = keys.filter((k) => !loaded[k]);
  if (missing.length > 0) {
    const names = missing.map((k) => `${MODULES[k].name} (packages/${MODULES[k].path.slice(6)})`);
    test.todo(`${name} — unported module: ${names.join(", ")}`, fn);
  } else {
    test(name, fn);
  }
}

/** A sample handler bundled on a FunctionSchema. */
async function sample_handler(params: FunctionCallParams): Promise<void> {
  await params.resultCallback({});
}

/** A sample async (non-interruptible) handler. */
const sample_async_handler = toolOptions({ cancelOnInterruption: false })(
  async function sample_async_handler(params: FunctionCallParams): Promise<void> {
    await params.resultCallback({});
  },
);

function _sampleSchema(handler: (params: FunctionCallParams) => Promise<void>): FunctionSchema {
  return new FunctionSchema({
    name: "sample",
    description: "A sample tool.",
    properties: {},
    required: [],
    handler,
  });
}

function _tools(handler: (params: FunctionCallParams) => Promise<void>): ToolsSchema {
  return new ToolsSchema({ standardTools: [_sampleSchema(handler)] });
}

function _names(tools: any[]): Set<string> {
  return new Set(tools.map((t) => t.name || t.function.name));
}

function _delegateSchema(): FunctionSchema {
  return new FunctionSchema({
    name: "delegate",
    description: "Delegate.",
    properties: {},
    required: [],
  });
}

/** The last awaited call's args of a `mock()` (AsyncMock.await_args.args). */
function _lastArgs(fn: ReturnType<typeof mock>): any[] {
  const calls = fn.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1] as any[];
}

type ServiceFactory = (tools: unknown) => AnyService;

/**
 * Shared cases for services that auto-register their service-configured tools.
 *
 * `service(tools)` builds the service with the given tools (a `ToolsSchema`,
 * a plain list of standard tools, or null) wired into its tool parameter.
 */
function _serviceToolSyncTests(keys: readonly ModuleKey[], service: ServiceFactory): void {
  testWith(keys, "test_service_schema_handler_registers", async () => {
    const s = service(_tools(sample_handler));
    // An empty context (NOT_GIVEN tools) falls back to the service tools.
    s._syncRegisteredToolHandlers(NOT_GIVEN);
    expect(s.hasFunction("sample")).toBe(true);
  });

  testWith(keys, "test_service_tool_list_registers", async () => {
    // The tool parameter accepts a plain list of standard tools, not just a
    // ToolsSchema; the handler still auto-registers.
    const s = service([_sampleSchema(sample_handler)]);
    s._syncRegisteredToolHandlers(NOT_GIVEN);
    expect(s.hasFunction("sample")).toBe(true);
  });

  testWith(keys, "test_service_async_tool_option_honored", async () => {
    const s = service(_tools(sample_async_handler));
    s._syncRegisteredToolHandlers(NOT_GIVEN);
    expect(s._functions.get("sample").cancelOnInterruption).toBe(false);
  });

  testWith(keys, "test_no_service_tools_is_safe", async () => {
    const s = service(null);
    s._syncRegisteredToolHandlers(NOT_GIVEN);
    expect([...s._functions.keys()]).toEqual([]);
  });
}

/**
 * Regression cases for services with a `_sendSessionUpdate`.
 *
 * These services (OpenAI/Grok/Inworld realtime) convert their
 * `sessionProperties.tools` from a `ToolsSchema` to the provider's list
 * form when building a `session.update`. That conversion must happen on a
 * copy: mutating the stored `sessionProperties` would leave `tools` a
 * list, so the next `_serviceTools()` fallback no longer recognizes it
 * and the bundled handler silently stops registering.
 */
function _sessionUpdateToolPreservationTests(
  keys: readonly ModuleKey[],
  service: ServiceFactory,
): void {
  testWith(keys, "test_send_session_update_preserves_service_tools", async () => {
    const s = service(_tools(sample_handler));
    s.sendClientEvent = mock(async () => {});
    // Mirrors reality: session.created triggers a session.update before the
    // first (empty) context frame arrives.
    await s._sendSessionUpdate();
    // The stored ToolsSchema survives, so the empty-context fallback still
    // finds and registers the handler.
    expect(s._settings.sessionProperties.tools).toBeInstanceOf(ToolsSchema);
    s._syncRegisteredToolHandlers(NOT_GIVEN);
    expect(s.hasFunction("sample")).toBe(true);
  });

  testWith(keys, "test_built_in_tools_join_the_service_tools", async () => {
    const s = service(_tools(sample_handler));
    s.sendClientEvent = mock(async () => {});
    s.getLlmAdapter().builtinTools.delegate = _delegateSchema();
    s._context = new LLMContext();

    await s._sendSessionUpdate();

    const session = _lastArgs(s.sendClientEvent)[0].session;
    expect(_names(session.tools)).toEqual(new Set(["sample", "delegate"]));
  });

  testWith(keys, "test_built_in_tools_are_sent_when_the_service_has_none", async () => {
    const s = service(null);
    s.sendClientEvent = mock(async () => {});
    s.getLlmAdapter().builtinTools.delegate = _delegateSchema();
    s._context = new LLMContext();

    await s._sendSessionUpdate();

    const session = _lastArgs(s.sendClientEvent)[0].session;
    expect(_names(session.tools)).toEqual(new Set(["delegate"]));
  });

  testWith(keys, "test_session_properties_normalizes_tool_list", async () => {
    // A plain list passed to SessionProperties.tools is normalized to a
    // ToolsSchema by the field validator.
    const s = service([_sampleSchema(sample_handler)]);
    expect(s._settings.sessionProperties.tools).toBeInstanceOf(ToolsSchema);
  });
}

describe("TestRealtimeSessionTools", () => {
  // The tool set a realtime adapter settles for a session.
  testWith(
    ["openAiRealtimeAdapter"],
    "test_the_contexts_own_tools_win_and_built_ins_ride_along",
    async () => {
      const mod = loaded.openAiRealtimeAdapter;
      const adapter = new mod.OpenAIRealtimeLLMAdapter();
      adapter.builtinTools.delegate = _delegateSchema();
      const fromContext = new ToolsSchema({
        standardTools: [
          new FunctionSchema({
            name: "from_context",
            description: "c",
            properties: {},
            required: [],
          }),
        ],
      });
      const serviceTools = _tools(sample_handler);

      async function tools(context: LLMContext, serviceTools: ToolsSchema | null) {
        const params = await adapter.getLlmInvocationParams(context, { serviceTools });
        return _names(params.tools);
      }

      expect(await tools(new LLMContext({ tools: fromContext }), serviceTools)).toEqual(
        new Set(["from_context", "delegate"]),
      );
      expect(await tools(new LLMContext(), serviceTools)).toEqual(new Set(["sample", "delegate"]));
      expect(await tools(new LLMContext(), null)).toEqual(new Set(["delegate"]));
      const bare = await new mod.OpenAIRealtimeLLMAdapter().getLlmInvocationParams(
        new LLMContext(),
      );
      expect(bare.tools).toEqual([]);
    },
  );
});

describe("TestGeminiLiveServiceToolSync", () => {
  const keys = ["geminiLive"] as const;
  const _service: ServiceFactory = (tools) => {
    const mod = loaded.geminiLive;
    return new mod.GeminiLiveLLMService({ apiKey: "test-key", tools });
  };

  _serviceToolSyncTests(keys, _service);

  testWith(keys, "test_raw_dict_service_tools_register_nothing", async () => {
    // Gemini accepts provider-native dict tools, which carry no handler.
    const service = _service([{ function_declarations: [] }]);
    service._syncRegisteredToolHandlers(NOT_GIVEN);
    expect([...service._functions.keys()]).toEqual([]);
  });

  testWith(keys, "test_context_tools_take_precedence", async () => {
    const service = _service(
      new ToolsSchema({
        standardTools: [
          new FunctionSchema({
            name: "from_init",
            description: "d",
            properties: {},
            required: [],
            handler: sample_handler,
          }),
        ],
      }),
    );
    // When the context advertises tools, the service tools aren't used.
    service._syncRegisteredToolHandlers(
      new ToolsSchema({
        standardTools: [
          new FunctionSchema({
            name: "from_context",
            description: "d",
            properties: {},
            required: [],
            handler: sample_handler,
          }),
        ],
      }),
    );
    expect(service.hasFunction("from_context")).toBe(true);
    expect(service.hasFunction("from_init")).toBe(false);
  });
});

describe("TestAWSNovaSonicServiceToolSync", () => {
  _serviceToolSyncTests(["novaSonic"], (tools) => {
    const mod = loaded.novaSonic;
    return new mod.AWSNovaSonicLLMService({
      secretAccessKey: "test",
      accessKeyId: "test",
      region: "us-east-1",
      tools,
    });
  });
});

describe("TestUltravoxServiceToolSync", () => {
  _serviceToolSyncTests(["ultravox"], (tools) => {
    const mod = loaded.ultravox;
    return new mod.UltravoxRealtimeLLMService({
      params: new mod.OneShotInputParams({ apiKey: "test-key", systemPrompt: "test" }),
      oneShotSelectedTools: tools,
    });
  });
});

describe("TestOpenAIRealtimeServiceToolSync", () => {
  const keys = ["openaiRealtime", "openaiRealtimeEvents"] as const;
  const _service: ServiceFactory = (tools) => {
    const mod = loaded.openaiRealtime;
    const events = loaded.openaiRealtimeEvents;
    const sp = new events.SessionProperties({ tools });
    return new mod.OpenAIRealtimeLLMService({
      apiKey: "test-key",
      settings: new mod.OpenAIRealtimeLLMService.Settings({ sessionProperties: sp }),
    });
  };
  _serviceToolSyncTests(keys, _service);
  _sessionUpdateToolPreservationTests(keys, _service);
});

describe("TestGrokRealtimeServiceToolSync", () => {
  const keys = ["grokRealtime", "grokRealtimeEvents"] as const;
  const _service: ServiceFactory = (tools) => {
    const mod = loaded.grokRealtime;
    const events = loaded.grokRealtimeEvents;
    const sp = new events.SessionProperties({ tools });
    return new mod.GrokRealtimeLLMService({
      apiKey: "test-key",
      settings: new mod.GrokRealtimeLLMService.Settings({ sessionProperties: sp }),
    });
  };
  _serviceToolSyncTests(keys, _service);
  _sessionUpdateToolPreservationTests(keys, _service);
});

describe("TestAzureVoiceLiveServiceToolSync", () => {
  const keys = ["azureVoiceLive", "azureVoiceLiveEvents"] as const;
  const _service: ServiceFactory = (tools) => {
    const mod = loaded.azureVoiceLive;
    const events = loaded.azureVoiceLiveEvents;
    const sp = new events.SessionProperties({ tools });
    return new mod.AzureVoiceLiveLLMService({
      endpoint: "https://my-resource.services.ai.azure.com",
      apiKey: "test-key",
      settings: new mod.AzureVoiceLiveLLMService.Settings({ sessionProperties: sp }),
    });
  };
  _serviceToolSyncTests(keys, _service);
  _sessionUpdateToolPreservationTests(keys, _service);
});

describe("TestInworldRealtimeServiceToolSync", () => {
  const keys = ["inworldRealtime", "inworldRealtimeEvents"] as const;
  const _service: ServiceFactory = (tools) => {
    const mod = loaded.inworldRealtime;
    const events = loaded.inworldRealtimeEvents;
    const sp = new events.SessionProperties({ tools });
    return new mod.InworldRealtimeLLMService({
      apiKey: "test-key",
      settings: new mod.InworldRealtimeLLMService.Settings({ sessionProperties: sp }),
    });
  };
  _serviceToolSyncTests(keys, _service);
  _sessionUpdateToolPreservationTests(keys, _service);

  testWith(keys, "test_session_update_serializes_provider_data", async () => {
    const mod = loaded.inworldRealtime;
    const events = loaded.inworldRealtimeEvents;
    const providerData = { stt: { voice_profile: true } };
    const sp = new events.SessionProperties({ providerData });
    const service = new mod.InworldRealtimeLLMService({
      apiKey: "test-key",
      settings: new mod.InworldRealtimeLLMService.Settings({ sessionProperties: sp }),
    });
    service._wsSend = mock(async () => {});

    await service._sendSessionUpdate();

    const message = _lastArgs(service._wsSend)[0];
    expect(message.session).not.toHaveProperty("provider_data");
    expect(message.session.providerData).toEqual({
      stt: { voice_profile: true },
      metadata: { sdk: "pipecat-realtime" },
      auto_tool_response: false,
    });
    expect(service._settings.sessionProperties.providerData).toEqual(providerData);
  });
});
