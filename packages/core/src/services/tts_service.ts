// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/tts_service.py

/**
 * Base classes for Text-to-speech services.
 *
 * Porting notes: the deprecated `aggregateSentences`, `pauseWatchdogTimeoutS`
 * and `skipAggregatorTypes` constructor options, the deprecated
 * `aggregationType` argument of `addTextTransformer()` /
 * `removeTextTransformer()`, `setModel()` / `setVoice()`, the legacy
 * `TTSUpdateSettingsFrame(settings={...})` path and the deprecated
 * `WordTTSService`, `WebsocketWordTTSService`, `InterruptibleWordTTSService`,
 * `AudioContextTTSService` and `AudioContextWordTTSService` classes are not
 * ported.
 */

import { rethrowIfCancelled, sleep, type Task, TimeoutError } from "@pipecat-ts/asyncio";
import type { BaseAudioResampler } from "../audio/resamplers/base_audio_resampler.ts";
import { createStreamResampler } from "../audio/utils.ts";
import {
  AggregatedTextFrame,
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type CancelFrame,
  EagerTranscriptionFrame,
  EndFrame,
  ErrorFrame,
  Frame,
  InterimTranscriptionFrame,
  InterruptionFrame,
  LLMAssistantPushAggregationFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  type StartFrame,
  SystemFrame,
  TextFrame,
  TextType,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
  TTSUpdateSettingsFrame,
} from "../frames/frames.ts";
import { FrameDirection, type FrameProcessorSetup } from "../processors/frame_processor.ts";
import { isLanguage, type Language } from "../transcriptions/language.ts";
import { AggregatedFrameSequencer } from "../utils/context/aggregated_frame_sequencer.ts";
import { AudioContextFrame, AudioContextManager } from "../utils/context/audio_context_manager.ts";
import { WordTimestamp, WordTimestampTracker } from "../utils/context/word_timestamp_tracker.ts";
import { ErrorCategory } from "../utils/errors.ts";
import { logger } from "../utils/logger.ts";
import { resolveSentenceTokenizerLanguage } from "../utils/string.ts";
import type { Aggregation } from "../utils/text/base_text_aggregator.ts";
import type { BaseTextFilter } from "../utils/text/base_text_filter.ts";
import { PatternMatch } from "../utils/text/pattern_pair_aggregator.ts";
import { SimpleTextAggregator } from "../utils/text/simple_text_aggregator.ts";
import {
  PronunciationTransform,
  pronunciationTransform,
} from "../utils/text/transforms/pronunciations.ts";
import { mergePunctTokens } from "../utils/text/word_timestamp_utils.ts";
import { isGiven } from "../utils/types.ts";
import { AIService, type AIServiceOptions } from "./ai_service.ts";
import { TTSSettings } from "./settings.ts";
import { State, WebsocketService, type WebsocketServiceOptions } from "./websocket_service.ts";

/**
 * Controls how incoming text is aggregated before TTS synthesis.
 *
 * - SENTENCE: Buffer text until sentence boundaries are detected before
 *   synthesis. Produces more natural speech but adds latency (~200-300ms per
 *   sentence).
 * - TOKEN: Stream text tokens directly to TTS as they arrive. Reduces latency
 *   but may affect speech quality depending on the TTS provider.
 */
export const TextAggregationMode = {
  SENTENCE: "sentence",
  TOKEN: "token",
} as const;
export type TextAggregationMode = (typeof TextAggregationMode)[keyof typeof TextAggregationMode];

/**
 * A text transform: takes the aggregated text and its type, and returns the
 * transformed text.
 */
export type TextTransformFunction = (text: string, textType: TextType | string) => Promise<string>;

export interface TTSContextOptions {
  /**
   * Whether this TTS output should be appended to the conversation context
   * after it is spoken.
   */
  appendToContext?: boolean;
  /**
   * Whether to push an `LLMAssistantPushAggregationFrame` after the TTS has
   * finished speaking, forcing the assistant aggregator to commit its current
   * text buffer to the conversation context.
   */
  pushAssistantAggregation?: boolean;
  /** Whether an interruption may discard this synthesis. */
  interruptible?: boolean;
}

/**
 * Context information for a TTS request.
 *
 * - `appendToContext`: Whether this TTS output should be appended to the
 *   conversation context after it is spoken.
 * - `pushAssistantAggregation`: Whether to push an
 *   `LLMAssistantPushAggregationFrame` after the TTS has finished speaking,
 *   forcing the assistant aggregator to commit its current text buffer to the
 *   conversation context.
 * - `interruptible`: Whether an interruption may discard this synthesis.
 */
export class TTSContext {
  appendToContext: boolean;
  pushAssistantAggregation: boolean;
  interruptible: boolean;

  constructor(options: TTSContextOptions = {}) {
    this.appendToContext = options.appendToContext ?? true;
    this.pushAssistantAggregation = options.pushAssistantAggregation ?? false;
    this.interruptible = options.interruptible ?? true;
  }
}

/** Internal: what has happened so far while an audio context plays. */
export class _AudioContextPlayback {
  receivedAudio = false;
  stopFrameDue = false;
}

/** An item queued in an audio context. */
export type AudioContextItem = Frame | WordTimestamp;

export interface TTSServiceOptions extends AIServiceOptions {
  /**
   * How to aggregate incoming text before synthesis.
   * `TextAggregationMode.SENTENCE` (default) buffers until sentence
   * boundaries, `TextAggregationMode.TOKEN` streams tokens directly for lower
   * latency.
   */
  textAggregationMode?: TextAggregationMode | null;
  /** Whether to push TextFrames and LLMFullResponseEndFrames. */
  pushTextFrames?: boolean;
  /** Whether to automatically push TTSStoppedFrames. */
  pushStopFrames?: boolean;
  /**
   * Whether to automatically create audio contexts and push TTSStartedFrames.
   * When true, the base class handles `createAudioContext` and yields
   * `TTSStartedFrame` before each synthesis call, so `runTts`
   * implementations do not need to.
   */
  pushStartFrame?: boolean;
  /** Idle time before pushing TTSStoppedFrame when pushStopFrames is true. */
  stopFrameTimeoutS?: number;
  /** Whether to push silence audio after TTSStoppedFrame. */
  pushSilenceAfterStop?: boolean;
  /** Duration of silence to push when pushSilenceAfterStop is true. */
  silenceTimeS?: number;
  /**
   * Whether to hold incoming frames after a turn until its audio contexts
   * end. Needed by services whose audio doesn't carry its request's context
   * ID.
   */
  pauseFrameProcessing?: boolean;
  /**
   * How many consecutive TTS contexts may complete without producing any
   * audio before the service is reported unable to do its job. Catches a
   * provider that accepts requests and stays silent — an unknown voice ID,
   * say — which no error ever surfaces. Every silent context reports an error
   * the service can carry on from, whatever the limit is; on reaching the
   * limit the service reports a permanent error instead, stops being given
   * work, and the pipeline worker applies its `ProcessorUnusablePolicy`. Set
   * to 0 to report silent contexts without ever writing the service off.
   */
  maxConsecutiveZeroAudioContexts?: number;
  /**
   * Whether to append a trailing space to text before sending to TTS. This
   * helps prevent some TTS services from vocalizing trailing punctuation
   * (e.g., "dot"). Only applied in sentence aggregation mode; when streaming
   * tokens, the incoming text's own whitespace is preserved.
   */
  appendTrailingSpace?: boolean;
  /** Output sample rate for generated audio. */
  sampleRate?: number | null;
  /** List of text types that should not be spoken. */
  skipTextTypes?: string[] | null;
  /**
   * A list of callables to transform text just before sending it to TTS.
   * Each callable takes the aggregated text and its type, and returns the
   * transformed text. To register, provide a list of tuples of
   * `[textType | "*", transformFunction]`.
   */
  textTransforms?: [TextType | string, TextTransformFunction][] | null;
  /** Sequence of text filters to apply after aggregation. */
  textFilters?: readonly BaseTextFilter[] | null;
  /** Destination for generated audio frames. */
  transportDestination?: string | null;
  /** The runtime-updatable settings for the TTS service. */
  settings?: TTSSettings | null;
  /** Whether the service should reuse context IDs within the same turn. */
  reuseContextIdWithinTurn?: boolean;
}

/**
 * Base class for text-to-speech services.
 *
 * Provides common functionality for TTS services including text aggregation,
 * filtering, audio generation, and frame management. Supports configurable
 * sentence aggregation, silence insertion, and frame processing control.
 *
 * Event handlers:
 *
 * - on_connected: Called when connected to the TTS service.
 * - on_disconnected: Called when disconnected from the TTS service.
 * - on_connection_error: Called when a connection to the TTS service error occurs.
 * - on_tts_request: Called before a TTS request is made, with the context ID and text.
 *
 * @example
 * tts.eventHandler("on_connected", async (tts: TTSService) => {
 *   logger.debug("TTS connected");
 * });
 * tts.eventHandler("on_disconnected", async (tts: TTSService) => {
 *   logger.debug("TTS disconnected");
 * });
 * tts.eventHandler("on_connection_error", async (tts: TTSService, error: string) => {
 *   logger.error(`TTS connection error: ${error}`);
 * });
 * tts.eventHandler("on_tts_request", async (tts: TTSService, contextId: string, text: string) => {
 *   logger.debug(`TTS request: ${contextId} - ${text}`);
 * });
 */
export abstract class TTSService extends AIService {
  declare protected _settings: TTSSettings;

  protected _textAggregationMode: TextAggregationMode;
  protected _pushTextFrames: boolean;
  protected _pushStopFrames: boolean;
  protected _pushStartFrame: boolean;
  protected _stopFrameTimeoutS: number;
  protected _pushSilenceAfterStop: boolean;
  protected _silenceTimeS: number;
  protected _pauseFrameProcessing: boolean;
  protected _maxConsecutiveZeroAudioContexts: number;
  protected _consecutiveZeroAudioContexts = 0;
  protected _appendTrailingSpace: boolean;
  protected _initSampleRate: number | null;
  protected _sampleRate = 0;
  protected _textAggregator: SimpleTextAggregator;
  protected _skippedTextAggregator: SimpleTextAggregator;
  protected _skipTextTypes: string[];
  protected _textTransforms: [TextType | string, TextTransformFunction][];
  protected _skippingPronunciations = false;
  protected _textFilters: readonly BaseTextFilter[];
  protected _transportDestination: string | null;
  protected _aggregatedFrameSequencer: AggregatedFrameSequencer;
  protected _resampler: BaseAudioResampler;
  protected _ttsContexts = new Map<string, TTSContext>();
  protected _streamedText = "";
  protected _sentNonWhitespaceInContext = false;
  protected _textAggregationMetricsStarted = false;
  protected _wordTimestampTracker: WordTimestampTracker;
  protected _reuseContextIdWithinTurn: boolean;
  protected _turnContextId: string | null = null;
  protected _audioContextManager: AudioContextManager;
  protected _audioContextTask: Task<unknown> | null = null;
  protected _isYieldingFramesSynchronously = false;

  /**
   * Initialize the TTS service.
   *
   * @param options See `TTSServiceOptions`. Other options are passed to the
   *   parent AIService.
   */
  constructor(options: TTSServiceOptions = {}) {
    super({
      ...options,
      settings:
        options.settings ??
        // Here in case subclass doesn't implement more specific settings
        // (which hopefully should be rare)
        new TTSSettings(),
    });

    const language = this._settings.language;
    const aggregationLanguage = resolveSentenceTokenizerLanguage(
      isGiven(language) ? (language as string | null) : null,
    );

    // Runtime updates are converted by _updateSettings(), but init-time
    // settings bypass that path.
    if (typeof this._settings.language === "string") {
      this._settings.language = this._serviceLanguage(this._settings.language);
    }

    this._textAggregationMode = options.textAggregationMode ?? TextAggregationMode.SENTENCE;
    this._pushTextFrames = options.pushTextFrames ?? true;
    this._pushStopFrames = options.pushStopFrames ?? false;
    this._pushStartFrame = options.pushStartFrame ?? false;
    this._stopFrameTimeoutS = options.stopFrameTimeoutS ?? 3.0;
    this._pushSilenceAfterStop = options.pushSilenceAfterStop ?? false;
    this._silenceTimeS = options.silenceTimeS ?? 2.0;
    this._pauseFrameProcessing = options.pauseFrameProcessing ?? false;
    this._maxConsecutiveZeroAudioContexts = options.maxConsecutiveZeroAudioContexts ?? 3;
    this._appendTrailingSpace = options.appendTrailingSpace ?? false;
    this._initSampleRate = options.sampleRate ?? null;
    this._textAggregator = new SimpleTextAggregator({
      aggregationType: this._textAggregationMode,
      language: aggregationLanguage,
    });
    // Cuts LLM text marked skipTts into sentences, so a reply that isn't
    // spoken still reaches clients as bot output. It's separate from the
    // aggregator above because that one yields single tokens in token mode,
    // and only spoken tokens are regrouped into sentences afterwards (by the
    // sequencer).
    this._skippedTextAggregator = new SimpleTextAggregator({
      aggregationType: TextAggregationMode.SENTENCE,
      language: aggregationLanguage,
    });

    this._skipTextTypes = options.skipTextTypes ?? [];
    this._textTransforms = options.textTransforms ?? [];
    // TODO: Deprecate _textFilters when added to LLMTextProcessor
    this._textFilters = options.textFilters ?? [];
    this._transportDestination = options.transportDestination ?? null;

    // Ordered sequence of every AggregatedTextFrame slot that passes through
    // _handleAggregatedText (both spoken and skipped). Skipped frames are held
    // here until all preceding spoken slots are complete, then flushed
    // downstream so their appendToContext=true arrives at the assistant
    // aggregator in the correct order relative to the TTSTextFrames from
    // spoken sentences.
    //
    // In streaming (TOKEN) mode the sequencer regroups tokens back into
    // sentences, which relies on the whole turn sharing one context ID; this
    // is only sound with reuseContextIdWithinTurn=true (see the sequencer's
    // `streaming` docstring).
    this._aggregatedFrameSequencer = new AggregatedFrameSequencer({
      name: String(this),
      streaming: this._isStreamingTokens,
    });

    this._resampler = createStreamResampler();

    // Turns provider word times into the PTS of word frames, and gives
    // TTSStoppedFrame and LLMFullResponseEndFrame the PTS of the last word.
    this._wordTimestampTracker = new WordTimestampTracker();
    this._reuseContextIdWithinTurn = options.reuseContextIdWithinTurn ?? true;

    // _turnContextId is shared by the sentences of the current turn, so they
    // form one audio context. A TTSSpeakFrame swaps in its own while it is
    // spoken. Unlike the playing context (see getActiveAudioContextId), it is
    // cleared once the turn's synthesis completes, before its audio has
    // played.

    // Audio contexts and the downstream frames between them, emitted in
    // order. Created once so it survives interruptions, which drop
    // interruptible contexts and frames while keeping uninterruptible ones
    // (e.g. FunctionCallResultFrame) that must not be lost mid-flight.
    this._audioContextManager = new AudioContextManager();

    this._registerEventHandler("on_connected");
    this._registerEventHandler("on_disconnected");
    this._registerEventHandler("on_connection_error");
    this._registerEventHandler("on_tts_request");

    // _isYieldingFramesSynchronously: whether the TTS process is currently
    // yielding audio frames synchronously.
  }

  /** The current sample rate for audio output, in Hz. */
  get sampleRate(): number {
    return this._sampleRate;
  }

  /**
   * The recommended chunk size for audio streaming, in bytes.
   *
   * This property indicates how much audio we download (from TTS services
   * that require chunking) before we start pushing the first audio frame.
   * This will make sure we download the rest of the audio while audio is
   * being played without causing audio glitches (specially at the
   * beginning). Of course, this will also depend on how fast the TTS service
   * generates bytes.
   */
  get chunkSize(): number {
    const CHUNK_SECONDS = 0.5;
    return Math.trunc(this.sampleRate * CHUNK_SECONDS * 2); // 2 bytes/sample
  }

  /** Current sentence tokenizer language, derived from TTS settings. */
  get textAggregationLanguage(): string {
    return this._textAggregator.language;
  }

  /**
   * Whether this service has a meaningful processing-time metric.
   *
   * Processing time is measured around `runTts()`, so it only means something
   * when synthesis finishes before `runTts` returns. Services that hand the
   * text off and receive audio elsewhere — anything holding a persistent
   * connection with its own receive task — return false, since the
   * measurement would cover the send and nothing else. TTFB and TTFA carry
   * the latency for those.
   */
  get supportsProcessingMetrics(): boolean {
    return true;
  }

  /**
   * Record TTS usage metrics.
   *
   * When streaming tokens, usage metrics are aggregated and reported at flush
   * time instead of per token, so individual calls are skipped.
   *
   * @param text The text being processed by TTS.
   */
  override async startTtsUsageMetrics(text: string): Promise<void> {
    if (this._isStreamingTokens) return;
    await super.startTtsUsageMetrics(text);
  }

  /**
   * Start text aggregation metrics if not already started.
   *
   * Only starts the metric once per LLM response. Skipped when streaming
   * tokens since per-token aggregation time is not meaningful.
   */
  override async startTextAggregationMetrics(): Promise<void> {
    if (this._isStreamingTokens || this._textAggregationMetricsStarted) return;
    this._textAggregationMetricsStarted = true;
    await super.startTextAggregationMetrics();
  }

  /** Stop text aggregation metrics and reset the started flag. */
  override async stopTextAggregationMetrics(): Promise<void> {
    this._textAggregationMetricsStarted = false;
    await super.stopTextAggregationMetrics();
  }

  /**
   * Set up the service.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._sampleRate = this._initSampleRate || setup.audioOutSampleRate;
  }

  /**
   * Start the TTS service.
   *
   * @param frame The start frame containing initialization parameters.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    this._createAudioContextTask();
  }

  /**
   * Stop the TTS service.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    if (this._audioContextTask) {
      // Playback ends once all pending contexts and frames have played.
      await this._audioContextManager.endPlayback();
      await this._audioContextTask;
      this._audioContextTask = null;
    }
  }

  /**
   * Cancel the TTS service.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    // Prompt stop of audio production. cleanup() repeats this idempotently.
    await this._stopAudioContextTask();
  }

  /** Release TTS resources at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._stopAudioContextTask();
  }

  /**
   * Set whether this service can be given work.
   *
   * @param isUsable Whether the service can be given work.
   */
  override async setUsable(isUsable: boolean): Promise<void> {
    // Whatever silence wrote the service off has been dealt with, so the
    // count of silent contexts starts over.
    if (isUsable) {
      this._consecutiveZeroAudioContexts = 0;
    }
    await super.setUsable(isUsable);
  }

  //
  // Text transforms and pronunciations
  //

  /**
   * Transform text of a specific type.
   *
   * @param transformFunction The function to apply for transformation. This
   *   function should take the text and its type as input and return the
   *   transformed text, e.g.
   *   `async function myTransform(text: string, textType: string): Promise<string>`.
   * @param textType The type of text to transform. This value defaults to
   *   "*" indicating the function should handle all text before sending to
   *   TTS.
   */
  addTextTransformer(
    transformFunction: TextTransformFunction,
    textType: TextType | string = "*",
  ): void {
    this._textTransforms.push([textType, transformFunction]);
  }

  /**
   * Remove a text transformer for a specific text type.
   *
   * @param transformFunction The function to remove.
   * @param textType The type of text to remove the transformer for.
   */
  removeTextTransformer(
    transformFunction: TextTransformFunction,
    textType: TextType | string = "*",
  ): void {
    this._textTransforms = this._textTransforms.filter(
      ([transformType, func]) => !(transformType === textType && func === transformFunction),
    );
  }

  /**
   * Render a word's pronunciation in this service's markup.
   *
   * Services that support pronunciation hints override this. The base
   * implementation supports none.
   *
   * @param word The word as it appears in the text.
   * @param ipa How to pronounce it, in IPA.
   * @returns The text to send in place of `word`, or null when this service
   *   cannot use the pronunciation.
   */
  static formatPronunciation(_word: string, _ipa: string): string | null {
    return null;
  }

  /**
   * Whether this service reads pronunciation markup with its current settings.
   *
   * Pronunciation transforms are skipped while this is false, so their words
   * are spoken as written. Services whose markup depends on the model or on a
   * setting override this; it is checked for every text sent, so it follows
   * settings updates.
   *
   * @returns true in the base implementation.
   */
  get supportsPronunciations(): boolean {
    return true;
  }

  /**
   * Create a text transform that makes this service say words as IPA describes.
   *
   * Each word is replaced with `formatPronunciation()` output, so the same
   * IPA works with any service that supports it. Words the service cannot use
   * are reported once and spoken as written. While the service cannot read
   * pronunciation markup at all (see `supportsPronunciations`), the transform
   * is skipped.
   *
   * Register this transform last in `textTransforms`. Transforms run in
   * order, and one that runs after it (stripping markdown or symbols,
   * replacing text) can rewrite the markup it inserts, such as Cartesia's
   * `<<…>>` blocks or an SSML `<phoneme>` tag, and break the hint.
   *
   * @param pronunciations Word to IPA, e.g. `{ Metformin: "mɛtˈfɔɹmɪn" }`.
   * @returns A transform to register with `textTransforms`.
   *
   * @example
   * const pronounce = CartesiaTTSService.pronunciationTransformIpa({ Metformin: "mɛtˈfɔɹmɪn" });
   * const tts = new CartesiaTTSService({
   *   textTransforms: [
   *     ["*", stripMarkdown],
   *     ["*", expandCurrency],
   *     ["*", pronounce], // last, so nothing rewrites its markup
   *   ],
   * });
   */
  static pronunciationTransformIpa(
    pronunciations: Readonly<Record<string, string>>,
  ): PronunciationTransform {
    // `this` is the subclass the method is called on, like Python's `cls`.
    return pronunciationTransform(
      pronunciations,
      // biome-ignore lint/complexity/noThisInStatic: polymorphic classmethod.
      (word: string, ipa: string) => this.formatPronunciation(word, ipa),
      // biome-ignore lint/complexity/noThisInStatic: polymorphic classmethod.
      { serviceName: this.name },
    );
  }

  //
  // Subclass interface
  //

  /**
   * Run text-to-speech synthesis on the provided text.
   *
   * This method must be implemented by subclasses to provide actual TTS
   * functionality. The base class logs the synthesized text before invoking
   * this method, so implementations should not log it again.
   *
   * @param text The text to synthesize into speech.
   * @param contextId Unique identifier for this TTS context.
   * @returns Audio frames containing the synthesized speech.
   */
  abstract runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void>;

  /**
   * Convert a language to the service-specific language format.
   *
   * @param language The language to convert.
   * @returns The service-specific language identifier. Return null to
   *   indicate an unsupported language. This optional return is an extension
   *   hook for future or third-party subclasses; as of 2026-04-28,
   *   first-party services return a string.
   */
  languageToServiceLanguage(language: Language): string | null {
    return language;
  }

  /**
   * Generate or reuse a context ID based on concurrent TTS support.
   *
   * @returns A context ID string for the TTS request.
   */
  createContextId(): string {
    let contextId: string;
    if (this._reuseContextIdWithinTurn && this._turnContextId) {
      this._refreshAudioContext(this._turnContextId);
      contextId = this._turnContextId;
    } else {
      contextId = crypto.randomUUID();
    }
    return contextId;
  }

  /**
   * Flush any buffered audio data.
   *
   * @param contextId The specific context to flush. If null, falls back to
   *   the currently active context (for non-concurrent services).
   */
  async flushAudio(_contextId: string | null = null): Promise<void> {}

  /**
   * Process frames from an async generator, routing them through the audio context.
   *
   * All non-null frames yielded by the generator are appended to the audio
   * context identified by contextId. The audio context must be created by
   * runTts (via createAudioContext) before the first frame is yielded.
   *
   * WebSocket services yield null to signal that audio will arrive via a
   * separate receive loop; those services manage context lifetime themselves
   * (via removeAudioContext in the receive loop on "done"). HTTP services
   * never yield null and do NOT call removeAudioContext in runTts —
   * onTurnContextCompleted closes the context once the turn's remaining
   * frames (e.g. TTSTextFrame) are queued.
   *
   * @param contextId The audio context to route frames to.
   * @param generator An async generator yielding Frame objects or null.
   */
  async ttsProcessGenerator(
    contextId: string,
    generator: AsyncIterable<Frame | null | undefined>,
  ): Promise<void> {
    let isYieldingFrames = false;
    for await (const frame of generator) {
      if (frame) {
        await this.appendToAudioContext(contextId, frame);
        if (frame instanceof TTSAudioRawFrame) {
          isYieldingFrames = true;
        }
      }
    }

    this._isYieldingFramesSynchronously = isYieldingFrames;
  }

  /**
   * Called when a new turn context ID has been created.
   *
   * Override to perform provider-specific setup (e.g., eagerly opening a
   * server-side context) before text starts flowing. This is called from
   * `processFrame` when an `LLMFullResponseStartFrame` or `TTSSpeakFrame`
   * arrives.
   *
   * @param contextId The newly created turn context ID.
   */
  async onTurnContextCreated(_contextId: string): Promise<void> {}

  /** Handle the completion of a turn. */
  async onTurnContextCompleted(): Promise<void> {
    // HTTP services yield their audio inline, so their audio context is
    // closed here, once all the turn's frames (including TTSTextFrame) are
    // queued.
    if (
      this._isYieldingFramesSynchronously &&
      this._turnContextId !== null &&
      this.audioContextAvailable(this._turnContextId)
    ) {
      if (this._pushStopFrames) {
        await this.appendToAudioContext(
          this._turnContextId,
          new TTSStoppedFrame({ contextId: this._turnContextId }),
        );
      }
      await this.removeAudioContext(this._turnContextId);
    }

    // Flush any pending audio so the TTS service closes the current context.
    // Only flush if the context was actually opened (text reached runTts).
    // When an interruption arrives before any text flows, the turn context ID
    // exists but was never registered via createAudioContext, so flushing
    // would send a message for a context the provider never opened.
    if (this._turnContextId && this.audioContextAvailable(this._turnContextId)) {
      await this.flushAudio(this._turnContextId);
    }

    // Reset the turn context ID
    this._turnContextId = null;
  }

  /**
   * Called when an audio context is cancelled due to an interruption.
   *
   * Override this in a subclass to perform provider-specific cleanup (e.g.
   * sending a cancel/close message over the WebSocket) when the bot is
   * interrupted mid-speech. The context is still registered when this hook
   * runs. Uninterruptible contexts continue playing and do not call this
   * hook.
   *
   * @param contextId The ID of the audio context that was interrupted.
   */
  async onAudioContextInterrupted(_contextId: string): Promise<void> {}

  /**
   * Called after an audio context has finished playing all of its audio.
   *
   * Override this in a subclass to perform provider-specific cleanup (e.g.
   * sending a close-context message to free server-side resources) once an
   * audio context has been fully processed. The context entry has already
   * been removed from the internal context map, and the active context has
   * **not** yet been reset when this is called.
   *
   * @param contextId The ID of the audio context that finished processing.
   */
  async onAudioContextCompleted(_contextId: string): Promise<void> {}

  //
  // Word timestamps
  //

  /** Start tracking word timestamps from the current time. */
  async startWordTimestamps(): Promise<void> {
    for (const cached of this._wordTimestampTracker.start(this.getClock().getTime())) {
      await this._addWordTimestamps([[cached.word, cached.timestamp]], cached.contextId, {
        includesInterFrameSpaces: cached.includesInterFrameSpaces,
      });
    }
  }

  /** Reset word timestamp tracking. */
  async resetWordTimestamps(): Promise<void> {
    this._wordTimestampTracker.reset();
  }

  /**
   * Add word timestamps for processing.
   *
   * When an audio context exists for this contextId, timestamps are routed
   * into the per-context audio queue alongside audio frames so they are
   * processed in strict playback order by _handleAudioContext. Otherwise they
   * are processed immediately via _addWordTimestamps.
   *
   * @param wordTimes List of [word, timestamp] tuples where timestamp is in
   *   seconds.
   * @param contextId Unique identifier for the TTS context.
   * @param options.includesInterFrameSpaces When true, each emitted
   *   TTSTextFrame carries `includesInterFrameSpaces=true` so downstream
   *   consumers do not inject extra spaces between consecutive frames (e.g.
   *   ElevenLabs for CJK languages where word tokens already self-contain
   *   their spacing). null leaves the frame's own default unchanged.
   * @param options.preMergeTokens When true, punctuation and space-only
   *   tokens are merged into the preceding word via `mergePunctTokens` before
   *   queuing (e.g. Inworld TTS, which emits spaces and punctuation as
   *   separate tokens). After merging the resulting tokens are clean word
   *   strings, so `includesInterFrameSpaces` should be left false (its
   *   default).
   */
  async addWordTimestamps(
    wordTimes: (readonly [string, number])[],
    contextId: string | null = null,
    options: { includesInterFrameSpaces?: boolean | null; preMergeTokens?: boolean } = {},
  ): Promise<void> {
    let times: (readonly [string, number])[] = wordTimes;
    if (options.preMergeTokens) {
      times = mergePunctTokens(times);
    }

    const ifs = Boolean(options.includesInterFrameSpaces);
    if (contextId && this.audioContextAvailable(contextId)) {
      for (const [word, timestamp] of times) {
        await this.appendToAudioContext(
          contextId,
          new WordTimestamp({
            word,
            timestamp,
            contextId,
            includesInterFrameSpaces: ifs,
          }),
        );
      }
    } else if (contextId !== null) {
      logger.trace(
        `Dropping stale words for context ${contextId}; word times: ${JSON.stringify(times)}`,
      );
    } else {
      await this._addWordTimestamps(times, contextId, { includesInterFrameSpaces: ifs });
    }
  }

  //
  // Audio contexts
  //

  /**
   * Create a new audio context for grouping related audio.
   *
   * @param contextId Unique identifier for the audio context.
   */
  async createAudioContext(contextId: string): Promise<void> {
    const context = this._ttsContexts.get(contextId);
    const interruptible = context ? context.interruptible : true;
    await this._audioContextManager.create(contextId, { interruptible });
    logger.trace(`${this} created audio context ${contextId}`);
  }

  /**
   * Append a frame or word-timestamp entry to an existing audio context queue.
   *
   * Passing a `frame` of null signals end-of-context (used by
   * removeAudioContext to mark the queue for deletion). If the context no
   * longer exists but the contextId matches the active turn, the context is
   * transparently recreated before appending.
   *
   * @param contextId The context to append to. null is accepted as a no-op
   *   (with a debug log) so callers can pass through values from
   *   `getActiveAudioContextId()` without an explicit guard.
   * @param frame The frame, word-timestamp entry, or null (end-of-context
   *   sentinel) to append.
   */
  async appendToAudioContext(
    contextId: string | null,
    frame: AudioContextItem | null,
  ): Promise<void> {
    if (!contextId) {
      logger.debug(`${this} unable to append audio to context: no context ID provided`);
      return;
    }
    // Sometimes the HTTP service can take more than 3 seconds without sending
    // any audio, so the context is recreated while we are in the same turn.
    // An end marker (null) never recreates it.
    if (!this.audioContextAvailable(contextId) && contextId === this._turnContextId && frame) {
      logger.debug(`${this} recreating audio context ${contextId}`);
      await this.createAudioContext(contextId);
    }

    if (this.audioContextAvailable(contextId)) {
      logger.trace(`${this} appending audio ${frame} to audio context ${contextId}`);
      await this._audioContextManager.append(contextId, frame);
    } else {
      logger.debug(`${this} unable to append audio to context ${contextId}`);
    }
  }

  /**
   * Remove an existing audio context.
   *
   * @param contextId The context to remove. null is accepted as a no-op
   *   (logged) so callers can pass through values from
   *   `getActiveAudioContextId()` without an explicit guard.
   */
  async removeAudioContext(contextId: string | null): Promise<void> {
    if (!contextId) {
      logger.debug(`${this} unable to remove audio context: no context ID provided`);
      return;
    }
    if (this.audioContextAvailable(contextId)) {
      // We just mark the audio context for deletion by appending null. Once
      // we reach null while handling audio we know we can safely remove the
      // context.
      logger.trace(`${this} marking audio context ${contextId} for deletion`);
      await this.appendToAudioContext(contextId, null);
    } else {
      logger.warning(`${this} unable to remove context ${contextId}`);
    }
  }

  /**
   * Check whether the given audio context is registered.
   *
   * @param contextId The context ID to check.
   * @returns true if the context exists and is available.
   */
  audioContextAvailable(contextId: string): boolean {
    return this._audioContextManager.available(contextId);
  }

  /** Get a list of all available audio contexts. */
  getAudioContexts(): string[] {
    return this._audioContextManager.contextIds;
  }

  /**
   * Check if there is an active audio context.
   *
   * @returns true if an active audio context exists, false otherwise.
   */
  hasActiveAudioContext(): boolean {
    const playingContextId = this._audioContextManager.playingContextId;
    return playingContextId !== null && this.audioContextAvailable(playingContextId);
  }

  /**
   * Get the active audio context ID.
   *
   * Returns the playback cursor when set (during active playback), falling
   * back to the current turn's synthesis contextId. The fallback covers the
   * gap between contexts and the start of a turn before the playback task has
   * dequeued the just-created context — important for services whose wire
   * protocol does not echo contextId back on incoming audio.
   *
   * @returns The active context ID, or null if neither cursor is set.
   */
  getActiveAudioContextId(): string | null {
    return this._audioContextManager.playingContextId || this._turnContextId;
  }

  /** Remove the active audio context. */
  async removeActiveAudioContext(): Promise<void> {
    const playingContextId = this._audioContextManager.playingContextId;
    if (playingContextId) {
      await this.removeAudioContext(playingContextId);
      this.resetActiveAudioContext();
    }
  }

  /** Reset the active audio context. */
  resetActiveAudioContext(): void {
    this._audioContextManager.playingContextId = null;
  }

  //
  // Frame processor
  //

  /**
   * Process frames for text-to-speech conversion.
   *
   * Handles TextFrames for synthesis, interruption frames, settings updates,
   * and various control frames.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    // A reply that isn't spoken is queued behind the audio still playing, so
    // it comes out after that audio, its start, sentences and end in order.
    if (frame instanceof LLMFullResponseStartFrame && frame.skipTts) {
      await this._audioContextManager.putFrame(frame);
    } else if (frame instanceof LLMTextFrame && frame.skipTts) {
      await this._handleSkippedLlmText(frame);
    } else if (frame instanceof LLMFullResponseEndFrame && frame.skipTts) {
      await this._handleSkippedLlmResponseEnd(frame);
    } else if (frame instanceof TextFrame && frame.skipTts) {
      await this.pushFrame(frame, direction);
    } else if (frame instanceof AggregatedTextFrame) {
      await this._handleAggregatedText(frame);
    } else if (
      frame instanceof TextFrame &&
      !(frame instanceof InterimTranscriptionFrame) &&
      !(frame instanceof TranscriptionFrame) &&
      !(frame instanceof EagerTranscriptionFrame)
    ) {
      await this.startTextAggregationMetrics();
      await this._handleText(frame);
    } else if (frame instanceof InterruptionFrame) {
      await this._handleInterruption(frame, direction);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof LLMFullResponseStartFrame) {
      await this._handleLlmResponseStart(frame);
    } else if (frame instanceof LLMFullResponseEndFrame || frame instanceof EndFrame) {
      await this._handleLlmResponseEnd(frame, direction);
    } else if (frame instanceof TTSSpeakFrame) {
      await this._handleTtsSpeak(frame);
    } else if (frame instanceof TTSUpdateSettingsFrame) {
      await this._handleUpdateSettings(frame, direction);
    } else {
      if (direction === FrameDirection.DOWNSTREAM && !(frame instanceof SystemFrame)) {
        // Queue non-system downstream frames behind the audio contexts so
        // they are emitted in the same order they arrive relative to any
        // audio contexts that are already queued (e.g. a FooFrame sent right
        // after a TTSSpeakFrame must not overtake the TTSStartedFrame /
        // TTSAudioRawFrame / TTSStoppedFrame sequence from that speak frame).
        await this._audioContextManager.putFrame(frame);
      } else {
        await this.pushFrame(frame, direction);
      }
    }
  }

  /**
   * Push a frame downstream with TTS-specific handling.
   *
   * @param frame The frame to push.
   * @param direction The direction to push the frame.
   */
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    this._applyContextInterruptible(frame);
    if (frame instanceof TTSStoppedFrame) {
      await this._finishTtsContext(frame);
      await this._pushStopSilence(frame);
    }
    if (
      frame instanceof TTSStartedFrame ||
      frame instanceof TTSStoppedFrame ||
      frame instanceof TTSAudioRawFrame ||
      frame instanceof TTSTextFrame
    ) {
      frame.transportDestination = this._transportDestination;
    }
    if (frame instanceof AggregatedTextFrame) {
      this._stampSegmentAnnouncement(frame);
    }
    await super.pushFrame(frame, direction);
  }

  //
  // Settings
  //

  /**
   * Apply a TTS settings delta.
   *
   * Translates language to service-specific value before applying.
   *
   * @param delta A TTS settings delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const language = delta.language;
    // Translate language *before* applying so the stored value is canonical.
    if (isGiven(delta.language) && typeof delta.language === "string") {
      delta.language = this._serviceLanguage(delta.language);
    }

    const changed = await super._updateSettings(delta);

    if (isGiven(language)) {
      this._textAggregator.setLanguage(language as string | null);
      this._skippedTextAggregator.setLanguage(language as string | null);
    }

    return changed;
  }

  /** Convert a language to the service's format, passing unknown codes as they are. */
  protected _serviceLanguage(language: string): string {
    // Raw strings (e.g. "de-DE") are first checked against the Language
    // codes so they go through the same resolution logic.
    if (!isLanguage(language)) {
      logger.debug(
        `Language string '${language}' is not a recognized ` +
          "Language code. It will be passed to the service as-is.",
      );
      return language;
    }
    const converted = this.languageToServiceLanguage(language);
    return converted ?? language;
  }

  //
  // Frame handling
  //

  /** Start a turn whose sentences share one context ID. */
  protected async _handleLlmResponseStart(frame: LLMFullResponseStartFrame): Promise<void> {
    this._turnContextId = this.createContextId();
    await this.onTurnContextCreated(this._turnContextId);
    // Queue behind the audio contexts so this frame is emitted only after any
    // earlier audio context already queued has fully drained, rather than
    // racing ahead of it (e.g. a new turn starting via LLMMessagesAppendFrame
    // while the previous turn's audio is still playing out downstream).
    await this._audioContextManager.putFrame(frame);
  }

  /** Speak the turn's remaining text and complete the turn. */
  protected async _handleLlmResponseEnd(
    frame: LLMFullResponseEndFrame | EndFrame,
    direction: FrameDirection,
  ): Promise<void> {
    // Flush any remaining text (including text waiting for lookahead)
    const remaining = await this._textAggregator.flush();
    // Stop the aggregation metric (no-op if already stopped on first sentence).
    await this.stopTextAggregationMetrics();
    if (remaining) {
      await this._handleAggregatedText(this._aggregatedTextFrame(remaining));
    }

    // Force-promote any sentence still pending in the sequencer (streaming
    // mode only; a no-op otherwise) — handles a response that ends with no
    // terminal punctuation.
    await this._pushSequencerFrames(
      await this._aggregatedFrameSequencer.finalize(this._turnContextId),
      this._turnContextId,
    );

    await this._holdFramesWhileAudioContextsOpen();

    // Log accumulated streamed text and emit aggregated usage metric.
    if (this._streamedText) {
      logger.debug(`${this}: Generating TTS [${this._streamedText}]`);
      await super.startTtsUsageMetrics(this._streamedText);
      this._streamedText = "";
    }

    // Reset aggregator state
    this._sentNonWhitespaceInContext = false;
    if (frame instanceof LLMFullResponseEndFrame) {
      // Queue behind the audio contexts so the frame follows the turn's audio
      // and text.
      await this._audioContextManager.putFrame(frame);
    } else {
      await this.pushFrame(frame, direction);
    }

    await this.onTurnContextCompleted();
  }

  /** Queue each sentence of LLM text that isn't spoken. */
  protected async _handleSkippedLlmText(frame: LLMTextFrame): Promise<void> {
    for await (const aggregate of this._skippedTextAggregator.aggregate(frame.text)) {
      await this._queueSkippedLlmText(aggregate);
    }
  }

  /** Queue the rest of a reply that isn't spoken, then the end of the reply. */
  protected async _handleSkippedLlmResponseEnd(frame: LLMFullResponseEndFrame): Promise<void> {
    const remaining = await this._skippedTextAggregator.flush();
    if (remaining) {
      await this._queueSkippedLlmText(remaining);
    }
    await this._audioContextManager.putFrame(frame);
  }

  /** Queue a sentence of LLM text that isn't spoken, as the bot's output. */
  protected async _queueSkippedLlmText(aggregation: Aggregation): Promise<void> {
    if (!aggregation.text.trim()) return;
    const frame = this._aggregatedTextFrame(aggregation);
    frame.skipTts = true;
    frame.transportDestination = this._transportDestination;
    await this._audioContextManager.putFrame(frame);
  }

  /** Speak a TTSSpeakFrame as a turn of its own, even in the middle of an LLM turn. */
  protected async _handleTtsSpeak(frame: TTSSpeakFrame): Promise<void> {
    const savedSentNonWhitespace = this._sentNonWhitespaceInContext;
    this._sentNonWhitespaceInContext = false;
    // TTSSpeakFrame is independent — temporarily clear the turn context so
    // createContextId() generates a fresh UUID for this utterance.
    const savedTurnContextId = this._turnContextId;
    this._turnContextId = null;
    // Creating a new contextId for the TTS request.
    const speakContextId = this.createContextId();
    this._turnContextId = speakContextId;
    // Inside an LLM turn, the end of the turn commits the spoken text to the
    // context. Outside one, the speak frame commits it once spoken.
    this._ttsContexts.set(
      speakContextId,
      new TTSContext({
        appendToContext: frame.appendToContext,
        pushAssistantAggregation: frame.appendToContext && !savedTurnContextId,
        interruptible: frame.interruptible,
      }),
    );
    await this.onTurnContextCreated(speakContextId);
    const textFrame = new AggregatedTextFrame({
      text: frame.text,
      textType: frame.textType,
      rawText: frame.text,
    });
    textFrame.interruptible = frame.interruptible;
    await this._handleAggregatedText(textFrame, speakContextId);
    // Force-promote the utterance's pending sentence into a real slot
    // (streaming mode only; a no-op otherwise). A TTSSpeakFrame is a
    // self-contained sentence with no following token to confirm its
    // boundary, so without this it would stay buffered and never be spoken.
    await this._pushSequencerFrames(
      await this._aggregatedFrameSequencer.finalize(this._turnContextId),
      this._turnContextId,
    );
    await this.onTurnContextCompleted();
    if (!this.audioContextAvailable(speakContextId)) {
      this._ttsContexts.delete(speakContextId);
    }
    this._turnContextId = savedTurnContextId;
    this._sentNonWhitespaceInContext = savedSentNonWhitespace;
    // Inside an LLM turn, the end of the turn holds the next frames.
    if (!savedTurnContextId) {
      await this._holdFramesWhileAudioContextsOpen();
    }
  }

  /** Apply a settings update meant for this service, or pass it on. */
  protected async _handleUpdateSettings(
    frame: TTSUpdateSettingsFrame,
    direction: FrameDirection,
  ): Promise<void> {
    if (frame.service !== null && frame.service !== this) {
      await this.pushFrame(frame, direction);
    } else if (frame.delta !== null) {
      await this._updateSettings(frame.delta);
    }
  }

  /** Reset the turn and drop interruptible audio contexts. */
  protected async _handleInterruption(
    _frame: InterruptionFrame,
    _direction: FrameDirection,
  ): Promise<void> {
    this._sentNonWhitespaceInContext = false;
    this._streamedText = "";
    this._textAggregationMetricsStarted = false;

    await this._textAggregator.handleInterruption();
    await this._skippedTextAggregator.handleInterruption();
    for (const filter of this._textFilters) {
      await filter.handleInterruption();
    }

    await this._interruptAudioContexts();
    this._createAudioContextTask();
    // Uninterruptible speech still open holds frames, even when the reply it
    // was part of never ended to hold them.
    await this._holdFramesWhileAudioContextsOpen();
    // Dropped contexts never reach _endAudioContext, so frames held for them
    // are released here.
    await this._releaseFramesIfAudioContextsEnded();
  }

  /** Discard interruptible contexts while preserving ongoing synthesis and playback. */
  protected async _interruptAudioContexts(): Promise<void> {
    const preserved = new Set<string>();
    for (const [key, context] of this._ttsContexts) {
      if (!context.interruptible) preserved.add(key);
    }
    const playingContextId = this._audioContextManager.playingContextId;
    const interruptPlaying = !(playingContextId !== null && preserved.has(playingContextId));
    if (interruptPlaying) {
      await this._stopAudioContextTask();
      await this.resetWordTimestamps();
      // Next words follow the uninterruptible words still to play.
      this._wordTimestampTracker.lastPts = this._wordTimestampTracker.uninterruptibleLastPts;
    }

    this._audioContextManager.reset();
    this._aggregatedFrameSequencer.clear({ keepContexts: preserved });

    for (const contextId of this.getAudioContexts()) {
      if (preserved.has(contextId)) continue;
      // A failing provider hook must not prevent cleanup or task restart.
      try {
        await this.onAudioContextInterrupted(contextId);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(
          `${this} on_audio_context_interrupted failed for ${contextId}: ${errorText(e)}`,
        );
      }
      this._audioContextManager.remove(contextId);
      this._ttsContexts.delete(contextId);
    }

    if (interruptPlaying) {
      this.resetActiveAudioContext();
    }
    if (!(this._turnContextId !== null && preserved.has(this._turnContextId))) {
      this._turnContextId = null;
    }
  }

  /**
   * Hold incoming frames while an audio context is open.
   *
   * Services whose audio doesn't carry its request's context ID label
   * incoming audio with the context still open, so the next request waits for
   * every open context to end. Contexts play in order, so audio from
   * different requests never overlaps.
   */
  protected async _holdFramesWhileAudioContextsOpen(): Promise<void> {
    if (this._pauseFrameProcessing && this.getAudioContexts().length > 0) {
      await this.pauseProcessingFrames();
    }
  }

  /** Let held frames through once no audio context is open. */
  protected async _releaseFramesIfAudioContextsEnded(): Promise<void> {
    if (this._pauseFrameProcessing && this.getAudioContexts().length === 0) {
      await this.resumeProcessingFrames();
    }
  }

  /** Make a frame of an uninterruptible context uninterruptible too. */
  protected _applyContextInterruptible(frame: Frame): void {
    const contextId = (frame as { contextId?: string | null }).contextId ?? null;
    const context = contextId !== null ? this._ttsContexts.get(contextId) : undefined;
    if (context) {
      frame.interruptible = frame.interruptible && context.interruptible;
    }
    if (frame instanceof TTSTextFrame && frame.pts && !frame.interruptible) {
      this._wordTimestampTracker.uninterruptibleLastPts = frame.pts;
    }
  }

  /** Forget a stopped context and push the assistant aggregation it asked for. */
  protected async _finishTtsContext(frame: TTSStoppedFrame): Promise<void> {
    let context: TTSContext | undefined;
    if (frame.contextId) {
      context = this._ttsContexts.get(frame.contextId);
      this._ttsContexts.delete(frame.contextId);
    }
    if (!context) return;
    logger.debug(`${this} cleaning up TTS context ${frame.contextId}`);
    if (context.pushAssistantAggregation) {
      const aggregationFrame = new LLMAssistantPushAggregationFrame();
      aggregationFrame.interruptible = frame.interruptible;
      // When word-level TTSTextFrames are routed through the transport's
      // clock queue (PTS-based), the aggregation frame would otherwise take
      // the audio (sync) queue path and could overtake the final word frames.
      // Stamping it with a PTS just past the last word forces it through the
      // clock queue too, so the assistant aggregator sees every word before
      // flushing.
      if (this._wordTimestampTracker.lastPts) {
        aggregationFrame.pts = this._wordTimestampTracker.lastPts + 1;
      }
      await this.pushFrame(aggregationFrame);
    }
  }

  /** Push the silence configured to follow a TTSStoppedFrame. */
  protected async _pushStopSilence(frame: TTSStoppedFrame): Promise<void> {
    if (!this._pushSilenceAfterStop) return;
    const silenceNumBytes = Math.trunc(this._silenceTimeS * this.sampleRate * 2); // 16-bit
    const silenceFrame = new TTSAudioRawFrame({
      audio: new Uint8Array(silenceNumBytes),
      sampleRate: this.sampleRate,
      numChannels: 1,
    });
    silenceFrame.interruptible = frame.interruptible;
    await this.pushFrame(silenceFrame);
  }

  /** Send a segment's willBeSpoken frame through the transport's clock queue. */
  protected _stampSegmentAnnouncement(frame: AggregatedTextFrame): void {
    // The willBeSpoken AggregatedTextFrame is the "new segment" announcement
    // whose segmentId the per-word progress frames reference. Those progress
    // frames carry a PTS and travel the transport's clock queue; the
    // announcement itself has no PTS and would take the audio (sync) queue,
    // so for a context whose audio is delayed behind another context's, its
    // clock-queued progress can be delivered before it. Stamp it with the
    // same baseline the first word will use so it rides the clock queue too,
    // sorted immediately before its first progress frame (ties broken by push
    // order). Only on the word-timestamp path (pushTextFrames services have no
    // progress frames).
    if (frame.willBeSpoken && frame.pts === null && !this._pushTextFrames) {
      frame.pts = Math.max(this._wordTimestampTracker.lastPts, this.getClock().getTime());
    }
  }

  //
  // Text to speech
  //

  /** Whether the service is streaming tokens directly without sentence aggregation. */
  protected get _isStreamingTokens(): boolean {
    return this._textAggregationMode === TextAggregationMode.TOKEN;
  }

  /** Aggregate LLM text and speak each aggregation. */
  protected async _handleText(frame: TextFrame): Promise<void> {
    for await (const aggregate of this._textAggregator.aggregate(frame.text)) {
      if (aggregate.type !== TextType.TOKEN) {
        // Stop the aggregation metric on the first sentence only.
        await this.stopTextAggregationMetrics();
      }
      await this._handleAggregatedText(this._aggregatedTextFrame(aggregate));
    }
  }

  /** Build the frame for an aggregation, keeping a pattern's delimiters in its raw text. */
  protected _aggregatedTextFrame(aggregation: Aggregation): AggregatedTextFrame {
    const rawText = aggregation instanceof PatternMatch ? aggregation.fullMatch : aggregation.text;
    return new AggregatedTextFrame({
      text: aggregation.text,
      textType: aggregation.type,
      rawText,
    });
  }

  /** Speak aggregated text in `contextId` or a new context, or push it on if skipped. */
  protected async _handleAggregatedText(
    srcFrame: AggregatedTextFrame,
    contextId: string | null = null,
  ): Promise<void> {
    const id = contextId || this.createContextId();
    const text = this._trimText(srcFrame.text);
    if (this._skipTextTypes.includes(srcFrame.textType)) {
      await this._pushSkippedText(srcFrame, id);
    } else if (text !== null) {
      await this._speakText(srcFrame, text, id);
    }
  }

  /** Push text that isn't spoken, in order with the spoken text around it. */
  protected async _pushSkippedText(frame: AggregatedTextFrame, contextId: string): Promise<void> {
    // Marked so whatever is downstream knows the TTS left it out.
    frame.skipTts = true;
    // The sequencer returns the frame at once if no spoken slot precedes it,
    // or holds it until it can flush it in order.
    await this._pushSequencerFrames(
      await this._aggregatedFrameSequencer.registerSkipped(
        frame,
        contextId,
        this._transportDestination,
      ),
      contextId,
    );
  }

  /** Filter, transform and synthesize text, timing it as processing. */
  protected async _speakText(
    srcFrame: AggregatedTextFrame,
    text: string,
    contextId: string,
  ): Promise<void> {
    // Accumulate text for a single debug log at flush time when streaming
    // tokens.
    if (this._isStreamingTokens) {
      this._streamedText += text;
    }

    // Two things disqualify the measurement. A service that hands text off
    // for synthesis elsewhere would time only the handoff, and a token is the
    // wrong unit to report a processing time against — one metric per token,
    // for work that spans a sentence. TTFB and TTFA carry the timing that
    // matters in both cases.
    if (this.supportsProcessingMetrics && !this._isStreamingTokens) {
      await this.startProcessingMetrics();
    }

    const filteredText = await this._filterText(text);
    if (filteredText !== null) {
      const preparedText = await this._transformText(filteredText, srcFrame.textType);
      if (preparedText !== null) {
        // A TTSSpeakFrame sets up its context before its text gets here.
        let context = this._ttsContexts.get(contextId);
        if (!context) {
          context = new TTSContext({ interruptible: srcFrame.interruptible });
          this._ttsContexts.set(contextId, context);
        }
        await this._announceText(srcFrame, contextId);
        await this._callEventHandler("on_tts_request", contextId, preparedText);
        await this._startAudioContext(contextId);
        await this._registerSpokenText(srcFrame, preparedText, contextId);
        await this._synthesizeText(preparedText, contextId);
        await this._pushSpokenText(srcFrame, filteredText, contextId, context.appendToContext);
      }
    }

    await this.stopProcessingMetrics();
  }

  /** Trim leading whitespace from text to synthesize, or null if nothing is left to say. */
  protected _trimText(text: string): string | null {
    // Whitespace gating depends on aggregation mode:
    // - Token streaming: drop all leading whitespace at the start of a
    //   context, as nothing substantive has been sent yet for it to attach
    //   to. Once a non-whitespace token has been sent, send whitespace as-is
    //   since it can influence prosody between non-whitespace tokens.
    //
    // - Sentence aggregation: strip leading newlines only and drop
    //   pure-whitespace frames.
    let result = text;
    let hasText: boolean;
    if (this._isStreamingTokens) {
      if (!this._sentNonWhitespaceInContext) {
        result = result.trimStart();
      }
      hasText = result.length > 0;
    } else {
      result = result.replace(/^\n+/, "");
      hasText = result.trim().length > 0;
    }
    return hasText ? result : null;
  }

  /**
   * Run the text filters on text about to be synthesized.
   *
   * @returns The filtered text, or null if nothing is left to say.
   */
  protected async _filterText(text: string): Promise<string | null> {
    let result = text;
    for (const filter of this._textFilters) {
      await filter.resetInterruption();
      result = await filter.filter(result);
    }

    // Mirrors the whitespace gate before the filters, so filter output that
    // collapses to whitespace-only is handled consistently. When streaming
    // tokens, whitespace is only sent once something else has been.
    let hasText: boolean;
    if (this._isStreamingTokens) {
      hasText = result.trim().length > 0 || (result.length > 0 && this._sentNonWhitespaceInContext);
      if (hasText) {
        this._sentNonWhitespaceInContext = true;
      }
    } else {
      hasText = result.trim().length > 0;
    }
    return hasText ? result : null;
  }

  /**
   * Turn filtered text into the text sent to the TTS.
   *
   * Transforms only affect the text sent to the TTS for TTS-specific purposes
   * (e.g. inserting tags for spelling or emotion, or replacing an @ with
   * "at"). For services with word timestamps they can affect the context,
   * since TTSTextFrames are built from the TTS output.
   *
   * @returns The text to synthesize, or null if a transform failed.
   */
  protected async _transformText(text: string, textType: string): Promise<string | null> {
    let transformedText = text;
    let preparedText: string | null = null;
    try {
      for (const [transformType, transform] of this._textTransforms) {
        if (
          (transformType === textType || transformType === "*") &&
          (!((transform as unknown) instanceof PronunciationTransform) ||
            this._canApplyPronunciations())
        ) {
          transformedText = await transform(transformedText, textType);
        }
      }
      // Apply any final text preparation (e.g., trailing space)
      preparedText = this._prepareTextForTts(transformedText);
    } catch (e) {
      rethrowIfCancelled(e);
      // Pushing the error with category "APPLICATION" since the failure came
      // from the application's text transformer. Speaking the untransformed
      // text isn't safe — a transformer may exist to remove something — so
      // this turn produces no audio.
      await this.pushError(
        `Error transforming text for TTS [${transformedText}]: ${errorText(e)}`,
        {
          exception: e,
          category: ErrorCategory.APPLICATION,
        },
      );
    }
    return preparedText;
  }

  /** Whether pronunciation transforms apply, warning once when they stop applying. */
  protected _canApplyPronunciations(): boolean {
    const supported = this.supportsPronunciations;
    if (!supported && !this._skippingPronunciations) {
      logger.warning(
        `${this} does not read pronunciation markup with its current settings ` +
          `(model ${this._settings.model}), so pronunciation hints are spoken as written`,
      );
    }
    this._skippingPronunciations = !supported;
    return supported;
  }

  /**
   * Prepare text for TTS by applying any transformations required by the TTS service.
   *
   * @param text The text to prepare.
   * @returns The prepared text with transformations applied.
   */
  protected _prepareTextForTts(text: string): string {
    // A trailing space only makes sense on sentence-sized inputs. When
    // streaming tokens, the incoming text's own whitespace is authoritative:
    // appending a space to every token would split words across tokens.
    if (this._appendTrailingSpace && !this._isStreamingTokens && !text.endsWith(" ")) {
      return `${text} `;
    }
    return text;
  }

  /** Mark text as about to be spoken and push it ahead of its audio. */
  protected async _announceText(srcFrame: AggregatedTextFrame, contextId: string): Promise<void> {
    // To support use cases that may want to know the text before it's spoken,
    // we push the AggregatedTextFrame version before sending it to TTS.
    // However, we do not want to add this text to the assistant context until
    // it is spoken, so we set appendToContext to false.
    srcFrame.appendToContext = false;
    srcFrame.contextId = contextId;
    srcFrame.willBeSpoken = true;

    // In streaming (TOKEN) mode this srcFrame is a single token, not the unit
    // the listener cares about: the sequencer regroups tokens into a sentence
    // and emits that sentence as the willBeSpoken anchor (see _promote).
    // Pushing srcFrame too would emit a second, redundant anchor (for a
    // TTSSpeakFrame, an exact duplicate). So only the non-streaming path
    // pushes srcFrame, queued behind the audio contexts so it is emitted
    // immediately before the TTSStartedFrame of the audio context it
    // describes, or into that context if it exists.
    if (!this._isStreamingTokens) {
      if (this.audioContextAvailable(contextId)) {
        await this.appendToAudioContext(contextId, srcFrame);
      } else {
        await this._audioContextManager.putFrame(srcFrame);
      }
    }
  }

  /** Open an audio context with a TTSStartedFrame, for services that leave it to the base. */
  protected async _startAudioContext(contextId: string): Promise<void> {
    if (!this._pushStartFrame || this.audioContextAvailable(contextId)) return;
    await this.createAudioContext(contextId);
    await this.startTtfbMetrics();
    // Note: TTSStartedFrame's appendToContext is stamped in
    // _pushAudioContextItem, where every TTSStartedFrame (base-class- and
    // subclass-emitted) funnels through.
    await this.appendToAudioContext(contextId, new TTSStartedFrame({ contextId }));
  }

  /** Give the text a slot in the sequencer, which orders it with skipped text. */
  protected async _registerSpokenText(
    srcFrame: AggregatedTextFrame,
    text: string,
    contextId: string,
  ): Promise<void> {
    // The slot unblocks any skipped frames queued behind it once complete.
    // Word-timestamp services complete it via processWord; pushTextFrames
    // services complete it after the TTSTextFrame is appended to the audio
    // context. When streaming tokens, the sequencer accumulates this call's
    // text into a pending sentence internally and only registers a real slot
    // once a sentence boundary is detected.
    const context = this._ttsContexts.get(contextId) as TTSContext;
    await this._pushSequencerFrames(
      await this._aggregatedFrameSequencer.registerSpoken(
        srcFrame,
        contextId,
        text,
        context.appendToContext,
        {
          buildTracker: !this._pushTextFrames,
          language: this.textAggregationLanguage,
        },
      ),
      contextId,
    );
  }

  /**
   * Emit frames returned by the aggregated-frame sequencer in audio order.
   *
   * In streaming (TOKEN) mode these frames — a promoted sentence anchor and
   * any replayed word/progress frames — describe an audio context whose audio
   * and word frames are emitted by the dedicated audio-context task. Routing
   * them through that context's queue keeps a single consumer emitting
   * everything in order; pushing directly here would let them race the
   * audio-context task. When the context is gone (or the sequencer is
   * non-streaming), push directly.
   *
   * @param frames Frames returned by registerSpoken/registerSkipped/finalize.
   * @param contextId The context these frames belong to.
   */
  protected async _pushSequencerFrames(frames: Frame[], contextId: string | null): Promise<void> {
    for (const f of frames) {
      if (this._isStreamingTokens && contextId && this.audioContextAvailable(contextId)) {
        await this.appendToAudioContext(contextId, f);
      } else {
        await this.pushFrame(f);
      }
    }
  }

  /** Run the service's runTts for text, unless the service is no longer usable. */
  protected async _synthesizeText(text: string, contextId: string): Promise<void> {
    // When streaming tokens, per-call logs are kept at trace level; the
    // accumulated turn text is logged at debug level at flush time.
    if (this._isStreamingTokens) {
      logger.trace(`${this}: Generating TTS [${text}]`);
    } else {
      logger.debug(`${this}: Generating TTS [${text}]`);
    }

    // A service that can no longer work can't synthesize anything, and
    // services that connect on demand would attempt a handshake per request.
    // The surrounding bookkeeping still runs, so the turn completes with no
    // audio rather than stalling.
    if (this.isUsable) {
      await this.ttsProcessGenerator(contextId, this.runTts(text, contextId));
    } else {
      // Name the text that goes unspoken: silence from the bot is otherwise
      // hard to trace back to the service that caused it.
      logger.warning(`${this}: service is no longer usable, not speaking [${text}]`);
    }
  }

  /** Queue the spoken text behind its audio, for services without word timestamps. */
  protected async _pushSpokenText(
    srcFrame: AggregatedTextFrame,
    text: string,
    contextId: string,
    appendToContext: boolean,
  ): Promise<void> {
    // In TTS services that support word timestamps, the TTSTextFrames are
    // pushed as words are spoken. Services without word timestamps
    // (_pushTextFrames) get the original (non-transformed) text after the TTS
    // generation has completed. This way, if we are interrupted, the text is
    // not added to the assistant context and the context that IS added does
    // not include TTS-specific tags or transformations.
    //
    // In streaming (TOKEN) mode this is handled instead by the sequencer's
    // per-sentence promotion (see AggregatedFrameSequencer._promote): a call
    // here represents a single token, not the sentence-level unit this frame
    // should carry.
    if (!this._pushTextFrames || this._isStreamingTokens) return;
    const frame = new TTSTextFrame({
      text,
      textType: srcFrame.textType,
      segmentId: srcFrame.id,
    });
    frame.willBeSpoken = true;
    frame.contextId = contextId;
    frame.appendToContext = appendToContext;
    // Appending to the context, so it preserves the ordering.
    await this.appendToAudioContext(contextId, frame);
    // TTSTextFrame is queued; mark the spoken slot complete so any skipped
    // frames (e.g. code blocks) waiting behind it can be flushed in order.
    for (const f of this._aggregatedFrameSequencer.completeSpokenSlot()) {
      await this.pushFrame(f);
    }
  }

  /**
   * Stream audio frames from an async byte iterator with optional resampling.
   *
   * For WAV data, use `stripWavHeader: true` to strip the header and
   * auto-detect the source sample rate. For raw PCM data, pass `inSampleRate`
   * directly. Audio is resampled to `this.sampleRate` when the source rate
   * differs.
   *
   * @param iterator Async iterator yielding audio bytes.
   * @param options.stripWavHeader Strip WAV header and parse source sample
   *   rate from it.
   * @param options.inSampleRate Source sample rate for raw PCM data.
   *   Overrides WAV-detected rate if both are provided.
   * @param options.contextId Unique identifier for this TTS context.
   */
  protected async *_streamAudioFramesFromIterator(
    iterator: AsyncIterable<Uint8Array>,
    options: {
      stripWavHeader?: boolean;
      inSampleRate?: number | null;
      contextId?: string | null;
    } = {},
  ): AsyncGenerator<Frame, void> {
    let buffer: Uint8Array = new Uint8Array(0);
    let sourceSampleRate = options.inSampleRate ?? null;
    let needToStripWavHeader = options.stripWavHeader ?? false;
    const contextId = options.contextId ?? null;

    const maybeResample = async (audio: Uint8Array): Promise<Uint8Array> => {
      if (sourceSampleRate && sourceSampleRate !== this.sampleRate) {
        return await this._resampler.resample(audio, sourceSampleRate, this.sampleRate);
      }
      return audio;
    };

    for await (let chunk of iterator) {
      if (needToStripWavHeader && startsWithRiff(chunk)) {
        // Parse sample rate from WAV header (bytes 24-28, little-endian uint32).
        if (chunk.length >= 44 && sourceSampleRate === null) {
          sourceSampleRate = new DataView(chunk.buffer, chunk.byteOffset, chunk.length).getUint32(
            24,
            true,
          );
        }
        chunk = chunk.subarray(44);
        needToStripWavHeader = false;
      }

      // Append to current buffer.
      buffer = concatBytes(buffer, chunk);

      // Round to nearest even number.
      const alignedLength = buffer.length & ~1; // 111111111...11110
      if (alignedLength > 0) {
        const alignedChunk = await maybeResample(buffer.slice(0, alignedLength));
        buffer = buffer.slice(alignedLength); // keep any leftover byte

        if (alignedChunk.length > 0) {
          yield new TTSAudioRawFrame({
            audio: alignedChunk,
            sampleRate: this.sampleRate,
            numChannels: 1,
            contextId,
          });
        }
      }
    }

    if (buffer.length > 0) {
      // Make sure we don't need an extra padding byte.
      if (buffer.length % 2 === 1) {
        buffer = concatBytes(buffer, new Uint8Array(1));
      }
      const audio = await maybeResample(buffer);
      yield new TTSAudioRawFrame({
        audio,
        sampleRate: this.sampleRate,
        numChannels: 1,
        contextId,
      });
    }
  }

  //
  // Word frames
  //

  /**
   * Process word timestamps directly, building and pushing TTSTextFrames inline.
   *
   * Used both from _handleAudioContext (via WordTimestamp items) and from
   * services that do not use audio contexts. Each entry emits a TTSTextFrame
   * with a PTS relative to when startWordTimestamps() was called. Entries that
   * come before that are cached and timed once it is called (i.e. when the
   * first audio chunk is received).
   */
  protected async _addWordTimestamps(
    wordTimes: readonly (readonly [string, number])[],
    contextId: string | null = null,
    options: { includesInterFrameSpaces?: boolean } = {},
  ): Promise<void> {
    const includesInterFrameSpaces = options.includesInterFrameSpaces ?? false;
    for (const [word, timestamp] of wordTimes) {
      if (!this._wordTimestampTracker.started) {
        this._wordTimestampTracker.cache(
          new WordTimestamp({ word, timestamp, contextId, includesInterFrameSpaces }),
        );
        continue;
      }
      // Build TTSTextFrame(s) for this word token, advancing the active
      // slot's tracker and flushing any skipped frames now unblocked.
      await this._pushWordFrames(
        this._aggregatedFrameSequencer.processWord(
          word,
          this._wordTimestampTracker.pts(timestamp),
          contextId,
          includesInterFrameSpaces,
        ),
      );
    }
  }

  /** Push frames built by the sequencer, noting the PTS of the last word. */
  protected async _pushWordFrames(frames: Frame[]): Promise<void> {
    for (const f of frames) {
      if (f instanceof TTSTextFrame) {
        // The sequencer stamps every word frame it builds.
        if (f.pts === null) throw new Error("word frame built without a PTS");
        this._wordTimestampTracker.lastPts = f.pts;
      }
      await this.pushFrame(f);
    }
  }

  /**
   * Force-complete a context's spoken slots and push any unblocked skipped frames.
   *
   * Called at end-of-context to handle TTS providers that silently drop
   * word-timestamp events. Emits a TTSTextFrame for any remaining unspoken
   * text in this context, then flushes skipped frames that were blocked by
   * those incomplete slots. Slots for other contexts still in flight are left
   * untouched.
   *
   * @param contextId The audio context that has ended.
   */
  protected async _applyForceComplete(contextId: string): Promise<void> {
    await this._pushWordFrames(
      this._aggregatedFrameSequencer.forceComplete(contextId, this._wordTimestampTracker.lastPts),
    );
  }

  //
  // Audio context playback
  //

  /** Signal that the audio context is still in use, resetting the timeout. */
  protected _refreshAudioContext(contextId: string): void {
    this._audioContextManager.keepalive(contextId);
  }

  /** Create the task that plays audio contexts. */
  protected _createAudioContextTask(): void {
    if (!this._audioContextTask) {
      this._audioContextTask = this.createTask(
        () => this._audioContextTaskHandler(),
        "_audioContextTaskHandler",
      );
    }
  }

  /** Cancel the task that plays audio contexts. */
  protected async _stopAudioContextTask(): Promise<void> {
    if (this._audioContextTask) {
      await this.cancelTask(this._audioContextTask);
      this._audioContextTask = null;
    }
  }

  /**
   * Play audio contexts and the frames between them in order.
   *
   * Each audio context plays until all its audio has been pushed downstream,
   * then onAudioContextCompleted() is called. A frame between contexts (e.g.
   * an AggregatedTextFrame preceding its audio, or a frame that arrived
   * between two speak frames) is pushed at its position.
   */
  protected async _audioContextTaskHandler(): Promise<void> {
    let running = true;
    while (running) {
      const contextValue = await this._audioContextManager.nextForPlayback();
      if (contextValue instanceof AudioContextFrame) {
        await this._handleAudioContext(contextValue.contextId);
      } else if (contextValue instanceof Frame) {
        this._stampLlmResponseFrame(contextValue);
        await this.pushFrame(contextValue);
      } else {
        running = false;
      }
    }
  }

  /** Send a reply's end frame after its words, or behind its start frame if it timed none. */
  protected _stampLlmResponseFrame(frame: Frame): void {
    if (frame instanceof LLMFullResponseStartFrame) {
      this._wordTimestampTracker.startReply();
    } else if (frame instanceof LLMFullResponseEndFrame && !this._pushTextFrames) {
      frame.pts = this._wordTimestampTracker.replyLastPts;
    }
  }

  /** Push an audio context's items in order until it ends or goes quiet. */
  protected async _handleAudioContext(contextId: string): Promise<void> {
    const playback = new _AudioContextPlayback();
    let item = await this._nextAudioContextItem(contextId);
    while (item !== null) {
      await this._pushAudioContextItem(contextId, item, playback);
      item = await this._nextAudioContextItem(contextId);
    }
    await this._endAudioContext(contextId, playback);
  }

  /** Wait for the context's next item, or null once it ends or goes quiet. */
  protected async _nextAudioContextItem(contextId: string): Promise<AudioContextItem | null> {
    let item: AudioContextItem | null = null;
    try {
      item =
        ((await this._audioContextManager.get(
          contextId,
          this._stopFrameTimeoutS,
        )) as AudioContextItem | null) ?? null;
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
      // We didn't get audio, so let's consider this context finished.
      logger.trace(`${this} time out on audio context ${contextId}`);
    }
    return item;
  }

  /** Push one item of the playing audio context. */
  protected async _pushAudioContextItem(
    contextId: string,
    item: AudioContextItem,
    playback: _AudioContextPlayback,
  ): Promise<void> {
    if (item instanceof WordTimestamp) {
      // Route word timestamps through _addWordTimestamps so they are
      // processed in playback order alongside audio frames.
      await this._addWordTimestamps([[item.word, item.timestamp]], item.contextId, {
        includesInterFrameSpaces: item.includesInterFrameSpaces,
      });
    } else if (item instanceof ErrorFrame) {
      await this.pushErrorFrame(item);
    } else {
      if (item instanceof TTSAudioRawFrame) {
        // Set the word-timestamp baseline once, on the first audio chunk.
        if (!playback.receivedAudio) {
          await this.stopTtfbMetrics();
          await this.startWordTimestamps();
        }
        playback.receivedAudio = true;
        await this.processTtfaMetrics(item);
      } else if (item instanceof TTSStartedFrame) {
        playback.stopFrameDue = this._pushStopFrames;
        // Stamp appropriate appendToContext value onto every TTSStartedFrame
        // here — the single point both base-class- and subclass-emitted
        // started frames pass through.
        const ttsContext = this._ttsContexts.get(contextId);
        if (ttsContext !== undefined) {
          item.appendToContext = ttsContext.appendToContext;
        }
      } else if (item instanceof TTSStoppedFrame) {
        // Checking if we have any remaining spoken slots before pushing the
        // TTSStoppedFrame
        await this._applyForceComplete(contextId);
        playback.stopFrameDue = false;
        // Setting the last word timestamp as the TTSStoppedFrame PTS
        if (!item.pts) {
          item.pts = this._wordTimestampTracker.lastPts;
        }
      }
      await this.pushFrame(item);
    }
  }

  /** Finish the playing audio context once it ends or goes quiet. */
  protected async _endAudioContext(
    contextId: string,
    playback: _AudioContextPlayback,
  ): Promise<void> {
    // Words the provider never timed come before the stop frame.
    await this._applyForceComplete(contextId);
    if (playback.stopFrameDue) {
      await this.pushFrame(new TTSStoppedFrame({ contextId }));
    }
    await this.resetWordTimestamps();
    await this._recordContextAudioOutcome(contextId, playback.receivedAudio);

    // If audio resumes after a timeout, the context is recreated without the
    // partial sample held here.
    this._audioContextManager.remove(contextId);
    // A failing hook must not end the playback task, or no more audio is
    // played.
    try {
      await this.onAudioContextCompleted(contextId);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`${this} on_audio_context_completed failed for ${contextId}: ${errorText(e)}`);
    }
    this.resetActiveAudioContext();
    await this._releaseFramesIfAudioContextsEnded();
  }

  /**
   * Track whether contexts are producing audio, and act when they stop.
   *
   * A provider can accept every request and return no audio at all — an
   * unknown voice ID, say — without ever reporting an error. Every context
   * that completes in silence is reported as an error, so application code
   * hears about a turn that produced no speech as it happens. Enough of them
   * in a row means the service isn't going to speak again, so it is reported
   * unable to do its job: it stops being given work, a `ServiceSwitcher` can
   * fail over to another provider, and the pipeline worker applies its
   * `ProcessorUnusablePolicy`.
   *
   * Only contexts that complete are counted; an interrupted context is
   * cancelled before it gets here.
   *
   * @param contextId The audio context that just completed.
   * @param receivedAudio Whether any audio arrived for that context.
   */
  protected async _recordContextAudioOutcome(
    contextId: string,
    receivedAudio: boolean,
  ): Promise<void> {
    if (receivedAudio) {
      this._consecutiveZeroAudioContexts = 0;
      return;
    }

    // An unusable service is deliberately not given work (see
    // _synthesizeText), so its silent contexts say nothing new.
    if (!this.isUsable) return;

    this._consecutiveZeroAudioContexts += 1;
    logger.warning(
      `${this} audio context ${contextId} completed with no audio ` +
        `(${this._consecutiveZeroAudioContexts} in a row)`,
    );

    if (
      this._maxConsecutiveZeroAudioContexts &&
      this._consecutiveZeroAudioContexts >= this._maxConsecutiveZeroAudioContexts
    ) {
      await this.pushError(
        `${this._consecutiveZeroAudioContexts} consecutive TTS contexts ` +
          "completed with no audio",
        { forceTreatAsPermanent: true },
      );
    } else {
      // A single silent context says nothing about whether the service will
      // speak again, so it is reported without costing the service its
      // usability.
      await this.pushError(`TTS context ${contextId} completed with no audio`);
    }
  }
}

export interface WebsocketTTSServiceOptions extends TTSServiceOptions, WebsocketServiceOptions {}

/**
 * Base class for websocket-based TTS services.
 *
 * Combines TTS functionality with websocket connectivity, providing automatic
 * error handling and reconnection capabilities.
 *
 * Includes an optional keepalive for providers that close an idle
 * connection. A subclass enables it by overriding `_sendKeepalive()` to send
 * its provider's keepalive message, and calling
 * `_createKeepaliveTask(interval)` / `_cancelKeepaliveTask()` from its
 * `_connect()` / `_disconnect()`.
 *
 * Event handlers:
 *
 * - on_connection_error: Called when a websocket connection error occurs.
 *
 * @example
 * tts.eventHandler("on_connection_error", async (tts: TTSService, error: string) => {
 *   logger.error(`TTS connection error: ${error}`);
 * });
 */
export abstract class WebsocketTTSService extends WebsocketService(TTSService) {
  protected _keepaliveTask: Task<unknown> | null = null;

  /**
   * Initialize the Websocket TTS service.
   *
   * @param options.reconnectOnError Whether to automatically reconnect on
   *   websocket errors. Other options are passed to parent classes.
   */
  constructor(options: WebsocketTTSServiceOptions = {}) {
    // reconnectOnError defaults to true in the WebsocketService mixin.
    super(options);
  }

  /**
   * Whether this service has a meaningful processing-time metric.
   *
   * false: `runTts` sends the text and returns, and audio arrives later on
   * the receive task, so there is no synthesis inside the measured window. A
   * subclass that instead waits for the server to signal the end of synthesis
   * before returning can override this back to true.
   */
  override get supportsProcessingMetrics(): boolean {
    return false;
  }

  /**
   * Stop the websocket TTS service on a graceful end.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the websocket TTS service immediately.
   *
   * Disconnecting here is the prompt teardown: the websocket receive loop
   * runs independently of the audio-context task, so it keeps reading from
   * the provider until the socket is closed. Stopping only the audio-context
   * task (in `TTSService.cancel()`) halts output but not reception.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /** Release websocket TTS resources at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._disconnect();
  }

  /**
   * End the audio contexts of a connection that is being replaced.
   *
   * Providers keep context state per connection and don't resume it on a new
   * one, so audio still due on the old connection never arrives. Every open
   * context is closed (audio already received still plays), and a turn in
   * progress moves to a new context ID so its remaining sentences open a
   * fresh provider context. Reopening a connection that was already closed,
   * to send the text at hand, doesn't come through here, so the context it
   * sends to stays open.
   */
  protected async _closeConnectionContexts(): Promise<void> {
    for (const contextId of this.getAudioContexts()) {
      await this.removeAudioContext(contextId);
    }
    if (this._turnContextId) {
      this._turnContextId = null;
      this._turnContextId = this.createContextId();
    }
  }

  override async _disconnect(): Promise<void> {
    // Subclasses call super._disconnect() first, so this runs before they
    // close their socket.
    await this._closeConnectionContexts();
    await super._disconnect();
  }

  override async _reconnectWebsocket(attemptNumber: number): Promise<boolean> {
    await this._closeConnectionContexts();
    return await super._reconnectWebsocket(attemptNumber);
  }

  protected async _reportError(
    error: ErrorFrame,
    options: { forceTreatAsPermanent?: boolean } = {},
  ): Promise<void> {
    await this._callEventHandler("on_connection_error", error.error);
    await this.pushErrorFrame(error, {
      forceTreatAsPermanent: options.forceTreatAsPermanent ?? false,
    });
  }

  /**
   * Start the keepalive task if it isn't running.
   *
   * @param interval Seconds between keepalive messages.
   */
  protected _createKeepaliveTask(interval: number): void {
    if (this._keepaliveTask && !this._keepaliveTask.done()) return;
    this._keepaliveTask = this.createTask(() => this._keepaliveTaskHandler(interval), "keepalive");
  }

  /** Stop the keepalive task if running. */
  protected async _cancelKeepaliveTask(): Promise<void> {
    if (this._keepaliveTask) {
      await this.cancelTask(this._keepaliveTask);
      this._keepaliveTask = null;
    }
  }

  /**
   * Send a keepalive every `interval` seconds while connected.
   *
   * A failed send is logged and the loop keeps going: the receive loop
   * handles a lost connection, and the next keepalive goes out on the
   * reconnected socket.
   */
  protected async _keepaliveTaskHandler(interval: number): Promise<void> {
    while (true) {
      await sleep(interval);
      try {
        if (this._isKeepaliveReady()) {
          await this._sendKeepalive();
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this} keepalive error: ${errorText(e)}`);
      }
    }
  }

  /**
   * Check if the service is ready to send a keepalive.
   *
   * @returns true if the websocket is open.
   */
  protected _isKeepaliveReady(): boolean {
    return this._websocket !== null && this._websocket.state === State.OPEN;
  }

  /**
   * Send a keepalive message over the websocket.
   *
   * Subclasses that enable keepalive must override this to send their
   * provider's keepalive message.
   */
  protected async _sendKeepalive(): Promise<void> {
    throw new Error("Subclasses must override _sendKeepalive");
  }
}

export interface InterruptibleTTSServiceOptions extends WebsocketTTSServiceOptions {}

/**
 * Websocket-based TTS service that handles interruptions without word timestamps.
 *
 * Designed for TTS services that don't support word timestamps. Handles
 * interruptions by reconnecting the websocket when the bot is speaking and
 * gets interrupted.
 */
export abstract class InterruptibleTTSService extends WebsocketTTSService {
  // Whether the bot is speaking, as BotStartedSpeakingFrame and
  // BotStoppedSpeakingFrame report it.
  protected _botSpeaking = false;
  // True once runTts has been invoked (TTSStartedFrame pushed) for the
  // current turn but before BotStartedSpeakingFrame confirms playback — the
  // narrow window where _botSpeaking (which only reflects confirmed playback)
  // can't yet tell a reconnect is needed. Kept separate from _botSpeaking so
  // this early, unconfirmed marker never makes a turn that produces no audio
  // look like one that played.
  protected _ttsStarted = false;

  protected override async _handleInterruption(
    frame: InterruptionFrame,
    direction: FrameDirection,
  ): Promise<void> {
    // If the bot is not speaking we don't need to reconnect when the user
    // speaks. If the bot is speaking and the user interrupts we need to
    // reconnect.
    const shouldReconnect = this._botSpeaking || this._ttsStarted;
    // Without context IDs, audio still coming for an interrupted context
    // would be labeled with an uninterruptible one, so the connection is kept
    // only when uninterruptible speech is all that's open.
    const contexts: TTSContext[] = [];
    for (const c of this.getAudioContexts()) {
      const context = this._ttsContexts.get(c);
      if (context) contexts.push(context);
    }
    const keepConnection = contexts.length > 0 && contexts.every((c) => !c.interruptible);
    this._botSpeaking = false;
    this._ttsStarted = false;
    await super._handleInterruption(frame, direction);
    if (shouldReconnect && !keepConnection) {
      await this._disconnect();
      await this._connect();
    }
  }

  /**
   * Push a frame downstream with TTS-specific handling.
   *
   * @param frame The frame to push.
   * @param direction The direction to push the frame.
   */
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    // This prevents a race condition in cases where runTts has been invoked
    // but the BotStartedSpeakingFrame has not yet been received, which could
    // allow stale audio to leak through.
    if (frame instanceof TTSStartedFrame) {
      this._ttsStarted = true;
    }

    await super.pushFrame(frame, direction);
  }

  /**
   * Process frames, tracking whether an interruption needs a reconnect.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof BotStartedSpeakingFrame) {
      this._botSpeaking = true;
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      // The turn ended normally; nothing left to reconnect for.
      this._botSpeaking = false;
      this._ttsStarted = false;
    } else if (frame instanceof LLMFullResponseStartFrame) {
      // Safety net for a previous turn that never produced audio, so
      // BotStoppedSpeakingFrame never arrived to clear it above.
      this._ttsStarted = false;
    }
  }
}

/** Whether a chunk starts with a WAV "RIFF" header. */
function startsWithRiff(chunk: Uint8Array): boolean {
  return (
    chunk.length >= 4 &&
    chunk[0] === 0x52 && // R
    chunk[1] === 0x49 && // I
    chunk[2] === 0x46 && // F
    chunk[3] === 0x46 // F
  );
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Python's `f"{e}"` for an exception. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
