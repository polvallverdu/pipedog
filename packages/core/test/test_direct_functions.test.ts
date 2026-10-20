// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_direct_functions.py

// DIVERGENCE (see adapters/schemas/direct_function.ts): JavaScript has no
// runtime type hints or docstrings, so the descriptions and parameter types
// upstream reads from annotations/docstrings are attached here as
// `DirectFunctionMetadata` (`description`, `parameters`). Python `int` maps to
// `BigInt`, `float` to `Number`, `X | None` to `[X, null]`; generic and
// TypedDict hints are given as the JSON schemas upstream derives from them,
// and per-parameter docstring descriptions as `description` inside them.

import { describe, expect, test } from "bun:test";
import { DirectFunctionWrapper } from "../src/adapters/schemas/direct_function.ts";
import type { FunctionCallParams } from "../src/services/llm_service.ts";

describe("TestDirectFunction", () => {
  test("test_name_is_set_from_function", () => {
    async function my_function(params: FunctionCallParams) {
      void params;
      return [{ status: "success" }, null];
    }

    const func = new DirectFunctionWrapper(my_function);
    expect(func.name).toEqual("my_function");
  });

  test("test_description_is_set_from_function", () => {
    const my_function_short_description = Object.assign(
      async function my_function_short_description(params: FunctionCallParams) {
        void params;
        return [{ status: "success" }, null];
      },
      { description: "This is a test function." },
    );

    let func = new DirectFunctionWrapper(my_function_short_description);
    expect(func.description).toEqual("This is a test function.");

    const my_function_long_description = Object.assign(
      async function my_function_long_description(params: FunctionCallParams) {
        void params;
        return [{ status: "success" }, null];
      },
      {
        description: `
            This is a test function.

            It does some really cool stuff.

            Trust me, you'll want to use it.
            `
          .split("\n")
          .map((l) => l.trim())
          .join("\n"),
      },
    );

    func = new DirectFunctionWrapper(my_function_long_description);
    expect(func.description).toEqual(
      "This is a test function.\n\nIt does some really cool stuff.\n\nTrust me, you'll want to use it.",
    );
  });

  test("test_properties_are_set_from_function", () => {
    async function my_function_no_params(params: FunctionCallParams) {
      void params;
      return [{ status: "success" }, null];
    }

    let func = new DirectFunctionWrapper(my_function_no_params);
    expect(func.properties).toEqual({});

    const my_function_simple_params = Object.assign(
      async function my_function_simple_params(
        params: FunctionCallParams,
        name: string,
        age: number,
        height: number | null,
      ) {
        void [params, name, age, height];
        return [{ status: "success" }, null];
      },
      { parameters: { name: String, age: BigInt, height: [Number, null] } },
    );

    func = new DirectFunctionWrapper(my_function_simple_params);
    expect(func.properties).toEqual({
      name: { type: "string" },
      age: { type: "integer" },
      height: { anyOf: [{ type: "number" }, { type: "null" }] },
    });

    const my_function_complex_params = Object.assign(
      async function my_function_complex_params(
        params: FunctionCallParams,
        address_lines: string[],
        nickname: string | number,
        extra: Record<string, string> | null,
      ) {
        void [params, address_lines, nickname, extra];
        return [{ status: "success" }, null];
      },
      {
        parameters: {
          address_lines: { type: "array", items: { type: "string" } },
          nickname: [String, BigInt, Number],
          extra: [{ type: "object", additionalProperties: { type: "string" } }, null],
        },
      },
    );

    func = new DirectFunctionWrapper(my_function_complex_params);
    expect(func.properties).toEqual({
      address_lines: { type: "array", items: { type: "string" } },
      nickname: {
        anyOf: [{ type: "string" }, { type: "integer" }, { type: "number" }],
      },
      extra: {
        anyOf: [{ type: "object", additionalProperties: { type: "string" } }, { type: "null" }],
      },
    });

    // class MyInfo1(TypedDict): name: str; age: int
    const MyInfo1 = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" } },
      required: ["name", "age"],
    };
    // class MyInfo2(TypedDict, total=False): name: str; age: int
    const MyInfo2 = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" } },
    };

    const my_function_complex_type_params = Object.assign(
      async function my_function_complex_type_params(
        params: FunctionCallParams,
        info1: unknown,
        info2: unknown,
      ) {
        void [params, info1, info2];
        return [{ status: "success" }, null];
      },
      { parameters: { info1: MyInfo1, info2: MyInfo2 } },
    );

    func = new DirectFunctionWrapper(my_function_complex_type_params);
    expect(func.properties).toEqual({
      info1: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
        },
        required: ["name", "age"],
      },
      info2: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
        },
      },
    });
  });

  test("test_required_is_set_from_function", () => {
    async function my_function_no_params(params: FunctionCallParams) {
      void params;
      return [{ status: "success" }, null];
    }

    let func = new DirectFunctionWrapper(my_function_no_params);
    expect(func.required).toEqual([]);

    async function my_function_simple_params(
      params: FunctionCallParams,
      name: string,
      age: number,
      height: number | null = null,
    ) {
      void [params, name, age, height];
      return [{ status: "success" }, null];
    }

    func = new DirectFunctionWrapper(my_function_simple_params);
    expect(func.required).toEqual(["name", "age"]);

    async function my_function_complex_params(
      params: FunctionCallParams,
      address_lines: string[] | null,
      nickname: string | number = "Bud",
      extra: Record<string, string> | null = null,
    ) {
      void [params, address_lines, nickname, extra];
      return [{ status: "success" }, null];
    }

    func = new DirectFunctionWrapper(my_function_complex_params);
    expect(func.required).toEqual(["address_lines"]);
  });

  test("test_property_descriptions_are_set_from_function", () => {
    const my_function = Object.assign(
      async function my_function(
        params: FunctionCallParams,
        name: string,
        age: number,
        height: number | null,
      ) {
        void [params, name, age, height];
        return [{ status: "success" }, null];
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

    const func = new DirectFunctionWrapper(my_function);

    // Validate that the function description is still set correctly even with the longer docstring
    expect(func.description).toEqual("This is a test function.");

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
    function my_function_non_async(params: FunctionCallParams) {
      void params;
      return [{ status: "success" }, null];
    }

    expect(() => new DirectFunctionWrapper(my_function_non_async)).toThrow(/must be async/);

    async function my_function_missing_params() {
      return [{ status: "success" }, null];
    }

    expect(() => new DirectFunctionWrapper(my_function_missing_params)).toThrow(
      /must have at least one parameter/,
    );

    async function my_function_misplaced_params(foo: string, params: FunctionCallParams) {
      void [foo, params];
      return [{ status: "success" }, null];
    }

    expect(() => new DirectFunctionWrapper(my_function_misplaced_params)).toThrow(
      /first parameter must be named/,
    );
  });

  test("test_invoke_calls_function_with_args_and_params_object", async () => {
    const called: Record<string, unknown> = {};

    class DummyParams {}

    async function my_function(params: DummyParams, name: string, age: number) {
      called.params = params;
      called.name = name;
      called.age = age;
      return [{ status: "success" }, null];
    }

    const func = new DirectFunctionWrapper(my_function);
    const params = new DummyParams();
    const args = { name: "Alice", age: 30 };

    const result = await func.invoke(args, params as unknown as FunctionCallParams);
    expect(result).toEqual([{ status: "success" }, null]);
    expect(called.params).toBe(params);
    expect(called.name).toEqual("Alice");
    expect(called.age).toEqual(30);
  });
});
