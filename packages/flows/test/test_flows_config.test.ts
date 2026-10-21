// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_flows_config.py

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConstructorError } from "@pipedog/core/utils/yaml";
import { ContextStrategy, FlowConfig, ValidationError } from "@pipedog/flows";

const FOOD_ORDERING = `
initial_node: initial

nodes:
  initial:
    role_message: You are an order-taking assistant for {{ restaurant_name }}.
    task_messages:
      - role: developer
        content: Greet the caller and ask whether they want pizza or sushi.
    pre_actions:
      - type: function
        handler: check_kitchen_status
    functions:
      - name: choose_pizza
        transition_to: choose_pizza
      - name: choose_sushi
        transition_to: choose_sushi

  choose_pizza:
    task_messages:
      - role: developer
        content: Take a pizza order.
    functions:
      - name: select_pizza_order
        transition_to:
          field: status
          cases:
            ok: confirm
            unavailable: choose_pizza
          default: confirm

  choose_sushi:
    task_messages:
      - role: developer
        content: Take a sushi order.
    context_strategy: reset
    respond_immediately: false
    functions:
      - name: select_sushi_order
        transition_to: confirm

  confirm:
    task_messages:
      - role: developer
        content: Read the order back.
    functions:
      - name: complete_order
        transition_to: end
      - name: revise_order
        transition_to: initial

  end:
    task_messages:
      - role: developer
        content: Thank the caller.
    post_actions:
      - type: tts_say
        text: Goodbye!
      - type: end_conversation

global_functions:
  - name: get_delivery_estimate
`;

const readFile = (path: string) => readFileSync(path, "utf8");

function minimal(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    initial_node: "a",
    nodes: { a: { task_messages: [{ role: "developer", content: "hi" }] } },
    ...overrides,
  };
}

describe("TestFlowConfigLoading", () => {
  test("test_loads_food_ordering_yaml", () => {
    const config = FlowConfig.fromYaml(FOOD_ORDERING);

    expect(config.initialNode).toBe("initial");
    expect(new Set(Object.keys(config.nodes))).toEqual(
      new Set(["initial", "choose_pizza", "choose_sushi", "confirm", "end"]),
    );

    const initial = config.nodes.initial!;
    expect(initial.roleMessage).toContain("{{ restaurant_name }}");
    expect(initial.functions.map((f) => f.name)).toEqual(["choose_pizza", "choose_sushi"]);
    expect(initial.functions[0]!.transitionTo).toBe("choose_pizza");
    expect(initial.preActions[0]!.type).toBe("function");
    expect(initial.preActions[0]!.handler).toBe("check_kitchen_status");

    const pizza = config.nodes.choose_pizza!.functions[0]!;
    expect(pizza.transitionTo).toBeInstanceOf(FlowConfig.Branch);
    const branch = pizza.transitionTo as InstanceType<typeof FlowConfig.Branch>;
    expect(branch.field).toBe("status");
    expect(branch.cases).toEqual({ ok: "confirm", unavailable: "choose_pizza" });
    expect(branch.default).toBe("confirm");

    const sushi = config.nodes.choose_sushi!;
    expect(sushi.contextStrategy).toBe("reset");
    expect(sushi.contextStrategyEnum()).toBe(ContextStrategy.RESET);
    expect(sushi.respondImmediately).toBe(false);

    const end = config.nodes.end!;
    expect(end.postActions[0]!.type).toBe("tts_say");
    expect(end.postActions[0]!.extras()).toEqual({ text: "Goodbye!" });
    expect(end.postActions[1]!.type).toBe("end_conversation");

    expect(config.globalFunctions.map((f) => f.name)).toEqual(["get_delivery_estimate"]);
    expect(config.globalFunctions[0]!.transitionTo).toBeNull();
  });

  test("test_defaults", () => {
    const config = FlowConfig.modelValidate(minimal());
    const node = config.nodes.a!;
    expect(node.roleMessage).toBeNull();
    expect(config.globalFunctions).toEqual([]);
    expect(node.functions).toEqual([]);
    expect(node.preActions).toEqual([]);
    expect(node.postActions).toEqual([]);
    expect(node.contextStrategy).toBeNull();
    expect(node.contextStrategyEnum()).toBeNull();
    expect(node.respondImmediately).toBe(true);
  });

  test("test_json_round_trip_matches_yaml", () => {
    const fromYaml = FlowConfig.fromYaml(FOOD_ORDERING);
    const fromJson = FlowConfig.fromJson(JSON.stringify(fromYaml.modelDump()));
    expect(fromJson.modelDump()).toEqual(fromYaml.modelDump());
    expect(fromJson).toEqual(fromYaml);
  });

  test("test_from_file_yaml_with_include", () => {
    const d = mkdtempSync(join(tmpdir(), "flows-"));
    writeFileSync(join(d, "greeting.yaml"), "- role: developer\n  content: Greet the caller.\n");
    writeFileSync(
      join(d, "flow.yaml"),
      "initial_node: a\nnodes:\n  a:\n    task_messages: !include greeting.yaml\n",
    );

    const config = FlowConfig.fromFile(join(d, "flow.yaml"), { readFile });
    expect(config.nodes.a!.taskMessages[0]!.content).toBe("Greet the caller.");
  });

  test("test_from_file_json", () => {
    const d = mkdtempSync(join(tmpdir(), "flows-"));
    writeFileSync(join(d, "flow.json"), JSON.stringify(minimal()));
    const config = FlowConfig.fromFile(join(d, "flow.json"), { readFile });
    expect(config.initialNode).toBe("a");
  });

  test("test_from_json_requires_a_mapping", () => {
    expect(() => FlowConfig.fromJson('["just", "a", "list"]')).toThrow(Error);
  });

  test("test_from_yaml_without_base_dir_rejects_include", () => {
    expect(() => FlowConfig.fromYaml("initial_node: a\nnodes: !include nodes.yaml\n")).toThrow(
      ConstructorError,
    );
  });

  test("test_top_level_must_be_mapping", () => {
    expect(() => FlowConfig.fromYaml("- just\n- a list\n")).toThrow("top level must be a mapping");
  });

  test("test_json_schema_is_exportable", () => {
    const schema = FlowConfig.modelJsonSchema() as any;
    expect(schema.required).toEqual(["initial_node", "nodes"]);
    expect(Object.keys(schema.$defs)).toContain("Branch");
  });

  test("test_shipped_schema_file_is_current", () => {
    // The package ships the schema for editors and other tools to vendor; it
    // is upstream's flow_config.schema.json.
    const path = new URL("../src/flow_config.schema.json", import.meta.url);
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...FlowConfig.modelJsonSchema(),
    };
    const expected = `${JSON.stringify(schema, null, 2)}\n`;
    expect(readFileSync(path, "utf8")).toBe(expected);
  });
});

describe("TestFlowConfigValidation", () => {
  function assertInvalid(data: Record<string, unknown>, message: string): void {
    let error: unknown;
    try {
      FlowConfig.modelValidate(data);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect(String((error as Error).message)).toContain(message);
  }

  test("test_initial_node_must_exist", () => {
    assertInvalid(minimal({ initial_node: "missing" }), "initial_node 'missing'");
  });

  test("test_unknown_top_level_key", () => {
    assertInvalid(minimal({ extra_key: 1 }), "extra_key");
  });

  test("test_nodes_required_and_non_empty", () => {
    assertInvalid({ initial_node: "a", nodes: {} }, "nodes");
  });

  test("test_task_messages_required", () => {
    assertInvalid({ initial_node: "a", nodes: { a: {} } }, "task_messages");
  });

  test("test_transition_to_unknown_node", () => {
    const data = minimal();
    data.nodes.a.functions = [{ name: "go", transition_to: "nowhere" }];
    assertInvalid(data, "node 'a' function 'go' transitions to unknown node 'nowhere'");
  });

  test("test_branch_case_to_unknown_node", () => {
    const data = minimal();
    data.nodes.a.functions = [
      { name: "go", transition_to: { field: "s", cases: { x: "nowhere" } } },
    ];
    assertInvalid(data, "unknown node 'nowhere'");
  });

  test("test_branch_default_to_unknown_node", () => {
    const data = minimal();
    data.nodes.a.functions = [
      { name: "go", transition_to: { field: "s", cases: { x: "a" }, default: "zz" } },
    ];
    assertInvalid(data, "unknown node 'zz'");
  });

  test("test_branch_keys_are_canonical_strings", () => {
    const data = minimal();
    // JavaScript object keys are strings: `true` and `3` arrive as "true" and "3".
    data.nodes.a.functions = [
      { name: "go", transition_to: { field: "s", cases: { True: "a", 3: "a", x: "a" } } },
    ];
    const branch = FlowConfig.modelValidate(data).nodes.a!.functions[0]!.transitionTo as any;
    expect(branch.cases).toEqual({ true: "a", 3: "a", x: "a" });
  });

  test("test_yaml_boolean_and_number_keys", () => {
    const config = FlowConfig.fromYaml(
      "initial_node: a\nnodes:\n  a:\n    task_messages: [{role: developer, content: a}]\n" +
        "    functions:\n      - name: go\n        transition_to:\n          field: ok\n" +
        "          cases:\n            true: a\n            0: a\n",
    );
    expect((config.nodes.a!.functions[0]!.transitionTo as any).cases).toEqual({
      true: "a",
      0: "a",
    });
  });

  test("test_branch_requires_cases", () => {
    const data = minimal();
    data.nodes.a.functions = [{ name: "go", transition_to: { field: "s", cases: {} } }];
    assertInvalid(data, "cases");
  });

  test("test_global_function_transition_to_unknown_node", () => {
    const data = minimal({ global_functions: [{ name: "go", transition_to: "nowhere" }] });
    assertInvalid(data, "global_functions function 'go' transitions to unknown node");
  });

  test("test_duplicate_function_in_node", () => {
    const data = minimal();
    data.nodes.a.functions = [{ name: "f" }, { name: "f" }];
    assertInvalid(data, "duplicate function 'f' in node");
  });

  test("test_duplicate_global_function", () => {
    const data = minimal({ global_functions: [{ name: "f" }, { name: "f" }] });
    assertInvalid(data, "duplicate function 'f' in global_functions");
  });

  test("test_node_function_collides_with_global", () => {
    const data = minimal({ global_functions: [{ name: "f" }] });
    data.nodes.a.functions = [{ name: "f" }];
    assertInvalid(data, "node 'a' function 'f' is also a global function");
  });

  test("test_function_rejects_unknown_keys", () => {
    const data = minimal();
    data.nodes.a.functions = [{ name: "f", parameters: {} }];
    assertInvalid(data, "parameters");
  });

  test("test_description_only_on_transition_only_function", () => {
    const data = minimal();
    data.nodes.a.functions = [{ name: "f", description: "d", transition_to: "a" }];
    assertInvalid(data, "only a transition_only function takes");
  });

  test("test_transition_only_function_needs_description", () => {
    const data = minimal();
    data.nodes.a.functions = [{ name: "f", transition_only: true, transition_to: "a" }];
    assertInvalid(data, "needs a description");
  });

  test("test_transition_only_function_needs_a_node_name", () => {
    const data = minimal();
    data.nodes.a.functions = [{ name: "f", transition_only: true, description: "d" }];
    assertInvalid(data, "must name the node it transitions to");
    data.nodes.a.functions = [
      {
        name: "f",
        transition_only: true,
        description: "d",
        transition_to: { field: "x", cases: { y: "a" } },
      },
    ];
    assertInvalid(data, "must name the node it transitions to");
  });

  test("test_transition_only_function", () => {
    const data = minimal();
    data.nodes.a.functions = [
      { name: "f", transition_only: true, description: "d", transition_to: "a" },
    ];
    const cfg = FlowConfig.modelValidate(data);
    const func = cfg.nodes.a!.functions[0]!;
    expect(func.transitionOnly).toBe(true);
    expect(func.targets()).toEqual(["a"]);
  });

  test("test_function_action_requires_handler", () => {
    const data = minimal();
    data.nodes.a.pre_actions = [{ type: "function" }];
    assertInvalid(data, "a 'function' action requires a 'handler' name");
  });

  test("test_built_in_actions_reject_handler", () => {
    for (const builtIn of ["tts_say", "end_conversation"]) {
      const data = minimal();
      data.nodes.a.post_actions = [{ type: builtIn, handler: "x" }];
      assertInvalid(data, `the built-in '${builtIn}' action does not take a 'handler'`);
    }
  });

  test("test_custom_action_may_name_a_handler", () => {
    const data = minimal();
    data.nodes.a.post_actions = [
      { type: "notify", handler: "notify_slack", channel: "#x" },
      { type: "audit" },
    ];
    const actions = FlowConfig.modelValidate(data).nodes.a!.postActions;
    expect(actions[0]!.handler).toBe("notify_slack");
    expect(actions[0]!.registeredInCode).toBe(false);
    expect(actions[1]!.registeredInCode).toBe(true);
    expect(actions[0]!.extras()).toEqual({ channel: "#x" });
  });

  test("test_context_strategy_values", () => {
    const data = minimal();
    data.nodes.a.context_strategy = "reset_with_summary";
    assertInvalid(data, "context_strategy");
  });
});
