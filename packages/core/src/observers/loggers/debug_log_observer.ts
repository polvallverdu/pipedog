// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/observers/loggers/debug_log_observer.py

/**
 * Debug logging observer for frame activity monitoring.
 *
 * This module provides a debug observer that logs detailed frame activity to
 * the console, making it useful for debugging pipeline behavior and
 * understanding frame flow between processors.
 */

import type { Frame } from "../../frames/frames.ts";
import { FrameDirection } from "../../processors/frame_processor.ts";
import { logger } from "../../utils/logger.ts";
import { BaseObserver, type BaseObserverOptions, type FramePushed } from "../base_observer.ts";

/**
 * Specifies which endpoint (source or destination) to filter on.
 *
 * - SOURCE: filter on the source component that is pushing the frame.
 * - DESTINATION: filter on the destination component receiving the frame.
 */
export const FrameEndpoint = {
  SOURCE: 1,
  DESTINATION: 2,
} as const;
export type FrameEndpoint = (typeof FrameEndpoint)[keyof typeof FrameEndpoint];

type AnyClass = abstract new (...args: any[]) => unknown;

export type FrameType = abstract new (...args: any[]) => Frame;

/** A filter configuration: null logs every instance, or `[serviceType, endpoint]`. */
export type FrameFilterConfig = readonly [AnyClass, FrameEndpoint] | null;

export interface DebugLogObserverOptions extends BaseObserverOptions {
  /**
   * Frame types to log. Can be:
   *
   * - An array of frame types to log all instances
   * - A Map from frame types to filter configurations
   * - null to log all frames
   *
   * Filter configurations can be null (log all instances) or a tuple of
   * `[serviceType, endpoint]` to filter on specific services.
   */
  frameTypes?: readonly FrameType[] | ReadonlyMap<FrameType, FrameFilterConfig> | null;
  /**
   * Field names to exclude from logging. Defaults to excluding binary data
   * fields like 'audio', 'image', 'images'.
   */
  excludeFields?: ReadonlySet<string> | null;
}

/**
 * Observer that logs frame activity with detailed content to the console.
 *
 * Automatically extracts and formats data from any frame type, making it
 * useful for debugging pipeline behavior without needing frame-specific
 * observers.
 *
 * @example
 * // Log all frames from all services
 * const observers = [new DebugLogObserver()];
 *
 * // Log specific frame types from any source/destination
 * const observers = [new DebugLogObserver({ frameTypes: [LLMTextFrame, TranscriptionFrame] })];
 *
 * // Log frames with specific source/destination filters
 * const observers = [
 *   new DebugLogObserver({
 *     frameTypes: new Map([
 *       // Only log InterruptionFrame when source is BaseOutputTransport
 *       [InterruptionFrame, [BaseOutputTransport, FrameEndpoint.SOURCE]],
 *       // Only log UserStartedSpeakingFrame when destination is STTService
 *       [UserStartedSpeakingFrame, [STTService, FrameEndpoint.DESTINATION]],
 *       // Log LLMTextFrame regardless of source or destination type
 *       [LLMTextFrame, null],
 *     ]),
 *   }),
 * ];
 */
export class DebugLogObserver extends BaseObserver {
  frameFilters: Map<FrameType, FrameFilterConfig> = new Map();
  excludeFields: ReadonlySet<string>;

  /** Initialize the debug log observer. */
  constructor(options: DebugLogObserverOptions = {}) {
    super(options);

    // Process frame filters
    const frameTypes = options.frameTypes ?? null;
    if (frameTypes !== null) {
      if (Array.isArray(frameTypes)) {
        // Array of frame types - log all instances
        this.frameFilters = new Map(
          (frameTypes as readonly FrameType[]).map((frameType) => [frameType, null]),
        );
      } else {
        // Map of frame types with filters
        this.frameFilters = new Map(frameTypes as ReadonlyMap<FrameType, FrameFilterConfig>);
      }
    }

    // By default, exclude binary data fields that would clutter logs
    this.excludeFields =
      options.excludeFields ??
      new Set([
        "audio", // Skip binary audio data
        "image", // Skip binary image data
        "images", // Skip lists of images
      ]);
  }

  /** Format a value for logging. */
  protected _formatValue(value: unknown): string {
    if (value === null || value === undefined) {
      return "None";
    } else if (typeof value === "string") {
      return reprStr(value);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        return "[]";
      }
      if (isPlainObject(value[0]) && value.length > 3) {
        // For message lists, just show count
        return `${value.length} items`;
      }
      return formatList(value);
    } else if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      return `${value.byteLength} bytes`;
    } else if (
      typeof value === "object" &&
      typeof (value as { getMessagesForLogging?: unknown }).getMessagesForLogging === "function"
    ) {
      // Special case for OpenAI context
      const messages = (value as { getMessagesForLogging: () => unknown }).getMessagesForLogging();
      return `${value.constructor.name} with messages: ${formatAny(messages)}`;
    } else {
      return formatAny(value);
    }
  }

  /** Determine if a frame should be logged based on filters. */
  protected _shouldLogFrame(frame: Frame, src: unknown, dst: unknown): boolean {
    // If no filters, log all frames
    if (this.frameFilters.size === 0) {
      return true;
    }

    // Check if this frame type is in our filters
    for (const [frameType, filterConfig] of this.frameFilters) {
      if (frame instanceof frameType) {
        // If filter is null, log all instances of this frame type
        if (filterConfig === null) {
          return true;
        }

        // Otherwise, check the specific filter
        const [serviceType, endpoint] = filterConfig;

        if (endpoint === FrameEndpoint.SOURCE) {
          return src instanceof serviceType;
        } else if (endpoint === FrameEndpoint.DESTINATION) {
          return dst instanceof serviceType;
        }
      }
    }

    return false;
  }

  /**
   * Process a frame being pushed into the pipeline.
   *
   * Logs frame details to the console with all relevant fields and values.
   *
   * @param data Event data containing the frame, source, destination,
   *   direction, and timestamp.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    const src = data.source;
    const dst = data.destination;
    const frame = data.frame;
    const direction = data.direction;
    const timestamp = data.timestamp;

    // Check if we should log this frame
    if (!this._shouldLogFrame(frame, src, dst)) {
      return;
    }

    // Format direction arrow
    const arrow = direction === FrameDirection.DOWNSTREAM ? "→" : "←";

    const timeSec = (timestamp / 1_000_000_000).toFixed(2);
    const className = frame.constructor.name;

    // Build frame representation
    const frameDetails: string[] = [];

    // Extract the frame's fields (its own enumerable properties, the
    // equivalent of a dataclass's fields).
    for (const [fieldName, value] of Object.entries(frame)) {
      if (this.excludeFields.has(fieldName)) {
        continue;
      }

      if (value === null || value === undefined) {
        continue;
      }

      const formattedValue = this._formatValue(value);
      frameDetails.push(`${fieldName}: ${formattedValue}`);
    }

    // Format the message
    let message: string;
    if (frameDetails.length > 0) {
      const details = frameDetails.join(", ");
      message = `${className} ${details} at ${timeSec}s`;
    } else {
      message = `${className} at ${timeSec}s`;
    }

    // Log the message
    logger.debug(`${src} ${arrow} ${dst}: ${message}`);
  }
}

/** Python's `repr()` of a string: single-quoted unless it holds only single quotes. */
function reprStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch < " " || ch === "\x7f")
      out += `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `${quote}${out}${quote}`;
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Roughly Python's `str()`: plain data as JSON, objects through `toString()`. */
function formatAny(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return formatList(value);
  if (isPlainObject(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatList(values: readonly unknown[]): string {
  return `[${values.map((v) => (typeof v === "string" ? reprStr(v) : formatAny(v))).join(", ")}]`;
}
