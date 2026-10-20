// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/google/frames.py

/**
 * Google AI service frames for search and grounding functionality.
 *
 * This module defines specialized frame types for handling search results and
 * grounding metadata from Google AI models, particularly for Gemini models
 * that support web search and fact grounding capabilities.
 */

import { DataFrame } from "@pipedog/core/frames/frames";

/** Python `repr()` of a value inside a dataclass repr. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  return String(value);
}

export interface LLMSearchResultOptions {
  /** The search result text content. */
  text: string;
  /** List of confidence scores associated with the result. */
  confidence?: number[];
}

/**
 * Represents a single search result with confidence scores.
 *
 * - `text`: the search result text content.
 * - `confidence`: list of confidence scores associated with the result.
 */
export class LLMSearchResult {
  text: string;
  confidence: number[];

  constructor(options: LLMSearchResultOptions) {
    this.text = options.text;
    this.confidence = options.confidence ?? [];
  }

  toString(): string {
    return `LLMSearchResult(text=${pyRepr(this.text)}, confidence=${pyRepr(this.confidence)})`;
  }
}

export interface LLMSearchOriginOptions {
  /** URI of the source website. */
  siteUri?: string | null;
  /** Title of the source website. */
  siteTitle?: string | null;
  /** List of search results from this origin. */
  results?: LLMSearchResult[];
}

/**
 * Represents the origin source of search results.
 *
 * - `siteUri`: URI of the source website.
 * - `siteTitle`: title of the source website.
 * - `results`: list of search results from this origin.
 */
export class LLMSearchOrigin {
  siteUri: string | null;
  siteTitle: string | null;
  results: LLMSearchResult[];

  constructor(options: LLMSearchOriginOptions = {}) {
    this.siteUri = options.siteUri ?? null;
    this.siteTitle = options.siteTitle ?? null;
    this.results = options.results ?? [];
  }

  toString(): string {
    return (
      `LLMSearchOrigin(site_uri=${pyRepr(this.siteUri)}, site_title=${pyRepr(this.siteTitle)}, ` +
      `results=${pyRepr(this.results)})`
    );
  }
}

export interface LLMSearchResponseFrameOptions {
  /** The main search result text. */
  searchResult?: string | null;
  /** Rendered content from the search entry point. */
  renderedContent?: string | null;
  /** List of search result origins with detailed information. */
  origins?: LLMSearchOrigin[];
}

/**
 * Frame containing search results and grounding information from Google AI models.
 *
 * This frame is used to convey search results and grounding metadata from
 * Google AI models that support web search capabilities. It includes the
 * search result text, rendered content, and detailed origin information with
 * confidence scores.
 *
 * - `searchResult`: the main search result text.
 * - `renderedContent`: rendered content from the search entry point.
 * - `origins`: list of search result origins with detailed information.
 */
export class LLMSearchResponseFrame extends DataFrame {
  searchResult: string | null;
  renderedContent: string | null;
  origins: LLMSearchOrigin[];

  constructor(options: LLMSearchResponseFrameOptions = {}) {
    super(options);
    this.searchResult = options.searchResult ?? null;
    this.renderedContent = options.renderedContent ?? null;
    this.origins = options.origins ?? [];
  }

  /**
   * Return string representation of the search response frame.
   *
   * @returns String representation showing search result and origins.
   */
  override toString(): string {
    return `LLMSearchResponseFrame(search_result=${this.searchResult ?? "None"}, origins=${pyRepr(this.origins)})`;
  }
}
