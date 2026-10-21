// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_flows_direct_functions.py

/**
 * Tests for FlowsDirectFunction class.
 *
 * DIVERGENCE: upstream reads a direct function's parameter schemas from its
 * type hints and its descriptions from its docstring. JavaScript has neither,
 * so these tests attach the same information as metadata (`description` and
 * `parameters`, see `DirectFunctionMetadata`), and the first parameter is
 * `flowManager` rather than `flow_manager`.
 */

import { describe, expect, test } from "bun:test";
import { InvalidFunctionError } from "@pipedog/flows/exceptions";
import type { FlowManager } from "@pipedog/flows/manager";
import {
  type ConsolidatedFunctionResult,
  FlowsDirectFunctionWrapper,
  flowsToolOptions,
} from "@pipedog/flows/types";

/** Attach direct-function metadata, as Python's docstring and type hints would. */
function withMeta<F extends (...args: any[]) => any>(
  fn: F,
  meta: { description?: string; parameters?: Record<string, unknown> },
): F {
  return Object.assign(fn, meta);
}

describe("TestFlowsDirectFunction", () => {
  test("test_name_is_set_from_function", () => {
    async function my_function(flowManager: FlowManager): Promise<ConsolidatedFunctionResult> {
      void flowManager;
      return [{ status: "success" }, null];
    }

    expect(FlowsDirectFunctionWrapper.validateFunction(my_function)).toBeUndefined();
    const func = new FlowsDirectFunctionWrapper(my_function);
    expect(func.name).toBe("my_function");
  });

  test("test_description_is_set_from_function", () => {
    const short = withMeta(
      async function my_function_short_description(flowManager: FlowManager) {
        void flowManager;
        return [{ status: "success" }, null] as const;
      },
      { description: "This is a test function." },
    );

    expect(FlowsDirectFunctionWrapper.validateFunction(short)).toBeUndefined();
    let func = new FlowsDirectFunctionWrapper(short);
    expect(func.description).toBe("This is a test function.");

    const long = withMeta(
      async function my_function_long_description(flowManager: FlowManager) {
        void flowManager;
        return [{ status: "success" }, null] as const;
      },
      {
        description: `
            This is a test function.

            It does some really cool stuff.

            Trust me, you'll want to use it.
            `
          .split("\n")
          .map((line) => line.trim())
          .join("\n"),
      },
    );

    expect(FlowsDirectFunctionWrapper.validateFunction(long)).toBeUndefined();
    func = new FlowsDirectFunctionWrapper(long);
    expect(func.description).toBe(
      "This is a test function.\n\nIt does some really cool stuff.\n\nTrust me, you'll want to use it.",
    );
  });

  test("test_properties_are_set_from_function", () => {
    const noParams = async function my_function_no_params(flowManager: FlowManager) {
      void flowManager;
      return [{ status: "success" }, null] as const;
    };

    expect(FlowsDirectFunctionWrapper.validateFunction(noParams)).toBeUndefined();
    let func = new FlowsDirectFunctionWrapper(noParams);
    expect(func.properties).toEqual({});

    const simpleParams = withMeta(
      async function my_function_simple_params(
        flowManager: FlowManager,
        name: string,
        age: number,
        height: number | null,
      ) {
        void [flowManager, name, age, height];
        return [{ status: "success" }, null] as const;
      },
      { parameters: { name: String, age: BigInt, height: [Number, null] } },
    );

    expect(FlowsDirectFunctionWrapper.validateFunction(simpleParams)).toBeUndefined();
    func = new FlowsDirectFunctionWrapper(simpleParams);
    expect(func.properties).toEqual({
      name: { type: "string" },
      age: { type: "integer" },
      height: { anyOf: [{ type: "number" }, { type: "null" }] },
    });

    const complexParams = withMeta(
      async function my_function_complex_params(
        flowManager: FlowManager,
        address_lines: string[],
        nickname: string | number,
        extra: Record<string, string> | null,
      ) {
        void [flowManager, address_lines, nickname, extra];
        return [{ status: "success" }, null] as const;
      },
      {
        parameters: {
          address_lines: { type: "array", items: { type: "string" } },
          nickname: [String, BigInt, Number],
          extra: [{ type: "object", additionalProperties: { type: "string" } }, null],
        },
      },
    );

    expect(FlowsDirectFunctionWrapper.validateFunction(complexParams)).toBeUndefined();
    func = new FlowsDirectFunctionWrapper(complexParams);
    expect(func.properties).toEqual({
      address_lines: { type: "array", items: { type: "string" } },
      nickname: { anyOf: [{ type: "string" }, { type: "integer" }, { type: "number" }] },
      extra: {
        anyOf: [{ type: "object", additionalProperties: { type: "string" } }, { type: "null" }],
      },
    });

    // Python's TypedDict parameters: given here as their JSON schemas.
    const complexTypeParams = withMeta(
      async function my_function_complex_type_params(
        flowManager: FlowManager,
        info1: { name: string; age: number },
        info2: { name?: string; age?: number },
      ) {
        void [flowManager, info1, info2];
        return [{ status: "success" }, null] as const;
      },
      {
        parameters: {
          info1: {
            type: "object",
            properties: { name: { type: "string" }, age: { type: "integer" } },
            required: ["name", "age"],
          },
          info2: {
            type: "object",
            properties: { name: { type: "string" }, age: { type: "integer" } },
          },
        },
      },
    );

    expect(FlowsDirectFunctionWrapper.validateFunction(complexTypeParams)).toBeUndefined();
    func = new FlowsDirectFunctionWrapper(complexTypeParams);
    expect(func.properties).toEqual({
      info1: {
        type: "object",
        properties: { name: { type: "string" }, age: { type: "integer" } },
        required: ["name", "age"],
      },
      info2: {
        type: "object",
        properties: { name: { type: "string" }, age: { type: "integer" } },
      },
    });
  });

  test("test_required_is_set_from_function", () => {
    const noParams = async function my_function_no_params(flowManager: FlowManager) {
      void flowManager;
      return [{ status: "success" }, null] as const;
    };

    expect(FlowsDirectFunctionWrapper.validateFunction(noParams)).toBeUndefined();
    let func = new FlowsDirectFunctionWrapper(noParams);
    expect(func.required).toEqual([]);

    const simpleParams = async function my_function_simple_params(
      flowManager: FlowManager,
      name: string,
      age: number,
      height: number | null = null,
    ) {
      void [flowManager, name, age, height];
      return [{ status: "success" }, null] as const;
    };

    expect(FlowsDirectFunctionWrapper.validateFunction(simpleParams)).toBeUndefined();
    func = new FlowsDirectFunctionWrapper(simpleParams);
    expect(func.required).toEqual(["name", "age"]);

    const complexParams = async function my_function_complex_params(
      flowManager: FlowManager,
      address_lines: string[] | null,
      nickname: string | number = "Bud",
      extra: Record<string, string> | null = null,
    ) {
      void [flowManager, address_lines, nickname, extra];
      return [{ status: "success" }, null] as const;
    };

    expect(FlowsDirectFunctionWrapper.validateFunction(complexParams)).toBeUndefined();
    func = new FlowsDirectFunctionWrapper(complexParams);
    expect(func.required).toEqual(["address_lines"]);
  });

  test("test_property_descriptions_are_set_from_function", () => {
    const fn = withMeta(
      async function my_function(
        flowManager: FlowManager,
        name: string,
        age: number,
        height: number | null,
      ) {
        void [flowManager, name, age, height];
        return [{ status: "success" }, null] as const;
      },
      {
        description: "This is a test function.",
        parameters: {
          name: { type: "string", description: "The name of the person." },
          age: { type: "integer", description: "The age of the person." },
          height: {
            anyOf: [{ type: "number" }, { type: "null" }],
            description: "The height of the person in meters. Defaults to None.",
          },
        },
      },
    );

    expect(FlowsDirectFunctionWrapper.validateFunction(fn)).toBeUndefined();
    const func = new FlowsDirectFunctionWrapper(fn);

    // Validate that the function description is still set correctly
    expect(func.description).toBe("This is a test function.");

    // Validate that the property descriptions are set correctly
    expect(func.properties).toEqual({
      name: { type: "string", description: "The name of the person." },
      age: { type: "integer", description: "The age of the person." },
      height: {
        anyOf: [{ type: "number" }, { type: "null" }],
        description: "The height of the person in meters. Defaults to None.",
      },
    });
  });

  test("test_invalid_functions_fail_validation", () => {
    function my_function_non_async(flowManager: FlowManager) {
      void flowManager;
      return [{ status: "success" }, null] as const;
    }

    expect(() => FlowsDirectFunctionWrapper.validateFunction(my_function_non_async)).toThrow(
      InvalidFunctionError,
    );

    async function my_function_missing_flow_manager() {
      return [{ status: "success" }, null] as const;
    }

    expect(() =>
      FlowsDirectFunctionWrapper.validateFunction(my_function_missing_flow_manager),
    ).toThrow(InvalidFunctionError);

    async function my_function_misplaced_flow_manager(foo: string, flowManager: FlowManager) {
      void [foo, flowManager];
      return [{ status: "success" }, null] as const;
    }

    expect(() =>
      FlowsDirectFunctionWrapper.validateFunction(my_function_misplaced_flow_manager),
    ).toThrow(InvalidFunctionError);
  });

  test("test_invoke_calls_function_with_args_and_flow_manager", async () => {
    const called: Record<string, unknown> = {};

    class DummyFlowManager {}

    async function my_function(flowManager: DummyFlowManager, name: string, age: number) {
      called.flow_manager = flowManager;
      called.name = name;
      called.age = age;
      return [{ status: "success" }, null] as const;
    }

    const func = new FlowsDirectFunctionWrapper(my_function as any);
    const flowManager = new DummyFlowManager();
    // Arguments are matched by name, not by their order in the object.
    const args = { age: 30, name: "Alice" };

    const result = await func.invoke(args, flowManager as any);
    expect(result).toEqual([{ status: "success" }, null]);
    expect(called.flow_manager).toBe(flowManager);
    expect(called.name).toBe("Alice");
    expect(called.age).toBe(30);
  });
});

describe("TestFlowsDirectFunctionDecorator", () => {
  test("test_cancel_on_interruption_defaults_to_false", () => {
    async function my_function(flowManager: FlowManager) {
      void flowManager;
      return [{ status: "success" }, null] as const;
    }

    const func = new FlowsDirectFunctionWrapper(my_function);
    expect(func.cancelOnInterruption).toBe(false);
  });

  test("test_cancel_on_interruption_can_be_set_to_false", () => {
    const fn = flowsToolOptions({ cancelOnInterruption: false })(async function my_function(
      flowManager: FlowManager,
    ) {
      void flowManager;
      return [{ status: "success" }, null] as const;
    });

    const func = new FlowsDirectFunctionWrapper(fn);
    expect(func.cancelOnInterruption).toBe(false);
  });

  test("test_cancel_on_interruption_can_be_explicitly_set_to_true", () => {
    const fn = flowsToolOptions({ cancelOnInterruption: true })(async function my_function(
      flowManager: FlowManager,
    ) {
      void flowManager;
      return [{ status: "success" }, null] as const;
    });

    const func = new FlowsDirectFunctionWrapper(fn);
    expect(func.cancelOnInterruption).toBe(true);
  });

  test("test_decorator_preserves_function_metadata", () => {
    const fn = flowsToolOptions({ cancelOnInterruption: false })(
      withMeta(
        async function my_decorated_function(flowManager: FlowManager, name: string) {
          void [flowManager, name];
          return [{ status: "success" }, null] as const;
        },
        {
          description: "This is a decorated function.",
          parameters: { name: { type: "string", description: "The name to use." } },
        },
      ),
    );

    const func = new FlowsDirectFunctionWrapper(fn);
    expect(func.name).toBe("my_decorated_function");
    expect(func.description).toBe("This is a decorated function.");
    expect(func.properties).toEqual({
      name: { type: "string", description: "The name to use." },
    });
    expect(func.cancelOnInterruption).toBe(false);
  });

  test("test_timeout_secs_defaults_to_none", () => {
    async function my_function(flowManager: FlowManager) {
      void flowManager;
      return [{ status: "success" }, null] as const;
    }

    const func = new FlowsDirectFunctionWrapper(my_function);
    expect(func.timeoutSecs).toBeNull();
  });

  test("test_timeout_secs_can_be_set", () => {
    const fn = flowsToolOptions({ timeoutSecs: 30 })(async function my_function(
      flowManager: FlowManager,
    ) {
      void flowManager;
      return [{ status: "success" }, null] as const;
    });

    const func = new FlowsDirectFunctionWrapper(fn);
    expect(func.timeoutSecs).toBe(30);
  });

  test("test_decorator_preserves_function_metadata_with_timeout", () => {
    const fn = flowsToolOptions({ cancelOnInterruption: false, timeoutSecs: 15.5 })(
      withMeta(
        async function my_decorated_function(flowManager: FlowManager, name: string) {
          void [flowManager, name];
          return [{ status: "success" }, null] as const;
        },
        {
          description: "This is a decorated function.",
          parameters: { name: { type: "string", description: "The name to use." } },
        },
      ),
    );

    const func = new FlowsDirectFunctionWrapper(fn);
    expect(func.name).toBe("my_decorated_function");
    expect(func.description).toBe("This is a decorated function.");
    expect(func.properties).toEqual({
      name: { type: "string", description: "The name to use." },
    });
    expect(func.cancelOnInterruption).toBe(false);
    expect(func.timeoutSecs).toBe(15.5);
  });
});

describe("TestFlowsDirectFunctionDeprecatedAlias", () => {
  // `flows_direct_function` is deprecated upstream (since 1.5.0) and not ported.
  test.skip("test_alias_warns_but_still_attaches_options", () => {});

  test("test_tool_options_does_not_warn", () => {
    const fn = flowsToolOptions({ cancelOnInterruption: false, timeoutSecs: 10 })(
      async function my_function(flowManager: FlowManager) {
        void flowManager;
        return [{ status: "success" }, null] as const;
      },
    );

    const func = new FlowsDirectFunctionWrapper(fn);
    expect(func.timeoutSecs).toBe(10);
  });
});

describe("TestConsolidatedFunctionResult", () => {
  // DIVERGENCE: a regression test for Python's typing.get_type_hints() resolving
  // the ConsolidatedFunctionResult alias; TypeScript types are erased at runtime.
  test.skip("test_get_type_hints_resolves_without_nodeconfig_import", () => {});

  test("test_direct_function_wrapper_accepts_consolidated_return_type", () => {
    async function my_tool(flowManager: FlowManager): Promise<ConsolidatedFunctionResult> {
      void flowManager;
      return [null, null];
    }

    expect(FlowsDirectFunctionWrapper.validateFunction(my_tool)).toBeUndefined();
    new FlowsDirectFunctionWrapper(my_tool);
  });
});
