// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/google/rtvi.py

/**
 * Google RTVI processor and observer implementation.
 *
 * This module provides integration with Google's services through the RTVI
 * framework, including models for search responses and an observer for
 * handling Google-specific frame types.
 *
 * Porting notes:
 * - The upstream pydantic models are small classes with camelCase fields
 *   whose `modelDump()` writes upstream's snake_case wire keys
 *   (`search_result`, `rendered_content`, `origins[].site_uri`, ...), so the
 *   `bot-llm-search-response` message is unchanged on the wire.
 */

import type { FramePushed } from "@pipedog/core/observers/base_observer";
import {
  RTVIObserver,
  type RTVIObserverOptions,
} from "@pipedog/core/processors/frameworks/rtvi/observer";
import { RTVIProcessor } from "@pipedog/core/processors/frameworks/rtvi/processor";
import { LLMSearchOrigin, LLMSearchResponseFrame, LLMSearchResult } from "./frames.ts";

/** Dump options, as `RTVIObserver.sendRtviMessage()` passes them. */
interface DumpOptions {
  excludeNone?: boolean;
}

function dropNone(obj: Record<string, unknown>, options: DumpOptions): Record<string, unknown> {
  if (!options.excludeNone) return obj;
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
}

function dumpResult(result: LLMSearchResult | Record<string, unknown>): Record<string, unknown> {
  if (result instanceof LLMSearchResult) {
    return { text: result.text, confidence: [...result.confidence] };
  }
  return { ...result };
}

function dumpOrigin(
  origin: LLMSearchOrigin | Record<string, unknown>,
  options: DumpOptions,
): Record<string, unknown> {
  if (origin instanceof LLMSearchOrigin) {
    return dropNone(
      {
        site_uri: origin.siteUri,
        site_title: origin.siteTitle,
        results: origin.results.map((r) => dumpResult(r)),
      },
      options,
    );
  }
  return dropNone({ ...origin }, options);
}

export interface RTVISearchResponseMessageDataOptions {
  /** The search result text, if available. */
  searchResult: string | null;
  /** The rendered content from the search, if available. */
  renderedContent: string | null;
  /** List of search result origins with metadata. */
  origins: LLMSearchOrigin[];
}

/**
 * Data payload for search response messages in RTVI protocol.
 *
 * - `searchResult`: the search result text, if available.
 * - `renderedContent`: the rendered content from the search, if available.
 * - `origins`: list of search result origins with metadata.
 */
export class RTVISearchResponseMessageData {
  searchResult: string | null;
  renderedContent: string | null;
  origins: LLMSearchOrigin[];

  constructor(options: RTVISearchResponseMessageDataOptions) {
    this.searchResult = options.searchResult;
    this.renderedContent = options.renderedContent;
    this.origins = options.origins;
  }

  /** The wire form, with upstream's snake_case keys (pydantic `model_dump`). */
  modelDump(options: DumpOptions = {}): Record<string, unknown> {
    return dropNone(
      {
        search_result: this.searchResult,
        rendered_content: this.renderedContent,
        origins: this.origins.map((o) => dumpOrigin(o, options)),
      },
      options,
    );
  }

  toJSON(): Record<string, unknown> {
    return this.modelDump();
  }
}

export interface RTVIBotLLMSearchResponseMessageOptions {
  /** The search response data payload. */
  data: RTVISearchResponseMessageData;
}

/**
 * RTVI message for bot LLM search responses.
 *
 * - `label`: always "rtvi-ai" for RTVI protocol messages.
 * - `type`: always "bot-llm-search-response" for this message type.
 * - `data`: the search response data payload.
 */
export class RTVIBotLLMSearchResponseMessage {
  readonly label = "rtvi-ai" as const;
  readonly type = "bot-llm-search-response" as const;
  data: RTVISearchResponseMessageData;

  constructor(options: RTVIBotLLMSearchResponseMessageOptions) {
    this.data = options.data;
  }

  /** The wire form, with upstream's snake_case keys (pydantic `model_dump`). */
  modelDump(options: DumpOptions = {}): Record<string, unknown> {
    return { label: this.label, type: this.type, data: this.data.modelDump(options) };
  }

  toJSON(): Record<string, unknown> {
    return this.modelDump();
  }
}

/**
 * RTVI observer for Google service integration.
 *
 * Extends the base RTVIObserver to handle Google-specific frame types,
 * particularly LLM search response frames from Google services.
 */
export class GoogleRTVIObserver extends RTVIObserver {
  /**
   * Initialize the Google RTVI observer.
   *
   * @param rtvi The RTVI processor to send messages through.
   */
  constructor(rtvi: RTVIProcessor) {
    super(rtvi);
  }

  /**
   * Process frames being pushed through the pipeline.
   *
   * Handles Google-specific frames in addition to the base RTVI frame types.
   *
   * @param data Frame push event data containing frame and metadata.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    await super.onPushFrame(data);

    const frame = data.frame;

    if (frame instanceof LLMSearchResponseFrame) {
      await this._handleLlmSearchResponseFrame(frame);
    }
  }

  protected async _handleLlmSearchResponseFrame(frame: LLMSearchResponseFrame): Promise<void> {
    const message = new RTVIBotLLMSearchResponseMessage({
      data: new RTVISearchResponseMessageData({
        searchResult: frame.searchResult,
        origins: frame.origins,
        renderedContent: frame.renderedContent,
      }),
    });
    await this.sendRtviMessage(message);
  }
}

/**
 * RTVI processor for Google service integration.
 *
 * Creates a specific Google RTVI Observer.
 */
export class GoogleRTVIProcessor extends RTVIProcessor {
  /**
   * Creates a new RTVI Observer.
   *
   * @param _options Settings to enable/disable specific messages and
   *   additional observer options. Ignored, as upstream does.
   * @returns A new RTVI observer.
   */
  override createRtviObserver(_options: RTVIObserverOptions = {}): RTVIObserver {
    return new GoogleRTVIObserver(this);
  }
}
