// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_function_calling_adapters.py

/**
 * PORTING NOTES:
 * - The OpenAI, Gemini, Bedrock and Inworld adapters are imported by relative
 *   path from `@pipedog/openai`, `@pipedog/google`, `@pipedog/aws` and
 *   `@pipedog/inworld`, which this package does not depend on.
 * - `ChatCompletionToolParam(...)`, `FunctionToolParam(...)` and
 *   `ToolSearchToolParam(...)` are TypedDicts, so they are plain objects here.
 * - loguru's `logger.add(sink, level="WARNING", format="{message}")` becomes
 *   `logger.addSink` collecting WARNING-and-above messages.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { FunctionSchema } from "@pipedog/core/adapters/llm/schemas/function_schema";
import { AdapterType, ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import { OpenAILLMAdapter } from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import { LOG_LEVELS, type LogLevel, logger } from "@pipedog/core/utils/logger";

import { AWSBedrockLLMAdapter } from "../../aws/src/bedrock_adapter.ts";
import { GeminiLLMAdapter } from "../../google/src/gemini_adapter.ts";
import { InworldRealtimeLLMAdapter } from "../../inworld/src/inworld_realtime_adapter.ts";
import { OpenAIRealtimeLLMAdapter } from "../../openai/src/open_ai_realtime_adapter.ts";
import { OpenAIResponsesLLMAdapter } from "../../openai/src/open_ai_responses_adapter.ts";
import { AnthropicLLMAdapter } from "../src/anthropic_adapter.ts";

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

  test("test_openai_adapter", () => {
    // Test OpenAI adapter format transformation.
    const expected = [
      {
        type: "function",
        function: {
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
      },
    ];
    expect(new OpenAILLMAdapter().toProviderToolsFormat(toolsDef)).toEqual(expected);
  });

  test("test_anthropic_adapter", () => {
    // Test Anthropic adapter format transformation.
    const expected = [
      {
        name: "get_weather",
        description: "Get the weather in a given location",
        input_schema: {
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
    expect(new AnthropicLLMAdapter().toProviderToolsFormat(toolsDef)).toEqual(expected);
  });

  test("test_gemini_adapter", () => {
    // Test Gemini adapter format transformation.
    const expected = [
      {
        function_declarations: [
          {
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
        ],
      },
    ];
    expect(new GeminiLLMAdapter().toProviderToolsFormat(toolsDef)).toEqual(expected);
  });

  test("test_gemini_adapter_strips_keys_gemini_rejects", () => {
    // Test Gemini adapter dropping schema keys Gemini's validation rejects.
    const functionDef = new FunctionSchema({
      name: "get_file_contents",
      description: "Get the contents of a file",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner",
          "x-mcp-header": "owner",
        },
        // A parameter whose name looks like a vendor extension is still a
        // parameter, so it survives.
        "x-api-key": { type: "string", description: "Caller's API key" },
        options: {
          type: "object",
          additionalProperties: false,
          properties: { "x-ref": { type: "string" } },
        },
      },
      required: ["owner"],
    });
    const expected = [
      {
        function_declarations: [
          {
            name: "get_file_contents",
            description: "Get the contents of a file",
            parameters: {
              type: "object",
              properties: {
                owner: { type: "string", description: "Repository owner" },
                "x-api-key": {
                  type: "string",
                  description: "Caller's API key",
                },
                options: {
                  type: "object",
                  properties: { "x-ref": { type: "string" } },
                },
              },
              required: ["owner"],
            },
          },
        ],
      },
    ];
    const toolsDef = new ToolsSchema({ standardTools: [functionDef] });
    expect(new GeminiLLMAdapter().toProviderToolsFormat(toolsDef)).toEqual(expected);
  });

  test("test_gemini_adapter_translates_constructs_gemini_rejects", () => {
    // Test Gemini adapter rewriting schema constructs Gemini can't express.
    const functionDef = new FunctionSchema({
      name: "issue_write",
      description: "Set or clear issue fields",
      properties: {
        // Gemini takes one type per schema, so a union becomes anyOf.
        value: {
          type: ["string", "number", "boolean"],
          description: "Value to set",
        },
        // Gemini's enum members are strings; a boolean one can't be
        // rendered, so the constraint is dropped and the type kept.
        delete: { type: "boolean", enum: [true], description: "Clear the field" },
        // A string enum is representable and passes through untouched.
        mode: { type: "string", enum: ["create", "update"] },
      },
      required: ["value"],
    });
    const expected = [
      {
        function_declarations: [
          {
            name: "issue_write",
            description: "Set or clear issue fields",
            parameters: {
              type: "object",
              properties: {
                value: {
                  anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
                  description: "Value to set",
                },
                delete: {
                  type: "boolean",
                  description: "Clear the field",
                },
                mode: { type: "string", enum: ["create", "update"] },
              },
              required: ["value"],
            },
          },
        ],
      },
    ];
    const toolsDef = new ToolsSchema({ standardTools: [functionDef] });
    expect(new GeminiLLMAdapter().toProviderToolsFormat(toolsDef)).toEqual(expected);
  });

  test("test_gemini_adapter_warns_once_per_adapted_tool", () => {
    // Test Gemini adapter reporting adapted schemas without repeating itself.
    const functionDef = new FunctionSchema({
      name: "issue_write",
      description: "Set or clear issue fields",
      properties: { value: { type: ["string", "number"], "x-mcp-header": "value" } },
      required: [],
    });
    const toolsDef = new ToolsSchema({ standardTools: [functionDef] });
    const adapter = new GeminiLLMAdapter();

    const convertCapturingWarnings = (): string => {
      // loguru's sink level applies whatever the global level is.
      const previous = (Object.keys(LOG_LEVELS) as LogLevel[])
        .sort((a, b) => LOG_LEVELS[a] - LOG_LEVELS[b])
        .find((l) => logger.isEnabledFor(l));
      logger.setLevel("TRACE");
      let sink = "";
      const remove = logger.addSink((record) => {
        if (LOG_LEVELS[record.level] >= LOG_LEVELS.WARNING) sink += `${record.message}\n`;
      });
      try {
        adapter.toProviderToolsFormat(toolsDef);
      } finally {
        remove();
        if (previous) logger.setLevel(previous);
      }
      return sink;
    };

    const warned = convertCapturingWarnings();
    expect(warned).toContain("issue_write");
    expect(warned).toContain("anyOf");
    expect(warned).toContain("x-mcp-header");

    // The same tools on a later inference don't warn again.
    expect(convertCapturingWarnings()).toEqual("");
  });

  test("test_openai_realtime_adapter", () => {
    // Test Anthropic adapter format transformation.
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
    expect(new OpenAIRealtimeLLMAdapter().toProviderToolsFormat(toolsDef)).toEqual(expected);
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

  test("test_gemini_adapter_with_custom_tools", () => {
    // Test Gemini adapter format transformation.
    const searchTool = { google_search: {} };
    const expected = [
      {
        function_declarations: [
          {
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
        ],
      },
      searchTool,
    ];
    const tools = toolsDef;
    tools.customTools = { [AdapterType.GEMINI]: [searchTool] };
    expect(new GeminiLLMAdapter().toProviderToolsFormat(tools)).toEqual(expected);
  });

  test("test_openai_adapter_with_custom_tools", () => {
    // Test OpenAI adapter appends custom tools.
    const toolSearch = { type: "tool_search" };
    const expected = [
      {
        type: "function",
        function: {
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
      },
      toolSearch,
    ];
    const tools = toolsDef;
    tools.customTools = { [AdapterType.OPENAI]: [toolSearch] };
    expect(new OpenAILLMAdapter().toProviderToolsFormat(tools)).toEqual(expected);
  });

  test("test_openai_responses_adapter_with_custom_tools", () => {
    // Test OpenAI Responses adapter appends custom tools.
    const toolSearch = { type: "tool_search" };
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
        strict: null,
      },
      { type: "tool_search" },
    ];
    const tools = toolsDef;
    tools.customTools = { [AdapterType.OPENAI]: [toolSearch] };
    expect(new OpenAIResponsesLLMAdapter().toProviderToolsFormat(tools)).toEqual(expected);
  });

  test("test_openai_responses_adapter", () => {
    // Test OpenAI Responses adapter format transformation.
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
        strict: null,
      },
    ];
    expect(new OpenAIResponsesLLMAdapter().toProviderToolsFormat(toolsDef)).toEqual(expected);
  });

  test("test_openai_realtime_adapter_with_custom_tools", () => {
    // Test OpenAI Realtime adapter appends custom tools.
    const toolSearch = { type: "tool_search" };
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
      toolSearch,
    ];
    const tools = toolsDef;
    tools.customTools = { [AdapterType.OPENAI]: [toolSearch] };
    expect(new OpenAIRealtimeLLMAdapter().toProviderToolsFormat(tools)).toEqual(expected);
  });

  test("test_openai_adapter_ignores_other_adapter_custom_tools", () => {
    // Test that OpenAI adapter ignores custom tools for other adapters.
    const expected = new OpenAILLMAdapter().toProviderToolsFormat(toolsDef);
    const tools = toolsDef;
    tools.customTools = { [AdapterType.GEMINI]: [{ google_search: {} }] };
    expect(new OpenAILLMAdapter().toProviderToolsFormat(tools)).toEqual(expected);
  });

  test("test_bedrock_adapter", () => {
    // Test AWS Bedrock adapter format transformation.
    const expected = [
      {
        toolSpec: {
          name: "get_weather",
          description: "Get the weather in a given location",
          inputSchema: {
            json: {
              type: "object",
              properties: {
                format: {
                  type: "string",
                  enum: ["celsius", "fahrenheit"],
                  description: "The temperature unit to use.",
                },
                location: {
                  type: "string",
                  description: "The city, e.g. San Francisco",
                },
              },
              required: ["location", "format"],
            },
          },
        },
      },
    ];
    expect(new AWSBedrockLLMAdapter().toProviderToolsFormat(toolsDef)).toEqual(expected);
  });
});
