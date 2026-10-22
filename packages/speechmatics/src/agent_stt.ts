// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Client for the Speechmatics Agent STT WebSocket API.
 *
 * Upstream Pipecat drives this API through the Python `speechmatics-agent-stt`
 * package (0.3.0), itself built on `speechmatics-rt` (1.2.1). Both are MIT
 * licensed (Copyright Speechmatics / Cantab Research Ltd). This module
 * re-implements the part of them Pipecat uses on the global `WebSocket` (through
 * core's `websocketConnect`), so it runs on Bun, Node, Deno and Cloudflare
 * Workers. The protocol follows those packages' source and the API reference
 * at https://docs.speechmatics.com/api-ref/agent-stt-websocket :
 *
 * - Endpoint: the RT endpoint (`wss://eu2.rt.speechmatics.com/v2`) plus an
 *   `/agent` path segment, with `sm-app` and `sm-sdk` query parameters.
 * - Auth: `Authorization: Bearer <api key>` on the handshake, plus an
 *   `X-Request-Id` header.
 * - Client messages: `StartRecognition` (`audio_format`, `transcription_config`,
 *   `turn_config`), binary audio frames, `ForceEndOfUtterance` (`timestamp`),
 *   `EndOfStream` (`last_seq_no`) and `GetSpeakers`.
 * - Server messages: `RecognitionStarted`, `AudioAdded` (`seq_no`),
 *   `AddSegment`, `AddPartialSegment`, `StartOfTurn`, `EndOfTurn`,
 *   `SpeakersResult`, `EndOfTranscript`, `Info`, `Warning` and `Error`.
 *
 * Porting notes (DIVERGENCE from the Python packages):
 * - JWT auth, multi-channel clients, file transcription (`transcribe`), the
 *   transcript accumulator and the event log are not ported: Pipecat uses none
 *   of them.
 * - `operating_point` (deprecated in the SDK) is not ported; the `model` field
 *   is always sent.
 */

import {
  createTask,
  Event,
  rethrowIfCancelled,
  type Task,
  TimeoutError,
  waitFor,
} from "@pipedog/asyncio";
import {
  type WebsocketClientConnection,
  type WebsocketConnectOptions,
  websocketConnect,
} from "@pipedog/core/services/websocket_service";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";

type Dict = Record<string, any>;

export const DEFAULT_RT_URL = "wss://eu2.rt.speechmatics.com/v2";
export const AGENT_PATH_SEGMENT = "agent";
export const DEFAULT_SAMPLE_RATE = 16000;
export const SUPPORTED_SAMPLE_RATES: readonly number[] = [8000, 16000];
export const DEFAULT_CHUNK_SIZE = 1024;
export const DEFAULT_WORD_DELIMITER = " ";
/** Seconds to wait for `RecognitionStarted` after `StartRecognition`. */
export const RECOGNITION_STARTED_TIMEOUT = 5.0;
/** Seconds to wait for `EndOfTranscript` when closing a session. */
export const DISCONNECT_TIMEOUT = 5.0;

const REQUEST_ID_HEADER = "X-Request-Id";
const SDK_IDENTIFIER = "pipedog-agent-stt";
const SDK_VERSION = "0.3.0";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

//
// Errors (the exception classes of `speechmatics.rt`)
//

/** Raised when there's an error in configuration. */
export class ConfigurationError extends Error {
  override name = "ConfigurationError";
}

/** Raised when authentication fails. */
export class AuthenticationError extends Error {
  override name = "AuthenticationError";
}

/** Raised when the connection to the service fails. */
export class ConnectionError extends Error {
  override name = "ConnectionError";
}

/** Raised when there's an error in the transport layer. */
export class TransportError extends Error {
  override name = "TransportError";
}

/** Raised when transcription fails (the service ended the session with an error). */
export class TranscriptionError extends Error {
  override name = "TranscriptionError";
}

/** Raised when there's an error with the session state. */
export class SessionError extends Error {
  override name = "SessionError";
}

//
// Models
//

/** Models available on the Agent STT service. */
export const Model = {
  LINDEN_1: "linden-1",
} as const;
export type Model = (typeof Model)[keyof typeof Model];

export const DEFAULT_MODEL: Model = Model.LINDEN_1;

/** Audio encodings accepted by the service. */
export const AudioEncoding = {
  PCM_F32LE: "pcm_f32le",
  PCM_S16LE: "pcm_s16le",
  MULAW: "mulaw",
} as const;
export type AudioEncoding = (typeof AudioEncoding)[keyof typeof AudioEncoding];

const BYTES_PER_SAMPLE: Record<AudioEncoding, number> = {
  [AudioEncoding.PCM_F32LE]: 4,
  [AudioEncoding.PCM_S16LE]: 2,
  [AudioEncoding.MULAW]: 1,
};

/** Message types sent from the client to the Agent STT service. */
export const ClientMessageType = {
  START_RECOGNITION: "StartRecognition",
  END_OF_STREAM: "EndOfStream",
  FORCE_END_OF_UTTERANCE: "ForceEndOfUtterance",
  GET_SPEAKERS: "GetSpeakers",
} as const;
export type ClientMessageType = (typeof ClientMessageType)[keyof typeof ClientMessageType];

/** Message types received from the Agent STT service. */
export const ServerMessageType = {
  RECOGNITION_STARTED: "RecognitionStarted",
  AUDIO_ADDED: "AudioAdded",
  ADD_SEGMENT: "AddSegment",
  ADD_PARTIAL_SEGMENT: "AddPartialSegment",
  SPEECH_STARTED: "SpeechStarted",
  SPEECH_ENDED: "SpeechEnded",
  START_OF_TURN: "StartOfTurn",
  END_OF_TURN: "EndOfTurn",
  END_OF_TRANSCRIPT: "EndOfTranscript",
  SPEAKERS_RESULT: "SpeakersResult",
  INFO: "Info",
  WARNING: "Warning",
  ERROR: "Error",
} as const;
export type ServerMessageType = (typeof ServerMessageType)[keyof typeof ServerMessageType];

/**
 * Which mechanism closes a turn.
 *
 * `VAD`: the service's own VAD closes turns. `EXTERNAL`: the application closes
 * each turn by calling `finalize()`.
 */
export const TurnDetectionMode = {
  VAD: "vad",
  EXTERNAL: "external",
} as const;
export type TurnDetectionMode = (typeof TurnDetectionMode)[keyof typeof TurnDetectionMode];

export interface TurnConfigOptions {
  turnDetectionMode?: TurnDetectionMode;
}

/** Turn-taking config for the session (sibling of the transcription config on the wire). */
export class TurnConfig {
  turnDetectionMode: TurnDetectionMode;

  constructor(options: TurnConfigOptions = {}) {
    this.turnDetectionMode = options.turnDetectionMode ?? TurnDetectionMode.VAD;
  }

  /** The wire form of `StartRecognition.turn_config`. */
  toDict(): Dict {
    return { turn_detection_mode: this.turnDetectionMode };
  }
}

/** A word to bias the engine towards, optionally with pronunciation hints. */
export interface AdditionalVocabEntry {
  content: string;
  soundsLike?: string[] | null;
}

/** Labeled speaker identifier for guided speaker diarization. */
export interface SpeakerIdentifier {
  label: string;
  speakerIdentifiers: string[];
}

export interface SpeakerDiarizationConfigOptions {
  maxSpeakers?: number | null;
  speakerSensitivity?: number | null;
  preferCurrentSpeaker?: boolean | null;
  speakers?: SpeakerIdentifier[] | null;
}

/** Speaker diarization configuration. */
export class SpeakerDiarizationConfig {
  maxSpeakers: number | null;
  speakerSensitivity: number | null;
  preferCurrentSpeaker: boolean | null;
  speakers: SpeakerIdentifier[] | null;

  constructor(options: SpeakerDiarizationConfigOptions = {}) {
    this.maxSpeakers = options.maxSpeakers ?? null;
    this.speakerSensitivity = options.speakerSensitivity ?? null;
    this.preferCurrentSpeaker = options.preferCurrentSpeaker ?? null;
    this.speakers = options.speakers ?? null;
  }

  /** The wire form, with unset (null) fields left out. */
  toDict(): Dict {
    const result: Dict = {};
    if (this.maxSpeakers !== null) result.max_speakers = this.maxSpeakers;
    if (this.speakerSensitivity !== null) result.speaker_sensitivity = this.speakerSensitivity;
    if (this.preferCurrentSpeaker !== null) {
      result.prefer_current_speaker = this.preferCurrentSpeaker;
    }
    if (this.speakers !== null) {
      result.speakers = this.speakers.map((s) => ({
        label: s.label,
        speaker_identifiers: [...s.speakerIdentifiers],
      }));
    }
    return result;
  }
}

export interface TranscriptionConfigOptions {
  language?: string;
  model?: Model | string;
  outputLocale?: string | null;
  diarization?: string | null;
  additionalVocab?: (AdditionalVocabEntry | Dict)[] | null;
  punctuationOverrides?: Dict | null;
  domain?: string | null;
  enablePartials?: boolean | null;
  emitSentences?: boolean | null;
  speakerDiarizationConfig?: SpeakerDiarizationConfig | null;
  transcriptFilteringConfig?: Dict | null;
}

/** Transcription config for the Agent STT service. */
export class TranscriptionConfig {
  language: string;
  model: Model | string;
  outputLocale: string | null;
  diarization: string | null;
  additionalVocab: (AdditionalVocabEntry | Dict)[] | null;
  punctuationOverrides: Dict | null;
  domain: string | null;
  enablePartials: boolean | null;
  emitSentences: boolean | null;
  speakerDiarizationConfig: SpeakerDiarizationConfig | null;
  transcriptFilteringConfig: Dict | null;

  constructor(options: TranscriptionConfigOptions = {}) {
    this.language = options.language ?? "en";
    this.model = options.model ?? DEFAULT_MODEL;
    this.outputLocale = options.outputLocale ?? null;
    this.diarization = options.diarization ?? null;
    this.additionalVocab = options.additionalVocab ?? null;
    this.punctuationOverrides = options.punctuationOverrides ?? null;
    this.domain = options.domain ?? null;
    this.enablePartials = options.enablePartials ?? null;
    this.emitSentences = options.emitSentences ?? null;
    this.speakerDiarizationConfig = options.speakerDiarizationConfig ?? null;
    this.transcriptFilteringConfig = options.transcriptFilteringConfig ?? null;
  }

  /** The wire form of `StartRecognition.transcription_config`, excluding unset fields. */
  toDict(): Dict {
    const result: Dict = { language: this.language, model: this.model };
    if (this.outputLocale !== null) result.output_locale = this.outputLocale;
    if (this.diarization !== null) result.diarization = this.diarization;
    if (this.additionalVocab !== null) {
      result.additional_vocab = this.additionalVocab.map((entry) => {
        if ("content" in entry && ("soundsLike" in entry || !("sounds_like" in entry))) {
          const e = entry as AdditionalVocabEntry;
          const out: Dict = { content: e.content };
          if (e.soundsLike !== undefined && e.soundsLike !== null) out.sounds_like = e.soundsLike;
          return out;
        }
        return entry;
      });
    }
    if (this.punctuationOverrides !== null)
      result.punctuation_overrides = this.punctuationOverrides;
    if (this.domain !== null) result.domain = this.domain;
    if (this.transcriptFilteringConfig !== null) {
      result.transcript_filtering_config = this.transcriptFilteringConfig;
    }
    if (this.enablePartials !== null) result.enable_partials = this.enablePartials;
    if (this.speakerDiarizationConfig !== null) {
      result.speaker_diarization_config = this.speakerDiarizationConfig.toDict();
    }
    if (this.emitSentences !== null) result.emit_sentences = this.emitSentences;
    return result;
  }
}

export interface AudioFormatOptions {
  encoding?: AudioEncoding | null;
  sampleRate?: number;
  chunkSize?: number;
}

/** Audio format parameters. */
export class AudioFormat {
  encoding: AudioEncoding | null;
  sampleRate: number;
  chunkSize: number;

  constructor(options: AudioFormatOptions = {}) {
    this.encoding = options.encoding ?? null;
    this.sampleRate = options.sampleRate ?? 44100;
    this.chunkSize = options.chunkSize ?? 4096;
  }

  /** Number of bytes per audio sample, from the encoding. */
  get bytesPerSample(): number {
    if (this.encoding === null) {
      throw new Error(
        "Cannot determine bytes per sample for file-type audio format. " +
          "Set an explicit encoding on AudioFormat.",
      );
    }
    const n = BYTES_PER_SAMPLE[this.encoding];
    if (n === undefined) throw new Error(`Unknown encoding: ${this.encoding}`);
    return n;
  }

  /** The wire form of `StartRecognition.audio_format`. */
  toDict(): Dict {
    if (this.encoding) {
      return { type: "raw", encoding: this.encoding, sample_rate: this.sampleRate };
    }
    return { type: "file" };
  }
}

/**
 * A segment of transcript, the unit the Agent STT service works in.
 *
 * `fromMessage` reads an `AddSegment` or `AddPartialSegment` message: the
 * `segment` object (`transcript`, `speaker`) plus the message-level `metadata`.
 */
export class Segment {
  transcript: string;
  startTime: number;
  endTime: number;
  speaker: string | null;
  isFinal: boolean;

  constructor(options: {
    transcript: string;
    startTime?: number;
    endTime?: number;
    speaker?: string | null;
    isFinal?: boolean;
  }) {
    this.transcript = options.transcript;
    this.startTime = options.startTime ?? 0.0;
    this.endTime = options.endTime ?? 0.0;
    this.speaker = options.speaker ?? null;
    this.isFinal = options.isFinal ?? true;
  }

  static fromMessage(message: Dict): Segment {
    const segment: Dict = message.segment ?? {};
    const metadata: Dict = message.metadata ?? {};
    return new Segment({
      transcript: segment.transcript ?? "",
      startTime: metadata.start_time ?? 0.0,
      endTime: metadata.end_time ?? 0.0,
      speaker: segment.speaker ?? null,
      isFinal: message.message === ServerMessageType.ADD_SEGMENT,
    });
  }
}

/** Language pack details reported in `RecognitionStarted`. */
export interface LanguagePackInfo {
  languageDescription: string;
  wordDelimiter: string;
  writingDirection: string;
  itn: boolean;
  adapted: boolean;
}

/** State of the current Agent STT session. */
export interface SessionInfo {
  requestId: string;
  sessionId: string | null;
  languagePackInfo: LanguagePackInfo;
}

//
// URL
//

/**
 * Resolve the Agent STT WebSocket URL: the RT endpoint plus an `/agent` path
 * segment (skipped when already present) and an `sm-app` query parameter.
 *
 * @param url Explicit endpoint. Defaults to the EU endpoint.
 * @param app Application name reported to the service as `sm-app`.
 */
export function resolveUrl(url?: string | null, app?: string | null): string {
  const parsed = new URL(url || DEFAULT_RT_URL);
  const segments = parsed.pathname.split("/").filter((s) => s);
  if (!segments.includes(AGENT_PATH_SEGMENT)) segments.push(AGENT_PATH_SEGMENT);
  parsed.pathname = `/${segments.join("/")}`;

  const existingApp = parsed.searchParams.get("sm-app");
  parsed.searchParams.set("sm-app", app || existingApp || `agent-stt-sdk/${SDK_VERSION}`);
  return parsed.toString();
}

//
// Client
//

type MessageHandler = (message: Dict) => void;

export interface AgentSttClientOptions {
  /** Speechmatics API key, sent as a Bearer token on the handshake. */
  apiKey: string;
  /** WebSocket endpoint. An `/agent` segment is appended if absent. */
  url?: string | null;
  /** Application name reported to the service as `sm-app`. */
  app?: string | null;
  transcriptionConfig?: TranscriptionConfig;
  turnConfig?: TurnConfig;
  /** Audio format. Defaults to 16 kHz signed 16-bit PCM; 8 kHz is also accepted. */
  audioFormat?: AudioFormat;
  /** Opens the socket. Defaults to core's `websocketConnect`; replaceable for tests. */
  connect?: (uri: string, options?: WebsocketConnectOptions) => Promise<WebsocketClientConnection>;
}

/** Raise if `sampleRate` is not one the Agent STT service accepts. */
export function validateSampleRate(sampleRate: number): void {
  if (!SUPPORTED_SAMPLE_RATES.includes(sampleRate)) {
    throw new Error(
      `sample_rate must be one of (${SUPPORTED_SAMPLE_RATES.join(", ")}), got ${sampleRate}`,
    );
  }
}

/**
 * Asynchronous client for the Speechmatics Agent STT service.
 *
 * Runs no VAD and no turn detection of its own: either the service's VAD closes
 * turns (`TurnDetectionMode.VAD`) or the application's does, by calling
 * `finalize()` (`TurnDetectionMode.EXTERNAL`).
 */
export class AgentSttClient {
  readonly #apiKey: string;
  readonly #url: string;
  readonly #connect: NonNullable<AgentSttClientOptions["connect"]>;
  readonly #handlers = new Map<string, MessageHandler[]>();

  #ws: WebsocketClientConnection | null = null;
  #recvTask: Task<unknown> | null = null;
  #transcriptionConfig: TranscriptionConfig;
  #turnConfig: TurnConfig;
  #audioFormat: AudioFormat;

  #requestId: string;
  #sessionInfo: SessionInfo;
  #closed = false;
  #eosSent = false;
  #audioBytesSent = 0;
  #seqNo = 0;
  #isConnected = false;
  #isReadyForAudio = false;
  #sessionError: string | null = null;
  #lastErrorReason: string | null = null;
  // Set by RecognitionStarted, and by Error / EndOfTranscript / a dropped socket.
  #startedOrDone = new Event();
  #recognitionStarted = false;
  #sessionDone = new Event();

  constructor(options: AgentSttClientOptions) {
    this.#apiKey = options.apiKey;
    this.#url = resolveUrl(options.url, options.app);
    this.#connect = options.connect ?? websocketConnect;
    this.#transcriptionConfig = options.transcriptionConfig ?? new TranscriptionConfig();
    this.#turnConfig = options.turnConfig ?? new TurnConfig();
    this.#audioFormat =
      options.audioFormat ??
      new AudioFormat({
        encoding: AudioEncoding.PCM_S16LE,
        sampleRate: DEFAULT_SAMPLE_RATE,
        chunkSize: DEFAULT_CHUNK_SIZE,
      });
    validateSampleRate(this.#audioFormat.sampleRate);

    this.#requestId = crypto.randomUUID();
    this.#sessionInfo = {
      requestId: this.#requestId,
      sessionId: null,
      languagePackInfo: {
        languageDescription: "",
        wordDelimiter: DEFAULT_WORD_DELIMITER,
        writingDirection: "ltr",
        itn: true,
        adapted: false,
      },
    };

    // Internal listeners run before the application's.
    this.on(ServerMessageType.RECOGNITION_STARTED, (m) => this.#onSessionStarted(m));
    this.on(ServerMessageType.END_OF_TRANSCRIPT, () => this.#onEndOfTranscript());
    this.on(ServerMessageType.ERROR, (m) => this.#onSessionError(m));
    this.on(ServerMessageType.WARNING, (m) =>
      logger.warning(`Server warning: ${m.reason ?? "unknown"}`),
    );
    this.on(ServerMessageType.AUDIO_ADDED, (m) => {
      this.#seqNo = m.seq_no ?? 0;
    });
  }

  /** Register a handler for a server message type. */
  on(type: ServerMessageType, handler: MessageHandler): void {
    const list = this.#handlers.get(type);
    if (list) list.push(handler);
    else this.#handlers.set(type, [handler]);
  }

  /** Service session info, set once `RecognitionStarted` arrives. */
  get sessionInfo(): SessionInfo {
    return this.#sessionInfo;
  }

  get isConnected(): boolean {
    return this.#isConnected;
  }

  /** Whether the service has accepted the session, so audio will be sent. */
  get isReadyForAudio(): boolean {
    return this.#isReadyForAudio;
  }

  /** The reason the service gave for ending the session, or null while it is healthy. */
  get sessionError(): string | null {
    return this.#sessionError;
  }

  /** Number of audio seconds sent to the server. */
  get audioSecondsSent(): number {
    return this.#audioBytesSent / (this.#audioFormat.sampleRate * this.#audioFormat.bytesPerSample);
  }

  /**
   * Open the session and wait until the service is ready for audio.
   *
   * @throws ConnectionError if the WebSocket connection fails.
   * @throws TranscriptionError if the service ends the session before it starts.
   * @throws TimeoutError if the service does not accept the session in time.
   */
  async connect(): Promise<void> {
    if (this.#isConnected) return;
    if (this.#closed) this.#beginNewSession();

    const startMessage = {
      message: ClientMessageType.START_RECOGNITION,
      audio_format: this.#audioFormat.toDict(),
      transcription_config: this.#transcriptionConfig.toDict(),
      turn_config: this.#turnConfig.toDict(),
    };

    try {
      const headers = {
        [REQUEST_ID_HEADER]: this.#requestId,
        Authorization: `Bearer ${this.#apiKey}`,
      };
      try {
        this.#ws = await this.#connect(this.#prepareUrl(), { additionalHeaders: headers });
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`WebSocket connection error: ${errorMessage(e)}`);
        throw new ConnectionError(`WebSocket connection error: ${errorMessage(e)}`, { cause: e });
      }
      this.#recvTask = createTask(() => this.#recvLoop(this.#ws as WebsocketClientConnection));
      await this.sendMessage(startMessage);
      await this.#waitRecognitionStarted();
    } catch (e) {
      // Also reached on cancellation: a caller's own timeout cancels this.
      try {
        await this.close();
      } catch (closeError) {
        rethrowIfCancelled(closeError);
      }
      throw e;
    }
    this.#isConnected = true;
  }

  /** Close the session, flushing whatever the service still holds. */
  async disconnect(): Promise<void> {
    if (!this.#isConnected) {
      await this.close();
      return;
    }
    this.#isReadyForAudio = false;
    try {
      await waitFor(() => this.#stopSession(), DISCONNECT_TIMEOUT);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`Error closing session: ${errorMessage(e)}`);
      await this.close();
    } finally {
      this.#isConnected = false;
    }
  }

  /**
   * Send a JSON message. `turn_config` is attached to `StartRecognition` by
   * `connect()`.
   *
   * @throws TransportError if the client is closed or the send fails.
   */
  async sendMessage(message: Dict): Promise<void> {
    if (this.#closed || this.#eosSent || !this.#ws) throw new TransportError("Client is closed");
    try {
      await this.#ws.send(pyJsonDumps(message));
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Send message failed: ${errorMessage(e)}`);
      this.#closed = true;
      throw new TransportError(`Send message failed: ${errorMessage(e)}`, { cause: e });
    }
  }

  /**
   * Send an audio frame.
   *
   * Frames sent before the session is ready, or after it has closed, are
   * dropped rather than raising, so an audio callback does not have to track
   * session state. A failed send closes the audio gate.
   */
  async sendAudio(payload: Uint8Array): Promise<void> {
    if (!this.#isReadyForAudio) return;
    try {
      if (this.#closed || this.#eosSent || !this.#ws) throw new TransportError("Client is closed");
      try {
        await this.#ws.send(payload);
      } catch (e) {
        rethrowIfCancelled(e);
        this.#closed = true;
        throw new TransportError(`Send message failed: ${errorMessage(e)}`, { cause: e });
      }
      this.#audioBytesSent += payload.length;
      this.#seqNo += 1;
    } catch (e) {
      rethrowIfCancelled(e);
      if (!(e instanceof TransportError)) throw e;
      logger.warning(`Error sending audio: ${e.message}`);
      this.#isReadyForAudio = false;
    }
  }

  /**
   * Close the current turn now: send `ForceEndOfUtterance` stamped with the
   * amount of audio sent so far, so the service closes the turn where the
   * application's VAD detected the end of speech. The flushed segment arrives
   * as a normal `AddSegment` message.
   *
   * Use with `TurnDetectionMode.EXTERNAL`. Runs the send in a background task.
   */
  finalize(options: { timestamp?: number | null } = {}): void {
    const timestamp = options.timestamp === undefined ? this.audioSecondsSent : options.timestamp;
    createTask(() => this.#sendForceEndOfUtterance(timestamp), "force_end_of_utterance");
  }

  /** Close the connection without waiting for outstanding messages. */
  async close(): Promise<void> {
    this.#isReadyForAudio = false;
    this.#isConnected = false;
    this.#closed = true;
    this.#sessionDone.set();
    this.#startedOrDone.set();

    const task = this.#recvTask;
    this.#recvTask = null;
    if (task && !task.done()) {
      task.cancel();
      try {
        await waitFor(() => task, 2.0);
      } catch (e) {
        // The receive task ending cancelled, or slow to stop, is expected here.
        if (!(e instanceof TimeoutError) && !task.cancelled()) rethrowIfCancelled(e);
      }
    }

    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      try {
        await ws.close();
      } catch (e) {
        rethrowIfCancelled(e);
      }
    }
  }

  //
  // internals
  //

  #prepareUrl(): string {
    const parsed = new URL(this.#url);
    parsed.searchParams.set("sm-sdk", `${SDK_IDENTIFIER}-v${SDK_VERSION}`);
    return parsed.toString();
  }

  /** Reset per-connection state for a fresh session on a client that already ran one. */
  #beginNewSession(): void {
    this.#requestId = crypto.randomUUID();
    this.#sessionInfo.requestId = this.#requestId;
    this.#sessionInfo.sessionId = null;
    this.#startedOrDone = new Event();
    this.#recognitionStarted = false;
    this.#sessionDone = new Event();
    this.#ws = null;
    this.#recvTask = null;
    this.#closed = false;
    this.#eosSent = false;
    this.#audioBytesSent = 0;
    this.#seqNo = 0;
    this.#lastErrorReason = null;
    this.#sessionError = null;
    this.#isReadyForAudio = false;
  }

  async #sendForceEndOfUtterance(timestamp: number | null): Promise<void> {
    const message: Dict = { message: ClientMessageType.FORCE_END_OF_UTTERANCE };
    if (timestamp !== null) message.timestamp = timestamp;
    try {
      await this.sendMessage(message);
    } catch (e) {
      rethrowIfCancelled(e);
      if (!(e instanceof TransportError)) throw e;
      logger.warning(`Error sending ${ClientMessageType.FORCE_END_OF_UTTERANCE}: ${e.message}`);
    }
  }

  async #stopSession(): Promise<void> {
    if (!this.#eosSent && !this.#sessionDone.isSet()) {
      try {
        await this.sendMessage({
          message: ClientMessageType.END_OF_STREAM,
          last_seq_no: this.#seqNo,
        });
        this.#eosSent = true;
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`Failed to send EndOfStream message: ${errorMessage(e)}`);
      }
    }
    // Wait for EndOfTranscript (or an error) to indicate we can stop listening.
    await this.#sessionDone.wait();
    await this.close();
  }

  async #waitRecognitionStarted(): Promise<void> {
    try {
      await waitFor(() => this.#startedOrDone.wait(), RECOGNITION_STARTED_TIMEOUT);
    } catch (e) {
      if (e instanceof TimeoutError) {
        throw new TimeoutError("Timed out waiting for RecognitionStarted");
      }
      throw e;
    }
    if (!this.#recognitionStarted) {
      throw new TranscriptionError(
        this.#lastErrorReason ?? "Session ended before RecognitionStarted",
      );
    }
  }

  /**
   * Receive and dispatch server messages for the lifetime of the connection. A
   * closed or failed socket ends the session.
   */
  async #recvLoop(ws: WebsocketClientConnection): Promise<void> {
    try {
      while (true) {
        const raw = await ws.recv();
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        let msg: unknown;
        try {
          msg = pyJsonLoads(text);
        } catch (e) {
          rethrowIfCancelled(e);
          throw new TransportError(`Invalid JSON received: ${errorMessage(e)}`);
        }
        if (msg !== null && typeof msg === "object" && "message" in msg) {
          this.#emit((msg as Dict).message as string, msg as Dict);
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Receive loop error: ${errorMessage(e)}`);
      this.#closed = true;
      this.#isReadyForAudio = false;
      this.#sessionDone.set();
      this.#startedOrDone.set();
      try {
        await ws.close();
      } catch (closeError) {
        rethrowIfCancelled(closeError);
      }
    } finally {
      this.#closed = true;
    }
  }

  #emit(type: string, message: Dict): void {
    for (const handler of this.#handlers.get(type) ?? []) {
      try {
        handler(message);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`Error in ${type} handler: ${errorMessage(e)}`);
      }
    }
  }

  /** Capture the session identity and language pack, and open the audio gate. */
  #onSessionStarted(message: Dict): void {
    this.#sessionInfo.requestId = this.#requestId;
    this.#sessionInfo.sessionId = message.id ?? null;
    const lp: Dict = message.language_pack_info ?? {};
    this.#sessionInfo.languagePackInfo = {
      languageDescription: lp.language_description ?? "",
      wordDelimiter: lp.word_delimiter ?? DEFAULT_WORD_DELIMITER,
      writingDirection: lp.writing_direction ?? "ltr",
      itn: lp.itn ?? true,
      adapted: lp.adapted ?? false,
    };
    this.#sessionError = null;
    this.#isReadyForAudio = true;
    this.#recognitionStarted = true;
    this.#startedOrDone.set();
    logger.debug(`Recognition started (session_id=${this.#sessionInfo.sessionId})`);
  }

  #onEndOfTranscript(): void {
    logger.debug("Received EndOfTranscript message");
    this.#sessionDone.set();
    this.#startedOrDone.set();
  }

  /** Record the reason and shut the audio gate: the service has ended the session. */
  #onSessionError(message: Dict): void {
    const reason: string = message.reason ?? "unknown";
    logger.error(`Server error: ${reason}`);
    this.#lastErrorReason = reason;
    this.#sessionError = reason;
    this.#isReadyForAudio = false;
    this.#isConnected = false;
    this.#sessionDone.set();
    this.#startedOrDone.set();
  }
}
