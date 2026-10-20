// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/frames/frames.py

/**
 * Core frame definitions for the Pipecat framework.
 *
 * Contains all frame types used throughout the pipeline system, including
 * data frames, system frames, and control frames for audio, video, text, and
 * LLM processing.
 *
 * Porting notes (see docs/CONVENTIONS.md, "Frames"):
 * - Python dataclass fields become class fields; `init=True` fields are read
 *   from the constructor's options object (`new TextFrame({ text: "hi" })`),
 *   `init=False` fields are plain field initializers.
 * - `__post_init__` overrides become field initializers or constructor code
 *   in the subclass (they run base-first, like the `super().__post_init__()` chain).
 * - Non-Frame dataclass mixins (AudioRawFrame, ImageRawFrame, ...) use
 *   `defineMixin`; a second concrete Frame base uses `addVirtualBase`.
 * - `__str__` becomes `toString()`.
 */

import { type Ctor, defineMixin } from "../utils/mixin.ts";
import { nanosecondsToStr } from "../utils/time.ts";
import { objCount, objId } from "../utils/utils.ts";

/** Format a presentation timestamp (nanoseconds) to a human-readable string. */
export function formatPts(pts: number | null | undefined): string | null {
  return pts ? nanosecondsToStr(pts) : null;
}

/**
 * Base frame class for all frames in the Pipecat pipeline.
 *
 * All frames automatically receive unique identifiers, names, and metadata.
 *
 * - `id`: unique identifier for the frame instance.
 * - `name`: class name and instance count.
 * - `pts`: presentation timestamp in nanoseconds.
 * - `broadcastSiblingId`: id of the paired frame when broadcast in both
 *   directions; set by `broadcastFrame()` / `broadcastFrameInstance()`.
 * - `metadata`: arbitrary frame metadata.
 * - `transportSource` / `transportDestination`: transport routing names.
 * - `interruptible`: whether an interruption may drop this frame from a
 *   processor's queue or cancel its processing. Subclasses that are
 *   uninterruptible by default declare `override interruptible = false`.
 */
export class Frame {
  id: number = objId();
  name: string = `${this.constructor.name}#${objCount(this)}`;
  pts: number | null = null;
  broadcastSiblingId: number | null = null;
  metadata: Record<string, unknown> = {};
  transportSource: string | null = null;
  transportDestination: string | null = null;
  interruptible = true;

  // Options are accepted (and ignored) so every frame constructor has the
  // same shape, which mixins and `broadcastFrame(FrameClass, options)` rely on.
  constructor(_options?: object) {}

  toString(): string {
    return this.name;
  }
}

/** Give a copied frame a fresh `id` and `name`, as dataclass re-construction does. */
export function renewFrameIdentity(frame: Frame): void {
  frame.id = objId();
  frame.name = `${frame.constructor.name}#${objCount(frame)}`;
}

/**
 * System frame class for immediate processing.
 *
 * Takes higher priority than other frames. System frames are handled in order
 * and are not affected by user interruptions.
 */
export class SystemFrame extends Frame {}

/**
 * Data frame class for processing data in order.
 *
 * Processed in order; usually contains data such as LLM context, text, audio
 * or images. Data frames are cancelled by user interruptions.
 */
export class DataFrame extends Frame {}

/**
 * Control frame class for processing control information in order.
 *
 * Like data frames, processed in order; usually contains control information
 * such as settings updates or ending the pipeline after everything is flushed.
 * Cancelled by user interruptions.
 */
export class ControlFrame extends Frame {}

//
// Mixins
//

/** Fields of a chunk of raw audio. */
export interface AudioRawFrameOptions {
  /** Raw audio bytes in PCM format (16-bit little endian). */
  audio: Uint8Array;
  /** Audio sample rate in Hz. */
  sampleRate: number;
  /** Number of audio channels. */
  numChannels: number;
}

/** A frame containing a chunk of raw audio. `numFrames` is computed. */
export interface AudioRawFrame extends AudioRawFrameOptions {
  numFrames: number;
}

export const AudioRawFrame = defineMixin<
  AudioRawFrame,
  <B extends Ctor>(base: B) => B & Ctor<AudioRawFrame>
>("AudioRawFrame", <B extends Ctor>(Base: B) => {
  abstract class AudioRawFrameMixin extends Base implements AudioRawFrame {
    audio: Uint8Array;
    sampleRate: number;
    numChannels: number;
    numFrames = 0;

    // biome-ignore lint/suspicious/noExplicitAny: mixin constructor.
    constructor(...args: any[]) {
      super(...args);
      const options = args[0] as AudioRawFrameOptions;
      this.audio = options.audio;
      this.sampleRate = options.sampleRate;
      this.numChannels = options.numChannels;
      this.numFrames = Math.trunc(this.audio.length / (this.numChannels * 2));
    }
  }
  return AudioRawFrameMixin;
});

/** Fields of a raw image. */
export interface ImageRawFrameOptions {
  /** Raw image bytes. */
  image: Uint8Array;
  /** Image dimensions as [width, height]. */
  size: [number, number];
  /** Image format (e.g. 'RGB', 'RGBA'). */
  format: string | null;
}

/** A frame containing a raw image. */
export interface ImageRawFrame extends ImageRawFrameOptions {}

export const ImageRawFrame = defineMixin<
  ImageRawFrame,
  <B extends Ctor>(base: B) => B & Ctor<ImageRawFrame>
>("ImageRawFrame", <B extends Ctor>(Base: B) => {
  abstract class ImageRawFrameMixin extends Base implements ImageRawFrame {
    image: Uint8Array;
    size: [number, number];
    format: string | null;

    // biome-ignore lint/suspicious/noExplicitAny: mixin constructor.
    constructor(...args: any[]) {
      super(...args);
      const options = args[0] as ImageRawFrameOptions;
      this.image = options.image;
      this.size = options.size;
      this.format = options.format;
    }
  }
  return ImageRawFrameMixin;
});

//
// Data frames.
//

/**
 * Audio data frame for output to transport.
 *
 * A chunk of raw audio that will be played by the output transport. If the
 * transport supports multiple audio destinations (e.g. multiple audio tracks)
 * the destination name can be specified in `transportDestination`.
 */
export class OutputAudioRawFrame extends AudioRawFrame(DataFrame) {
  constructor(options: AudioRawFrameOptions) {
    super(options);
  }

  override toString(): string {
    const pts = formatPts(this.pts);
    return `${this.name}(pts: ${pts}, destination: ${this.transportDestination}, size: ${this.audio.length}, frames: ${this.numFrames}, sample_rate: ${this.sampleRate}, channels: ${this.numChannels})`;
  }
}

export interface TextFrameOptions {
  /** The text content. */
  text: string;
}

/**
 * Text data frame for passing text through the pipeline.
 *
 * Emitted by LLM services, consumed by context aggregators, TTS services and
 * more.
 *
 * - `skipTts`: whether this text should be skipped by the TTS service.
 * - `includesInterFrameSpaces`: whether any necessary inter-frame
 *   (leading/trailing) spaces are already included in the text.
 * - `appendToContext`: whether this text should be appended to the LLM context.
 */
export class TextFrame extends DataFrame {
  text: string;
  skipTts: boolean | null = null;
  includesInterFrameSpaces = false;
  appendToContext = true;

  constructor(options: TextFrameOptions) {
    super(options);
    this.text = options.text;
  }

  override toString(): string {
    const pts = formatPts(this.pts);
    return `${this.name}(pts: ${pts}, text: [${this.text}])`;
  }
}

/** Text frame generated by LLM services. */
export class LLMTextFrame extends TextFrame {
  // LLM services send text frames with all necessary spaces included.
  override includesInterFrameSpaces = true;
}

// PORTING: the rest of frames.py continues below, in upstream order.
