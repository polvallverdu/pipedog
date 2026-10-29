// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * LLM adapter for the Vercel AI SDK.
 *
 * Converts a universal `LLMContext` (OpenAI-shaped messages and a `ToolsSchema`)
 * into what the AI SDK's `streamText()` / `generateText()` take: `instructions`,
 * `ModelMessage[]`, a `ToolSet` and a tool choice. The AI SDK then converts
 * those to the provider's own format, so this one adapter serves every
 * provider.
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
import {
  type AssistantContent,
  type FilePart,
  type ImagePart,
  jsonSchema,
  type ModelMessage,
  type TextPart,
  type ToolCallPart,
  type ToolChoice,
  type ToolSet,
  type UserContent,
} from "ai";

type Dict = Record<string, any>;

/** Provider-specific options of a message part (the AI SDK's `ProviderOptions`). */
export type ProviderOptions = NonNullable<TextPart["providerOptions"]>;

/** The identifier of AI SDK messages and thoughts in an `LLMContext`. */
export const AI_SDK_LLM_ID = "ai-sdk";

/** Context-based parameters for `streamText()` / `generateText()`. */
export type AISDKLLMInvocationParams = {
  /** The system instruction, or undefined for none. */
  instructions: string | undefined;
  /** The conversation, in the AI SDK's format. */
  messages: ModelMessage[];
  /** The tools, without `execute` functions, or undefined for none. */
  tools: ToolSet | undefined;
  /** The tool choice, or undefined for the model's default. */
  toolChoice: ToolChoice<ToolSet> | undefined;
};

/** Options for `AISDKLLMAdapter.getLlmInvocationParams()`. */
export interface AISDKLLMInvocationParamsOptions {
  /** System instruction from service settings or `runInference`. */
  systemInstruction?: string | null;
}

/**
 * Provider metadata the service saw on a piece of model output, kept in the
 * context so it can be sent back with that output on later turns (the AI SDK
 * convention: an output part's `providerMetadata` becomes the input part's
 * `providerOptions`). Gemini's thought signatures travel this way.
 */
export interface AISDKProviderMetadataMessage {
  type: "provider_metadata";
  providerMetadata: ProviderOptions;
  /** Which output the metadata belongs to: a tool call (by ID) or the response text. */
  bookmark: { tool_call_id?: string; text?: string };
}

/**
 * Adapter from the universal LLM context to the Vercel AI SDK.
 *
 * Handles:
 *
 * - System instruction: an initial `"system"` context message is extracted
 *   (the service's `systemInstruction` wins over it); later `"system"` and
 *   `"developer"` messages become `"user"` messages.
 * - User content: text, images (`image_url`), files (`file_url`,
 *   `file_base64`) and audio (`input_audio`).
 * - Assistant tool calls and tool results, with the tool name looked up from
 *   the call (the universal format's tool messages don't carry it).
 * - `LLMSpecificMessage`s for `"ai-sdk"`: thoughts (reasoning parts),
 *   provider metadata bookmarks, and raw `ModelMessage`s, passed through.
 * - Tools: each `FunctionSchema` becomes an AI SDK tool with a JSON schema and
 *   no `execute`, so the model's calls come back to pipedog, which runs them.
 */
export class AISDKLLMAdapter extends BaseLLMAdapter<AISDKLLMInvocationParams> {
  /** The identifier used in LLMSpecificMessage instances for the AI SDK. */
  get idForLlmSpecificMessages(): string {
    return AI_SDK_LLM_ID;
  }

  /**
   * Get AI SDK call parameters from a universal LLM context.
   *
   * @param context The LLM context containing messages, tools, etc.
   * @param options.systemInstruction System instruction from the service.
   * @returns `instructions`, `messages`, `tools` and `toolChoice`.
   */
  async getLlmInvocationParams(
    context: LLMContext,
    options: AISDKLLMInvocationParamsOptions = {},
  ): Promise<AISDKLLMInvocationParams> {
    const systemInstruction = options.systemInstruction ?? null;
    await this.prepareFileContent(context);
    const { messages, system } = this._fromUniversalContextMessages(this.getMessages(context), {
      systemInstruction,
    });
    const instructions = this._resolveSystemInstruction(system, systemInstruction, {
      discardContextSystem: true,
    });
    const tools = this.fromStandardTools(context.tools);
    return {
      instructions: instructions ?? undefined,
      messages,
      // A ToolsSchema converts to `[toolSet]`; a list of AI SDK tool sets set
      // directly on the context passes through.
      tools: Array.isArray(tools) ? toolSetFromList(tools) : undefined,
      toolChoice: AISDKLLMAdapter._toolChoice(context.toolChoice),
    };
  }

  /**
   * Get messages from a universal LLM context in a format ready for logging.
   *
   * File and image data are replaced by `"..."`.
   *
   * @param context The LLM context containing messages.
   * @returns The messages in AI SDK format, with binary data elided.
   */
  getMessagesForLogging(context: LLMContext): Record<string, unknown>[] {
    let messages: ModelMessage[];
    try {
      messages = this._fromUniversalContextMessages(this.getMessages(context)).messages;
    } catch (e) {
      rethrowIfCancelled(e);
      return [];
    }
    return messages.map((message) => {
      if (!Array.isArray(message.content)) {
        return { ...message } as Record<string, unknown>;
      }
      const content = (message.content as Dict[]).map((part) => {
        if (part.type === "image") return { ...part, image: "..." };
        if (part.type === "file") return { ...part, data: "..." };
        return part;
      });
      return { ...message, content } as Record<string, unknown>;
    });
  }

  /**
   * Convert function schemas to an AI SDK `ToolSet`.
   *
   * The tools have no `execute`, so the AI SDK returns the model's tool calls
   * instead of running them.
   *
   * @param toolsSchema The tools schema containing functions to convert.
   * @returns A one-element list holding the `ToolSet` (the base class's
   *   contract is a list; `getLlmInvocationParams()` unwraps it).
   */
  toProviderToolsFormat(toolsSchema: ToolsSchema): unknown[] {
    const tools: ToolSet = {};
    for (const fn of toolsSchema.standardTools) {
      tools[fn.name] = AISDKLLMAdapter._toAISDKTool(fn);
    }
    return Object.keys(tools).length > 0 ? [tools] : [];
  }

  /** Convert one function schema to an AI SDK tool. */
  protected static _toAISDKTool(fn: FunctionSchema): ToolSet[string] {
    return {
      description: fn.description,
      inputSchema: jsonSchema({
        type: "object",
        properties: fn.properties,
        required: fn.required,
      } as Parameters<typeof jsonSchema>[0]),
    };
  }

  /** Convert an OpenAI-style `tool_choice` to the AI SDK's. */
  protected static _toolChoice(toolChoice: unknown): ToolChoice<ToolSet> | undefined {
    if (!isGiven(toolChoice) || toolChoice === null || toolChoice === undefined) {
      return undefined;
    }
    if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
      return toolChoice;
    }
    if (typeof toolChoice === "object") {
      const choice = toolChoice as Dict;
      const name = choice.function?.name ?? choice.toolName ?? choice.name;
      if (typeof name === "string") {
        return { type: "tool", toolName: name };
      }
    }
    logger.warning(`Unsupported tool_choice for the AI SDK: ${JSON.stringify(toolChoice)}`);
    return undefined;
  }

  /**
   * Convert universal context messages to AI SDK messages.
   *
   * @returns The messages and the initial system message's content, if any.
   */
  protected _fromUniversalContextMessages(
    universalContextMessages: LLMContextMessage[],
    options: { systemInstruction?: string | null } = {},
  ): { messages: ModelMessage[]; system: string | null } {
    const remaining = [...universalContextMessages];
    let system: string | null = null;
    if (remaining.length > 0 && !(remaining[0] instanceof LLMSpecificMessage)) {
      system = this._extractInitialSystem(remaining as Dict[], {
        systemInstruction: options.systemInstruction ?? null,
      });
    }

    const messages: ModelMessage[] = [];
    const bookmarks: AISDKProviderMetadataMessage[] = [];
    const toolNames = new Map<string, string>();
    try {
      for (const message of remaining) {
        if (message instanceof LLMSpecificMessage) {
          const inner = message.message as Dict | null;
          if (isDict(inner) && inner.type === "provider_metadata") {
            bookmarks.push(inner as AISDKProviderMetadataMessage);
            continue;
          }
          if (isDict(inner) && inner.type === "thought") {
            const thought = AISDKLLMAdapter._fromThought(inner);
            if (thought !== null) messages.push(thought);
            continue;
          }
          // Otherwise the message is already an AI SDK ModelMessage.
          const raw = structuredClone(inner) as ModelMessage;
          collectToolNames(raw, toolNames);
          messages.push(raw);
          continue;
        }
        const converted = this._fromStandardMessage(message, toolNames);
        if (converted !== null) messages.push(converted);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      throw new LLMContextConversionError(e);
    }

    const merged = mergeConsecutive(messages);
    applyProviderMetadata(bookmarks, merged);
    return { messages: merged, system };
  }

  /** Convert a thought (`{type: "thought", text, signature}`) to a reasoning part. */
  protected static _fromThought(thought: Dict): ModelMessage | null {
    const text = typeof thought.text === "string" ? thought.text : "";
    const providerOptions = isDict(thought.signature)
      ? (thought.signature as ProviderOptions)
      : undefined;
    if (!text && !providerOptions) return null;
    return {
      role: "assistant",
      content: [{ type: "reasoning", text, ...(providerOptions ? { providerOptions } : {}) }],
    };
  }

  /**
   * Convert a standard (OpenAI-shaped) context message to an AI SDK message.
   *
   * @param message The message to convert.
   * @param toolNames Tool call ID to tool name, filled from assistant tool
   *   calls and read for tool results.
   * @returns The message, or null when it carries nothing to send.
   */
  protected _fromStandardMessage(
    message: LLMStandardMessage,
    toolNames: Map<string, string>,
  ): ModelMessage | null {
    const role = message.role;
    if (role === "tool") {
      const toolCallId = String(message.tool_call_id ?? "");
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: toolNames.get(toolCallId) ?? "unknown",
            output: { type: "text", value: textOf(message.content) },
          },
        ],
      };
    }

    if (role === "assistant") {
      const content: Exclude<AssistantContent, string> = [];
      const text = textOf(message.content);
      if (text) content.push({ type: "text", text });
      const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Dict[]) : [];
      for (const toolCall of toolCalls) {
        const fn = (toolCall.function ?? {}) as Dict;
        const args = fn.arguments;
        const input =
          typeof args === "string" ? (args.trim() ? pyJsonLoads(args) : {}) : (args ?? {});
        const part: ToolCallPart = {
          type: "tool-call",
          toolCallId: String(toolCall.id),
          toolName: String(fn.name),
          input,
        };
        toolNames.set(part.toolCallId, part.toolName);
        content.push(part);
      }
      if (content.length === 0) return null;
      return { role: "assistant", content };
    }

    // "user", and "system" / "developer" past the first message: the AI SDK
    // only takes system instructions up front, so these become user messages.
    if (role !== "user" && role !== "system" && role !== "developer") {
      logger.warning(`Unsupported message role for the AI SDK: ${role}`);
      return null;
    }
    const content = message.content;
    if (typeof content === "string") {
      return { role: "user", content };
    }
    if (!Array.isArray(content)) {
      return null;
    }
    const parts: Exclude<UserContent, string> = [];
    for (const item of content as Dict[]) {
      const part = this._fromUserContentItem(item);
      if (part !== null) parts.push(part);
    }
    if (parts.length === 0) return null;
    return { role: "user", content: parts };
  }

  /** Convert one item of a user message's content list. */
  protected _fromUserContentItem(item: Dict): TextPart | ImagePart | FilePart | null {
    switch (item.type) {
      case "text":
        return { type: "text", text: String(item.text ?? "") };
      case "image_url": {
        const url = String(item.image_url?.url ?? "");
        if (url.startsWith("data:")) {
          const { mediaType, data } = parseDataUrl(url);
          return { type: "image", image: data, mediaType };
        }
        if (url.startsWith("http://") || url.startsWith("https://")) {
          return { type: "image", image: new URL(url) };
        }
        logger.warning(`Unsupported 'image_url': ${url}`);
        return null;
      }
      case "file_url": {
        const file = item.file as Dict;
        // Throws when the URL wasn't resolved (wrapped by the caller).
        const resolved = this.inlinedFileContent(file);
        const dataUrl = typeof resolved === "string" ? resolved : null;
        return filePart(file, dataUrl ?? String(file.url));
      }
      case "file_base64": {
        const file = item.file as Dict;
        return filePart(file, String(file.file_data));
      }
      case "input_audio": {
        const audio = item.input_audio as Dict;
        const format = String(audio.format ?? "wav");
        return { type: "file", data: String(audio.data), mediaType: `audio/${format}` };
      }
      default:
        logger.warning(`Unsupported content type for the AI SDK: ${item.type}`);
        return null;
    }
  }
}

function isDict(value: unknown): value is Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The text of a message's content: a string, or its text parts joined. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => isDict(part) && part.type === "text")
      .map((part) => String((part as Dict).text ?? ""))
      .join(" ");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

/** Split a `data:` URL into its media type and base64 payload. */
function parseDataUrl(url: string): { mediaType: string; data: string } {
  const comma = url.indexOf(",");
  if (comma < 0) throw new Error("Invalid data URL: missing ','");
  const header = url.slice(5, comma);
  const mediaType = header.split(";")[0] || "application/octet-stream";
  return { mediaType, data: url.slice(comma + 1) };
}

/** A file part from a context `file` object and its data (a data URL or a URL). */
function filePart(file: Dict, source: string): FilePart {
  const mediaType = String(file.mime_type ?? "application/octet-stream");
  const filename = typeof file.filename === "string" ? file.filename : undefined;
  const data = source.startsWith("data:") ? parseDataUrl(source).data : new URL(source);
  return { type: "file", data, mediaType, ...(filename ? { filename } : {}) };
}

/** A `ToolSet` from a provider-format tool list (one or more `ToolSet`s). */
function toolSetFromList(tools: unknown[]): ToolSet | undefined {
  const merged: ToolSet = {};
  for (const tool of tools) {
    if (isDict(tool)) Object.assign(merged, tool);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Record the tool names of a raw message's tool calls. */
function collectToolNames(message: ModelMessage, toolNames: Map<string, string>): void {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
  for (const part of message.content) {
    if (part.type === "tool-call") toolNames.set(part.toolCallId, part.toolName);
  }
}

/**
 * Merge consecutive assistant messages, and consecutive tool messages.
 *
 * Thoughts are added to the context as their own messages ahead of the
 * response they belong to; providers that check reasoning (Anthropic's
 * thinking blocks, Gemini's thought signatures) need them in the same
 * assistant message as the text and tool calls that follow.
 */
function mergeConsecutive(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      last.role === message.role &&
      (message.role === "assistant" || message.role === "tool")
    ) {
      const lastContent = asParts(last.content);
      const content = asParts(message.content);
      (last as Dict).content = [...lastContent, ...content];
      continue;
    }
    out.push(
      message.role === "assistant" || message.role === "tool"
        ? ({ ...message, content: asParts(message.content) } as ModelMessage)
        : message,
    );
  }
  return out;
}

function asParts(content: unknown): Dict[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return Array.isArray(content) ? [...(content as Dict[])] : [];
}

/** Collapse runs of whitespace, for comparing response text. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Attach saved provider metadata to the output it came with, as that part's
 * `providerOptions`. Tool-call bookmarks match by tool call ID; text
 * bookmarks match an assistant message's text, in order.
 */
function applyProviderMetadata(
  bookmarks: AISDKProviderMetadataMessage[],
  messages: ModelMessage[],
): void {
  if (bookmarks.length === 0) return;
  const assistants = messages.filter((m) => m.role === "assistant");
  let textSearchStart = 0;
  for (const { bookmark, providerMetadata } of bookmarks) {
    if (!bookmark || !isDict(providerMetadata)) continue;
    if (bookmark.tool_call_id) {
      for (const message of assistants) {
        const part = (message.content as Dict[]).find(
          (p) => p.type === "tool-call" && p.toolCallId === bookmark.tool_call_id,
        );
        if (part) {
          part.providerOptions = { ...(part.providerOptions ?? {}), ...providerMetadata };
          break;
        }
      }
    } else if (bookmark.text) {
      const wanted = normalizeWhitespace(bookmark.text);
      for (let i = textSearchStart; i < assistants.length; i++) {
        const parts = (assistants[i] as ModelMessage).content as Dict[];
        const textParts = parts.filter((p) => p.type === "text");
        const text = normalizeWhitespace(textParts.map((p) => p.text).join(" "));
        const last = textParts[textParts.length - 1];
        if (last && text === wanted) {
          last.providerOptions = { ...(last.providerOptions ?? {}), ...providerMetadata };
          textSearchStart = i + 1;
          break;
        }
      }
    }
  }
}
