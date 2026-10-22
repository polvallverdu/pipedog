// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/gladia/config.py

/**
 * Configuration for the Gladia STT service.
 *
 * Porting notes:
 * - The pydantic models become classes with options constructors. Fields are
 *   camelCase; `modelDump()` mirrors pydantic's `model_dump(exclude_none=True)`
 *   and produces the snake_case dict that goes on the wire (a protocol is not
 *   an API).
 * - DIVERGENCE: `GladiaInputParams` (deprecated since 0.0.105) is not ported;
 *   use `GladiaSTTService.Settings` and the `encoding`/`bitDepth`/`channels`
 *   init options instead.
 */

type Dict = Record<string, unknown>;

/** Drop `null`/`undefined` values, like `model_dump(exclude_none=True)`. */
function compact(entries: [string, unknown][]): Dict {
  const out: Dict = {};
  for (const [key, value] of entries) {
    if (value !== null && value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export interface LanguageConfigOptions {
  /** List of language codes to use for transcription. */
  languages?: string[] | null;
  /** Whether to auto-detect language changes during transcription. */
  codeSwitching?: boolean | null;
}

/** Configuration for language detection and handling. */
export class LanguageConfig {
  languages: string[] | null;
  codeSwitching: boolean | null;

  constructor(options: LanguageConfigOptions = {}) {
    this.languages = options.languages ?? null;
    this.codeSwitching = options.codeSwitching ?? null;
  }

  /** The wire form: a snake_case dict without unset fields. */
  modelDump(): Dict {
    return compact([
      ["languages", this.languages],
      ["code_switching", this.codeSwitching],
    ]);
  }
}

export interface PreProcessingConfigOptions {
  /** Apply pre-processing to the audio stream to enhance quality. */
  audioEnhancer?: boolean | null;
  /** Sensitivity for speech detection (0-1). */
  speechThreshold?: number | null;
}

/** Configuration for audio pre-processing options. */
export class PreProcessingConfig {
  audioEnhancer: boolean | null;
  speechThreshold: number | null;

  constructor(options: PreProcessingConfigOptions = {}) {
    this.audioEnhancer = options.audioEnhancer ?? null;
    this.speechThreshold = options.speechThreshold ?? null;
  }

  modelDump(): Dict {
    return compact([
      ["audio_enhancer", this.audioEnhancer],
      ["speech_threshold", this.speechThreshold],
    ]);
  }
}

export interface CustomVocabularyItemOptions {
  /** The vocabulary word or phrase. */
  value: string;
  /** The bias intensity for this vocabulary item (0-1). */
  intensity: number;
  /** The pronunciations used in the transcription. */
  pronunciations?: string[] | null;
  /** Language in which it is pronounced when sound comparison occurs. Defaults to the transcription language. */
  language?: string | null;
}

/** Represents a custom vocabulary item with an intensity value. */
export class CustomVocabularyItem {
  value: string;
  intensity: number;
  pronunciations: string[] | null;
  language: string | null;

  constructor(options: CustomVocabularyItemOptions) {
    this.value = options.value;
    this.intensity = options.intensity;
    this.pronunciations = options.pronunciations ?? null;
    this.language = options.language ?? null;
  }

  modelDump(): Dict {
    return compact([
      ["value", this.value],
      ["intensity", this.intensity],
      ["pronunciations", this.pronunciations],
      ["language", this.language],
    ]);
  }
}

export interface CustomVocabularyConfigOptions {
  /** List of words/phrases or CustomVocabularyItem objects. */
  vocabulary?: (string | CustomVocabularyItem)[] | null;
  /** Default intensity for simple string vocabulary items. */
  defaultIntensity?: number | null;
}

/** Configuration for custom vocabulary. */
export class CustomVocabularyConfig {
  vocabulary: (string | CustomVocabularyItem)[] | null;
  defaultIntensity: number | null;

  constructor(options: CustomVocabularyConfigOptions = {}) {
    this.vocabulary = options.vocabulary ?? null;
    this.defaultIntensity = options.defaultIntensity ?? null;
  }

  modelDump(): Dict {
    return compact([
      [
        "vocabulary",
        this.vocabulary?.map((item) => (typeof item === "string" ? item : item.modelDump())) ??
          null,
      ],
      ["default_intensity", this.defaultIntensity],
    ]);
  }
}

export interface CustomSpellingConfigOptions {
  /** Mapping of correct spellings to phonetic variations. */
  spellingDictionary?: Record<string, string[]> | null;
}

/** Configuration for custom spelling rules. */
export class CustomSpellingConfig {
  spellingDictionary: Record<string, string[]> | null;

  constructor(options: CustomSpellingConfigOptions = {}) {
    this.spellingDictionary = options.spellingDictionary ?? null;
  }

  modelDump(): Dict {
    return compact([["spelling_dictionary", this.spellingDictionary]]);
  }
}

export interface TranslationConfigOptions {
  /** List of target language codes for translation. */
  targetLanguages?: string[] | null;
  /** Translation model to use ("base", "batch" or "enhanced"). Gladia defaults to "batch". */
  model?: string | null;
  /** Whether to align translations with original utterances. */
  matchOriginalUtterances?: boolean | null;
  /** Whether to enable lip-sync optimization for translations. */
  lipsync?: boolean | null;
  /** Whether to enable context-aware translation adaptation. */
  contextAdaptation?: boolean | null;
  /** Additional context to help with translation accuracy. */
  context?: string | null;
  /** Force informal language forms when available. */
  informal?: boolean | null;
}

/** Configuration for real-time translation. */
export class TranslationConfig {
  targetLanguages: string[] | null;
  model: string | null;
  matchOriginalUtterances: boolean | null;
  lipsync: boolean | null;
  contextAdaptation: boolean | null;
  context: string | null;
  informal: boolean | null;

  constructor(options: TranslationConfigOptions = {}) {
    this.targetLanguages = options.targetLanguages ?? null;
    this.model = options.model ?? null;
    this.matchOriginalUtterances = options.matchOriginalUtterances ?? null;
    this.lipsync = options.lipsync ?? null;
    this.contextAdaptation = options.contextAdaptation ?? null;
    this.context = options.context ?? null;
    this.informal = options.informal ?? null;
  }

  modelDump(): Dict {
    return compact([
      ["target_languages", this.targetLanguages],
      ["model", this.model],
      ["match_original_utterances", this.matchOriginalUtterances],
      ["lipsync", this.lipsync],
      ["context_adaptation", this.contextAdaptation],
      ["context", this.context],
      ["informal", this.informal],
    ]);
  }
}

export interface RealtimeProcessingConfigOptions {
  /** Whether to provide per-word timestamps. */
  wordsAccurateTimestamps?: boolean | null;
  /** Whether to enable custom vocabulary. */
  customVocabulary?: boolean | null;
  /** Custom vocabulary configuration. */
  customVocabularyConfig?: CustomVocabularyConfig | null;
  /** Whether to enable custom spelling. */
  customSpelling?: boolean | null;
  /** Custom spelling configuration. */
  customSpellingConfig?: CustomSpellingConfig | null;
  /** Whether to enable translation. */
  translation?: boolean | null;
  /** Translation configuration. */
  translationConfig?: TranslationConfig | null;
  /** Whether to enable named entity recognition. */
  namedEntityRecognition?: boolean | null;
  /** Whether to enable sentiment analysis. */
  sentimentAnalysis?: boolean | null;
}

/** Configuration for real-time processing features. */
export class RealtimeProcessingConfig {
  wordsAccurateTimestamps: boolean | null;
  customVocabulary: boolean | null;
  customVocabularyConfig: CustomVocabularyConfig | null;
  customSpelling: boolean | null;
  customSpellingConfig: CustomSpellingConfig | null;
  translation: boolean | null;
  translationConfig: TranslationConfig | null;
  namedEntityRecognition: boolean | null;
  sentimentAnalysis: boolean | null;

  constructor(options: RealtimeProcessingConfigOptions = {}) {
    this.wordsAccurateTimestamps = options.wordsAccurateTimestamps ?? null;
    this.customVocabulary = options.customVocabulary ?? null;
    this.customVocabularyConfig = options.customVocabularyConfig ?? null;
    this.customSpelling = options.customSpelling ?? null;
    this.customSpellingConfig = options.customSpellingConfig ?? null;
    this.translation = options.translation ?? null;
    this.translationConfig = options.translationConfig ?? null;
    this.namedEntityRecognition = options.namedEntityRecognition ?? null;
    this.sentimentAnalysis = options.sentimentAnalysis ?? null;
  }

  modelDump(): Dict {
    return compact([
      ["words_accurate_timestamps", this.wordsAccurateTimestamps],
      ["custom_vocabulary", this.customVocabulary],
      ["custom_vocabulary_config", this.customVocabularyConfig?.modelDump()],
      ["custom_spelling", this.customSpelling],
      ["custom_spelling_config", this.customSpellingConfig?.modelDump()],
      ["translation", this.translation],
      ["translation_config", this.translationConfig?.modelDump()],
      ["named_entity_recognition", this.namedEntityRecognition],
      ["sentiment_analysis", this.sentimentAnalysis],
    ]);
  }
}

export interface MessagesConfigOptions {
  /** Whether to receive intermediate transcription results. */
  receivePartialTranscripts?: boolean | null;
  /** Whether to receive final transcription results. */
  receiveFinalTranscripts?: boolean | null;
  /** Whether to receive speech begin/end events. */
  receiveSpeechEvents?: boolean | null;
  /** Whether to receive pre-processing events. */
  receivePreProcessingEvents?: boolean | null;
  /** Whether to receive real-time processing events. */
  receiveRealtimeProcessingEvents?: boolean | null;
  /** Whether to receive post-processing events. */
  receivePostProcessingEvents?: boolean | null;
  /** Whether to receive acknowledgment messages. */
  receiveAcknowledgments?: boolean | null;
  /** Whether to receive error messages. */
  receiveErrors?: boolean | null;
  /** Whether to receive lifecycle events. */
  receiveLifecycleEvents?: boolean | null;
}

/** Configuration for controlling which message types are sent via WebSocket. */
export class MessagesConfig {
  receivePartialTranscripts: boolean | null;
  receiveFinalTranscripts: boolean | null;
  receiveSpeechEvents: boolean | null;
  receivePreProcessingEvents: boolean | null;
  receiveRealtimeProcessingEvents: boolean | null;
  receivePostProcessingEvents: boolean | null;
  receiveAcknowledgments: boolean | null;
  receiveErrors: boolean | null;
  receiveLifecycleEvents: boolean | null;

  constructor(options: MessagesConfigOptions = {}) {
    this.receivePartialTranscripts = options.receivePartialTranscripts ?? null;
    this.receiveFinalTranscripts = options.receiveFinalTranscripts ?? null;
    this.receiveSpeechEvents = options.receiveSpeechEvents ?? null;
    this.receivePreProcessingEvents = options.receivePreProcessingEvents ?? null;
    this.receiveRealtimeProcessingEvents = options.receiveRealtimeProcessingEvents ?? null;
    this.receivePostProcessingEvents = options.receivePostProcessingEvents ?? null;
    this.receiveAcknowledgments = options.receiveAcknowledgments ?? null;
    this.receiveErrors = options.receiveErrors ?? null;
    this.receiveLifecycleEvents = options.receiveLifecycleEvents ?? null;
  }

  modelDump(): Dict {
    return compact([
      ["receive_partial_transcripts", this.receivePartialTranscripts],
      ["receive_final_transcripts", this.receiveFinalTranscripts],
      ["receive_speech_events", this.receiveSpeechEvents],
      ["receive_pre_processing_events", this.receivePreProcessingEvents],
      ["receive_realtime_processing_events", this.receiveRealtimeProcessingEvents],
      ["receive_post_processing_events", this.receivePostProcessingEvents],
      ["receive_acknowledgments", this.receiveAcknowledgments],
      ["receive_errors", this.receiveErrors],
      ["receive_lifecycle_events", this.receiveLifecycleEvents],
    ]);
  }
}
