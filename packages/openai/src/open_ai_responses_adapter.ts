// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/llm/services/open_ai_responses_adapter.py

/**
 * OpenAI Responses API adapter for Pipecat.
 *
 * Porting note: like `open_ai_adapter.ts` in core, this module does not
 * depend on the `openai` SDK. The Responses API types are declared
 * structurally, and the SDK's `NOT_GIVEN` sentinel is `undefined`.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import {
  BaseLLMAdapter,
  LLMContextConversionError,
} from "@pipedog/core/adapters/llm/base_llm_adapter";
import { AdapterType, type ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import {
  type OpenAINotGiven,
  openaiFromLlmContextTools,
} from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import {
  type LLMContext,
  type LLMContextMessage,
  LLMSpecificMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";

type Dict = Record<string, any>;

/** A Responses API input item (`ResponseInputItemParam`). */
export type ResponseInputItemParam = Dict;
/** A Responses API tool (`ToolParam`). */
export type ToolParam = Dict;
/** A Responses API function tool (`FunctionToolParam`). */
export interface FunctionToolParam {
  type: "function";
  name: string;
  parameters: Dict | null;
  strict: boolean | null;
  description?: string | null;
}

/** Context-based parameters for invoking OpenAI Responses API. */
export interface OpenAIResponsesLLMInvocationParams {
  // `input` and `tools` are always populated by `getLlmInvocationParams`;
  // `instructions` is only set when a system instruction is present.
  input: ResponseInputItemParam[];
  tools: ToolParam[] | OpenAINotGiven;
  instructions?: string;
}

/** Options for `OpenAIResponsesLLMAdapter.getLlmInvocationParams`. */
export interface OpenAIResponsesLLMInvocationParamsOptions {
  /** Optional system instruction from service settings. */
  systemInstruction?: string | null;
}

/**
 * OpenAI Responses API adapter for Pipecat.
 *
 * Handles:
 *
 * - Converting LLMContext messages to Responses API input items
 * - Converting Pipecat's standardized tools schema to Responses API function tool format
 * - Extracting and sanitizing messages from the LLM context for logging
 */
export class OpenAIResponsesLLMAdapter extends BaseLLMAdapter<OpenAIResponsesLLMInvocationParams> {
  /** The identifier used in LLMSpecificMessage instances. */
  get idForLlmSpecificMessages(): string {
    return "openai_responses";
  }

  /**
   * Get Responses API invocation parameters from a universal LLM context.
   *
   * @param context The LLM context containing messages, tools, etc.
   * @param options.systemInstruction Optional system instruction from service settings.
   * @returns Dictionary of parameters for the Responses API.
   */
  async getLlmInvocationParams(
    context: LLMContext,
    options: OpenAIResponsesLLMInvocationParamsOptions = {},
  ): Promise<OpenAIResponsesLLMInvocationParams> {
    const systemInstruction = options.systemInstruction ?? null;
    await this.prepareFileContent(context);
    const messages = this.getMessages(context);

    if (messages.length > 0) {
      const firstMsg =
        messages[0] instanceof LLMSpecificMessage ? null : (messages[0] as Dict | undefined);
      if (firstMsg && firstMsg.role === "system") {
        this._warnContextSystemMessage();
        // Check for conflict: systemInstruction + initial system message.
        // `content` is `string | Iterable<...>`; we only forward it for
        // warning purposes. Coerce non-strings to null.
        const firstContent = firstMsg.content ?? "";
        if (systemInstruction) {
          this._resolveSystemInstruction(
            typeof firstContent === "string" ? firstContent : null,
            systemInstruction,
            { discardContextSystem: false },
          );
        }
      }
    }

    const inputItems = this._convertMessagesToInput(messages);

    const params: OpenAIResponsesLLMInvocationParams = {
      input: inputItems,
      // NOTE: LLMContext's tools are guaranteed to be a ToolsSchema (or NOT_GIVEN)
      tools: openaiFromLlmContextTools(this.fromStandardTools(context.tools) as ToolParam[] | null),
    };

    if (systemInstruction) {
      // Compatibility: The Responses API requires at least one input
      // message when instructions are provided. Contexts that worked with
      // OpenAILLMService (systemInstruction + empty messages) need the
      // instructions converted to an initial developer message.
      //
      // NOTE: The service layer (OpenAIResponsesLLMService) internally
      // manages `previous_response_id` for incremental context delivery
      // over WebSocket. This runs post-adapter — the adapter always
      // produces the full input list and the service determines what
      // subset to send. This empty-input fallback is therefore only
      // relevant for one-shot or initial calls.
      //
      // If we added support for user-provided explicit
      // `previous_response_id` and/or `conversation_id` (overriding
      // internal management), we'd need to revisit this logic, as it'd
      // be legit to provide instructions without input items. Note that
      // over HTTP, `previous_response_id` requires `store=True` (30-day
      // OpenAI-side storage), which is why the HTTP variant doesn't use
      // it. The WebSocket variant avoids this via a connection-local
      // in-memory cache — see the class docstrings in llm.ts.
      if (inputItems.length === 0) {
        params.input = [{ role: "developer", content: systemInstruction }];
      } else {
        params.instructions = systemInstruction;
      }
    }

    return params;
  }

  /**
   * Convert function schemas to Responses API function tool format.
   *
   * @param toolsSchema The Pipecat tools schema to convert.
   * @returns List of Responses API function tool definitions.
   */
  toProviderToolsFormat(toolsSchema: ToolsSchema): ToolParam[] {
    const functionsSchema = toolsSchema.standardTools;
    const result: ToolParam[] = [];
    for (const func of functionsSchema) {
      const d = func.toDefaultDict() as Dict;
      const tool: FunctionToolParam = {
        type: "function",
        name: d.name,
        parameters: pyGet(d, "parameters", {}),
        strict: d.strict ?? null,
      };
      if ("description" in d) {
        tool.description = d.description;
      }
      result.push(tool);
    }
    let customOpenaiTools: ToolParam[] = [];
    if (toolsSchema.customTools) {
      customOpenaiTools = toolsSchema.customTools[AdapterType.OPENAI] ?? [];
    }
    return [...result, ...customOpenaiTools];
  }

  /**
   * Get messages from context in a format ready for logging.
   *
   * Binary data (images, audio) is replaced with short placeholders, and
   * reasoning messages' encrypted payloads are elided.
   *
   * @param context The LLM context containing messages.
   * @returns List of messages in a format ready for logging.
   */
  getMessagesForLogging(context: LLMContext): Record<string, unknown>[] {
    // Sanitize messages for logging
    const messagesForLogging: Dict[] = [];
    for (const message of this.getMessages(context, { truncateLargeValues: true })) {
      if (message instanceof LLMSpecificMessage) {
        // Responses-specific messages are reasoning items (see
        // _BaseOpenAIResponsesLLMService._appendReasoningMessage).
        // Elide the encrypted payload, which is opaque noise in logs.
        const msg = structuredClone(message.message) as Dict;
        if (isDict(msg) && msg.encrypted_content) {
          msg.encrypted_content = "...";
        }
        messagesForLogging.push(msg);
      } else {
        messagesForLogging.push(message as Dict);
      }
    }
    return messagesForLogging;
  }

  /**
   * Convert LLMContext messages to Responses API input items.
   *
   * @param messages Messages from the LLMContext.
   * @returns List of Responses API input items.
   */
  protected _convertMessagesToInput(messages: LLMContextMessage[]): ResponseInputItemParam[] {
    const result: ResponseInputItemParam[] = [];

    for (const message of messages) {
      if (message instanceof LLMSpecificMessage) {
        result.push(this._fromSpecificMessage(message));
        continue;
      }

      const role = message.role;

      if (role === "system" || role === "developer") {
        let content = pyGet(message, "content", "");
        if (Array.isArray(content)) {
          content = this._convertMultimodalContent(content);
        }
        result.push({ role: "developer", content });
      } else if (role === "user") {
        let content = pyGet(message, "content", "");
        if (Array.isArray(content)) {
          content = this._convertMultimodalContent(content);
        }
        result.push({ role: "user", content });
      } else if (role === "assistant") {
        const toolCalls = message.tool_calls as Dict[] | undefined;
        if (toolCalls && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            const func = pyGet(tc, "function", {}) as Dict;
            result.push({
              type: "function_call",
              call_id: pyGet(tc, "id", ""),
              name: pyGet(func, "name", ""),
              arguments: pyGet(func, "arguments", ""),
            });
          }
        } else {
          let content = pyGet(message, "content", "");
          if (Array.isArray(content)) {
            content = this._convertMultimodalContent(content);
          }
          result.push({ role: "assistant", content });
        }
      } else if (role === "tool") {
        let content = pyGet(message, "content", "");
        if (typeof content !== "string") {
          // DIVERGENCE: upstream uses Python's `str(content)` (a Python repr
          // for lists/dicts); we write JSON for objects instead.
          content =
            content === null
              ? "None"
              : typeof content === "boolean"
                ? content
                  ? "True"
                  : "False"
                : typeof content === "object"
                  ? pyJsonDumps(content)
                  : String(content);
        }
        result.push({
          type: "function_call_output",
          call_id: pyGet(message, "tool_call_id", ""),
          output: content,
        });
      }
    }

    return result;
  }

  /**
   * Convert an OpenAI-Responses-specific message to an input item.
   *
   * Reasoning messages — persisted so the model's prior reasoning round-trips
   * on later turns — become Responses `reasoning` input items. Anything
   * else is assumed to already be in Responses input shape.
   *
   * @param message The LLM-specific message from the context.
   * @returns A Responses API input item.
   */
  protected _fromSpecificMessage(message: LLMSpecificMessage): ResponseInputItemParam {
    const payload = message.message;
    if (isDict(payload) && payload.type === "reasoning") {
      const item: Dict = {
        type: "reasoning",
        id: payload.id ?? null,
        summary: pyGet(payload, "summary", []),
      };
      const encrypted = payload.encrypted_content;
      if (encrypted) {
        item.encrypted_content = encrypted;
      }
      return item;
    }
    return payload as ResponseInputItemParam;
  }

  /** The Responses API fetches image and file URLs itself. */
  override supportsFileUrl(url: string, _mimeType: string): boolean {
    return url.startsWith("http://") || url.startsWith("https://");
  }

  /**
   * Convert multimodal content parts to Responses API format.
   *
   * @param content List of content parts from the LLMContext message.
   * @returns List of content parts in Responses API format.
   */
  protected _convertMultimodalContent(content: Dict[]): Dict[] {
    const result: Dict[] = [];
    for (const part of content) {
      const partType = part.type;
      if (partType === "text") {
        result.push({ type: "input_text", text: pyGet(part, "text", "") });
      } else if (partType === "image_url") {
        const imageUrlObj = pyGet(part, "image_url", {}) as Dict;
        result.push({
          type: "input_image",
          image_url: pyGet(imageUrlObj, "url", ""),
          detail: pyGet(imageUrlObj, "detail", "auto"),
        });
      } else if (partType === "file_base64") {
        const fData = part.file as Dict;
        if ((fData.mime_type as string).startsWith("image/")) {
          result.push({
            type: "input_image",
            image_url: fData.file_data,
          });
        } else {
          result.push({
            type: "input_file",
            filename: fData.filename,
            file_data: fData.file_data,
          });
        }
      } else if (partType === "file_url") {
        const fData = part.file as Dict;
        // inlinedFileContent throws a plain Error so adapters with a
        // message-level wrapper don't double-wrap; this adapter has no such
        // wrapper, so wrap here.
        let resolved: Uint8Array | string | null;
        try {
          resolved = this.inlinedFileContent(fData);
        } catch (e) {
          rethrowIfCancelled(e);
          throw new LLMContextConversionError(e);
        }
        if (resolved === null) {
          if ((fData.mime_type as string).startsWith("image/")) {
            result.push({
              type: "input_image",
              image_url: fData.url,
            });
          } else {
            result.push({
              type: "input_file",
              file_url: fData.url,
            });
          }
        } else {
          // Non-raw adapters always cache the data-URL form.
          const dataUrl = resolved as string;
          if ((fData.mime_type as string).startsWith("image/")) {
            result.push({
              type: "input_image",
              image_url: dataUrl,
            });
          } else {
            result.push({
              type: "input_file",
              filename: pyGet(fData, "filename", ""),
              file_data: dataUrl,
            });
          }
        }
      } else {
        // Pass through other types as-is. Note: "input_audio" is not
        // yet supported by the Responses API (coming soon per OpenAI
        // docs) but the LLMContext format already matches the expected
        // shape, so it should work once support is enabled.
        result.push(part);
      }
    }
    return result;
  }
}

/**
 * Python's `dict.get(key, default)`: the default only replaces a missing key
 * (`undefined`); an explicit `null` (None) is kept.
 */
function pyGet(d: Dict, key: string, dflt: unknown): any {
  const v = d[key];
  return v === undefined ? dflt : v;
}

function isDict(value: unknown): value is Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
