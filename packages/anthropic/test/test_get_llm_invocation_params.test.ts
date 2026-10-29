// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_get_llm_invocation_params.py

/**
 * Unit tests for LLM adapters' getLlmInvocationParams() method.
 *
 * PORTING NOTES:
 * - Adapters from other packages (`@pipedog/google`, `@pipedog/aws`,
 *   `@pipedog/openai`, ...) are imported by relative path, as in
 *   `test_function_calling_adapters.test.ts`.
 * - `patch("pipecat.adapters.llm.base_llm_adapter.logger")` becomes a spy on
 *   the shared `logger.warning`. Upstream's `DeprecationWarning`s go through
 *   `warnings.warn`, which that mock does not see; here `warnDeprecated` logs
 *   them through the same logger, prefixed with `DeprecationWarning: `, so the
 *   spy leaves those out of the adapter's warning calls, and
 *   `warnings.catch_warnings` becomes collecting exactly those.
 * - Gemini `Content` / `Part` are the JS SDK's plain objects with camelCase
 *   fields (`inlineData`, `functionCall`, `thoughtSignature`, ...); bytes in a
 *   part (`Blob.data`, `thoughtSignature`) are base64 strings.
 * - The OpenAI and Anthropic `NOT_GIVEN` sentinels are `undefined`.
 * - Python's `IndexError` (from `url.split(",")[1]`) is a `RangeError`.
 * - `subTest` loops are plain loops.
 */

import { afterEach, describe, expect, type Mock, spyOn, test } from "bun:test";

import {
  type BaseLLMAdapter,
  LLMContextConversionError,
} from "@pipedog/core/adapters/llm/base_llm_adapter";
import { FunctionSchema } from "@pipedog/core/adapters/llm/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import {
  OPENAI_NOT_GIVEN,
  OpenAILLMAdapter,
} from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import {
  LLMContext,
  LLMSpecificMessage,
  type LLMStandardMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";
import { _warnedSites } from "@pipedog/core/utils/deprecation";
import { FileResolver } from "@pipedog/core/utils/file_resolver";
import { logger } from "@pipedog/core/utils/logger";

import { AWSNovaSonicLLMAdapter } from "../../aws/src/aws_nova_sonic_adapter.ts";
import {
  _sanitizeBedrockDocumentName,
  AWSBedrockLLMAdapter,
} from "../../aws/src/bedrock_adapter.ts";
import { AWSBedrockLLMService } from "../../aws/src/llm.ts";
import { AzureVoiceLiveLLMAdapter } from "../../azure/src/azure_voice_live_adapter.ts";
import { DeepSeekLLMAdapter } from "../../deepseek/src/deepseek_adapter.ts";
import { GeminiLLMAdapter } from "../../google/src/gemini_adapter.ts";
import { GeminiLiveLLMAdapter } from "../../google/src/gemini_live_adapter.ts";
import { GoogleLLMService } from "../../google/src/llm.ts";
import { GrokRealtimeLLMAdapter } from "../../grok/src/grok_realtime_adapter.ts";
import { InworldRealtimeLLMAdapter } from "../../inworld/src/inworld_realtime_adapter.ts";
import { OpenAIRealtimeLLMAdapter } from "../../openai/src/open_ai_realtime_adapter.ts";
import { OpenAIResponsesLLMAdapter } from "../../openai/src/open_ai_responses_adapter.ts";
import { PerplexityLLMAdapter } from "../../perplexity/src/perplexity_adapter.ts";
import { ANTHROPIC_NOT_GIVEN, AnthropicLLMAdapter } from "../src/anthropic_adapter.ts";
import { AnthropicLLMService } from "../src/llm.ts";

type Any = any;

const DEPRECATION_PREFIX = "DeprecationWarning: ";

/**
 * Stand-in for `patch("pipecat.adapters.llm.base_llm_adapter.logger")`:
 * records the adapter's `logger.warning` calls (not deprecation warnings,
 * which upstream emits through `warnings`).
 */
class MockLogger {
  warningCalls: string[] = [];
  deprecations: string[] = [];
  #spy: Mock<(...args: unknown[]) => void>;

  constructor() {
    this.#spy = spyOn(logger, "warning").mockImplementation(((msg: unknown) => {
      const text = String(msg);
      if (text.startsWith(DEPRECATION_PREFIX)) {
        this.deprecations.push(text.slice(DEPRECATION_PREFIX.length));
      } else {
        this.warningCalls.push(text);
      }
    }) as Any) as Any;
  }

  /** `mock_logger.warning.call_args[0][0]`. */
  get lastWarning(): string {
    return this.warningCalls.at(-1) as string;
  }

  restore(): void {
    this.#spy.mockRestore();
  }
}

let activeMock: MockLogger | null = null;

/** Runs `fn` with the logger patched, like `with patch(...) as mock_logger:`. */
async function withMockLogger<T>(fn: (mock: MockLogger) => Promise<T> | T): Promise<T> {
  const mock = new MockLogger();
  activeMock = mock;
  try {
    return await fn(mock);
  } finally {
    mock.restore();
    activeMock = null;
  }
}

afterEach(() => {
  activeMock?.restore();
  activeMock = null;
});

/** `with self.assertRaises(E) as ctx: await fn()`, returning `ctx.exception`. */
async function assertRaises<E extends Error>(
  cls: new (...args: Any[]) => E,
  fn: () => Promise<unknown>,
): Promise<E> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(cls);
  return caught as E;
}

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("TestOpenAIGetLLMInvocationParams", () => {
  // In production, BaseOpenAILLMService always passes convertDeveloperToUser
  // to the adapter (true or false depending on the service's supportsDeveloperRole).
  // Tests below use false to simulate native OpenAI usage, except for the
  // developer-conversion-specific tests which use true.

  let adapter: OpenAILLMAdapter;
  const setUp = () => {
    adapter = new OpenAILLMAdapter();
  };

  test("test_unsupported_file_mime_type_raises_conversion_error", async () => {
    // An unsupported file MIME type raises instead of silently dropping the file.
    setUp();
    const message = {
      role: "user",
      content: [
        { type: "text", text: "please summarize" },
        {
          type: "file_base64",
          file: {
            file_data: "data:text/plain;base64,aGVsbG8=",
            filename: "notes.txt",
            mime_type: "text/plain",
          },
        },
      ],
    };
    const context = new LLMContext({ messages: [message as Any] });

    const exc = await assertRaises(LLMContextConversionError, () =>
      adapter.getLlmInvocationParams(context, { convertDeveloperToUser: false }),
    );

    expect(String(exc.message)).toContain("Unsupported 'file' MIME type");
  });

  test("test_unsupported_file_url_raises_conversion_error", async () => {
    // A file_url message raises instead of silently dropping the file.
    setUp();
    const message = {
      role: "user",
      content: [
        {
          type: "file_url",
          file: { url: "https://example.com/doc.pdf", mime_type: "application/pdf" },
        },
      ],
    };
    const context = new LLMContext({ messages: [message as Any] });

    const exc = await assertRaises(LLMContextConversionError, () =>
      adapter.getLlmInvocationParams(context, { convertDeveloperToUser: false }),
    );

    expect(exc.message).toContain("Unresolved file URL");
  });

  test("test_image_file_url_converted_to_image_url", async () => {
    // A file_url with an image MIME type becomes image_url content.
    setUp();
    const message = {
      role: "user",
      content: [
        {
          type: "file_url",
          file: { url: "https://example.com/photo.jpg", mime_type: "image/jpeg" },
        },
      ],
    };
    const context = new LLMContext({ messages: [message as Any] });

    const params: Any = await adapter.getLlmInvocationParams(context, {
      convertDeveloperToUser: false,
    });

    const content = params.messages[0].content;
    expect(content[0].type).toEqual("image_url");
    expect(content[0].image_url.url).toEqual("https://example.com/photo.jpg");
  });

  test("test_image_file_base64_converted_to_image_url", async () => {
    // An inline image file becomes image_url content with a data URL.
    setUp();
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const message = {
      role: "user",
      content: [
        {
          type: "file_base64",
          file: { file_data: dataUrl, filename: "a.png", mime_type: "image/png" },
        },
      ],
    };
    const context = new LLMContext({ messages: [message as Any] });

    const params: Any = await adapter.getLlmInvocationParams(context, {
      convertDeveloperToUser: false,
    });

    const content = params.messages[0].content;
    expect(content[0].type).toEqual("image_url");
    expect(content[0].image_url.url).toEqual(dataUrl);
  });

  test("test_standard_messages_passed_through_unchanged", async () => {
    // LLMStandardMessage objects are passed through unchanged to OpenAI params.
    setUp();
    const standardMessages: LLMStandardMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello, how are you?" },
      { role: "assistant", content: "I'm doing well, thank you for asking!" },
    ];

    const context = new LLMContext({ messages: standardMessages });

    const params: Any = await adapter.getLlmInvocationParams(context, {
      convertDeveloperToUser: false,
    });

    // Verify messages are passed through unchanged
    expect(params.messages).toEqual(standardMessages);
    expect(params.messages.length).toEqual(3);

    // Verify content matches exactly
    expect(params.messages[0].content).toEqual("You are a helpful assistant.");
    expect(params.messages[1].content).toEqual("Hello, how are you?");
    expect(params.messages[2].content).toEqual("I'm doing well, thank you for asking!");
  });

  test("test_tools_absent_yields_openai_sentinel", async () => {
    // A context without tools yields the sentinel the SDK omits from the request.
    setUp();
    const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });
    const params = await adapter.getLlmInvocationParams(context, {
      convertDeveloperToUser: false,
    });

    expect(params.tools).toBe(OPENAI_NOT_GIVEN);
  });

  test("test_llm_specific_message_filtering", async () => {
    // OpenAI-specific messages are included and others are filtered out.
    setUp();
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      new AnthropicLLMAdapter().createLlmSpecificMessage({
        role: "user",
        content: "Anthropic specific message",
      }),
      new GeminiLLMAdapter().createLlmSpecificMessage({
        role: "user",
        content: "Gemini specific message",
      }),
      { role: "user", content: "Standard user message" },
      adapter.createLlmSpecificMessage({ role: "assistant", content: "OpenAI specific response" }),
    ];

    const context = new LLMContext({ messages: messages as Any });

    const params: Any = await adapter.getLlmInvocationParams(context, {
      convertDeveloperToUser: false,
    });

    // Should only include standard messages and OpenAI-specific ones
    // (3 total: system, standard user, openai assistant)
    expect(params.messages.length).toEqual(3);

    expect(params.messages[0].content).toEqual("You are a helpful assistant.");
    expect(params.messages[1].content).toEqual("Standard user message");
    expect(params.messages[2]).toEqual({ role: "assistant", content: "OpenAI specific response" });
  });

  test("test_complex_message_content_preserved", async () => {
    // Complex message content (like multi-part messages) is preserved.
    setUp();
    const complexImageMessage = {
      role: "user",
      content: [
        { type: "text", text: "What's in this image?" },
        {
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD..." },
        },
      ],
    };

    const multiTextMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me analyze this step by step:" },
        { type: "text", text: "1. First, I'll examine the visual elements" },
        { type: "text", text: "2. Then I'll provide my conclusions" },
      ],
    };

    const messages = [
      { role: "system", content: "You are a helpful assistant that can analyze images." },
      complexImageMessage,
      multiTextMessage,
    ];

    const context = new LLMContext({ messages: messages as Any });

    const params: Any = await adapter.getLlmInvocationParams(context, {
      convertDeveloperToUser: false,
    });

    expect(params.messages.length).toEqual(3);
    expect(params.messages[1]).toEqual(complexImageMessage);
    expect(params.messages[2]).toEqual(multiTextMessage);

    const imageContent = params.messages[1].content;
    expect(Array.isArray(imageContent)).toBe(true);
    expect(imageContent.length).toEqual(2);
    expect(imageContent[0].type).toEqual("text");
    expect(imageContent[1].type).toEqual("image_url");

    const textContent = params.messages[2].content;
    expect(Array.isArray(textContent)).toBe(true);
    expect(textContent.length).toEqual(3);
    for (const textBlock of textContent) {
      expect(textBlock.type).toEqual("text");
    }
    expect(textContent[0].text).toEqual("Let me analyze this step by step:");
    expect(textContent[1].text).toEqual("1. First, I'll examine the visual elements");
    expect(textContent[2].text).toEqual("2. Then I'll provide my conclusions");
  });

  test("test_system_instructions_preserved_throughout_messages", async () => {
    // OpenAI adapter preserves system instructions sprinkled throughout messages.
    setUp();
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello!" },
      { role: "assistant", content: "Hi there!" },
      { role: "system", content: "Remember to be concise." },
      { role: "user", content: "Tell me about Python." },
      { role: "system", content: "Use simple language." },
      { role: "assistant", content: "Python is a programming language." },
    ];

    const context = new LLMContext({ messages });

    const params: Any = await adapter.getLlmInvocationParams(context, {
      convertDeveloperToUser: false,
    });

    expect(params.messages.length).toEqual(7);

    expect(params.messages[0].role).toEqual("system");
    expect(params.messages[0].content).toEqual("You are a helpful assistant.");

    expect(params.messages[3].role).toEqual("system");
    expect(params.messages[3].content).toEqual("Remember to be concise.");

    expect(params.messages[5].role).toEqual("system");
    expect(params.messages[5].content).toEqual("Use simple language.");

    expect(params.messages[1].role).toEqual("user");
    expect(params.messages[2].role).toEqual("assistant");
    expect(params.messages[4].role).toEqual("user");
    expect(params.messages[6].role).toEqual("assistant");
  });

  test("test_system_instruction_only", async () => {
    // system_instruction alone is prepended as a system message.
    setUp();
    const messages: LLMStandardMessage[] = [{ role: "user", content: "Hello" }];
    const context = new LLMContext({ messages });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      systemInstruction: "Be helpful.",
      convertDeveloperToUser: false,
    });

    expect(params.messages[0].role).toEqual("system");
    expect(params.messages[0].content).toEqual("Be helpful.");
    expect(params.messages[1].role).toEqual("user");
  });

  test("test_initial_system_message_only", async () => {
    // Initial system message without system_instruction passes through.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      convertDeveloperToUser: false,
    });

    expect(params.messages.length).toEqual(2);
    expect(params.messages[0].role).toEqual("system");
    expect(params.messages[0].content).toEqual("You are helpful.");
  });

  test("test_both_system_instruction_and_system_message_warns", async () => {
    // system_instruction + initial system message warns but allows both.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    const params: Any = await withMockLogger(async (mockLogger) => {
      const params = await adapter.getLlmInvocationParams(context, {
        systemInstruction: "Be concise.",
        convertDeveloperToUser: false,
      });
      expect(mockLogger.warningCalls.length).toEqual(1);
      expect(mockLogger.lastWarning).toContain("may be unintended");
      return params;
    });

    // Both are present: prepended system_instruction + original system message
    expect(params.messages[0].content).toEqual("Be concise.");
    expect(params.messages[1].content).toEqual("You are helpful.");
  });

  test("test_both_system_instruction_and_developer_message_no_warning", async () => {
    // system_instruction + initial developer message does NOT warn.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "developer", content: "Extra context." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    const params: Any = await withMockLogger(async (mockLogger) => {
      const params = await adapter.getLlmInvocationParams(context, {
        systemInstruction: "Be concise.",
        convertDeveloperToUser: false,
      });
      expect(mockLogger.warningCalls).toEqual([]);
      return params;
    });

    // system_instruction prepended, developer message stays in messages
    expect(params.messages[0].content).toEqual("Be concise.");
    expect(params.messages[1].role).toEqual("developer");
  });

  test("test_warning_fires_only_once", async () => {
    // Conflict warning fires only once per adapter instance.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    await withMockLogger(async (mockLogger) => {
      await adapter.getLlmInvocationParams(context, {
        systemInstruction: "Be concise.",
        convertDeveloperToUser: false,
      });
      await adapter.getLlmInvocationParams(context, {
        systemInstruction: "Be concise.",
        convertDeveloperToUser: false,
      });
      expect(mockLogger.warningCalls.length).toEqual(1);
    });
  });

  test("test_developer_messages_converted_to_user", async () => {
    // Developer messages are converted to user role when convertDeveloperToUser is true.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "developer", content: "Extra context." },
      { role: "user", content: "Hello" },
    ];

    const context = new LLMContext({ messages });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      convertDeveloperToUser: true,
    });

    expect(params.messages[0].role).toEqual("user");
    expect(params.messages[0].content).toEqual("Extra context.");
    expect((context.getMessages()[0] as Any).role).toEqual("developer");
  });

  test("test_developer_conversion_does_not_affect_other_roles", async () => {
    // convertDeveloperToUser only affects developer messages, not system/user/assistant.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "System prompt." },
      { role: "developer", content: "Dev guidance." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];

    const context = new LLMContext({ messages });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      convertDeveloperToUser: true,
    });

    expect(params.messages[0].role).toEqual("system");
    expect(params.messages[1].role).toEqual("user");
    expect(params.messages[1].content).toEqual("Dev guidance.");
    expect(params.messages[2].role).toEqual("user");
    expect(params.messages[3].role).toEqual("assistant");
  });
});

describe("TestGeminiGetLLMInvocationParams", () => {
  let adapter: Any;
  const setUp = () => {
    adapter = new GeminiLLMAdapter();
  };

  test("test_malformed_message_raises_conversion_error", async () => {
    // A malformed message raises LLMContextConversionError, preserving the underlying cause.
    setUp();
    // A data URL with no comma has no base64 payload, so the adapter's
    // url.split(",")[1] raises IndexError during conversion.
    const malformedMessage = {
      role: "user",
      content: [
        { type: "text", text: "What's in this image?" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64" } },
      ],
    };
    const context = new LLMContext({ messages: [malformedMessage as Any] });

    const exc = await assertRaises(LLMContextConversionError, () =>
      adapter.getLlmInvocationParams(context),
    );

    // The underlying cause is preserved for debugging.
    expect(exc.cause).toBeInstanceOf(RangeError);
    expect(exc.message).toContain("Error mapping context messages to provider format");
  });

  test("test_standard_messages_converted_to_gemini_format", async () => {
    // LLMStandardMessage objects are converted to Gemini Content format.
    setUp();
    const standardMessages: LLMStandardMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello, how are you?" },
      { role: "assistant", content: "I'm doing well, thank you for asking!" },
    ];

    const context = new LLMContext({ messages: standardMessages });

    const params = await adapter.getLlmInvocationParams(context);

    expect(params.system_instruction).toEqual("You are a helpful assistant.");

    // Verify messages are converted to Gemini format (2 messages: user + model)
    expect(params.messages.length).toEqual(2);

    // `Content` is a plain object in the JS SDK.
    const userMsg = params.messages[0];
    expect(typeof userMsg).toBe("object");
    expect(userMsg.role).toEqual("user");
    expect(userMsg.parts.length).toEqual(1);
    expect(userMsg.parts[0].text).toEqual("Hello, how are you?");

    const modelMsg = params.messages[1];
    expect(typeof modelMsg).toBe("object");
    expect(modelMsg.role).toEqual("model");
    expect(modelMsg.parts.length).toEqual(1);
    expect(modelMsg.parts[0].text).toEqual("I'm doing well, thank you for asking!");
  });

  test("test_llm_specific_message_filtering", async () => {
    // Gemini-specific messages are included and others are filtered out.
    setUp();
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      new OpenAILLMAdapter().createLlmSpecificMessage({
        role: "user",
        content: "OpenAI specific message",
      }),
      new AnthropicLLMAdapter().createLlmSpecificMessage({
        role: "user",
        content: "Anthropic specific message",
      }),
      { role: "user", content: "Standard user message" },
      adapter.createLlmSpecificMessage({
        role: "model",
        parts: [{ text: "Gemini specific response" }],
      }),
    ];

    const context = new LLMContext({ messages: messages as Any });

    const params = await adapter.getLlmInvocationParams(context);

    // (2 total: converted standard user + gemini model)
    expect(params.messages.length).toEqual(2);

    expect(params.system_instruction).toEqual("You are a helpful assistant.");

    expect(params.messages[0].role).toEqual("user");
    expect(params.messages[0].parts[0].text).toEqual("Standard user message");

    expect(params.messages[1].role).toEqual("model");
    expect(params.messages[1].parts[0].text).toEqual("Gemini specific response");
  });

  test("test_complex_message_content_preserved", async () => {
    // Complex message content (image, audio, multi-text) is preserved and converted.
    setUp();
    const complexImageMessage = {
      role: "user",
      content: [
        { type: "text", text: "What's in this image?" },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${PNG_1X1}` } },
      ],
    };

    const multiTextMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me analyze this step by step:" },
        { type: "text", text: "1. First, I'll examine the visual elements" },
        { type: "text", text: "2. Then I'll provide my conclusions" },
      ],
    };

    // Using a minimal valid base64 audio data (16 bytes of WAV header)
    const audioMessage = {
      role: "user",
      content: [
        { type: "text", text: "Can you transcribe this audio?" },
        {
          type: "input_audio",
          input_audio: {
            data: "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=",
            format: "wav",
          },
        },
      ],
    };

    const messages = [
      { role: "system", content: "You are a helpful assistant that can analyze images and audio." },
      complexImageMessage,
      multiTextMessage,
      audioMessage,
    ];

    const context = new LLMContext({ messages: messages as Any });

    const params = await adapter.getLlmInvocationParams(context);

    expect(params.system_instruction).toEqual(
      "You are a helpful assistant that can analyze images and audio.",
    );

    // Note: Gemini adapter may add system instruction back as user message in some cases
    expect(params.messages.length).toBeGreaterThanOrEqual(3);

    let userWithImage: Any = null;
    let modelWithText: Any = null;
    let userWithAudio: Any = null;

    for (const msg of params.messages) {
      if (msg.role === "user" && msg.parts.length === 2) {
        // Check if it's image or audio based on the text content
        if (msg.parts[0].text?.includes("image")) {
          userWithImage = msg;
        } else if (msg.parts[0].text?.includes("audio")) {
          userWithAudio = msg;
        }
      } else if (msg.role === "model" && msg.parts.length === 3) {
        modelWithText = msg;
      }
    }

    expect(userWithImage).not.toBeNull();
    expect(userWithImage.parts.length).toEqual(2);
    expect(userWithImage.parts[0].text).toEqual("What's in this image?");
    expect(userWithImage.parts[1].inlineData).toBeDefined();
    expect(userWithImage.parts[1].inlineData).not.toBeNull();
    expect(userWithImage.parts[1].inlineData.mimeType).toEqual("image/jpeg");

    expect(userWithAudio).not.toBeNull();
    expect(userWithAudio.parts.length).toEqual(2);
    expect(userWithAudio.parts[0].text).toEqual("Can you transcribe this audio?");
    expect(userWithAudio.parts[1].inlineData).toBeDefined();
    expect(userWithAudio.parts[1].inlineData).not.toBeNull();
    expect(userWithAudio.parts[1].inlineData.mimeType).toEqual("audio/wav");

    expect(modelWithText).not.toBeNull();
    expect(modelWithText.parts.length).toEqual(3);

    const expectedTexts = [
      "Let me analyze this step by step:",
      "1. First, I'll examine the visual elements",
      "2. Then I'll provide my conclusions",
    ];
    expectedTexts.forEach((expectedText, i) => {
      expect(modelWithText.parts[i].text).toEqual(expectedText);
    });
  });

  test("test_file_url_converted_to_file_uri_part", async () => {
    // A supported file_url becomes a Gemini file_uri Part.
    setUp();
    const url = "https://generativelanguage.googleapis.com/v1beta/files/abc";
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "file_url",
            file: { url, mime_type: "application/pdf", filename: "report.pdf" },
          },
        ],
      },
    ];

    const context = new LLMContext({ messages: messages as Any });
    const params = await adapter.getLlmInvocationParams(context);

    expect(params.messages.length).toEqual(1);
    const part = params.messages[0].parts[0];
    expect(part.fileData.fileUri).toEqual(url);
    expect(part.fileData.mimeType).toEqual("application/pdf");
  });

  test("test_file_base64_uses_cached_raw_bytes", async () => {
    // Conversion consumes bytes cached by the file resolution pass.
    setUp();
    const dataUrl = "data:application/pdf;base64,aGVsbG8=";
    const cached = new TextEncoder().encode("cached raw bytes");
    const resolver: Any = new FileResolver();
    resolver._bytesCache.set(dataUrl, cached);
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "file_base64",
            file: { file_data: dataUrl, filename: "a.pdf", mime_type: "application/pdf" },
          },
        ],
      },
    ];

    const context = new LLMContext({ messages: messages as Any });
    adapter.fileResolver = resolver;
    const params = await adapter.getLlmInvocationParams(context);

    // The JS SDK carries a Blob's bytes base64-encoded.
    const part = params.messages[0].parts[0];
    expect(part.inlineData.data).toEqual(bytesToBase64(cached));
    expect(part.inlineData.mimeType).toEqual("application/pdf");
  });

  test("test_single_system_instruction_converted_to_user", async () => {
    // When there's only a system instruction, it gets converted to user message.
    setUp();
    const messages = [{ role: "system", content: "You are a helpful assistant." }];

    const context = new LLMContext({ messages });
    const params = await adapter.getLlmInvocationParams(context);

    // When there's only one message, it's converted to user in-place (not extracted)
    // so system_instruction is null
    expect(params.system_instruction).toBeNull();

    expect(params.messages.length).toEqual(1);
    expect(params.messages[0].role).toEqual("user");
    expect(params.messages[0].parts[0].text).toEqual("You are a helpful assistant.");
  });

  test("test_multiple_system_instructions_handling", async () => {
    // First system instruction is extracted, later ones converted to user messages.
    setUp();
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello!" },
      { role: "assistant", content: "Hi there!" },
      { role: "system", content: "Remember to be concise." },
      { role: "user", content: "Tell me about Python." },
      { role: "system", content: "Use simple language." },
      { role: "assistant", content: "Python is a programming language." },
    ];

    const context = new LLMContext({ messages });
    const params = await adapter.getLlmInvocationParams(context);

    expect(params.system_instruction).toEqual("You are a helpful assistant.");

    // Should have 6 messages (original 7 minus 1 system instruction that was extracted)
    expect(params.messages.length).toEqual(6);

    const convertedSystemMessages: string[] = [];
    for (const msg of params.messages) {
      if (
        msg.role === "user" &&
        (msg.parts[0].text === "Remember to be concise." ||
          msg.parts[0].text === "Use simple language.")
      ) {
        convertedSystemMessages.push(msg.parts[0].text);
      }
    }

    expect(convertedSystemMessages.length).toEqual(2);
    expect(convertedSystemMessages).toContain("Remember to be concise.");
    expect(convertedSystemMessages).toContain("Use simple language.");

    const userMessages = params.messages.filter((m: Any) => m.role === "user");
    const modelMessages = params.messages.filter((m: Any) => m.role === "model");

    // Should have 4 user messages: 2 original + 2 converted from system
    expect(userMessages.length).toEqual(4);
    // Should have 2 model messages (converted from assistant)
    expect(modelMessages.length).toEqual(2);
  });

  test("test_system_instruction_only", async () => {
    // system_instruction alone becomes the system_instruction parameter.
    setUp();
    const messages: LLMStandardMessage[] = [{ role: "user", content: "Hello" }];
    const context = new LLMContext({ messages });
    const params = await adapter.getLlmInvocationParams(context, {
      systemInstruction: "Be helpful.",
    });

    expect(params.system_instruction).toEqual("Be helpful.");
  });

  test("test_initial_system_message_only", async () => {
    // Initial system message is extracted as system_instruction.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });
    const params = await adapter.getLlmInvocationParams(context);

    expect(params.system_instruction).toEqual("You are helpful.");
    expect(params.messages.length).toEqual(1);
  });

  test("test_initial_developer_message_becomes_user", async () => {
    // Initial developer message without system_instruction becomes user, not system_instruction.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "developer", content: "Extra context." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });
    const params = await adapter.getLlmInvocationParams(context);

    expect(params.system_instruction).toBeNull();
    expect(params.messages.length).toEqual(2);
    expect(params.messages[0].role).toEqual("user");
    expect(params.messages[0].parts[0].text).toEqual("Extra context.");
  });

  test("test_both_system_instruction_and_system_message_warns", async () => {
    // system_instruction + initial system message warns and uses system_instruction.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    const params = await withMockLogger(async (mockLogger) => {
      const params = await adapter.getLlmInvocationParams(context, {
        systemInstruction: "Be concise.",
      });
      expect(mockLogger.warningCalls.length).toEqual(1);
      return params;
    });

    expect(params.system_instruction).toEqual("Be concise.");
  });

  test("test_both_system_instruction_and_developer_message_no_warning", async () => {
    // system_instruction + initial developer message: no warning, developer becomes user.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "developer", content: "Extra context." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    const params = await withMockLogger(async (mockLogger) => {
      const params = await adapter.getLlmInvocationParams(context, {
        systemInstruction: "Be concise.",
      });
      expect(mockLogger.warningCalls).toEqual([]);
      return params;
    });

    expect(params.system_instruction).toEqual("Be concise.");
  });

  test("test_non_initial_system_message_not_extracted", async () => {
    // Non-initial system message is converted to user, not extracted as system instruction.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "user", content: "Hello" },
      { role: "system", content: "Late system message" },
      { role: "user", content: "How are you?" },
    ];
    const context = new LLMContext({ messages });
    const params = await adapter.getLlmInvocationParams(context);

    expect(params.system_instruction).toBeNull();
    // (we check that 3 messages are present, meaning no extraction happened)
    expect(params.messages.length).toEqual(3);
  });

  test("test_subsequent_developer_messages_converted_to_user", async () => {
    // Subsequent developer messages are converted to user role.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "user", content: "Hello" },
      { role: "developer", content: "More instructions" },
    ];
    const context = new LLMContext({ messages });
    const params = await adapter.getLlmInvocationParams(context);

    expect(params.messages.length).toEqual(2);
    expect(params.messages[1].role).toEqual("user");
  });

  // --- _mergeParallelToolCallsForThinking ---
  //
  // With thinking enabled, a batch of parallel tool calls arrives split across
  // separate messages (each call, then its response). The adapter regroups
  // both sides so the model turn's call count matches the following user
  // turn's response count.

  /** Build a model Content with a single functionCall Part. */
  const toolCallMessage = (callId: string, options: { signature?: string } = {}): Any => {
    const part: Any = {
      functionCall: { id: callId, name: `tool_${callId}`, args: { q: callId } },
    };
    if (options.signature) {
      part.thoughtSignature = options.signature;
    }
    return { role: "model", parts: [part] };
  };

  /** Build a user Content with a single functionResponse Part. */
  const toolResponseMessage = (callId: string): Any => ({
    role: "user",
    parts: [{ functionResponse: { id: callId, name: `tool_${callId}`, response: { ok: true } } }],
  });

  /** Build a thought_signature dict bookmarked to a function call. */
  const thoughtSignatureDict = (callId: string): Any => ({
    signature: `sig-${callId}`,
    bookmark: { function_call: callId },
  });

  test("test_merge_parallel_interleaved_calls_and_responses", () => {
    // Parallel calls interleaved with responses merge into one model and one user turn.
    setUp();
    const messages = [
      toolCallMessage("c1", { signature: "sig-c1" }),
      toolResponseMessage("c1"),
      toolCallMessage("c2"),
      toolResponseMessage("c2"),
    ];
    const result = adapter._mergeParallelToolCallsForThinking(
      [thoughtSignatureDict("c1")],
      messages,
    );

    expect(result.map((m: Any) => m.role)).toEqual(["model", "user"]);
    expect(result[0].parts.map((p: Any) => p.functionCall.id)).toEqual(["c1", "c2"]);
    expect(result[1].parts.map((p: Any) => p.functionResponse.id)).toEqual(["c1", "c2"]);
  });

  test("test_merge_batch_ordered_calls_and_responses", () => {
    // Calls grouped first, then responses, still merge into matching turns.
    setUp();
    const messages = [
      toolCallMessage("c1", { signature: "sig-c1" }),
      toolCallMessage("c2"),
      toolResponseMessage("c1"),
      toolResponseMessage("c2"),
    ];
    const result = adapter._mergeParallelToolCallsForThinking(
      [thoughtSignatureDict("c1")],
      messages,
    );

    expect(result.map((m: Any) => m.role)).toEqual(["model", "user"]);
    expect(result[0].parts.map((p: Any) => p.functionCall.id)).toEqual(["c1", "c2"]);
    expect(result[1].parts.map((p: Any) => p.functionResponse.id)).toEqual(["c1", "c2"]);
  });

  test("test_merge_three_parallel_calls", () => {
    // Three parallel calls merge into a single model turn and user turn.
    setUp();
    const messages = [
      toolCallMessage("c1", { signature: "sig-c1" }),
      toolResponseMessage("c1"),
      toolCallMessage("c2"),
      toolResponseMessage("c2"),
      toolCallMessage("c3"),
      toolResponseMessage("c3"),
    ];
    const result = adapter._mergeParallelToolCallsForThinking(
      [thoughtSignatureDict("c1")],
      messages,
    );

    expect(result.map((m: Any) => m.role)).toEqual(["model", "user"]);
    expect(result[0].parts.length).toEqual(3);
    expect(result[1].parts.length).toEqual(3);
  });

  test("test_merge_single_call_unchanged", () => {
    // A lone signed call and its response pass through as-is.
    setUp();
    const messages = [toolCallMessage("c1", { signature: "sig-c1" }), toolResponseMessage("c1")];
    const result = adapter._mergeParallelToolCallsForThinking(
      [thoughtSignatureDict("c1")],
      messages,
    );

    expect(result.map((m: Any) => m.role)).toEqual(["model", "user"]);
    expect(result[0].parts.length).toEqual(1);
    expect(result[1].parts.length).toEqual(1);
  });

  test("test_merge_sequential_calls_with_signatures_not_merged", () => {
    // Sequential calls (each with its own signature) stay in separate turns.
    setUp();
    const messages = [
      toolCallMessage("c1", { signature: "sig-c1" }),
      toolResponseMessage("c1"),
      toolCallMessage("c2", { signature: "sig-c2" }),
      toolResponseMessage("c2"),
    ];
    const result = adapter._mergeParallelToolCallsForThinking(
      [thoughtSignatureDict("c1"), thoughtSignatureDict("c2")],
      messages,
    );

    expect(result.map((m: Any) => m.role)).toEqual(["model", "user", "model", "user"]);
    expect(result.every((m: Any) => m.parts.length === 1)).toBe(true);
  });

  test("test_merge_mixed_parallel_and_sequential_groups", () => {
    // A parallel group followed by a sequential call are grouped independently.
    setUp();
    const messages = [
      toolCallMessage("c1", { signature: "sig-c1" }),
      toolResponseMessage("c1"),
      toolCallMessage("c2"),
      toolResponseMessage("c2"),
      toolCallMessage("c3", { signature: "sig-c3" }),
      toolResponseMessage("c3"),
    ];
    const result = adapter._mergeParallelToolCallsForThinking(
      [thoughtSignatureDict("c1"), thoughtSignatureDict("c3")],
      messages,
    );

    expect(result.map((m: Any) => m.role)).toEqual(["model", "user", "model", "user"]);
    expect(result.map((m: Any) => m.parts.length)).toEqual([2, 2, 1, 1]);
  });

  test("test_merge_collects_interleaved_non_tool_message", () => {
    // A non-tool message inside a group is collected and re-emitted after it.
    setUp();
    const textMessage = { role: "model", parts: [{ text: "thinking out loud" }] };
    const messages = [
      toolCallMessage("c1", { signature: "sig-c1" }),
      toolResponseMessage("c1"),
      textMessage,
      toolCallMessage("c2"),
      toolResponseMessage("c2"),
    ];
    const result = adapter._mergeParallelToolCallsForThinking(
      [thoughtSignatureDict("c1")],
      messages,
    );

    // Both calls still merge (and both responses), and the interleaved text
    // is preserved after the merged group rather than stopping the merge.
    expect(result.map((m: Any) => m.role)).toEqual(["model", "user", "model"]);
    expect(result[0].parts.map((p: Any) => p.functionCall.id)).toEqual(["c1", "c2"]);
    expect(result[1].parts.map((p: Any) => p.functionResponse.id)).toEqual(["c1", "c2"]);
    expect(result[2].parts[0].text).toEqual("thinking out loud");
  });

  test("test_merge_no_thought_signatures_unchanged", () => {
    // Without any function-call thought signatures, messages pass through unchanged.
    setUp();
    const messages = [toolCallMessage("c1"), toolResponseMessage("c1")];
    const result = adapter._mergeParallelToolCallsForThinking([], messages);

    expect(result.length).toEqual(2);
  });

  test("test_merge_empty_messages", () => {
    // An empty message list returns empty.
    setUp();
    expect(adapter._mergeParallelToolCallsForThinking([], [])).toEqual([]);
  });

  // --- _addPlaceholderThoughtSignatures ---
  //
  // Gemini 3 rejects function calls without a thought signature, so calls
  // another provider produced get the placeholder Google documents for them.

  // The JS SDK carries a thought signature's bytes base64-encoded.
  const PLACEHOLDER = bytesToBase64(new TextEncoder().encode("skip_thought_signature_validator"));

  test("test_unsigned_tool_call_gets_placeholder_signature", async () => {
    // A tool call converted from a standard message carries the placeholder.
    setUp();
    const messages = [
      { role: "user", content: "Switch to Gemini." },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "switch_llm", arguments: '{"llm": "Google"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"ok": true}' },
    ];
    const context = new LLMContext({ messages: messages as Any });
    const params = await adapter.getLlmInvocationParams(context);

    const callPart = params.messages[1].parts[0];
    expect(callPart.functionCall.id).toEqual("call_1");
    expect(callPart.thoughtSignature).toEqual(PLACEHOLDER);
  });

  test("test_signed_parallel_group_left_unsigned_after_first_call", () => {
    // A parallel batch keeps Gemini's shape: the first call signed, the rest unsigned.
    setUp();
    let messages = [
      toolCallMessage("c1", { signature: "sig-c1" }),
      toolResponseMessage("c1"),
      toolCallMessage("c2"),
      toolResponseMessage("c2"),
    ];
    messages = adapter._mergeParallelToolCallsForThinking([thoughtSignatureDict("c1")], messages);
    adapter._addPlaceholderThoughtSignatures(messages);

    expect(messages[0].parts.map((p: Any) => p.thoughtSignature ?? null)).toEqual(["sig-c1", null]);
  });

  test("test_placeholder_skips_text_and_user_parts", () => {
    // Text parts and user turns never receive a signature.
    setUp();
    const messages: Any[] = [
      { role: "user", parts: [{ text: "Hi" }] },
      { role: "model", parts: [{ text: "Hello" }] },
      toolResponseMessage("c1"),
    ];
    adapter._addPlaceholderThoughtSignatures(messages);

    expect(
      messages.every((m: Any) => m.parts.every((p: Any) => (p.thoughtSignature ?? null) === null)),
    ).toBe(true);
  });

  test("test_ensure_last_message_is_user_appends_when_trailing_model", async () => {
    // ensureLastMessageIsUser=true appends a user message after a trailing model turn.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Let me check on that." },
      ],
    });
    const params = await adapter.getLlmInvocationParams(context, {
      ensureLastMessageIsUser: true,
    });
    expect(params.messages.map((m: Any) => m.role)).toEqual(["user", "model", "user"]);
    expect(params.messages.at(-1).parts[0].text).toEqual(".");
  });

  test("test_ensure_last_message_is_user_after_function_response_and_model_text", async () => {
    // A settled tool result followed by spoken filler ends with a user turn.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"temperature": "75"}' },
        { role: "assistant", content: "Let me check on that." },
      ] as Any,
    });
    const params = await adapter.getLlmInvocationParams(context, {
      ensureLastMessageIsUser: true,
    });
    expect(params.messages.at(-2).role).toEqual("model");
    expect(params.messages.at(-1).role).toEqual("user");
    expect(params.messages.at(-1).parts[0].text).toEqual(".");
  });

  test("test_ensure_last_message_is_user_off_keeps_trailing_model", async () => {
    // Without the flag (default), a trailing model turn is preserved.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    });
    const params = await adapter.getLlmInvocationParams(context);
    expect(params.messages.map((m: Any) => m.role)).toEqual(["user", "model"]);
  });

  test("test_ensure_last_message_is_user_noop_when_trailing_user", async () => {
    // ensureLastMessageIsUser=true does nothing when the list already ends with a user.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ],
    });
    const params = await adapter.getLlmInvocationParams(context, {
      ensureLastMessageIsUser: true,
    });
    expect(params.messages.length).toEqual(3);
    expect(params.messages.at(-1).parts[0].text).toEqual("How are you?");
  });
});

describe("TestGeminiLiveGetLLMInvocationParams", () => {
  let adapter: Any;
  const setUp = () => {
    adapter = new GeminiLiveLLMAdapter();
  };

  test("test_standard_messages_converted_to_gemini_format", async () => {
    // Messages with no tool calls are converted just like Gemini's.
    setUp();
    const standardMessages: LLMStandardMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello, how are you?" },
      { role: "assistant", content: "I'm doing well, thank you for asking!" },
    ];
    const context = new LLMContext({ messages: standardMessages });

    const params = await adapter.getLlmInvocationParams(context);

    expect(params).toEqual(await new GeminiLLMAdapter().getLlmInvocationParams(context));
  });

  test("test_llm_specific_message_filtering", async () => {
    // Gemini Live-specific messages are included and others are filtered out.
    setUp();
    const messages = [
      new GeminiLLMAdapter().createLlmSpecificMessage({
        role: "model",
        parts: [{ text: "Gemini specific response" }],
      }),
      adapter.createLlmSpecificMessage({
        role: "model",
        parts: [{ text: "Gemini Live specific response" }],
      }),
    ];
    const context = new LLMContext({ messages });

    const params = await adapter.getLlmInvocationParams(context);

    expect(params.messages.length).toEqual(1);
    expect(params.messages[0].parts[0].text).toEqual("Gemini Live specific response");
  });

  test("test_tool_call_and_result_summarized_as_text", async () => {
    // A tool call and its result are summarized as text messages.
    setUp();
    const messages = [
      { role: "user", content: "What's the weather?" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "get_weather", arguments: '{"location": "Paris"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: '{"conditions": "nice"}' },
    ];
    const context = new LLMContext({ messages: messages as Any });

    const params = await adapter.getLlmInvocationParams(context);

    expect(params.messages.length).toEqual(3);
    // The call is a model turn, its result a user turn.
    const callMessage = params.messages[1];
    expect(callMessage.role).toEqual("model");
    expect(callMessage.parts[0].functionCall ?? null).toBeNull();
    expect(callMessage.parts[0].text).toContain("get_weather");
    expect(callMessage.parts[0].text).toContain("Paris");

    const resultMessage = params.messages[2];
    expect(resultMessage.role).toEqual("user");
    expect(resultMessage.parts[0].functionResponse ?? null).toBeNull();
    expect(resultMessage.parts[0].text).toContain("get_weather");
    expect(resultMessage.parts[0].text).toContain("nice");
  });

  test("test_parallel_tool_calls_summarized_together", async () => {
    // A message calling several functions is summarized as one message.
    setUp();
    const messages = [
      {
        role: "assistant",
        tool_calls: [
          { id: "call-1", type: "function", function: { name: "get_weather", arguments: "{}" } },
          {
            id: "call-2",
            type: "function",
            function: { name: "get_restaurant", arguments: "{}" },
          },
        ],
      },
    ];
    const context = new LLMContext({ messages: messages as Any });

    const params = await adapter.getLlmInvocationParams(context);

    expect(params.messages.length).toEqual(1);
    const parts = params.messages[0].parts;
    expect(parts.length).toEqual(1);
    expect(parts[0].text).toContain("get_weather");
    expect(parts[0].text).toContain("get_restaurant");
  });
});

describe("TestAnthropicGetLLMInvocationParams", () => {
  let adapter: AnthropicLLMAdapter;
  const setUp = () => {
    adapter = new AnthropicLLMAdapter();
  };

  test("test_malformed_message_raises_conversion_error", async () => {
    // A malformed message raises LLMContextConversionError, preserving the underlying cause.
    setUp();
    // A data URL with no comma has no base64 payload, so the adapter's
    // url.split(",")[1] raises IndexError during conversion.
    const malformedMessage = {
      role: "user",
      content: [
        { type: "text", text: "What's in this image?" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64" } },
      ],
    };
    const context = new LLMContext({ messages: [malformedMessage as Any] });

    const exc = await assertRaises(LLMContextConversionError, () =>
      adapter.getLlmInvocationParams(context, { enablePromptCaching: false }),
    );

    // The underlying cause is preserved for debugging.
    expect(exc.cause).toBeInstanceOf(RangeError);
    expect(exc.message).toContain("Error mapping context messages to provider format");
  });

  test("test_unsupported_file_mime_type_raises_conversion_error", async () => {
    // An unsupported file MIME type raises instead of silently dropping the file.
    setUp();
    const message = {
      role: "user",
      content: [
        { type: "text", text: "please summarize" },
        {
          type: "file_base64",
          file: {
            file_data: "data:text/plain;base64,aGVsbG8=",
            filename: "notes.txt",
            mime_type: "text/plain",
          },
        },
      ],
    };
    const context = new LLMContext({ messages: [message as Any] });

    const exc = await assertRaises(LLMContextConversionError, () =>
      adapter.getLlmInvocationParams(context, { enablePromptCaching: false }),
    );

    expect(exc.message).toContain("Unsupported 'file' MIME type");
  });

  test("test_image_file_base64_converted_to_image_block", async () => {
    // An inline image file becomes an Anthropic base64 image block.
    setUp();
    const message = {
      role: "user",
      content: [
        {
          type: "file_base64",
          file: {
            file_data: "data:image/png;base64,aGVsbG8=",
            filename: "a.png",
            mime_type: "image/png",
          },
        },
      ],
    };
    const context = new LLMContext({ messages: [message as Any] });

    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
    });

    const item = params.messages[0].content[0];
    expect(item.type).toEqual("image");
    expect(item.source).toEqual({ type: "base64", media_type: "image/png", data: "aGVsbG8=" });
  });

  test("test_standard_messages_converted_to_anthropic_format", async () => {
    // LLMStandardMessage objects are converted to Anthropic MessageParam format.
    setUp();
    const standardMessages: LLMStandardMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello, how are you?" },
      { role: "assistant", content: "I'm doing well, thank you!" },
    ];

    const context = new LLMContext({ messages: standardMessages });

    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
    });

    expect(params.system).toEqual("You are a helpful assistant.");

    expect(params).toHaveProperty("messages");
    expect(params.messages.length).toEqual(2);

    const userMsg = params.messages[0];
    expect(userMsg.role).toEqual("user");
    expect(userMsg.content).toEqual("Hello, how are you?");

    const assistantMsg = params.messages[1];
    expect(assistantMsg.role).toEqual("assistant");
    expect(assistantMsg.content).toEqual("I'm doing well, thank you!");
  });

  test("test_llm_specific_message_filtering", async () => {
    // Anthropic-specific messages are included and others are filtered out.
    setUp();
    const anthropicMessageContent = {
      role: "user",
      content: [
        { type: "text", text: "Hello" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: "fake_data" },
        },
      ],
    };

    const messages = [
      { role: "user", content: "Standard message" },
      new OpenAILLMAdapter().createLlmSpecificMessage({ role: "user", content: "OpenAI specific" }),
      new GeminiLLMAdapter().createLlmSpecificMessage({ role: "user", content: "Google specific" }),
      adapter.createLlmSpecificMessage(anthropicMessageContent),
      { role: "assistant", content: "Response" },
    ];

    const context = new LLMContext({ messages: messages as Any });

    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
    });

    // Should only have 2 messages after merging consecutive user messages: merged user + standard response
    // (openai and google specific filtered out, standard + anthropic-specific merged)
    expect(params.messages.length).toEqual(2);

    const userMsg = params.messages[0];
    expect(userMsg.role).toEqual("user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    // Should have 3 content blocks: standard text + anthropic text + anthropic image
    expect(userMsg.content.length).toEqual(3);
    expect(userMsg.content[0].type).toEqual("text");
    expect(userMsg.content[0].text).toEqual("Standard message");
    expect(userMsg.content[1].type).toEqual("text");
    expect(userMsg.content[1].text).toEqual("Hello");
    expect(userMsg.content[2].type).toEqual("image");

    expect(params.messages[1].content).toEqual("Response");
  });

  test("test_consecutive_same_role_messages_merged", async () => {
    // Consecutive messages with the same role are merged into multi-content blocks.
    setUp();
    const messages = [
      { role: "user", content: "First user message" },
      { role: "user", content: "Second user message" },
      { role: "user", content: "Third user message" },
      { role: "assistant", content: "First assistant message" },
      { role: "assistant", content: "Second assistant message" },
    ];

    const context = new LLMContext({ messages });

    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
    });

    expect(params.messages.length).toEqual(2);

    const userMsg = params.messages[0];
    expect(userMsg.role).toEqual("user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content.length).toEqual(3);
    expect(userMsg.content[0].type).toEqual("text");
    expect(userMsg.content[0].text).toEqual("First user message");
    expect(userMsg.content[1].type).toEqual("text");
    expect(userMsg.content[1].text).toEqual("Second user message");
    expect(userMsg.content[2].type).toEqual("text");
    expect(userMsg.content[2].text).toEqual("Third user message");

    const assistantMsg = params.messages[1];
    expect(assistantMsg.role).toEqual("assistant");
    expect(Array.isArray(assistantMsg.content)).toBe(true);
    expect(assistantMsg.content.length).toEqual(2);
    expect(assistantMsg.content[0].type).toEqual("text");
    expect(assistantMsg.content[0].text).toEqual("First assistant message");
    expect(assistantMsg.content[1].type).toEqual("text");
    expect(assistantMsg.content[1].text).toEqual("Second assistant message");
  });

  test("test_empty_text_converted_to_empty_placeholder", async () => {
    // Empty text content is converted to "(empty)" string.
    setUp();
    const messages = [
      { role: "user", content: "" }, // Empty string
      {
        role: "assistant",
        content: [
          { type: "text", text: "" }, // Empty text in list content
          { type: "text", text: "Valid text" },
        ],
      },
    ];

    const context = new LLMContext({ messages: messages as Any });

    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
    });

    const userMsg = params.messages[0];
    expect(userMsg.content).toEqual("(empty)");

    const assistantMsg = params.messages[1];
    expect(Array.isArray(assistantMsg.content)).toBe(true);
    expect(assistantMsg.content[0].text).toEqual("(empty)");
    expect(assistantMsg.content[1].text).toEqual("Valid text");
  });

  test("test_complex_message_content_preserved", async () => {
    // Complex message structures (text + image) are properly converted to Anthropic format.
    setUp();
    const complexMessage = {
      role: "user",
      content: [
        { type: "text", text: "What do you see in this image?" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,fake_image_data" } },
        { type: "text", text: "Please describe it in detail." },
      ],
    };

    const messages = [
      complexMessage,
      { role: "assistant", content: "I can see the image clearly." },
    ];

    const context = new LLMContext({ messages: messages as Any });

    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
    });

    expect(params.messages.length).toEqual(2);
    const userMsg = params.messages[0];
    expect(userMsg.role).toEqual("user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content.length).toEqual(3);

    // Note: Anthropic adapter reorders single images to come before text, as per Anthropic docs
    expect(userMsg.content[0].type).toEqual("image");
    expect(userMsg.content[0]).toHaveProperty("source");
    expect(userMsg.content[0].source.type).toEqual("base64");
    expect(userMsg.content[0].source.media_type).toEqual("image/jpeg");
    expect(userMsg.content[0].source.data).toEqual("fake_image_data");

    expect(userMsg.content[1].type).toEqual("text");
    expect(userMsg.content[1].text).toEqual("What do you see in this image?");

    expect(userMsg.content[2].type).toEqual("text");
    expect(userMsg.content[2].text).toEqual("Please describe it in detail.");
  });

  test("test_multiple_system_instructions_handling", async () => {
    // First system instruction is extracted, later ones converted to user messages.
    setUp();
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "system", content: "Remember to be concise." }, // Later system message
    ];

    const context = new LLMContext({ messages });

    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
    });

    expect(params.system).toEqual("You are a helpful assistant.");

    expect(params.messages.length).toEqual(3);
    expect(params.messages[0].role).toEqual("user");
    expect(params.messages[0].content).toEqual("Hello");
    expect(params.messages[1].role).toEqual("assistant");
    expect(params.messages[1].content).toEqual("Hi there!");

    expect(params.messages[2].role).toEqual("user");
    expect(params.messages[2].content).toEqual("Remember to be concise.");
  });

  test("test_single_system_message_converted_to_user", async () => {
    // A single system message is converted to user role when no other messages exist.
    setUp();
    const messages = [{ role: "system", content: "You are a helpful assistant." }];

    const context = new LLMContext({ messages });

    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
    });

    // System should be NOT_GIVEN since we only have one message
    expect(params.system).toEqual(ANTHROPIC_NOT_GIVEN);

    expect(params.messages.length).toEqual(1);
    expect(params.messages[0].role).toEqual("user");
    expect(params.messages[0].content).toEqual("You are a helpful assistant.");
  });

  test("test_single_system_message_conversion_does_not_mutate_source_context", async () => {
    // Converting a lone system message to user leaves the source context unchanged.
    setUp();
    const context = new LLMContext({ messages: [{ role: "system", content: "You are helpful." }] });

    await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
      systemInstruction: "Be concise.",
    });

    expect((context.getMessages()[0] as Any).role).toEqual("system");
  });

  test("test_system_instruction_only", async () => {
    // system_instruction alone becomes the system parameter.
    setUp();
    const messages: LLMStandardMessage[] = [{ role: "user", content: "Hello" }];
    const context = new LLMContext({ messages });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
      systemInstruction: "Be helpful.",
    });

    expect(params.system).toEqual("Be helpful.");
    expect(params.messages.length).toEqual(1);
    expect(params.messages[0].role).toEqual("user");
  });

  test("test_prompt_caching_marks_system_instruction", async () => {
    // Prompt caching adds a reusable breakpoint to the system prompt.
    setUp();
    const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });

    const params = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: true,
      systemInstruction: "Be helpful.",
    });

    expect(params.system).toEqual([
      { type: "text", text: "Be helpful.", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("test_prompt_caching_keeps_system_instruction_as_string_when_disabled", async () => {
    // Without prompt caching, the system prompt keeps its string form.
    setUp();
    const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });

    const params = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
      systemInstruction: "Be helpful.",
    });

    expect(params.system).toEqual("Be helpful.");
  });

  test("test_prompt_caching_leaves_system_omitted_when_not_configured", async () => {
    // Caching does not add a system block when no system prompt exists.
    setUp();
    const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });

    const params = await adapter.getLlmInvocationParams(context, { enablePromptCaching: true });

    expect(params.system).toBe(ANTHROPIC_NOT_GIVEN);
  });

  test("test_prompt_caching_system_instruction_ttl", async () => {
    // The system prompt's cache breakpoint carries the configured TTL.
    setUp();
    const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });

    for (const ttl of [null, "5m", "1h"] as const) {
      const params: Any = await adapter.getLlmInvocationParams(context, {
        enablePromptCaching: true,
        systemInstruction: "Be helpful.",
        systemPromptCacheTtl: ttl,
      });

      expect(params.system.length).toEqual(1);
      const [systemBlock] = params.system;
      // `dict.get("ttl")`: null when absent.
      expect(systemBlock.cache_control.ttl ?? null).toEqual(ttl);
    }
  });

  test("test_prompt_caching_system_instruction_ttl_ignored_when_disabled", async () => {
    // A TTL doesn't mark the system prompt when prompt caching is disabled.
    setUp();
    const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });

    const params = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
      systemInstruction: "Be helpful.",
      systemPromptCacheTtl: "1h",
    });

    expect(params.system).toEqual("Be helpful.");
  });

  test("test_initial_developer_message_becomes_user", async () => {
    // Initial developer message without system_instruction becomes user, not system.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "developer", content: "Extra context." },
      { role: "assistant", content: "OK" },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
    });

    expect(params.system).toEqual(ANTHROPIC_NOT_GIVEN);
    expect(params.messages.length).toEqual(3);
    expect(params.messages[0].role).toEqual("user");
    expect(params.messages[0].content).toEqual("Extra context.");
  });

  test("test_both_system_instruction_and_system_message_warns", async () => {
    // system_instruction + initial system message warns and uses system_instruction.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    const params = await withMockLogger(async (mockLogger) => {
      const params = await adapter.getLlmInvocationParams(context, {
        enablePromptCaching: false,
        systemInstruction: "Be concise.",
      });
      expect(mockLogger.warningCalls.length).toEqual(1);
      expect(mockLogger.lastWarning).toContain("Using system_instruction");
      return params;
    });

    expect(params.system).toEqual("Be concise.");
  });

  test("test_both_system_instruction_and_developer_message_no_warning", async () => {
    // system_instruction + initial developer message: no warning, developer becomes user.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "developer", content: "Extra context." },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    const params: Any = await withMockLogger(async (mockLogger) => {
      const params = await adapter.getLlmInvocationParams(context, {
        enablePromptCaching: false,
        systemInstruction: "Be concise.",
      });
      expect(mockLogger.warningCalls).toEqual([]);
      return params;
    });

    expect(params.system).toEqual("Be concise.");
    // Developer message should have been converted to "user"
    expect(params.messages[0].role).toEqual("user");
    expect(params.messages[0].content).toEqual("Extra context.");
  });

  test("test_subsequent_developer_messages_converted_to_user", async () => {
    // Subsequent developer messages are converted to user role.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "developer", content: "More instructions" },
    ];
    const context = new LLMContext({ messages });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
    });

    expect(params.messages[2].role).toEqual("user");
    expect(params.messages[2].content).toEqual("More instructions");
  });

  test("test_initial_system_discarded_when_system_instruction_provided", async () => {
    // Initial system message is discarded when system_instruction is provided.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "Old instruction." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    const params: Any = await withMockLogger(() =>
      adapter.getLlmInvocationParams(context, {
        enablePromptCaching: false,
        systemInstruction: "New instruction.",
      }),
    );

    expect(params.system).toEqual("New instruction.");
    // Only the user message should remain
    expect(params.messages.length).toEqual(1);
    expect(params.messages[0].role).toEqual("user");
  });

  test("test_ensure_last_message_is_user_appends_when_trailing_assistant", async () => {
    // ensureLastMessageIsUser=true appends a user message after a trailing assistant.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
      ensureLastMessageIsUser: true,
    });
    expect(params.messages.length).toEqual(3);
    expect(params.messages.at(-1).role).toEqual("user");
    expect(params.messages.at(-1).content).toEqual([{ type: "text", text: "." }]);
  });

  test("test_ensure_last_message_is_user_off_keeps_trailing_assistant", async () => {
    // Without the flag (default), a trailing assistant message is preserved.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
    });
    expect(params.messages.length).toEqual(2);
    expect(params.messages.at(-1).role).toEqual("assistant");
  });

  test("test_ensure_last_message_is_user_noop_when_trailing_user", async () => {
    // ensureLastMessageIsUser=true does nothing when the list already ends with a user.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ],
    });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
      ensureLastMessageIsUser: true,
    });
    expect(params.messages.length).toEqual(3);
    expect(params.messages.at(-1).role).toEqual("user");
    expect(params.messages.at(-1).content).toEqual("How are you?");
  });

  test("test_ensure_last_message_is_user_handles_empty_list", async () => {
    // ensureLastMessageIsUser=true handles an empty context.
    setUp();
    const params = await adapter.getLlmInvocationParams(new LLMContext(), {
      enablePromptCaching: false,
      ensureLastMessageIsUser: true,
    });
    expect(params.messages.length).toEqual(0);
  });

  test("test_ensure_last_message_is_user_noop_when_tool_result_trailing", async () => {
    // ensureLastMessageIsUser=true does nothing when a tool result (user role) trails.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          tool_calls: [{ id: "t1", function: { name: "get_weather", arguments: "{}" } }],
        },
        { role: "tool", content: "Sunny, 22°C", tool_call_id: "t1" },
      ] as Any,
    });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
      ensureLastMessageIsUser: true,
    });
    expect(params.messages.at(-1).role).toEqual("user");
    expect(params.messages.at(-1).content[0].type).toEqual("tool_result");
  });

  test("test_thought_converted_to_thinking_block", async () => {
    // A signed thought becomes a thinking block merged into the assistant message.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "What's the weather?" },
        new LLMSpecificMessage({
          llm: "anthropic",
          message: { type: "thought", text: "Let me check.", signature: "sig" },
        }),
        { role: "assistant", content: "It's sunny." },
      ],
    });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
    });

    // The thought and the response merge into a single assistant message,
    // with the thinking block first.
    expect(params.messages.length).toEqual(2);
    const content = params.messages[1].content;
    expect(content[0]).toEqual({ type: "thinking", thinking: "Let me check.", signature: "sig" });
    expect(content[1]).toEqual({ type: "text", text: "It's sunny." });
  });

  test("test_thought_with_empty_text_preserved", async () => {
    // A signed thought with no text still round-trips as a thinking block.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "What's the weather?" },
        new LLMSpecificMessage({
          llm: "anthropic",
          message: { type: "thought", text: "", signature: "sig" },
        }),
        { role: "assistant", content: "It's sunny." },
      ],
    });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
    });

    expect(params.messages.length).toEqual(2);
    const content = params.messages[1].content;
    expect(content[0]).toEqual({ type: "thinking", thinking: "", signature: "sig" });
    expect(content[1]).toEqual({ type: "text", text: "It's sunny." });
  });

  test("test_thought_without_signature_dropped", async () => {
    // A thought with no signature can't be round-tripped, so it's skipped.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "What's the weather?" },
        new LLMSpecificMessage({
          llm: "anthropic",
          message: { type: "thought", text: "Let me check.", signature: "" },
        }),
        { role: "assistant", content: "It's sunny." },
      ],
    });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: false,
    });

    expect(params.messages.length).toEqual(2);
    expect(params.messages[0].content).toEqual("What's the weather?");
    expect(params.messages[1].content).toEqual("It's sunny.");
  });
});

describe("TestAWSBedrockGetLLMInvocationParams", () => {
  let adapter: AWSBedrockLLMAdapter;
  const setUp = () => {
    adapter = new AWSBedrockLLMAdapter();
  };

  test("test_malformed_message_raises_conversion_error", async () => {
    // A malformed message raises LLMContextConversionError, preserving the underlying cause.
    setUp();
    // A data URL with no comma has no base64 payload, so the adapter's
    // url.split(",")[1] raises IndexError during conversion.
    const malformedMessage = {
      role: "user",
      content: [
        { type: "text", text: "What's in this image?" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64" } },
      ],
    };
    const context = new LLMContext({ messages: [malformedMessage as Any] });

    const exc = await assertRaises(LLMContextConversionError, () =>
      adapter.getLlmInvocationParams(context),
    );

    // The underlying cause is preserved for debugging.
    expect(exc.cause).toBeInstanceOf(RangeError);
    expect(exc.message).toContain("Error mapping context messages to provider format");
  });

  test("test_unsupported_file_mime_type_raises_conversion_error", async () => {
    // An unsupported file MIME type raises instead of silently dropping the file.
    setUp();
    const message = {
      role: "user",
      content: [
        { type: "text", text: "please summarize" },
        {
          type: "file_base64",
          file: {
            file_data: "data:application/zip;base64,aGVsbG8=",
            filename: "notes.zip",
            mime_type: "application/zip",
          },
        },
      ],
    };
    const context = new LLMContext({ messages: [message as Any] });

    const exc = await assertRaises(LLMContextConversionError, () =>
      adapter.getLlmInvocationParams(context),
    );

    expect(exc.message).toContain("Unsupported 'file' MIME type for Bedrock");
  });

  test("test_unsupported_s3_url_raises_conversion_error", async () => {
    // A non-S3 file_url raises instead of silently dropping the file.
    setUp();
    const message = {
      role: "user",
      content: [
        {
          type: "file_url",
          file: { url: "https://example.com/doc.pdf", mime_type: "application/pdf" },
        },
      ],
    };
    const context = new LLMContext({ messages: [message as Any] });

    const exc = await assertRaises(LLMContextConversionError, () =>
      adapter.getLlmInvocationParams(context),
    );

    expect(exc.message).toContain("Unresolved file URL");
  });

  test("test_file_base64_document_name_is_sanitized_for_bedrock", async () => {
    // An ordinary filename is sanitized to satisfy Bedrock's document name rules.
    setUp();
    const message = {
      role: "user",
      content: [
        {
          type: "file_base64",
          file: {
            file_data: "data:application/pdf;base64,aGVsbG8=",
            filename: "notes.pdf",
            mime_type: "application/pdf",
          },
        },
      ],
    };
    const context = new LLMContext({ messages: [message as Any] });

    const params: Any = await adapter.getLlmInvocationParams(context);

    const document = params.messages[0].content[0].document;
    expect(document.name).toEqual("notes pdf");
  });

  test("test_file_url_document_name_is_sanitized_for_bedrock", async () => {
    // Document name sanitization also applies to the S3-URL file path.
    setUp();
    const message = {
      role: "user",
      content: [
        {
          type: "file_url",
          file: {
            url: "s3://bucket/notes.pdf",
            filename: "notes.pdf",
            mime_type: "application/pdf",
          },
        },
      ],
    };
    const context = new LLMContext({ messages: [message as Any] });

    const params: Any = await adapter.getLlmInvocationParams(context);

    const document = params.messages[0].content[0].document;
    expect(document.name).toEqual("notes pdf");
  });

  test("test_file_base64_image_mime_type_converted_to_image_block", async () => {
    // An image sent as file_base64 becomes a Bedrock image block, not a document.
    setUp();
    const message = {
      role: "user",
      content: [
        {
          type: "file_base64",
          file: {
            file_data: "data:image/png;base64,aGVsbG8=",
            filename: "photo.png",
            mime_type: "image/png",
          },
        },
      ],
    };
    const context = new LLMContext({ messages: [message as Any] });

    const params: Any = await adapter.getLlmInvocationParams(context);

    const image = params.messages[0].content[0].image;
    expect(image.format).toEqual("png");
    expect(image.source.bytes).toEqual(base64ToBytes("aGVsbG8="));
  });

  test("test_file_base64_uses_cached_raw_bytes", async () => {
    // Conversion consumes bytes cached by the file resolution pass.
    setUp();
    const dataUrl = "data:application/pdf;base64,aGVsbG8=";
    const cached = new TextEncoder().encode("cached raw bytes");
    const resolver: Any = new FileResolver();
    resolver._bytesCache.set(dataUrl, cached);
    const message = {
      role: "user",
      content: [
        {
          type: "file_base64",
          file: { file_data: dataUrl, filename: "a.pdf", mime_type: "application/pdf" },
        },
      ],
    };
    const context = new LLMContext({ messages: [message as Any] });

    adapter.fileResolver = resolver;
    const params: Any = await adapter.getLlmInvocationParams(context);

    const document = params.messages[0].content[0].document;
    expect(document.source.bytes).toEqual(cached);
  });

  test("test_standard_messages_converted_to_aws_bedrock_format", async () => {
    // LLMStandardMessage objects are converted to AWS Bedrock format.
    setUp();
    const standardMessages: LLMStandardMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello, how are you?" },
      { role: "assistant", content: "I'm doing well, thank you!" },
    ];

    const context = new LLMContext({ messages: standardMessages });

    const params: Any = await adapter.getLlmInvocationParams(context);

    expect(Array.isArray(params.system)).toBe(true);
    expect(params.system.length).toEqual(1);
    expect(params.system[0].text).toEqual("You are a helpful assistant.");

    expect(params).toHaveProperty("messages");
    expect(params.messages.length).toEqual(2);

    const userMsg = params.messages[0];
    expect(userMsg.role).toEqual("user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content.length).toEqual(1);
    expect(userMsg.content[0].text).toEqual("Hello, how are you?");

    const assistantMsg = params.messages[1];
    expect(assistantMsg.role).toEqual("assistant");
    expect(Array.isArray(assistantMsg.content)).toBe(true);
    expect(assistantMsg.content.length).toEqual(1);
    expect(assistantMsg.content[0].text).toEqual("I'm doing well, thank you!");
  });

  test("test_llm_specific_message_filtering", async () => {
    // AWS-specific messages are included and others are filtered out.
    setUp();
    const awsMessageContent = {
      role: "user",
      content: [
        { text: "Hello" },
        {
          image: {
            format: "jpeg",
            source: { bytes: new TextEncoder().encode("fake_image_data") },
          },
        },
      ],
    };

    const messages = [
      { role: "user", content: "Standard message" },
      new OpenAILLMAdapter().createLlmSpecificMessage({ role: "user", content: "OpenAI specific" }),
      new GeminiLLMAdapter().createLlmSpecificMessage({ role: "user", content: "Google specific" }),
      adapter.createLlmSpecificMessage(awsMessageContent),
      { role: "assistant", content: "Response" },
    ];

    const context = new LLMContext({ messages: messages as Any });

    const params: Any = await adapter.getLlmInvocationParams(context);

    // (openai and google specific filtered out, standard + aws-specific merged)
    expect(params.messages.length).toEqual(2);

    const userMsg = params.messages[0];
    expect(userMsg.role).toEqual("user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    // Should have 3 content blocks: standard text + aws text + aws image
    expect(userMsg.content.length).toEqual(3);
    expect(userMsg.content[0].text).toEqual("Standard message");
    expect(userMsg.content[1].text).toEqual("Hello");
    expect(userMsg.content[2]).toHaveProperty("image");

    expect(params.messages[1].content[0].text).toEqual("Response");
  });

  test("test_consecutive_same_role_messages_merged", async () => {
    // Consecutive messages with the same role are merged into multi-content blocks.
    setUp();
    const messages = [
      { role: "user", content: "First user message" },
      { role: "user", content: "Second user message" },
      { role: "user", content: "Third user message" },
      { role: "assistant", content: "First assistant message" },
      { role: "assistant", content: "Second assistant message" },
    ];

    const context = new LLMContext({ messages });

    const params: Any = await adapter.getLlmInvocationParams(context);

    expect(params.messages.length).toEqual(2);

    const userMsg = params.messages[0];
    expect(userMsg.role).toEqual("user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content.length).toEqual(3);
    expect(userMsg.content[0].text).toEqual("First user message");
    expect(userMsg.content[1].text).toEqual("Second user message");
    expect(userMsg.content[2].text).toEqual("Third user message");

    const assistantMsg = params.messages[1];
    expect(assistantMsg.role).toEqual("assistant");
    expect(Array.isArray(assistantMsg.content)).toBe(true);
    expect(assistantMsg.content.length).toEqual(2);
    expect(assistantMsg.content[0].text).toEqual("First assistant message");
    expect(assistantMsg.content[1].text).toEqual("Second assistant message");
  });

  test("test_empty_text_converted_to_empty_placeholder", async () => {
    // Empty text content is converted to "(empty)" string.
    setUp();
    const messages = [
      { role: "user", content: "" }, // Empty string
      {
        role: "assistant",
        content: [
          { type: "text", text: "" }, // Empty text in list content
          { type: "text", text: "Valid text" },
        ],
      },
    ];

    const context = new LLMContext({ messages: messages as Any });

    const params: Any = await adapter.getLlmInvocationParams(context);

    const userMsg = params.messages[0];
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[0].text).toEqual("(empty)");

    const assistantMsg = params.messages[1];
    expect(Array.isArray(assistantMsg.content)).toBe(true);
    expect(assistantMsg.content[0].text).toEqual("(empty)");
    expect(assistantMsg.content[1].text).toEqual("Valid text");
  });

  test("test_complex_message_content_preserved", async () => {
    // Complex message structures (text + image) are properly converted to AWS Bedrock format.
    setUp();
    const complexMessage = {
      role: "user",
      content: [
        { type: "text", text: "What do you see in this image?" },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${PNG_1X1}` } },
        { type: "text", text: "Please describe it in detail." },
      ],
    };

    const messages = [
      complexMessage,
      { role: "assistant", content: "I can see the image clearly." },
    ];

    const context = new LLMContext({ messages: messages as Any });

    const params: Any = await adapter.getLlmInvocationParams(context);

    expect(params.messages.length).toEqual(2);
    const userMsg = params.messages[0];
    expect(userMsg.role).toEqual("user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content.length).toEqual(3);

    // Note: AWS Bedrock adapter reorders single images to come before text, like Anthropic
    expect(userMsg.content[0]).toHaveProperty("image");
    expect(userMsg.content[0].image.format).toEqual("jpeg");
    expect(userMsg.content[0].image).toHaveProperty("source");
    expect(userMsg.content[0].image.source).toHaveProperty("bytes");

    expect(userMsg.content[1].text).toEqual("What do you see in this image?");

    expect(userMsg.content[2].text).toEqual("Please describe it in detail.");
  });

  test("test_multiple_system_instructions_handling", async () => {
    // First system instruction is extracted, later ones converted to user messages.
    setUp();
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "system", content: "Remember to be concise." }, // Later system message
    ];

    const context = new LLMContext({ messages });

    const params: Any = await adapter.getLlmInvocationParams(context);

    expect(Array.isArray(params.system)).toBe(true);
    expect(params.system.length).toEqual(1);
    expect(params.system[0].text).toEqual("You are a helpful assistant.");

    expect(params.messages.length).toEqual(3);
    expect(params.messages[0].role).toEqual("user");
    expect(params.messages[0].content[0].text).toEqual("Hello");
    expect(params.messages[1].role).toEqual("assistant");
    expect(params.messages[1].content[0].text).toEqual("Hi there!");

    expect(params.messages[2].role).toEqual("user");
    expect(params.messages[2].content[0].text).toEqual("Remember to be concise.");
  });

  test("test_single_system_message_handling", async () => {
    // A single system message is converted to user role when no other messages exist.
    setUp();
    const messages = [{ role: "system", content: "You are a helpful assistant." }];

    const context = new LLMContext({ messages });

    const params: Any = await adapter.getLlmInvocationParams(context);

    // When there's only one message, it's converted to user in-place (not extracted)
    // so system is null
    expect(params.system).toBeNull();

    expect(params.messages.length).toEqual(1);
    expect(params.messages[0].role).toEqual("user");
    expect(params.messages[0].content[0].text).toEqual("You are a helpful assistant.");
  });

  test("test_system_instruction_only", async () => {
    // system_instruction alone becomes the system parameter.
    setUp();
    const messages: LLMStandardMessage[] = [{ role: "user", content: "Hello" }];
    const context = new LLMContext({ messages });
    const params = await adapter.getLlmInvocationParams(context, {
      systemInstruction: "Be helpful.",
    });

    expect(params.system).toEqual([{ text: "Be helpful." }]);
  });

  test("test_initial_developer_message_becomes_user", async () => {
    // Initial developer message without system_instruction becomes user, not system.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "developer", content: "Extra context." },
      { role: "assistant", content: "OK" },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });
    const params: Any = await adapter.getLlmInvocationParams(context);

    expect(params.system).toBeNull();
    expect(params.messages.length).toEqual(3);
    expect(params.messages[0].role).toEqual("user");
    expect(params.messages[0].content[0].text).toEqual("Extra context.");
  });

  test("test_both_system_instruction_and_system_message_warns", async () => {
    // system_instruction + initial system message warns and uses system_instruction.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    const params = await withMockLogger(async (mockLogger) => {
      const params = await adapter.getLlmInvocationParams(context, {
        systemInstruction: "Be concise.",
      });
      expect(mockLogger.warningCalls.length).toEqual(1);
      return params;
    });

    expect(params.system).toEqual([{ text: "Be concise." }]);
  });

  test("test_both_system_instruction_and_developer_message_no_warning", async () => {
    // system_instruction + initial developer message: no warning, developer becomes user.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "developer", content: "Extra context." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    const params: Any = await withMockLogger(async (mockLogger) => {
      const params = await adapter.getLlmInvocationParams(context, {
        systemInstruction: "Be concise.",
      });
      expect(mockLogger.warningCalls).toEqual([]);
      return params;
    });

    expect(params.system).toEqual([{ text: "Be concise." }]);
    expect(params.messages[0].role).toEqual("user");
  });

  test("test_subsequent_developer_messages_converted_to_user", async () => {
    // Subsequent developer messages are converted to user role.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "developer", content: "More instructions" },
    ];
    const context = new LLMContext({ messages });
    const params: Any = await adapter.getLlmInvocationParams(context);

    expect(params.messages[2].role).toEqual("user");
  });

  test("test_ensure_last_message_is_user_appends_when_trailing_assistant", async () => {
    // ensureLastMessageIsUser=true appends a user message after a trailing assistant.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      ensureLastMessageIsUser: true,
    });
    expect(params.messages.length).toEqual(3);
    expect(params.messages.at(-1).role).toEqual("user");
    expect(params.messages.at(-1).content).toEqual([{ text: "." }]);
  });

  test("test_ensure_last_message_is_user_off_keeps_trailing_assistant", async () => {
    // Without the flag (default), a trailing assistant message is preserved.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    });
    const params: Any = await adapter.getLlmInvocationParams(context);
    expect(params.messages.length).toEqual(2);
    expect(params.messages.at(-1).role).toEqual("assistant");
  });

  test("test_ensure_last_message_is_user_noop_when_trailing_user", async () => {
    // ensureLastMessageIsUser=true does nothing when the list already ends with a user.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ],
    });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      ensureLastMessageIsUser: true,
    });
    expect(params.messages.length).toEqual(3);
    expect(params.messages.at(-1).role).toEqual("user");
  });

  test("test_ensure_last_message_is_user_handles_empty_list", async () => {
    // ensureLastMessageIsUser=true handles an empty context.
    setUp();
    const params = await adapter.getLlmInvocationParams(new LLMContext(), {
      ensureLastMessageIsUser: true,
    });
    expect(params.messages.length).toEqual(0);
  });

  test("test_ensure_last_message_is_user_noop_when_tool_result_trailing", async () => {
    // ensureLastMessageIsUser=true does nothing when a tool result (user role) trails.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          tool_calls: [{ id: "t1", function: { name: "get_weather", arguments: "{}" } }],
        },
        { role: "tool", content: "Sunny, 22°C", tool_call_id: "t1" },
      ] as Any,
    });
    const params: Any = await adapter.getLlmInvocationParams(context, {
      ensureLastMessageIsUser: true,
    });
    expect(params.messages.at(-1).role).toEqual("user");
    expect(params.messages.at(-1).content[0]).toHaveProperty("toolResult");
  });

  test("test_image_before_text_does_not_raise_unbound_local_error", async () => {
    // Regression test for issue #4724: image placed before text must not raise.
    setUp();
    // Image appears FIRST (before text) — this is the failing shape from the issue.
    const message = {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${PNG_1X1}` } },
        { type: "text", text: "What do you see?" },
      ],
    };
    const context = new LLMContext({ messages: [message as Any] });

    // Must not raise.
    const params: Any = await adapter.getLlmInvocationParams(context);

    const userMsg = params.messages[0];
    expect(userMsg.role).toEqual("user");
    const content = userMsg.content;
    expect(content.length).toEqual(2);
    // Image was already first, so the adapter should leave it in place.
    expect(content[0]).toHaveProperty("image");
    expect(content[1].text).toEqual("What do you see?");
  });

  test("test_image_after_text_reordered_to_first", async () => {
    // Image placed after text is reordered to come before text (existing behaviour).
    setUp();
    const message = {
      role: "user",
      content: [
        { type: "text", text: "What do you see?" },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${PNG_1X1}` } },
      ],
    };
    const context = new LLMContext({ messages: [message as Any] });
    const params: Any = await adapter.getLlmInvocationParams(context);

    const userMsg = params.messages[0];
    const content = userMsg.content;
    expect(content.length).toEqual(2);
    // Adapter should have moved the image before the text.
    expect(content[0]).toHaveProperty("image");
    expect(content[1].text).toEqual("What do you see?");
  });

  test("test_thought_converted_to_reasoning_content", async () => {
    // A signed thought becomes a reasoning block merged into the assistant message.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "What's the weather?" },
        new LLMSpecificMessage({
          llm: "aws",
          message: { type: "thought", text: "Let me check.", signature: "sig" },
        }),
        {
          role: "assistant",
          tool_calls: [{ id: "t1", function: { name: "get_weather", arguments: "{}" } }],
        },
        { role: "tool", content: "Sunny", tool_call_id: "t1" },
      ] as Any,
    });
    const params: Any = await adapter.getLlmInvocationParams(context);

    // The thought and the tool call merge into a single assistant message,
    // with the reasoning first.
    expect(params.messages.length).toEqual(3);
    const content = params.messages[1].content;
    expect(content[0]).toEqual({
      reasoningContent: { reasoningText: { text: "Let me check.", signature: "sig" } },
    });
    expect(content[1].toolUse.toolUseId).toEqual("t1");
  });

  test("test_thought_without_signature_dropped", async () => {
    // A thought with no signature can't be passed back, so it's skipped.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "What's the weather?" },
        new LLMSpecificMessage({ llm: "aws", message: { type: "thought", text: "[REDACTED]" } }),
        { role: "assistant", content: "It's sunny." },
      ],
    });
    const params: Any = await adapter.getLlmInvocationParams(context);

    expect(params.messages.length).toEqual(2);
    expect(params.messages[1].content).toEqual([{ text: "It's sunny." }]);
  });

  test("test_thought_signature_elided_from_logs", () => {
    // Reasoning signatures are elided from logged messages.
    setUp();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "What's the weather?" },
        new LLMSpecificMessage({
          llm: "aws",
          message: { type: "thought", text: "Let me check.", signature: "sig" },
        }),
      ],
    });
    const messages: Any = adapter.getMessagesForLogging(context);

    const reasoning = messages[1].content[0].reasoningContent.reasoningText;
    expect(reasoning).toEqual({ text: "Let me check.", signature: "..." });
  });
});

describe("TestSanitizeBedrockDocumentName", () => {
  // Tests for bedrock_adapter._sanitizeBedrockDocumentName.

  test("test_dot_and_underscore_replaced_with_whitespace", () => {
    expect(_sanitizeBedrockDocumentName("my_notes.pdf")).toEqual("my notes pdf");
  });

  test("test_allowed_characters_preserved", () => {
    expect(_sanitizeBedrockDocumentName("Report (v2) [final] - draft")).toEqual(
      "Report (v2) [final] - draft",
    );
  });

  test("test_consecutive_whitespace_collapsed", () => {
    expect(_sanitizeBedrockDocumentName("weird   spacing")).toEqual("weird spacing");
  });

  test("test_leading_and_trailing_whitespace_stripped", () => {
    expect(_sanitizeBedrockDocumentName("  notes.txt  ")).toEqual("notes txt");
  });

  test("test_empty_or_fully_disallowed_name_falls_back_to_document", () => {
    expect(_sanitizeBedrockDocumentName("")).toEqual("document");
    expect(_sanitizeBedrockDocumentName("...")).toEqual("document");
  });
});

describe("TestPerplexityGetLLMInvocationParams", () => {
  // Perplexity doesn't support the "developer" role, so PerplexityLLMService
  // sets supportsDeveloperRole = false. Tests below pass
  // convertDeveloperToUser: true to match production behavior.

  let adapter: PerplexityLLMAdapter;
  const setUp = () => {
    adapter = new PerplexityLLMAdapter();
  };
  const invoke = (context: LLMContext): Promise<Any> =>
    adapter.getLlmInvocationParams(context, { convertDeveloperToUser: true });

  test("test_standard_messages_pass_through", async () => {
    // A valid [user, assistant, user] sequence passes through unchanged.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "How are you?" },
    ];

    const params = await invoke(new LLMContext({ messages }));

    expect(params.messages.length).toEqual(3);
    expect(params.messages[0].role).toEqual("user");
    expect(params.messages[0].content).toEqual("Hello");
    expect(params.messages[1].role).toEqual("assistant");
    expect(params.messages[1].content).toEqual("Hi there!");
    expect(params.messages[2].role).toEqual("user");
    expect(params.messages[2].content).toEqual("How are you?");
  });

  test("test_initial_system_message_preserved", async () => {
    // A valid [system, user, assistant, user] sequence passes through unchanged.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "Bye" },
    ];

    const params = await invoke(new LLMContext({ messages }));

    expect(params.messages.length).toEqual(4);
    expect(params.messages[0].role).toEqual("system");
    expect(params.messages[0].content).toEqual("You are a helpful assistant.");
    expect(params.messages[1].role).toEqual("user");
    expect(params.messages[2].role).toEqual("assistant");
    expect(params.messages[3].role).toEqual("user");
  });

  test("test_consecutive_same_role_messages_merged", async () => {
    // Consecutive user messages are merged into list-of-dicts content.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "user", content: "First message" },
      { role: "user", content: "Second message" },
      { role: "assistant", content: "Response" },
      { role: "user", content: "Third message" },
    ];

    const params = await invoke(new LLMContext({ messages }));

    expect(params.messages.length).toEqual(3);

    const merged = params.messages[0];
    expect(merged.role).toEqual("user");
    expect(Array.isArray(merged.content)).toBe(true);
    expect(merged.content.length).toEqual(2);
    expect(merged.content[0].type).toEqual("text");
    expect(merged.content[0].text).toEqual("First message");
    expect(merged.content[1].type).toEqual("text");
    expect(merged.content[1].text).toEqual("Second message");

    expect(params.messages[1].role).toEqual("assistant");
    expect(params.messages[2].role).toEqual("user");
  });

  test("test_non_initial_system_converted_to_user", async () => {
    // Non-initial system messages are converted to user and merged with adjacent user.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
      { role: "system", content: "Be concise." },
      { role: "user", content: "Tell me about Python." },
    ];

    const params = await invoke(new LLMContext({ messages }));

    // system(initial), user, assistant, merged(system→user + user)
    expect(params.messages.length).toEqual(4);
    expect(params.messages[0].role).toEqual("system");
    expect(params.messages[1].role).toEqual("user");
    expect(params.messages[2].role).toEqual("assistant");

    const merged = params.messages[3];
    expect(merged.role).toEqual("user");
    expect(Array.isArray(merged.content)).toBe(true);
    expect(merged.content.length).toEqual(2);
    expect(merged.content[0].text).toEqual("Be concise.");
    expect(merged.content[1].text).toEqual("Tell me about Python.");
  });

  test("test_multiple_system_messages_at_start_preserved", async () => {
    // Multiple consecutive system messages at start pass through unchanged.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "system", content: "Always be polite." },
      { role: "user", content: "Hello" },
    ];

    const params = await invoke(new LLMContext({ messages }));

    expect(params.messages.length).toEqual(3);
    expect(params.messages[0].role).toEqual("system");
    expect(params.messages[0].content).toEqual("You are a helpful assistant.");
    expect(params.messages[1].role).toEqual("system");
    expect(params.messages[1].content).toEqual("Always be polite.");
    expect(params.messages[2].role).toEqual("user");
    expect(params.messages[2].content).toEqual("Hello");
  });

  test("test_trailing_assistant_removed", async () => {
    // A trailing assistant message is removed.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];

    const params = await invoke(new LLMContext({ messages }));

    expect(params.messages.length).toEqual(1);
    expect(params.messages[0].role).toEqual("user");
    expect(params.messages[0].content).toEqual("Hello");
  });

  test("test_only_system_messages_preserved", async () => {
    // System-only contexts are left unchanged (no system→user conversion).
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
    ];

    const params = await invoke(new LLMContext({ messages }));

    expect(params.messages.length).toEqual(1);
    expect(params.messages[0].role).toEqual("system");
  });

  test("test_system_exposed_after_trailing_assistant_removed", async () => {
    // A system message exposed by trailing assistant removal stays system.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "assistant", content: "Sure thing." },
    ];

    const params = await invoke(new LLMContext({ messages }));

    // Trailing assistant removed → [system], system stays as-is
    expect(params.messages.length).toEqual(1);
    expect(params.messages[0].role).toEqual("system");
    expect(params.messages[0].content).toEqual("You are helpful.");
  });

  test("test_consecutive_assistants_merged_then_trailing_removed", async () => {
    // Consecutive assistant messages are merged, then trailing assistant is removed.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "First response" },
      { role: "assistant", content: "Second response" },
    ];

    const params = await invoke(new LLMContext({ messages }));

    // After merging assistants we get [user, assistant(merged)], then trailing
    // assistant is removed, leaving just [user]
    expect(params.messages.length).toEqual(1);
    expect(params.messages[0].role).toEqual("user");
    expect(params.messages[0].content).toEqual("Hello");
  });

  test("test_tool_messages_preserved", async () => {
    // Tool messages pass through without modification.
    setUp();
    const messages = [
      { role: "user", content: "What's the weather?" },
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [{ id: "1", function: { name: "get_weather", arguments: "{}" } }],
      },
      { role: "tool", content: "Sunny, 72F", tool_call_id: "1" },
      { role: "user", content: "Thanks!" },
    ];

    const params = await invoke(new LLMContext({ messages: messages as Any }));

    expect(params.messages.length).toEqual(4);
    expect(params.messages[0].role).toEqual("user");
    expect(params.messages[1].role).toEqual("assistant");
    expect(params.messages[2].role).toEqual("tool");
    expect(params.messages[2].content).toEqual("Sunny, 72F");
    expect(params.messages[3].role).toEqual("user");
  });

  test("test_developer_message_converted_to_user", async () => {
    // Developer messages are converted to user role.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "developer", content: "Extra context." },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Hello" },
    ];

    const params = await invoke(new LLMContext({ messages }));

    expect(params.messages[0].role).toEqual("user");
    expect(params.messages[0].content).toEqual("Extra context.");
  });

  test("test_developer_message_merged_with_adjacent_user", async () => {
    // Developer→user conversion merges with adjacent user messages.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "developer", content: "Be concise." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Bye" },
    ];

    const params = await invoke(new LLMContext({ messages }));

    // developer→user merged with following user
    expect(params.messages.length).toEqual(3);
    const merged = params.messages[0];
    expect(merged.role).toEqual("user");
    expect(Array.isArray(merged.content)).toBe(true);
    expect(merged.content.length).toEqual(2);
    expect(merged.content[0].text).toEqual("Be concise.");
    expect(merged.content[1].text).toEqual("Hello");
  });

  test("test_empty_messages", async () => {
    // An empty messages list returns empty.
    setUp();
    const params = await invoke(new LLMContext({ messages: [] }));

    expect(params.messages).toEqual([]);
  });
});

describe("TestDeepSeekGetLLMInvocationParams", () => {
  // DeepSeek doesn't support the "developer" role, so DeepSeekLLMService
  // sets supportsDeveloperRole = false. Tests below pass
  // convertDeveloperToUser: true to match production behavior.

  let adapter: DeepSeekLLMAdapter;
  const setUp = () => {
    adapter = new DeepSeekLLMAdapter();
  };
  const invoke = (context: LLMContext): Promise<Any> =>
    adapter.getLlmInvocationParams(context, { convertDeveloperToUser: true });

  const toolCall = (): Any => ({
    id: "call_1",
    type: "function",
    function: { name: "get_weather", arguments: '{"location": "LA"}' },
  });

  test("test_tool_call_message_gets_empty_reasoning_content", async () => {
    // An assistant tool-call message without reasoning_content gets an empty one.
    setUp();
    const messages = [
      { role: "user", content: "Weather in LA?" },
      { role: "assistant", tool_calls: [toolCall()] },
      { role: "tool", content: '{"temperature": "75"}', tool_call_id: "call_1" },
    ];

    const params = await invoke(new LLMContext({ messages: messages as Any }));

    const assistant = params.messages[1];
    expect(assistant.role).toEqual("assistant");
    expect(assistant.reasoning_content).toEqual("");
    expect(assistant.tool_calls).toEqual([toolCall()]);
  });

  test("test_spoken_text_before_tool_call_also_stamped", async () => {
    // Assistant text recorded before a tool call (e.g. spoken via TTS) is stamped too.
    setUp();
    const messages = [
      { role: "user", content: "Weather in LA?" },
      { role: "assistant", content: "Let me check on that." },
      { role: "assistant", tool_calls: [toolCall()] },
      { role: "tool", content: '{"temperature": "75"}', tool_call_id: "call_1" },
    ];

    const params = await invoke(new LLMContext({ messages: messages as Any }));

    expect(params.messages[1].content).toEqual("Let me check on that.");
    expect(params.messages[1].reasoning_content).toEqual("");
    expect(params.messages[2].reasoning_content).toEqual("");
  });

  test("test_existing_reasoning_content_preserved", async () => {
    // An assistant message that already carries reasoning_content is left alone.
    setUp();
    const messages = [
      { role: "user", content: "Weather in LA?" },
      {
        role: "assistant",
        tool_calls: [toolCall()],
        reasoning_content: "Need the weather tool.",
      },
    ];

    const params = await invoke(new LLMContext({ messages: messages as Any }));

    expect(params.messages[1].reasoning_content).toEqual("Need the weather tool.");
  });

  test("test_non_assistant_messages_untouched", async () => {
    // System, user, and tool messages never get the field.
    setUp();
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Weather in LA?" },
      { role: "assistant", tool_calls: [toolCall()] },
      { role: "tool", content: '{"temperature": "75"}', tool_call_id: "call_1" },
      { role: "user", content: "Thanks." },
    ];

    const params = await invoke(new LLMContext({ messages: messages as Any }));

    for (const i of [0, 1, 3, 4]) {
      expect(params.messages[i]).not.toHaveProperty("reasoning_content");
    }
    expect(params.messages[2].reasoning_content).toEqual("");
  });

  test("test_context_messages_not_mutated", async () => {
    // Stamping produces copies; the context's own message dicts are unchanged.
    setUp();
    const assistant: LLMStandardMessage = { role: "assistant", content: "Hi!" };
    const messages: LLMStandardMessage[] = [{ role: "user", content: "Hello" }, assistant];

    const context = new LLMContext({ messages });
    const params = await invoke(context);

    expect(params.messages[1].reasoning_content).toEqual("");
    expect(assistant).not.toHaveProperty("reasoning_content");
    expect(context.getMessages()[1]).not.toHaveProperty("reasoning_content");
  });
});

describe("TestOpenAIResponsesGetLLMInvocationParams", () => {
  let adapter: OpenAIResponsesLLMAdapter;
  const setUp = () => {
    adapter = new OpenAIResponsesLLMAdapter();
  };

  test("test_simple_user_assistant_messages", async () => {
    // Simple user/assistant text messages are converted correctly.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    const params: Any = await adapter.getLlmInvocationParams(new LLMContext({ messages }));

    expect(params.input.length).toEqual(2);
    expect(params.input[0]).toEqual({ role: "user", content: "Hello" });
    expect(params.input[1]).toEqual({ role: "assistant", content: "Hi there!" });
  });

  test("test_system_role_converted_to_developer", async () => {
    // System role messages are converted to developer role.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const params: Any = await adapter.getLlmInvocationParams(new LLMContext({ messages }));

    expect(params.input[0].role).toEqual("developer");
    expect(params.input[0].content).toEqual("You are helpful.");
  });

  test("test_developer_role_kept_as_developer", async () => {
    // Developer role messages are kept as developer role.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "developer", content: "Extra context." },
      { role: "user", content: "Hello" },
    ];
    const params: Any = await adapter.getLlmInvocationParams(new LLMContext({ messages }));

    expect(params.input[0].role).toEqual("developer");
    expect(params.input[0].content).toEqual("Extra context.");
  });

  test("test_system_message_without_system_instruction_no_warning", async () => {
    // System message without system_instruction does not trigger a warning.
    const adapter = new OpenAIResponsesLLMAdapter();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    await withMockLogger(async (mockLogger) => {
      await adapter.getLlmInvocationParams(context);
      expect(mockLogger.warningCalls).toEqual([]);
    });
  });

  test("test_system_message_with_system_instruction_triggers_warning", async () => {
    // System message + system_instruction triggers a conflict warning.
    const adapter = new OpenAIResponsesLLMAdapter();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    await withMockLogger(async (mockLogger) => {
      await adapter.getLlmInvocationParams(context, { systemInstruction: "Be concise." });
      expect(mockLogger.warningCalls.length).toEqual(1);
      expect(mockLogger.lastWarning).toContain("system_instruction");
    });
  });

  test("test_developer_message_with_system_instruction_no_warning", async () => {
    // Developer message + system_instruction does NOT trigger a warning.
    const adapter = new OpenAIResponsesLLMAdapter();
    const messages: LLMStandardMessage[] = [
      { role: "developer", content: "Extra context." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    const params: Any = await withMockLogger(async (mockLogger) => {
      const params = await adapter.getLlmInvocationParams(context, {
        systemInstruction: "Be concise.",
      });
      expect(mockLogger.warningCalls).toEqual([]);
      return params;
    });

    // Developer message stays as developer, system_instruction becomes instructions
    expect(params.input[0].role).toEqual("developer");
    expect(params.instructions).toEqual("Be concise.");
  });

  test("test_non_initial_system_message_no_warning", async () => {
    // Non-initial system messages are converted without a warning.
    const messages: LLMStandardMessage[] = [
      { role: "user", content: "Hello" },
      { role: "system", content: "New instruction" },
    ];
    const context = new LLMContext({ messages });

    const adapter = new OpenAIResponsesLLMAdapter();
    const params: Any = await withMockLogger(async (mockLogger) => {
      const params = await adapter.getLlmInvocationParams(context, {
        systemInstruction: "Be helpful.",
      });
      expect(mockLogger.warningCalls).toEqual([]);
      return params;
    });

    expect(params.input[1].role).toEqual("developer");
    expect(params.input[1].content).toEqual("New instruction");
  });

  test("test_conflict_warning_fires_only_once", async () => {
    // The conflict warning fires only once per adapter instance.
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    const adapter = new OpenAIResponsesLLMAdapter();
    await withMockLogger(async (mockLogger) => {
      await adapter.getLlmInvocationParams(context, { systemInstruction: "Be concise." });
      await adapter.getLlmInvocationParams(context, { systemInstruction: "Be concise." });
      expect(mockLogger.warningCalls.length).toEqual(1);
    });
  });

  test("test_assistant_tool_calls_to_function_call", async () => {
    // Assistant messages with tool_calls produce function_call input items.
    setUp();
    const messages = [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_123",
            function: { name: "get_weather", arguments: '{"location": "SF"}' },
            type: "function",
          },
        ],
      },
    ];
    const params: Any = await adapter.getLlmInvocationParams(
      new LLMContext({ messages: messages as Any }),
    );

    expect(params.input.length).toEqual(1);
    const fc = params.input[0];
    expect(fc.type).toEqual("function_call");
    expect(fc.call_id).toEqual("call_123");
    expect(fc.name).toEqual("get_weather");
    expect(fc.arguments).toEqual('{"location": "SF"}');
  });

  test("test_multiple_tool_calls", async () => {
    // Multiple tool calls in one assistant message produce multiple function_call items.
    setUp();
    const messages = [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            function: { name: "get_weather", arguments: '{"location": "SF"}' },
            type: "function",
          },
          {
            id: "call_2",
            function: { name: "get_restaurant", arguments: '{"location": "SF"}' },
            type: "function",
          },
        ],
      },
    ];
    const params: Any = await adapter.getLlmInvocationParams(
      new LLMContext({ messages: messages as Any }),
    );

    expect(params.input.length).toEqual(2);
    expect(params.input[0].name).toEqual("get_weather");
    expect(params.input[1].name).toEqual("get_restaurant");
  });

  test("test_tool_message_to_function_call_output", async () => {
    // Tool role messages produce function_call_output input items.
    setUp();
    const messages = [{ role: "tool", content: '{"temperature": "72"}', tool_call_id: "call_123" }];
    const params: Any = await adapter.getLlmInvocationParams(
      new LLMContext({ messages: messages as Any }),
    );

    expect(params.input.length).toEqual(1);
    const fco = params.input[0];
    expect(fco.type).toEqual("function_call_output");
    expect(fco.call_id).toEqual("call_123");
    expect(fco.output).toEqual('{"temperature": "72"}');
  });

  test("test_mixed_conversation", async () => {
    // Mixed conversation with text + function calls converts correctly.
    setUp();
    const messages = [
      { role: "user", content: "What's the weather in SF?" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_abc",
            function: { name: "get_weather", arguments: '{"location": "SF"}' },
            type: "function",
          },
        ],
      },
      { role: "tool", content: '{"temp": "72"}', tool_call_id: "call_abc" },
      { role: "assistant", content: "It's 72 degrees in SF." },
    ];
    const params: Any = await adapter.getLlmInvocationParams(
      new LLMContext({ messages: messages as Any }),
    );

    expect(params.input.length).toEqual(4);
    expect(params.input[0].role).toEqual("user");
    expect(params.input[1].type).toEqual("function_call");
    expect(params.input[2].type).toEqual("function_call_output");
    expect(params.input[3].role).toEqual("assistant");
  });

  test("test_multimodal_text_conversion", async () => {
    // Multimodal text content parts are converted to input_text.
    setUp();
    const messages = [{ role: "user", content: [{ type: "text", text: "What's in this image?" }] }];
    const params: Any = await adapter.getLlmInvocationParams(
      new LLMContext({ messages: messages as Any }),
    );

    const content = params.input[0].content;
    expect(content.length).toEqual(1);
    expect(content[0].type).toEqual("input_text");
    expect(content[0].text).toEqual("What's in this image?");
  });

  test("test_multimodal_image_conversion", async () => {
    // Multimodal image_url content parts are converted to input_image.
    setUp();
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this:" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc123" } },
        ],
      },
    ];
    const params: Any = await adapter.getLlmInvocationParams(
      new LLMContext({ messages: messages as Any }),
    );

    const content = params.input[0].content;
    expect(content.length).toEqual(2);
    expect(content[0].type).toEqual("input_text");
    expect(content[1].type).toEqual("input_image");
    expect(content[1].image_url).toEqual("data:image/jpeg;base64,abc123");
    expect(content[1].detail).toEqual("auto");
  });

  test("test_multimodal_image_with_detail", async () => {
    // Image content parts preserve the detail setting when provided.
    setUp();
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://example.com/img.png", detail: "high" } },
        ],
      },
    ];
    const params: Any = await adapter.getLlmInvocationParams(
      new LLMContext({ messages: messages as Any }),
    );

    const content = params.input[0].content;
    expect(content[0].detail).toEqual("high");
  });

  test("test_image_file_url_converted_to_input_image", async () => {
    // A file_url with an image MIME type becomes input_image, not input_file.
    setUp();
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "file_url",
            file: { url: "https://example.com/photo.jpg", mime_type: "image/jpeg" },
          },
        ],
      },
    ];
    const params: Any = await adapter.getLlmInvocationParams(
      new LLMContext({ messages: messages as Any }),
    );

    const content = params.input[0].content;
    expect(content[0].type).toEqual("input_image");
    expect(content[0].image_url).toEqual("https://example.com/photo.jpg");
  });

  test("test_non_image_file_url_converted_to_input_file", async () => {
    // A file_url with a non-image MIME type becomes input_file.
    setUp();
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "file_url",
            file: { url: "https://example.com/doc.pdf", mime_type: "application/pdf" },
          },
        ],
      },
    ];
    const params: Any = await adapter.getLlmInvocationParams(
      new LLMContext({ messages: messages as Any }),
    );

    const content = params.input[0].content;
    expect(content[0].type).toEqual("input_file");
    expect(content[0].file_url).toEqual("https://example.com/doc.pdf");
  });

  test("test_image_file_base64_converted_to_input_image", async () => {
    // An inline image file becomes input_image content with a data URL.
    setUp();
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "file_base64",
            file: { file_data: dataUrl, filename: "a.png", mime_type: "image/png" },
          },
        ],
      },
    ];
    const params: Any = await adapter.getLlmInvocationParams(
      new LLMContext({ messages: messages as Any }),
    );

    const content = params.input[0].content;
    expect(content[0].type).toEqual("input_image");
    expect(content[0].image_url).toEqual(dataUrl);
  });

  test("test_tools_schema_flattening", async () => {
    // Tools schema with nested function dict is flattened to Responses API format.
    setUp();
    const weatherFn = new FunctionSchema({
      name: "get_weather",
      description: "Get the current weather",
      properties: { location: { type: "string", description: "The city" } },
      required: ["location"],
    });
    const tools = new ToolsSchema({ standardTools: [weatherFn] });
    const context = new LLMContext({ tools });
    const params: Any = await adapter.getLlmInvocationParams(context);

    const toolList = params.tools;
    expect(toolList.length).toEqual(1);
    const tool = toolList[0];
    expect(tool.type).toEqual("function");
    expect(tool.name).toEqual("get_weather");
    expect(tool.description).toEqual("Get the current weather");
    expect(tool.parameters).toHaveProperty("properties");
  });

  test("test_tools_absent_yields_openai_sentinel", async () => {
    // A context without tools yields the sentinel the SDK omits from the request.
    setUp();
    const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });
    const params = await adapter.getLlmInvocationParams(context);

    expect(params.tools).toBe(OPENAI_NOT_GIVEN);
  });

  test("test_empty_messages", async () => {
    // Empty messages list produces empty input list.
    setUp();
    const params = await adapter.getLlmInvocationParams(new LLMContext({ messages: [] }));
    expect(params.input).toEqual([]);
  });

  test("test_llm_specific_message_passthrough", async () => {
    // LLMSpecificMessage with llm='openai_responses' passes through.
    setUp();
    const specificMsg = adapter.createLlmSpecificMessage({
      type: "function_call",
      call_id: "x",
      name: "foo",
      arguments: "{}",
    });
    const messages = [{ role: "user", content: "Hello" }, specificMsg];
    const params: Any = await adapter.getLlmInvocationParams(
      new LLMContext({ messages: messages as Any }),
    );

    expect(params.input.length).toEqual(2);
    expect(params.input[0].role).toEqual("user");
    expect(params.input[1].type).toEqual("function_call");
  });

  test("test_reasoning_message_becomes_reasoning_item", async () => {
    // A persisted reasoning message converts to a Responses reasoning item.
    setUp();
    const reasoningMsg = adapter.createLlmSpecificMessage({
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "Let me think." }],
      encrypted_content: "ENCRYPTED",
    });
    const params: Any = await adapter.getLlmInvocationParams(
      new LLMContext({ messages: [reasoningMsg] }),
    );

    expect(params.input[0]).toEqual({
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "Let me think." }],
      encrypted_content: "ENCRYPTED",
    });
  });

  test("test_reasoning_precedes_assistant_message", async () => {
    // Reasoning round-trips positioned before the assistant reply it produced.
    setUp();
    const reasoningMsg = adapter.createLlmSpecificMessage({
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "ENCRYPTED",
    });
    const context = new LLMContext({
      messages: [reasoningMsg, { role: "assistant", content: "Hello!" }],
    });
    const params: Any = await adapter.getLlmInvocationParams(context);

    expect(params.input[0].type).toEqual("reasoning");
    expect(params.input[1].role).toEqual("assistant");
  });

  test("test_reasoning_without_encrypted_content_omits_field", async () => {
    // encrypted_content is optional; omit it rather than send null.
    setUp();
    const reasoningMsg = adapter.createLlmSpecificMessage({
      type: "reasoning",
      id: "rs_2",
      summary: [],
    });
    const params: Any = await adapter.getLlmInvocationParams(
      new LLMContext({ messages: [reasoningMsg] }),
    );

    expect(params.input[0].type).toEqual("reasoning");
    expect(params.input[0].id).toEqual("rs_2");
    expect(params.input[0]).not.toHaveProperty("encrypted_content");
  });

  test("test_id_for_llm_specific_messages", () => {
    // Adapter identifier is 'openai_responses'.
    setUp();
    expect(adapter.idForLlmSpecificMessages).toEqual("openai_responses");
  });

  test("test_system_instruction_with_messages_sets_instructions", async () => {
    // When system_instruction is provided and input is non-empty, sets instructions.
    setUp();
    const messages: LLMStandardMessage[] = [{ role: "user", content: "Hello" }];
    const params: Any = await adapter.getLlmInvocationParams(new LLMContext({ messages }), {
      systemInstruction: "Be helpful.",
    });

    expect(params.instructions).toEqual("Be helpful.");
    expect(params.input.length).toEqual(1);
    expect(params.input[0].role).toEqual("user");
  });

  test("test_system_instruction_with_empty_input_becomes_developer_message", async () => {
    // When system_instruction is provided but input is empty, it becomes a developer message.
    setUp();
    const params: Any = await adapter.getLlmInvocationParams(new LLMContext({ messages: [] }), {
      systemInstruction: "Be helpful.",
    });

    expect(params).not.toHaveProperty("instructions");
    expect(params.input.length).toEqual(1);
    expect(params.input[0].role).toEqual("developer");
    expect(params.input[0].content).toEqual("Be helpful.");
  });

  test("test_no_system_instruction_omits_instructions", async () => {
    // When no system_instruction is provided, instructions key is absent.
    setUp();
    const context = new LLMContext({ messages: [{ role: "user", content: "Hi" }] });
    const params = await adapter.getLlmInvocationParams(context);

    expect(params).not.toHaveProperty("instructions");
  });
});

/**
 * The shared `system_instruction` / developer-message tests for the realtime
 * adapters (`TestOpenAIRealtimeGetLLMInvocationParams`,
 * `TestGrokRealtimeGetLLMInvocationParams`).
 */
function realtimeSystemInstructionTests(makeAdapter: () => Any): void {
  let adapter: Any;
  const setUp = () => {
    adapter = makeAdapter();
  };

  test("test_system_message_extracted_as_instruction", async () => {
    // Initial system message is extracted as system_instruction.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const params = await adapter.getLlmInvocationParams(new LLMContext({ messages }));

    expect(params.system_instruction).toEqual("You are helpful.");
    expect(params.messages.length).toEqual(1);
  });

  test("test_developer_message_becomes_user", async () => {
    // Developer message is converted to user, not extracted as system instruction.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "developer", content: "Extra context." },
      { role: "user", content: "Hello" },
    ];
    const params = await adapter.getLlmInvocationParams(new LLMContext({ messages }));

    expect(params.system_instruction).toBeNull();
    // Developer converted to user, then packed with the other user message
    expect(params.messages.length).toEqual(1);
  });

  test("test_subsequent_developer_message_becomes_user", async () => {
    // Non-initial developer message is converted to user.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "developer", content: "Extra context." },
    ];
    const params = await adapter.getLlmInvocationParams(new LLMContext({ messages }));

    expect(params.system_instruction).toEqual("You are helpful.");
    // Developer message converted to user
    expect(params.messages.length).toEqual(1);
  });

  test("test_empty_messages", async () => {
    // Empty messages list returns empty.
    setUp();
    const params = await adapter.getLlmInvocationParams(new LLMContext({ messages: [] }));

    expect(params.messages).toEqual([]);
    expect(params.system_instruction).toBeNull();
  });

  test("test_both_system_instruction_and_system_message_warns", async () => {
    // system_instruction + initial system message warns and uses system_instruction.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    const params = await withMockLogger(async (mockLogger) => {
      const params = await adapter.getLlmInvocationParams(context, {
        systemInstruction: "Be concise.",
      });
      expect(mockLogger.warningCalls.length).toEqual(1);
      return params;
    });

    expect(params.system_instruction).toEqual("Be concise.");
  });

  test("test_both_system_instruction_and_developer_message_no_warning", async () => {
    // system_instruction + initial developer message: no warning, developer becomes user.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "developer", content: "Extra context." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    const params = await withMockLogger(async (mockLogger) => {
      const params = await adapter.getLlmInvocationParams(context, {
        systemInstruction: "Be concise.",
      });
      expect(mockLogger.warningCalls).toEqual([]);
      return params;
    });

    expect(params.system_instruction).toEqual("Be concise.");
  });

  test("test_system_instruction_only", async () => {
    // system_instruction without context system message returns system_instruction.
    setUp();
    const messages: LLMStandardMessage[] = [{ role: "user", content: "Hello" }];
    const params = await adapter.getLlmInvocationParams(new LLMContext({ messages }), {
      systemInstruction: "Be concise.",
    });

    expect(params.system_instruction).toEqual("Be concise.");
  });
}

describe("TestOpenAIRealtimeGetLLMInvocationParams", () => {
  realtimeSystemInstructionTests(() => new OpenAIRealtimeLLMAdapter());
});

describe("TestRealtimePackedHistoryKeepsNonAscii", () => {
  test("test_packed_history_is_not_escaped", async () => {
    // Multi-message history packed into one text item keeps non-ASCII text readable.
    for (const cls of [
      OpenAIRealtimeLLMAdapter,
      GrokRealtimeLLMAdapter,
      InworldRealtimeLLMAdapter,
      AzureVoiceLiveLLMAdapter,
    ] as Any[]) {
      const messages: LLMStandardMessage[] = [
        { role: "user", content: "मेरा ऑर्डर कहाँ है?" },
        { role: "assistant", content: "आपका ऑर्डर कल पहुँचेगा।" },
      ];
      const params = await new cls().getLlmInvocationParams(new LLMContext({ messages }));
      const text = params.messages[0].content[0].text;
      expect(text).toContain("मेरा ऑर्डर कहाँ है?");
      expect(text).toContain("आपका ऑर्डर कल पहुँचेगा।");
    }
  });
});

describe("TestGrokRealtimeGetLLMInvocationParams", () => {
  realtimeSystemInstructionTests(() => new GrokRealtimeLLMAdapter());
});

describe("TestAWSNovaSonicGetLLMInvocationParams", () => {
  let adapter: AWSNovaSonicLLMAdapter;
  const setUp = () => {
    adapter = new AWSNovaSonicLLMAdapter();
  };

  test("test_system_message_extracted_as_instruction", async () => {
    // Initial system message is extracted as system_instruction.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const params = await adapter.getLlmInvocationParams(new LLMContext({ messages }));

    expect(params.system_instruction).toEqual("You are helpful.");
    expect(params.messages.length).toEqual(1);
  });

  test("test_developer_message_becomes_user", async () => {
    // Developer message is converted to user, not extracted as system instruction.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "developer", content: "Extra context." },
      { role: "user", content: "Hello" },
    ];
    const params = await adapter.getLlmInvocationParams(new LLMContext({ messages }));

    expect(params.system_instruction).toBeNull();
    // Both messages should be present (developer as user, plus the real user)
    expect(params.messages.length).toEqual(2);
  });

  test("test_subsequent_developer_message_becomes_user", async () => {
    // Non-initial developer message is converted to user.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "developer", content: "Extra context." },
      { role: "assistant", content: "Hi" },
    ];
    const params = await adapter.getLlmInvocationParams(new LLMContext({ messages }));

    expect(params.system_instruction).toEqual("You are helpful.");
    // Developer becomes user, plus assistant
    expect(params.messages.length).toEqual(2);
  });

  test("test_both_system_instruction_and_system_message_warns", async () => {
    // system_instruction + initial system message warns and uses system_instruction.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    const params = await withMockLogger(async (mockLogger) => {
      const params = await adapter.getLlmInvocationParams(context, {
        systemInstruction: "Be concise.",
      });
      expect(mockLogger.warningCalls.length).toEqual(1);
      return params;
    });

    expect(params.system_instruction).toEqual("Be concise.");
  });

  test("test_both_system_instruction_and_developer_message_no_warning", async () => {
    // system_instruction + initial developer message: no warning, developer becomes user.
    setUp();
    const messages: LLMStandardMessage[] = [
      { role: "developer", content: "Extra context." },
      { role: "user", content: "Hello" },
    ];
    const context = new LLMContext({ messages });

    const params = await withMockLogger(async (mockLogger) => {
      const params = await adapter.getLlmInvocationParams(context, {
        systemInstruction: "Be concise.",
      });
      expect(mockLogger.warningCalls).toEqual([]);
      return params;
    });

    expect(params.system_instruction).toEqual("Be concise.");
  });

  test("test_system_instruction_only", async () => {
    // system_instruction without context system message returns system_instruction.
    setUp();
    const messages: LLMStandardMessage[] = [{ role: "user", content: "Hello" }];
    const params = await adapter.getLlmInvocationParams(new LLMContext({ messages }), {
      systemInstruction: "Be concise.",
    });

    expect(params.system_instruction).toEqual("Be concise.");
  });
});

describe("TestBaseLLMAdapterHelpers", () => {
  // Tests for the shared helper methods on BaseLLMAdapter.

  let adapter: Any;
  const setUp = () => {
    // Use OpenAILLMAdapter as a concrete implementation for testing the base helpers
    adapter = new OpenAILLMAdapter();
  };

  test("test_extract_system_message", () => {
    // System message is extracted from messages[0].
    setUp();
    const messages = [
      { role: "system", content: "Be helpful." },
      { role: "user", content: "Hello" },
    ];
    const content = adapter._extractInitialSystem(messages, { systemInstruction: null });

    expect(content).toEqual("Be helpful.");
    expect(messages.length).toEqual(1); // popped
  });

  test("test_extract_developer_not_extracted", () => {
    // Developer message is not extracted by _extractInitialSystem.
    setUp();
    const messages = [
      { role: "developer", content: "Context." },
      { role: "user", content: "Hello" },
    ];
    const content = adapter._extractInitialSystem(messages, { systemInstruction: null });

    expect(content).toBeNull();
    expect(messages.length).toEqual(2); // not popped
    expect(messages[0]?.role).toEqual("developer"); // unchanged
  });

  test("test_developer_with_system_instruction_not_extracted", () => {
    // Developer message with system_instruction is not handled by _extractInitialSystem.
    setUp();
    const messages = [
      { role: "developer", content: "Context." },
      { role: "user", content: "Hello" },
    ];
    const content = adapter._extractInitialSystem(messages, { systemInstruction: "Be helpful." });

    expect(content).toBeNull();
    expect(messages.length).toEqual(2); // not popped
    expect(messages[0]?.role).toEqual("developer"); // unchanged by helper
  });

  test("test_single_system_message_becomes_user", () => {
    // Single system message is converted to user instead of extracting (empty prevention).
    setUp();
    const messages = [{ role: "system", content: "Be helpful." }];
    const content = adapter._extractInitialSystem(messages, { systemInstruction: null });

    expect(content).toBeNull();
    expect(messages.length).toEqual(1); // not popped
    expect(messages[0]?.role).toEqual("user");
  });

  test("test_single_system_message_with_system_instruction_warns", async () => {
    // Single system message + system_instruction still warns even though content isn't extracted.
    setUp();
    const messages = [{ role: "system", content: "Be helpful." }];

    const adapter: Any = new OpenAILLMAdapter();
    const content = await withMockLogger((mockLogger) => {
      const content = adapter._extractInitialSystem(messages, { systemInstruction: "Be concise." });
      expect(mockLogger.warningCalls.length).toEqual(1);
      return content;
    });

    expect(content).toBeNull();
    expect(messages[0]?.role).toEqual("user");
  });

  test("test_non_system_message_ignored", () => {
    // Non-system/developer first message is ignored.
    setUp();
    const messages = [{ role: "user", content: "Hello" }];
    const content = adapter._extractInitialSystem(messages, { systemInstruction: null });

    expect(content).toBeNull();
    expect(messages.length).toEqual(1);
  });

  test("test_empty_messages", () => {
    // Empty messages list returns null.
    setUp();
    const messages: Any[] = [];
    const content = adapter._extractInitialSystem(messages, { systemInstruction: null });

    expect(content).toBeNull();
  });

  test("test_resolve_both_system_discard", async () => {
    // Resolve with discard=true: system_instruction wins, warns.
    setUp();
    const result = await withMockLogger((mockLogger) => {
      const result = adapter._resolveSystemInstruction("from context", "from settings", {
        discardContextSystem: true,
      });
      expect(mockLogger.warningCalls.length).toEqual(1);
      expect(mockLogger.lastWarning).toContain("is not sent to the model");
      return result;
    });

    expect(result).toEqual("from settings");
  });

  test("test_resolve_both_system_keep", async () => {
    // Resolve with discard=false: warns but returns system_instruction.
    setUp();
    const result = await withMockLogger((mockLogger) => {
      const result = adapter._resolveSystemInstruction("from context", "from settings", {
        discardContextSystem: false,
      });
      expect(mockLogger.warningCalls.length).toEqual(1);
      return result;
    });

    expect(result).toEqual("from settings");
  });

  test("test_resolve_only_system_instruction", async () => {
    // Only system_instruction: returns it, no warning.
    setUp();
    const result = await withMockLogger((mockLogger) => {
      const result = adapter._resolveSystemInstruction(null, "from settings", {
        discardContextSystem: true,
      });
      expect(mockLogger.warningCalls).toEqual([]);
      return result;
    });

    expect(result).toEqual("from settings");
  });

  test("test_resolve_only_context_system_discard", () => {
    // Only context system (discard=true): returns it.
    setUp();
    const result = adapter._resolveSystemInstruction("from context", null, {
      discardContextSystem: true,
    });

    expect(result).toEqual("from context");
  });

  test("test_resolve_only_context_system_keep", () => {
    // Only context system (discard=false): returns null (already in messages).
    setUp();
    const result = adapter._resolveSystemInstruction("from context", null, {
      discardContextSystem: false,
    });

    expect(result).toBeNull();
  });
});

describe("TestTrailingUserMessageInjection", () => {
  // Model gating for the no-prefill trailing-user-message injection.
  //
  // Claude 4.6+ models reject requests whose message list ends with an
  // assistant message. Injection must default to ON for any model not known
  // to support prefill (so future models are covered) and stay OFF for the
  // frozen legacy set that still supports prefill.

  const anthropic = (settings: Any): Any =>
    new AnthropicLLMService({
      apiKey: "test-key",
      settings: new AnthropicLLMService.Settings(settings),
    });

  const bedrock = (settings: Any): Any =>
    new AWSBedrockLLMService({
      awsRegion: "us-east-1",
      settings: new AWSBedrockLLMService.Settings(settings),
    });

  test("test_anthropic_no_prefill_models_inject", () => {
    // Models without prefill support — including unknown future ones — inject.
    for (const model of [
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-opus-4-8",
      "claude-sonnet-5", // hypothetical future model: must default to inject
    ]) {
      const service = anthropic({ model });
      expect([model, service._shouldInjectTrailingUserMessage()]).toEqual([model, true]);
    }
  });

  test("test_anthropic_legacy_prefill_models_do_not_inject", () => {
    // Models known to support prefill are left untouched.
    for (const model of [
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-5",
      "claude-opus-4-1",
      "claude-3-7-sonnet-latest",
    ]) {
      const service = anthropic({ model });
      expect([model, service._shouldInjectTrailingUserMessage()]).toEqual([model, false]);
    }
  });

  test("test_prefill_patterns_overridable_by_subclass", () => {
    // Deployments with exotic model naming can override the pattern set.
    class CustomService extends AnthropicLLMService {
      static override _PREFILL_SUPPORTED_PATTERNS: readonly string[] = ["my-claude-proxy"];
    }

    const service: Any = new CustomService({
      apiKey: "test-key",
      settings: new CustomService.Settings({ model: "my-claude-proxy-v2" }),
    });
    expect(service._shouldInjectTrailingUserMessage()).toBe(false);
  });

  test("test_anthropic_invocation_params_append_trailing_user", async () => {
    // A trailing assistant message gets a user message appended, request-only.
    const service = anthropic({ model: "claude-sonnet-4-6" });
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Hold on a second." },
        { role: "assistant", content: "◐" },
      ],
    });
    const params = await service._getLlmInvocationParams(context);

    expect(params.messages.at(-1).role).toEqual("user");
    expect(params.messages.at(-1).content).toEqual([{ type: "text", text: "." }]);
    // The stored context is never mutated — the fix applies to the request only.
    expect((context.messages.at(-1) as Any).role).toEqual("assistant");
  });

  test("test_anthropic_invocation_params_untouched_when_prefill_supported", async () => {
    // Legacy prefill-supporting models keep the trailing assistant message.
    const service = anthropic({ model: "claude-haiku-4-5" });
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Hold on a second." },
        { role: "assistant", content: "◐" },
      ],
    });
    const params = await service._getLlmInvocationParams(context);

    expect(params.messages.at(-1).role).toEqual("assistant");
  });

  test("test_bedrock_gate_by_model", () => {
    // Bedrock IDs match by substring; non-Claude models never inject.
    const cases: Record<string, boolean> = {
      "us.anthropic.claude-sonnet-4-6-v1:0": true,
      "anthropic.claude-opus-4-8-v1:0": true,
      "us.anthropic.claude-haiku-4-5-v1:0": false,
      "anthropic.claude-3-7-sonnet-20250219-v1:0": false,
      "amazon.nova-pro-v1:0": false,
    };
    for (const [model, expected] of Object.entries(cases)) {
      const service = bedrock({ model });
      expect([model, service._shouldInjectTrailingUserMessage()]).toEqual([model, expected]);
    }
  });

  const google = (settings: Any): Any =>
    new GoogleLLMService({ apiKey: "test-key", settings: new GoogleLLMService.Settings(settings) });

  test("test_google_gate_by_model", () => {
    // Gemini models not known to continue a trailing model turn, including future ones, inject.
    const cases: Record<string, boolean> = {
      "gemini-3.6-flash": true,
      "gemini-3.8-flash": true,
      "gemini-3.5-flash-lite": true,
      "gemini-flash-latest": true,
      "gemini-flash-lite-latest": true,
      "gemini-4-pro": true, // hypothetical future model: must default to inject
      "gemini-2.5-flash": false,
      "gemini-2.5-flash-lite": false,
      "gemini-2.5-pro": false,
      "gemini-3-flash-preview": false,
      "gemini-3.1-pro-preview": false,
      "gemini-3.5-flash": true,
      "gemini-pro-latest": false,
    };
    for (const [model, expected] of Object.entries(cases)) {
      const service = google({ model });
      expect([model, service._shouldInjectTrailingUserMessage()]).toEqual([model, expected]);
    }
  });

  test("test_google_stream_params_append_trailing_user", async () => {
    // A trailing model turn gets a user turn appended, request-only.
    const service = google({ model: "gemini-3.6-flash" });
    // `AsyncMock()`: a client that is never called.
    service._client = {};
    const context = new LLMContext({
      messages: [
        { role: "user", content: "What's the weather?" },
        { role: "assistant", content: "Let me check on that." },
      ],
    });
    const adapter = service.getLlmAdapter();
    const params = await adapter.getLlmInvocationParams(context, {
      ensureLastMessageIsUser: service._shouldInjectTrailingUserMessage(),
    });

    expect(params.messages.at(-1).role).toEqual("user");
    expect(params.messages.at(-1).parts[0].text).toEqual(".");
    expect((context.messages.at(-1) as Any).role).toEqual("assistant");
  });
});

describe("TestContextSystemMessageDeprecation", () => {
  // Every adapter warns when the system prompt is carried in the context.

  const makeContext = () =>
    new LLMContext({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
    });

  const invoke = (adapter: Any, systemInstruction: string | null): Promise<unknown> => {
    if (adapter instanceof OpenAILLMAdapter) {
      return adapter.getLlmInvocationParams(makeContext(), {
        systemInstruction,
        convertDeveloperToUser: false,
      });
    }
    if (adapter instanceof AnthropicLLMAdapter) {
      return adapter.getLlmInvocationParams(makeContext(), {
        systemInstruction,
        enablePromptCaching: false,
      });
    }
    return adapter.getLlmInvocationParams(makeContext(), { systemInstruction });
  };

  /** `warnings.catch_warnings(record=True)`, keeping the DeprecationWarnings. */
  const catchDeprecations = async (fn: () => Promise<unknown>): Promise<string[]> =>
    withMockLogger(async (mockLogger) => {
      await fn();
      return mockLogger.deprecations;
    });

  test("test_every_adapter_warns_with_or_without_system_instruction", async () => {
    const adapters: (new () => BaseLLMAdapter<Any>)[] = [
      OpenAILLMAdapter,
      OpenAIResponsesLLMAdapter,
      AnthropicLLMAdapter,
      GeminiLLMAdapter,
      GeminiLiveLLMAdapter,
      AWSBedrockLLMAdapter,
      AWSNovaSonicLLMAdapter,
      OpenAIRealtimeLLMAdapter,
      GrokRealtimeLLMAdapter as Any,
    ];
    for (const cls of adapters) {
      for (const systemInstruction of [null, "Be concise."]) {
        // Every adapter warns from the same line, so start each one
        // from an empty record of warned sites.
        _warnedSites.clear();
        const messages = await catchDeprecations(() => invoke(new cls(), systemInstruction));
        expect([cls.name, systemInstruction, messages.length > 0]).toEqual([
          cls.name,
          systemInstruction,
          true,
        ]);
        expect(messages[0]).toContain("systemInstruction");
      }
    }
  });

  test("test_warns_once_per_adapter", async () => {
    const adapter = new OpenAILLMAdapter();
    _warnedSites.clear();
    const deprecations = await catchDeprecations(async () => {
      await invoke(adapter, null);
      await invoke(adapter, null);
    });
    expect(deprecations.length).toEqual(1);
  });

  test("test_warns_through_an_ignore_filter", async () => {
    // The warning reaches a bot whose interpreter ignores the category.
    //
    // Upstream runs a subprocess with `-W ignore::DeprecationWarning`. Python's
    // warning filters have no counterpart here: `warnDeprecated` always logs,
    // so the warning reaching the logger is what is checked.
    _warnedSites.clear();
    const ctx = new LLMContext({
      messages: [
        { role: "system", content: "Be helpful." },
        { role: "user", content: "hi" },
      ],
    });
    const deprecations = await catchDeprecations(() =>
      new OpenAILLMAdapter().getLlmInvocationParams(ctx, {
        systemInstruction: null,
        convertDeveloperToUser: false,
      }),
    );
    expect(deprecations.join("\n")).toContain("is deprecated since 1.9.0");
  });

  test("test_no_warning_without_a_context_system_message", async () => {
    const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });
    _warnedSites.clear();
    const deprecations = await catchDeprecations(() =>
      new OpenAILLMAdapter().getLlmInvocationParams(context, {
        systemInstruction: "Be concise.",
        convertDeveloperToUser: false,
      }),
    );
    expect(deprecations).toEqual([]);
  });
});

describe("TestSyncGetLLMInvocationParamsOverride", () => {
  // Deprecated upstream API: overriding getLlmInvocationParams with a sync
  // `def` (warned at class definition by `__init_subclass__`) is not ported;
  // TypeScript has no class-definition hook and the method is always async.
  test.skip("test_sync_override_warns_at_class_definition", () => {});
  // Exercises the same deprecated class-definition hook (that it stays silent).
  test.skip("test_async_override_does_not_warn", () => {});
});
