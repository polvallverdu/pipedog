// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_flows_flow.py

/**
 * Tests for Flow: a FlowConfig joined to the application's handlers.
 *
 * DIVERGENCE: upstream reads a direct function's description and parameter
 * schemas from its docstring and type hints. JavaScript has neither, so the
 * handlers below attach them as metadata (`description` and `parameters`), and
 * the first parameter is `flowManager` rather than `flow_manager`. Handlers
 * are called as `(args, flowManager)`, and results are two-element arrays.
 * The two upstream tests of the return-annotation warning are skipped: there
 * are no runtime annotations to inspect, so there is no such warning.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { FunctionCallParams } from "@pipedog/core/services/llm_service";
import {
  ContextStrategy,
  ContextStrategyConfig,
  Flow,
  FlowConfig,
  FlowError,
  FlowManager,
  FlowReferenceError,
  FlowsFunctionSchema,
  flowsToolOptions,
  NO_RESPONSE,
  type NodeConfig,
  TRANSITION_IN_YAML,
} from "@pipedog/flows";
import { OpenAILLMService } from "@pipedog/openai/llm";
import {
  getAdvertisedToolHandlers,
  getQueuedFramesBatches,
  type MockWorker,
  makeMockWorker,
} from "./flows_test_helpers.ts";

/** Attach direct-function metadata, as Python's docstring and type hints would. */
function withMeta<F extends (...args: any[]) => any>(
  fn: F,
  meta: { description?: string; parameters?: Record<string, unknown> },
): F {
  return Object.assign(fn, meta);
}

// --- A handlers module, as an application would write it ---

const choose_pizza = withMeta(async (flowManager: unknown) => [null, TRANSITION_IN_YAML], {
  description: "User wants to order pizza.",
});

async function select_pizza_order(flowManager: FlowManager, size: string, pizza_type: string) {
  flowManager.state.order = { size, pizza_type };
  return [{ size, type: pizza_type, status: "ok" }, TRANSITION_IN_YAML];
}

const select_pizza_order_tool = flowsToolOptions({ cancelOnInterruption: true, timeoutSecs: 12 })(
  withMeta(select_pizza_order, {
    description: "Record the pizza order details.",
    parameters: {
      size: { type: "string", description: 'One of "small", "medium", or "large".' },
      pizza_type: { type: "string", description: "The kind of pizza." },
    },
  }),
);

const report = withMeta(
  async (flowManager: unknown, status: string) => [{ status }, TRANSITION_IN_YAML],
  {
    description: "Report a status the config can branch on.",
    parameters: { status: { type: "string", description: "The status to report." } },
  },
);

const report_flag = withMeta(
  async (flowManager: unknown, flag: boolean) => [{ flag }, TRANSITION_IN_YAML],
  {
    description: "Report a boolean the config can branch on.",
    parameters: { flag: { type: "boolean", description: "The flag to report." } },
  },
);

const get_delivery_estimate = withMeta(
  async (flowManager: unknown) => [{ time: "30 minutes" }, TRANSITION_IN_YAML],
  { description: "Get a delivery estimate." },
);

const stay_quiet = withMeta(async (flowManager: unknown) => [{ ok: true }, NO_RESPONSE], {
  description: "Do work without prompting a bot response.",
});

const returns_none = withMeta(async (flowManager: unknown) => [{ ok: true }, null], {
  description: "Break the contract with null as the next node.",
});

const report_flag_int = withMeta(
  async (flowManager: unknown, code: number) => [{ code }, TRANSITION_IN_YAML],
  {
    description: "Report an integer the config can branch on.",
    parameters: { code: { type: "integer", description: "The code to report." } },
  },
);

const returns_bare = withMeta(async (flowManager: unknown) => ({ ok: true }), {
  description: "Break the contract with a bare result.",
});

const returns_node = withMeta(async (flowManager: unknown) => [null, { taskMessages: [] }], {
  description: "Break the contract with a node.",
});

const returns_name = withMeta(async (flowManager: unknown) => [null, "confirm"], {
  description: "Break the contract with a node name.",
});

const returns_non_mapping = withMeta(
  async (flowManager: unknown) => ["sold out", TRANSITION_IN_YAML],
  { description: "Return a result a branch cannot read." },
);

const not_async = withMeta((flowManager: unknown) => [null, TRANSITION_IN_YAML], {
  description: "Not a coroutine.",
});

const wrong_first_param = withMeta(async (fm: unknown) => [fm && null, TRANSITION_IN_YAML], {
  description: "Wrong first parameter name.",
});

const kitchenChecks: Record<string, unknown>[] = [];

async function check_kitchen_status(
  action: Record<string, unknown>,
  _flowManager: unknown,
): Promise<void> {
  kitchenChecks.push(action);
}

const NOT_A_TOOL = "just a constant";

const TOOLS: Record<string, unknown> = {
  choose_pizza,
  select_pizza_order: select_pizza_order_tool,
  report,
  report_flag,
  get_delivery_estimate,
  stay_quiet,
  returns_none,
  report_flag_int,
  returns_bare,
  returns_node,
  returns_name,
  returns_non_mapping,
  not_async,
  wrong_first_param,
  check_kitchen_status,
  NOT_A_TOOL,
};

function config(overrides: Record<string, unknown> = {}): FlowConfig {
  const data = {
    initial_node: "initial",
    nodes: {
      initial: {
        role_message: "You work for {{ restaurant }}.",
        task_messages: [{ role: "developer", content: "Greet the {{ caller }}." }],
        pre_actions: [{ type: "function", handler: "check_kitchen_status" }],
        functions: [{ name: "choose_pizza", transition_to: "pizza" }],
      },
      pizza: {
        task_messages: [{ role: "developer", content: "Take the order." }],
        context_strategy: "reset",
        respond_immediately: false,
        functions: [{ name: "select_pizza_order", transition_to: "confirm" }],
        post_actions: [{ type: "tts_say", text: "Thanks, {{ caller }}!" }],
      },
      confirm: {
        task_messages: [{ role: "developer", content: "Confirm." }],
      },
    },
    global_functions: [{ name: "get_delivery_estimate" }],
    ...overrides,
  };
  return FlowConfig.modelValidate(data);
}

/** A config with one node offering one function, plus a 'next' node. */
function singleNode(
  fn: Record<string, unknown>,
  nodeExtras: Record<string, unknown> = {},
): FlowConfig {
  return FlowConfig.modelValidate({
    initial_node: "a",
    nodes: {
      a: {
        task_messages: [{ role: "developer", content: "a" }],
        functions: [fn],
        ...nodeExtras,
      },
      next: { task_messages: [{ role: "developer", content: "next" }] },
      other: { task_messages: [{ role: "developer", content: "other" }] },
    },
  });
}

function makeFlow(cfg: FlowConfig, handlers: any = TOOLS): Flow {
  return new Flow(cfg, { handlers });
}

/** The first function of a node, as the schema `Flow` built for it. */
function firstTool(node: NodeConfig): FlowsFunctionSchema {
  const schema = node.functions?.[0];
  if (!(schema instanceof FlowsFunctionSchema)) throw new Error("node has no function schema");
  return schema;
}

function errorOf(fn: () => unknown): any {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

async function asyncErrorOf(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

describe("TestConstruction", () => {
  let flow: Flow;
  beforeEach(() => {
    flow = makeFlow(config());
  });

  test("test_flow_keeps_its_config", () => {
    const cfg = config();
    const f = makeFlow(cfg);
    expect(f).toBeInstanceOf(Flow);
    expect(f.config).toBe(cfg);
  });

  test("test_handlers_from_mapping", () => {
    const mapping = {
      choose_pizza,
      select_pizza_order,
      get_delivery_estimate,
      check_kitchen_status,
      unrelated: 42,
    };
    const f = makeFlow(config(), mapping);
    expect(firstTool(f.initialNode).name).toBe("choose_pizza");
  });

  test("test_handlers_from_a_map", () => {
    const f = makeFlow(config(), new Map(Object.entries(TOOLS)));
    expect(firstTool(f.initialNode).name).toBe("choose_pizza");
  });

  test("test_handlers_from_a_sequence_of_namespaces", () => {
    const shared = { choose_pizza, get_delivery_estimate };
    const actions = { check_kitchen_status };
    const f = makeFlow(config(), [shared, actions, TOOLS]);
    expect(f.node("initial").preActions?.[0]?.handler).toBe(check_kitchen_status);
    expect(firstTool(f.node("pizza")).name).toBe("select_pizza_order");
  });

  test("test_schema_carries_the_configured_name", () => {
    const cfg = FlowConfig.modelValidate({
      initial_node: "a",
      nodes: {
        a: {
          task_messages: [{ role: "developer", content: "a" }],
          functions: [
            { name: "accept", transition_to: "next" },
            { name: "reject", transition_to: "other" },
          ],
        },
        next: { task_messages: [{ role: "developer", content: "n" }] },
        other: { task_messages: [{ role: "developer", content: "o" }] },
      },
    });
    const f = makeFlow(cfg, { accept: choose_pizza, reject: choose_pizza });
    const names = (f.node("a").functions ?? []).map((fn) => (fn as FlowsFunctionSchema).name);
    expect(names).toEqual(["accept", "reject"]);
  });

  test("test_same_callable_in_two_namespaces_is_not_ambiguous", () => {
    const f = makeFlow(singleNode({ name: "choose_pizza" }), [{ choose_pizza }, TOOLS]);
    expect(firstTool(f.node("a")).name).toBe("choose_pizza");
  });

  test("test_name_in_two_namespaces_is_ambiguous", () => {
    const choose_pizza_override = withMeta(
      async (flowManager: unknown) => [null, TRANSITION_IN_YAML],
      { description: "Override." },
    );
    const e = errorOf(() =>
      makeFlow(singleNode({ name: "choose_pizza" }), [
        { choose_pizza: choose_pizza_override },
        TOOLS,
      ]),
    );
    expect(e).toBeInstanceOf(FlowReferenceError);
    const problem = e.problems[0];
    expect(problem.code).toBe("ambiguous_tool");
    expect(problem.function).toBe("choose_pizza");
    expect(problem.message).toContain(
      "tool 'choose_pizza' is defined in more than one of the handlers",
    );
    expect(problem.message).toContain("handlers[0]");
    expect(problem.message).toContain("handlers[1]");
  });

  test("test_handler_in_two_namespaces_is_ambiguous", () => {
    const other_status = async (_action: unknown, _flowManager: unknown) => {};
    const e = errorOf(() => makeFlow(config(), [TOOLS, { check_kitchen_status: other_status }]));
    expect(e).toBeInstanceOf(FlowReferenceError);
    expect(e.problems[0].code).toBe("ambiguous_handler");
  });

  test("test_missing_across_every_namespace", () => {
    const e = errorOf(() => makeFlow(singleNode({ name: "no_such_tool" }), [{}, {}]));
    expect(e).toBeInstanceOf(FlowError);
    expect(e.message).toContain("references tool 'no_such_tool'");
  });

  test("test_transition_only_function_needs_no_tool", () => {
    const cfg = singleNode({
      name: "start_over",
      transition_only: true,
      description: "Start over at {{ restaurant }}.",
      transition_to: "next",
    });
    const f = makeFlow(cfg, {});
    const schema = firstTool(f.node("a"));
    expect(schema.name).toBe("start_over");
    expect(schema.description).toBe("Start over at {{ restaurant }}.");
    expect(schema.properties).toEqual({});
    expect(schema.required).toEqual([]);
  });

  test("test_missing_tool", () => {
    const e = errorOf(() => makeFlow(singleNode({ name: "no_such_tool" })));
    expect(e).toBeInstanceOf(FlowError);
    expect(e.message).toContain("node 'a' references tool 'no_such_tool'");
  });

  test("test_missing_global_tool", () => {
    const e = errorOf(() => makeFlow(config({ global_functions: [{ name: "no_such_tool" }] })));
    expect(e).toBeInstanceOf(FlowError);
    expect(e.message).toContain("global_functions references tool 'no_such_tool'");
  });

  test("test_missing_action_handler", () => {
    const cfg = singleNode(
      { name: "choose_pizza" },
      { pre_actions: [{ type: "function", handler: "no_such_handler" }] },
    );
    const e = errorOf(() => makeFlow(cfg));
    expect(e).toBeInstanceOf(FlowError);
    expect(e.message).toContain("pre_actions references action handler 'no_such_handler'");
  });

  test("test_non_callable_reference", () => {
    const e = errorOf(() => makeFlow(singleNode({ name: "NOT_A_TOOL" })));
    expect(e).toBeInstanceOf(FlowError);
    expect(e.message).toContain("is not callable");
  });

  test("test_invalid_direct_function_not_async", () => {
    const e = errorOf(() => makeFlow(singleNode({ name: "not_async" })));
    expect(e).toBeInstanceOf(FlowError);
    expect(e.message).toContain("not a valid direct function");
    expect(e.message).toContain("must be async");
  });

  test("test_invalid_direct_function_first_param", () => {
    const e = errorOf(() => makeFlow(singleNode({ name: "wrong_first_param" })));
    expect(e).toBeInstanceOf(FlowError);
    expect(e.message).toContain("flowManager");
  });

  test("test_every_problem_is_reported_together", () => {
    const cfg = singleNode(
      { name: "no_such_tool" },
      { pre_actions: [{ type: "function", handler: "no_such_handler" }] },
    );
    const e = errorOf(() => makeFlow(cfg));
    expect(e).toBeInstanceOf(FlowReferenceError);
    expect(e.problems.map((p: { code: string }) => p.code)).toEqual([
      "missing_tool",
      "missing_handler",
    ]);
    expect(e.problems[0].node).toBe("a");
    expect(e.problems[0].function).toBe("no_such_tool");
    expect(e.message).toContain("2 problems");
    expect(e.message).toContain("no_such_handler");
  });

  test("test_placeholders_are_left_for_the_manager", () => {
    const initial = makeFlow(config()).node("initial");
    expect(initial.roleMessage).toBe("You work for {{ restaurant }}.");
  });

  // DIVERGENCE: no runtime return annotations in JavaScript, so there is no
  // "annotated as returning a NodeConfig" warning to test.
  test.skip("test_annotation_warning", () => {});
  test.skip("test_annotation_warning_for_optional_node_and_alias", () => {});

  test("test_initial_node", () => {
    expect(flow.initialNode).toBe(flow.node("initial"));
  });

  test("test_unknown_node", () => {
    expect(() => flow.node("nope")).toThrow(FlowError);
  });

  test("test_node_shape", () => {
    const pizza = flow.node("pizza");
    expect(pizza.name).toBe("pizza");
    expect(pizza.taskMessages).toEqual([{ role: "developer", content: "Take the order." }]);
    expect(pizza.respondImmediately).toBe(false);
    expect(pizza.contextStrategy).toEqual(
      new ContextStrategyConfig({ strategy: ContextStrategy.RESET }),
    );
    expect(pizza).not.toHaveProperty("roleMessage");
    expect(pizza).not.toHaveProperty("preActions");

    const initial = flow.node("initial");
    expect(initial.respondImmediately).toBe(true);
    expect(initial).not.toHaveProperty("contextStrategy");

    expect(flow.node("confirm")).not.toHaveProperty("functions");
  });

  test("test_function_schema_from_direct_function", () => {
    const schema = firstTool(flow.node("pizza"));
    expect(schema).toBeInstanceOf(FlowsFunctionSchema);
    expect(schema.name).toBe("select_pizza_order");
    expect(schema.description).toBe("Record the pizza order details.");
    expect(new Set(Object.keys(schema.properties))).toEqual(new Set(["size", "pizza_type"]));
    expect((schema.properties.size as { description: string }).description).toBe(
      'One of "small", "medium", or "large".',
    );
    expect(schema.required).toEqual(["size", "pizza_type"]);
    expect(schema.cancelOnInterruption).toBe(true);
    expect(schema.timeoutSecs).toBe(12);
  });

  test("test_undecorated_tool_defaults", () => {
    const schema = firstTool(flow.node("initial"));
    expect(schema.cancelOnInterruption).toBe(false);
    expect(schema.timeoutSecs ?? null).toBeNull();
  });

  test("test_actions", () => {
    expect(flow.node("initial").preActions).toEqual([
      { type: "function", handler: check_kitchen_status },
    ]);
  });

  test("test_custom_action_handler_resolves_by_name", () => {
    const f = makeFlow(
      singleNode(
        { name: "choose_pizza" },
        {
          post_actions: [
            { type: "notify", handler: "check_kitchen_status", channel: "#x" },
            { type: "audit" },
          ],
        },
      ),
    );
    const post = f.node("a").postActions ?? [];
    expect(post[0]).toEqual({ type: "notify", handler: check_kitchen_status, channel: "#x" });
    expect(post[1]).toEqual({ type: "audit" });
  });

  test("test_custom_action_handler_must_exist", () => {
    const cfg = singleNode(
      { name: "choose_pizza" },
      { post_actions: [{ type: "notify", handler: "nope" }] },
    );
    const e = errorOf(() => makeFlow(cfg));
    expect(e).toBeInstanceOf(FlowError);
    expect(e.message).toContain("post_actions references action handler 'nope'");
    expect(flow.node("pizza").postActions).toEqual([
      { type: "tts_say", text: "Thanks, {{ caller }}!" },
    ]);
  });

  test("test_global_functions", () => {
    const globals = flow.globalFunctions;
    expect(globals.map((g) => (g as FlowsFunctionSchema).name)).toEqual(["get_delivery_estimate"]);
    expect(globals).not.toBe(flow.globalFunctions);
  });
});

describe("TestCallTimeContract", () => {
  const flowManager = { state: {} as Record<string, any> };

  beforeEach(() => {
    flowManager.state = {};
  });

  async function call(flow: Flow, node = "a", args: Record<string, unknown> = {}): Promise<any> {
    const schema = firstTool(flow.node(node));
    return await schema.handler(args, flowManager as any);
  }

  test("test_none_with_transition_uses_config_edge", async () => {
    const flow = makeFlow(singleNode({ name: "choose_pizza", transition_to: "next" }));
    const [result, nextNode] = await call(flow);
    expect(result).toBeNull();
    expect(nextNode).toBe(flow.node("next"));
  });

  test("test_transition_only_function_moves_to_its_node", async () => {
    const flow = makeFlow(
      singleNode({
        name: "start_over",
        transition_only: true,
        description: "Start over.",
        transition_to: "next",
      }),
      {},
    );
    const [result, nextNode] = await call(flow);
    expect(result).toBeNull();
    expect(nextNode).toBe(flow.node("next"));
  });

  test("test_none_without_transition_stays", async () => {
    const flow = makeFlow(singleNode({ name: "get_delivery_estimate" }));
    const [result, nextNode] = await call(flow);
    expect(result).toEqual({ time: "30 minutes" });
    expect(nextNode).toBeNull();
  });

  test("test_arguments_reach_the_tool", async () => {
    const flow = makeFlow(singleNode({ name: "select_pizza_order", transition_to: "next" }));
    const [result, nextNode] = await call(flow, "a", { size: "large", pizza_type: "cheese" });
    expect(result.size).toBe("large");
    expect(flowManager.state.order.pizza_type).toBe("cheese");
    expect(nextNode).toBe(flow.node("next"));
  });

  test("test_no_response_passes_through", async () => {
    const flow = makeFlow(singleNode({ name: "stay_quiet", transition_to: "next" }));
    const [result, nextNode] = await call(flow);
    expect(result).toEqual({ ok: true });
    expect(nextNode).toBe(NO_RESPONSE);
  });

  test("test_none_next_node_is_rejected", async () => {
    const flow = makeFlow(singleNode({ name: "returns_none", transition_to: "next" }));
    const e = await asyncErrorOf(() => call(flow));
    expect(e).toBeInstanceOf(FlowError);
    expect(e.message).toContain("return (result, TRANSITION_IN_YAML)");
  });

  test("test_bare_result_is_rejected", async () => {
    const flow = makeFlow(singleNode({ name: "returns_bare" }));
    const e = await asyncErrorOf(() => call(flow));
    expect(e).toBeInstanceOf(FlowError);
    expect(e.message).toContain("must return a (result, next) tuple");
  });

  test("test_node_return_is_rejected", async () => {
    for (const fn of [{ name: "returns_node" }, { name: "returns_node", transition_to: "next" }]) {
      const flow = makeFlow(singleNode(fn));
      const e = await asyncErrorOf(() => call(flow));
      expect(e).toBeInstanceOf(FlowError);
      expect(e.message).toContain("return (result, TRANSITION_IN_YAML)");
    }
  });

  test("test_name_return_is_rejected", async () => {
    const flow = makeFlow(singleNode({ name: "returns_name" }));
    const e = await asyncErrorOf(() => call(flow));
    expect(e).toBeInstanceOf(FlowError);
    expect(e.message).toContain("returned node name 'confirm'");
  });
});

describe("TestBranches", () => {
  const BRANCH = { field: "status", cases: { ok: "next", sold_out: "other" } };
  const flowManager = { state: {} };

  async function branch(tool: string, transitionTo: unknown, args: Record<string, unknown>) {
    const flow = makeFlow(singleNode({ name: tool, transition_to: transitionTo }));
    const schema = firstTool(flow.node("a"));
    const [, nextNode] = (await schema.handler(args, flowManager as any)) as [unknown, unknown];
    return { flow, nextNode };
  }

  test("test_case_match", async () => {
    const { flow, nextNode } = await branch("report", BRANCH, { status: "sold_out" });
    expect(nextNode).toBe(flow.node("other"));
  });

  test("test_default", async () => {
    const { flow, nextNode } = await branch(
      "report",
      { ...BRANCH, default: "next" },
      { status: "weird" },
    );
    expect(nextNode).toBe(flow.node("next"));
  });

  test("test_no_match_no_default_stays", async () => {
    const { nextNode } = await branch("report", BRANCH, { status: "weird" });
    expect(nextNode).toBeNull();
  });

  test("test_boolean_values_match_boolean_or_string_keys", async () => {
    // Object keys are always strings; YAML's `true:` and "True": arrive as these.
    for (const key of ["true", "True"]) {
      const { flow, nextNode } = await branch(
        "report_flag",
        { field: "flag", cases: { [key]: "next" } },
        { flag: true },
      );
      expect(nextNode).toBe(flow.node("next"));
    }
    const { nextNode } = await branch(
      "report_flag",
      { field: "flag", cases: { false: "next" } },
      { flag: true },
    );
    expect(nextNode).toBeNull();
  });

  test("test_integer_values_match_integer_or_string_keys", async () => {
    for (const key of [7, "7"]) {
      const { flow, nextNode } = await branch(
        "report_flag_int",
        { field: "code", cases: { [key]: "next" } },
        { code: 7 },
      );
      expect(nextNode).toBe(flow.node("next"));
    }
  });

  test("test_missing_field_is_an_error", async () => {
    const e = await asyncErrorOf(() =>
      branch("report", { field: "missing", cases: { x: "next" } }, { status: "ok" }),
    );
    expect(e).toBeInstanceOf(FlowError);
    expect(e.message).toContain("branches on result field 'missing'");
  });

  test("test_non_mapping_result_is_an_error", async () => {
    const e = await asyncErrorOf(() => branch("returns_non_mapping", BRANCH, {}));
    expect(e).toBeInstanceOf(FlowError);
    expect(e.message).toContain("has no such field");
  });
});

describe("TestWithFlowManager", () => {
  /** A configured flow driven through the real FlowManager. */
  let mockWorker: MockWorker;
  let llm: OpenAILLMService;
  let contextAggregator: any;

  beforeEach(() => {
    mockWorker = makeMockWorker();
    contextAggregator = {
      user: () => ({ context: { getMessages: () => [] } }),
      assistant: () => ({ hasFunctionCallsInProgress: false }),
    };
    llm = new OpenAILLMService({ apiKey: "test-key" });
    kitchenChecks.length = 0;
  });

  function makeManager(flow: Flow): FlowManager {
    const manager = new FlowManager({
      worker: mockWorker as any,
      llm,
      contextAggregator,
      globalFunctions: flow.globalFunctions,
    });
    // What the config's prompts refer to as {{ restaurant }} and {{ caller }}.
    Object.assign(manager.state, { restaurant: "Luigi's", caller: "friend" });
    return manager;
  }

  /**
   * Call an advertised tool the way the LLM service would, then let the
   * context-updated callback fire so a pending transition executes.
   */
  async function invoke(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const handler = getAdvertisedToolHandlers(mockWorker)[name];
    if (!handler) throw new Error(`tool ${name} is not advertised`);
    const results: unknown[] = [];
    await handler(
      new FunctionCallParams({
        functionName: name,
        toolCallId: "t1",
        arguments: args,
        llm,
        pipelineWorker: mockWorker as any,
        context: null as any,
        resultCallback: async (result, options) => {
          results.push(result);
          const onUpdated = options?.properties?.onContextUpdated;
          if (onUpdated) await onUpdated();
        },
      }),
    );
    return results[0];
  }

  test("test_configured_flow_end_to_end", async () => {
    const flow = makeFlow(config());
    const flowManager = makeManager(flow);
    await flowManager.initialize(flow.initialNode);

    expect(flowManager.currentNode).toBe("initial");
    expect(kitchenChecks.length).toBe(1);
    expect(new Set(Object.keys(getAdvertisedToolHandlers(mockWorker)))).toEqual(
      new Set(["choose_pizza", "get_delivery_estimate"]),
    );

    let result = await invoke("choose_pizza");
    expect(result).toEqual({ status: "acknowledged" });
    expect(flowManager.currentNode).toBe("pizza");
    expect(new Set(Object.keys(getAdvertisedToolHandlers(mockWorker)))).toEqual(
      new Set(["select_pizza_order", "get_delivery_estimate"]),
    );

    result = await invoke("select_pizza_order", { size: "small", pizza_type: "cheese" });
    expect(result.status).toBe("ok");
    expect(flowManager.state.order.size).toBe("small");
    expect(flowManager.currentNode).toBe("confirm");

    result = await invoke("get_delivery_estimate");
    expect(result).toEqual({ time: "30 minutes" });
    expect(flowManager.currentNode).toBe("confirm");
  });

  test("test_transition_only_function_through_the_manager", async () => {
    const cfg = config();
    cfg.nodes.confirm?.functions.push(
      new FlowConfig.Function({
        name: "start_over",
        transitionOnly: true,
        description: "Start the order over.",
        transitionTo: "initial",
      }),
    );
    const flow = makeFlow(cfg);
    const flowManager = makeManager(flow);
    await flowManager.initialize(flow.node("confirm"));
    expect(Object.keys(getAdvertisedToolHandlers(mockWorker))).toContain("start_over");

    const result = await invoke("start_over");
    expect(result).toEqual({ status: "acknowledged" });
    expect(flowManager.currentNode).toBe("initial");
  });

  /** Every message the manager has sent to the LLM context so far. */
  function queuedMessages(): any[] {
    return getQueuedFramesBatches(mockWorker)
      .flat()
      .flatMap((frame) => (frame as { messages?: any[] }).messages ?? []);
  }

  test("test_prompts_render_from_state_on_entry", async () => {
    const flow = makeFlow(config());
    const flowManager = makeManager(flow);
    flowManager.state.caller = "Ada";
    await flowManager.initialize(flow.initialNode);

    const contents = queuedMessages().map((m) => m.content);
    expect(contents).toContain("Greet the Ada.");
    // The flow's own node is untouched; rendering happens on a copy.
    expect(flow.initialNode.taskMessages[0]?.content).toBe("Greet the {{ caller }}.");
  });

  test("test_render_node_walks_into_mappings", () => {
    const flowManager = makeManager(makeFlow(config()));
    flowManager.state.order = { size: "large", type: "cheese" };
    const node: NodeConfig = {
      roleMessage: "You work for {{ restaurant }}.",
      taskMessages: [{ role: "developer", content: "Confirm the {{ order.size }} pizza." }],
      postActions: [
        { type: "tts_say", text: "One {{order.type}} pizza." },
        { type: "function", handler: check_kitchen_status },
      ],
    };
    const rendered = flowManager._renderNode("n", node);
    expect(rendered.roleMessage).toBe("You work for Luigi's.");
    expect(rendered.taskMessages[0]?.content).toBe("Confirm the large pizza.");
    expect(rendered.postActions?.[0]?.text).toBe("One cheese pizza.");
    expect(rendered.postActions?.[1]?.handler).toBe(check_kitchen_status);
  });

  test("test_backslash_escapes_a_placeholder", () => {
    const flowManager = makeManager(makeFlow(config()));
    const node: NodeConfig = {
      taskMessages: [{ role: "developer", content: "Write \\{{ caller }} for {{ caller }}." }],
    };
    const rendered = flowManager._renderNode("n", node);
    expect(rendered.taskMessages[0]?.content).toBe("Write {{ caller }} for friend.");
  });

  test("test_missing_state_key_fails_on_entry", async () => {
    const flow = makeFlow(config());
    const flowManager = makeManager(flow);
    delete flowManager.state.caller;
    const e = await asyncErrorOf(() => flowManager.initialize(flow.initialNode));
    expect(e).toBeInstanceOf(FlowError);
    expect(e.message).toContain("uses '{{ caller }}', which is not in state");
  });

  test("test_contract_violation_reaches_llm_as_error", async () => {
    const flow = makeFlow(singleNode({ name: "returns_bare" }));
    const flowManager = makeManager(flow);
    await flowManager.initialize(flow.initialNode);

    const result = await invoke("returns_bare");
    expect(result.status).toBe("error");
    expect(result.error).toContain("must return a (result, next) tuple");
    expect(flowManager.currentNode).toBe("a");
  });

  test("test_hand_built_flow_rejects_the_yaml_sentinel", async () => {
    const flowManager = new FlowManager({ worker: mockWorker as any, llm, contextAggregator });
    await flowManager.initialize();
    const node: NodeConfig = {
      name: "hand_built",
      taskMessages: [{ role: "developer", content: "Order." }],
      functions: [select_pizza_order_tool as any],
    };
    await flowManager.setNodeFromConfig(node);

    const result = await invoke("select_pizza_order", { size: "large", pizza_type: "veg" });
    expect(result.status).toBe("error");
    expect(result.error).toContain("TRANSITION_IN_YAML");
    expect(result.error).toContain("not built from a flow config");
    expect(flowManager.currentNode).toBe("hand_built");
  });
});
