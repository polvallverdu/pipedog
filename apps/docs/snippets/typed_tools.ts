// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/concepts/typed-tools.mdx. Type-checked on every docs build.

import { defineTool, registerTools } from "@pipedog/core/adapters/llm/schemas/standard_tool";
import { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import { z } from "zod";

const llm = new OpenAILLMService({ apiKey: process.env.OPENAI_API_KEY ?? null });

// #region define
const getWeather = defineTool({
  name: "get_weather",
  description: "Get the current weather for a location.",
  parameters: z.object({
    location: z.string().describe("City name, e.g. 'Paris'"),
    unit: z.enum(["celsius", "fahrenheit"]).default("celsius"),
  }),
  // `args` is { location: string; unit: "celsius" | "fahrenheit" }, already validated.
  handler: async ({ location, unit }) => {
    return { location, unit, temperature: 21, conditions: "sunny" };
  },
});
// #endregion define

// #region use
// Advertising the tool registers its handler on the LLM service automatically.
const context = new LLMContext({
  tools: new ToolsSchema({ standardTools: [getWeather] }),
});
// #endregion use

// #region register
// Or register explicitly, with `registerFunction` under the hood.
registerTools(llm, [getWeather]);
// #endregion register

// #region json
// The handler's argument types are inferred; the JSON schema the LLM sees comes from the schema too.
const schemaForLlm = getWeather.toDefaultDict();
// #endregion json

// #region converter
const search = defineTool({
  name: "search",
  description: "Search the knowledge base.",
  parameters: v.object({ query: v.string() }),
  // This schema doesn't provide a JSON schema itself: pass a converter (or the object).
  jsonSchema: (schema) => toJsonSchema(schema) as Record<string, unknown>,
  handler: async ({ query }) => ({ hits: [query] }),
});

// #endregion converter

export { context, schemaForLlm, search };
