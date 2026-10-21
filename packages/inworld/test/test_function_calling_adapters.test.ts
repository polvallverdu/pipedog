// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_function_calling_adapters.py

/**
 * Upstream's file covers every adapter. This file holds its Inworld Realtime
 * case (`TestFunctionAdapters.test_inworld_realtime_adapter`) and the shared
 * fixture; the other adapters' cases live with their own packages.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { FunctionSchema } from "@pipedog/core/adapters/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";

import { InworldRealtimeLLMAdapter } from "../src/inworld_realtime_adapter.ts";

describe("TestFunctionAdapters", () => {
  let toolsDef: ToolsSchema;

  beforeEach(() => {
    // Sets up a common tools schema for all tests.
    const functionDef = new FunctionSchema({
      name: "get_weather",
      description: "Get the weather in a given location",
      properties: {
        location: { type: "string", description: "The city, e.g. San Francisco" },
        format: {
          type: "string",
          enum: ["celsius", "fahrenheit"],
          description: "The temperature unit to use.",
        },
      },
      required: ["location", "format"],
    });
    toolsDef = new ToolsSchema({ standardTools: [functionDef] });
  });

  test("test_inworld_realtime_adapter", () => {
    // Test Inworld Realtime adapter format transformation.
    const expected = [
      {
        type: "function",
        name: "get_weather",
        description: "Get the weather in a given location",
        parameters: {
          type: "object",
          properties: {
            location: {
              type: "string",
              description: "The city, e.g. San Francisco",
            },
            format: {
              type: "string",
              enum: ["celsius", "fahrenheit"],
              description: "The temperature unit to use.",
            },
          },
          required: ["location", "format"],
        },
      },
    ];
    expect(new InworldRealtimeLLMAdapter().toProviderToolsFormat(toolsDef)).toEqual(expected);
  });
});
