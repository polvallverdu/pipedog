// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/services/open_ai_adapter.py

/**
 * OpenAI LLM adapter for Pipecat.
 *
 * Porting note: core does not depend on the `openai` SDK. The Chat
 * Completions types are declared structurally here, and the SDK's
 * `NOT_GIVEN` sentinel is `undefined` (how the JS SDK omits a field).
 */

import { rethrowIfCancelled } from "@pipecat-ts/asyncio";
import type {
  LLMContext,
  LLMContextMessage,
  LLMContextToolChoice,
  LLMStandardMessage,
  NotGiven,
} from "../../processors/aggregators/llm_context.ts";
import { LLMSpecificMessage } from "../../processors/aggregators/llm_context.ts";
import { isGiven } from "../../utils/types.ts";
import { BaseLLMAdapter, LLMContextConversionError } from "../base_llm_adapter.ts";
import { AdapterType, type ToolsSchema } from "../schemas/tools_schema.ts";

type Dict = Record<string, any>;

/** An OpenAI Chat Completions message (`ChatCompletionMessageParam`). */
export type ChatCompletionMessageParam = Dict;
/** An OpenAI Chat Completions tool (`ChatCompletionToolParam`). */
export type ChatCompletionToolParam = { type: "function"; function: Dict } | Dict;
/** An OpenAI Chat Completions tool choice (`ChatCompletionToolChoiceOptionParam`). */
export type ChatCompletionToolChoiceOptionParam =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } }
  | Dict;
/** The OpenAI SDK's "not given" value: an omitted (undefined) field. */
export type OpenAINotGiven = undefined;
/** The OpenAI SDK's "not given" sentinel. */
export const OPENAI_NOT_GIVEN: OpenAINotGiven = undefined;

/**
 * Reinterpret an LLMContext `toolChoice` as OpenAI's type.
 *
 * The value types are aliased — `LLMContextToolChoice` is
 * `ChatCompletionToolChoiceOptionParam` — so only the "not provided" sentinel
 * needs translating: LLMContext has its own, and the SDK recognizes only its
 * own.
 *
 * @param toolChoice A context's tool choice, or its "not provided" sentinel.
 * @returns The tool choice unchanged, with LLMContext's sentinel replaced by
 *   the SDK's.
 */
export function openaiFromLlmContextToolChoice(
  toolChoice: LLMContextToolChoice | NotGiven,
): ChatCompletionToolChoiceOptionParam | OpenAINotGiven {
  if (!isGiven(toolChoice)) {
    return OPENAI_NOT_GIVEN;
  }
  return toolChoice as ChatCompletionToolChoiceOptionParam;
}

/**
 * Reinterpret converted LLMContext tools as OpenAI's type.
 *
 * Same boundary as `openaiFromLlmContextToolChoice()`: the tool entries are
 * already in OpenAI's format by this point, so only the absence of tools has
 * to be respelled. The SDK's sentinel is the one that omits `tools` from the
 * request body, so both of the ways absence arrives here — LLMContext's
 * sentinel and `null` — map onto it.
 *
 * Generic over the tool entry type so that every OpenAI surface can share one
 * translation: the Chat Completions and Responses APIs each have their own.
 *
 * @param tools Converted tools, or a value meaning no tools were provided.
 * @returns The tools unchanged, or the SDK's sentinel if there are none.
 */
export function openaiFromLlmContextTools<T>(
  tools: T[] | NotGiven | null | undefined,
): T[] | OpenAINotGiven {
  if (tools == null || !isGiven(tools)) {
    return OPENAI_NOT_GIVEN;
  }
  return tools as T[];
}

/**
 * Reinterpret an LLMContext standard message as OpenAI's type.
 *
 * Same rationale as `openaiFromLlmContextToolChoice()`: the aliased types
 * make this a no-op today, but the boundary is preserved for future
 * divergence.
 *
 * @param message A context's standard message.
 * @returns The message unchanged, typed as OpenAI's.
 */
export function openaiFromLlmStandardMessage(
  message: LLMStandardMessage,
): ChatCompletionMessageParam {
  return message as ChatCompletionMessageParam;
}

/**
 * Check whether a value was explicitly provided to the OpenAI SDK.
 *
 * Asks about the SDK's sentinel, not Pipecat's — use `isGiven` from
 * `utils/types` for values that are still Pipecat's.
 *
 * Also acts as a type guard: inside a true branch, the value is narrowed to
 * exclude `OpenAINotGiven`.
 *
 * @example
 * if (openaiIsGiven(toolChoice)) { ... }
 *
 * @param value The value to check.
 * @returns True if `value` is anything other than the SDK's `NOT_GIVEN`.
 */
export function openaiIsGiven<T>(value: T | OpenAINotGiven): value is T {
  return value !== OPENAI_NOT_GIVEN;
}

/** Context-based parameters for invoking OpenAI ChatCompletion API. */
export interface OpenAILLMInvocationParams {
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionToolParam[] | OpenAINotGiven;
  tool_choice: ChatCompletionToolChoiceOptionParam | OpenAINotGiven;
}

export interface OpenAILLMInvocationParamsOptions {
  /**
   * Optional system instruction from service settings or `runInference`. If
   * provided, prepended as a system message.
   */
  systemInstruction?: string | null;
  /**
   * If true, convert "developer"-role messages to "user"-role messages. Used
   * by OpenAI-compatible services that don't support the "developer" role.
   */
  convertDeveloperToUser: boolean;
}

/**
 * OpenAI-specific adapter for Pipecat.
 *
 * Handles:
 *
 * - Extracting parameters for OpenAI's ChatCompletion API from a universal
 *   LLM context
 * - Converting Pipecat's standardized tools schema to OpenAI's
 *   function-calling format.
 * - Extracting and sanitizing messages from the LLM context for logging
 *   about OpenAI.
 */
export class OpenAILLMAdapter extends BaseLLMAdapter<OpenAILLMInvocationParams> {
  /** The identifier used in LLMSpecificMessage instances for OpenAI. */
  get idForLlmSpecificMessages(): string {
    return "openai";
  }

  /**
   * Get OpenAI-specific LLM invocation parameters from a universal LLM context.
   *
   * @param context The LLM context containing messages, tools, etc.
   * @returns Object of parameters for OpenAI's ChatCompletion API.
   */
  async getLlmInvocationParams(
    context: LLMContext,
    options: OpenAILLMInvocationParamsOptions,
  ): Promise<OpenAILLMInvocationParams> {
    const systemInstruction = options.systemInstruction ?? null;
    await this.prepareFileContent(context);
    let messages = this._fromUniversalContextMessages(this.getMessages(context), {
      convertDeveloperToUser: options.convertDeveloperToUser,
    });

    // Detect initial system message for warning purposes (don't extract).
    // The content is `string | parts[]`; we only forward it for warning
    // purposes, so coerce non-strings to null — the resolver handles null.
    let initialContent: string | null = null;
    if (messages.length > 0 && (messages[0] as Dict).role === "system") {
      this._warnContextSystemMessage();
      const rawContent = (messages[0] as Dict).content ?? "";
      if (typeof rawContent === "string") {
        initialContent = rawContent;
      }
    }

    if (systemInstruction) {
      this._resolveSystemInstruction(initialContent, systemInstruction, {
        discardContextSystem: false,
      });
      messages = [{ role: "system", content: systemInstruction }, ...messages];
    }

    return {
      messages,
      // NOTE: LLMContext's tools are guaranteed to be a ToolsSchema (or NOT_GIVEN)
      tools: openaiFromLlmContextTools(
        this.fromStandardTools(context.tools) as ChatCompletionToolParam[] | NotGiven | null,
      ),
      tool_choice: openaiFromLlmContextToolChoice(context.toolChoice),
    };
  }

  /**
   * Convert function schemas to OpenAI's function-calling format.
   *
   * @param toolsSchema The Pipecat tools schema to convert.
   * @returns List of OpenAI formatted function call definitions ready for use
   *   with ChatCompletion API.
   */
  toProviderToolsFormat(toolsSchema: ToolsSchema): ChatCompletionToolParam[] {
    const functionsSchema = toolsSchema.standardTools;
    const formattedStandardTools: ChatCompletionToolParam[] = functionsSchema.map((func) => ({
      type: "function",
      function: func.toDefaultDict(),
    }));
    let customOpenaiTools: ChatCompletionToolParam[] = [];
    if (toolsSchema.customTools) {
      customOpenaiTools = (toolsSchema.customTools[AdapterType.OPENAI] ??
        []) as ChatCompletionToolParam[];
    }
    return [...formattedStandardTools, ...customOpenaiTools];
  }

  /**
   * Get messages from a universal LLM context in a format ready for logging
   * about OpenAI.
   *
   * Binary data (images, audio) is replaced with short placeholders.
   *
   * @param context The LLM context containing messages.
   * @returns List of messages in a format ready for logging about OpenAI.
   */
  getMessagesForLogging(context: LLMContext): Record<string, unknown>[] {
    return this.getMessages(context, { truncateLargeValues: true }) as Record<string, unknown>[];
  }

  /** OpenAI Chat Completions fetches image URLs itself; other files must be inlined. */
  override supportsFileUrl(url: string, mimeType: string): boolean {
    return (
      mimeType.startsWith("image/") && (url.startsWith("http://") || url.startsWith("https://"))
    );
  }

  protected _fromUniversalContextMessages(
    messages: LLMContextMessage[],
    options: { convertDeveloperToUser: boolean },
  ): ChatCompletionMessageParam[] {
    let result: ChatCompletionMessageParam[] = [];
    for (const message of messages) {
      if (message instanceof LLMSpecificMessage) {
        result.push(message.message as ChatCompletionMessageParam);
      } else {
        const msg: Dict = { ...openaiFromLlmStandardMessage(message) };
        const content = msg.content;
        if (Array.isArray(content)) {
          const newContent: Dict[] = [];
          for (let item of content as Dict[]) {
            if (item.type === "file_base64") {
              const fData = item.file as Dict;
              item = this._inlineFileItem(fData.file_data, fData.filename, fData.mime_type);
            } else if (item.type === "file_url") {
              const fData = item.file as Dict;
              // inlinedFileContent throws a plain Error so adapters with a
              // message-level wrapper don't double-wrap; this adapter has no
              // such wrapper, so wrap here.
              let resolved: Uint8Array | string | null;
              try {
                resolved = this.inlinedFileContent(fData);
              } catch (e) {
                rethrowIfCancelled(e);
                if (e instanceof LLMContextConversionError || !(e instanceof Error)) throw e;
                throw new LLMContextConversionError(e);
              }
              if (resolved === null) {
                // Pass-through: only image URLs, per supportsFileUrl.
                item = {
                  type: "image_url",
                  image_url: { url: fData.url },
                };
              } else {
                // Non-raw adapters always cache the data-URL form.
                item = this._inlineFileItem(
                  resolved as string,
                  fData.filename ?? "",
                  fData.mime_type,
                );
              }
            }
            newContent.push(item);
          }
          msg.content = newContent;
        }
        result.push(msg);
      }
    }

    if (options.convertDeveloperToUser) {
      // Copy rather than mutate: the message objects are shared with the
      // source LLMContext.
      result = result.map((msg) => (msg.role === "developer" ? { ...msg, role: "user" } : msg));
    }

    return result;
  }

  /** Build the ChatCompletion content item for an inline (base64) file. */
  protected _inlineFileItem(fileDataUrl: string, filename: string, mimeType: string): Dict {
    if (mimeType.startsWith("image/")) {
      return { type: "image_url", image_url: { url: fileDataUrl } };
    }
    if (mimeType === "application/pdf") {
      return { type: "file", file: { filename, file_data: fileDataUrl } };
    }
    throw new LLMContextConversionError(
      new Error(`Unsupported 'file' MIME type for OpenAI: ${mimeType}`),
    );
  }

  protected _fromStandardToolChoice(
    toolChoice: LLMContextToolChoice | NotGiven,
  ): ChatCompletionToolChoiceOptionParam | OpenAINotGiven {
    return openaiFromLlmContextToolChoice(toolChoice);
  }
}
