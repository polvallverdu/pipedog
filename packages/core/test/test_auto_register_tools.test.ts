// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_auto_register_tools.py

/** Tests for automatic registration of tool handlers advertised in a context. */

import { afterEach, describe, expect, test } from "bun:test";

import {
  type DirectFunctionWrapper,
  toolOptions,
} from "../src/adapters/schemas/direct_function.ts";
import { FunctionSchema } from "../src/adapters/schemas/function_schema.ts";
import { ToolsSchema } from "../src/adapters/schemas/tools_schema.ts";
import { SystemClock } from "../src/clocks/system_clock.ts";
import { StartFrame } from "../src/frames/frames.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "../src/processors/frame_processor.ts";
import {
  type FunctionCallParams,
  type FunctionCallRegistryItem,
  LLMService,
} from "../src/services/llm_service.ts";
import { cancelToolName } from "../src/utils/async_tool_cancellation.ts";
import { type BaseTaskManager, TaskManager } from "../src/utils/asyncio/task_manager.ts";
import { LOG_LEVELS, type LogLevel, logger } from "../src/utils/logger.ts";
import { tool } from "../src/workers/llm/tool_decorator.ts";

// DIVERGENCE (see adapters/schemas/direct_function.ts): JavaScript has no
// docstrings or runtime type hints, so direct functions carry their
// description and parameter types as attached metadata.

/**
 * Build a setup configuration for a processor used outside a pipeline.
 *
 * Local port of upstream tests/frame_processor_helpers.py `frame_processor_setup`.
 */
function frameProcessorSetup(
  taskManager: BaseTaskManager | null = null,
  options: Partial<FrameProcessorSetupOptions> = {},
): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    ...options,
    taskManager: taskManager as BaseTaskManager,
  });
}

/** The protected LLMService members these tests exercise, as upstream reaches into them. */
interface Internals {
  _functions: Map<string | null, FunctionCallRegistryItem>;
  _syncRegisteredToolHandlers(tools: unknown): void;
  _registerDirectFunction(handler: (...args: any[]) => Promise<unknown>, options?: object): void;
  _unregisterDirectFunction(handler: (...args: any[]) => Promise<unknown>): void;
}

function internals(service: LLMService): Internals {
  return service as unknown as Internals;
}

function fns(service: LLMService): Map<string | null, FunctionCallRegistryItem> {
  return internals(service)._functions;
}

function item(service: LLMService, name: string | null): FunctionCallRegistryItem {
  return fns(service).get(name) as FunctionCallRegistryItem;
}

const get_current_weather = Object.assign(
  async function get_current_weather(params: FunctionCallParams, location: string, format: string) {
    void [location, format];
    await params.resultCallback({ conditions: "nice", temperature: "75" });
  },
  {
    description: "Get the current weather.",
    parameters: {
      location: { type: "string", description: 'The city and state, e.g. "San Francisco, CA".' },
      format: { type: "string", description: 'The temperature unit, "celsius" or "fahrenheit".' },
    },
  },
);

const get_restaurant_recommendation = Object.assign(
  async function get_restaurant_recommendation(params: FunctionCallParams, location: string) {
    void location;
    await params.resultCallback({ name: "The Golden Dragon" });
  },
  {
    description: "Get a restaurant recommendation.",
    parameters: {
      location: { type: "string", description: 'The city and state, e.g. "San Francisco, CA".' },
    },
  },
);

const end_call = toolOptions({ cancelOnInterruption: false, timeoutSecs: 60 })(
  Object.assign(
    async function end_call(params: FunctionCallParams, reason: string) {
      void reason;
      await params.resultCallback({ status: "ending" });
    },
    {
      description: "End the call.",
      parameters: { reason: { type: "string", description: "Why the call is ending." } },
    },
  ),
);

const async_task = toolOptions({ cancelOnInterruption: false })(
  Object.assign(
    async function async_task(params: FunctionCallParams, query: string) {
      void query;
      await params.resultCallback({ status: "done" });
    },
    {
      description: "Run an async task (cancel_on_interruption=False).",
      parameters: { query: { type: "string", description: "The task query." } },
    },
  ),
);

const cancellable_task = toolOptions({ cancelOnInterruption: false, cancellableByLlm: true })(
  Object.assign(
    async function cancellable_task(params: FunctionCallParams, query: string) {
      void [params, query];
    },
    {
      description: "A long-running task the LLM may cancel.",
      parameters: { query: { type: "string", description: "What to work on." } },
    },
  ),
);

const async_task_2 = toolOptions({ cancelOnInterruption: false })(
  Object.assign(
    async function async_task_2(params: FunctionCallParams, query: string) {
      void query;
      await params.resultCallback({ status: "done" });
    },
    {
      description: "Run a second async task (cancel_on_interruption=False).",
      parameters: { query: { type: "string", description: "The task query." } },
    },
  ),
);

/** A classic (non-direct) handler bundled on a FunctionSchema. */
async function lookup_order_handler(params: FunctionCallParams): Promise<void> {
  await params.resultCallback({ status: "shipped" });
}

/** Build a handler-carrying FunctionSchema for `lookup_order`. */
function lookup_order_schema(): FunctionSchema {
  return new FunctionSchema({
    name: "lookup_order",
    description: "Look up an order.",
    properties: { order_id: { type: "string" } },
    required: ["order_id"],
    handler: lookup_order_handler,
  });
}

/** A schema handler whose call options come from toolOptions(). */
const end_call_handler = toolOptions({ cancelOnInterruption: false, timeoutSecs: 60 })(
  async function end_call_handler(params: FunctionCallParams): Promise<void> {
    await params.resultCallback({ status: "ending" });
  },
);

/** Build a handler-carrying FunctionSchema for `end_call`. */
function end_call_schema(): FunctionSchema {
  return new FunctionSchema({
    name: "end_call",
    description: "End the call.",
    properties: {},
    required: [],
    handler: end_call_handler,
  });
}

/** loguru `logger.add(sink, level=..., format="{message}")`. */
const sinkCleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of sinkCleanups.splice(0)) cleanup();
});

function captureLogs(level: LogLevel): { getvalue: () => string; remove: () => void } {
  const lines: string[] = [];
  const remove = logger.addSink((record) => {
    if (LOG_LEVELS[record.level] >= LOG_LEVELS[level]) lines.push(`${record.message}\n`);
  });
  sinkCleanups.push(remove);
  return { getvalue: () => lines.join(""), remove };
}

describe("TestToolsSchemaRetainsCallables", () => {
  test("test_direct_functions_become_schemas_and_retain_wrappers", () => {
    const schema = new FunctionSchema({
      name: "advertise_only",
      description: "d",
      properties: {},
      required: [],
    });
    const tools = new ToolsSchema({ standardTools: [get_current_weather, schema] });
    // Direct functions are advertised as FunctionSchemas...
    expect(tools.standardTools.every((t) => t instanceof FunctionSchema)).toBe(true);
    expect(new Set(tools.standardTools.map((t) => t.name))).toEqual(
      new Set(["get_current_weather", "advertise_only"]),
    );
    // ...and retained as wrappers so their handlers can be registered. A
    // FunctionSchema-only entry is advertise-only (no wrapper).
    expect(new Set(tools.directFunctions.map((w) => w.name))).toEqual(
      new Set(["get_current_weather"]),
    );
  });
});

describe("TestLLMContextAcceptsList", () => {
  test("test_context_accepts_bare_list", () => {
    const context = new LLMContext({
      tools: [get_current_weather, get_restaurant_recommendation],
    });
    expect(context.tools).toBeInstanceOf(ToolsSchema);
    expect(new Set((context.tools as ToolsSchema).standardTools.map((t) => t.name))).toEqual(
      new Set(["get_current_weather", "get_restaurant_recommendation"]),
    );
  });

  test("test_set_tools_accepts_bare_list", () => {
    const context = new LLMContext();
    context.setTools([get_current_weather]);
    expect(new Set((context.tools as ToolsSchema).standardTools.map((t) => t.name))).toEqual(
      new Set(["get_current_weather"]),
    );
  });

  test("test_invalid_tools_type_raises", () => {
    expect(() => new LLMContext({ tools: "not-a-tools-object" as never })).toThrow(TypeError);
  });
});

describe("TestAutoRegister", () => {
  const _service = (): LLMService => new LLMService();

  test("test_auto_registers_with_defaults", () => {
    const service = _service();
    const context = new LLMContext({
      tools: [get_current_weather, get_restaurant_recommendation],
    });
    internals(service)._syncRegisteredToolHandlers(context.tools);
    expect(service.hasFunction("get_current_weather")).toBe(true);
    expect(service.hasFunction("get_restaurant_recommendation")).toBe(true);
    const it = item(service, "get_current_weather");
    expect(it.cancelOnInterruption).toBe(true);
    expect(it.timeoutSecs).toBeNull();
  });

  test("test_auto_register_reads_decorator_options", () => {
    const service = _service();
    const context = new LLMContext({ tools: [end_call] });
    internals(service)._syncRegisteredToolHandlers(context.tools);
    const it = item(service, "end_call");
    expect(it.cancelOnInterruption).toBe(false);
    expect(it.timeoutSecs).toEqual(60);
  });

  test("test_explicit_registration_not_clobbered", () => {
    const service = _service();
    // Register explicitly with non-default options first.
    internals(service)._registerDirectFunction(get_current_weather, {
      cancelOnInterruption: false,
      timeoutSecs: 99,
    });
    const context = new LLMContext({ tools: [get_current_weather] });
    internals(service)._syncRegisteredToolHandlers(context.tools);
    const it = item(service, "get_current_weather");
    // The explicit registration's options survive (no clobber).
    expect(it.cancelOnInterruption).toBe(false);
    expect(it.timeoutSecs).toEqual(99);
  });

  test("test_function_schema_advertised_not_registered", () => {
    const service = _service();
    const schema = new FunctionSchema({
      name: "advertise_only",
      description: "d",
      properties: {},
      required: [],
    });
    const context = new LLMContext({ tools: [get_current_weather, schema] });
    internals(service)._syncRegisteredToolHandlers(context.tools);
    expect(service.hasFunction("get_current_weather")).toBe(true);
    // 'advertise_only' has no handler; it must not be auto-registered.
    expect(fns(service).has("advertise_only")).toBe(false);
  });

  test("test_no_tools_is_safe", () => {
    const service = _service();
    internals(service)._syncRegisteredToolHandlers(new LLMContext().tools);
    expect(fns(service)).toEqual(new Map());
  });

  test("test_none_tools_is_safe", () => {
    // Some callers (and realtime services in tests) hand the LLM service a
    // context whose `tools` is null rather than NOT_GIVEN. isGiven(null)
    // is true, so this must be guarded explicitly.
    const service = _service();
    const ctx = { tools: null };
    internals(service)._syncRegisteredToolHandlers(ctx.tools);
    expect(fns(service)).toEqual(new Map());
  });

  test("test_idempotent_across_repeated_contexts", () => {
    const service = _service();
    const context = new LLMContext({ tools: [end_call] });
    internals(service)._syncRegisteredToolHandlers(context.tools);
    // A second pass must not change anything (and must not raise).
    internals(service)._syncRegisteredToolHandlers(context.tools);
    expect([...fns(service).keys()]).toEqual(["end_call"]);
  });
});

/** A service configured with its own tools, as the realtime services are. */
class _ServiceWithOwnTools extends LLMService {
  protected override _serviceTools(): ToolsSchema {
    return new ToolsSchema({ standardTools: [lookup_order_schema()] });
  }
}

describe("TestServiceToolsRegisterOnStart", () => {
  // A service's own tools have their handlers registered as soon as it starts.
  //
  // A realtime service can run one of its configured tools before the first
  // context frame reaches it, so the handlers cannot wait for that frame.

  const _start = async (service: LLMService): Promise<void> => {
    await service.setup(frameProcessorSetup(new TaskManager()));
    await service.start(new StartFrame());
  };

  test("test_service_tools_registered_on_start", async () => {
    const service = new _ServiceWithOwnTools();
    expect(service.hasFunction("lookup_order")).toBe(false);

    await _start(service);

    expect(service.hasFunction("lookup_order")).toBe(true);
  });

  test("test_start_without_service_tools_registers_nothing", async () => {
    const service = new LLMService();

    await _start(service);

    expect(fns(service)).toEqual(new Map());
  });
});

describe("TestAutoRegisterSchemaHandlers", () => {
  // A FunctionSchema that carries a handler is auto-registered like a direct function.
  const _service = (): LLMService => new LLMService();

  test("test_schema_handler_is_registered_with_defaults", () => {
    const service = _service();
    internals(service)._syncRegisteredToolHandlers([lookup_order_schema()]);
    const it = item(service, "lookup_order");
    expect(it.handler).toBe(lookup_order_handler);
    // Registered from the advertised set, so it's prunable (like a direct function).
    expect(it.autoRegistered).toBe(true);
    // An undecorated handler gets the classic defaults.
    expect(it.cancelOnInterruption).toBe(true);
    expect(it.timeoutSecs).toBeNull();
  });

  test("test_schema_handler_reads_tool_options_decorator", () => {
    const service = _service();
    internals(service)._syncRegisteredToolHandlers([end_call_schema()]);
    const it = item(service, "end_call");
    // Options come from toolOptions() on the handler, just like a direct function.
    expect(it.cancelOnInterruption).toBe(false);
    expect(it.timeoutSecs).toEqual(60);
  });

  test("test_handlerless_schema_is_still_advertise_only", () => {
    const service = _service();
    const advertise_only = new FunctionSchema({
      name: "advertise_only",
      description: "d",
      properties: {},
      required: [],
    });
    internals(service)._syncRegisteredToolHandlers([advertise_only, lookup_order_schema()]);
    expect(fns(service).has("advertise_only")).toBe(false);
    expect(service.hasFunction("lookup_order")).toBe(true);
  });

  test("test_deadvertised_schema_handler_is_pruned", () => {
    const service = _service();
    internals(service)._syncRegisteredToolHandlers([lookup_order_schema()]);
    expect(service.hasFunction("lookup_order")).toBe(true);
    // A new tool set that no longer advertises it drops the handler.
    internals(service)._syncRegisteredToolHandlers([]);
    expect(fns(service).has("lookup_order")).toBe(false);
  });

  test("test_idempotent_across_repeated_contexts", () => {
    const service = _service();
    internals(service)._syncRegisteredToolHandlers([lookup_order_schema()]);
    internals(service)._syncRegisteredToolHandlers([lookup_order_schema()]);
    expect([...fns(service).keys()]).toEqual(["lookup_order"]);
  });

  test("test_user_tool_keeps_a_colliding_cancel_tool_name", () => {
    const service = _service();
    const schema = new FunctionSchema({
      name: cancelToolName("cancellable_task"),
      description: "d",
      properties: {},
      required: [],
      handler: lookup_order_handler,
    });
    // A user tool of that name keeps it; the cancel tool is not advertised,
    // which leaves cancellable_task with no way to be stopped.
    internals(service)._syncRegisteredToolHandlers([cancellable_task, schema]);
    expect(item(service, cancelToolName("cancellable_task")).handler).toBe(lookup_order_handler);
    expect(
      Object.hasOwn(service.getLlmAdapter().builtinTools, cancelToolName("cancellable_task")),
    ).toBe(false);
  });
});

describe("TestRedundantManualRegistrationWarning", () => {
  // Manually registering a handler the schema already carries warns, once.
  const _service = (): LLMService => new LLMService();
  const _captureWarnings = () => captureLogs("WARNING");

  test("test_explicit_registration_wins_and_warns", () => {
    const service = _service();

    async function explicit_handler(params: FunctionCallParams): Promise<void> {
      await params.resultCallback({});
    }

    service.registerFunction("lookup_order", explicit_handler);
    const sink = _captureWarnings();
    try {
      internals(service)._syncRegisteredToolHandlers([lookup_order_schema()]);
    } finally {
      sink.remove();
    }
    // The explicit handler is left in place (the schema's handler doesn't clobber it).
    expect(item(service, "lookup_order").handler).toBe(explicit_handler);
    expect(sink.getvalue()).toContain("lookup_order");
    expect(sink.getvalue()).toContain("unnecessary");
  });

  test("test_warning_fires_once_across_repeated_syncs", () => {
    const service = _service();

    async function explicit_handler(params: FunctionCallParams): Promise<void> {
      await params.resultCallback({});
    }

    service.registerFunction("lookup_order", explicit_handler);
    const sink = _captureWarnings();
    try {
      for (let i = 0; i < 3; i++) {
        internals(service)._syncRegisteredToolHandlers([lookup_order_schema()]);
      }
    } finally {
      sink.remove();
    }
    // Sync runs per inference; the advisory must not repeat every turn.
    expect(sink.getvalue().split("lookup_order").length - 1).toEqual(1);
  });

  test("test_no_warning_for_advertise_only_schema", () => {
    const service = _service();

    async function explicit_handler(params: FunctionCallParams): Promise<void> {
      await params.resultCallback({});
    }

    // Classic pattern: register a handler and advertise a handlerless schema.
    service.registerFunction("advertise_only", explicit_handler);
    const advertise_only = new FunctionSchema({
      name: "advertise_only",
      description: "d",
      properties: {},
      required: [],
    });
    const sink = _captureWarnings();
    try {
      internals(service)._syncRegisteredToolHandlers([advertise_only]);
    } finally {
      sink.remove();
    }
    expect(sink.getvalue()).toEqual("");
  });
});

describe("TestUnregisterInteractionWithAutoRegister", () => {
  // A standalone unregister sticks; the advertised set doesn't resurrect it.
  const _service = (): LLMService => new LLMService();

  test("test_unregister_of_still_advertised_direct_function_sticks", () => {
    // Unregistering a direct function that's still advertised must stick: the
    // next context frame must not auto-re-register it (a "zombie"), so calls
    // to it hit the missing-handler recovery path instead.
    const service = _service();
    const context = new LLMContext({ tools: [get_current_weather] });
    internals(service)._syncRegisteredToolHandlers(context.tools);
    internals(service)._unregisterDirectFunction(get_current_weather);
    expect(fns(service).has("get_current_weather")).toBe(false);
    internals(service)._syncRegisteredToolHandlers(context.tools);
    expect(fns(service).has("get_current_weather")).toBe(false);
  });

  test("test_unregister_of_still_advertised_schema_handler_sticks", () => {
    // Same guarantee for a FunctionSchema-carried handler removed via
    // unregisterFunction.
    const service = _service();
    internals(service)._syncRegisteredToolHandlers([lookup_order_schema()]);
    service.unregisterFunction("lookup_order");
    internals(service)._syncRegisteredToolHandlers([lookup_order_schema()]);
    expect(fns(service).has("lookup_order")).toBe(false);
  });

  test("test_explicit_reregister_overrides_suppression", () => {
    // Explicitly registering again clears the suppression and survives the
    // next context frame.
    const service = _service();
    const context = new LLMContext({ tools: [get_current_weather] });
    internals(service)._syncRegisteredToolHandlers(context.tools);
    internals(service)._unregisterDirectFunction(get_current_weather);
    internals(service)._registerDirectFunction(get_current_weather);
    expect(service.hasFunction("get_current_weather")).toBe(true);
    internals(service)._syncRegisteredToolHandlers(context.tools);
    expect(service.hasFunction("get_current_weather")).toBe(true);
  });

  test("test_deadvertising_clears_suppression_so_readvertising_restores", () => {
    // The suppression only holds while the tool stays advertised. Dropping it
    // from the tool set and advertising it again brings the handler back.
    const service = _service();
    internals(service)._syncRegisteredToolHandlers([get_current_weather]);
    internals(service)._unregisterDirectFunction(get_current_weather);
    internals(service)._syncRegisteredToolHandlers([get_current_weather]);
    expect(fns(service).has("get_current_weather")).toBe(false);
    // Drop it from the advertised set...
    internals(service)._syncRegisteredToolHandlers([]);
    // ...then advertise it again: it auto-registers afresh.
    internals(service)._syncRegisteredToolHandlers([get_current_weather]);
    expect(service.hasFunction("get_current_weather")).toBe(true);
  });
});

describe("TestRegisterFunctionOptionPrecedence", () => {
  // Explicit arg > toolOptions()/tool() decorator > default.
  //
  // registerFunction and registerDirectFunction share the resolution
  // (_resolveToolOption), so both registrars are exercised here. The
  // timeout-specific edge cases are covered once, via the direct path.
  const _service = (): LLMService => new LLMService();

  // -- registerFunction ----------------------------------------------------

  test("test_register_function_decorator_values_used_when_no_explicit_args", () => {
    const service = _service();
    service.registerFunction("end_call", end_call_handler); // decorated: false / 60
    const it = item(service, "end_call");
    expect(it.cancelOnInterruption).toBe(false);
    expect(it.timeoutSecs).toEqual(60);
  });

  test("test_register_function_defaults_used_for_undecorated_handler", () => {
    const service = _service();

    async function handler(params: FunctionCallParams): Promise<void> {
      await params.resultCallback({});
    }

    service.registerFunction("do_thing", handler); // undecorated
    const it = item(service, "do_thing");
    expect(it.cancelOnInterruption).toBe(true);
    expect(it.timeoutSecs).toBeNull();
  });

  test("test_register_function_explicit_arg_overrides_decorator", () => {
    const service = _service();
    service.registerFunction("end_call", end_call_handler, { cancelOnInterruption: true });
    const it = item(service, "end_call");
    expect(it.cancelOnInterruption).toBe(true); // explicit wins
    expect(it.timeoutSecs).toEqual(60); // decorator still applies
  });

  // -- registerDirectFunction ----------------------------------------------

  test("test_register_direct_function_decorator_values_used_when_no_explicit_args", () => {
    const service = _service();
    internals(service)._registerDirectFunction(end_call); // decorated: false / 60
    const it = item(service, "end_call");
    expect(it.cancelOnInterruption).toBe(false);
    expect(it.timeoutSecs).toEqual(60);
  });

  test("test_register_direct_function_defaults_used_for_undecorated_function", () => {
    const service = _service();
    internals(service)._registerDirectFunction(get_current_weather); // undecorated
    const it = item(service, "get_current_weather");
    expect(it.cancelOnInterruption).toBe(true);
    expect(it.timeoutSecs).toBeNull();
  });

  test("test_register_direct_function_explicit_arg_overrides_decorator", () => {
    const service = _service();
    // Override one option explicitly; the other still comes from the decorator.
    internals(service)._registerDirectFunction(end_call, { cancelOnInterruption: true });
    const it = item(service, "end_call");
    expect(it.cancelOnInterruption).toBe(true); // explicit wins
    expect(it.timeoutSecs).toEqual(60); // decorator still applies
  });

  test("test_register_direct_function_explicit_timeout_overrides_decorator", () => {
    const service = _service();
    internals(service)._registerDirectFunction(end_call, { timeoutSecs: 5 });
    const it = item(service, "end_call");
    expect(it.cancelOnInterruption).toBe(false); // decorator still applies
    expect(it.timeoutSecs).toEqual(5); // explicit wins
  });

  test("test_register_direct_function_explicit_none_timeout_falls_back_to_decorator", () => {
    // null means "not provided": it falls back to the decorator value rather
    // than forcing the global default past the decorator.
    const service = _service();
    internals(service)._registerDirectFunction(end_call, { timeoutSecs: null });
    const it = item(service, "end_call");
    expect(it.timeoutSecs).toEqual(60);
  });
});

describe("TestAutoUnregisterFromToolSet", () => {
  // An LLMSetToolsFrame replacing the tool set prunes de-advertised handlers.
  const _service = (): LLMService => new LLMService();

  test("test_deadvertised_direct_function_is_unregistered", () => {
    const service = _service();
    // Auto-register two from the initial context.
    internals(service)._syncRegisteredToolHandlers(
      new LLMContext({ tools: [get_current_weather, end_call] }).tools,
    );
    expect(service.hasFunction("get_current_weather")).toBe(true);
    expect(service.hasFunction("end_call")).toBe(true);
    // A new tool set advertises only one of them.
    internals(service)._syncRegisteredToolHandlers([get_current_weather]);
    expect(service.hasFunction("get_current_weather")).toBe(true);
    expect(fns(service).has("end_call")).toBe(false);
  });

  test("test_readvertising_brings_handler_back", () => {
    const service = _service();
    internals(service)._syncRegisteredToolHandlers(new LLMContext({ tools: [end_call] }).tools);
    internals(service)._syncRegisteredToolHandlers([get_current_weather]);
    expect(fns(service).has("end_call")).toBe(false);
    // Re-advertising registers it again (not blocked as "unregistered").
    internals(service)._syncRegisteredToolHandlers([get_current_weather, end_call]);
    expect(service.hasFunction("end_call")).toBe(true);
  });

  test("test_empty_tool_set_prunes_all", () => {
    const service = _service();
    internals(service)._syncRegisteredToolHandlers(
      new LLMContext({ tools: [get_current_weather, end_call] }).tools,
    );
    internals(service)._syncRegisteredToolHandlers([]); // clear all tools
    expect(fns(service)).toEqual(new Map());
  });

  test("test_explicitly_registered_handler_is_not_pruned", () => {
    const service = _service();
    // Explicit registration is outside the advertised-tool-set lifecycle.
    internals(service)._registerDirectFunction(get_current_weather);
    // A tool set that doesn't advertise it must not remove it.
    internals(service)._syncRegisteredToolHandlers([end_call]);
    expect(service.hasFunction("get_current_weather")).toBe(true);
    expect(service.hasFunction("end_call")).toBe(true);
  });

  test("test_catch_all_handler_is_not_pruned", () => {
    const service = _service();

    async function catch_all(params: FunctionCallParams): Promise<void> {
      await params.resultCallback({});
    }

    service.registerFunction(null, catch_all);
    internals(service)._syncRegisteredToolHandlers(new LLMContext({ tools: [end_call] }).tools);
    internals(service)._syncRegisteredToolHandlers([get_current_weather]);
    // Catch-all survives; the de-advertised direct function is pruned.
    expect(fns(service).has(null)).toBe(true);
    expect(fns(service).has("end_call")).toBe(false);
  });
});

describe("TestDeprecatedExplicitRegistrationApi", () => {
  // register/unregister_direct_function are deprecated but still delegate.

  // Deprecated upstream API (register_direct_function, deprecated since 1.4.0)
  // is not ported.
  test.skip("test_register_direct_function_warns_and_registers", () => {});

  // Deprecated upstream API (unregister_direct_function, deprecated since
  // 1.4.0) is not ported.
  test.skip("test_unregister_direct_function_warns_and_unregisters", () => {});
});

describe("TestToolDecoratorSharesAnnotation", () => {
  test("test_tool_sets_options_and_marker", () => {
    const my_tool = tool({ cancelOnInterruption: false, timeoutSecs: 30 })(
      Object.assign(
        async function my_tool(params: FunctionCallParams, arg: string) {
          void arg;
          await params.resultCallback({});
        },
        { description: "A tool.", parameters: { arg: { description: "An argument." } } },
      ),
    );

    expect(my_tool._pipecatIsLlmTool).toBe(true);
    expect(my_tool._pipecatCancelOnInterruption).toBe(false);
    expect(my_tool._pipecatTimeoutSecs).toEqual(30);
  });

  // Deprecated upstream API (the tool(timeout=...) alias) is not ported.
  test.skip("test_tool_timeout_alias_is_deprecated_but_works", () => {});
});

describe("TestReservedToolName", () => {
  // The built-in cancel tool name can't be registered by user code.

  test("test_register_function_rejects_reserved_name", () => {
    const service = new LLMService();
    internals(service)._syncRegisteredToolHandlers(
      new LLMContext({ tools: [cancellable_task] }).tools,
    );

    async function handler(params: FunctionCallParams): Promise<void> {
      await params.resultCallback({});
    }

    // Python ValueError -> Error.
    expect(() => service.registerFunction(cancelToolName("cancellable_task"), handler)).toThrow(
      "reserved built-in tool name",
    );
  });

  test("test_register_direct_function_rejects_reserved_name", () => {
    const service = new LLMService();
    internals(service)._syncRegisteredToolHandlers(
      new LLMContext({ tools: [cancellable_task] }).tools,
    );

    /** A direct function whose name collides with an advertised cancel tool. */
    async function cancel_cancellable_task(params: FunctionCallParams): Promise<void> {
      await params.resultCallback({});
    }

    expect(() => internals(service)._registerDirectFunction(cancel_cancellable_task)).toThrow(
      "reserved built-in tool name",
    );
  });
});

describe("TestClassicRegisterFunction", () => {
  // registerFunction (non-direct handlers): registration and removal.
  //
  // Option precedence is covered in TestRegisterFunctionOptionPrecedence.

  const _handler = async (params: FunctionCallParams): Promise<void> => {
    await params.resultCallback({});
  };

  test("test_registers_named_handler_with_options", () => {
    const service = new LLMService();
    service.registerFunction("do_thing", _handler, {
      cancelOnInterruption: false,
      timeoutSecs: 12,
    });
    const it = item(service, "do_thing");
    expect(it.cancelOnInterruption).toBe(false);
    expect(it.timeoutSecs).toEqual(12);
    // Classic registrations are explicit, never advertised-set-managed.
    expect(it.autoRegistered).toBe(false);
  });

  test("test_unregister_function_removes_handler", () => {
    const service = new LLMService();
    service.registerFunction("do_thing", _handler);
    expect(service.hasFunction("do_thing")).toBe(true);
    service.unregisterFunction("do_thing");
    expect(fns(service).has("do_thing")).toBe(false);
  });
});

describe("TestAsyncToolCancellationPruning", () => {
  // The cancellation tools track the advertised set, in both directions.

  test("test_withdrawn_when_the_cancellable_tool_is_pruned", () => {
    const service = new LLMService();
    internals(service)._syncRegisteredToolHandlers(
      new LLMContext({ tools: [cancellable_task] }).tools,
    );
    expect(fns(service).has(cancelToolName("cancellable_task"))).toBe(true);

    // Drop the only cancellable tool from the advertised set.
    internals(service)._syncRegisteredToolHandlers([]);
    expect(fns(service).has("cancellable_task")).toBe(false);
    expect(fns(service).has(cancelToolName("cancellable_task"))).toBe(false);
    expect(
      Object.hasOwn(service.getLlmAdapter().builtinTools, cancelToolName("cancellable_task")),
    ).toBe(false);
  });

  test("test_kept_while_a_cancellable_tool_remains", () => {
    const service = new LLMService();
    internals(service)._syncRegisteredToolHandlers(
      new LLMContext({ tools: [cancellable_task, async_task] }).tools,
    );
    // Drop the async tool that never opted in; the cancellable one remains.
    internals(service)._syncRegisteredToolHandlers([cancellable_task]);
    expect(fns(service).has("async_task")).toBe(false);
    expect(fns(service).has(cancelToolName("cancellable_task"))).toBe(true);
  });

  test("test_absent_for_async_tools_that_did_not_opt_in", () => {
    const service = new LLMService();
    internals(service)._syncRegisteredToolHandlers(
      new LLMContext({ tools: [async_task, async_task_2] }).tools,
    );
    expect(fns(service).has(cancelToolName("cancellable_task"))).toBe(false);
  });
});

describe("TestRebindChangedAdvertisedHandler", () => {
  // Re-advertising a name with a different handler rebinds the auto-registered entry.
  //
  // Regression test for the case where two consecutive advertised tool sets carry
  // the same tool name but different handlers (e.g. a fresh per-node closure after
  // a Flows transition). The new handler must take effect, not be silently dropped.

  const _service = (): LLMService => new LLMService();

  const _captureDebug = () => {
    // loguru's sink at level DEBUG receives DEBUG records regardless of other sinks.
    logger.setLevel("DEBUG");
    return captureLogs("DEBUG");
  };

  /** Build a distinct direct function advertised under `name`. */
  const _namedDirectFunction = (name: string, marker: string) => {
    const fn = Object.assign(
      async function fn(params: FunctionCallParams, value: string) {
        void value;
        await params.resultCallback({ marker });
      },
      { description: "Do a thing.", parameters: { value: { description: "A value." } } },
    );
    Object.defineProperty(fn, "name", { value: name });
    return fn;
  };

  test("test_rebinds_changed_handler_for_still_advertised_direct_function", () => {
    const service = _service();
    const first = _namedDirectFunction("switch", "A");
    const second = _namedDirectFunction("switch", "B");
    internals(service)._syncRegisteredToolHandlers([first]);
    expect((item(service, "switch").handler as DirectFunctionWrapper).function).toBe(first);
    // Re-advertise the same name with a different handler — it must rebind.
    internals(service)._syncRegisteredToolHandlers([second]);
    expect((item(service, "switch").handler as DirectFunctionWrapper).function).toBe(second);
    // Still managed by the advertised set, so it stays prunable.
    expect(item(service, "switch").autoRegistered).toBe(true);
  });

  test("test_rebinds_changed_schema_handler_for_still_advertised_name", () => {
    const service = _service();

    async function handler_a(params: FunctionCallParams): Promise<void> {
      await params.resultCallback({ marker: "A" });
    }

    async function handler_b(params: FunctionCallParams): Promise<void> {
      await params.resultCallback({ marker: "B" });
    }

    const schema = (handler: (params: FunctionCallParams) => Promise<void>) =>
      new FunctionSchema({ name: "x", description: "d", properties: {}, required: [], handler });

    internals(service)._syncRegisteredToolHandlers([schema(handler_a)]);
    expect(item(service, "x").handler).toBe(handler_a);
    // The issue's exact repro: same name, new handler on the next advertised set.
    internals(service)._syncRegisteredToolHandlers([schema(handler_b)]);
    expect(item(service, "x").handler).toBe(handler_b);
    expect(item(service, "x").autoRegistered).toBe(true);
  });

  test("test_repeated_identical_schema_handler_does_not_churn", () => {
    const service = _service();
    internals(service)._syncRegisteredToolHandlers([lookup_order_schema()]);
    const sink = _captureDebug();
    try {
      // The handler object is unchanged across frames, so no rebind should happen.
      internals(service)._syncRegisteredToolHandlers([lookup_order_schema()]);
    } finally {
      sink.remove();
    }
    expect(item(service, "lookup_order").handler).toBe(lookup_order_handler);
    expect(sink.getvalue()).not.toContain("rebound");
  });

  test("test_explicit_registration_not_rebound_by_advertised_handler", () => {
    const service = _service();

    async function explicit_handler(params: FunctionCallParams): Promise<void> {
      await params.resultCallback({});
    }

    async function advertised_handler(params: FunctionCallParams): Promise<void> {
      await params.resultCallback({});
    }

    const schema = (handler: (params: FunctionCallParams) => Promise<void>) =>
      new FunctionSchema({
        name: "lookup_order",
        description: "d",
        properties: {},
        required: [],
        handler,
      });

    service.registerFunction("lookup_order", explicit_handler);
    const sink = captureLogs("WARNING");
    try {
      internals(service)._syncRegisteredToolHandlers([schema(advertised_handler)]);
    } finally {
      sink.remove();
    }
    // Explicit registration wins; the advertised handler does not rebind it.
    expect(item(service, "lookup_order").handler).toBe(explicit_handler);
    expect(item(service, "lookup_order").autoRegistered).toBe(false);
    expect(sink.getvalue()).toContain("unnecessary");
  });
});
