// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
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

import { type Event, time } from "@pipedog/asyncio";
import type { DirectFunction } from "../adapters/llm/schemas/direct_function.ts";
import type { FunctionSchema } from "../adapters/llm/schemas/function_schema.ts";
import type { ToolsSchema } from "../adapters/llm/schemas/tools_schema.ts";
import { KeypadEntry } from "../audio/dtmf/types.ts";
import type { BaseTurnParams } from "../audio/turn/base_turn_analyzer.ts";
import type { VADParams } from "../audio/vad/vad_analyzer.ts";
import type { MetricsData } from "../metrics/metrics.ts";
import type { LLMContext, LLMContextMessage } from "../processors/aggregators/llm_context.ts";
import type { FrameProcessor } from "../processors/frame_processor.ts";
import type {
  LLMSettings,
  ServiceSettings,
  STTSettings,
  TTSSettings,
} from "../services/settings.ts";
import type { Language } from "../transcriptions/language.ts";
import type { UserTurnStrategies } from "../turns/user_turn_strategies.ts";
import type { LLMContextSummaryConfig } from "../utils/context/llm_context_summarization.ts";
import { ErrorCategory } from "../utils/errors.ts";
import { addVirtualBase, type Ctor, defineMixin } from "../utils/mixin.ts";
import { redactSecrets } from "../utils/security/redaction.ts";
import { TextType } from "../utils/text/base_text_aggregator.ts";
import { nanosecondsToStr } from "../utils/time.ts";
import type { NotGiven } from "../utils/types.ts";
import { objCount, objId } from "../utils/utils.ts";

// Upstream modules import `TextType` through `pipecat.frames.frames`.
export { TextType };

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

/** Format an image size the way upstream prints a `(width, height)` tuple. */
function formatSize(size: [number, number]): string {
  return `(${size[0]}, ${size[1]})`;
}

/** Validate one DTMF character, like constructing `KeypadEntry(c)` upstream. */
function toKeypadEntry(value: string): KeypadEntry {
  if (!(Object.values(KeypadEntry) as string[]).includes(value)) {
    throw new Error(`'${value}' is not a valid KeypadEntry`);
  }
  return value as KeypadEntry;
}

//
// Mixins (continued)
//

/** Type of a raw file: a base64 data URL ('bytes') or a URL string ('url'). */
export type FileSourceType = "bytes" | "url";

/** Fields of a raw file. */
export interface FileRawFrameOptions {
  /** A base64 data URL, or a URL string, depending on `type`. */
  file: string;
  /** Type of the file ('bytes' or 'url'). */
  type: FileSourceType;
  /** Optional name of the file. */
  filename: string | null;
  /** File format (expected in Mime Format). */
  format: string;
}

/** A frame containing a raw file. */
export interface FileRawFrame extends FileRawFrameOptions {}

export const FileRawFrame = defineMixin<
  FileRawFrame,
  <B extends Ctor>(base: B) => B & Ctor<FileRawFrame>
>("FileRawFrame", <B extends Ctor>(Base: B) => {
  abstract class FileRawFrameMixin extends Base implements FileRawFrame {
    file: string;
    type: FileSourceType;
    filename: string | null;
    format: string;

    constructor(...args: any[]) {
      super(...args);
      const options = args[0] as FileRawFrameOptions;
      this.file = options.file;
      this.type = options.type;
      this.filename = options.filename;
      this.format = options.format;
    }
  }
  return FileRawFrameMixin;
});

/**
 * Marker base class for DTMF (Dual-Tone Multi-Frequency) keypad frames.
 *
 * Used only as a shared tag so that both input and output DTMF frames can be
 * identified via `frame instanceof DTMFFrame`. The concrete frames define
 * their own fields.
 */
// biome-ignore lint/suspicious/noEmptyInterface: marker mixin.
export interface DTMFFrame {}

export const DTMFFrame = defineMixin<DTMFFrame, <B extends Ctor>(base: B) => B & Ctor<DTMFFrame>>(
  "DTMFFrame",
  <B extends Ctor>(Base: B) => {
    abstract class DTMFFrameMixin extends Base implements DTMFFrame {}
    return DTMFFrameMixin;
  },
);

//
// Data frames (continued).
//

/**
 * Image data frame for output to transport.
 *
 * An image that will be shown by the transport. If the transport supports
 * multiple video destinations (e.g. multiple video tracks) the destination
 * name can be specified in `transportDestination`.
 *
 * - `syncWithAudio`: if true, the image is queued with audio frames so it is
 *   only displayed after all preceding audio has been sent. Defaults to false
 *   (image is displayed immediately when the output transport receives it).
 */
export class OutputImageRawFrame extends ImageRawFrame(DataFrame) {
  syncWithAudio = false;

  constructor(options: ImageRawFrameOptions) {
    super(options);
  }

  override toString(): string {
    const pts = formatPts(this.pts);
    return `${this.name}(pts: ${pts}, destination: ${this.transportDestination}, size: ${formatSize(this.size)}, format: ${this.format})`;
  }
}

export interface TTSAudioRawFrameOptions extends AudioRawFrameOptions {
  /** Unique identifier for the TTS context that generated this audio. */
  contextId?: string | null;
}

/**
 * Audio data frame generated by Text-to-Speech services.
 *
 * A chunk of output audio generated by a TTS service, ready for playback.
 *
 * - `contextId`: unique identifier for the TTS context that generated this audio.
 */
export class TTSAudioRawFrame extends OutputAudioRawFrame {
  contextId: string | null;

  constructor(options: TTSAudioRawFrameOptions) {
    super(options);
    this.contextId = options.contextId ?? null;
  }
}

/**
 * An audio frame part of a speech audio stream.
 *
 * This frame is part of a continuous stream of audio frames containing speech.
 * The audio stream might also contain silence frames, so a process to
 * distinguish between speech and silence might be needed.
 */
export class SpeechOutputAudioRawFrame extends OutputAudioRawFrame {}

export interface URLImageRawFrameOptions extends ImageRawFrameOptions {
  /** URL where the image can be downloaded from. */
  url?: string | null;
}

/**
 * Image frame with an associated URL.
 *
 * An output image with an associated URL. These images are usually generated
 * by third-party services that provide a URL to download the image.
 *
 * - `url`: URL where the image can be downloaded from.
 */
export class URLImageRawFrame extends OutputImageRawFrame {
  url: string | null;

  constructor(options: URLImageRawFrameOptions) {
    super(options);
    this.url = options.url ?? null;
  }

  override toString(): string {
    const pts = formatPts(this.pts);
    return `${this.name}(pts: ${pts}, url: ${this.url}, size: ${formatSize(this.size)}, format: ${this.format})`;
  }
}

export interface SpriteFrameOptions {
  /** List of image frames that make up the sprite animation. */
  images: OutputImageRawFrame[];
}

/**
 * Animated sprite frame containing multiple images.
 *
 * An animated sprite that will be shown by the transport if the transport's
 * camera is enabled. Will play at the framerate specified in the transport's
 * `cameraOutFramerate` constructor parameter.
 *
 * - `images`: list of image frames that make up the sprite animation.
 */
export class SpriteFrame extends DataFrame {
  images: OutputImageRawFrame[];

  constructor(options: SpriteFrameOptions) {
    super(options);
    this.images = options.images;
  }

  override toString(): string {
    const pts = formatPts(this.pts);
    return `${this.name}(pts: ${pts}, size: ${this.images.length})`;
  }
}

export interface LLMMarkerFrameOptions {
  /** The marker payload (typically a short string such as a single character). */
  marker: string;
  /**
   * Whether the marker is written to the context as its own standalone
   * assistant message as soon as it's received. Defaults to true.
   */
  appendToContextImmediately?: boolean;
}

/**
 * Sideband marker emitted by an LLM service.
 *
 * A marker is short, structured assistant output that should be persisted in
 * the conversation context but should not flow through the standard text path
 * (TTS, transcript). The assistant aggregator writes the marker to the context
 * so the LLM can self-condition on prior markers on subsequent turns.
 *
 * The primary use today is the `filterIncompleteUserTurns` protocol, where
 * `UserTurnCompletionLLMServiceMixin` emits the turn-completion markers
 * ● / ◐ / ○ on every response. The frame is intentionally generic so other
 * components — STT services with built-in turn signals, end-of-turn
 * classifiers, custom annotations, etc. — can use the same mechanism to inject
 * sideband signals into the assistant context.
 *
 * - `marker`: the marker payload (typically a short string such as a single
 *   character).
 * - `appendToContextImmediately`: if true, the marker is written to the
 *   context as its own standalone assistant message as soon as it's received.
 *   If false, the marker is appended to the running assistant aggregation and
 *   flushed to the context together with the following text as a single
 *   message (e.g. for the ● case the context message ends up as
 *   "● <response>").
 */
export class LLMMarkerFrame extends DataFrame {
  marker: string;
  appendToContextImmediately: boolean;

  constructor(options: LLMMarkerFrameOptions) {
    super(options);
    this.marker = options.marker;
    this.appendToContextImmediately = options.appendToContextImmediately ?? true;
  }
}

export interface LLMMarkerResponseFrameOptions {
  /** The response text as the LLM produced it, markers included. */
  raw: string;
  /** The marker found, or null when the response carried none. */
  marker?: string | null;
  /** What the marker meant, in the emitter's own vocabulary. */
  kind?: string | null;
  /** Every marker the emitter recognizes. */
  markers?: string[];
}

/**
 * What a marker-reading LLM service made of one whole response.
 *
 * Pushed when the response ends, after the `LLMMarkerFrame` and the spoken
 * text: the marker it found, what it meant, and the raw text the LLM produced
 * before anything was held back. A diagnostic, for consumers that check how
 * well the LLM follows the marker protocol; it plays no part in the
 * conversation.
 *
 * - `raw`: the response text as the LLM produced it, markers included.
 * - `marker`: the marker found, or null when the response carried none.
 * - `kind`: what the marker meant, in the emitter's own vocabulary, for
 *   consumers that should not depend on the marker text (which is
 *   configurable). The turn-completion mixin uses `"complete"`, `"short"` and
 *   `"long"`.
 * - `markers`: every marker the emitter recognizes, so a consumer can find
 *   them in `raw` without knowing the emitter's configuration.
 */
export class LLMMarkerResponseFrame extends DataFrame {
  raw: string;
  marker: string | null;
  kind: string | null;
  markers: string[];

  constructor(options: LLMMarkerResponseFrameOptions) {
    super(options);
    this.raw = options.raw;
    this.marker = options.marker ?? null;
    this.kind = options.kind ?? null;
    this.markers = options.markers ?? [];
  }
}

export interface AggregatedTextFrameOptions extends TextFrameOptions {
  /** The kind of text, such as a sentence, a word or a custom type like `"code"`. */
  textType: TextType | string;
  /** Unique identifier for the TTS context that generated this text. */
  contextId?: string | null;
  /** The full matched text including start/end pattern delimiters. */
  rawText?: string | null;
}

/**
 * Text frame representing an aggregation of TextFrames.
 *
 * This frame contains multiple TextFrames aggregated together for processing
 * or output along with a field to indicate what kind of text they make.
 *
 * - `textType`: the kind of text, such as a sentence, a word or a custom type
 *   like `"code"`.
 * - `contextId`: unique identifier for the TTS context that generated this text.
 * - `rawText`: the full matched text including start/end pattern delimiters,
 *   set when this frame was produced from a PatternMatch (e.g. a
 *   `<code>...</code>` block). Null for ordinary sentence aggregations.
 * - `willBeSpoken`: whether the TTS service will speak this frame. Set to true
 *   by the TTS service just before synthesis. Defaults to false.
 */
export class AggregatedTextFrame extends TextFrame {
  textType: TextType | string;
  contextId: string | null;
  rawText: string | null;
  willBeSpoken = false;

  constructor(options: AggregatedTextFrameOptions) {
    super(options);
    this.textType = options.textType;
    this.contextId = options.contextId ?? null;
    this.rawText = options.rawText ?? null;
  }
}

/** Text frame generated by vision services. */
export class VisionTextFrame extends LLMTextFrame {}

export interface TTSTextFrameOptions extends AggregatedTextFrameOptions {
  /** ID of the AggregatedTextFrame this text is part of. */
  segmentId?: number | null;
}

/**
 * Text frame generated by Text-to-Speech services.
 *
 * - `segmentId`: ID of the AggregatedTextFrame this text is part of, when the
 *   TTS service built it from one. A word reported by the TTS carries the ID
 *   of the sentence or other segment it was spoken in.
 */
export class TTSTextFrame extends AggregatedTextFrame {
  segmentId: number | null;

  constructor(options: TTSTextFrameOptions) {
    super(options);
    this.segmentId = options.segmentId ?? null;
  }
}

export interface AggregatedTextProgressFrameOptions {
  /** ID of the AggregatedTextFrame being spoken. */
  segmentId: number;
  /** TTS context this frame belongs to. */
  contextId: string | null;
  /** Full original text of the source AggregatedTextFrame. */
  text: string;
  /** Text type of the source AggregatedTextFrame. */
  textType: TextType | string;
  /** Text already spoken in this slot (including the current word). */
  accumulatedText: string;
  /** Text not yet spoken in this slot. */
  remainingText: string;
}

/**
 * Progress frame emitted alongside each TTSTextFrame during word-timestamp playback.
 *
 * Carries the spoken-so-far / remaining-text breakdown for the active
 * AggregatedTextFrame slot, enabling downstream consumers (e.g. the RTVI
 * observer) to do word-level highlighting without coupling to internal
 * sequencer state.
 *
 * - `segmentId`: ID of the AggregatedTextFrame being spoken.
 * - `contextId`: TTS context this frame belongs to.
 * - `text`: full original text of the source AggregatedTextFrame.
 * - `textType`: text type of the source AggregatedTextFrame.
 * - `accumulatedText`: text already spoken in this slot (including the current word).
 * - `remainingText`: text not yet spoken in this slot.
 */
export class AggregatedTextProgressFrame extends DataFrame {
  segmentId: number;
  contextId: string | null;
  text: string;
  textType: TextType | string;
  accumulatedText: string;
  remainingText: string;

  constructor(options: AggregatedTextProgressFrameOptions) {
    super(options);
    this.segmentId = options.segmentId;
    this.contextId = options.contextId;
    this.text = options.text;
    this.textType = options.textType;
    this.accumulatedText = options.accumulatedText;
    this.remainingText = options.remainingText;
  }
}

export interface TranscriptionFrameOptions extends TextFrameOptions {
  /** Identifier for the user who spoke. */
  userId: string;
  /** When the transcription occurred. */
  timestamp: string;
  /** Detected or specified language of the speech. */
  language?: Language | null;
  /** Raw result from the STT service. */
  result?: unknown;
  /** Whether this is the final transcription for an utterance. */
  finalized?: boolean;
}

/**
 * Text frame containing speech transcription data.
 *
 * A text frame with transcription-specific data. The `result` field contains
 * the result from the STT service if available.
 *
 * - `userId`: identifier for the user who spoke.
 * - `timestamp`: when the transcription occurred.
 * - `language`: detected or specified language of the speech.
 * - `result`: raw result from the STT service.
 * - `finalized`: whether this is the final transcription for an utterance.
 *   Set by STT services that support commit/finalize signals.
 */
export class TranscriptionFrame extends TextFrame {
  userId: string;
  timestamp: string;
  language: Language | null;
  result: unknown;
  finalized: boolean;

  constructor(options: TranscriptionFrameOptions) {
    super(options);
    this.userId = options.userId;
    this.timestamp = options.timestamp;
    this.language = options.language ?? null;
    this.result = options.result ?? null;
    this.finalized = options.finalized ?? false;
  }

  override toString(): string {
    return `${this.name}(user: ${this.userId}, text: [${this.text}], language: ${this.language}, timestamp: ${this.timestamp})`;
  }
}

export interface InterimTranscriptionFrameOptions extends TextFrameOptions {
  /** Identifier for the user who spoke. */
  userId: string;
  /** When the interim transcription occurred. */
  timestamp: string;
  /** Detected or specified language of the speech. */
  language?: Language | null;
  /** Raw result from the STT service. */
  result?: unknown;
}

/**
 * Text frame containing partial/interim transcription data.
 *
 * A text frame with interim transcription-specific data that represents
 * partial results before final transcription. The `result` field contains the
 * result from the STT service if available.
 *
 * - `userId`: identifier for the user who spoke.
 * - `timestamp`: when the interim transcription occurred.
 * - `language`: detected or specified language of the speech.
 * - `result`: raw result from the STT service.
 */
export class InterimTranscriptionFrame extends TextFrame {
  userId: string;
  timestamp: string;
  language: Language | null;
  result: unknown;

  constructor(options: InterimTranscriptionFrameOptions) {
    super(options);
    this.userId = options.userId;
    this.timestamp = options.timestamp;
    this.language = options.language ?? null;
    this.result = options.result ?? null;
  }

  override toString(): string {
    return `${this.name}(user: ${this.userId}, text: [${this.text}], language: ${this.language}, timestamp: ${this.timestamp})`;
  }
}

export interface EagerTranscriptionFrameOptions extends TextFrameOptions {
  /** Identifier for the user who spoke. */
  userId: string;
  /** When the eager end of turn occurred. */
  timestamp: string;
  /** Detected or specified language of the speech. */
  language?: Language | null;
  /** Raw result from the STT service. */
  result?: unknown;
}

/**
 * Transcript of a turn a service predicts has ended, before it commits.
 *
 * Some STT services emit a provisional end of turn ahead of the real one, so a
 * response can be generated during the gap. The prediction may be withdrawn
 * (`EagerEndOfTurnCancelFrame`) and the committed transcript may differ from
 * this one, so nothing produced from it may reach the user or the context
 * until it is confirmed. See `EagerUserTurnStopStrategy`.
 *
 * - `userId`: identifier for the user who spoke.
 * - `timestamp`: when the eager end of turn occurred.
 * - `language`: detected or specified language of the speech.
 * - `result`: raw result from the STT service.
 */
export class EagerTranscriptionFrame extends TextFrame {
  userId: string;
  timestamp: string;
  language: Language | null;
  result: unknown;

  constructor(options: EagerTranscriptionFrameOptions) {
    super(options);
    this.userId = options.userId;
    this.timestamp = options.timestamp;
    this.language = options.language ?? null;
    this.result = options.result ?? null;
  }

  override toString(): string {
    return `${this.name}(user: ${this.userId}, text: [${this.text}], language: ${this.language}, timestamp: ${this.timestamp})`;
  }
}

export interface TranslationFrameOptions extends TextFrameOptions {
  /** Identifier for the user who spoke. */
  userId: string;
  /** When the translation occurred. */
  timestamp: string;
  /** Target language of the translation. */
  language?: Language | null;
}

/**
 * Text frame containing translated transcription data.
 *
 * A text frame with translated transcription data that will be placed in the
 * transport's receive queue when a participant speaks.
 *
 * - `userId`: identifier for the user who spoke.
 * - `timestamp`: when the translation occurred.
 * - `language`: target language of the translation.
 */
export class TranslationFrame extends TextFrame {
  userId: string;
  timestamp: string;
  language: Language | null;

  constructor(options: TranslationFrameOptions) {
    super(options);
    this.userId = options.userId;
    this.timestamp = options.timestamp;
    this.language = options.language ?? null;
  }

  override toString(): string {
    return `${this.name}(user: ${this.userId}, text: [${this.text}], language: ${this.language}, timestamp: ${this.timestamp})`;
  }
}

export interface UserBackchannelFrameOptions {
  /** What the user said. */
  text: string;
  /** Identifier for the user who spoke. */
  userId: string;
  /** When the user said it. */
  timestamp: string;
}

/**
 * A short acknowledgment the user said while the bot talks, such as "mhm".
 *
 * Pushed in place of a transcription, so the bot keeps talking and the
 * acknowledgment stays out of the LLM context.
 *
 * - `text`: what the user said.
 * - `userId`: identifier for the user who spoke.
 * - `timestamp`: when the user said it.
 */
export class UserBackchannelFrame extends DataFrame {
  text: string;
  userId: string;
  timestamp: string;

  constructor(options: UserBackchannelFrameOptions) {
    super(options);
    this.text = options.text;
    this.userId = options.userId;
    this.timestamp = options.timestamp;
  }

  override toString(): string {
    return `${this.name}(user: ${this.userId}, text: [${this.text}], timestamp: ${this.timestamp})`;
  }
}

export interface LLMContextAssistantTimestampFrameOptions {
  /** Timestamp when the assistant message was created. */
  timestamp: string;
}

/**
 * Timestamp information for assistant messages in LLM context.
 *
 * - `timestamp`: timestamp when the assistant message was created.
 */
export class LLMContextAssistantTimestampFrame extends DataFrame {
  timestamp: string;

  constructor(options: LLMContextAssistantTimestampFrameOptions) {
    super(options);
    this.timestamp = options.timestamp;
  }
}

export interface LLMContextAssistantTurnFrameOptions {
  /** The assistant's aggregated spoken text for this turn. */
  text: string;
  /** ISO-8601 timestamp of when the assistant turn started. */
  timestamp: string;
}

/**
 * The aggregated text of a completed assistant turn.
 *
 * Broadcast by the LLM assistant aggregator when a turn ends, carrying the
 * same text that is stored in the LLM context. Processors upstream and
 * downstream (e.g. STT services) can handle this frame to react to each
 * completed bot reply without needing a separate observer.
 *
 * - `text`: the assistant's aggregated spoken text for this turn.
 * - `timestamp`: ISO-8601 timestamp of when the assistant turn started.
 */
export class LLMContextAssistantTurnFrame extends DataFrame {
  text: string;
  timestamp: string;

  constructor(options: LLMContextAssistantTurnFrameOptions) {
    super(options);
    this.text = options.text;
    this.timestamp = options.timestamp;
  }
}

export interface LLMContextUserTurnFrameOptions {
  /** The user's aggregated transcript for this turn. */
  text: string;
  /** ISO-8601 timestamp of when the user turn started. */
  timestamp: string;
}

/**
 * The aggregated text of a user turn, as written to the LLM context.
 *
 * Broadcast by the LLM user aggregator each time it writes what the user said
 * to the context, so it holds what the bot heard: a transcription the
 * aggregator leaves out, such as one while the user is muted, is not in it.
 *
 * - `text`: the user's aggregated transcript for this turn.
 * - `timestamp`: ISO-8601 timestamp of when the user turn started.
 */
export class LLMContextUserTurnFrame extends DataFrame {
  text: string;
  timestamp: string;

  constructor(options: LLMContextUserTurnFrameOptions) {
    super(options);
    this.text = options.text;
    this.timestamp = options.timestamp;
  }
}

export interface LLMContextFrameOptions {
  /** The LLM context containing messages, tools, and configuration. */
  context: LLMContext;
  /** Whether this inference is speculative. Defaults to false. */
  speculation?: boolean;
}

/**
 * Frame containing a universal LLM context.
 *
 * Used as a signal to LLM services to ingest the provided context and generate
 * a response based on it.
 *
 * - `context`: the LLM context containing messages, tools, and configuration.
 * - `speculation`: whether this inference is speculative, run from a
 *   provisional context that is not part of the conversation. Its response
 *   must not reach the user or the context until the turn is confirmed, and
 *   the service must not execute tool calls for it.
 */
export class LLMContextFrame extends Frame {
  context: LLMContext;
  speculation: boolean;

  constructor(options: LLMContextFrameOptions) {
    super(options);
    this.context = options.context;
    this.speculation = options.speculation ?? false;
  }
}

export interface LLMThoughtStartFrameOptions {
  /** Whether the thought should be appended to the LLM context. */
  appendToContext?: boolean;
  /** Optional identifier of the LLM provider for LLM-specific handling. */
  llm?: string | null;
}

/**
 * Frame indicating the start of an LLM thought.
 *
 * - `appendToContext`: whether the thought should be appended to the LLM
 *   context. If it is appended, the `llm` field is required, since it will be
 *   appended as an `LLMSpecificMessage`.
 * - `llm`: optional identifier of the LLM provider for LLM-specific handling.
 *   Only required if `appendToContext` is true, as the thought is appended to
 *   context as an `LLMSpecificMessage`.
 */
export class LLMThoughtStartFrame extends ControlFrame {
  appendToContext: boolean;
  llm: string | null;

  constructor(options: LLMThoughtStartFrameOptions = {}) {
    super(options);
    this.appendToContext = options.appendToContext ?? false;
    this.llm = options.llm ?? null;
    if (this.appendToContext && this.llm === null) {
      throw new Error("When append_to_context is True, llm must be set");
    }
  }

  override toString(): string {
    const pts = formatPts(this.pts);
    return `${this.name}(pts: ${pts}, append_to_context: ${this.appendToContext}, llm: ${this.llm})`;
  }
}

export interface LLMThoughtTextFrameOptions {
  /** The text (or text chunk) of the thought. */
  text: string;
}

/**
 * Frame containing the text (or text chunk) of an LLM thought.
 *
 * Note that despite this containing text, it is a DataFrame and not a
 * TextFrame, to avoid most typical text processing, such as TTS.
 *
 * - `text`: the text (or text chunk) of the thought.
 */
export class LLMThoughtTextFrame extends DataFrame {
  text: string;
  // Assume that thought text chunks include all necessary spaces
  includesInterFrameSpaces = true;

  constructor(options: LLMThoughtTextFrameOptions) {
    super(options);
    this.text = options.text;
  }

  override toString(): string {
    const pts = formatPts(this.pts);
    return `${this.name}(pts: ${pts}, thought text: ${this.text})`;
  }
}

export interface LLMThoughtEndFrameOptions {
  /** Optional signature associated with the thought. */
  signature?: unknown;
}

/**
 * Frame indicating the end of an LLM thought.
 *
 * - `signature`: optional signature associated with the thought. This is used
 *   by Anthropic, which includes a signature at the end of each thought.
 */
export class LLMThoughtEndFrame extends ControlFrame {
  signature: unknown;

  constructor(options: LLMThoughtEndFrameOptions = {}) {
    super(options);
    this.signature = options.signature ?? null;
  }

  override toString(): string {
    const pts = formatPts(this.pts);
    return `${this.name}(pts: ${pts}, signature: ${this.signature})`;
  }
}

/**
 * Frame to trigger LLM processing with current context.
 *
 * A frame that instructs the LLM service to process the current context and
 * generate a response.
 */
export class LLMRunFrame extends DataFrame {}

export interface LLMMessagesAppendFrameOptions {
  /** List of context messages to append. */
  messages: LLMContextMessage[];
  /** Whether the context update should be sent to the LLM. */
  runLlm?: boolean | null;
}

/**
 * Frame containing LLM messages to append to current context.
 *
 * A frame containing a list of LLM messages that need to be added to the
 * current context.
 *
 * - `messages`: list of context messages to append.
 * - `runLlm`: whether the context update should be sent to the LLM.
 */
export class LLMMessagesAppendFrame extends DataFrame {
  messages: LLMContextMessage[];
  runLlm: boolean | null;

  constructor(options: LLMMessagesAppendFrameOptions) {
    super(options);
    this.messages = options.messages;
    this.runLlm = options.runLlm ?? null;
  }
}

export interface LLMMessagesUpdateFrameOptions {
  /** List of context messages to replace current context. */
  messages: LLMContextMessage[];
  /** Whether the context update should be sent to the LLM. */
  runLlm?: boolean | null;
}

/**
 * Frame containing LLM messages to replace current context.
 *
 * A frame containing a list of new LLM messages to replace the current
 * context LLM messages.
 *
 * - `messages`: list of context messages to replace current context.
 * - `runLlm`: whether the context update should be sent to the LLM.
 */
export class LLMMessagesUpdateFrame extends DataFrame {
  messages: LLMContextMessage[];
  runLlm: boolean | null;

  constructor(options: LLMMessagesUpdateFrameOptions) {
    super(options);
    this.messages = options.messages;
    this.runLlm = options.runLlm ?? null;
  }
}

export interface LLMMessagesTransformFrameOptions {
  /** A function that takes a list of messages and returns a modified list. */
  transform: (messages: LLMContextMessage[]) => LLMContextMessage[];
  /** Whether the context update should be sent to the LLM. */
  runLlm?: boolean | null;
}

/**
 * Frame containing a transform function to modify the current context's LLM messages.
 *
 * A frame containing a transform function that takes the context's current
 * list of LLM messages and returns a modified list.
 *
 * - `transform`: a function that takes a list of messages and returns a
 *   modified list.
 * - `runLlm`: whether the context update should be sent to the LLM.
 */
export class LLMMessagesTransformFrame extends DataFrame {
  transform: (messages: LLMContextMessage[]) => LLMContextMessage[];
  runLlm: boolean | null;

  constructor(options: LLMMessagesTransformFrameOptions) {
    super(options);
    this.transform = options.transform;
    this.runLlm = options.runLlm ?? null;
  }
}

export interface LLMSetToolsFrameOptions {
  /** The tools to advertise. */
  tools: (FunctionSchema | DirectFunction)[] | ToolsSchema | NotGiven;
}

/**
 * Frame containing tools for LLM function calling.
 *
 * Used to change the set of tools advertised to the LLM mid-conversation.
 *
 * - `tools`: the tools to advertise. May be a `ToolsSchema`, a plain list of
 *   direct functions and/or `FunctionSchema` objects (normalized to a
 *   `ToolsSchema`, with direct-function handlers auto-registered), or
 *   `NOT_GIVEN` to clear tools. Provider-native tools travel in a
 *   `ToolsSchema`'s `customTools`, keyed by adapter type.
 */
export class LLMSetToolsFrame extends DataFrame {
  tools: (FunctionSchema | DirectFunction)[] | ToolsSchema | NotGiven;

  constructor(options: LLMSetToolsFrameOptions) {
    super(options);
    this.tools = options.tools;
  }
}

/** Tool choice setting: 'none', 'auto', 'required', or a specific tool dict. */
export type LLMToolChoice = "none" | "auto" | "required" | Record<string, unknown>;

export interface LLMSetToolChoiceFrameOptions {
  /** Tool choice setting - 'none', 'auto', 'required', or specific tool dict. */
  toolChoice: LLMToolChoice;
}

/**
 * Frame containing tool choice configuration for LLM function calling.
 *
 * - `toolChoice`: tool choice setting - 'none', 'auto', 'required', or
 *   specific tool dict.
 */
export class LLMSetToolChoiceFrame extends DataFrame {
  toolChoice: LLMToolChoice;

  constructor(options: LLMSetToolChoiceFrameOptions) {
    super(options);
    this.toolChoice = options.toolChoice;
  }
}

export interface LLMEnablePromptCachingFrameOptions {
  /** Whether to enable prompt caching. */
  enable: boolean;
}

/**
 * Frame to enable/disable prompt caching in LLMs.
 *
 * - `enable`: whether to enable prompt caching.
 */
export class LLMEnablePromptCachingFrame extends DataFrame {
  enable: boolean;

  constructor(options: LLMEnablePromptCachingFrameOptions) {
    super(options);
    this.enable = options.enable;
  }
}

export interface LLMConfigureOutputFrameOptions {
  /** Whether LLM tokens should skip the TTS service (if any). */
  skipTts: boolean;
}

/**
 * Frame to configure LLM output.
 *
 * This frame is used to configure how the LLM produces output. For example, it
 * can tell the LLM to generate tokens that should be added to the context but
 * not spoken by the TTS service (if one is present in the pipeline).
 *
 * - `skipTts`: whether LLM tokens should skip the TTS service (if any).
 */
export class LLMConfigureOutputFrame extends DataFrame {
  skipTts: boolean;

  constructor(options: LLMConfigureOutputFrameOptions) {
    super(options);
    this.skipTts = options.skipTts;
  }
}

export interface FunctionCallResultPropertiesOptions {
  /** Whether to run the LLM after receiving this result. */
  runLlm?: boolean | null;
  /** Callback to execute when context is updated. */
  onContextUpdated?: (() => Promise<void>) | null;
  /** Whether this is the final result for the function call. Defaults to true. */
  isFinal?: boolean;
}

/**
 * Properties for configuring function call result behavior.
 *
 * - `runLlm`: whether to run the LLM after receiving this result.
 * - `onContextUpdated`: callback to execute when context is updated.
 * - `isFinal`: whether this is the final result for the function call. When
 *   false the result is treated as an intermediate update. Defaults to true.
 *   Only meaningful for async function calls (`cancelOnInterruption: false`).
 *   A speech-to-speech service takes one output per call, so it puts an
 *   intermediate result to its model some other way — a conversation item, a
 *   text event, a response that keeps the call open — and `runLlm` says
 *   whether the model should answer it or just take it in. A service that
 *   can't do that at all says so with
 *   `acceptsIntermediateFunctionCallResults` and drops intermediate results
 *   with a warning.
 */
export class FunctionCallResultProperties {
  runLlm: boolean | null;
  onContextUpdated: (() => Promise<void>) | null;
  isFinal: boolean;

  constructor(options: FunctionCallResultPropertiesOptions = {}) {
    this.runLlm = options.runLlm ?? null;
    this.onContextUpdated = options.onContextUpdated ?? null;
    this.isFinal = options.isFinal ?? true;
  }
}

export interface FunctionCallResultFrameOptions {
  /** Name of the function that was executed. */
  functionName: string;
  /** Unique identifier for the function call. */
  toolCallId: string;
  /** Arguments that were passed to the function. */
  arguments: unknown;
  /** The result returned by the function. */
  result: unknown;
  /** Whether to run the LLM after this result. */
  runLlm?: boolean | null;
  /** Additional properties for result handling. */
  properties?: FunctionCallResultProperties | null;
  /** What went wrong, when the call ended because its handler raised. */
  error?: string | null;
}

/**
 * Frame containing the result of an LLM function call.
 *
 * This is an uninterruptible frame because once a result is generated we
 * always want to update the context.
 *
 * - `functionName`: name of the function that was executed.
 * - `toolCallId`: unique identifier for the function call.
 * - `arguments`: arguments that were passed to the function.
 * - `result`: the result returned by the function.
 * - `runLlm`: whether to run the LLM after this result.
 * - `properties`: additional properties for result handling.
 * - `error`: what went wrong, when the call ended because its handler raised.
 *   The `result` is then a stand-in message written for the LLM to read,
 *   rather than anything the handler returned.
 */
export class FunctionCallResultFrame extends DataFrame {
  override interruptible = false;

  functionName: string;
  toolCallId: string;
  arguments: unknown;
  result: unknown;
  runLlm: boolean | null;
  properties: FunctionCallResultProperties | null;
  error: string | null;

  constructor(options: FunctionCallResultFrameOptions) {
    super(options);
    this.functionName = options.functionName;
    this.toolCallId = options.toolCallId;
    this.arguments = options.arguments;
    this.result = options.result;
    this.runLlm = options.runLlm ?? null;
    this.properties = options.properties ?? null;
    this.error = options.error ?? null;
  }
}

export interface TTSSpeakFrameOptions {
  /** The text to be spoken. */
  text: string;
  /** Whether the spoken text should be appended to the LLM context. Defaults to true. */
  appendToContext?: boolean;
  /** The text type of the text frames the TTS service pushes. Defaults to a sentence. */
  textType?: TextType | string;
}

/**
 * Frame containing text that should be spoken by TTS.
 *
 * A frame that contains text that should be spoken by the TTS service in the
 * pipeline (if any).
 *
 * Set `interruptible = false` on the frame to preserve its synthesis and
 * generated audio and text through interruptions.
 *
 * - `text`: the text to be spoken.
 * - `appendToContext`: whether the spoken text should be appended to the LLM
 *   context. Defaults to true.
 * - `textType`: the text type of the text frames the TTS service pushes for
 *   the spoken text, a sentence by default. A custom type lets them be told
 *   apart, for example to keep them from the client with
 *   `RTVIObserverParams.skipTextTypes`.
 */
export class TTSSpeakFrame extends DataFrame {
  text: string;
  appendToContext: boolean;
  textType: TextType | string;

  constructor(options: TTSSpeakFrameOptions) {
    super(options);
    this.text = options.text;
    this.appendToContext = options.appendToContext ?? true;
    this.textType = options.textType ?? TextType.SENTENCE;
  }
}

export interface BotBackchannelFrameOptions extends Omit<TTSSpeakFrameOptions, "textType"> {}

/**
 * A short acknowledgment for the bot to say while the user talks, such as "Mm-hmm.".
 *
 * The TTS service speaks it like any `TTSSpeakFrame`, and its text frames
 * have type `TextType.BACKCHANNEL`. Interruptions don't cut it off unless
 * `interruptible` is set to true on the frame.
 *
 * - `appendToContext`: whether the spoken text should be appended to the LLM
 *   context. Defaults to false.
 */
export class BotBackchannelFrame extends TTSSpeakFrame {
  override textType: TextType | string = TextType.BACKCHANNEL;
  override interruptible = false;

  constructor(options: BotBackchannelFrameOptions) {
    super(options);
    this.appendToContext = options.appendToContext ?? false;
  }
}

export interface OutputTransportMessageFrameOptions {
  /** The transport message payload. */
  message: unknown;
}

/**
 * Frame containing transport-specific message data.
 *
 * - `message`: the transport message payload.
 */
export class OutputTransportMessageFrame extends DataFrame {
  message: unknown;

  constructor(options: OutputTransportMessageFrameOptions) {
    super(options);
    this.message = options.message;
  }

  override toString(): string {
    return `${this.name}(message: ${this.message})`;
  }
}

export interface OutputDTMFFrameOptions {
  /** Convenience shortcut for sending a single DTMF keypad entry. */
  button?: KeypadEntry | null;
  /** Sequence of one or more DTMF keypad buttons to send. */
  buttons?: KeypadEntry[] | null;
}

/**
 * DTMF keypress output frame for transport queuing.
 *
 * - `button`: convenience shortcut for sending a single DTMF keypad entry.
 *   Equivalent to `buttons: [button]`. If both `buttons` and `button` are
 *   provided, `buttons` takes precedence.
 * - `buttons`: sequence of one or more DTMF keypad buttons to send. Use
 *   `fromString()` to build this from a string like `"123#"`.
 */
export class OutputDTMFFrame extends DTMFFrame(DataFrame) {
  button: KeypadEntry | null;
  buttons: KeypadEntry[] | null;

  constructor(options: OutputDTMFFrameOptions = {}) {
    super(options);
    this.button = options.button ?? null;
    this.buttons = options.buttons ?? null;
    if (this.buttons === null && this.button !== null) {
      this.buttons = [this.button];
    }
    if (!this.buttons || this.buttons.length === 0) {
      throw new Error(`${this.constructor.name} requires \`buttons\` or \`button\` to be set`);
    }
  }

  override toString(): string {
    return `${this.name}(buttons: ${this.toDialString()})`;
  }

  /**
   * Build an `OutputDTMFFrame` from a string of DTMF characters.
   *
   * @param buttons A string like `"123#"`. Each character must be a valid
   *   `KeypadEntry` value.
   * @param options Additional options forwarded to the frame constructor.
   * @returns A frame of this class with `buttons` populated as a list of `KeypadEntry`.
   */
  static fromString<T extends OutputDTMFFrame>(
    this: new (
      options: OutputDTMFFrameOptions,
    ) => T,
    buttons: string,
    options: Omit<OutputDTMFFrameOptions, "buttons"> = {},
  ): T {
    return new this({ ...options, buttons: [...buttons].map(toKeypadEntry) });
  }

  /**
   * Return the frame's `buttons` as a dial string. Upstream's `to_string()`;
   * renamed because `toString()` is the JS `__str__`.
   *
   * @returns A string such as `"123#"` formed by concatenating each
   *   `KeypadEntry` in `buttons`, or an empty string if `buttons` is not set.
   */
  toDialString(): string {
    return this.buttons ? this.buttons.join("") : "";
  }
}

//
// System frames
//

/**
 * Initial frame to start pipeline processing.
 *
 * This is the first frame that should be pushed down a pipeline to initialize
 * all processors. Processors read the pipeline configuration from
 * `FrameProcessorSetup`.
 */
export class StartFrame extends SystemFrame {}

export interface CancelFrameOptions {
  /** Optional reason for pushing a cancel frame. */
  reason?: unknown;
}

/**
 * Frame indicating pipeline should stop immediately.
 *
 * Indicates that a pipeline needs to stop right away without processing
 * remaining queued frames.
 *
 * - `reason`: optional reason for pushing a cancel frame.
 */
export class CancelFrame extends SystemFrame {
  reason: unknown;

  constructor(options: CancelFrameOptions = {}) {
    super(options);
    this.reason = options.reason ?? null;
  }

  override toString(): string {
    return `${this.name}(reason: ${this.reason})`;
  }
}

export interface ErrorFrameOptions {
  /** Description of the error that occurred. */
  error: string;
  /** The frame processor that generated the error. */
  processor?: FrameProcessor | null;
  /** The exception that occurred. */
  exception?: unknown;
  /** What kind of failure this was. */
  category?: ErrorCategory | null;
}

/**
 * Frame notifying of errors in the pipeline.
 *
 * This is used to notify upstream that an error has occurred downstream in the
 * pipeline.
 *
 * - `error`: description of the error that occurred. Credentials it quotes
 *   (an API key, a signed URL's signature, an auth header) are masked, since
 *   the description is logged and reported wherever the error goes.
 * - `processor`: the frame processor that generated the error.
 * - `exception`: the exception that occurred.
 * - `category`: what kind of failure this was, drawn from `ErrorCategory`:
 *   rejected credentials, an unreachable provider, a malformed request and so
 *   on. Null means nobody has said yet, which invites the category to be
 *   worked out from the exception; set it to `ErrorCategory.UNKNOWN` to
 *   report an error whose cause can't be attributed. Always set by the time
 *   the frame travels.
 */
export class ErrorFrame extends SystemFrame {
  error: string;
  processor: FrameProcessor | null;
  exception: unknown;
  category: ErrorCategory | null;

  constructor(options: ErrorFrameOptions) {
    super(options);
    this.error = typeof options.error === "string" ? redactSecrets(options.error) : options.error;
    this.processor = options.processor ?? null;
    this.exception = options.exception ?? null;
    this.category = options.category ?? null;
  }

  override toString(): string {
    const category =
      this.category && this.category !== ErrorCategory.UNKNOWN
        ? `, category: ${this.category.value}`
        : "";
    return `${this.name}(error: ${this.error}${category})`;
  }
}

export interface FrameProcessorPauseUrgentFrameOptions {
  /** The frame processor to pause. */
  processor: FrameProcessor;
}

/**
 * Frame to pause frame processing immediately.
 *
 * This frame is used to pause frame processing for the given processor as
 * fast as possible. Pausing frame processing will keep frames in the internal
 * queue which will then be processed when frame processing is resumed with
 * `FrameProcessorResumeFrame`.
 *
 * - `processor`: the frame processor to pause.
 */
export class FrameProcessorPauseUrgentFrame extends SystemFrame {
  processor: FrameProcessor;

  constructor(options: FrameProcessorPauseUrgentFrameOptions) {
    super(options);
    this.processor = options.processor;
  }
}

export interface FrameProcessorResumeUrgentFrameOptions {
  /** The frame processor to resume. */
  processor: FrameProcessor;
}

/**
 * Frame to resume frame processing immediately.
 *
 * This frame is used to resume frame processing for the given processor if it
 * was previously paused as fast as possible. After resuming frame processing
 * all queued frames will be processed in the order received.
 *
 * Note: this frame is now equivalent to FrameProcessorResumeFrame, which was
 * changed to a SystemFrame to fix a bug where resume frames would get stuck in
 * the blocked processing queue.
 *
 * - `processor`: the frame processor to resume.
 */
export class FrameProcessorResumeUrgentFrame extends SystemFrame {
  processor: FrameProcessor;

  constructor(options: FrameProcessorResumeUrgentFrameOptions) {
    super(options);
    this.processor = options.processor;
  }
}

/**
 * Frame pushed to interrupt the pipeline.
 *
 * This frame is used to interrupt the pipeline. For example, when a user
 * starts speaking to cancel any in-progress bot output. It can also be pushed
 * by any processor.
 */
export class InterruptionFrame extends SystemFrame {}

/**
 * Frame indicating that the user turn has started.
 *
 * Emitted when the user turn starts, which usually means that some
 * transcriptions are already available.
 */
export class UserStartedSpeakingFrame extends SystemFrame {}

/**
 * Frame indicating that the user turn has ended.
 *
 * Emitted when the user turn ends. This usually coincides with the start of
 * the bot turn. A `SpeculationGate` releases whatever speculative response it
 * is holding on this frame, since the turn that response answers has now
 * ended.
 */
export class UserStoppedSpeakingFrame extends SystemFrame {}

/**
 * Frame withdrawing an eager end of turn.
 *
 * Emitted when a service reports the user resumed speaking after an eager end
 * of turn, or when the committed transcript doesn't match the eager one. The
 * LLM service stops generating, and its `SpeculationGate` discards what it was
 * holding — which is everything the response produced, so nothing further
 * down the pipeline has anything to undo.
 *
 * A system frame so it overtakes the speculative output it cancels.
 */
export class EagerEndOfTurnCancelFrame extends SystemFrame {}

/**
 * Frame indicating that the user has been muted.
 *
 * Emitted when a mute strategy activates, suppressing user frames (audio,
 * transcription, interruption) from propagating through the pipeline.
 */
export class UserMuteStartedFrame extends SystemFrame {}

/**
 * Frame indicating that the user has been unmuted.
 *
 * Emitted when a mute strategy deactivates, allowing user frames to propagate
 * through the pipeline again.
 */
export class UserMuteStoppedFrame extends SystemFrame {}

/**
 * Frame indicating the user is speaking.
 *
 * Emitted by VAD to indicate the user is speaking.
 */
export class UserSpeakingFrame extends SystemFrame {}

/**
 * Frame indicating that the user turn is semantically complete.
 *
 * Emitted by any component that can judge conversational turn completeness —
 * for example an LLM with turn-completion markers, an STT service with
 * built-in turn detection, or a dedicated end-of-turn classifier. Stop
 * strategies that gate the user-turn-stop event on an external completeness
 * signal (e.g. `LLMTurnCompletionUserTurnStopStrategy`) consume this frame to
 * finalize the turn. Producers should emit this frame only when they judge the
 * turn complete; an absence of this frame means the turn is not yet considered
 * complete.
 */
export class UserTurnInferenceCompletedFrame extends SystemFrame {}

export interface VADUserStartedSpeakingFrameOptions {
  /** The VAD start_secs duration that was used to confirm the user started speaking. */
  startSecs?: number;
  /** Wall-clock time (seconds) when the VAD made its determination. */
  timestamp?: number;
}

/**
 * Frame emitted when VAD definitively detects user started speaking.
 *
 * - `startSecs`: the VAD `startSecs` duration that was used to confirm the
 *   user started speaking. This represents the speech duration that had to
 *   elapse before the VAD determined speech began.
 * - `timestamp`: wall-clock time when the VAD made its determination.
 */
export class VADUserStartedSpeakingFrame extends SystemFrame {
  startSecs: number;
  timestamp: number;

  constructor(options: VADUserStartedSpeakingFrameOptions = {}) {
    super(options);
    this.startSecs = options.startSecs ?? 0.0;
    this.timestamp = options.timestamp ?? time();
  }
}

export interface VADUserStoppedSpeakingFrameOptions {
  /** The VAD stop_secs duration that was used to confirm the user stopped speaking. */
  stopSecs?: number;
  /** Wall-clock time (seconds) when the VAD made its determination. */
  timestamp?: number;
}

/**
 * Frame emitted when VAD definitively detects user stopped speaking.
 *
 * - `stopSecs`: the VAD `stopSecs` duration that was used to confirm the user
 *   stopped speaking. This represents the silence duration that had to elapse
 *   before the VAD determined speech ended.
 * - `timestamp`: wall-clock time when the VAD made its determination.
 */
export class VADUserStoppedSpeakingFrame extends SystemFrame {
  stopSecs: number;
  timestamp: number;

  constructor(options: VADUserStoppedSpeakingFrameOptions = {}) {
    super(options);
    this.stopSecs = options.stopSecs ?? 0.0;
    this.timestamp = options.timestamp ?? time();
  }
}

/**
 * Frame proposing that the user turn has started.
 *
 * Emitted by a component with its own turn detection — typically an STT or
 * realtime LLM service whose provider reports speech boundaries. It is a
 * proposal, not a decision: an `ExternalUserTurnStartStrategy` resolves it
 * into a `UserStartedSpeakingFrame` and broadcasts the interruption.
 *
 * This is a system frame because resolving it broadcasts an interruption,
 * which must preempt queued frames rather than wait behind them. Its
 * end-of-turn counterpart has the opposite requirement and is a control
 * frame; see `ProposedUserStoppedSpeakingFrame`.
 */
export class ProposedUserStartedSpeakingFrame extends SystemFrame {}

/**
 * Frame proposing that the user turn has ended.
 *
 * The end-of-turn counterpart to `ProposedUserStartedSpeakingFrame`, resolved
 * into a `UserStoppedSpeakingFrame` by an `ExternalUserTurnStopStrategy`.
 *
 * This is a control frame so it stays ordered against the final
 * `TranscriptionFrame`. A service with its own turn detection pushes that
 * transcript and then proposes the stop, and the turn strategy needs that text
 * in hand to close the turn on.
 */
export class ProposedUserStoppedSpeakingFrame extends ControlFrame {}

/**
 * Frame indicating the bot started speaking.
 *
 * Emitted upstream and downstream by the BaseTransportOutput to indicate the
 * bot started speaking.
 */
export class BotStartedSpeakingFrame extends SystemFrame {}

/**
 * Frame indicating the bot stopped speaking.
 *
 * Emitted upstream and downstream by the BaseTransportOutput to indicate the
 * bot stopped speaking.
 */
export class BotStoppedSpeakingFrame extends SystemFrame {}

/**
 * Frame indicating the bot is currently speaking.
 *
 * Emitted upstream and downstream by the BaseOutputTransport while the bot is
 * still speaking. This can be used, for example, to detect when a user is
 * idle. That is, while the bot is speaking we don't want to trigger any user
 * idle timeout since the user might be listening.
 */
export class BotSpeakingFrame extends SystemFrame {}

export interface MetricsFrameOptions {
  /** List of metrics data collected by the processor. */
  data: MetricsData[];
}

/**
 * Frame containing performance metrics data.
 *
 * Emitted by processors that can compute metrics like latencies.
 *
 * - `data`: list of metrics data collected by the processor.
 */
export class MetricsFrame extends SystemFrame {
  data: MetricsData[];

  constructor(options: MetricsFrameOptions) {
    super(options);
    this.data = options.data;
  }
}

export interface FunctionCallFromLLMOptions {
  /** The name of the function to call. */
  functionName: string;
  /** A unique identifier for the function call. */
  toolCallId: string;
  /** The arguments to pass to the function. */
  arguments: Record<string, unknown>;
  /** The LLM context when the function call was made. */
  context: unknown;
}

/**
 * Represents a function call returned by the LLM.
 *
 * Represents a function call returned by the LLM to be registered for execution.
 *
 * - `functionName`: the name of the function to call.
 * - `toolCallId`: a unique identifier for the function call.
 * - `arguments`: the arguments to pass to the function.
 * - `context`: the LLM context when the function call was made.
 */
export class FunctionCallFromLLM {
  functionName: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
  context: unknown;

  constructor(options: FunctionCallFromLLMOptions) {
    this.functionName = options.functionName;
    this.toolCallId = options.toolCallId;
    this.arguments = options.arguments;
    this.context = options.context;
  }
}

export interface FunctionCallsStartedFrameOptions {
  /** Sequence of function calls that will be executed. */
  functionCalls: FunctionCallFromLLM[];
}

/**
 * Frame signaling that function call execution is starting.
 *
 * A frame signaling that one or more function call execution is going to
 * start.
 *
 * - `functionCalls`: sequence of function calls that will be executed.
 */
export class FunctionCallsStartedFrame extends SystemFrame {
  functionCalls: FunctionCallFromLLM[];

  constructor(options: FunctionCallsStartedFrameOptions) {
    super(options);
    this.functionCalls = options.functionCalls;
  }
}

export interface ExternalFunctionCallOptions {
  /** Name of the function called. */
  functionName: string;
  /** Unique identifier of the call. */
  toolCallId: string;
}

/**
 * A function call made outside this pipeline, as announced to it.
 *
 * What `ExternalFunctionCallsStartedFrame` carries, one per call.
 *
 * - `functionName`: name of the function called.
 * - `toolCallId`: unique identifier of the call.
 */
export class ExternalFunctionCall {
  functionName: string;
  toolCallId: string;

  constructor(options: ExternalFunctionCallOptions) {
    this.functionName = options.functionName;
    this.toolCallId = options.toolCallId;
  }
}

export interface ExternalFunctionCallsStartedFrameOptions {
  /** The calls made. */
  functionCalls: ExternalFunctionCall[];
}

/**
 * Function calls were made outside this pipeline: `FunctionCallsStartedFrame`'s counterpart.
 *
 * Nothing in the pipeline acts on one; observers report it as they report the
 * pipeline's own. The calls ran elsewhere, e.g. in a backend worker's pipeline
 * on behalf of a tool here, and belong to that pipeline's conversation, not
 * this one. Like its counterpart it carries every call announced together,
 * which may be one. Each call's later phases come as
 * `ExternalFunctionCallInProgressFrame`, `ExternalFunctionCallResultFrame` and
 * `ExternalFunctionCallCancelFrame`.
 *
 * - `functionCalls`: the calls made.
 */
export class ExternalFunctionCallsStartedFrame extends SystemFrame {
  functionCalls: ExternalFunctionCall[];

  constructor(options: ExternalFunctionCallsStartedFrameOptions) {
    super(options);
    this.functionCalls = options.functionCalls;
  }
}

export interface ExternalFunctionCallInProgressFrameOptions {
  /** Name of the function called. */
  functionName: string;
  /** Unique identifier of the call. */
  toolCallId: string;
  /** Arguments passed to the function. */
  arguments: unknown;
}

/**
 * An external function call is running: `FunctionCallInProgressFrame`'s counterpart.
 *
 * Nothing in the pipeline acts on one; observers report it as they report the
 * pipeline's own. The call ran elsewhere, e.g. in a backend worker's pipeline
 * on behalf of a tool here, and belongs to that pipeline's conversation, not
 * this one.
 *
 * - `functionName`: name of the function called.
 * - `toolCallId`: unique identifier of the call.
 * - `arguments`: arguments passed to the function.
 */
export class ExternalFunctionCallInProgressFrame extends SystemFrame {
  functionName: string;
  toolCallId: string;
  arguments: unknown;

  constructor(options: ExternalFunctionCallInProgressFrameOptions) {
    super(options);
    this.functionName = options.functionName;
    this.toolCallId = options.toolCallId;
    this.arguments = options.arguments;
  }
}

export interface ExternalFunctionCallResultFrameOptions {
  /** Name of the function called. */
  functionName: string;
  /** Unique identifier of the call. */
  toolCallId: string;
  /** Arguments passed to the function. */
  arguments: unknown;
  /** The result. */
  result: unknown;
  /** Whether this result completes the call. Defaults to true. */
  isFinal?: boolean;
}

/**
 * An external function call produced a result: `FunctionCallResultFrame`'s counterpart.
 *
 * Nothing in the pipeline acts on one; observers report it as they report the
 * pipeline's own.
 *
 * - `functionName`: name of the function called.
 * - `toolCallId`: unique identifier of the call.
 * - `arguments`: arguments passed to the function.
 * - `result`: the result.
 * - `isFinal`: whether this result completes the call, or is one of a stream
 *   of intermediate results before the final one.
 */
export class ExternalFunctionCallResultFrame extends SystemFrame {
  functionName: string;
  toolCallId: string;
  arguments: unknown;
  result: unknown;
  isFinal: boolean;

  constructor(options: ExternalFunctionCallResultFrameOptions) {
    super(options);
    this.functionName = options.functionName;
    this.toolCallId = options.toolCallId;
    this.arguments = options.arguments;
    this.result = options.result;
    this.isFinal = options.isFinal ?? true;
  }
}

export interface ExternalFunctionCallCancelFrameOptions {
  /** Name of the function called. */
  functionName: string;
  /** Unique identifier of the call. */
  toolCallId: string;
}

/**
 * An external function call was cancelled: `FunctionCallCancelFrame`'s counterpart.
 *
 * Nothing in the pipeline acts on one; observers report it as they report the
 * pipeline's own.
 *
 * - `functionName`: name of the function called.
 * - `toolCallId`: unique identifier of the call.
 */
export class ExternalFunctionCallCancelFrame extends SystemFrame {
  functionName: string;
  toolCallId: string;

  constructor(options: ExternalFunctionCallCancelFrameOptions) {
    super(options);
    this.functionName = options.functionName;
    this.toolCallId = options.toolCallId;
  }
}

export interface FunctionCallCancelFrameOptions {
  /** Name of the function that was cancelled. */
  functionName: string;
  /** Unique identifier for the cancelled function call. */
  toolCallId: string;
  /** Whether to run the LLM after this cancellation. Defaults to false. */
  runLlm?: boolean;
}

/**
 * Frame signaling that a function call has been cancelled.
 *
 * - `functionName`: name of the function that was cancelled.
 * - `toolCallId`: unique identifier for the cancelled function call.
 * - `runLlm`: whether to run the LLM after this cancellation. Only a call
 *   cancelled by its own timeout sets this: an interruption must not trigger
 *   inference, and a cancellation the LLM asked for already runs inference
 *   through the result of the tool that requested it.
 */
export class FunctionCallCancelFrame extends SystemFrame {
  functionName: string;
  toolCallId: string;
  runLlm: boolean;

  constructor(options: FunctionCallCancelFrameOptions) {
    super(options);
    this.functionName = options.functionName;
    this.toolCallId = options.toolCallId;
    this.runLlm = options.runLlm ?? false;
  }
}

export interface STTMuteFrameOptions {
  /** Whether to mute (true) or unmute (false) the STT service. */
  mute: boolean;
}

/**
 * Frame to mute/unmute the Speech-to-Text service.
 *
 * - `mute`: whether to mute (true) or unmute (false) the STT service.
 */
export class STTMuteFrame extends SystemFrame {
  mute: boolean;

  constructor(options: STTMuteFrameOptions) {
    super(options);
    this.mute = options.mute;
  }
}

export interface InputTransportMessageFrameOptions {
  /** The transport message payload. */
  message: unknown;
}

/**
 * Frame for transport messages received from external sources.
 *
 * - `message`: the urgent transport message payload.
 */
export class InputTransportMessageFrame extends SystemFrame {
  message: unknown;

  constructor(options: InputTransportMessageFrameOptions) {
    super(options);
    this.message = options.message;
  }

  override toString(): string {
    return `${this.name}(message: ${this.message})`;
  }
}

export interface OutputTransportMessageUrgentFrameOptions {
  /** The urgent transport message payload. */
  message: unknown;
}

/**
 * Frame for urgent transport messages that need to be sent immediately.
 *
 * - `message`: the urgent transport message payload.
 */
export class OutputTransportMessageUrgentFrame extends SystemFrame {
  message: unknown;

  constructor(options: OutputTransportMessageUrgentFrameOptions) {
    super(options);
    this.message = options.message;
  }

  override toString(): string {
    return `${this.name}(message: ${this.message})`;
  }
}

export interface UserImageRequestFrameOptions {
  /** Identifier of the user to request image from. */
  userId: string;
  /** An optional text associated to the image request. */
  text?: string | null;
  /** Whether the requested image should be appended to the LLM context. */
  appendToContext?: boolean | null;
  /** Specific video source to capture from. */
  videoSource?: string | null;
  /** Name of function that generated this request (if any). */
  functionName?: string | null;
  /** Tool call ID if generated by function call (if any). */
  toolCallId?: string | null;
  /** Optional callback to invoke when the image is retrieved. */
  resultCallback?: unknown;
}

/**
 * Frame requesting an image from a specific user.
 *
 * A frame to request an image from the given user. The request might come
 * with a text that can be later used to describe the requested image.
 *
 * - `userId`: identifier of the user to request image from.
 * - `text`: an optional text associated to the image request.
 * - `appendToContext`: whether the requested image should be appended to the
 *   LLM context.
 * - `videoSource`: specific video source to capture from.
 * - `functionName`: name of function that generated this request (if any).
 * - `toolCallId`: tool call ID if generated by function call (if any).
 * - `resultCallback`: optional callback to invoke when the image is retrieved.
 */
export class UserImageRequestFrame extends SystemFrame {
  userId: string;
  text: string | null;
  appendToContext: boolean | null;
  videoSource: string | null;
  functionName: string | null;
  toolCallId: string | null;
  resultCallback: unknown;

  constructor(options: UserImageRequestFrameOptions) {
    super(options);
    this.userId = options.userId;
    this.text = options.text ?? null;
    this.appendToContext = options.appendToContext ?? null;
    this.videoSource = options.videoSource ?? null;
    this.functionName = options.functionName ?? null;
    this.toolCallId = options.toolCallId ?? null;
    this.resultCallback = options.resultCallback ?? null;
  }

  override toString(): string {
    return `${this.name}(user: ${this.userId}, text: ${this.text}, append_to_context: ${this.appendToContext}, ${this.videoSource})`;
  }
}

/**
 * Raw audio input frame from transport.
 *
 * A chunk of audio usually coming from an input transport. If the transport
 * supports multiple audio sources (e.g. multiple audio tracks) the source name
 * will be specified in `transportSource`.
 */
export class InputAudioRawFrame extends AudioRawFrame(SystemFrame) {
  constructor(options: AudioRawFrameOptions) {
    super(options);
  }

  override toString(): string {
    const pts = formatPts(this.pts);
    return `${this.name}(pts: ${pts}, source: ${this.transportSource}, size: ${this.audio.length}, frames: ${this.numFrames}, sample_rate: ${this.sampleRate}, channels: ${this.numChannels})`;
  }
}

/**
 * Raw image input frame from transport.
 *
 * An image usually coming from an input transport. If the transport supports
 * multiple video sources (e.g. multiple video tracks) the source name will be
 * specified in `transportSource`.
 */
export class InputImageRawFrame extends ImageRawFrame(SystemFrame) {
  constructor(options: ImageRawFrameOptions) {
    super(options);
  }

  override toString(): string {
    const pts = formatPts(this.pts);
    return `${this.name}(pts: ${pts}, source: ${this.transportSource}, size: ${formatSize(this.size)}, format: ${this.format})`;
  }
}

/**
 * Raw file input frame.
 *
 * A file usually coming from RTVI.
 */
export class InputFileRawFrame extends FileRawFrame(SystemFrame) {
  constructor(options: FileRawFrameOptions) {
    super(options);
  }

  override toString(): string {
    const pts = formatPts(this.pts);
    return `${this.name}(pts: ${pts}, type: ${this.type})`;
  }
}

/**
 * Raw text input frame from transport.
 *
 * Text input usually coming from user typing or programmatic text injection
 * that should be sent to LLM services as input, similar to how
 * InputAudioRawFrame and InputImageRawFrame represent user audio and video
 * input.
 *
 * Upstream inherits from both `SystemFrame` and `TextFrame`; here it extends
 * `SystemFrame`, carries `TextFrame`'s fields, and `instanceof TextFrame`
 * holds through `addVirtualBase`.
 */
export class InputTextRawFrame extends SystemFrame {
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
    return `${this.name}(pts: ${pts}, source: ${this.transportSource}, text: [${this.text}])`;
  }
}
addVirtualBase(InputTextRawFrame, TextFrame);

export interface UserAudioRawFrameOptions extends AudioRawFrameOptions {
  /** Identifier of the user who provided this audio. */
  userId?: string;
}

/**
 * Raw audio input frame associated with a specific user.
 *
 * A chunk of audio, usually coming from an input transport, associated to a user.
 *
 * - `userId`: identifier of the user who provided this audio.
 */
export class UserAudioRawFrame extends InputAudioRawFrame {
  userId: string;

  constructor(options: UserAudioRawFrameOptions) {
    super(options);
    this.userId = options.userId ?? "";
  }

  override toString(): string {
    const pts = formatPts(this.pts);
    return `${this.name}(pts: ${pts}, user: ${this.userId}, source: ${this.transportSource}, size: ${this.audio.length}, frames: ${this.numFrames}, sample_rate: ${this.sampleRate}, channels: ${this.numChannels})`;
  }
}

export interface UserImageRawFrameOptions extends ImageRawFrameOptions {
  /** Identifier of the user who provided this image. */
  userId?: string;
  /** An optional text associated to this image. */
  text?: string | null;
  /** Whether the requested image should be appended to the LLM context. */
  appendToContext?: boolean | null;
  /** The original image request frame if this is a response. */
  request?: UserImageRequestFrame | null;
  /** Whether appending this image should trigger an LLM completion. */
  runLlm?: boolean | null;
}

/**
 * Raw image input frame associated with a specific user.
 *
 * An image associated to a user, potentially in response to an image request.
 *
 * - `userId`: identifier of the user who provided this image.
 * - `text`: an optional text associated to this image.
 * - `appendToContext`: whether the requested image should be appended to the
 *   LLM context.
 * - `request`: the original image request frame if this is a response.
 * - `runLlm`: whether appending this image should trigger an LLM completion.
 *   Null (the default) preserves the old unconditional-trigger behavior; only
 *   an explicit false suppresses it.
 */
export class UserImageRawFrame extends InputImageRawFrame {
  userId: string;
  text: string | null;
  appendToContext: boolean | null;
  request: UserImageRequestFrame | null;
  runLlm: boolean | null;

  constructor(options: UserImageRawFrameOptions) {
    super(options);
    this.userId = options.userId ?? "";
    this.text = options.text ?? null;
    this.appendToContext = options.appendToContext ?? null;
    this.request = options.request ?? null;
    this.runLlm = options.runLlm ?? null;
  }

  override toString(): string {
    const pts = formatPts(this.pts);
    return `${this.name}(pts: ${pts}, user: ${this.userId}, source: ${this.transportSource}, size: ${formatSize(this.size)}, format: ${this.format}, text: ${this.text}, append_to_context: ${this.appendToContext})`;
  }
}

export interface UserFileRawFrameOptions extends FileRawFrameOptions {
  /** Identifier of the user who provided this file. */
  userId?: string;
  /** Text associated to this file. */
  text?: string;
  /** Whether the requested file should be appended to the LLM context. */
  appendToContext?: boolean | null;
  /** Custom llm-specific options to be used when processing this file. */
  customOptions?: Record<string, unknown> | null;
  /** Whether appending this file should trigger an LLM completion. */
  runLlm?: boolean | null;
}

/**
 * Raw file input frame associated with a specific user.
 *
 * A file associated to a user.
 *
 * - `userId`: identifier of the user who provided this file.
 * - `text`: text associated to this file.
 * - `appendToContext`: whether the requested file should be appended to the
 *   LLM context.
 * - `customOptions`: dictionary of custom llm-specific options to be used when
 *   processing this file, like 'detail' in openAI or 'citations' in Bedrock.
 * - `runLlm`: whether appending this file should trigger an LLM completion.
 *   Null (the default) preserves the old unconditional-trigger behavior; only
 *   an explicit false suppresses it.
 */
export class UserFileRawFrame extends InputFileRawFrame {
  userId: string;
  text: string;
  appendToContext: boolean | null;
  customOptions: Record<string, unknown> | null;
  runLlm: boolean | null;

  constructor(options: UserFileRawFrameOptions) {
    super(options);
    this.userId = options.userId ?? "";
    this.text = options.text ?? "";
    this.appendToContext = options.appendToContext ?? null;
    this.customOptions = options.customOptions ?? null;
    this.runLlm = options.runLlm ?? null;
  }

  override toString(): string {
    const pts = formatPts(this.pts);
    return `${this.name}(pts: ${pts}, user: ${this.userId}, format: ${this.format}, type: ${this.type}, text: ${this.text}, append_to_context: ${this.appendToContext})`;
  }
}

export interface AssistantImageRawFrameOptions extends ImageRawFrameOptions {
  /** The original image data, usable directly in an LLM context message. */
  originalData?: Uint8Array | null;
  /** The MIME type of the original image data. */
  originalMimeType?: string | null;
}

/**
 * Frame containing an image generated by the assistant.
 *
 * Contains both the raw frame for display (superclass functionality) as well
 * as the original image, which can get used directly in LLM contexts.
 *
 * - `originalData`: the original image data, which can get used directly in
 *   an LLM context message without further encoding.
 * - `originalMimeType`: the MIME type of the original image data.
 */
export class AssistantImageRawFrame extends OutputImageRawFrame {
  originalData: Uint8Array | null;
  originalMimeType: string | null;

  constructor(options: AssistantImageRawFrameOptions) {
    super(options);
    this.originalData = options.originalData ?? null;
    this.originalMimeType = options.originalMimeType ?? null;
  }
}

export interface InputDTMFFrameOptions {
  /** The DTMF keypad entry that was pressed. */
  button: KeypadEntry;
}

/**
 * DTMF keypress input frame from transport.
 *
 * - `button`: the DTMF keypad entry that was pressed.
 */
export class InputDTMFFrame extends DTMFFrame(SystemFrame) {
  button: KeypadEntry;

  constructor(options: InputDTMFFrameOptions) {
    super(options);
    this.button = options.button;
  }

  override toString(): string {
    return `${this.name}(tone: ${this.button})`;
  }
}

export interface OutputDTMFUrgentFrameOptions {
  /** Convenience shortcut for sending a single DTMF keypad entry. */
  button?: KeypadEntry | null;
  /** Sequence of one or more DTMF keypad buttons to send. */
  buttons?: KeypadEntry[] | null;
}

/**
 * DTMF keypress output frame for immediate sending.
 *
 * - `button`: convenience shortcut for sending a single DTMF keypad entry.
 *   Equivalent to `buttons: [button]`. If both `buttons` and `button` are
 *   provided, `buttons` takes precedence.
 * - `buttons`: sequence of one or more DTMF keypad buttons to send. Use
 *   `fromString()` to build this from a string like `"123#"`.
 */
export class OutputDTMFUrgentFrame extends DTMFFrame(SystemFrame) {
  button: KeypadEntry | null;
  buttons: KeypadEntry[] | null;

  constructor(options: OutputDTMFUrgentFrameOptions = {}) {
    super(options);
    this.button = options.button ?? null;
    this.buttons = options.buttons ?? null;
    if (this.buttons === null && this.button !== null) {
      this.buttons = [this.button];
    }
    if (!this.buttons || this.buttons.length === 0) {
      throw new Error(`${this.constructor.name} requires \`buttons\` or \`button\` to be set`);
    }
  }

  override toString(): string {
    return `${this.name}(buttons: ${this.toDialString()})`;
  }

  /**
   * Build an `OutputDTMFUrgentFrame` from a string of DTMF characters.
   *
   * @param buttons A string like `"123#"`. Each character must be a valid
   *   `KeypadEntry` value.
   * @param options Additional options forwarded to the frame constructor.
   * @returns A frame of this class with `buttons` populated as a list of `KeypadEntry`.
   */
  static fromString<T extends OutputDTMFUrgentFrame>(
    this: new (
      options: OutputDTMFUrgentFrameOptions,
    ) => T,
    buttons: string,
    options: Omit<OutputDTMFUrgentFrameOptions, "buttons"> = {},
  ): T {
    return new this({ ...options, buttons: [...buttons].map(toKeypadEntry) });
  }

  /**
   * Return the frame's `buttons` as a dial string. Upstream's `to_string()`;
   * renamed because `toString()` is the JS `__str__`.
   *
   * @returns A string such as `"123#"` formed by concatenating each
   *   `KeypadEntry` in `buttons`, or an empty string if `buttons` is not set.
   */
  toDialString(): string {
    return this.buttons ? this.buttons.join("") : "";
  }
}

export interface SpeechControlParamsFrameOptions {
  /** Current VAD parameters. */
  vadParams?: VADParams | null;
  /** Current turn-taking analysis parameters. */
  turnParams?: BaseTurnParams | null;
}

/**
 * Frame for notifying processors of speech control parameter changes.
 *
 * This includes parameters for both VAD (Voice Activity Detection) and
 * turn-taking analysis. It allows downstream processors to adjust their
 * behavior based on updated interaction control settings.
 *
 * - `vadParams`: current VAD parameters.
 * - `turnParams`: current turn-taking analysis parameters.
 */
export class SpeechControlParamsFrame extends SystemFrame {
  vadParams: VADParams | null;
  turnParams: BaseTurnParams | null;

  constructor(options: SpeechControlParamsFrameOptions = {}) {
    super(options);
    this.vadParams = options.vadParams ?? null;
    this.turnParams = options.turnParams ?? null;
  }
}

export interface ServiceMetadataFrameOptions {
  /** The name of the service broadcasting this metadata. */
  serviceName: string;
  /** User turn strategies the service recommends. */
  userTurnStrategies?: UserTurnStrategies | null;
}

/**
 * Base metadata frame for services.
 *
 * Broadcast by services at pipeline start to share service-specific
 * configuration and performance characteristics with downstream processors.
 *
 * - `serviceName`: the name of the service broadcasting this metadata.
 * - `userTurnStrategies`: user turn strategies the service recommends, e.g.
 *   `ExternalUserTurnStrategies` for a service that does its own server-side
 *   end-of-turn detection. The user aggregator applies them unless the user
 *   passed their own `userTurnStrategies`, which always wins. Null leaves the
 *   defaults in place.
 */
export class ServiceMetadataFrame extends SystemFrame {
  serviceName: string;
  userTurnStrategies: UserTurnStrategies | null;

  constructor(options: ServiceMetadataFrameOptions) {
    super(options);
    this.serviceName = options.serviceName;
    this.userTurnStrategies = options.userTurnStrategies ?? null;
  }
}

export interface STTMetadataFrameOptions extends ServiceMetadataFrameOptions {
  /** Time to final segment P99 latency in seconds. */
  ttfsP99Latency: number;
}

/**
 * Metadata from STT service.
 *
 * Broadcast by STT services to inform downstream processors (like turn
 * strategies) about STT latency characteristics.
 *
 * - `ttfsP99Latency`: time to final segment P99 latency in seconds. This is
 *   the expected time from when speech ends to when the final transcript is
 *   received, at the 99th percentile.
 */
export class STTMetadataFrame extends ServiceMetadataFrame {
  ttfsP99Latency: number;

  constructor(options: STTMetadataFrameOptions) {
    super(options);
    this.ttfsP99Latency = options.ttfsP99Latency;
  }
}

export interface LLMServiceMetadataFrameOptions extends ServiceMetadataFrameOptions {
  /** Whether the broadcasting service is a realtime (speech-to-speech) LLM service. */
  isRealtimeService?: boolean;
}

/**
 * Metadata broadcast by an LLM service at pipeline start.
 *
 * - `isRealtimeService`: whether the broadcasting service is a realtime
 *   (speech-to-speech) LLM service.
 */
export class LLMServiceMetadataFrame extends ServiceMetadataFrame {
  isRealtimeService: boolean;

  constructor(options: LLMServiceMetadataFrameOptions) {
    super(options);
    this.isRealtimeService = options.isRealtimeService ?? false;
  }
}

export interface ServiceSwitcherRequestMetadataFrameOptions {
  /** The target service that should re-emit its metadata. */
  service: FrameProcessor;
}

/**
 * Request a service to re-emit its metadata frames.
 *
 * Used by ServiceSwitcher when switching active services to ensure downstream
 * processors receive updated metadata from the newly active service. Services
 * that receive this frame should re-push their metadata frame (e.g.,
 * STTMetadataFrame for STT services).
 *
 * - `service`: the target service that should re-emit its metadata.
 */
export class ServiceSwitcherRequestMetadataFrame extends ControlFrame {
  service: FrameProcessor;

  constructor(options: ServiceSwitcherRequestMetadataFrameOptions) {
    super(options);
    this.service = options.service;
  }
}

//
// Worker frames
//

/**
 * Base frame for worker frames.
 *
 * This is a base class for frames that are handled by the pipeline worker.
 * This might result in a corresponding frame sent downstream (e.g.
 * `InterruptionWorkerFrame` / `InterruptionFrame` or `EndWorkerFrame` /
 * `EndFrame`). Push these frames downstream (the default direction) so frames
 * queued ahead of them are processed first; pushing them upstream is also
 * supported.
 */
export class WorkerFrame extends ControlFrame {}

/**
 * Base frame for worker system frames.
 *
 * This is a base class for system frames that are handled by the pipeline
 * worker. This might result in a corresponding frame sent downstream (e.g.
 * `InterruptionWorkerFrame` / `InterruptionFrame` or `CancelWorkerFrame` /
 * `CancelFrame`). They can be pushed in either direction (downstream is the
 * default); being system frames, they are processed immediately either way.
 */
export class WorkerSystemFrame extends SystemFrame {}

export interface EndWorkerFrameOptions {
  /** Optional reason for pushing an end frame. */
  reason?: unknown;
}

/**
 * Frame to request graceful pipeline worker closure.
 *
 * This is used to notify the pipeline worker that the pipeline should be
 * closed nicely (flushing all the queued frames) by pushing an EndFrame
 * downstream. Push this frame downstream (the default direction) so frames
 * queued ahead of it are flushed before the pipeline ends.
 *
 * - `reason`: optional reason for pushing an end frame.
 */
export class EndWorkerFrame extends WorkerFrame {
  override interruptible = false;

  reason: unknown;

  constructor(options: EndWorkerFrameOptions = {}) {
    super(options);
    this.reason = options.reason ?? null;
  }

  override toString(): string {
    return `${this.name}(reason: ${this.reason})`;
  }
}

/**
 * Frame to request pipeline worker stop while keeping processors running.
 *
 * This is used to notify the pipeline worker that it should be stopped as
 * soon as possible (flushing all the queued frames) but that the pipeline
 * processors should be kept in a running state. Push this frame downstream
 * (the default direction) so frames queued ahead of it are flushed first.
 */
export class StopWorkerFrame extends WorkerFrame {
  override interruptible = false;
}

export interface CancelWorkerFrameOptions {
  /** Optional reason for pushing a cancel frame. */
  reason?: unknown;
}

/**
 * Frame to request immediate pipeline worker cancellation.
 *
 * This is used to notify the pipeline worker that the pipeline should be
 * stopped immediately by pushing a CancelFrame downstream. It can be pushed in
 * either direction; being a system frame, it is processed immediately.
 *
 * - `reason`: optional reason for pushing a cancel frame.
 */
export class CancelWorkerFrame extends WorkerSystemFrame {
  reason: unknown;

  constructor(options: CancelWorkerFrameOptions = {}) {
    super(options);
    this.reason = options.reason ?? null;
  }

  override toString(): string {
    return `${this.name}(reason: ${this.reason})`;
  }
}

/**
 * Frame indicating the pipeline should be interrupted.
 *
 * The pipeline worker converts this into an `InterruptionFrame` and sends it
 * downstream. It can be pushed in either direction; being a system frame, it
 * is processed immediately.
 */
export class InterruptionWorkerFrame extends WorkerSystemFrame {}

//
// Control frames
//

export interface EndFrameOptions {
  /** Optional reason for pushing an end frame. */
  reason?: unknown;
}

/**
 * Frame indicating pipeline has ended and should shut down.
 *
 * Indicates that a pipeline has ended and frame processors and pipelines
 * should be shut down. If the transport receives this frame, it will stop
 * sending frames to its output channel(s) and close all its threads. Note,
 * that this is a control frame, which means it will be received in the order
 * it was sent.
 *
 * This frame is uninterruptible so it is not lost when an InterruptionFrame
 * is processed. Terminal frames must survive interruption to guarantee proper
 * pipeline shutdown.
 *
 * - `reason`: optional reason for pushing an end frame.
 */
export class EndFrame extends ControlFrame {
  override interruptible = false;

  reason: unknown;

  constructor(options: EndFrameOptions = {}) {
    super(options);
    this.reason = options.reason ?? null;
  }

  override toString(): string {
    return `${this.name}(reason: ${this.reason})`;
  }
}

/**
 * Frame indicating pipeline should stop but keep processors running.
 *
 * Indicates that a pipeline should be stopped but that the pipeline processors
 * should be kept in a running state. This is normally queued from the
 * pipeline task.
 *
 * This frame is uninterruptible so it is not lost when an InterruptionFrame
 * is processed. Terminal frames must survive interruption to guarantee proper
 * pipeline control.
 */
export class StopFrame extends ControlFrame {
  override interruptible = false;
}

export interface PipelineFlushFrameOptions {
  /** Set by the worker when the probe completes its round-trip. */
  event?: Event | null;
  /** Whether the probe is on its second pass downstream. */
  returning?: boolean;
  /** Name of the worker that started the flush. */
  origin?: string | null;
}

/**
 * Probe frame used to flush all in-flight frames from the pipeline.
 *
 * Pushed downstream; the pipeline worker's sink bounces it back upstream, the
 * source turns it around, and the worker sets `event` when it reaches the sink
 * a second time. Once that fires, every frame queued ahead of the probe has
 * been processed, along with anything a processor started by pushing
 * upstream. Useful to wait for the pipeline to drain (e.g. after an
 * interruption) before injecting a new frame.
 *
 * This frame is uninterruptible so the probe survives an InterruptionFrame and
 * still completes its trip.
 *
 * - `event`: set by the worker when the probe completes its round-trip. The
 *   initiator awaits it to know the pipeline has drained. Carried on the frame
 *   so concurrent flushes stay isolated (each awaits its own).
 * - `returning`: whether the probe is on its second pass downstream, after
 *   having been back up to the source. Work a processor starts by pushing
 *   upstream — an LLM run triggered by a function call result, say — only
 *   reaches the sink after that turnaround, so the probe makes the trip twice
 *   and settles on the second arrival.
 * - `origin`: name of the worker that started the flush. A probe that crosses
 *   into another pipeline is answered there, out of sight of whoever is
 *   waiting, so the answering worker reports progress back to this name.
 */
export class PipelineFlushFrame extends ControlFrame {
  override interruptible = false;

  event: Event | null;
  returning: boolean;
  origin: string | null;

  constructor(options: PipelineFlushFrameOptions = {}) {
    super(options);
    this.event = options.event ?? null;
    this.returning = options.returning ?? false;
    this.origin = options.origin ?? null;
  }
}

/**
 * Frame indicating the bot has connected to the transport service.
 *
 * Pushed downstream by SFU transports (Daily, LiveKit, HeyGen, Tavus) when the
 * bot successfully joins the room. Non-SFU transports do not emit this frame.
 */
export class BotConnectedFrame extends SystemFrame {}

/**
 * Frame indicating that a client has connected to the transport.
 *
 * Pushed downstream by the input transport when a client (participant)
 * connects. Used by observers to measure transport readiness timing.
 */
export class ClientConnectedFrame extends SystemFrame {}

/**
 * Frame indicating that the output transport is ready.
 *
 * Indicates that the output transport is ready and able to receive frames.
 */
export class OutputTransportReadyFrame extends ControlFrame {}

/**
 * Frame asking the input transport to start audio input streaming.
 *
 * Pushed downstream (e.g. by `RTVIProcessor` once the client is ready) so a
 * `BaseInputTransport` begins streaming audio from its source. Replaces
 * calling `BaseInputTransport.startAudioInStreaming()` directly, keeping
 * cross-processor communication frame-based.
 */
export class InputTransportStartAudioStreamingFrame extends ControlFrame {}

export interface HeartbeatFrameOptions {
  /** Timestamp when the heartbeat was generated. */
  timestamp: number;
}

/**
 * Frame used by pipeline task to monitor pipeline health.
 *
 * This frame is used by the pipeline task as a mechanism to know if the
 * pipeline is running properly.
 *
 * - `timestamp`: timestamp when the heartbeat was generated.
 */
export class HeartbeatFrame extends ControlFrame {
  timestamp: number;

  constructor(options: HeartbeatFrameOptions) {
    super(options);
    this.timestamp = options.timestamp;
  }
}

export interface FrameProcessorPauseFrameOptions {
  /** The frame processor to pause. */
  processor: FrameProcessor;
}

/**
 * Frame to pause frame processing for a specific processor.
 *
 * This frame is used to pause frame processing for the given processor.
 * Pausing frame processing will keep frames in the internal queue which will
 * then be processed when frame processing is resumed with
 * `FrameProcessorResumeFrame`.
 *
 * - `processor`: the frame processor to pause.
 */
export class FrameProcessorPauseFrame extends ControlFrame {
  processor: FrameProcessor;

  constructor(options: FrameProcessorPauseFrameOptions) {
    super(options);
    this.processor = options.processor;
  }
}

export interface FrameProcessorResumeFrameOptions {
  /** The frame processor to resume. */
  processor: FrameProcessor;
}

/**
 * Frame to resume frame processing for a specific processor.
 *
 * This frame is used to resume frame processing for the given processor if it
 * was previously paused. After resuming frame processing all queued frames
 * will be processed in the order received.
 *
 * This is a SystemFrame to ensure it bypasses the blocked processing queue
 * when the processor is paused. Otherwise, the resume frame would get queued
 * and never processed.
 *
 * Note: this frame is now equivalent to FrameProcessorResumeUrgentFrame.
 *
 * - `processor`: the frame processor to resume.
 */
export class FrameProcessorResumeFrame extends SystemFrame {
  processor: FrameProcessor;

  constructor(options: FrameProcessorResumeFrameOptions) {
    super(options);
    this.processor = options.processor;
  }
}

/**
 * Frame indicating the beginning of an LLM response.
 *
 * Used to indicate the beginning of an LLM response. Followed by one or more
 * TextFrames and a final LLMFullResponseEndFrame.
 *
 * - `skipTts`: whether the response should be skipped by the TTS service.
 */
export class LLMFullResponseStartFrame extends ControlFrame {
  skipTts: boolean | null = null;
}

/**
 * Frame indicating the end of an LLM response.
 *
 * - `skipTts`: whether the response should be skipped by the TTS service.
 */
export class LLMFullResponseEndFrame extends ControlFrame {
  skipTts: boolean | null = null;
}

/**
 * Frame that forces the LLM assistant aggregator to push its current aggregation to context.
 *
 * When received by `LLMAssistantAggregator`, any text that has been
 * accumulated in the aggregation buffer is immediately committed to the
 * conversation context as an assistant message, without waiting for an
 * `LLMFullResponseEndFrame`.
 */
export class LLMAssistantPushAggregationFrame extends ControlFrame {}

export interface LLMSummarizeContextFrameOptions {
  /** Optional per-request override for summary generation settings. */
  config?: LLMContextSummaryConfig | null;
}

/**
 * Frame requesting on-demand context summarization.
 *
 * Push this frame into the pipeline to trigger a manual context summarization.
 *
 * - `config`: optional per-request override for summary generation settings
 *   (prompt, token budget, messages to keep). If null, the summarizer's
 *   default `LLMContextSummaryConfig` is used.
 */
export class LLMSummarizeContextFrame extends ControlFrame {
  config: LLMContextSummaryConfig | null;

  constructor(options: LLMSummarizeContextFrameOptions = {}) {
    super(options);
    this.config = options.config ?? null;
  }
}

export interface LLMContextSummaryRequestFrameOptions {
  /** Unique identifier to match this request with its response. */
  requestId: string;
  /** The full LLM context containing all messages to analyze and summarize. */
  context: LLMContext;
  /** Number of recent messages to preserve uncompressed. */
  minMessagesToKeep: number;
  /** Maximum token size for the generated summary. */
  targetContextTokens: number;
  /** System prompt instructing the LLM how to generate the summary. */
  summarizationPrompt: string;
  /** Maximum time in seconds for the LLM to generate a summary. */
  summarizationTimeout?: number | null;
}

/**
 * Frame requesting context summarization from an LLM service.
 *
 * Sent by aggregators to LLM services when conversation context needs to be
 * compressed. The LLM service generates a summary of older messages while
 * preserving recent conversation history.
 *
 * - `requestId`: unique identifier to match this request with its response.
 *   Used to handle async responses and avoid race conditions.
 * - `context`: the full LLM context containing all messages to analyze and
 *   summarize.
 * - `minMessagesToKeep`: number of recent messages to preserve uncompressed.
 *   These messages will not be included in the summary.
 * - `targetContextTokens`: maximum token size for the generated summary. This
 *   value is passed directly to the LLM as the max_tokens parameter when
 *   generating the summary text.
 * - `summarizationPrompt`: system prompt instructing the LLM how to generate
 *   the summary.
 * - `summarizationTimeout`: maximum time in seconds for the LLM to generate a
 *   summary. When null, a default timeout of 120s is applied.
 */
export class LLMContextSummaryRequestFrame extends ControlFrame {
  requestId: string;
  context: LLMContext;
  minMessagesToKeep: number;
  targetContextTokens: number;
  summarizationPrompt: string;
  summarizationTimeout: number | null;

  constructor(options: LLMContextSummaryRequestFrameOptions) {
    super(options);
    this.requestId = options.requestId;
    this.context = options.context;
    this.minMessagesToKeep = options.minMessagesToKeep;
    this.targetContextTokens = options.targetContextTokens;
    this.summarizationPrompt = options.summarizationPrompt;
    this.summarizationTimeout = options.summarizationTimeout ?? null;
  }
}

export interface LLMContextSummaryResultFrameOptions {
  /** Identifier matching the original request. */
  requestId: string;
  /** The formatted summary message ready to be inserted into context. */
  summary: string;
  /** Index (0-based) of the last message that was included in the summary. */
  lastSummarizedIndex: number;
  /** Error message if summarization failed, null on success. */
  error?: string | null;
}

/**
 * Frame containing the result of context summarization.
 *
 * Sent by LLM services back to aggregators after generating a summary.
 * Contains the formatted summary message and metadata about what was
 * summarized.
 *
 * - `requestId`: identifier matching the original request. Used to correlate
 *   async responses.
 * - `summary`: the formatted summary message ready to be inserted into context.
 * - `lastSummarizedIndex`: index (0-based) of the last message that was
 *   included in the summary. Messages after this index are preserved.
 * - `error`: error message if summarization failed, null on success.
 */
export class LLMContextSummaryResultFrame extends ControlFrame {
  override interruptible = false;

  requestId: string;
  summary: string;
  lastSummarizedIndex: number;
  error: string | null;

  constructor(options: LLMContextSummaryResultFrameOptions) {
    super(options);
    this.requestId = options.requestId;
    this.summary = options.summary;
    this.lastSummarizedIndex = options.lastSummarizedIndex;
    this.error = options.error ?? null;
  }
}

export interface FunctionCallInProgressFrameOptions {
  /** Name of the function being executed. */
  functionName: string;
  /** Unique identifier for this function call. */
  toolCallId: string;
  /** Arguments passed to the function. */
  arguments: unknown;
  /** Whether to cancel this call if interrupted. Defaults to false. */
  cancelOnInterruption?: boolean;
  /** Identifier shared by all function calls from the same LLM response batch. */
  groupId?: string | null;
}

/**
 * Frame signaling that a function call is currently executing.
 *
 * This is an uninterruptible frame because we always want to update the
 * context.
 *
 * - `functionName`: name of the function being executed.
 * - `toolCallId`: unique identifier for this function call.
 * - `arguments`: arguments passed to the function.
 * - `cancelOnInterruption`: whether to cancel this call if interrupted. When
 *   false the call is treated as asynchronous: the conversation is not held
 *   while it runs, and a result that arrives after the conversation has moved
 *   on is injected via a developer message. A result that arrives before then
 *   settles in place like a synchronous call's.
 * - `groupId`: identifier shared by all function calls originating from the
 *   same LLM response batch. Used to determine when the last call in a group
 *   completes so the LLM can be triggered exactly once.
 */
export class FunctionCallInProgressFrame extends ControlFrame {
  override interruptible = false;

  functionName: string;
  toolCallId: string;
  arguments: unknown;
  cancelOnInterruption: boolean;
  groupId: string | null;

  constructor(options: FunctionCallInProgressFrameOptions) {
    super(options);
    this.functionName = options.functionName;
    this.toolCallId = options.toolCallId;
    this.arguments = options.arguments;
    this.cancelOnInterruption = options.cancelOnInterruption ?? false;
    this.groupId = options.groupId ?? null;
  }
}

/**
 * Frame indicating the beginning of a vision model response.
 *
 * Used to indicate the beginning of a vision model response. Followed by one
 * or more VisionTextFrames and a final VisionFullResponseEndFrame.
 */
export class VisionFullResponseStartFrame extends LLMFullResponseStartFrame {}

/** Frame indicating the end of a Vision model response. */
export class VisionFullResponseEndFrame extends LLMFullResponseEndFrame {}

export interface TTSStartedFrameOptions {
  /** Unique identifier for this TTS context. */
  contextId?: string | null;
  /** Whether the spoken text for this response will be appended to the LLM context. */
  appendToContext?: boolean;
}

/**
 * Frame indicating the beginning of a TTS response.
 *
 * Used to indicate the beginning of a TTS response. Following
 * TTSAudioRawFrames are part of the TTS response until a TTSStoppedFrame.
 * These frames can be used for aggregating audio frames in a transport to
 * optimize the size of frames sent to the session, without needing to control
 * this in the TTS service.
 *
 * - `contextId`: unique identifier for this TTS context.
 * - `appendToContext`: whether the spoken text for this response will be
 *   appended to the LLM context. Mirrors the value carried by the response's
 *   TTSTextFrames.
 */
export class TTSStartedFrame extends ControlFrame {
  contextId: string | null;
  appendToContext: boolean;

  constructor(options: TTSStartedFrameOptions = {}) {
    super(options);
    this.contextId = options.contextId ?? null;
    this.appendToContext = options.appendToContext ?? true;
  }
}

export interface TTSStoppedFrameOptions {
  /** Unique identifier for this TTS context. */
  contextId?: string | null;
}

/**
 * Frame indicating the end of a TTS response.
 *
 * - `contextId`: unique identifier for this TTS context.
 */
export class TTSStoppedFrame extends ControlFrame {
  contextId: string | null;

  constructor(options: TTSStoppedFrameOptions = {}) {
    super(options);
    this.contextId = options.contextId ?? null;
  }
}

export interface ServiceUpdateSettingsFrameOptions<
  TSettings extends ServiceSettings = ServiceSettings,
> {
  /** Settings delta object describing the fields to change. */
  delta?: TSettings | null;
  /** Optional target service instance. */
  service?: FrameProcessor | null;
  /** Whether these settings should reach every service a ServiceSwitcher manages. */
  reachInactiveServices?: boolean;
}

/**
 * Base frame for updating service settings.
 *
 * `TSettings` is covariant upstream so a bare `ServiceUpdateSettingsFrame`
 * annotation still accepts the subclasses. Gotcha: `delta` is mutable, so
 * writing through the base type is unsound and goes unreported — treat a
 * base-typed frame as read-only.
 *
 * - `delta`: `ServiceSettings` delta-mode object describing the fields to change.
 * - `service`: optional target service instance. When provided, only that
 *   service will apply the settings; other services will forward the frame
 *   unchanged.
 * - `reachInactiveServices`: whether these settings should reach every service
 *   a `ServiceSwitcher` manages, rather than only the active one. Set this for
 *   provider-neutral settings that must survive a service switch.
 */
export class ServiceUpdateSettingsFrame<
  TSettings extends ServiceSettings = ServiceSettings,
> extends ControlFrame {
  override interruptible = false;

  delta: TSettings | null;
  service: FrameProcessor | null;
  reachInactiveServices: boolean;

  constructor(options: ServiceUpdateSettingsFrameOptions<TSettings> = {}) {
    super(options);
    this.delta = options.delta ?? null;
    this.service = options.service ?? null;
    this.reachInactiveServices = options.reachInactiveServices ?? false;
  }
}

/** Frame for updating LLM service settings. */
export class LLMUpdateSettingsFrame extends ServiceUpdateSettingsFrame<LLMSettings> {}

/** Frame for updating TTS service settings. */
export class TTSUpdateSettingsFrame extends ServiceUpdateSettingsFrame<TTSSettings> {}

/** Frame for updating STT service settings. */
export class STTUpdateSettingsFrame extends ServiceUpdateSettingsFrame<STTSettings> {}

export interface UserIdleTimeoutUpdateFrameOptions {
  /** The new idle timeout in seconds. 0 disables idle detection. */
  timeout: number;
}

/**
 * Frame for updating the user idle timeout at runtime.
 *
 * Setting timeout to 0 disables idle detection. Setting a positive value
 * enables it. Updates apply immediately: a running idle timer restarts with
 * the new duration, and if the bot is waiting for the user to speak the timer
 * is armed right away.
 *
 * - `timeout`: the new idle timeout in seconds. 0 disables idle detection.
 */
export class UserIdleTimeoutUpdateFrame extends SystemFrame {
  timeout: number;

  constructor(options: UserIdleTimeoutUpdateFrameOptions) {
    super(options);
    this.timeout = options.timeout;
  }
}

export interface VADParamsUpdateFrameOptions {
  /** New VAD parameters to apply. */
  params: VADParams;
}

/**
 * Frame for updating VAD parameters.
 *
 * A control frame containing a request to update VAD params. Intended to be
 * pushed upstream from RTVI processor.
 *
 * - `params`: new VAD parameters to apply.
 */
export class VADParamsUpdateFrame extends ControlFrame {
  params: VADParams;

  constructor(options: VADParamsUpdateFrameOptions) {
    super(options);
    this.params = options.params;
  }
}

/** Base control frame for audio filter operations. */
export class FilterControlFrame extends ControlFrame {}

export interface FilterUpdateSettingsFrameOptions {
  /** Dictionary of filter setting name to value mappings. */
  settings: Record<string, unknown>;
}

/**
 * Frame for updating audio filter settings.
 *
 * - `settings`: dictionary of filter setting name to value mappings.
 */
export class FilterUpdateSettingsFrame extends FilterControlFrame {
  settings: Record<string, unknown>;

  constructor(options: FilterUpdateSettingsFrameOptions) {
    super(options);
    this.settings = options.settings;
  }
}

export interface FilterEnableFrameOptions {
  /** Whether to enable (true) or disable (false) the filter. */
  enable: boolean;
}

/**
 * Frame for enabling/disabling audio filters at runtime.
 *
 * - `enable`: whether to enable (true) or disable (false) the filter.
 */
export class FilterEnableFrame extends FilterControlFrame {
  enable: boolean;

  constructor(options: FilterEnableFrameOptions) {
    super(options);
    this.enable = options.enable;
  }
}

/** Frame instructing audio buffer processors to start recording. */
export class AudioBufferStartRecordingFrame extends ControlFrame {
  override interruptible = false;
}

/** Frame instructing audio buffer processors to stop recording and flush. */
export class AudioBufferStopRecordingFrame extends ControlFrame {
  override interruptible = false;
}

/** Base control frame for audio mixer operations. */
export class MixerControlFrame extends ControlFrame {}

export interface MixerUpdateSettingsFrameOptions {
  /** Dictionary of mixer setting name to value mappings. */
  settings: Record<string, unknown>;
}

/**
 * Frame for updating audio mixer settings.
 *
 * - `settings`: dictionary of mixer setting name to value mappings.
 */
export class MixerUpdateSettingsFrame extends MixerControlFrame {
  settings: Record<string, unknown>;

  constructor(options: MixerUpdateSettingsFrameOptions) {
    super(options);
    this.settings = options.settings;
  }
}

export interface MixerEnableFrameOptions {
  /** Whether to enable (true) or disable (false) the mixer. */
  enable: boolean;
}

/**
 * Frame for enabling/disabling audio mixer at runtime.
 *
 * - `enable`: whether to enable (true) or disable (false) the mixer.
 */
export class MixerEnableFrame extends MixerControlFrame {
  enable: boolean;

  constructor(options: MixerEnableFrameOptions) {
    super(options);
    this.enable = options.enable;
  }
}

export interface VolumeFrameOptions {
  /** The volume, as a multiplier on the audio's samples. */
  volume: number;
}

/**
 * Frame that sets the volume of the output transport's audio.
 *
 * The volume holds until the next `VolumeFrame`, and starts at the
 * transport's `audioOutVolume`. Audio plays at the volume times the gain set
 * by `VolumeGainFrame`. The frame takes effect in order with the audio before
 * it, and an interruption doesn't drop it.
 *
 * - `volume`: the volume, as a multiplier on the audio's samples: 1.0 leaves
 *   it unchanged, 0.5 halves it.
 */
export class VolumeFrame extends ControlFrame {
  volume: number;
  override interruptible = false;

  constructor(options: VolumeFrameOptions) {
    super(options);
    this.volume = options.volume;
  }
}

export interface VolumeGainFrameOptions {
  /** The gain, as a multiplier on the volume. */
  gain: number;
}

/**
 * Frame that sets a gain on the output transport's volume.
 *
 * A gain adjusts the volume for some audio and is reset afterwards, for
 * example `new VolumeGainFrame({ gain: 0.5 })` before a `TTSSpeakFrame` and
 * `new VolumeGainFrame({ gain: 1.0 })` after it, which plays that utterance at
 * half the volume without changing the volume set by `VolumeFrame`. The frame
 * takes effect in order with the audio before it, and an interruption doesn't
 * drop it.
 *
 * - `gain`: the gain, as a multiplier on the volume: 1.0 leaves it unchanged,
 *   0.5 halves it.
 */
export class VolumeGainFrame extends ControlFrame {
  gain: number;
  override interruptible = false;

  constructor(options: VolumeGainFrameOptions) {
    super(options);
    this.gain = options.gain;
  }
}

/** A base class for frames that affect ServiceSwitcher behavior. */
export class ServiceSwitcherFrame extends ControlFrame {}

export interface ManuallySwitchServiceFrameOptions {
  /** The service to switch to. */
  service: FrameProcessor;
}

/**
 * A frame to request a manual switch in the active service in a ServiceSwitcher.
 *
 * Handled by ServiceSwitcherStrategyManual to switch the active service.
 */
export class ManuallySwitchServiceFrame extends ServiceSwitcherFrame {
  service: FrameProcessor;

  constructor(options: ManuallySwitchServiceFrameOptions) {
    super(options);
    this.service = options.service;
  }
}
