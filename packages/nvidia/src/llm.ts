// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/nvidia/llm.py

/**
 * NVIDIA NIM API service implementation.
 *
 * This module provides a service for interacting with NVIDIA's NIM (NVIDIA
 * Inference Microservice) API while maintaining compatibility with the
 * OpenAI-style interface.
 *
 * Refer to the NVIDIA NIM LLM API documentation for available models and usage:
 * https://docs.api.nvidia.com/nim/reference/llm-apis
 *
 * Porting notes:
 * - The deprecated `model` constructor option is not ported (use `settings`).
 * - Upstream closes the inner OpenAI stream with its `close()` method. The JS
 *   SDK's stream has no such method; it is released by aborting its
 *   `controller`, which `_closeInnerStream()` does when there is no `close()`.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import {
  LLMThoughtEndFrame,
  LLMThoughtStartFrame,
  LLMThoughtTextFrame,
} from "@pipedog/core/frames/frames";
import type { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { logger } from "@pipedog/core/utils/logger";
import {
  type TaggedLLMTextParsedOutputChunk,
  TaggedLLMTextParsedOutputChunkKind,
  TaggedLLMTextParser,
} from "@pipedog/core/utils/text/tagged_llm_text_parser";
import {
  type ChatCompletionChunk,
  type ChatCompletionStream,
  OpenAILLMSettings,
} from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";

/** Settings for NvidiaLLMService. */
export class NvidiaLLMSettings extends OpenAILLMSettings {}

export interface NvidiaLLMServiceOptions extends OpenAILLMServiceOptions {
  /**
   * NVIDIA API key for authentication. Required when using the cloud
   * endpoint. Not needed for local NIM deployments.
   */
  apiKey?: string | null;
  /**
   * The base URL for NIM API. Defaults to NVIDIA's cloud endpoint. For local
   * deployments, pass the local address (e.g. `http://localhost:8000/v1`).
   */
  baseUrl?: string | null;
  /** Runtime-updatable settings. */
  settings?: NvidiaLLMSettings | null;
}

/**
 * A service for interacting with NVIDIA's NIM (NVIDIA Inference Microservice) API.
 *
 * This service extends OpenAILLMService to work with NVIDIA's NIM API while
 * maintaining compatibility with the OpenAI-style interface. It handles:
 *
 * - Detection and filtering of leading `<think>`/`</think>` content for
 *   models that emit reasoning inline before visible output (e.g.
 *   DeepSeek-R1, some nemotron models)
 * - Extraction of `reasoning_content` from the streaming delta for models
 *   with API-level reasoning separation (e.g. Nemotron Nano models)
 *
 * Reasoning content is emitted as `LLMThought*Frame` objects, keeping it
 * accessible to observers and logging without sending it to TTS.
 */
export class NvidiaLLMService extends OpenAILLMService {
  static override Settings: typeof NvidiaLLMSettings = NvidiaLLMSettings;
  declare protected _settings: NvidiaLLMSettings;

  protected _thinkParser: TaggedLLMTextParser = new TaggedLLMTextParser("<think>", "</think>");
  protected _hasReasoningField = false;

  /**
   * Initialize the NvidiaLLMService.
   *
   * @param options.apiKey NVIDIA API key for authentication. Required when
   *   using the cloud endpoint. Not needed for local NIM deployments.
   * @param options.baseUrl The base URL for NIM API. Defaults to NVIDIA's cloud
   *   endpoint. For local deployments, pass the local address (e.g.
   *   `http://localhost:8000/v1`).
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "nvidia/nemotron-3.5-super-vl-120b-a12b").
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: NvidiaLLMServiceOptions = {}) {
    const cls = new.target as typeof NvidiaLLMService;
    const baseUrl = options.baseUrl ?? "https://integrate.api.nvidia.com/v1";

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({ model: "nvidia/nemotron-3.5-super-vl-120b-a12b" });

    // 2. (No step 2, the deprecated direct init args are not ported)
    // 3. (No step 3, as there's no params object to apply)

    // 4. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    // Local NIM takes no key, but the OpenAI client needs one: given None it
    // would fall back to OPENAI_API_KEY and send it to NVIDIA.
    super({
      ...options,
      apiKey: options.apiKey || "not-needed",
      baseUrl,
      settings: defaultSettings,
    });

    if (baseUrl.includes("api.nvidia.com") && !options.apiKey) {
      logger.warning(
        "NvidiaLLMService: Using the cloud endpoint but no API key was provided. " +
          "An API key is required for the cloud endpoint. " +
          "Set base_url to your local NIM endpoint for local deployments.",
      );
    }
  }

  /**
   * Reset per-response state at the start of each LLM call.
   *
   * Resets leading-think-tag detection state and reasoning-content field
   * tracking.
   */
  protected _resetResponseState(): void {
    this._thinkParser = new TaggedLLMTextParser("<think>", "</think>");

    // reasoning_content field tracking
    this._hasReasoningField = false;
  }

  /**
   * Filter leading `<think>` tags from content and emit thought frames.
   *
   * Returns only visible content to the base OpenAI processing loop while
   * emitting a leading `<think>` block as `LLMThought*Frame` side effects.
   * Responses without one pass through from the first chunk that rules it
   * out.
   *
   * @param text The text content from the LLM to filter.
   * @returns The non-reasoning content that should continue through the base
   *   OpenAI content path, or `null` if this chunk should not emit normal
   *   content.
   */
  protected async _filterThinkingContent(text: string): Promise<string | null> {
    let visible = "";
    for (const chunk of this._thinkParser.parseNextChunk(text)) {
      if (chunk.kind === TaggedLLMTextParsedOutputChunkKind.TEXT) {
        visible += chunk.text;
      } else {
        await this._pushThoughtChunk(chunk);
      }
    }
    return visible || null;
  }

  /**
   * Finalize buffered reasoning state at stream end.
   *
   * @param options.flushBufferedText Whether to forward buffered text that was
   *   held while deciding whether the stream started with `<think>`. This
   *   should be `true` on normal completion and `false` when the stream ends
   *   early due to interruption or cancellation.
   */
  protected async _finalizeReasoningState(options: { flushBufferedText: boolean }): Promise<void> {
    const chunks = options.flushBufferedText
      ? this._thinkParser.flush()
      : this._thinkParser.reset();
    for (const chunk of chunks) {
      if (chunk.kind === TaggedLLMTextParsedOutputChunkKind.TEXT) {
        await super._pushLlmText(chunk.text);
      } else {
        await this._pushThoughtChunk(chunk);
      }
    }

    if (this._hasReasoningField) {
      await this.pushFrame(new LLMThoughtEndFrame());
      this._hasReasoningField = false;
    }
  }

  /** Push a piece of a `<think>` block as a thought frame. */
  protected async _pushThoughtChunk(chunk: TaggedLLMTextParsedOutputChunk): Promise<void> {
    if (chunk.kind === TaggedLLMTextParsedOutputChunkKind.THOUGHT_START) {
      await this.stopTtfbMetrics();
      await this.pushFrame(new LLMThoughtStartFrame());
    } else if (chunk.kind === TaggedLLMTextParsedOutputChunkKind.THOUGHT_TEXT) {
      await this.pushFrame(new LLMThoughtTextFrame({ text: chunk.text }));
    } else if (chunk.kind === TaggedLLMTextParsedOutputChunkKind.THOUGHT_END) {
      await this.pushFrame(new LLMThoughtEndFrame());
    }
  }

  /**
   * Wrap the chat completion stream to handle `reasoning_content`.
   *
   * Models with API-level reasoning separation (e.g. Nemotron Nano) include a
   * `reasoning_content` field on the streaming delta. This wrapper extracts
   * those chunks and emits them as `LLMThought*Frame` objects. It also
   * rewrites streamed `delta.content` so leading `<think>` sections are
   * removed before the base OpenAI loop processes visible content.
   *
   * @param context The LLM context for the completion request.
   * @returns An async iterator of chat completion chunks where
   *   `reasoning_content` has been emitted as `LLMThought*Frame` side effects.
   */
  override async getChatCompletions(context: LLMContext): Promise<ChatCompletionStream> {
    const stream = await super.getChatCompletions(context);
    return this._handleReasoningContent(stream);
  }

  /**
   * Handle `reasoning_content` and leading `<think>` tags in a chunk stream.
   *
   * Inspects each chunk for a `reasoning_content` field on the delta and
   * emits `LLMThoughtStartFrame` / `LLMThoughtTextFrame` /
   * `LLMThoughtEndFrame` as side effects. It also strips `<think>` blocks from
   * `delta.content` before yielding the chunk so the base OpenAI loop only
   * sees user-facing content. Every chunk is still yielded so the base
   * streaming loop can process metadata such as token usage, model name, tool
   * calls, and audio transcripts.
   *
   * Notes: `BaseOpenAILLMService._processContext()` closes the wrapper
   * iterator returned from `getChatCompletions()`, but it does not close the
   * inner OpenAI stream directly. This wrapper closes that inner stream in a
   * `finally` block so it is released promptly, including if the response is
   * cancelled very early, for example due to an interruption right after the
   * request starts.
   *
   * @param stream The original chat completion stream.
   * @returns Chat completion chunks with any leading `<think>` content removed
   *   from `delta.content` before they reach the base OpenAI loop.
   */
  protected async *_handleReasoningContent(
    stream: ChatCompletionStream,
  ): AsyncGenerator<ChatCompletionChunk> {
    let completed = false;
    try {
      for await (const chunk of stream) {
        if (chunk.choices && chunk.choices.length > 0 && chunk.choices[0]!.delta) {
          const delta = chunk.choices[0]!.delta as ChatCompletionChunk["choices"][number]["delta"] &
            Record<string, unknown>;
          const rc = (delta.reasoning_content || delta.reasoning || null) as string | null;
          if (rc) {
            if (!this._hasReasoningField) {
              await this.stopTtfbMetrics();
              this._hasReasoningField = true;
              await this.pushFrame(new LLMThoughtStartFrame());
            }
            await this.pushFrame(new LLMThoughtTextFrame({ text: rc }));
          } else if (this._hasReasoningField && delta.content) {
            await this.pushFrame(new LLMThoughtEndFrame());
            this._hasReasoningField = false;
          }

          if (delta.content) {
            delta.content = await this._filterThinkingContent(delta.content);
          }
        }
        yield chunk;
      }
      completed = true;
    } finally {
      try {
        await this._finalizeReasoningState({ flushBufferedText: completed });
      } finally {
        await this._closeInnerStream(stream);
      }
    }
  }

  /**
   * Eagerly close the underlying OpenAI streaming response.
   *
   * The OpenAI Python SDK exposes `close()` on this stream object; the JS SDK
   * releases it through its `controller`. Closing here complements the base
   * OpenAI cleanup path and keeps teardown local to this adapter, including
   * early interruption or cancellation cases.
   */
  protected async _closeInnerStream(stream: ChatCompletionStream): Promise<void> {
    const close = (stream as { close?: () => unknown }).close;
    try {
      if (typeof close === "function") {
        const result = close.call(stream);
        if (result !== null && typeof (result as PromiseLike<unknown>)?.then === "function") {
          await result;
        }
        return;
      }
      if (stream.controller === undefined) {
        return;
      }
      stream.controller.abort();
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error("NvidiaLLMService: error while closing underlying chat completion stream", e);
    }
  }

  /**
   * Process a context through the LLM.
   *
   * Delegates to the base OpenAI streaming loop, resetting the per-response
   * state it needs to emit `LLMThought*Frame` objects for `reasoning_content`
   * and leading `<think>` content, which the `getChatCompletions` stream
   * wrapper intercepts.
   *
   * @param context The context to process, containing messages and other
   *   information needed for the LLM interaction.
   */
  protected override async _processContext(context: LLMContext): Promise<void> {
    this._resetResponseState();
    await super._processContext(context);
  }
}
