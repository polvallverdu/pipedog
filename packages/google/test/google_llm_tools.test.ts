// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The tools the adapter builds (upstream's snake_case `function_declarations`)
// reach the JS SDK in the camelCase form it reads; otherwise the SDK drops them
// and the model is never offered a function.

import { expect, test } from "bun:test";
import { GoogleLLMService } from "../src/llm.ts";

test("tool keys are converted for the JS SDK", () => {
  const service: any = new GoogleLLMService({ apiKey: "test-key" });
  const declaration = { name: "lookup", description: "d", parameters: { type: "object" } };
  const config = service._toGenerateContentConfig({
    tools: [{ function_declarations: [declaration] }, { google_search: {} }],
  });
  expect(config.tools).toEqual([{ functionDeclarations: [declaration] }, { googleSearch: {} }]);
});
