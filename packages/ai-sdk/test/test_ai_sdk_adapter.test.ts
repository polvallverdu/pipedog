// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// AISDKLLMAdapter: universal LLMContext -> AI SDK instructions, ModelMessages,
// tools and tool choice.

import { describe, expect, test } from "bun:test";
import { FunctionSchema } from "@pipedog/core/adapters/llm/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import { LLMContext, LLMSpecificMessage } from "@pipedog/core/processors/aggregators/llm_context";
import { AI_SDK_LLM_ID, AISDKLLMAdapter } from "../src/ai_sdk_adapter.ts";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

describe("AISDKLLMAdapter", () => {
  test("system instruction wins over an initial system message", async () => {
    const adapter = new AISDKLLMAdapter();
    const context = new LLMContext({
      messages: [
        { role: "system", content: "From context" },
        { role: "user", content: "Hi" },
      ],
    });
    const params = await adapter.getLlmInvocationParams(context, {
      systemInstruction: "From service",
    });
    expect(params.instructions).toBe("From service");
    expect(params.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  test("an initial system message becomes the instructions", async () => {
    const adapter = new AISDKLLMAdapter();
    const context = new LLMContext({
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
        { role: "developer", content: "Later guidance" },
      ],
    });
    const params = await adapter.getLlmInvocationParams(context);
    expect(params.instructions).toBe("Be brief.");
    expect(params.messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "user", content: "Later guidance" },
    ]);
  });

  test("converts images, files, tool calls and tool results", async () => {
    const adapter = new AISDKLLMAdapter();
    const context = new LLMContext({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image_url", image_url: { url: PNG_DATA_URL } },
            {
              type: "file_base64",
              file: {
                file_data: "data:application/pdf;base64,JVBERi0=",
                mime_type: "application/pdf",
                filename: "doc.pdf",
              },
            },
          ],
        },
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "lookup", arguments: '{"q": "x"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: '{"answer": 42}' },
        { role: "assistant", content: "It's 42." },
      ],
    });
    const { messages } = await adapter.getLlmInvocationParams(context);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image", image: "iVBORw0KGgo=", mediaType: "image/png" },
          {
            type: "file",
            data: "JVBERi0=",
            mediaType: "application/pdf",
            filename: "doc.pdf",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { q: "x" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "lookup",
            output: { type: "text", value: '{"answer": 42}' },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "It's 42." }] },
    ]);
  });

  test("converts tools and tool choice", async () => {
    const adapter = new AISDKLLMAdapter();
    const context = new LLMContext({
      messages: [{ role: "user", content: "Hi" }],
      tools: new ToolsSchema({
        standardTools: [
          new FunctionSchema({
            name: "lookup",
            description: "Look something up",
            properties: { q: { type: "string" } },
            required: ["q"],
          }),
        ],
      }),
      toolChoice: { type: "function", function: { name: "lookup" } },
    });
    const params = await adapter.getLlmInvocationParams(context);
    expect(Object.keys(params.tools ?? {})).toEqual(["lookup"]);
    const tool = params.tools!.lookup as any;
    expect(tool.description).toBe("Look something up");
    expect(tool.execute).toBeUndefined();
    expect(tool.inputSchema.jsonSchema).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    });
    expect(params.toolChoice).toEqual({ type: "tool", toolName: "lookup" });
  });

  test("passes AI SDK messages through and applies text provider metadata", async () => {
    const adapter = new AISDKLLMAdapter();
    const raw = { role: "user", content: [{ type: "text", text: "raw" }] };
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Hi" },
        new LLMSpecificMessage({
          llm: AI_SDK_LLM_ID,
          message: {
            type: "provider_metadata",
            providerMetadata: { google: { thoughtSignature: "t" } },
            bookmark: { text: "Hello  there" },
          },
        }),
        { role: "assistant", content: "Hello there" },
        new LLMSpecificMessage({ llm: AI_SDK_LLM_ID, message: raw }),
        new LLMSpecificMessage({ llm: "other", message: { role: "user", content: "skip" } }),
      ],
    });
    const { messages } = await adapter.getLlmInvocationParams(context);
    expect(messages).toEqual([
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello there",
            providerOptions: { google: { thoughtSignature: "t" } },
          },
        ],
      },
      raw,
    ]);
  });
});
