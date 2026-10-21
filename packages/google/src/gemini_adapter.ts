// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/services/gemini_adapter.py

/**
 * Gemini LLM adapter for Pipecat.
 *
 * Porting notes:
 * - Messages are `@google/genai` `Content` / `Part` plain objects, so their
 *   fields are the JS SDK's camelCase (`inlineData`, `functionCall`,
 *   `thoughtSignature`, ...) rather than the Python SDK's snake_case. The
 *   logging copy (`getMessagesForLogging`) therefore has camelCase keys too.
 * - The JS SDK carries bytes as base64 strings (`Blob.data`,
 *   `Part.thoughtSignature`), where the Python SDK takes `bytes`. Raw bytes
 *   (`prefersRawFileBytes`) are still what the file resolver caches; they
 *   are base64-encoded when placed in a part.
 * - `Part.from_uri(file_uri=url)` without a MIME type guesses it from the
 *   URL's extension, like Python's `mimetypes.guess_type`, and throws when it
 *   can't.
 * - The nested dataclasses (`GeminiLLMAdapter.ConvertedMessages`, ...) are
 *   module-level classes, also reachable as static members of the adapter.
 */

import type { Content, Blob as GenAIBlob, Part } from "@google/genai";
import { rethrowIfCancelled } from "@pipedog/asyncio";
import { BaseLLMAdapter, LLMContextConversionError } from "@pipedog/core/adapters/base_llm_adapter";
import { AdapterType, type ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import {
  type LLMContext,
  type LLMContextMessage,
  LLMSpecificMessage,
  type LLMStandardMessage,
  type NotGiven,
} from "@pipedog/core/processors/aggregators/llm_context";
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";

type Dict = Record<string, any>;

/** Context-based parameters for invoking Gemini LLM. */
export interface GeminiLLMInvocationParams {
  system_instruction: string | null;
  messages: Content[];
  tools: unknown[] | NotGiven;
}

/** Options for `GeminiLLMAdapter.getLlmInvocationParams()`. */
export interface GeminiLLMInvocationParamsOptions {
  /** Optional system instruction from service settings or `runInference`. */
  systemInstruction?: string | null;
  /**
   * Whether to append a minimal user message when the converted message list
   * ends with a model message. The Gemini API rejects a generate request that
   * ends with a model turn.
   */
  ensureLastMessageIsUser?: boolean;
}

/** Container for Google-formatted messages converted from universal context. */
export class ConvertedMessages {
  messages: Content[];
  systemInstruction: string | null;

  constructor(options: { messages: Content[]; systemInstruction?: string | null }) {
    this.messages = options.messages;
    this.systemInstruction = options.systemInstruction ?? null;
  }
}

/**
 * Result of converting a single universal context message to Google format.
 *
 * Contains a Google Content object and a tool call ID to name mapping for any
 * tool calls discovered in the message.
 */
export class MessageConversionResult {
  content: Content | null;
  toolCallIdToNameMapping: Record<string, string>;

  constructor(
    options: { content?: Content | null; toolCallIdToNameMapping?: Record<string, string> } = {},
  ) {
    this.content = options.content ?? null;
    this.toolCallIdToNameMapping = options.toolCallIdToNameMapping ?? {};
  }
}

/** Parameters for converting a single universal context message to Google format. */
export class MessageConversionParams {
  toolCallIdToNameMapping: Record<string, string>;

  constructor(options: { toolCallIdToNameMapping: Record<string, string> }) {
    this.toolCallIdToNameMapping = options.toolCallIdToNameMapping;
  }
}

// The MIME types Python's `mimetypes.guess_type` knows for the extensions a
// file URI handed to Gemini plausibly carries.
const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  ".aac": "audio/aac",
  ".aif": "audio/x-aiff",
  ".aifc": "audio/x-aiff",
  ".aiff": "audio/x-aiff",
  ".avi": "video/x-msvideo",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".css": "text/css",
  ".csv": "text/csv",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpe": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".py": "text/x-python",
  ".rtf": "application/rtf",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".txt": "text/plain",
  ".wav": "audio/x-wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xml": "text/xml",
};

/** Python's `mimetypes.guess_type(url)[0]`, for common extensions. */
function guessMimeType(uri: string): string | null {
  let path = uri;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]+):/.exec(uri);
  if (scheme) {
    // Like `urlparse(url).path`: drop the scheme, authority, query and fragment.
    path = uri.slice((scheme[0] as string).length);
    if (path.startsWith("//")) {
      const slash = path.indexOf("/", 2);
      path = slash < 0 ? "" : path.slice(slash);
    }
    path = path.split(/[?#]/, 1)[0] as string;
  }
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const ext = base.slice(dot);
  return MIME_TYPES_BY_EXTENSION[ext] ?? MIME_TYPES_BY_EXTENSION[ext.toLowerCase()] ?? null;
}

/** `Part.from_uri(file_uri=..., mime_type=...)`. */
function partFromUri(fileUri: string, mimeType: string | null = null): Part {
  const resolved = mimeType ?? guessMimeType(fileUri);
  if (!resolved) {
    throw new Error(`Failed to determine mime type for file: ${fileUri}`);
  }
  return { fileData: { fileUri, mimeType: resolved } };
}

/** The byte length of Blob data, whether base64 text (JS SDK) or raw bytes. */
function blobDataLength(data: unknown): number | null {
  if (data == null) {
    return null;
  }
  if (data instanceof Uint8Array) {
    return data.length;
  }
  if (typeof data === "string") {
    const stripped = data.replace(/=+$/, "");
    return Math.floor((stripped.length * 3) / 4);
  }
  return null;
}

/** Python `" ".join(s.split())`. */
function normalizeWhitespace(s: string): string {
  return s
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .join(" ");
}

/** Python's `len(s) > 50` / `s[:50]` on code points. */
function logDisplayText(text: string): string {
  const chars = Array.from(text);
  return chars.length > 50 ? `${chars.slice(0, 50).join("")}...` : text;
}

/**
 * Gemini-specific adapter for Pipecat.
 *
 * Handles:
 * - Extracting parameters for Gemini's API from a universal LLM context
 * - Converting Pipecat's standardized tools schema to Gemini's function-calling format.
 * - Extracting and sanitizing messages from the LLM context for logging with Gemini.
 */
export class GeminiLLMAdapter extends BaseLLMAdapter<GeminiLLMInvocationParams> {
  static ConvertedMessages = ConvertedMessages;
  static MessageConversionResult = MessageConversionResult;
  static MessageConversionParams = MessageConversionParams;

  // (adaptation, tool name) pairs already reported, so a tool set needing
  // them warns once rather than on every inference.
  protected _warnedSchemaAdaptations = new Set<string>();

  // Gemini's inline_data parts take raw bytes.
  override prefersRawFileBytes = true;

  // Gemini 3 rejects a model turn whose function calls carry no thought
  // signature, which is what a call from another provider (an LLM switched
  // mid-conversation) or one injected by the application looks like. Google
  // documents this placeholder to skip that check; both the Gemini API and
  // Vertex AI accept it, and the SDK encodes it on the wire as it would a
  // real signature.
  protected static _PLACEHOLDER_THOUGHT_SIGNATURE: string = bytesToBase64(
    new TextEncoder().encode("skip_thought_signature_validator"),
  );

  /** The identifier used in LLMSpecificMessage instances for Google. */
  get idForLlmSpecificMessages(): string {
    return "google";
  }

  /**
   * Get Gemini-specific LLM invocation parameters from a universal LLM context.
   *
   * @param context The LLM context containing messages, tools, etc.
   * @param options.systemInstruction Optional system instruction from service
   *   settings or `runInference`.
   * @param options.ensureLastMessageIsUser Whether to append a minimal user
   *   message when the converted message list ends with a model message. The
   *   Gemini API rejects a generate request that ends with a model turn.
   * @returns Dictionary of parameters for Gemini's API.
   */
  async getLlmInvocationParams(
    context: LLMContext,
    options: GeminiLLMInvocationParamsOptions = {},
  ): Promise<GeminiLLMInvocationParams> {
    const systemInstruction = options.systemInstruction ?? null;
    await this.prepareFileContent(context);
    const converted = this._fromUniversalContextMessages(this.getMessages(context), {
      systemInstruction,
    });
    if (options.ensureLastMessageIsUser ?? false) {
      GeminiLLMAdapter._ensureLastMessageIsUser(converted.messages);
    }
    const effectiveSystem = this._resolveSystemInstruction(
      converted.systemInstruction,
      systemInstruction,
      { discardContextSystem: true },
    );
    return {
      system_instruction: effectiveSystem,
      messages: converted.messages,
      // NOTE: LLMContext's tools are guaranteed to be a ToolsSchema (or NOT_GIVEN)
      tools: this.fromStandardTools(context.tools) as unknown[] | NotGiven,
    };
  }

  /**
   * Convert tool schemas to Gemini's function-calling format.
   *
   * @param toolsSchema The tools schema containing standard and custom tool definitions.
   * @returns List of tool definitions formatted for Gemini's function-calling API.
   *   Includes both converted standard tools and any custom Gemini-specific tools.
   */
  toProviderToolsFormat(toolsSchema: ToolsSchema): Record<string, unknown>[] {
    /**
     * Recursively adapt a JSON schema to the subset Gemini accepts.
     *
     * Tool schemas are JSON Schema, but Gemini takes only a limited subset of
     * it — its schema object follows OpenAPI 3.0's, which predates JSON Schema
     * alignment — and it rejects anything outside that subset. Three
     * constructs need adapting:
     *
     * - Keys it has no field for, namely `additionalProperties` and vendor
     *   extensions (`x-` prefixed, such as the `x-mcp-header` GitHub's MCP
     *   server attaches to its tool properties), are dropped.
     * - A union `type` (a list of types) becomes the equivalent `anyOf`.
     * - `enum` members must be strings, so an `enum` holding other values is
     *   dropped and its constraint lost.
     *
     * @param schema The JSON schema to process.
     * @param notes Collects one description per kind of adaptation applied.
     * @returns The schema, in the form Gemini accepts.
     */
    const adaptSchema = (schema: unknown, notes: Set<string>): unknown => {
      if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
        return schema;
      }

      const result: Dict = {};

      for (const [key, value] of Object.entries(schema as Dict)) {
        if (key === "additionalProperties" || key.startsWith("x-")) {
          notes.add(`dropped unsupported key '${key}'`);
        } else if (
          key === "properties" &&
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value)
        ) {
          // Keys here name the tool's parameters rather than schema
          // keywords, so adapt the values but keep every key.
          const props: Dict = {};
          for (const [name, prop] of Object.entries(value as Dict)) {
            props[name] = adaptSchema(prop, notes);
          }
          result[key] = props;
        } else if (key === "type" && Array.isArray(value)) {
          notes.add("converted a union 'type' to 'anyOf'");
          result.anyOf = value.map((member) => ({ type: member }));
        } else if (
          key === "enum" &&
          Array.isArray(value) &&
          !value.every((member) => typeof member === "string")
        ) {
          notes.add("dropped a non-string 'enum', losing its constraint");
        } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          result[key] = adaptSchema(value, notes);
        } else if (Array.isArray(value)) {
          result[key] = value.map((item) => adaptSchema(item, notes));
        } else {
          result[key] = value;
        }
      }

      return result;
    };

    const functionsSchema = toolsSchema.standardTools;
    let formattedStandardTools: Record<string, unknown>[];
    if (functionsSchema.length > 0) {
      const formattedFunctions: Dict[] = [];
      const adapted = new Map<string, string[]>();
      for (const func of functionsSchema) {
        const funcDict: Dict = func.toDefaultDict();
        const notes = new Set<string>();
        funcDict.parameters = adaptSchema(funcDict.parameters, notes);
        for (const note of notes) {
          let tools = adapted.get(note);
          if (tools === undefined) {
            tools = [];
            adapted.set(note, tools);
          }
          tools.push(funcDict.name as string);
        }
        formattedFunctions.push(funcDict);
      }
      this._warnSchemaAdaptations(adapted);
      formattedStandardTools = [{ function_declarations: formattedFunctions }];
    } else {
      formattedStandardTools = [];
    }
    let customGeminiTools: Record<string, unknown>[] = [];
    if (toolsSchema.customTools) {
      customGeminiTools = toolsSchema.customTools[AdapterType.GEMINI] ?? [];
    }

    return [...formattedStandardTools, ...customGeminiTools];
  }

  /**
   * Report tool schemas that had to be adapted before Gemini would accept them.
   *
   * Each (adaptation, tool) pair is reported once, so a stable tool set warns
   * on the first inference rather than on all of them, while a tool added
   * later still gets reported.
   *
   * @param adapted Adaptation description mapped to the tools it applied to.
   */
  protected _warnSchemaAdaptations(adapted: Map<string, string[]>): void {
    const lines: string[] = [];
    const notes = [...adapted.keys()].sort();
    for (const note of notes) {
      const tools = adapted.get(note) as string[];
      const key = (t: string) => JSON.stringify([note, t]);
      const fresh = tools.filter((t) => !this._warnedSchemaAdaptations.has(key(t)));
      if (fresh.length === 0) {
        continue;
      }
      for (const t of fresh) {
        this._warnedSchemaAdaptations.add(key(t));
      }
      let listed = fresh.slice(0, 3).join(", ");
      if (fresh.length > 3) {
        listed += ` and ${fresh.length - 3} more`;
      }
      lines.push(`  ${note}: ${listed}`);
    }

    if (lines.length > 0) {
      logger.warning(`Adapted tool schemas Gemini doesn't accept as-is:\n${lines.join("\n")}`);
    }
  }

  /**
   * Convert a tool-result content value to Gemini's FunctionResponse.response shape.
   *
   * Gemini's `FunctionResponse.response` field requires a dict, so non-dict
   * values (e.g. plain strings, JSON-encoded scalars, or sentinel strings like
   * `"COMPLETED"` used when a function returned no value) are wrapped as
   * `{"value": <value>}`. JSON strings that decode to a dict are passed
   * through as-is.
   *
   * @param content The tool-result content. Typically the JSON-encoded return
   *   value of a function, but can also be a plain string (e.g.
   *   `"COMPLETED"`) or already-parsed dict.
   * @returns A dict suitable for `FunctionResponse.response`.
   */
  static toFunctionResponseDict(content: unknown): Record<string, unknown> {
    const isDict = (v: unknown): v is Record<string, unknown> =>
      v !== null && typeof v === "object" && !Array.isArray(v);
    if (isDict(content)) {
      return content;
    }
    if (typeof content !== "string") {
      return { value: content };
    }
    let decoded: unknown;
    try {
      decoded = pyJsonLoads(content);
    } catch (e) {
      rethrowIfCancelled(e);
      return { value: content };
    }
    if (isDict(decoded)) {
      return decoded;
    }
    return { value: decoded };
  }

  /**
   * Get messages from a universal LLM context in a format ready for logging
   * about Gemini.
   *
   * Removes or truncates sensitive data like image content for safe logging.
   *
   * @param context The LLM context containing messages.
   * @returns List of messages in a format ready for logging about Gemini.
   */
  getMessagesForLogging(context: LLMContext): Record<string, unknown>[] {
    // Get messages in Gemini's format
    const messages = this._fromUniversalContextMessages(this.getMessages(context)).messages;

    // Sanitize messages for logging
    const messagesForLogging: Record<string, unknown>[] = [];
    for (const message of messages) {
      // A JSON copy of the message (the SDK's JSON form). The broad catch
      // below is the safety net if any item isn't shaped as expected.
      const obj: Dict = JSON.parse(JSON.stringify(message ?? null)) ?? {};
      try {
        if ("parts" in obj) {
          for (const part of obj.parts) {
            if ("inlineData" in part) {
              part.inlineData.data = "...";
            }
            if ("thoughtSignature" in part) {
              part.thoughtSignature = "...";
            }
          }
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.debug(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
      messagesForLogging.push(obj);
    }
    return messagesForLogging;
  }

  /**
   * The Gemini developer API consumes its own Files API URIs; other URLs must
   * be inlined.
   *
   * A `gs://` URI is not consumable here: the developer API requires
   * registering it with the Files API first (which returns a Files API URI to
   * use instead). Only Vertex reads `gs://` directly — see
   * `GeminiVertexLLMAdapter`.
   */
  override supportsFileUrl(url: string, _mimeType: string): boolean {
    let hostname = "";
    try {
      hostname = new URL(url).hostname;
    } catch (e) {
      rethrowIfCancelled(e);
      hostname = "";
    }
    return (
      url.startsWith("https://") &&
      (hostname === "googleapis.com" || hostname.endsWith(".googleapis.com"))
    );
  }

  /**
   * Ensure the message list does not end with a model message.
   *
   * When the last message has `role="model"`, a minimal user message is
   * appended so that the API request is accepted. "." represents a
   * language-neutral no-op user turn.
   *
   * @param messages The converted message list (may be mutated in-place).
   * @returns The same list, possibly with an appended user message.
   */
  protected static _ensureLastMessageIsUser(messages: Content[]): Content[] {
    if (messages.length > 0 && messages[messages.length - 1]?.role === "model") {
      messages.push({ role: "user", parts: [{ text: "." }] });
    }
    return messages;
  }

  /**
   * Restructures messages to ensure proper Google format and message ordering.
   *
   * This method handles conversion of OpenAI-formatted messages to Google
   * format, with special handling for function calls, function responses, and
   * system/developer messages.
   *
   * Initial system/developer messages are extracted as the system instruction
   * (only from `messages[0]`). Subsequent system/developer messages are
   * converted to user role.
   *
   * @param universalContextMessages Messages from the LLM context.
   * @param options.systemInstruction Optional system instruction from service
   *   settings, used to decide whether to extract an initial "developer"
   *   message.
   */
  protected _fromUniversalContextMessages(
    universalContextMessages: LLMContextMessage[],
    options: { systemInstruction?: string | null } = {},
  ): ConvertedMessages {
    const systemInstruction = options.systemInstruction ?? null;
    // Extract initial system/developer message from universal messages before conversion.
    // We work on a mutable copy so we can pop messages[0] if needed.
    const remainingMessages = [...universalContextMessages];
    let extractedSystem: string | null = null;

    // Extract initial system message from universal messages BEFORE conversion,
    // so the helper works with standard message format.
    if (remainingMessages.length > 0 && !(remainingMessages[0] instanceof LLMSpecificMessage)) {
      extractedSystem = this._extractInitialSystem(remainingMessages as Dict[], {
        systemInstruction,
      });
    }

    let messages: Content[] = [];
    const toolCallIdToNameMapping: Record<string, string> = {};
    const thoughtSignatureDicts: Dict[] = [];

    // Process each message, converting to Google format as needed. A
    // conversion failure (e.g. a malformed message) is wrapped so it
    // surfaces with its underlying cause.
    try {
      for (const message of remainingMessages) {
        // We have a Google-specific message; this may either be a
        // thought-signature-containing message that we need to handle in a
        // special way, or a message already in Google format that we can
        // use directly
        if (message instanceof LLMSpecificMessage) {
          const inner = message.message;
          if (
            inner !== null &&
            typeof inner === "object" &&
            !Array.isArray(inner) &&
            (inner as Dict).type === "thought_signature"
          ) {
            thoughtSignatureDicts.push(inner as Dict);
            continue;
          }

          // Fall back to assuming that the message is already in Google
          // format
          messages.push(inner as Content);
          continue;
        }

        // We have a standard universal context message; convert it to
        // Google format
        const result = this._fromStandardMessage(message, {
          params: new MessageConversionParams({ toolCallIdToNameMapping }),
        });

        if (result.content) {
          messages.push(result.content);
        }

        // Merge tool call ID to name mapping
        if (Object.keys(result.toolCallIdToNameMapping).length > 0) {
          Object.assign(toolCallIdToNameMapping, result.toolCallIdToNameMapping);
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      throw new LLMContextConversionError(e);
    }

    // Apply thought signatures to the corresponding messages
    this._applyThoughtSignaturesToMessages(thoughtSignatureDicts, messages);

    // When thinking is enabled, merge parallel tool calls into single messages
    messages = this._mergeParallelToolCallsForThinking(thoughtSignatureDicts, messages);

    this._addPlaceholderThoughtSignatures(messages);

    // Check if we only have function-related messages (no regular text)
    const effectiveSystem = extractedSystem || systemInstruction;
    const hasRegularMessages = messages.some((msg) => {
      const parts = msg?.parts;
      if (parts == null || parts.length !== 1) {
        return false;
      }
      const part = parts[0] as Part;
      return Boolean(part.text) && !part.functionCall && !part.functionResponse;
    });

    // Add system instruction back as a user message if we only have function messages
    if (effectiveSystem && !hasRegularMessages) {
      messages.push({ role: "user", parts: [{ text: effectiveSystem }] });
    }

    // Remove any empty messages
    messages = messages.filter((m) => m?.parts && m.parts.length > 0);

    return new ConvertedMessages({
      messages,
      systemInstruction: extractedSystem,
    });
  }

  /**
   * Convert standard universal context message to Google Content object.
   *
   * Handles conversion of text, images, and function calls to Google's format.
   * System and developer messages at this stage (i.e. non-initial ones, since
   * the initial one is already extracted) are converted to user role.
   *
   * @param message Message in standard universal context format.
   * @param options.params Parameters for conversion.
   * @returns MessageConversionResult containing a Content object.
   *
   * @example
   * // Standard text message:
   * { role: "user", content: "Hello there" }
   * // Converts to Google Content with:
   * { role: "user", parts: [{ text: "Hello there" }] }
   *
   * // Standard function call message:
   * {
   *   role: "assistant",
   *   tool_calls: [{ function: { name: "search", arguments: '{"query": "test"}' } }],
   * }
   * // Converts to Google Content with:
   * { role: "user", parts: [{ functionCall: { name: "search", args: { query: "test" } } }] }
   */
  protected _fromStandardMessage(
    message: LLMStandardMessage,
    options: { params: MessageConversionParams },
  ): MessageConversionResult {
    const { params } = options;
    const msg = message as Dict;
    let role: string = msg.role;
    const content = "content" in msg ? msg.content : [];

    // Convert non-initial system/developer messages to user role,
    // as Gemini doesn't support these as input messages.
    if (role === "system" || role === "developer") {
      role = "user";
    } else if (role === "assistant") {
      role = "model";
    }

    const parts: Part[] = [];
    const toolCallIdToNameMapping: Record<string, string> = {};

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls as Dict[]) {
        const id = tc.id as string;
        const name = tc.function.name as string;
        toolCallIdToNameMapping[id] = name;
        parts.push({
          functionCall: {
            id,
            name,
            args: pyJsonLoads(tc.function.arguments) as Record<string, unknown>,
          },
        });
      }
    } else if (role === "tool") {
      role = "user";
      const responseDict = GeminiLLMAdapter.toFunctionResponseDict(msg.content);

      // Get function name from mapping using tool_call_id, or fallback
      const toolCallId: string | undefined = msg.tool_call_id ?? undefined;
      let functionName = "tool_call_result"; // Default fallback
      if (toolCallId && Object.hasOwn(params.toolCallIdToNameMapping, toolCallId)) {
        functionName = params.toolCallIdToNameMapping[toolCallId] as string;
      }

      parts.push({
        functionResponse: {
          ...(toolCallId != null ? { id: toolCallId } : {}),
          name: functionName,
          response: responseDict,
        },
      });
    } else if (typeof content === "string") {
      parts.push({ text: content });
    } else if (Array.isArray(content)) {
      for (const c of content as Dict[]) {
        if (c.type === "text") {
          parts.push({ text: c.text });
        } else if (c.type === "image_url" && (c.image_url.url as string).startsWith("data:")) {
          // Extract MIME type from data URL (format: "data:image/jpeg;base64,...")
          const url = c.image_url.url as string;
          const mimeType = (url.split(":")[1] as string).split(";")[0] as string;
          parts.push({
            inlineData: {
              mimeType,
              data: bytesToBase64(base64ToBytes(url.split(",")[1] as string)),
            },
          });
        } else if (c.type === "image_url") {
          const url = c.image_url.url as string;
          parts.push(partFromUri(url));
        } else if (c.type === "input_audio") {
          const inputAudio = c.input_audio as Dict;
          const audioBytes = base64ToBytes(inputAudio.data as string);
          parts.push({ inlineData: { mimeType: "audio/wav", data: bytesToBase64(audioBytes) } });
        } else if (c.type === "file_base64") {
          const fData = c.file as Dict;
          parts.push({
            inlineData: {
              mimeType: fData.mime_type,
              data: bytesToBase64(this.decodedFileBytes(fData)),
            },
          });
        } else if (c.type === "file_url") {
          const fData = c.file as Dict;
          // Throws for a URL the provider can't consume with nothing
          // resolved (wrapped as LLMContextConversionError by the caller in
          // _fromUniversalContextMessages).
          const resolved = this.inlinedFileContent(fData);
          if (resolved === null) {
            parts.push(partFromUri(fData.url, fData.mime_type));
          } else {
            // Raw-bytes adapters always cache the decoded form.
            parts.push({
              inlineData: {
                mimeType: fData.mime_type,
                data: bytesToBase64(resolved as Uint8Array),
              },
            });
          }
        } else if (c.type === "file_data") {
          const fileData = c.file_data as Dict;
          parts.push({
            fileData: {
              mimeType: fileData.mime_type ?? undefined,
              fileUri: fileData.file_uri ?? undefined,
            },
          });
        }
      }
    }

    return new MessageConversionResult({
      content: { role, parts },
      toolCallIdToNameMapping,
    });
  }

  /**
   * Merge parallel tool calls and their responses into single Content objects.
   *
   * Gemini expects the two sides of a batch of parallel tool calls to each
   * live in a single Content: all the `function_call` Parts in one model turn,
   * and all the matching `function_response` Parts in the following user turn.
   * It rejects the request when the number of response Parts in the response
   * turn doesn't match the number of call Parts in the call turn. In practice
   * the Vertex AI endpoint enforces this strictly (with a 400); the Gemini
   * Developer API is currently more lenient and accepts the split form, but
   * the grouped form is the shape the API documents, so we always produce it.
   * Pipecat's context stores each call (and its response) as its own message,
   * so a batch of parallel calls arrives split across several messages; this
   * method regroups both sides back into a single model turn and a single
   * user turn.
   *
   * This only has an effect when thought_signatures are present (i.e., when
   * thinking is enabled). When thinking is disabled, merging doesn't matter.
   * When thinking is enabled, there is a guarantee that the first tool call
   * (and only the first) in any batch of parallel tool calls will have a
   * thought_signature. This allows us to distinguish:
   *
   * - Parallel tool calls: share a single thought_signature (on the first call)
   * - Sequential tool calls: each have their own thought_signature
   *
   * Algorithm: A tool call message with a thought_signature starts a new
   * parallel group. Scanning forward, subsequent unsigned tool call messages
   * and their function response messages are merged into the group's single
   * model turn and single user turn respectively, and a fresh
   * thought_signature ends the group. Any other messages that happen to be
   * interleaved are collected and re-emitted after the group, so the
   * regrouping makes as few assumptions as possible about the surrounding
   * message structure.
   *
   * @param thoughtSignatureDicts A list of thought signature dicts, used to
   *   determine if the work of merging is necessary.
   * @param messages List of Content messages to process.
   * @returns List of Content messages with parallel tool calls merged when
   *   thought_signatures are present, otherwise unchanged.
   */
  protected _mergeParallelToolCallsForThinking(
    thoughtSignatureDicts: Dict[],
    messages: Content[],
  ): Content[] {
    if (messages.length === 0) {
      return messages;
    }

    // Fast-exit if no function-call-related thought signatures
    // This is a shortcut for determining both:
    // - whether thinking is enabled, and
    // - whether there are function calls in the messages
    const hasFunctionCallSignatures = thoughtSignatureDicts.some(
      (ts) => ts.bookmark?.function_call,
    );
    if (!hasFunctionCallSignatures) {
      return messages;
    }

    /** Check if message contains only function_call parts. */
    const isToolCallMessage = (msg: Content): boolean =>
      Boolean(
        msg.role === "model" &&
          msg.parts &&
          msg.parts.length > 0 &&
          msg.parts.every((part) => part.functionCall),
      );

    /** Check if message contains only function_response parts. */
    const isToolResponseMessage = (msg: Content): boolean =>
      Boolean(
        msg.role === "user" &&
          msg.parts &&
          msg.parts.length > 0 &&
          msg.parts.every((part) => part.functionResponse),
      );

    /** Check if any part in the message has a thought_signature. */
    const messageHasThoughtSignature = (msg: Content): boolean => {
      if (msg.parts == null) {
        return false;
      }
      return msg.parts.some((part) => part.thoughtSignature);
    };

    const mergedMessages: Content[] = [];
    let i = 0;

    while (i < messages.length) {
      const current = messages[i] as Content;

      // If this is a tool call message with a thought signature, start merging
      if (isToolCallMessage(current) && messageHasThoughtSignature(current)) {
        const mergedParts: Part[] = [...(current.parts ?? [])];
        const mergedResponseParts: Part[] = [];
        const otherMessages: Content[] = [];
        let j = i + 1;

        // Scan forward: merge unsigned tool calls and their responses
        // into the group, collecting any other interleaved messages to
        // re-emit afterward. A fresh thought signature ends the group.
        while (j < messages.length) {
          const nextMsg = messages[j] as Content;
          if (isToolCallMessage(nextMsg)) {
            if (messageHasThoughtSignature(nextMsg)) {
              // New parallel group starts, stop here
              break;
            }
            // Merge this call into the current group
            mergedParts.push(...(nextMsg.parts ?? []));
            j += 1;
          } else if (isToolResponseMessage(nextMsg)) {
            // Merge the corresponding response into the group
            mergedResponseParts.push(...(nextMsg.parts ?? []));
            j += 1;
          } else {
            // Some other message is interleaved within the group;
            // collect it and keep scanning for this group's calls
            // and responses.
            otherMessages.push(nextMsg);
            j += 1;
          }
        }

        // Output the merged calls, then the merged responses, then any
        // other messages that were interleaved within the group.
        mergedMessages.push({ role: "model", parts: mergedParts });
        if (mergedResponseParts.length > 0) {
          mergedMessages.push({ role: "user", parts: mergedResponseParts });
        }
        mergedMessages.push(...otherMessages);
        i = j;
      } else {
        mergedMessages.push(current);
        i += 1;
      }
    }

    return mergedMessages;
  }

  /**
   * Give function calls in unsigned model turns the placeholder signature.
   *
   * A model turn with a signed part is left alone: Gemini signs only the first
   * call of a parallel batch and expects the rest unsigned.
   */
  protected _addPlaceholderThoughtSignatures(messages: Content[]): void {
    for (const message of messages) {
      if (
        message === null ||
        typeof message !== "object" ||
        message.role !== "model" ||
        !message.parts ||
        message.parts.length === 0
      ) {
        continue;
      }
      if (message.parts.some((part) => part.thoughtSignature)) {
        continue;
      }
      for (const part of message.parts) {
        if (part.functionCall) {
          part.thoughtSignature = GeminiLLMAdapter._PLACEHOLDER_THOUGHT_SIGNATURE;
        }
      }
    }
  }

  /**
   * Apply thought signatures to corresponding assistant messages.
   *
   * See GoogleLLMService for more details about thought signatures.
   *
   * @param thoughtSignatureDicts A list of dicts containing:
   *   - "signature": a thought signature
   *   - "bookmark": a bookmark to identify the message part to apply the
   *     signature to. The bookmark may contain one of:
   *     - "function_call" (a function call ID string)
   *     - "text" (a text string)
   *     - "inline_data" (a Blob)
   *   The list of thought signature dicts is in order.
   * @param messages List of messages to apply the thought signatures to.
   */
  protected _applyThoughtSignaturesToMessages(
    thoughtSignatureDicts: Dict[],
    messages: Content[],
  ): void {
    if (thoughtSignatureDicts.length === 0) {
      return;
    }

    // For debugging, print out thought signatures and their bookmarks
    logger.debug(`Thought signatures to apply: ${thoughtSignatureDicts.length}`);
    for (const ts of thoughtSignatureDicts) {
      const bookmark = ts.bookmark as Dict | null | undefined;
      if (bookmark == null) {
        continue;
      }
      if (bookmark.function_call) {
        logger.trace(` - To function call: ${bookmark.function_call}`);
      } else if (bookmark.text) {
        logger.trace(` - To text: ${logDisplayText(bookmark.text as string)}`);
      } else if (bookmark.inline_data) {
        logger.trace(" - To inline data");
      }
    }

    // Get all assistant messages
    const assistantMessages = messages.filter(
      (message) => message !== null && typeof message === "object" && message.role === "model",
    );

    // Apply thought signatures to the corresponding assistant messages.
    // Thought signatures are already in message order.
    let thoughtSignaturesApplied = 0;
    let messageStartIndex = 0; // Track where to start searching for the next matching message.
    for (const thoughtSignatureDict of thoughtSignatureDicts) {
      const signature = thoughtSignatureDict.signature;
      const bookmark = thoughtSignatureDict.bookmark as Dict | null | undefined;
      // Python truthiness: empty bytes and an empty dict are falsy.
      if (
        !signature ||
        (signature instanceof Uint8Array && signature.length === 0) ||
        !bookmark ||
        Object.keys(bookmark).length === 0
      ) {
        continue;
      }

      // Search through remaining assistant messages for a match
      for (let i = messageStartIndex; i < assistantMessages.length; i++) {
        const message = assistantMessages[i] as Content;
        if (!message.parts || message.parts.length === 0) {
          continue;
        }

        // We're assuming that the thought signature always applies to the last part
        const lastPart = message.parts[message.parts.length - 1] as Part;

        // If the bookmark matches the part...
        if (this._thoughtSignatureBookmarkMatchesPart(bookmark, lastPart)) {
          // Apply the thought signature
          lastPart.thoughtSignature =
            signature instanceof Uint8Array ? bytesToBase64(signature) : (signature as string);
          thoughtSignaturesApplied += 1;

          // Update the start index and stop searching for a match
          messageStartIndex = i + 1;
          break;
        }
      }
    }

    // For debugging, print out how many thought signatures were applied
    logger.debug(`Applied ${thoughtSignaturesApplied} thought signatures.`);
  }

  protected _thoughtSignatureBookmarkMatchesPart(bookmark: Dict, part: Part): boolean {
    const functionCallBookmark = bookmark.function_call;
    const textBookmark = bookmark.text;
    const inlineData = bookmark.inline_data;
    if (functionCallBookmark) {
      return this._thoughtSignatureFunctionCallBookmarkMatchesPart(functionCallBookmark, part);
    } else if (textBookmark) {
      return this._thoughtSignatureTextBookmarkMatchesPart(textBookmark, part);
    } else if (inlineData) {
      return this._thoughtSignatureInlineDataBookmarkMatchesPart(inlineData, part);
    } else {
      logger.warning(`Unknown thought signature bookmark type: ${JSON.stringify(bookmark)}`);
    }

    return false;
  }

  protected _thoughtSignatureFunctionCallBookmarkMatchesPart(
    bookmarkFunctionCallId: string,
    part: Part,
  ): boolean {
    if (part.functionCall && part.functionCall.id === bookmarkFunctionCallId) {
      logger.trace(`Thought signature function call match: ${bookmarkFunctionCallId}`);
      return true;
    }

    return false;
  }

  protected _thoughtSignatureTextBookmarkMatchesPart(bookmarkText: string, part: Part): boolean {
    if (part.text) {
      // Normalize whitespace for comparison
      const normalizedBookmark = normalizeWhitespace(bookmarkText);
      const partText = normalizeWhitespace(part.text);
      // Check that either:
      // - the part text is the same as the bookmark text
      // - a prefix of the bookmark text (in case the part text was truncated due to interruption)
      // - the bookmark text is a prefix of the part text (in case the bookmark represents just first chunk of multi-chunk text)
      if (
        partText === normalizedBookmark ||
        normalizedBookmark.startsWith(partText) ||
        partText.startsWith(normalizedBookmark)
      ) {
        logger.trace(`Thought signature text match: ${logDisplayText(part.text)}`);
        return true;
      }
    }

    return false;
  }

  protected _thoughtSignatureInlineDataBookmarkMatchesPart(
    bookmarkInlineData: GenAIBlob | Dict,
    part: Part,
  ): boolean {
    const partLength = blobDataLength(part.inlineData?.data);
    const bookmarkLength = blobDataLength((bookmarkInlineData as Dict).data);
    if (
      part.inlineData &&
      partLength !== null &&
      bookmarkLength !== null &&
      // Comparing length should be good enough for matching inline data,
      // especially since we're already matching thought signatures in
      // strict message order. Comparing actual data is expensive.
      partLength === bookmarkLength
    ) {
      logger.trace("Thought signature inline data match");
      return true;
    }

    return false;
  }
}

/**
 * Gemini adapter for Vertex AI.
 *
 * Identical to `GeminiLLMAdapter` except for file URL support: Vertex reads
 * `gs://` URIs directly through its own IAM, with no registration step.
 */
export class GeminiVertexLLMAdapter extends GeminiLLMAdapter {
  /** Vertex additionally consumes `gs://` URIs directly. */
  override supportsFileUrl(url: string, mimeType: string): boolean {
    return url.startsWith("gs://") || super.supportsFileUrl(url, mimeType);
  }
}
