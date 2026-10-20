// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/base_llm_adapter.py

/**
 * Base adapter for LLM provider integration.
 *
 * Provides the abstract base class for implementing LLM provider-specific
 * adapters that handle tool format conversion and standardization.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import {
  type LLMContext,
  type LLMContextMessage,
  LLMSpecificMessage,
  type NotGiven,
} from "../processors/aggregators/llm_context.ts";
import { warnDeprecated } from "../utils/deprecation.ts";
import type { FileResolver } from "../utils/file_resolver.ts";
import { logger } from "../utils/logger.ts";
import { UrlReachability } from "../utils/security/ssrf.ts";
import { isGiven } from "../utils/types.ts";
import type { FunctionSchema } from "./schemas/function_schema.ts";
import { ToolsSchema } from "./schemas/tools_schema.ts";

type Dict = Record<string, any>;

let warnedBuiltinToolsNotInjected = false;

/** The scheme of a URL, lowercased (Python's `urlsplit(url).scheme`). */
export function urlScheme(url: string): string {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  return match ? (match[1] as string).toLowerCase() : "";
}

function base64Decode(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Raised when converting a universal `LLMContext` to a provider's message
 * format fails.
 *
 * Adapters that transform context messages into a provider-specific format
 * throw this from their conversion routine, wrapping the underlying error
 * (preserved as `cause`). Its message identifies the failure as a
 * context-mapping problem and carries the underlying cause. The corresponding
 * LLM service catches this and surfaces it in the `ErrorFrame` it pushes
 * upstream.
 */
export class LLMContextConversionError extends Error {
  override name = "LLMContextConversionError";

  /**
   * @param cause The underlying error raised during message conversion.
   */
  constructor(cause: unknown) {
    super(`Error mapping context messages to provider format: ${errorText(cause)}`, { cause });
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Abstract base class for LLM provider adapters.
 *
 * Provides a standard interface for converting to provider-specific formats.
 *
 * Handles:
 *
 * - Extracting provider-specific parameters for LLM invocation from a
 *   universal LLM context
 * - Converting standardized tools schema to provider-specific tool formats.
 * - Extracting messages from the LLM context for the purposes of logging
 *   about the specific provider.
 * - Resolving conflicts between `systemInstruction` and initial
 *   system/developer messages in the conversation context.
 *
 * Subclasses must implement provider-specific conversion logic.
 */
export abstract class BaseLLMAdapter<TLLMInvocationParams = Record<string, unknown>> {
  protected _warnedSystemInstruction = false;
  protected _warnedContextSystemMessage = false;
  protected _builtinTools: Record<string, FunctionSchema> = {};
  protected _fileResolver: FileResolver | null = null;

  // Whether this provider's conversion consumes raw bytes (rather than the
  // base64 payload of a data URL) for inline file content. Decides which form
  // the resolution pass prepares in the resolver's cache, so conversion never
  // re-decodes or re-encodes a file on later turns.
  prefersRawFileBytes = false;

  /**
   * Built-in tools automatically merged into every inference request.
   *
   * Keyed by tool name for O(1) lookup, insertion, and removal (`delete`). The service
   * injects tools here so they are sent transparently on every inference
   * request without the user having to add them to their `ToolsSchema`.
   */
  get builtinTools(): Record<string, FunctionSchema> {
    return this._builtinTools;
  }

  /** The identifier used in LLMSpecificMessage instances for this LLM provider. */
  abstract get idForLlmSpecificMessages(): string;

  /**
   * Get provider-specific LLM invocation parameters from a universal LLM
   * context.
   *
   * An adapter whose provider takes files awaits `prepareFileContent()`
   * first, so the files its conversion inlines are in the `fileResolver`'s
   * caches.
   *
   * @param context The LLM context containing messages, tools, etc.
   * @param options Additional provider-specific arguments that subclasses can use.
   * @returns Provider-specific parameters for invoking the LLM.
   */
  abstract getLlmInvocationParams(
    context: LLMContext,
    options?: object,
  ): Promise<TLLMInvocationParams>;

  /**
   * Convert tools schema to the provider's specific format.
   *
   * @param toolsSchema The standardized tools schema to convert.
   * @returns List of tools in the provider's expected format.
   */
  abstract toProviderToolsFormat(toolsSchema: ToolsSchema): unknown[];

  /**
   * Get messages from a universal LLM context in a format ready for logging
   * about this provider.
   *
   * @param context The LLM context containing messages.
   * @returns List of messages in a format ready for logging about this provider.
   */
  abstract getMessagesForLogging(context: LLMContext): Record<string, unknown>[];

  /**
   * The resolver that fetches and caches file content for this adapter.
   *
   * Set once by the owning LLM service. Every conversion this adapter
   * performs — invocation params and logging alike — reads the same resolver
   * caches. Without one, conversion still passes through URLs the provider
   * consumes directly, but fails on any file that would need fetching.
   */
  get fileResolver(): FileResolver | null {
    return this._fileResolver;
  }

  set fileResolver(resolver: FileResolver | null) {
    this._fileResolver = resolver;
  }

  /**
   * Whether the provider can be handed `url` to fetch itself.
   *
   * This covers both URLs the provider fetches over the public internet and
   * cloud-storage URIs it resolves through its own IAM (e.g. Bedrock reading
   * `s3://`). A URL the provider can't consume is instead fetched into the
   * file resolver's cache and inlined at conversion — see
   * `prepareFileContent()`.
   *
   * @param url The file URL from a `file_url` context content item.
   * @param mimeType The file's MIME type.
   * @returns True if conversion can pass `url` through to the provider.
   */
  supportsFileUrl(_url: string, _mimeType: string): boolean {
    return false;
  }

  /**
   * Fetch the file content this provider will need into the resolver's caches.
   *
   * A `file_url` item whose URL the provider consumes directly
   * (`supportsFileUrl()`, and — for `http(s)` — publicly routable) needs
   * nothing. Any other `file_url` item is fetched into the `fileResolver`'s
   * cache, in the form this provider's conversion reads: raw bytes when
   * `prefersRawFileBytes`, a base64 data URL otherwise. Inline `file_base64`
   * items get their decoded bytes cached for raw-bytes providers. The
   * resolver caches by URL, so each file is fetched once no matter how many
   * turns — or how many adapters sharing the resolver — consume it; only the
   * per-provider pass-through decision is re-evaluated here on every run.
   *
   * An adapter whose conversion inlines files (through `inlinedFileContent()`
   * or `decodedFileBytes()`) awaits this at the start of
   * `getLlmInvocationParams()`. An adapter for a provider that doesn't take
   * files doesn't call it, so nothing is fetched for that provider.
   *
   * @param context The LLM context whose messages to resolve.
   * @throws LLMContextConversionError If a file URL can't be resolved (refused
   *   by the reachability policy, download failure, unresolvable scheme,
   *   corrupt base64). The service handles it like any other conversion
   *   failure, including invalid-file-message cleanup.
   */
  async prepareFileContent(context: LLMContext): Promise<void> {
    const resolver = this._fileResolver;
    if (resolver === null) {
      return;
    }
    for (const message of context.getMessages()) {
      if (message instanceof LLMSpecificMessage) {
        continue;
      }
      const content = (message as Dict).content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const rawItem of content) {
        if (rawItem === null || typeof rawItem !== "object" || Array.isArray(rawItem)) {
          continue;
        }
        const item = rawItem as Dict;
        try {
          if (item.type === "file_url") {
            const fileData = item.file as Dict;
            const url = fileData.url as string;
            const mimeType = fileData.mime_type as string;
            if (await this._canPassFileUrl(url, mimeType, resolver)) {
              continue;
            }
            if (this.prefersRawFileBytes) {
              await resolver.fetch(url);
            } else {
              await resolver.ensureDataUrl(url, mimeType);
            }
          } else if (item.type === "file_base64" && this.prefersRawFileBytes) {
            await resolver.fetch((item.file as Dict).file_data as string);
          }
        } catch (e) {
          rethrowIfCancelled(e);
          throw new LLMContextConversionError(e);
        }
      }
    }
  }

  /** Whether `url` can be handed to the provider to fetch itself. */
  protected async _canPassFileUrl(
    url: string,
    mimeType: string,
    resolver: FileResolver,
  ): Promise<boolean> {
    if (!this.supportsFileUrl(url, mimeType)) {
      return false;
    }
    const scheme = urlScheme(url);
    if (scheme !== "http" && scheme !== "https") {
      // A cloud-storage URI resolved via the provider's own IAM; reachability
      // from here is irrelevant.
      return true;
    }
    return (await resolver.classify(url)) === UrlReachability.PUBLIC;
  }

  /**
   * Return the content to inline for a `file_url` item, or null when the URL
   * passes through.
   *
   * @param fileData The item's `file` object (`url`, `mime_type`, ...).
   * @returns null when the URL passes through for the provider to fetch
   *   itself; otherwise the resolved content from the `fileResolver`'s caches
   *   — raw bytes when `prefersRawFileBytes`, a base64 data URL otherwise.
   * @throws Error If the provider can't consume the URL and no resolved
   *   content is cached (wrapped as `LLMContextConversionError` by the
   *   conversion routine's caller).
   */
  inlinedFileContent(fileData: Readonly<Dict>): Uint8Array | string | null {
    const resolver = this._fileResolver;
    const url = fileData.url as string;
    const mimeType = fileData.mime_type as string;
    if (this.supportsFileUrl(url, mimeType)) {
      const scheme = urlScheme(url);
      if (scheme !== "http" && scheme !== "https") {
        return null;
      }
      const reachability = resolver !== null ? resolver.cachedReachability(url) : null;
      // Unclassified (no resolver / resolution not run) keeps the
      // conversion-only behavior: hand the URL to the provider.
      if (reachability == null || reachability === UrlReachability.PUBLIC) {
        return null;
      }
    }
    if (resolver !== null) {
      let resolved: Uint8Array | string | null | undefined;
      if (this.prefersRawFileBytes) {
        resolved = resolver.cachedBytes(url);
      } else {
        resolved = resolver.cachedDataUrl(url);
      }
      if (resolved != null) {
        return resolved;
      }
    }
    throw new Error(
      `Unresolved file URL for this provider: '${url}' (await prepareFileContent ` +
        "in getLlmInvocationParams, with a file resolver set)",
    );
  }

  /**
   * Return a `file_base64` item's decoded bytes, from the resolver's cache
   * when prepared.
   *
   * Falls back to decoding inline for conversion-only calls where no
   * resolution has run.
   *
   * @param fileData The item's `file` object (`file_data`, ...).
   */
  decodedFileBytes(fileData: Readonly<Dict>): Uint8Array {
    const dataUrl = fileData.file_data as string;
    if (this._fileResolver !== null) {
      const cached = this._fileResolver.cachedBytes(dataUrl);
      if (cached != null) {
        return cached;
      }
    }
    const comma = dataUrl.indexOf(",");
    if (comma < 0) {
      throw new Error("Invalid data URL: missing ','");
    }
    return base64Decode(dataUrl.slice(comma + 1));
  }

  /**
   * Create an LLM-specific message (as opposed to a standard message) for use
   * in an LLMContext.
   *
   * @param message The message content.
   * @returns A LLMSpecificMessage instance.
   */
  createLlmSpecificMessage(message: unknown): LLMSpecificMessage {
    return new LLMSpecificMessage({ llm: this.idForLlmSpecificMessages, message });
  }

  /**
   * Get messages from the LLM context, including standard and LLM-specific
   * messages.
   *
   * @param context The LLM context containing messages.
   * @param options.truncateLargeValues If true, return deep copies of messages
   *   with large values replaced by short placeholders.
   * @returns List of messages including standard and LLM-specific messages.
   */
  getMessages(
    context: LLMContext,
    options: { truncateLargeValues?: boolean } = {},
  ): LLMContextMessage[] {
    return context.getMessages(this.idForLlmSpecificMessages, {
      truncateLargeValues: options.truncateLargeValues ?? false,
    });
  }

  /**
   * The tools a realtime session carries, in provider format.
   *
   * The context's own tools when it has any, else the init-provided ones.
   * Built-in tools ride along with whichever set is in use, and are the set
   * when there is neither.
   *
   * @param contextTools The context's tools (`NOT_GIVEN` or `null` when it has
   *   none).
   * @param serviceTools The service's init-provided tools, as
   *   `_serviceTools()` returns them: a `ToolsSchema` or a provider-native
   *   tool list, or `null`.
   * @returns The tools, or `null` when there are none at all.
   */
  protected _realtimeSessionTools(contextTools: unknown, serviceTools: unknown): unknown[] | null {
    const own = contextTools != null && isGiven(contextTools) ? contextTools : serviceTools;
    const converted = this.fromStandardTools(own);
    return converted == null || !isGiven(converted) ? null : (converted as unknown[]);
  }

  /**
   * Convert tools from standard format to provider format.
   *
   * Built-in tools are automatically merged into the schema before conversion
   * so that every inference request receives them without the user having to
   * declare them explicitly; when there are no other tools, they are the tool
   * set.
   *
   * @param tools Tools in standard format or provider-specific format.
   * @returns List of tools converted to provider format, or original tools
   *   (possibly `null`) if not in standard format.
   */
  fromStandardTools(tools: unknown): unknown[] | NotGiven | null {
    if (Object.keys(this._builtinTools).length > 0) {
      if (tools instanceof ToolsSchema) {
        tools = new ToolsSchema({
          standardTools: [...tools.standardTools, ...Object.values(this._builtinTools)],
          customTools: tools.customTools,
        });
      } else if (tools == null || !isGiven(tools)) {
        tools = new ToolsSchema({ standardTools: [...Object.values(this._builtinTools)] });
      } else {
        // User supplied tools in a legacy/provider-specific format. Built-in
        // tools cannot be safely merged, so they will not be injected.
        // Migrate to ToolsSchema to enable built-in tool support; use
        // customTools as an escape hatch for any provider-specific tools that
        // don't fit the standard schema.
        // Like Python's `warnings.warn` (default filter), warn once.
        if (!warnedBuiltinToolsNotInjected) {
          warnedBuiltinToolsNotInjected = true;
          logger.warning(
            "Built-in tools (e.g. async tool cancellation) could not be injected " +
              "because the supplied tools are not a ToolsSchema instance. " +
              "Migrate to ToolsSchema to enable built-in tool support. " +
              "Use new ToolsSchema({ customTools: ... }) as an escape hatch for any " +
              "provider-specific tools that don't fit the standard schema.",
          );
        }
        // Fall through and return the original tools unchanged.
      }
    }

    if (tools instanceof ToolsSchema) {
      return this.toProviderToolsFormat(tools);
    }
    // Fallback to return the same tools in case they are not in a standard format
    return (tools ?? null) as unknown[] | NotGiven | null;
  }

  /**
   * Warn once that the initial `"system"` context message is deprecated.
   *
   * The system prompt belongs on the LLM service, where it composes with the
   * instructions the framework contributes — appended instructions,
   * turn-completion guidance, async-tool guidance. A prompt carried in the
   * context bypasses that composition, and providers that take the system
   * instruction as a separate parameter drop it entirely when the service
   * also has one.
   */
  protected _warnContextSystemMessage(): void {
    if (this._warnedContextSystemMessage) {
      return;
    }
    this._warnedContextSystemMessage = true;
    warnDeprecated(
      '`new LLMContext({ messages: [{ role: "system", ... }, ...] })` is deprecated since 1.9.0' +
        " and will be removed in 2.0.0. Use `systemInstruction` on the LLM service" +
        " instead.",
      3,
    );
  }

  /**
   * Extract an initial `"system"` message for use as a system instruction.
   *
   * Only useful for services that expect the system instruction as a separate
   * parameter, not inline in conversation history (today, all non-OpenAI
   * services). Does not extract `"developer"` messages — those are converted
   * to `"user"` by the adapter's subsequent message loop, like any other
   * non-system role the provider doesn't support.
   *
   * Checks `messages[0]`. If the role is `"system"`, removes it and returns
   * its content. If extracting would leave the messages list empty
   * (`messages.length === 1`), the message is converted to `"user"` role
   * instead of being extracted, to prevent sending an empty conversation
   * history to providers that require at least one non-system message.
   *
   * @param messages Message list in standard format. The list is mutated
   *   in-place; the message objects it holds are never mutated, since they are
   *   shared with the source LLMContext.
   * @param options.systemInstruction The system instruction from service
   *   settings or `runInference`. Only used to decide whether to warn about a
   *   conflict in the single-message case.
   * @returns The extracted system message content, or `null` if nothing was
   *   extracted.
   */
  protected _extractInitialSystem(
    messages: Dict[],
    options: { systemInstruction?: string | null } = {},
  ): string | null {
    const systemInstruction = options.systemInstruction ?? null;
    if (messages.length === 0) {
      return null;
    }

    const first = messages[0] as Dict;
    if (first.role !== "system") {
      return null;
    }

    this._warnContextSystemMessage();

    // Would extracting empty the list? Convert to "user" instead.
    if (messages.length === 1) {
      if (systemInstruction) {
        if (!this._warnedSystemInstruction) {
          this._warnedSystemInstruction = true;
          logger.warning(
            "Both system_instruction and an initial system message in" +
              " context are set. Using system_instruction. The context" +
              " system message is being converted to a user message to" +
              " avoid sending an empty conversation history.",
          );
        }
      }
      // Replace rather than mutate: the message objects are shared with the
      // source LLMContext, so an in-place write would rewrite its history.
      messages[0] = { ...first, role: "user" };
      return null;
    }

    // Extract
    let content = first.content ?? "";
    if (Array.isArray(content)) {
      // Join text parts for providers that expect a string system instruction
      content = content
        .filter((part: Dict) => part.type === "text")
        .map((part: Dict) => part.text ?? "")
        .join(" ");
    }
    messages.shift();
    return content as string;
  }

  /**
   * Resolve conflict between `systemInstruction` and an extracted context
   * system message.
   *
   * @param systemFromContext Content extracted from an initial `"system"`
   *   message by `_extractInitialSystem()`, or detected inline (OpenAI
   *   adapters).
   * @param systemInstruction From service settings or `runInference` param.
   * @param options.discardContextSystem If true (non-OpenAI adapters), the
   *   context system message is discarded when `systemInstruction` is also
   *   present. If false (OpenAI adapters), both are kept.
   * @returns The effective system instruction to use, or `null` if the system
   *   instruction is already represented in the messages (OpenAI path).
   */
  protected _resolveSystemInstruction(
    systemFromContext: string | null,
    systemInstruction: string | null,
    options: { discardContextSystem: boolean },
  ): string | null {
    const { discardContextSystem } = options;
    if (systemFromContext && systemInstruction) {
      if (!this._warnedSystemInstruction) {
        this._warnedSystemInstruction = true;
        if (discardContextSystem) {
          // This provider takes the system instruction as a separate
          // parameter, so only one of the two can be sent.
          logger.warning(
            "Both system_instruction and an initial system message in" +
              " context are set. Using system_instruction; the context" +
              " system message is not sent to the model. Move the prompt" +
              " to system_instruction on the LLM service.",
          );
        } else {
          logger.warning(
            "Both system_instruction and an initial system message" +
              " in context are set, which may be unintended. Keeping" +
              " both, but consider using system_instruction for" +
              " system-level instructions and developer messages in" +
              " context for supplementary guidance.",
          );
        }
      }
    }

    if (systemInstruction) {
      return systemInstruction;
    }

    if (systemFromContext) {
      if (discardContextSystem) {
        return systemFromContext;
      }
      // Content is already in messages; nothing to prepend
      return null;
    }

    return null;
  }
}
