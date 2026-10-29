// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/aggregators/llm_context.py

/**
 * Universal LLM context management for LLM services in Pipecat.
 *
 * Context contents are represented in a universal format (based on OpenAI)
 * that supports a union of known Pipecat LLM service functionality.
 *
 * Whenever an LLM service needs to access context, it does a just-in-time
 * translation from this universal context into whatever format it needs,
 * using a service-specific adapter.
 */

import type { DirectFunction } from "../../adapters/llm/schemas/direct_function.ts";
import { FunctionSchema } from "../../adapters/llm/schemas/function_schema.ts";
import { ToolsSchema } from "../../adapters/llm/schemas/tools_schema.ts";
import { pcmToWav } from "../../audio/utils.ts";
import type { AudioRawFrame, FileSourceType } from "../../frames/frames.ts";
import { bytesToBase64 } from "../../utils/base64.ts";
import { encodeImage } from "../../utils/image.ts";
import { logger } from "../../utils/logger.ts";
import { NOT_GIVEN, type NotGiven } from "../../utils/types.ts";

// The sentinel is part of LLMContext's public surface (tools and toolChoice
// default to it), so it is re-exported here for callers.
export { isGiven, NOT_GIVEN, NotGiven } from "../../utils/types.ts";

// Universal context types. Upstream aliases these to OpenAI's chat completion
// types for type checking only; callers should treat them as LLMContext's own
// types, independent definitions that happen to coincide with OpenAI's. At
// runtime they are plain objects (or strings), which is all we model here.

/**
 * A message in the universal (OpenAI-based) context format: an object with a
 * `role` and, usually, a `content` that is a string or a list of content parts.
 * Keys are the wire keys (`tool_call_id`, `tool_calls`, ...), unchanged.
 */
export interface LLMStandardMessage {
  role: string;
  content?: any;
  [key: string]: any;
}

/** The tool choice strategy, in OpenAI's `tool_choice` format. */
export type LLMContextToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } }
  | Record<string, any>;

/**
 * A container for a context message that is specific to a particular LLM service.
 *
 * Enables the use of service-specific message types while maintaining
 * compatibility with the universal LLM context format.
 */
export class LLMSpecificMessage {
  llm: string;
  message: unknown;

  constructor(options: { llm: string; message: unknown }) {
    this.llm = options.llm;
    this.message = options.message;
  }
}

export type LLMContextMessage = LLMStandardMessage | LLMSpecificMessage;

/** The tools accepted by LLMContext: a ToolsSchema, a plain list, or NOT_GIVEN. */
export type LLMContextTools = ToolsSchema | (FunctionSchema | DirectFunction)[] | NotGiven;

function isDict(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object" || typeof value === "function") {
    return (value as object).constructor?.name ?? typeof value;
  }
  return typeof value;
}

/**
 * Return the text of a standard context message, joining the text parts of
 * list content.
 *
 * @param message A context message.
 * @returns The text, or `""` for a message in a service's own format or one
 *   that carries no text.
 */
export function standardMessageText(message: LLMContextMessage): string {
  if (message instanceof LLMSpecificMessage) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => isDict(part) && part.type === "text" && part.text)
      .map((part) => (part as Record<string, unknown>).text ?? "")
      .join(" ");
  }
  return "";
}

export interface LLMContextOptions {
  /** Initial list of conversation messages. */
  messages?: LLMContextMessage[] | null;
  /**
   * Available tools for the LLM to use. May be a `ToolsSchema` or a plain
   * list of direct functions and/or `FunctionSchema` objects (normalized to a
   * `ToolsSchema` internally). Any tool that carries a handler (a direct
   * function, or a `FunctionSchema` with its `handler` set) is registered
   * with the LLM service automatically, so no separate `registerFunction`
   * call is needed.
   */
  tools?: LLMContextTools;
  /** Tool selection strategy for the LLM. */
  toolChoice?: LLMContextToolChoice | NotGiven;
}

/**
 * Manages conversation context for LLM interactions.
 *
 * Handles message history, tool definitions, tool choices, and multimedia
 * content for LLM conversations. Provides methods for message manipulation,
 * and content formatting.
 */
export class LLMContext {
  protected _messages: LLMContextMessage[];
  protected _tools: ToolsSchema | NotGiven;
  protected _toolChoice: LLMContextToolChoice | NotGiven;

  constructor(options: LLMContextOptions = {}) {
    this._messages = options.messages && options.messages.length > 0 ? options.messages : [];
    this._tools = LLMContext._normalizeAndValidateTools(options.tools ?? NOT_GIVEN);
    this._toolChoice = options.toolChoice ?? NOT_GIVEN;
  }

  /**
   * Create a context message containing an image URL.
   *
   * @param options.role The role of this message (defaults to "user").
   * @param options.url The URL of the image.
   * @param options.text Optional text to include with the image.
   */
  static createImageUrlMessage(options: {
    role?: string;
    url: string;
    text?: string | null;
  }): LLMContextMessage {
    // TODO: Deprecate support for a non-data `url` here now that
    //       `createFileUrlMessage` exists: a URL-referenced image and a
    //       URL-referenced file should go through the same path instead of two.
    const role = options.role ?? "user";
    const content: Record<string, unknown>[] = [];
    if (options.text) {
      content.push({ type: "text", text: options.text });
    }

    content.push({ type: "image_url", image_url: { url: options.url } });

    return { role, content };
  }

  /**
   * Create a context message containing an image.
   *
   * @param options.role The role of this message (defaults to "user").
   * @param options.format Image format (e.g. 'RGB', 'RGBA', or, if already
   *   encoded, the MIME type like 'image/jpeg').
   * @param options.size Image dimensions as [width, height].
   * @param options.image Raw image bytes.
   * @param options.text Optional text to include with the image.
   */
  static async createImageMessage(options: {
    role?: string;
    format: string;
    size: [number, number];
    image: Uint8Array;
    text?: string | null;
  }): Promise<LLMContextMessage> {
    const [data, contentType] = await encodeImage(options.image, options.size, options.format);
    const encodedImage = bytesToBase64(data);

    const url = `data:${contentType};base64,${encodedImage}`;

    return LLMContext.createImageUrlMessage({
      role: options.role ?? "user",
      url,
      text: options.text ?? null,
    });
  }

  /**
   * Create a context message containing a file.
   *
   * @param options.role The role of this message (defaults to "user").
   * @param options.type The type of the file.
   * @param options.format MIME type of the file (e.g. "application/pdf").
   * @param options.file Base64 data URL (`data:<mime>;base64,...`) or plain URL string.
   * @param options.name Optional name of the file.
   * @param options.text Optional text to include with the file.
   */
  static async createFileMessage(options: {
    role?: string;
    type: FileSourceType;
    format: string;
    file: string;
    name?: string | null;
    text?: string | null;
  }): Promise<LLMContextMessage> {
    const role = options.role ?? "user";
    // The URL is stored unresolved; at completion time the LLM service either
    // passes it to the provider to fetch itself or downloads it via its
    // FileResolver, depending on what the provider can consume.
    if (options.type === "url") {
      return LLMContext.createFileUrlMessage({
        role,
        format: options.format,
        url: options.file,
        filename: options.name ?? null,
        text: options.text ?? null,
      });
    }

    const content: Record<string, unknown>[] = [];
    if (options.text) {
      content.push({ type: "text", text: options.text });
    }

    const fileM = {
      file_data: options.file,
      filename: options.name ? options.name : "",
      mime_type: options.format,
    };
    content.push({ type: "file_base64", file: fileM });

    return { role, content };
  }

  /**
   * Create a context message containing an image or file URL.
   *
   * @param options.role The role of this message (defaults to "user").
   * @param options.format The MIME type of the file (e.g. 'application/pdf').
   * @param options.url The URL of the image or file.
   * @param options.filename Optional name of the file.
   * @param options.text Optional text to include with the image or file.
   */
  static createFileUrlMessage(options: {
    role?: string;
    format: string;
    url: string;
    filename?: string | null;
    text?: string | null;
  }): LLMContextMessage {
    const role = options.role ?? "user";
    const content: Record<string, unknown>[] = [];
    if (options.text) {
      content.push({ type: "text", text: options.text });
    }

    const fileM = {
      url: options.url,
      filename: options.filename ? options.filename : "",
      mime_type: options.format,
    };
    content.push({ type: "file_url", file: fileM });

    return { role, content };
  }

  /**
   * Create a context message containing audio.
   *
   * @param options.role The role of this message (defaults to "user").
   * @param options.audioFrames List of audio frame objects to include.
   * @param options.text Optional text to include with the audio.
   */
  static async createAudioMessage(options: {
    role?: string;
    audioFrames: AudioRawFrame[];
    text?: string;
  }): Promise<LLMContextMessage> {
    const role = options.role ?? "user";
    const audioFrames = options.audioFrames;
    const content: Record<string, unknown>[] = [
      { type: "text", text: options.text ?? "Audio follows" },
    ];

    // Upstream runs this in a thread (asyncio.to_thread); there are no
    // threads on every runtime we target, so it runs inline.
    const encodeAudio = (): string => {
      const sampleRate = (audioFrames[0] as AudioRawFrame).sampleRate;
      const numChannels = (audioFrames[0] as AudioRawFrame).numChannels;

      const total = audioFrames.reduce((n, frame) => n + frame.audio.length, 0);
      const data = new Uint8Array(total);
      let offset = 0;
      for (const frame of audioFrames) {
        data.set(frame.audio, offset);
        offset += frame.audio.length;
      }

      const wav = pcmToWav(data, sampleRate, numChannels);
      return bytesToBase64(wav);
    };

    const encodedAudio = encodeAudio();

    content.push({
      type: "input_audio",
      input_audio: { data: encodedAudio, format: "wav" },
    });

    return { role, content };
  }

  /**
   * Get the current messages list.
   *
   * NOTE: This is equivalent to calling `getMessages()` with no filter. If
   * you want to filter out LLM-specific messages that don't pertain to your
   * LLM, use `getMessages()` directly.
   *
   * @returns List of conversation messages.
   */
  get messages(): LLMContextMessage[] {
    return this.getMessages();
  }

  /**
   * Get the current messages list.
   *
   * @param llmSpecificFilter Optional filter to return LLM-specific messages
   *   for the given LLM, in addition to the standard messages. If messages end
   *   up being filtered, an error will be logged; this is intended to catch
   *   accidental use of incompatible LLM-specific messages.
   * @param options.truncateLargeValues If true, return deep copies of
   *   messages with large values shortened. For standard messages, known
   *   binary data (base64-encoded images, audio) is replaced with short
   *   placeholders. For LLM-specific messages, long string values are
   *   truncated.
   * @returns List of conversation messages.
   */
  getMessages(
    llmSpecificFilter: string | null = null,
    options: { truncateLargeValues?: boolean } = {},
  ): LLMContextMessage[] {
    let messages: LLMContextMessage[];
    if (llmSpecificFilter === null) {
      messages = this._messages;
    } else {
      messages = this._messages.filter(
        (msg) => !(msg instanceof LLMSpecificMessage) || msg.llm === llmSpecificFilter,
      );
      if (messages.length < this._messages.length) {
        logger.error(
          `Attempted to use incompatible LLMSpecificMessages with LLM '${llmSpecificFilter}'.`,
        );
      }
    }

    if (options.truncateLargeValues ?? false) {
      messages = LLMContext._truncateLargeValuesFromMessages(messages);
    }

    return messages;
  }

  /**
   * Return deep copies of messages with large values replaced by placeholders.
   *
   * For standard (universal-format) messages, the following known binary
   * patterns are replaced with short placeholders:
   *
   * - `image_url` items with `data:image/...` base64 URLs
   * - `input_audio` items with `input_audio.data` or `audio` fields
   * - `audio` items with an `audio` field
   * - Top-level messages with a `mime_type` starting with `image/`
   *
   * For `LLMSpecificMessage` instances, long string values are truncated
   * since the internal structure is provider-specific.
   */
  protected static _truncateLargeValuesFromMessages(
    messages: LLMContextMessage[],
  ): LLMContextMessage[] {
    const result: LLMContextMessage[] = [];
    for (const message of messages) {
      if (message instanceof LLMSpecificMessage) {
        const msgCopy = new LLMSpecificMessage({
          llm: message.llm,
          message: LLMContext._truncateLongStrings(structuredClone(message.message)),
        });
        result.push(msgCopy);
        continue;
      }

      // The standard message variant is a union of object shapes; the
      // mutations below operate on plain objects at runtime. Treat as such
      // for the duration of the redaction loop.
      const msg: Record<string, any> = structuredClone(message);
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          const itemType = item?.type;
          if (itemType === "image_url") {
            const url = item.image_url?.url ?? "";
            if (typeof url === "string" && url.startsWith("data:image/")) {
              item.image_url.url = "data:image/...";
            }
          } else if (itemType === "input_audio") {
            if ("input_audio" in item) {
              item.input_audio.data = "...";
            }
            if ("audio" in item) {
              item.audio = "...";
            }
          } else if (itemType === "audio") {
            if ("audio" in item) {
              item.audio = "...";
            }
          } else if (itemType === "file_base64") {
            if ("file" in item) {
              item.file.file_data = "...";
              delete item.file._raw_bytes;
            }
          }
        }
      }

      const mimeType = msg.mime_type ?? "";
      if (typeof mimeType === "string" && mimeType.startsWith("image/")) {
        msg.data = "...";
      }

      result.push(msg as LLMStandardMessage);
    }
    return result;
  }

  /**
   * Recursively truncate long strings in a nested structure.
   *
   * Preserves the structure of objects and lists while truncating any string
   * values that exceed `maxLength`.
   *
   * @param value The value to process (object, list, string, or other).
   * @param options.maxLength Strings longer than this are truncated.
   * @returns A copy of the structure with long strings truncated.
   */
  protected static _truncateLongStrings(
    value: unknown,
    options: { maxLength?: number } = {},
  ): unknown {
    const maxLength = options.maxLength ?? 100;
    if (typeof value === "string") {
      if (value.length > maxLength) {
        return `${value.slice(0, maxLength)}...(${value.length} chars)`;
      }
      return value;
    } else if (isDict(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          LLMContext._truncateLongStrings(v, { maxLength }),
        ]),
      );
    } else if (Array.isArray(value)) {
      return value.map((item) => LLMContext._truncateLongStrings(item, { maxLength }));
    }
    return value;
  }

  /**
   * Get the tools list.
   *
   * @returns Tools list.
   */
  get tools(): ToolsSchema | NotGiven {
    return this._tools;
  }

  /**
   * Get the current tool choice setting.
   *
   * @returns The tool choice configuration.
   */
  get toolChoice(): LLMContextToolChoice | NotGiven {
    return this._toolChoice;
  }

  /**
   * Add a single message to the context.
   *
   * @param message The message to add to the conversation history.
   */
  addMessage(message: LLMContextMessage): void {
    this._messages.push(message);
  }

  /**
   * Add multiple messages to the context.
   *
   * @param messages List of messages to add to the conversation history.
   */
  addMessages(messages: LLMContextMessage[]): void {
    for (const message of messages) {
      this._messages.push(message);
    }
  }

  /**
   * Replace all messages in the context.
   *
   * @param messages New list of messages to replace the current history.
   */
  setMessages(messages: LLMContextMessage[]): void {
    // In place, like Python's `self._messages[:] = messages`.
    const copy = [...messages];
    this._messages.length = 0;
    for (const message of copy) {
      this._messages.push(message);
    }
  }

  /**
   * Transform the current messages using the provided function.
   *
   * @param transform A function that takes the current list of messages and
   *   returns a modified list of messages to set in the context.
   */
  transformMessages(transform: (messages: LLMContextMessage[]) => LLMContextMessage[]): void {
    this.setMessages(transform(this._messages));
  }

  /**
   * Set the available tools for the LLM.
   *
   * @param tools A ToolsSchema, a plain list of direct functions and/or
   *   `FunctionSchema` objects, or NOT_GIVEN to disable tools.
   */
  setTools(tools: LLMContextTools = NOT_GIVEN): void {
    this._tools = LLMContext._normalizeAndValidateTools(tools);
  }

  /**
   * Set the tool choice configuration.
   *
   * @param toolChoice Tool selection strategy for the LLM.
   */
  setToolChoice(toolChoice: LLMContextToolChoice | NotGiven): void {
    this._toolChoice = toolChoice;
  }

  /**
   * Add a message containing an image frame.
   *
   * @param options.format Image format (e.g. 'RGB', 'RGBA', or, if already
   *   encoded, the MIME type like 'image/jpeg').
   * @param options.size Image dimensions as [width, height].
   * @param options.image Raw image bytes.
   * @param options.text Optional text to include with the image.
   * @param options.role The role of this message (defaults to "user").
   */
  async addImageFrameMessage(options: {
    format: string;
    size: [number, number];
    image: Uint8Array;
    text?: string | null;
    role?: string;
  }): Promise<void> {
    const message = await LLMContext.createImageMessage({
      role: options.role ?? "user",
      format: options.format,
      size: options.size,
      image: options.image,
      text: options.text ?? null,
    });
    this.addMessage(message);
  }

  /**
   * Add a message containing a file frame.
   *
   * @param options.type File source type.
   * @param options.format MIME type of the file (e.g. 'application/pdf').
   * @param options.file Base64 data URL (`data:<mime>;base64,...`) or plain
   *   URL string. URL fetching for providers that require bytes is handled by
   *   the provider adapter during message conversion.
   * @param options.text Optional text to accompany the file.
   * @param options.name Optional file name.
   * @param options.role Message role (defaults to 'user').
   */
  async addFileFrameMessage(options: {
    type: FileSourceType;
    format: string;
    file: string;
    text?: string | null;
    name?: string | null;
    role?: string;
  }): Promise<void> {
    const message = await LLMContext.createFileMessage({
      role: options.role ?? "user",
      type: options.type,
      format: options.format,
      file: options.file,
      name: options.name ?? null,
      text: options.text ?? null,
    });
    this.addMessage(message);
  }

  /**
   * Add a message containing audio frames.
   *
   * @param options.audioFrames List of audio frame objects to include.
   * @param options.text Optional text to include with the audio.
   */
  async addAudioFramesMessage(options: {
    audioFrames: AudioRawFrame[];
    text?: string;
  }): Promise<void> {
    const message = await LLMContext.createAudioMessage({
      audioFrames: options.audioFrames,
      text: options.text ?? "Audio follows",
    });
    this.addMessage(message);
  }

  /**
   * Remove the oldest file or image message added since the model's last
   * successful reply.
   *
   * Best-effort cleanup for an LLM service to call once it's determined (from
   * a provider-specific error) that a request was rejected due to unsupported
   * or malformed file content, e.g. an unsupported MIME type, corrupt bytes,
   * or an image whose bytes don't match its declared media type. Removing it
   * prevents the context from getting permanently stuck retrying the same
   * failure. Images count as files here: both are discrete client-supplied
   * attachments a provider can reject the same way. Audio content
   * deliberately doesn't: audio-in-context flows append audio as ordinary
   * conversation every turn, so removing the oldest audio message on an
   * unrelated rejection would discard real conversation rather than a bad
   * attachment.
   *
   * Providers don't say which message or content item triggered the
   * rejection, so there's no way to identify the exact culprit; this is a
   * heuristic, not a precise fix. An assistant message proves everything
   * before it was already accepted by a prior successful completion
   * (assistant messages are only ever appended after a completion succeeds),
   * so only file messages added since the last one are candidates; a file
   * from an earlier, already-successful turn is never at risk. If several
   * files are candidates (e.g. sent in quick succession before either went
   * through a completion), only the oldest is removed: if it wasn't the actual
   * culprit, the next retry fails again and removes the next-oldest,
   * converging on the bad file within a few retries without ever knowing
   * which one the provider meant.
   *
   * @returns True if a file or image message was found and removed.
   */
  removeInvalidFileMessage(): boolean {
    let sinceIndex = 0;
    for (let i = this._messages.length - 1; i >= 0; i--) {
      const message = this._messages[i] as LLMContextMessage;
      if (!(message instanceof LLMSpecificMessage) && message.role === "assistant") {
        sinceIndex = i + 1;
        break;
      }
    }

    for (let i = sinceIndex; i < this._messages.length; i++) {
      const message = this._messages[i] as LLMContextMessage;
      if (message instanceof LLMSpecificMessage) {
        continue;
      }
      const content = message.content;
      if (
        Array.isArray(content) &&
        content.some(
          (item) =>
            isDict(item) &&
            (item.type === "file_base64" || item.type === "file_url" || item.type === "image_url"),
        )
      ) {
        logger.warning(
          "Removing message with file or image content from context due to invalid response.",
        );
        this._messages.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  /**
   * Normalize and validate the given tools.
   *
   * A plain list of direct functions and/or `FunctionSchema` objects is
   * wrapped in a `ToolsSchema`.
   *
   * @param tools The tools to normalize: a `ToolsSchema`, a list of direct
   *   functions and/or `FunctionSchema` objects, or `NOT_GIVEN`.
   * @param options.allowProviderTools If true, a list that isn't entirely
   *   standard tools (direct functions / `FunctionSchema` objects) is taken to
   *   be already-formatted, provider-native tools and returned unchanged
   *   rather than throwing. For callers whose tools parameter accepts
   *   provider-native tools alongside standard ones.
   * @throws TypeError If tools aren't a `ToolsSchema`, list, or `NOT_GIVEN`,
   *   or, unless `allowProviderTools` is set, if a list contains anything
   *   other than standard tools.
   */
  static _normalizeAndValidateTools(
    tools: LLMContextTools,
    options?: { allowProviderTools?: false },
  ): ToolsSchema | NotGiven;
  static _normalizeAndValidateTools(
    tools: ToolsSchema | unknown[] | NotGiven,
    options: { allowProviderTools: true },
  ): ToolsSchema | unknown[] | NotGiven;
  static _normalizeAndValidateTools(
    tools: ToolsSchema | unknown[] | NotGiven,
    options: { allowProviderTools?: boolean } = {},
  ): ToolsSchema | unknown[] | NotGiven {
    const allowProviderTools = options.allowProviderTools ?? false;
    let normalized: unknown = tools;
    if (Array.isArray(tools)) {
      if (
        allowProviderTools &&
        !tools.every((t) => t instanceof FunctionSchema || typeof t === "function")
      ) {
        // Already-formatted, provider-native tools; pass through unchanged.
        return tools;
      }
      normalized = new ToolsSchema({
        standardTools: tools as (FunctionSchema | DirectFunction)[],
      });
    }
    if (normalized instanceof ToolsSchema) {
      const custom: unknown = normalized.customTools;
      const hasCustom =
        custom instanceof Map
          ? custom.size > 0
          : custom != null && Object.keys(custom as object).length > 0;
      if (normalized.standardTools.length === 0 && !hasCustom) {
        return NOT_GIVEN;
      }
      return normalized;
    } else if (normalized === NOT_GIVEN) {
      return NOT_GIVEN;
    } else {
      throw new TypeError(
        "In LLMContext, tools must be a ToolsSchema, a list of direct functions / " +
          `FunctionSchema objects, or NOT_GIVEN. Got type: ${typeName(normalized)}`,
      );
    }
  }
}
