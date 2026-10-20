// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/serializers/base_serializer.py

/** Frame serialization interfaces for Pipecat. */

import {
  type Frame,
  OutputTransportMessageFrame,
  OutputTransportMessageUrgentFrame,
} from "../frames/frames.ts";
import type { FrameProcessorSetup } from "../processors/frame_processor.ts";
import * as RTVI from "../processors/frameworks/rtvi/models.ts";
import { BaseObject, type BaseObjectOptions } from "../utils/base_object.ts";

export interface FrameSerializerInputParamsOptions {
  /**
   * Whether to ignore RTVI protocol messages during serialization. Defaults
   * to true to prevent RTVI messages from being sent to external transports.
   */
  ignoreRtviMessages?: boolean;
  /**
   * Seconds of inactivity after which the stream resampler clears its
   * internal history to avoid audio artefacts from stale state. Set to `null`
   * to never clear — recommended for telephony providers (e.g. Genesys) that
   * have irregular gaps between audio chunks. Defaults to `0.2`.
   */
  resamplerClearAfterSecs?: number | null;
}

/**
 * Base configuration parameters for FrameSerializer.
 *
 * - `ignoreRtviMessages`: whether to ignore RTVI protocol messages during
 *   serialization. Defaults to true to prevent RTVI messages from being sent
 *   to external transports.
 * - `resamplerClearAfterSecs`: seconds of inactivity after which the stream
 *   resampler clears its internal history to avoid audio artefacts from stale
 *   state. Set to `null` to never clear — recommended for telephony providers
 *   (e.g. Genesys) that have irregular gaps between audio chunks. Defaults to
 *   `0.2`.
 */
export class FrameSerializerInputParams {
  ignoreRtviMessages: boolean;
  resamplerClearAfterSecs: number | null;

  constructor(options: FrameSerializerInputParamsOptions = {}) {
    this.ignoreRtviMessages = options.ignoreRtviMessages ?? true;
    this.resamplerClearAfterSecs =
      options.resamplerClearAfterSecs === undefined ? 0.2 : options.resamplerClearAfterSecs;
  }
}

export interface FrameSerializerOptions extends BaseObjectOptions {
  /** Configuration parameters. */
  params?: FrameSerializerInputParams | null;
}

/** Serialized frame data: a string or bytes. */
export type SerializedData = string | Uint8Array;

/**
 * Abstract base class for frame serialization implementations.
 *
 * Defines the interface for converting frames to/from serialized formats
 * for transmission or storage. Subclasses must implement the core
 * serialize/deserialize methods.
 */
export abstract class FrameSerializer extends BaseObject {
  /** Upstream's nested `FrameSerializer.InputParams`. */
  static InputParams = FrameSerializerInputParams;

  protected _params: FrameSerializerInputParams;

  /**
   * Initialize the FrameSerializer.
   *
   * @param options.params Configuration parameters. Other options (e.g.
   *   `name`) are passed to BaseObject.
   */
  constructor(options: FrameSerializerOptions = {}) {
    super(options);
    this._params = options.params || new FrameSerializerInputParams();
  }

  /**
   * Check if a frame should be ignored during serialization.
   *
   * This method filters out RTVI protocol messages when `ignoreRtviMessages`
   * is enabled. Subclasses can override this to add additional filtering
   * logic.
   *
   * @param frame The frame to check.
   * @returns True if the frame should be ignored, false otherwise.
   */
  shouldIgnoreFrame(frame: Frame): boolean {
    if (
      this._params.ignoreRtviMessages &&
      (frame instanceof OutputTransportMessageFrame ||
        frame instanceof OutputTransportMessageUrgentFrame) &&
      typeof frame.message === "object" &&
      frame.message !== null &&
      (frame.message as Record<string, unknown>).label === RTVI.MESSAGE_LABEL
    ) {
      return true;
    }
    return false;
  }

  /**
   * Initialize the serializer with pipeline configuration.
   *
   * @param setup Configuration object containing setup parameters.
   */
  // Typed `unknown` to keep BaseObject.setup's signature; callers pass a
  // FrameProcessorSetup, as upstream does.
  override async setup(_setup: FrameProcessorSetup | unknown): Promise<void> {}

  /**
   * Convert a frame to its serialized representation.
   *
   * @param frame The frame to serialize.
   * @returns Serialized frame data as string or bytes, or null when there is
   *   nothing to send for this frame: it isn't handled, or the serializer is
   *   buffering it and will emit it on a later call.
   */
  abstract serialize(frame: Frame): Promise<SerializedData | null>;

  /**
   * Convert serialized data back to a frame object.
   *
   * @param data Serialized frame data as string or bytes.
   * @returns Reconstructed Frame object, or null if deserialization fails.
   */
  abstract deserialize(data: SerializedData): Promise<Frame | null>;
}
