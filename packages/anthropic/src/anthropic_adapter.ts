// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/llm/services/anthropic_adapter.py

/**
 * Anthropic LLM adapter for Pipecat.
 *
 * Porting note: the adapter does not depend on the `@anthropic-ai/sdk`
 * package. The Messages API types it produces are declared structurally here,
 * and the SDK's `NOT_GIVEN` sentinel is `undefined` (how the JS SDK omits a
 * field).
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import {
  BaseLLMAdapter,
  LLMContextConversionError,
} from "@pipedog/core/adapters/llm/base_llm_adapter";
import type { FunctionSchema } from "@pipedog/core/adapters/llm/schemas/function_schema";
import type { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import {
  type LLMContext,
  type LLMContextMessage,
  LLMSpecificMessage,
  type LLMStandardMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";
import { isGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

/** An Anthropic Messages API message (`MessageParam`). */
export type MessageParam = { role: string; content: string | Dict[] } & Dict;
/** An Anthropic text content block (`TextBlockParam`). */
export type TextBlockParam = { type: "text"; text: string } & Dict;
/** An Anthropic tool definition (`ToolUnionParam`). */
export type ToolUnionParam = Dict;
/** An Anthropic ephemeral cache control marker (`CacheControlEphemeralParam`). */
export type CacheControlEphemeralParam = { type: "ephemeral"; ttl?: AnthropicCacheTTL };

/** The Anthropic SDK's "not given" value: an omitted (undefined) field. */
export type AnthropicNotGiven = undefined;
/** The Anthropic SDK's "not given" sentinel. */
export const ANTHROPIC_NOT_GIVEN: AnthropicNotGiven = undefined;

/** Lifetime of an Anthropic prompt cache entry after it was last written or read. */
export type AnthropicCacheTTL = "5m" | "1h";

/**
 * Check whether a value was explicitly provided to the Anthropic SDK.
 *
 * Asks about the SDK's sentinel, not Pipecat's — use `isGiven` from
 * `utils/types` for values that are still Pipecat's.
 *
 * Also acts as a type guard: inside a true branch, the value is narrowed to
 * exclude `AnthropicNotGiven` (e.g. `string | AnthropicNotGiven` becomes
 * `string`).
 *
 * @example
 * if (anthropicIsGiven(system)) { ... }
 *
 * @param value The value to check.
 * @returns True if `value` is anything other than the SDK's `NOT_GIVEN`.
 */
export function anthropicIsGiven<T>(value: T | AnthropicNotGiven): value is T {
  return value !== ANTHROPIC_NOT_GIVEN;
}

/** Context-based parameters for invoking Anthropic's LLM API. */
export type AnthropicLLMInvocationParams = {
  system: string | TextBlockParam[] | AnthropicNotGiven;
  messages: MessageParam[];
  tools: ToolUnionParam[];
};

/** Options for `AnthropicLLMAdapter.getLlmInvocationParams()`. */
export interface AnthropicLLMInvocationParamsOptions {
  /** Whether prompt caching should be enabled. */
  enablePromptCaching: boolean;
  /** Optional system instruction from service settings or `runInference`. */
  systemInstruction?: string | null;
  /**
   * Whether to append a minimal user message when the converted message list
   * ends with an assistant message. Required by models without
   * assistant-prefill support, which reject requests ending with an assistant
   * message.
   */
  ensureLastMessageIsUser?: boolean;
  /**
   * Lifetime of the system prompt's cache entry when prompt caching is
   * enabled. `null` uses Anthropic's default of 5 minutes.
   */
  systemPromptCacheTtl?: AnthropicCacheTTL | null;
}

/** Container for Anthropic-formatted messages converted from universal context. */
export class ConvertedMessages {
  messages: MessageParam[];
  system: string | AnthropicNotGiven;

  constructor(options: { messages: MessageParam[]; system: string | AnthropicNotGiven }) {
    this.messages = options.messages;
    this.system = options.system;
  }
}

/**
 * Adapter for converting tool schemas to Anthropic's function-calling format.
 *
 * This adapter handles the conversion of Pipecat's standard function schemas
 * to the specific format required by Anthropic's Claude models for function
 * calling.
 */
export class AnthropicLLMAdapter extends BaseLLMAdapter<AnthropicLLMInvocationParams> {
  /** Container for Anthropic-formatted messages converted from universal context. */
  static readonly ConvertedMessages = ConvertedMessages;

  /** The identifier used in LLMSpecificMessage instances for Anthropic. */
  get idForLlmSpecificMessages(): string {
    return "anthropic";
  }

  /**
   * Get Anthropic-specific LLM invocation parameters from a universal LLM
   * context.
   *
   * @param context The LLM context containing messages, tools, etc.
   * @param options See `AnthropicLLMInvocationParamsOptions`.
   * @returns Object of parameters for invoking Anthropic's LLM API.
   */
  async getLlmInvocationParams(
    context: LLMContext,
    options: AnthropicLLMInvocationParamsOptions,
  ): Promise<AnthropicLLMInvocationParams> {
    const enablePromptCaching = options.enablePromptCaching;
    const systemInstruction = options.systemInstruction ?? null;
    const ensureLastMessageIsUser = options.ensureLastMessageIsUser ?? false;
    const systemPromptCacheTtl = options.systemPromptCacheTtl ?? null;

    await this.prepareFileContent(context);
    const converted = this._fromUniversalContextMessages(this.getMessages(context), {
      systemInstruction,
    });
    if (ensureLastMessageIsUser) {
      AnthropicLLMAdapter._ensureLastMessageIsUser(converted.messages);
    }
    const system = this._resolveSystemInstruction(
      anthropicIsGiven(converted.system) ? converted.system : null,
      systemInstruction,
      { discardContextSystem: true },
    );
    let systemParam: string | TextBlockParam[] | AnthropicNotGiven = ANTHROPIC_NOT_GIVEN;
    if (system !== null) {
      systemParam = enablePromptCaching
        ? AnthropicLLMAdapter._systemWithCacheControl(system, systemPromptCacheTtl)
        : system;
    }
    return {
      system: systemParam,
      messages: enablePromptCaching
        ? this._withCacheControlMarkers(converted.messages)
        : converted.messages,
      // NOTE: LLMContext's tools are guaranteed to be a ToolsSchema (or NOT_GIVEN)
      tools: toolsOrEmpty(this.fromStandardTools(context.tools)),
    };
  }

  /**
   * Get messages from a universal LLM context in a format ready for logging
   * about Anthropic.
   *
   * Removes or truncates sensitive data like image content for safe logging.
   *
   * @param context The LLM context containing messages.
   * @returns List of messages in a format ready for logging about Anthropic.
   */
  getMessagesForLogging(context: LLMContext): Record<string, unknown>[] {
    // Get messages in Anthropic's format
    const messages = this._fromUniversalContextMessages(this.getMessages(context)).messages;

    // Sanitize messages for logging
    const messagesForLogging: Dict[] = [];
    for (const message of messages) {
      const msg: Dict = structuredClone({ ...message });
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (!isDict(item)) {
            continue;
          }
          if (item.type === "image") {
            const source = item.source;
            if (isDict(source)) {
              source.data = "...";
            }
          }
          if (item.type === "thinking" && item.signature) {
            item.signature = "...";
          }
          if (item.type === "document") {
            const source = item.source;
            if (isDict(source) && "data" in source) {
              source.data = "...";
            }
          }
        }
      }
      messagesForLogging.push(msg);
    }
    return messagesForLogging;
  }

  /** Anthropic fetches image and PDF URLs itself; other files must be inlined. */
  override supportsFileUrl(url: string, mimeType: string): boolean {
    return (
      (url.startsWith("http://") || url.startsWith("https://")) &&
      (mimeType.startsWith("image/") || mimeType === "application/pdf")
    );
  }

  protected _fromUniversalContextMessages(
    universalContextMessages: LLMContextMessage[],
    options: { systemInstruction?: string | null } = {},
  ): ConvertedMessages {
    const systemInstruction = options.systemInstruction ?? null;
    let system: string | AnthropicNotGiven = ANTHROPIC_NOT_GIVEN;

    // Extract initial system message from universal messages BEFORE conversion,
    // so the helper works with standard message format (not provider-specific).
    const remaining = [...universalContextMessages];
    if (remaining.length > 0 && !(remaining[0] instanceof LLMSpecificMessage)) {
      const extracted = this._extractInitialSystem(remaining as Dict[], { systemInstruction });
      if (extracted !== null) {
        system = extracted;
      }
    }

    // Convert remaining messages to Anthropic format, skipping messages that
    // have no Anthropic representation. A conversion failure (e.g. a
    // malformed message) is wrapped so it surfaces with its underlying cause.
    const messages: MessageParam[] = [];
    try {
      for (const m of remaining) {
        const converted = this._fromUniversalContextMessage(m);
        if (converted !== null) {
          messages.push(converted);
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      throw new LLMContextConversionError(e);
    }

    // Convert any subsequent "system"/"developer"-role messages to "user"-role
    // messages, as Anthropic doesn't support system or developer input messages.
    for (const message of messages) {
      if (message.role === "system" || message.role === "developer") {
        message.role = "user";
      }
    }

    // Merge consecutive messages with the same role.
    let i = 0;
    while (i < messages.length - 1) {
      const currentMessage = messages[i] as MessageParam;
      const nextMessage = messages[i + 1] as MessageParam;
      if (currentMessage.role === nextMessage.role) {
        // Convert content to list of dictionaries if it's a string
        if (typeof currentMessage.content === "string") {
          currentMessage.content = [{ type: "text", text: currentMessage.content }];
        }
        if (typeof nextMessage.content === "string") {
          nextMessage.content = [{ type: "text", text: nextMessage.content }];
        }
        // Concatenate the content. Content is either a string or a list; the
        // string case is handled above, so both are lists here.
        (currentMessage.content as Dict[]).push(...(nextMessage.content as Dict[]));
        // Remove the next message from the list
        messages.splice(i + 1, 1);
      } else {
        i += 1;
      }
    }

    // Avoid empty content in messages
    for (const message of messages) {
      if (typeof message.content === "string" && message.content === "") {
        message.content = "(empty)";
      } else if (Array.isArray(message.content) && message.content.length === 0) {
        message.content = [{ type: "text", text: "(empty)" }];
      }
    }

    return new ConvertedMessages({ messages, system });
  }

  /**
   * Ensure the message list does not end with an assistant message.
   *
   * Models without assistant-prefill support reject requests ending with an
   * assistant message. When the last message has `role="assistant"`, a
   * minimal user message is appended so that the API request is accepted.
   * "." represents a language-neutral no-op user turn.
   *
   * @param messages The converted message list (may be mutated in-place).
   * @returns The same list, possibly with an appended user message.
   */
  protected static _ensureLastMessageIsUser(messages: MessageParam[]): MessageParam[] {
    if (
      messages.length > 0 &&
      (messages[messages.length - 1] as MessageParam).role === "assistant"
    ) {
      messages.push({ role: "user", content: [{ type: "text", text: "." }] });
    }
    return messages;
  }

  protected _fromUniversalContextMessage(message: LLMContextMessage): MessageParam | null {
    if (message instanceof LLMSpecificMessage) {
      return this._fromAnthropicSpecificMessage(message);
    }
    return this._fromStandardMessage(message);
  }

  /**
   * Convert LLMSpecificMessage to Anthropic format.
   *
   * Anthropic-specific messages may either be special thought messages that
   * need to be handled in a special way, or messages already in Anthropic
   * format.
   *
   * @param message Anthropic-specific message.
   * @returns The message in Anthropic format, or null for a thought that
   *   can't be represented as a thinking block.
   */
  protected _fromAnthropicSpecificMessage(message: LLMSpecificMessage): MessageParam | null {
    // Handle special case of thought messages.
    // These can be converted to standalone "assistant" messages; later
    // these thinking messages will be properly merged into the assistant
    // response messages before the context is sent to Anthropic for the
    // next turn.
    const inner = message.message;
    if (isDict(inner) && inner.type === "thought") {
      // A thinking block is valid to Anthropic only with a signature: it
      // carries the encrypted reasoning the API decrypts when the block is
      // passed back, and a block without one can't be round-tripped.
      // Thought text can legitimately be empty, since models that default
      // to `display: "omitted"` return thinking blocks with no text.
      // https://platform.claude.com/docs/en/build-with-claude/thinking#controlling-thinking-display
      const signature = inner.signature;
      if (!signature) {
        return null;
      }
      return {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: inner.text || "",
            signature,
          },
        ],
      };
    }

    // Fall back to assuming that the message is already in Anthropic format
    return structuredClone(inner) as MessageParam;
  }

  /**
   * Convert standard universal context message to Anthropic format.
   *
   * Handles conversion of text content, tool calls, and tool results. Empty
   * text content is converted to "(empty)".
   *
   * @example
   * // Input standard format:
   * {
   *   role: "assistant",
   *   tool_calls: [
   *     { id: "123", function: { name: "search", arguments: '{"q": "test"}' } },
   *   ],
   * }
   * // Output Anthropic format:
   * {
   *   role: "assistant",
   *   content: [{ type: "tool_use", id: "123", name: "search", input: { q: "test" } }],
   * }
   *
   * @param message Message in standard universal context format.
   * @returns Message in Anthropic format.
   */
  protected _fromStandardMessage(message: LLMStandardMessage): MessageParam {
    // The standard (input) and Anthropic (output) message shapes differ —
    // work with the message as a plain object for the transformations below.
    const msg: Dict = structuredClone(message) as Dict;
    if (msg.role === "tool") {
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          },
        ],
      };
    }
    if (isTruthy(msg.tool_calls)) {
      const tc = msg.tool_calls as Dict[];
      const ret: { role: string; content: Dict[] } = { role: "assistant", content: [] };
      for (const toolCall of tc) {
        const fn = toolCall.function as Dict;
        const args = pyJsonLoads(fn.arguments as string);
        const newToolUse = {
          type: "tool_use",
          id: toolCall.id,
          name: fn.name,
          input: args,
        };
        ret.content.push(newToolUse);
      }
      return ret;
    }
    let content = msg.content;
    if (typeof content === "string") {
      // fix empty text
      if (content === "") {
        content = "(empty)";
      }
    } else if (Array.isArray(content)) {
      const newContent: Dict[] = [];
      for (let item of content as Dict[]) {
        // fix empty text
        if (item.type === "text" && item.text === "") {
          item.text = "(empty)";
        }
        // handle image_url -> image conversion
        if (item.type === "image_url") {
          const imageUrl = item.image_url.url as string;
          if (imageUrl.startsWith("data:")) {
            // Extract MIME type from data URL (format: "data:image/jpeg;base64,...")
            const url = imageUrl;
            const mimeType = (url.split(":")[1] as string).split(";")[0];
            item.type = "image";
            item.source = {
              type: "base64",
              media_type: mimeType,
              data: url.split(",")[1],
            };
            delete item.image_url;
          } else if (imageUrl.startsWith("http")) {
            item.type = "image";
            item.source = {
              type: "url",
              url: imageUrl,
            };
            delete item.image_url;
          } else {
            logger.warning(`Unsupported 'image_url': ${imageUrl}`);
            continue;
          }
        }
        if (item.type === "file_url") {
          const fData = item.file as Dict;
          // Throws for a URL the provider can't consume with nothing
          // resolved (wrapped as LLMContextConversionError by the caller in
          // _fromUniversalContextMessages).
          const resolved = this.inlinedFileContent(fData);
          if (resolved === null) {
            // Pass-through: supportsFileUrl admits only images and PDFs.
            item.type = (fData.mime_type as string).startsWith("image/") ? "image" : "document";
            item.source = {
              type: "url",
              url: fData.url,
            };
            delete item.file;
          } else {
            // Resolved content converts through the inline branch below.
            // Non-raw adapters always cache the data-URL form.
            item = {
              type: "file_base64",
              file: { ...fData, file_data: resolved as string },
            };
          }
        }
        if (item.type === "file_base64") {
          const fData = item.file as Dict;
          const mimeType = fData.mime_type as string;
          if (mimeType.startsWith("image/")) {
            item.type = "image";
            item.source = {
              type: "base64",
              media_type: mimeType,
              data: (fData.file_data as string).split(",")[1],
            };
            delete item.file;
          } else if (mimeType === "application/pdf") {
            item.type = "document";
            item.source = {
              type: "base64",
              media_type: mimeType,
              data: (fData.file_data as string).split(",")[1],
            };
            delete item.file;
          } else {
            // Wrapped as LLMContextConversionError by the caller in
            // _fromUniversalContextMessages.
            throw new Error(`Unsupported 'file' MIME type: ${mimeType}`);
          }
        }
        newContent.push(item);
      }
      content = newContent;
      msg.content = content;

      // In the case where there's a single image or document in the list (like
      // what would result from a UserImageRawFrame or UserFileRawFrame), ensure
      // it comes before text, as recommended by Anthropic docs
      // (https://docs.anthropic.com/en/docs/build-with-claude/vision#example-one-image)
      const mediaIndices: number[] = [];
      const textIndices: number[] = [];
      newContent.forEach((it, idx) => {
        if (it.type === "image" || it.type === "document") {
          mediaIndices.push(idx);
        }
        if (it.type === "text") {
          textIndices.push(idx);
        }
      });
      if (mediaIndices.length === 1 && textIndices.length > 0) {
        const mediaIdx = mediaIndices[0] as number;
        const firstTxtIdx = textIndices[0] as number;
        if (mediaIdx > firstTxtIdx) {
          // Move the image/document before the first text
          const [mediaItem] = newContent.splice(mediaIdx, 1);
          newContent.splice(firstTxtIdx, 0, mediaItem as Dict);
        }
      }
    }

    return msg as MessageParam;
  }

  /**
   * Add cache control markers to messages for prompt caching.
   *
   * @param messages List of messages in Anthropic format.
   * @returns List of messages with cache control markers added.
   */
  protected _withCacheControlMarkers(messages: MessageParam[]): MessageParam[] {
    const addCacheControlMarker = (message: MessageParam): void => {
      if (typeof message.content === "string") {
        message.content = [{ type: "text", text: message.content }];
      }
      // Assumptions on the next line:
      //   - content is a list (string case handled above; this codebase only
      //     ever constructs content as a string or a list)
      //   - the list is non-empty (guaranteed by the empty-content
      //     replacement in `_fromUniversalContextMessages`)
      //   - the last item is an object. The standard-message path enforces
      //     this; the LLMSpecificMessage passthrough doesn't, but in practice
      //     callers use objects.
      const content = message.content as Dict[];
      (content[content.length - 1] as Dict).cache_control = { type: "ephemeral" };
    };

    let messagesWithMarkers: MessageParam[] = messages;
    try {
      // Add cache control markers to the most recent two user messages.
      // - The marker at the most recent user message tells Anthropic to
      //   cache the prompt up to that point.
      // - The marker at the second-most-recent user message tells Anthropic
      //   to look up the cached prompt that goes up to that point (the
      //   point that *was* the last user message the previous turn).
      // If we only added the marker to the last user message, we'd only
      // ever be adding to the cache, never looking up from it.
      // Why user messages? We're assuming that we're primarily running
      // inference as soon as user turns come in. In Anthropic, turns
      // strictly alternate between user and assistant.

      messagesWithMarkers = structuredClone(messages);

      // Find the most recent two user messages
      const userMessageIndices: number[] = [];
      for (let i = messagesWithMarkers.length - 1; i >= 0; i--) {
        if ((messagesWithMarkers[i] as MessageParam).role === "user") {
          userMessageIndices.push(i);
          if (userMessageIndices.length === 2) {
            break;
          }
        }
      }

      // Add cache control markers to the identified user messages
      for (const index of userMessageIndices) {
        addCacheControlMarker(messagesWithMarkers[index] as MessageParam);
      }

      return messagesWithMarkers;
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Error adding cache control marker: ${e instanceof Error ? e.message : e}`);
      return messagesWithMarkers;
    }
  }

  /**
   * Add a cache breakpoint to the end of a system prompt.
   *
   * Anthropic accepts system prompts as either a string or a list of content
   * blocks. Converting a string to one text block lets the shared system
   * prompt be cached independently of the conversation messages.
   *
   * A TTL longer than the message breakpoints' keeps the shared prefix cached
   * across gaps between conversations. Anthropic requires longer-TTL
   * breakpoints to come before shorter ones, which the system prompt always
   * does.
   *
   * @param system The system prompt to mark for caching.
   * @param ttl Lifetime of the cache entry. `null` uses Anthropic's default.
   * @returns The system prompt as one cacheable text block.
   */
  protected static _systemWithCacheControl(
    system: string,
    ttl: AnthropicCacheTTL | null = null,
  ): TextBlockParam[] {
    const cacheControl: CacheControlEphemeralParam = { type: "ephemeral" };
    if (ttl !== null) {
      cacheControl.ttl = ttl;
    }
    return [{ type: "text", text: system, cache_control: cacheControl }];
  }

  /**
   * Convert a single function schema to Anthropic's format.
   *
   * @param fn The function schema to convert.
   * @returns Object containing the function definition in Anthropic's format.
   */
  protected static _toAnthropicFunctionFormat(fn: FunctionSchema): Dict {
    return {
      name: fn.name,
      description: fn.description,
      input_schema: {
        type: "object",
        properties: fn.properties,
        required: fn.required,
      },
    };
  }

  /**
   * Convert function schemas to Anthropic's function-calling format.
   *
   * @param toolsSchema The tools schema containing functions to convert.
   * @returns List of function definitions formatted for Anthropic's API.
   */
  toProviderToolsFormat(toolsSchema: ToolsSchema): Dict[] {
    const functionsSchema = toolsSchema.standardTools;
    return functionsSchema.map((func) => AnthropicLLMAdapter._toAnthropicFunctionFormat(func));
  }
}

function isDict(value: unknown): value is Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Python truthiness for a value read from a message (`msg.get("tool_calls")`). */
function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isDict(value)) {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

/**
 * `tools or []`: `NOT_GIVEN`, `null` and an empty list all become `[]`; any
 * other (truthy) value, including non-standard tools passed through unchanged
 * by `fromStandardTools()`, is kept as is.
 */
function toolsOrEmpty(tools: unknown): ToolUnionParam[] {
  if (!isGiven(tools) || !isTruthy(tools)) {
    return [];
  }
  return tools as ToolUnionParam[];
}
