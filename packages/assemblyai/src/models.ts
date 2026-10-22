// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/assemblyai/models.py

/**
 * AssemblyAI WebSocket API message models.
 *
 * This module defines the models for AssemblyAI's real-time transcription
 * WebSocket messages (Universal-Streaming v3). Wire format source:
 * https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api
 *
 * Porting notes:
 * - Pydantic models become classes with an options constructor (camelCase
 *   fields) and a static `modelValidate()` that reads the snake_case wire
 *   JSON, as `Model.model_validate(dict)` does upstream. It throws on a
 *   missing or wrongly typed required field, like pydantic's
 *   `ValidationError`.
 * - DIVERGENCE: `AssemblyAIConnectionParams` is deprecated upstream (since
 *   0.0.105, removed in 2.0.0) and is not ported; use
 *   `AssemblyAISTTService.Settings` instead.
 */

type Dict = Record<string, unknown>;

function fail(model: string, field: string, expected: string, value: unknown): never {
  throw new Error(
    `${model}: field '${field}' must be ${expected}, got ${value === undefined ? "nothing" : JSON.stringify(value)}`,
  );
}

function reqInt(model: string, d: Dict, field: string): number {
  const v = d[field];
  if (typeof v !== "number" || !Number.isInteger(v)) fail(model, field, "an integer", v);
  return v;
}

function reqNum(model: string, d: Dict, field: string): number {
  const v = d[field];
  if (typeof v !== "number" || Number.isNaN(v)) fail(model, field, "a number", v);
  return v;
}

function reqStr(model: string, d: Dict, field: string): string {
  const v = d[field];
  if (typeof v !== "string") fail(model, field, "a string", v);
  return v;
}

function reqBool(model: string, d: Dict, field: string): boolean {
  const v = d[field];
  if (typeof v !== "boolean") fail(model, field, "a boolean", v);
  return v;
}

function optStr(model: string, d: Dict, field: string): string | null {
  const v = d[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") fail(model, field, "a string", v);
  return v;
}

function optNum(model: string, d: Dict, field: string): number | null {
  const v = d[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number") fail(model, field, "a number", v);
  return v;
}

function asDict(model: string, data: unknown): Dict {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${model}: expected an object, got ${JSON.stringify(data)}`);
  }
  return data as Dict;
}

function checkType(model: string, d: Dict, literal: string): void {
  const type = d.type;
  if (type !== undefined && type !== literal) fail(model, "type", `'${literal}'`, type);
}

export interface WordOptions {
  /** Start time of the word in milliseconds. */
  start: number;
  /** End time of the word in milliseconds. */
  end: number;
  /** The transcribed word text. */
  text: string;
  /** Confidence score for the word (0.0 to 1.0). */
  confidence: number;
  /** Whether this word is finalized and won't change. */
  wordIsFinal: boolean;
}

/** Represents a single word in a transcription with timing and confidence. */
export class Word {
  start: number;
  end: number;
  text: string;
  confidence: number;
  wordIsFinal: boolean;

  constructor(options: WordOptions) {
    this.start = options.start;
    this.end = options.end;
    this.text = options.text;
    this.confidence = options.confidence;
    this.wordIsFinal = options.wordIsFinal;
  }

  /** Build a Word from its wire (snake_case) JSON. */
  static modelValidate(data: unknown): Word {
    const d = asDict("Word", data);
    return new Word({
      start: reqInt("Word", d, "start"),
      end: reqInt("Word", d, "end"),
      text: reqStr("Word", d, "text"),
      confidence: reqNum("Word", d, "confidence"),
      wordIsFinal: reqBool("Word", d, "word_is_final"),
    });
  }
}

export interface BaseMessageOptions {
  /** The message type identifier. */
  type?: string;
}

/** Base class for all AssemblyAI WebSocket messages. */
export class BaseMessage {
  type: string;

  constructor(options: BaseMessageOptions = {}) {
    this.type = options.type ?? "";
  }
}

export interface BeginMessageOptions extends BaseMessageOptions {
  /** Unique session identifier. */
  id: string;
  /** Unix timestamp when the session expires. */
  expiresAt: number;
}

/** Message sent when a new session begins. */
export class BeginMessage extends BaseMessage {
  id: string;
  expiresAt: number;

  constructor(options: BeginMessageOptions) {
    super({ ...options, type: options.type ?? "Begin" });
    this.id = options.id;
    this.expiresAt = options.expiresAt;
  }

  static modelValidate(data: unknown): BeginMessage {
    const d = asDict("BeginMessage", data);
    checkType("BeginMessage", d, "Begin");
    return new BeginMessage({
      id: reqStr("BeginMessage", d, "id"),
      expiresAt: reqInt("BeginMessage", d, "expires_at"),
    });
  }
}

export interface TurnMessageOptions extends BaseMessageOptions {
  /** Sequential number of this turn in the session. */
  turnOrder: number;
  /** Whether the transcript has been formatted. */
  turnIsFormatted: boolean;
  /** Whether this marks the end of a speaking turn. */
  endOfTurn: boolean;
  /** The transcribed text for this turn. */
  transcript: string;
  /** Confidence score for end-of-turn detection. */
  endOfTurnConfidence: number;
  /** Individual words with timing and confidence data. */
  words: Word[];
  /** Detected language code (e.g. "es", "fr"). */
  languageCode?: string | null;
  /** Confidence score (0-1) for language detection. */
  languageConfidence?: number | null;
  /** Speaker label (e.g. "A", "B"); wire name `speaker_label`. */
  speaker?: string | null;
}

/** Message containing transcription data for a turn of speech. */
export class TurnMessage extends BaseMessage {
  turnOrder: number;
  turnIsFormatted: boolean;
  endOfTurn: boolean;
  transcript: string;
  endOfTurnConfidence: number;
  words: Word[];
  languageCode: string | null;
  languageConfidence: number | null;
  speaker: string | null;

  constructor(options: TurnMessageOptions) {
    super({ ...options, type: options.type ?? "Turn" });
    this.turnOrder = options.turnOrder;
    this.turnIsFormatted = options.turnIsFormatted;
    this.endOfTurn = options.endOfTurn;
    this.transcript = options.transcript;
    this.endOfTurnConfidence = options.endOfTurnConfidence;
    this.words = options.words;
    this.languageCode = options.languageCode ?? null;
    this.languageConfidence = options.languageConfidence ?? null;
    this.speaker = options.speaker ?? null;
  }

  /** Build a TurnMessage from wire JSON (`speaker_label` maps to `speaker`). */
  static modelValidate(data: unknown): TurnMessage {
    const m = "TurnMessage";
    const d = asDict(m, data);
    checkType(m, d, "Turn");
    const words = d.words;
    if (!Array.isArray(words)) fail(m, "words", "a list", words);
    return new TurnMessage({
      turnOrder: reqInt(m, d, "turn_order"),
      turnIsFormatted: reqBool(m, d, "turn_is_formatted"),
      endOfTurn: reqBool(m, d, "end_of_turn"),
      transcript: reqStr(m, d, "transcript"),
      endOfTurnConfidence: reqNum(m, d, "end_of_turn_confidence"),
      words: words.map((w) => Word.modelValidate(w)),
      languageCode: optStr(m, d, "language_code"),
      languageConfidence: optNum(m, d, "language_confidence"),
      // populate_by_name=True upstream: the field name works as well as the alias.
      speaker: optStr(m, d, "speaker_label") ?? optStr(m, d, "speaker"),
    });
  }
}

export interface SpeechStartedMessageOptions extends BaseMessageOptions {
  /** Audio timestamp in milliseconds when speech was detected. */
  timestamp: number;
}

/** Message sent when speech is first detected in the audio stream. */
export class SpeechStartedMessage extends BaseMessage {
  timestamp: number;

  constructor(options: SpeechStartedMessageOptions) {
    super({ ...options, type: options.type ?? "SpeechStarted" });
    this.timestamp = options.timestamp;
  }

  static modelValidate(data: unknown): SpeechStartedMessage {
    const d = asDict("SpeechStartedMessage", data);
    checkType("SpeechStartedMessage", d, "SpeechStarted");
    return new SpeechStartedMessage({ timestamp: reqInt("SpeechStartedMessage", d, "timestamp") });
  }
}

export interface TerminationMessageOptions extends BaseMessageOptions {
  /** Total duration of audio processed. */
  audioDurationSeconds: number;
  /** Total duration of the session. */
  sessionDurationSeconds: number;
}

/** Message sent when the session is terminated. */
export class TerminationMessage extends BaseMessage {
  audioDurationSeconds: number;
  sessionDurationSeconds: number;

  constructor(options: TerminationMessageOptions) {
    super({ ...options, type: options.type ?? "Termination" });
    this.audioDurationSeconds = options.audioDurationSeconds;
    this.sessionDurationSeconds = options.sessionDurationSeconds;
  }

  static modelValidate(data: unknown): TerminationMessage {
    const m = "TerminationMessage";
    const d = asDict(m, data);
    checkType(m, d, "Termination");
    return new TerminationMessage({
      audioDurationSeconds: reqNum(m, d, "audio_duration_seconds"),
      sessionDurationSeconds: reqNum(m, d, "session_duration_seconds"),
    });
  }
}

/** Union type for all possible message types. */
export type AnyMessage = BeginMessage | TurnMessage | SpeechStartedMessage | TerminationMessage;
