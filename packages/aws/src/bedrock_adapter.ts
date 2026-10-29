// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/llm/services/bedrock_adapter.py

/**
 * AWS Bedrock LLM adapter for Pipecat.
 *
 * Porting note: inline content (`image`, `document`, `video`) carries raw
 * bytes as a `Uint8Array` in `source.bytes`, as upstream (boto3) does. The
 * service base64-encodes them when it writes the request JSON, which is what
 * boto3 does on the wire.
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
  type LLMContextToolChoice,
  LLMSpecificMessage,
  type LLMStandardMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";
import { isGiven, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

const _MIME_TO_BEDROCK_FORMAT: Record<string, string> = {
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/html": "html",
  "text/plain": "txt",
  "text/markdown": "md",
};

const _MIME_TO_BEDROCK_IMAGE_FORMAT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const _MIME_TO_BEDROCK_VIDEO_FORMAT: Record<string, string> = {
  "video/x-flv": "flv",
  "video/x-matroska": "mkv",
  "video/quicktime": "mov",
  "video/mpeg": "mpeg",
  "video/mp4": "mp4",
  "video/3gpp": "three_gp",
  "video/webm": "webm",
  "video/x-ms-wmv": "wmv",
};

/**
 * Map a video MIME type to Bedrock's video format.
 *
 * `video/mpeg` covers both the `mpeg` and `mpg` Bedrock formats, which aren't
 * distinguishable by MIME type alone, so fall back to the filename extension
 * to disambiguate.
 */
function _bedrockVideoFormat(mimeType: string, filename: string | null | undefined): string | null {
  if (mimeType === "video/mpeg" && filename && filename.toLowerCase().endsWith(".mpg")) {
    return "mpg";
  }
  return Object.hasOwn(_MIME_TO_BEDROCK_VIDEO_FORMAT, mimeType)
    ? (_MIME_TO_BEDROCK_VIDEO_FORMAT[mimeType] as string)
    : null;
}

function lookup(table: Record<string, string>, key: string): string | null {
  return Object.hasOwn(table, key) ? (table[key] as string) : null;
}

// Bedrock's API reference documents an AudioBlock content type
// (https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_AudioBlock.html),
// but in practice ConverseStream rejects it outright ("ContentBlock object
// ... must set one of the following keys: text, image, toolUse, toolResult,
// document, video, cachePoint, searchResult") regardless of model, unlike
// unsupported image/video/document blocks, which are rejected per-model with
// a specific "this model doesn't support the X content block" error. So
// audio files aren't handled as a distinct content block below; treat this
// as unsupported until the live API actually accepts it.

// Bedrock's document name only allows alphanumerics, whitespace, hyphens,
// parentheses, and square brackets, with no consecutive whitespace — notably
// no ".", so an ordinary filename like "notes.pdf" is rejected as-is.
const _BEDROCK_DOCUMENT_NAME_DISALLOWED = /[^A-Za-z0-9\s\-()[\]]/g;
const _BEDROCK_DOCUMENT_NAME_WHITESPACE = /\s+/g;

/** Rewrite `name` to satisfy Bedrock's document name restrictions. */
export function _sanitizeBedrockDocumentName(name: string): string {
  let sanitized = name.replace(_BEDROCK_DOCUMENT_NAME_DISALLOWED, " ");
  sanitized = sanitized.replace(_BEDROCK_DOCUMENT_NAME_WHITESPACE, " ").trim();
  return sanitized || "document";
}

/** Context-based parameters for invoking AWS Bedrock's LLM API. */
export type AWSBedrockLLMInvocationParams = {
  /** `[{ text: "system message" }]` or null. */
  system: Dict[] | null;
  messages: Dict[];
  tools: Dict[];
  tool_choice: LLMContextToolChoice | NotGiven;
};

/** Options for `AWSBedrockLLMAdapter.getLlmInvocationParams()`. */
export interface AWSBedrockLLMInvocationParamsOptions {
  /** Optional system instruction from service settings or `runInference`. */
  systemInstruction?: string | null;
  /**
   * Whether to append a minimal user message when the converted message list
   * ends with an assistant message. Required by models without
   * assistant-prefill support, which reject requests ending with an assistant
   * message.
   */
  ensureLastMessageIsUser?: boolean;
}

/** Container for Bedrock-formatted messages converted from universal context. */
export class ConvertedMessages {
  messages: Dict[];
  system: string | null;

  constructor(options: { messages: Dict[]; system: string | null }) {
    this.messages = options.messages;
    this.system = options.system;
  }
}

/**
 * Adapter for AWS Bedrock LLM integration with Pipecat.
 *
 * Provides conversion utilities for transforming Pipecat function schemas
 * into AWS Bedrock's expected tool format for function calling capabilities.
 */
export class AWSBedrockLLMAdapter extends BaseLLMAdapter<AWSBedrockLLMInvocationParams> {
  /** Container for Bedrock-formatted messages converted from universal context. */
  static readonly ConvertedMessages = ConvertedMessages;

  // Bedrock's Converse API takes raw bytes for inline content.
  override prefersRawFileBytes = true;

  /** The identifier used in LLMSpecificMessage instances for AWS Bedrock. */
  get idForLlmSpecificMessages(): string {
    return "aws";
  }

  /**
   * Get AWS Bedrock-specific LLM invocation parameters from a universal LLM context.
   *
   * @param context The LLM context containing messages, tools, etc.
   * @param options See `AWSBedrockLLMInvocationParamsOptions`.
   * @returns Parameters for invoking AWS Bedrock's LLM API.
   */
  async getLlmInvocationParams(
    context: LLMContext,
    options: AWSBedrockLLMInvocationParamsOptions = {},
  ): Promise<AWSBedrockLLMInvocationParams> {
    const systemInstruction = options.systemInstruction ?? null;
    await this.prepareFileContent(context);
    const converted = this._fromUniversalContextMessages(this.getMessages(context), {
      systemInstruction,
    });
    if (options.ensureLastMessageIsUser) {
      AWSBedrockLLMAdapter._ensureLastMessageIsUser(converted.messages);
    }
    const effectiveSystem = this._resolveSystemInstruction(converted.system, systemInstruction, {
      discardContextSystem: true,
    });
    const tools = this.fromStandardTools(context.tools);
    return {
      system: effectiveSystem ? [{ text: effectiveSystem }] : null,
      messages: converted.messages,
      // NOTE: LLMContext's tools are guaranteed to be a ToolsSchema (or NOT_GIVEN)
      tools: isGiven(tools) && Array.isArray(tools) && tools.length > 0 ? (tools as Dict[]) : [],
      // To avoid refactoring in AWSBedrockLLMService, we just pass through tool_choice.
      // Eventually (when we don't have to maintain the non-LLMContext code path) we should do
      // the conversion to Bedrock's expected format here rather than in AWSBedrockLLMService.
      tool_choice: context.toolChoice,
    };
  }

  /**
   * Get messages from a universal LLM context in a format ready for logging about AWS Bedrock.
   *
   * Removes or truncates sensitive data like image content for safe logging.
   *
   * @param context The LLM context containing messages.
   * @returns List of messages in a format ready for logging about AWS Bedrock.
   */
  getMessagesForLogging(context: LLMContext): Record<string, unknown>[] {
    const messages = this._fromUniversalContextMessages(this.getMessages(context)).messages;

    // Sanitize messages for logging
    const messagesForLogging: Dict[] = [];
    for (const message of messages) {
      const msg: Dict = structuredClone(message);
      if ("content" in msg && Array.isArray(msg.content)) {
        for (const item of msg.content as Dict[]) {
          if (item.image) item.image.source.bytes = "...";
          if (item.document) item.document.source.bytes = "...";
          if (item.video) item.video.source.bytes = "...";
        }
      }
      messagesForLogging.push(msg);
    }
    return messagesForLogging;
  }

  /** Bedrock resolves `s3://` URIs through AWS IAM; other URLs must be inlined. */
  override supportsFileUrl(url: string, _mimeType: string): boolean {
    return url.startsWith("s3://");
  }

  protected _fromUniversalContextMessages(
    universalContextMessages: LLMContextMessage[],
    options: { systemInstruction?: string | null } = {},
  ): ConvertedMessages {
    let system: string | null = null;

    // Extract initial system message from universal messages BEFORE conversion,
    // so the helper works with standard message format (not provider-specific).
    const remaining = [...universalContextMessages];
    if (remaining.length > 0 && !(remaining[0] instanceof LLMSpecificMessage)) {
      system = this._extractInitialSystem(remaining as Dict[], {
        systemInstruction: options.systemInstruction ?? null,
      });
    }

    // Convert remaining messages to Bedrock format. A conversion failure
    // (e.g. a malformed message) is wrapped so it surfaces with its
    // underlying cause.
    let messages: Dict[];
    try {
      messages = remaining.map((m) => this._fromUniversalContextMessage(m));
    } catch (e) {
      rethrowIfCancelled(e);
      throw new LLMContextConversionError(e);
    }

    // Convert any subsequent "system"/"developer"-role messages to "user"-role
    // messages, as AWS Bedrock doesn't support system or developer input messages.
    for (const message of messages) {
      if (message.role === "system" || message.role === "developer") {
        message.role = "user";
      }
    }

    // Merge consecutive messages with the same role.
    let i = 0;
    while (i < messages.length - 1) {
      const currentMessage = messages[i] as Dict;
      const nextMessage = messages[i + 1] as Dict;
      if (currentMessage.role === nextMessage.role) {
        // Convert content to list of dictionaries if it's a string
        if (typeof currentMessage.content === "string") {
          currentMessage.content = [{ type: "text", text: currentMessage.content }];
        }
        if (typeof nextMessage.content === "string") {
          nextMessage.content = [{ type: "text", text: nextMessage.content }];
        }
        // Concatenate the content
        currentMessage.content.push(...nextMessage.content);
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
   * minimal user message is appended so that the Converse API request is
   * accepted. "." represents a language-neutral no-op user turn.
   *
   * @param messages The converted message list (may be mutated in-place).
   * @returns The same list, possibly with an appended user message.
   */
  protected static _ensureLastMessageIsUser(messages: Dict[]): Dict[] {
    if (messages.length > 0 && (messages[messages.length - 1] as Dict).role === "assistant") {
      messages.push({ role: "user", content: [{ text: "." }] });
    }
    return messages;
  }

  /** Build the Converse content block for an inline file's bytes. */
  protected _inlineFileItem(
    rawBytes: Uint8Array,
    filename: string | null | undefined,
    mimeType: string,
  ): Dict {
    const imageFormat = lookup(_MIME_TO_BEDROCK_IMAGE_FORMAT, mimeType);
    if (imageFormat !== null) {
      return { image: { format: imageFormat, source: { bytes: rawBytes } } };
    }
    const videoFormat = _bedrockVideoFormat(mimeType, filename);
    if (videoFormat !== null) {
      return { video: { format: videoFormat, source: { bytes: rawBytes } } };
    }
    const bedrockFormat = lookup(_MIME_TO_BEDROCK_FORMAT, mimeType);
    if (bedrockFormat === null) {
      // Wrapped as LLMContextConversionError by the caller in
      // _fromUniversalContextMessages.
      throw new Error(`Unsupported 'file' MIME type for Bedrock: ${mimeType}`);
    }
    return {
      document: {
        name: _sanitizeBedrockDocumentName(filename || "document"),
        format: bedrockFormat,
        source: { bytes: rawBytes },
      },
    };
  }

  /** Build the Converse content block for a file Bedrock reads from S3 itself. */
  protected _s3FileItem(url: string, filename: string | null | undefined, mimeType: string): Dict {
    const imageFormat = lookup(_MIME_TO_BEDROCK_IMAGE_FORMAT, mimeType);
    if (imageFormat !== null) {
      return { image: { format: imageFormat, source: { s3Location: { uri: url } } } };
    }
    const videoFormat = _bedrockVideoFormat(mimeType, filename);
    if (videoFormat !== null) {
      return { video: { format: videoFormat, source: { s3Location: { uri: url } } } };
    }
    const bedrockFormat = lookup(_MIME_TO_BEDROCK_FORMAT, mimeType);
    if (bedrockFormat === null) {
      // Wrapped as LLMContextConversionError by the caller in
      // _fromUniversalContextMessages.
      throw new Error(`Unsupported MIME type for Bedrock S3 URI: ${mimeType}`);
    }
    return {
      document: {
        name: _sanitizeBedrockDocumentName(filename || "document"),
        format: bedrockFormat,
        source: { s3Location: { uri: url } },
      },
    };
  }

  protected _fromUniversalContextMessage(message: LLMContextMessage): Dict {
    if (message instanceof LLMSpecificMessage) {
      return structuredClone(message.message) as Dict;
    }
    return this._fromStandardMessage(message);
  }

  /**
   * Convert standard format message to AWS Bedrock format.
   *
   * Handles conversion of text content, tool calls, and tool results.
   * Empty text content is converted to "(empty)".
   *
   * @example
   * // Standard format input:
   * { role: "assistant", tool_calls: [{ id: "123", function: { name: "search", arguments: '{"q": "test"}' } }] }
   * // AWS Bedrock format output:
   * { role: "assistant", content: [{ toolUse: { toolUseId: "123", name: "search", input: { q: "test" } } }] }
   *
   * @param message Message in standard format.
   * @returns Message in AWS Bedrock format.
   */
  protected _fromStandardMessage(message: LLMStandardMessage): Dict {
    // The standard (input) and Bedrock (output) message shapes differ — work
    // with the copied message as a plain object for the transformations below.
    const msg: Dict = structuredClone(message) as Dict;
    if (msg.role === "tool") {
      // Try to parse the content as JSON if it looks like JSON
      let toolResultContent: Dict[];
      try {
        const trimmed = (msg.content as string).trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          const contentJson = pyJsonLoads(msg.content as string);
          toolResultContent = [{ json: contentJson }];
        } else {
          toolResultContent = [{ text: msg.content }];
        }
      } catch (e) {
        rethrowIfCancelled(e);
        toolResultContent = [{ text: msg.content }];
      }

      return {
        role: "user",
        content: [
          {
            toolResult: {
              toolUseId: msg.tool_call_id,
              content: toolResultContent,
            },
          },
        ],
      };
    }

    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const ret: { role: string; content: Dict[] } = { role: "assistant", content: [] };
      for (const toolCall of msg.tool_calls as Dict[]) {
        const fn = toolCall.function as Dict;
        const args = pyJsonLoads(fn.arguments as string);
        ret.content.push({
          toolUse: {
            toolUseId: toolCall.id,
            name: fn.name,
            input: args,
          },
        });
      }
      return ret;
    }

    // Handle text content
    const content = msg.content;
    if (typeof content === "string") {
      if (content === "") {
        return { role: msg.role, content: [{ text: "(empty)" }] };
      }
      return { role: msg.role, content: [{ text: content }] };
    }
    if (Array.isArray(content)) {
      const newContent: Dict[] = [];
      for (const item of content as Dict[]) {
        // fix empty text
        if ((item.type ?? "") === "text") {
          const textContent = item.text !== "" ? item.text : "(empty)";
          newContent.push({ text: textContent });
        }
        // handle image_url -> image conversion
        if (item.type === "image_url") {
          const url = item.image_url.url as string;
          if (url.startsWith("data:")) {
            // Extract format from data URL (format: "data:image/jpeg;base64,...")
            const mimeType = (url.split(":")[1] as string).split(";")[0] as string;
            // Bedrock expects format like "jpeg", "png" etc., not "image/jpeg"
            const imageFormat = mimeType.split("/")[1];
            newContent.push({
              image: {
                format: imageFormat,
                source: { bytes: base64ToBytes(url.split(",")[1] as string) },
              },
            });
          } else {
            logger.warning(`Unsupported 'image_url': ${url}`);
          }
        } else if (item.type === "file_base64") {
          const fData = item.file as Dict;
          newContent.push(
            this._inlineFileItem(
              this.decodedFileBytes(fData),
              fData.filename as string | null,
              fData.mime_type as string,
            ),
          );
        } else if (item.type === "file_url") {
          const fData = item.file as Dict;
          // Throws for a URL the provider can't consume with nothing
          // resolved (wrapped as LLMContextConversionError by the caller in
          // _fromUniversalContextMessages).
          const resolved = this.inlinedFileContent(fData);
          if (resolved === null) {
            // Pass-through: supportsFileUrl admits only s3:// URIs.
            newContent.push(
              this._s3FileItem(
                fData.url as string,
                fData.filename as string | undefined,
                fData.mime_type as string,
              ),
            );
          } else {
            // Raw-bytes adapters always cache the decoded form.
            newContent.push(
              this._inlineFileItem(
                resolved as Uint8Array,
                fData.filename as string | undefined,
                fData.mime_type as string,
              ),
            );
          }
        }
      }
      // In the case where there's a single image, document, or video in
      // the list (like what would result from a UserImageRawFrame),
      // ensure it comes before text
      for (const key of ["image", "document", "video"]) {
        const mediaIndices: number[] = [];
        const textIndices: number[] = [];
        newContent.forEach((it, idx) => {
          if (key in it) mediaIndices.push(idx);
          if ("text" in it) textIndices.push(idx);
        });
        if (mediaIndices.length === 1 && textIndices.length > 0) {
          const mediaIdx = mediaIndices[0] as number;
          const firstTxtIdx = textIndices[0] as number;
          if (mediaIdx > firstTxtIdx) {
            // Move the media item before the first text
            const [mediaItem] = newContent.splice(mediaIdx, 1);
            newContent.splice(firstTxtIdx, 0, mediaItem as Dict);
          }
        }
      }
      return { role: msg.role, content: newContent };
    }

    return msg;
  }

  /**
   * Convert a function schema to Bedrock's tool format.
   *
   * @param fn The function schema to convert.
   * @returns Object formatted for Bedrock's tool specification.
   */
  protected static _toBedrockFunctionFormat(fn: FunctionSchema): Dict {
    return {
      toolSpec: {
        name: fn.name,
        description: fn.description,
        inputSchema: {
          json: {
            type: "object",
            properties: fn.properties,
            required: fn.required,
          },
        },
      },
    };
  }

  /**
   * Convert function schemas to Bedrock's function-calling format.
   *
   * @param toolsSchema The tools schema containing functions to convert.
   * @returns List of Bedrock formatted function call definitions.
   */
  toProviderToolsFormat(toolsSchema: ToolsSchema): Dict[] {
    const functionsSchema = toolsSchema.standardTools;
    return functionsSchema.map((func) => AWSBedrockLLMAdapter._toBedrockFunctionFormat(func));
  }
}
