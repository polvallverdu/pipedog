// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/client.py

/**
 * The harness's connection to the bot under test.
 *
 * `EvalClient` runs the eval pipeline, a Pipecat pipeline acting as an RTVI
 * client: it waits for the bot to listen, connects, completes the handshake,
 * sends the user's turns (text, synthesized speech, a recording, DTMF keys, an
 * image), records the conversation, and tears down. The bot's output reaches
 * the rest of the harness as events on the stream the client is given. In a
 * simulation the pipeline also carries the persona LLM, which answers the bot
 * on its own.
 */

import {
  createTask,
  Event,
  Future,
  monotonic,
  rethrowIfCancelled,
  sleep,
  type Task,
  TimeoutError,
  waitFor,
} from "@pipedog/asyncio";
import { VADParams } from "@pipedog/core/audio/vad/vad_analyzer";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  DataFrame,
  EndFrame,
  type ErrorFrame,
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallInProgressFrame,
  FunctionCallResultFrame,
  InputTransportMessageFrame,
  InterruptionFrame,
  LLMConfigureOutputFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMMarkerResponseFrame,
  LLMTextFrame,
  LLMUpdateSettingsFrame,
  OutputTransportMessageUrgentFrame,
  TranscriptionFrame,
  type TranscriptionFrameOptions,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import {
  LLMAssistantAggregator,
  LLMUserAggregator,
  LLMUserAggregatorParams,
} from "@pipedog/core/processors/aggregators/llm_response_universal";
import { FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import {
  Message,
  SendTextData,
  SendTextOptions,
} from "@pipedog/core/processors/frameworks/rtvi/models";
import { LLMSettings } from "@pipedog/core/services/settings";
import { SegmentedSTTService, type STTService } from "@pipedog/core/services/stt_service";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { WebsocketClientParams } from "@pipedog/transport-websocket/client";
import { ConnectionClosed, type WebsocketConnection } from "@pipedog/transport-websocket/socket";
import { pyStrRepr } from "./_pyutil.ts";
import { loadUserAudio } from "./audio.ts";
import { EvalClientRecorder, EvalClientTransport } from "./client_transport.ts";
import type { EvalEvent, EvalEventStream } from "./events.ts";
import type { EvalPersona } from "./persona.ts";
import type { EvalTrace } from "./results.ts";
import {
  EVAL_CANCEL_MESSAGE_TYPE,
  EVAL_CONFIGURE_MESSAGE_TYPE,
  EVAL_CONTEXT_MESSAGE_TYPE,
  EVAL_IMAGE_MESSAGE_TYPE,
  EVAL_STT_SAMPLE_RATE,
  EvalClientSerializer,
  EvalConnectionFlags,
} from "./serializer.ts";
import { EvalSessionParams } from "./session.ts";
import { type CachingTTSService, ttsSampleRate } from "./tts.ts";

type Dict = Record<string, unknown>;

// NOTE: upstream's `BOT_READY_TIMEOUT_S` alias exists only for the deprecated
// `pipecat.evals.harness` re-export and is not ported.

// Frames the bot produced: the sink turns them into events and stops them here.
// Everything downstream of the sink speaks for the user (a persona LLM, the user
// TTS, the output) and must never see the bot's text or reports as its own
// input. The aggregator's context frame and lifecycle frames pass.
const _BOT_FRAMES = [
  LLMFullResponseStartFrame,
  LLMTextFrame,
  LLMMarkerResponseFrame,
  LLMFullResponseEndFrame,
  TTSTextFrame,
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  FunctionCallInProgressFrame,
  FunctionCallResultFrame,
  FunctionCallCancelFrame,
  InputTransportMessageFrame,
] as const;

function _directionName(direction: FrameDirection): string {
  return direction === FrameDirection.DOWNSTREAM ? "DOWNSTREAM" : "UPSTREAM";
}

/** How the bot closed the connection, with its close code and reason when it sent them. */
function _closeDescription(websocket: WebsocketConnection | null | undefined): string {
  const code = websocket?.closeCode ?? null;
  if (code === null) {
    return "the bot closed the connection before bot-ready";
  }
  const reason = websocket?.closeReason ? ` ${websocket.closeReason}` : "";
  return `the bot closed the connection before bot-ready (${code}${reason})`;
}

/**
 * Whether a pipeline error is the bot refusing the connection.
 *
 * DIVERGENCE: upstream checks for `websockets`' `InvalidHandshake` or an
 * `OSError`. The pipedog WebSocket client reports a refused or failed upgrade
 * as a `ConnectionClosed` from its connect, and a runtime's socket errors carry
 * a string `code` (`ECONNREFUSED`, ...), the `OSError` equivalent.
 */
function _isConnectError(exception: unknown): boolean {
  if (exception instanceof ConnectionClosed) return true;
  return exception instanceof Error && typeof (exception as { code?: unknown }).code === "string";
}

/** `mimetypes.guess_type` for the image formats a turn can send. */
const _IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpe": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
  ".ico": "image/vnd.microsoft.icon",
  ".heic": "image/heic",
  ".avif": "image/avif",
};

function _basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

function _guessMime(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return _IMAGE_MIME_TYPES[name.slice(dot).toLowerCase()] ?? null;
}

/** Options for {@link _BotSegmentTranscriptionFrame}. */
export interface BotSegmentTranscriptionFrameOptions extends TranscriptionFrameOptions {
  /** Monotonic time the segment's speech was first heard. */
  segmentStartedAt?: number;
}

/** A transcription of one segment of the bot's speech, with when that audio began. */
export class _BotSegmentTranscriptionFrame extends TranscriptionFrame {
  segmentStartedAt: number;

  constructor(options: BotSegmentTranscriptionFrameOptions) {
    super(options);
    this.segmentStartedAt = options.segmentStartedAt ?? 0.0;
  }
}

/**
 * Closes a segment's transcription run, whatever it yielded.
 *
 * Sent after the run's frames, it reaches the sink once the aggregator has
 * taken them in, so the sink reports the segment as accounted for only then:
 * a transcript that opens a turn of its own has opened it by the time this
 * frame passes. Uninterruptible because a transcript that opens a turn also
 * raises an interruption, which flushes the queued frames behind it.
 */
export class _BotSegmentTranscribedFrame extends DataFrame {
  override interruptible = false;
}

/**
 * Have the STT's transcriptions carry when their segment's audio began.
 *
 * A segmented STT transcribes each speech segment on its own, in order, once
 * the segment ends, and its transcript can land seconds after the audio it
 * came from. The gate ahead of it records when each segment began, one entry
 * per segment as it ends, and this pairs each transcription run with the
 * matching entry, so a transcript is attributed by its audio's time and not
 * by its arrival. A run that yields no transcription still takes its entry,
 * which keeps the pairing exact, and every run ends with a
 * `_BotSegmentTranscribedFrame`, so the sink can tell when nothing is left to
 * transcribe.
 *
 * @param stt The bot-speech STT in the harness pipeline.
 * @param starts The gate's record of segment starts, oldest first.
 */
export function _tagBotSegments(stt: SegmentedSTTService, starts: number[]): void {
  const runStt = stt.runStt.bind(stt);

  stt.runStt = async function* tagged(audio: Uint8Array) {
    const startedAt = starts.length > 0 ? (starts.shift() as number) : monotonic();
    logger.debug(`bot speech: transcribing a segment (${starts.length} start(s) left recorded)`);
    try {
      for await (let frame of runStt(audio)) {
        if (frame instanceof TranscriptionFrame) {
          frame = new _BotSegmentTranscriptionFrame({
            text: frame.text,
            userId: frame.userId,
            timestamp: frame.timestamp,
            language: frame.language,
            result: frame.result,
            finalized: frame.finalized,
            segmentStartedAt: startedAt,
          });
        }
        yield frame;
      }
    } finally {
      yield new _BotSegmentTranscribedFrame();
    }
  };
}

/**
 * Between the bot-speech STT and the turn aggregator: after an interrupting
 * send, only the bot's reply gets through.
 *
 * The aggregator's VAD reports the bot's speech segments upstream, past this
 * gate, to the STT; the gate notes when each began and, as each ends, hands
 * the start to the STT's tagging (see `_tagBotSegments`) and tells the stream
 * a segment awaits transcription. An ordinary send waits for the bot's speech
 * to be transcribed first, so nothing of it is in flight. A send that talks
 * over the bot cannot wait, and the bot goes on speaking until it notices the
 * user: a tagged transcript whose segment began before the bot started
 * speaking again is the bot finishing what it was saying, however late it
 * lands, and is dropped here so it cannot pass for the reply or be folded
 * into it. A turn that sends nothing drops the same way what the bot says
 * before it starts speaking again.
 *
 * Both need a segmented STT, which transcribes one segment at a time. With
 * any other STT the gate keeps no account of segments and drops nothing, and
 * a send waits only for the bot to stop speaking and its open turn to close.
 */
export class _BotSpeechGate extends FrameProcessor {
  protected _stream: EvalEventStream;
  protected _trace: EvalTrace;
  protected _starts: number[] | null;
  protected _segmentStartedAt: number | null = null;

  /**
   * Initialize the gate.
   *
   * @param stream The event stream, for when the user's input was sent.
   * @param trace The run's trace, for what the gate drops.
   * @param starts Where the start of each ended segment goes, for the STT's
   *   tagging; `null` with an STT that is not segmented.
   */
  constructor(stream: EvalEventStream, trace: EvalTrace, starts: number[] | null) {
    super();
    this._stream = stream;
    this._trace = trace;
    this._starts = starts;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (this._starts === null) {
      // Nothing to account for.
    } else if (frame instanceof VADUserStartedSpeakingFrame) {
      logger.debug(`bot speech: segment began (${_directionName(direction)})`);
      this._segmentStartedAt = monotonic();
      this._stream.botSegmentStarted();
    } else if (frame instanceof VADUserStoppedSpeakingFrame) {
      logger.debug(`bot speech: segment ended (${_directionName(direction)})`);
      this._starts.push(this._segmentStartedAt || monotonic());
      this._segmentStartedAt = null;
      this._stream.botSegmentEnded();
    } else if (frame instanceof _BotSegmentTranscriptionFrame) {
      const talkedOverUntil = this._stream.talkedOverUntil;
      if (talkedOverUntil !== null && frame.segmentStartedAt < talkedOverUntil) {
        this._trace.log(
          `discard: bot speech from before the turn's reply ${pyStrRepr(frame.text)}`,
        );
        return;
      }
    }
    await this.pushFrame(frame, direction);
  }
}

/** Options for {@link _BotFrameSink}. */
export interface BotFrameSinkOptions {
  /** The simulated caller, else `null`. */
  persona?: EvalPersona | null;
  /**
   * Whether the persona hears the bot's responses through the sink (text mode,
   * with no aggregator to hand it the turn).
   */
  personaHears?: boolean;
}

/**
 * Where the bot's output stops and the user's turns start.
 *
 * The bot's frames become events on the stream and go no further. The user's
 * turns are injected here, past the bot's side of the pipeline, so an
 * interruption there cannot drop them.
 *
 * Two rules apply. The aggregator's interruption, raised when the bot speaks,
 * stops here for a scripted turn (it would flush the user audio being sent)
 * and passes for a persona (a caller who hears the bot keep talking stops).
 * And the persona answers from here: in text mode it hears each finished bot
 * response through the sink, in audio mode the aggregator hands it the bot's
 * turn; either way nothing reaches it once it hung up.
 */
export class _BotFrameSink extends FrameProcessor {
  protected _stream: EvalEventStream;
  protected _persona: EvalPersona | null;
  protected _personaHears: boolean;

  /**
   * Initialize the sink.
   *
   * @param stream Where the bot's frames go as events.
   * @param options.persona The simulated caller, else `null`.
   * @param options.personaHears Whether the persona hears the bot's responses
   *   through the sink (text mode, with no aggregator to hand it the turn).
   */
  constructor(stream: EvalEventStream, options: BotFrameSinkOptions = {}) {
    super();
    this._stream = stream;
    this._persona = options.persona ?? null;
    this._personaHears = (options.personaHears ?? false) && this._persona !== null;
  }

  /**
   * Push a user turn into the pipeline, past the bot's side.
   *
   * @param frame The frame to push (a `TTSSpeakFrame`, or a spoken recording's
   *   TTS-bracketed frames).
   */
  async inject(frame: Frame): Promise<void> {
    await this.pushFrame(frame);
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    // The bot's frames arrive downstream, from the input transport. What
    // travels upstream is the user side's own (a persona's function call, a
    // TTS's lifecycle), not bot output, and passes through as is.
    if (direction !== FrameDirection.DOWNSTREAM) {
      await this.pushFrame(frame, direction);
      return;
    }
    const event = this._stream.frameToEvent(frame);
    if (event !== null) {
      await this._stream.append(event);
      if (this._personaHears && this._persona !== null) {
        await this._answer(this._persona.hear(event));
      }
    }
    if (frame instanceof _BotSegmentTranscribedFrame) {
      this._stream.botSegmentTranscribed();
      return;
    }
    if (_BOT_FRAMES.some((cls) => frame instanceof cls)) {
      return;
    } else if (frame instanceof InterruptionFrame && this._persona === null) {
      return;
    } else if (frame instanceof LLMContextFrame) {
      // The aggregator handing the persona the bot's turn (audio mode).
      await this._answer(frame);
      return;
    }
    await this.pushFrame(frame, direction);
  }

  /** Push the frame that has the persona answer, unless there is none or it hung up. */
  protected async _answer(frame: LLMContextFrame | null): Promise<void> {
    if (frame === null || this._persona === null || this._persona.hungUp) {
      return;
    }
    await this.pushFrame(frame);
  }
}

// The event the relay appends for each response the persona completes, and the
// one the client appends when the bot ends the call by closing the connection.
export const PERSONA_TURN_EVENT = "persona_turn";
export const BOT_ENDED_EVENT = "bot_ended";
// The harness's own pipeline reported an error: a service in it (the persona
// LLM, the user TTS, the bot STT) failed, not the bot.
export const HARNESS_ERROR_EVENT = "harness_error";

/**
 * Sends the persona's replies to the bot and reports each one as a turn.
 *
 * In text mode a whole reply goes to the bot as one `send-text`; in audio mode
 * the user TTS has already spoken it and this only logs the text. A reply with
 * words in it is one `persona_turn` event, up to where the bot's speech cut it
 * off if it did; a reply that only calls `end_call`, or that the bot's speech
 * cut off before a word went out, is not a turn.
 *
 * The persona's `end_call` event follows the turn of the reply that made the
 * call: in audio mode the reply is still being spoken when the persona calls it.
 */
export class _PersonaTurnRelay extends FrameProcessor {
  protected _textTurnMessage: (text: string) => Dict;
  protected _trace: EvalTrace;
  protected _stream: EvalEventStream;
  protected _text: string[] = [];
  // What the persona said in the current response: the one text turn, or
  // the sentences the user TTS spoke.
  protected _spoken: string[] = [];
  // Whether a response is on its way to the bot, and the end_call event
  // held until it has gone out.
  protected _replying = false;
  protected _endCall: EvalEvent | null = null;

  /**
   * Initialize the relay.
   *
   * @param textTurnMessage Builds the RTVI `send-text` message for a turn.
   * @param trace The run's trace.
   * @param stream Where the persona's turns are counted.
   */
  constructor(textTurnMessage: (text: string) => Dict, trace: EvalTrace, stream: EvalEventStream) {
    super();
    this._textTurnMessage = textTurnMessage;
    this._trace = trace;
    this._stream = stream;
  }

  /**
   * Append the persona's `end_call` event once the response in progress has gone out.
   *
   * @param event The `end_call` event.
   */
  async endCall(event: EvalEvent): Promise<void> {
    if (this._replying) {
      this._endCall = event;
    } else {
      await this._stream.append(event);
    }
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    this._stream.touch();
    if (frame instanceof LLMFullResponseStartFrame) {
      this._text = [];
      this._spoken = [];
      this._replying = true;
    } else if (frame instanceof InterruptionFrame) {
      // The bot heard what the user TTS spoke before the cut; a text-mode
      // reply is sent only once it is complete.
      this._text = [];
      await this._endReply();
    } else if (frame instanceof LLMTextFrame && frame.skipTts) {
      this._text.push(frame.text);
    } else if (frame instanceof LLMFullResponseEndFrame) {
      const text = this._text.join("").trim();
      this._text = [];
      if (frame.skipTts && text) {
        this._trace.log(`send: ${pyStrRepr(text)} (persona, text)`);
        await this.pushFrame(
          new OutputTransportMessageUrgentFrame({ message: this._textTurnMessage(text) }),
        );
        this._spoken.push(text);
      }
      await this._endReply();
    } else if (frame instanceof TTSTextFrame) {
      this._trace.log(`send: ${pyStrRepr(frame.text)} (persona, audio)`);
      this._spoken.push(frame.text);
    }
    await this.pushFrame(frame, direction);
  }

  /** Append what went out of the reply as a turn, then the end_call event held for it. */
  protected async _endReply(): Promise<void> {
    if (this._spoken.length > 0) {
      await this._stream.append({ type: PERSONA_TURN_EVENT, text: this._spoken.join(" ") });
    }
    this._spoken = [];
    this._replying = false;
    if (this._endCall !== null) {
      await this._stream.append(this._endCall);
      this._endCall = null;
    }
  }
}

/** Options for {@link EvalClientParams}. */
export interface EvalClientParamsOptions {
  /** Whether the bot speaks; in text mode it is asked to skip TTS at connect. */
  botAudio?: boolean;
  /** Whether the user's turns reach the bot as audio. */
  userAudio?: boolean;
  /** TTS config the user's turns are synthesized with, or `null`; sets the user audio rate. */
  userSpeech?: Dict | null;
  /** Whether the bot forwards its synthesized audio, for the `response` transcription or a persona that listens. */
  captureBotAudio?: boolean;
  /** Whether the bot reports the images it outputs. */
  captureBotImages?: boolean;
  /** Function-call report level to ask of the bot, or `null` for its default. */
  reportLevel?: string | null;
  /** Whether to ask the bot for its raw VAD events. */
  vadEvents?: boolean;
  /** Whether to ask the bot for the sideband markers its LLM emits. */
  markerEvents?: boolean;
  /** Messages the bot's context starts from, sent right after the handshake; empty sends nothing. */
  context?: Dict[];
  /**
   * Whether the scenario itself asks a bot serving the server `EvalTransport`
   * to fire its `on_client_disconnected` handler when this connection ends.
   */
  triggerDisconnect?: boolean;
}

/** What the scenario asks of the bot; the session derives it from its scenario. */
export class EvalClientParams {
  botAudio: boolean;
  userAudio: boolean;
  userSpeech: Dict | null;
  captureBotAudio: boolean;
  captureBotImages: boolean;
  reportLevel: string | null;
  vadEvents: boolean;
  markerEvents: boolean;
  context: Dict[];
  triggerDisconnect: boolean;

  constructor(options: EvalClientParamsOptions = {}) {
    this.botAudio = options.botAudio ?? false;
    this.userAudio = options.userAudio ?? false;
    this.userSpeech = options.userSpeech ?? null;
    this.captureBotAudio = options.captureBotAudio ?? false;
    this.captureBotImages = options.captureBotImages ?? false;
    this.reportLevel = options.reportLevel ?? null;
    this.vadEvents = options.vadEvents ?? false;
    this.markerEvents = options.markerEvents ?? false;
    this.context = options.context ?? [];
    this.triggerDisconnect = options.triggerDisconnect ?? false;
  }
}

/** The bot refused the connection, or closed it, before sending `bot-ready`. */
export class EvalBotUnavailableError extends Error {
  /**
   * The failure kind the run records: `connect_failed` when the bot refused
   * the connection, `closed_before_ready` when it closed the connection before
   * `bot-ready`.
   */
  kind: string;

  /**
   * Initialize the error.
   *
   * @param kind The failure kind the run records.
   * @param reason What happened, with the close code and reason when there was one.
   */
  constructor(kind: string, reason: string) {
    super(reason);
    this.name = "EvalBotUnavailableError";
    this.kind = kind;
  }
}

/** Options for {@link EvalClient}. */
export interface EvalClientOptions {
  /** What the scenario asks of the bot; `null` asks nothing beyond a text-mode conversation. */
  params?: EvalClientParams | null;
  /**
   * How the run behaves: the connect timeout, the recording, and the handshake
   * timeout are the client's part of it. `null` for the defaults.
   */
  sessionParams?: EvalSessionParams | null;
  /** Where the bot's output is appended as events. */
  stream: EvalEventStream;
  /** The run's trace. */
  trace: EvalTrace;
  /** The `CachingTTSService` that synthesizes spoken user turns, or `null` for text mode. */
  userTts?: CachingTTSService | null;
  /** The `STTService` that transcribes the bot's audio into the `response` event, or `null`. */
  botStt?: STTService | null;
  /**
   * A simulation's `EvalPersona`, whose LLM rides in the pipeline and whose
   * context the aggregators keep up to date with both sides of the
   * conversation; `null` for a scripted scenario.
   */
  persona?: EvalPersona | null;
}

/**
 * The eval pipeline that talks to the bot, and the user's sends into it.
 *
 * Built once per run: `waitForBot`, `start`, `handshake`, the turns
 * (`sendText`, `say`, `play`, `sendDtmf`, `sendImage`), then `stop`. The
 * pipeline is the same for both modalities and both kinds of eval:
 *
 *     input -> [STT -> speech gate -> user aggregator] -> sink -> [persona LLM]
 *           -> [user TTS] -> [persona relay] -> output -> [assistant aggregator]
 *
 * The bracketed stages exist only in audio mode (the STT, the gate that drops
 * transcripts of audio from before a send that talked over the bot, the
 * aggregator, the user TTS) or in a simulation (the persona LLM, its relay,
 * the aggregator that records its replies). The bot's output comes in through
 * the input and stops at the sink, as events; the user's turns start at the
 * sink and leave through the output. A session builds it, with the params its
 * scenario asks for.
 */
export class EvalClient {
  protected _botUrl: string;
  protected _stream: EvalEventStream;
  protected _trace: EvalTrace;
  protected _params: EvalClientParams;
  protected _sessionParams: EvalSessionParams;
  protected _userTts: CachingTTSService | null;
  protected _botStt: STTService | null;
  protected _persona: EvalPersona | null;
  // The aggregator that turns the bot's transcribed speech into turns (audio
  // mode), kept so a send that talks over the bot can drop what it holds of
  // the bot's speech from before the send.
  protected _botTurns: LLMUserAggregator | null = null;
  // The eval pipeline's worker (built by start()) and the runner task driving it.
  protected _worker: PipelineWorker | null = null;
  // Set once stop() begins: a disconnect from then on is our own teardown.
  protected _stopping = false;
  // Where the user's turns enter the pipeline (built with the processors).
  protected _sink: _BotFrameSink | null = null;
  // What sends the persona's replies to the bot (built with the processors).
  protected _relay: _PersonaTurnRelay | null = null;
  protected _runTask: Task<void> | null = null;
  // Records the conversation audio (bot + user) when recordPath is set and the
  // scenario is audio mode; fed raw audio by the transport, written on stop().
  protected _recorder: EvalClientRecorder | null = null;
  // Set once the handshake is over: by the bot's bot-ready, or by the bot
  // refusing or closing the connection first, which leaves _refusal set.
  // handshake() waits on it.
  protected _handshakeOver = new Event();
  protected _refusal: EvalBotUnavailableError | null = null;
  protected _nextId = 0;

  /**
   * Initialize the client.
   *
   * @param botUrl WebSocket URL of the bot's eval transport.
   * @param options See {@link EvalClientOptions}.
   */
  constructor(botUrl: string, options: EvalClientOptions) {
    this._botUrl = botUrl;
    this._stream = options.stream;
    this._trace = options.trace;
    this._params = options.params ?? new EvalClientParams();
    this._sessionParams = options.sessionParams ?? new EvalSessionParams();
    this._userTts = options.userTts ?? null;
    this._botStt = options.botStt ?? null;
    this._persona = options.persona ?? null;
  }

  /** Whether text user turns are spoken to the bot rather than sent as text. */
  get hasUserTts(): boolean {
    return this._userTts !== null;
  }

  /** Whether the user's side streams audio to the bot (the output is enabled). */
  get sendsUserAudio(): boolean {
    return this._userTts !== null || this._params.userAudio;
  }

  /**
   * Wait until the bot accepts connections.
   *
   * Retries a plain TCP connect until the bot is listening, and stops short of
   * the WebSocket handshake on purpose: a full connection would make the bot
   * greet, and that connection would then be thrown away.
   *
   * DIVERGENCE: the TCP probe uses `node:net` (Bun, Node, Deno), imported
   * lazily; there is no raw TCP on Cloudflare Workers.
   *
   * @throws Error The last connect error, when the bot never accepted within
   *   the connect timeout.
   * @throws TimeoutError When the timeout passed without a single attempt failing.
   */
  async waitForBot(): Promise<void> {
    const u = new URL(this._botUrl);
    const host = u.hostname.replace(/^\[(.*)\]$/, "$1") || "localhost";
    const port = u.port ? Number(u.port) : u.protocol === "wss:" ? 443 : 80;
    const deadline = monotonic() + this._sessionParams.connectTimeoutS;
    const net = await import("node:net");
    let connectError: unknown = null;
    while (monotonic() < deadline) {
      const attempt = new Future<unknown>();
      const socket = net.connect({ host, port });
      socket.once("connect", () => {
        if (!attempt.done()) attempt.setResult(null);
      });
      socket.once("error", (e: Error) => {
        if (!attempt.done()) attempt.setResult(e);
      });
      let error: unknown;
      try {
        error = await attempt;
      } finally {
        socket.destroy();
      }
      if (error !== null) {
        // not accepting connections yet
        connectError = error;
        await sleep(0.25);
        continue;
      }
      return;
    }
    throw connectError ?? new TimeoutError("timed out");
  }

  /** Build the eval pipeline and start running it, which connects to the bot. */
  async start(): Promise<void> {
    const transport = this._transport();
    const pipeline = new Pipeline(await this._processors(transport));
    const worker = new PipelineWorker(pipeline, {
      params: this._pipelineParams(),
      enableRtvi: false,
      cancelOnIdleTimeout: false,
    });
    this._worker = worker;

    worker.eventHandler("on_pipeline_error", async (_worker: PipelineWorker, frame: ErrorFrame) => {
      // The transport connects as it starts, so a refused connection (an
      // HTTP 403 for a spent token, nothing listening) surfaces here.
      if (_isConnectError(frame.exception)) {
        this._refuse("connect_failed", String(frame.exception));
      }
      await this._stream.append({ type: HARNESS_ERROR_EVENT, text: String(frame.error) });
    });

    // Before the pipeline runs, so the persona is configured before it can
    // hear the bot, which may greet as soon as the input transport starts.
    if (this._persona !== null) {
      await this._configurePersona(this._persona.instruction);
    }

    const runner = new WorkerRunner();
    await runner.addWorkers(worker);
    this._runTask = createTask(() => runner.run());
  }

  /**
   * Wait for `bot-ready`, then send what the scenario asks of the bot and its context.
   *
   * A bot that never says ready is not a usable eval target, so this throws
   * instead of sending turns to a half-started bot.
   *
   * @throws EvalBotUnavailableError If the bot refuses the connection or closes
   *   it before sending `bot-ready`.
   * @throws TimeoutError If the bot never sends `bot-ready`.
   */
  async handshake(): Promise<void> {
    // The transport sends client-ready on connect and fires on_bot_ready when
    // the bot answers; our handler sets _handshakeOver.
    const timeoutS = this._sessionParams.botReadyTimeoutS;
    try {
      await waitFor(() => this._handshakeOver.wait(), timeoutS);
    } catch (e) {
      if (e instanceof TimeoutError) {
        throw new TimeoutError(`bot-ready not received within ${Math.trunc(timeoutS * 1000)}ms`);
      }
      throw e;
    }
    if (this._refusal !== null) {
      throw this._refusal;
    }

    // Ask the bot's RTVIObserver to expose what this scenario needs, for the
    // duration of this eval only (bots keep their defaults; only the eval
    // transport understands this): raise the function-call report level if it
    // asserts on call name/args, and enable raw VAD speaking events and LLM
    // markers if it uses them.
    const config: Dict = {};
    if (this._params.reportLevel !== null) {
      config.function_call_report_level = { "*": this._params.reportLevel };
    }
    if (this._params.vadEvents) {
      config.vad_user_speaking = true;
    }
    if (this._params.markerEvents) {
      config.llm_markers = true;
    }
    if (Object.keys(config).length > 0) {
      await this._sendEval(EVAL_CONFIGURE_MESSAGE_TYPE, config);
    }

    // Only send the eval-context when the scenario provides starting context.
    // An implicit empty one would race with bot startup flows (e.g. a greeting
    // added in on_client_connected), wiping the bot's context right after it
    // set it up.
    if (this._params.context.length > 0) {
      await this._sendEval(EVAL_CONTEXT_MESSAGE_TYPE, { messages: this._params.context });
    }
  }

  /** Save the recording, end the bot's session, and end the pipeline. */
  async stop(): Promise<void> {
    this._stopping = true;
    // Write the recording first: the recorder is harness-owned and fed raw
    // audio by the transport, so nothing below clears it, but writing here
    // lands it even if the teardown throws.
    await this._writeRecording();
    // End the bot's session whatever its disconnect handler does, so it
    // doesn't wait out its pipeline's idle timeout.
    await this._sendCancel();
    const worker = this._worker;
    const runTask = this._runTask;
    if (worker === null || runTask === null) {
      return;
    }
    // End the worker (which disconnects the transport), falling back to
    // cancel if it doesn't wind down cleanly.
    try {
      await worker.queueFrame(new EndFrame());
      await waitFor(() => runTask, 5.0);
    } catch {
      // Upstream catches CancelledError here too, deliberately.
      runTask.cancel();
      try {
        await runTask;
      } catch {
        // Upstream swallows CancelledError and any error here.
      }
    }
  }

  /**
   * Send an RTVI client message to the bot through the transport pipeline.
   *
   * @param message The message to send.
   */
  async send(message: Message): Promise<void> {
    if (this._worker === null) throw new Error("assertion failed: pipeline built before any send");
    await this._worker.queueFrame(
      new OutputTransportMessageUrgentFrame({ message: message.modelDump() }),
    );
  }

  /**
   * Send a text user turn via the RTVI `send-text` message.
   *
   * @param text The user's turn.
   */
  async sendText(text: string): Promise<void> {
    await this._dropBotSpeechIfTalkingOver();
    await this.send(Message.modelValidate(this._textTurnMessage(text)));
  }

  /**
   * Send a DTMF keypress turn as one RTVI `dtmf` message.
   *
   * The bot handles the keys the way it handles a phone keypad.
   *
   * @param keys The keys to press, in order.
   */
  async sendDtmf(keys: string): Promise<void> {
    await this._dropBotSpeechIfTalkingOver();
    await this.send(this._message("dtmf", { buttons: Array.from(keys) }));
  }

  /**
   * Register an image for the current turn.
   *
   * The bot's eval transport serves it back when the bot asks for a user
   * image. The file is sent as is.
   *
   * @param imagePath Path to the image file.
   */
  async sendImage(imagePath: string): Promise<void> {
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(imagePath);
    const encoded = bytesToBase64(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const name = _basename(imagePath);
    const mime = _guessMime(name) ?? "image/jpeg";
    this._trace.log(`send: image ${name} (${mime})`);
    await this._sendEval(EVAL_IMAGE_MESSAGE_TYPE, { image: encoded, format: mime });
  }

  /**
   * Speak `text` as the user.
   *
   * The user TTS synthesizes it (cached) and the output paces it to the bot as
   * live audio.
   *
   * @param text What the user says.
   */
  async say(text: string): Promise<void> {
    const sink = this._sink;
    if (sink === null) throw new Error("assertion failed: pipeline built before any send");
    await this._dropBotSpeechIfTalkingOver();
    await sink.inject(new TTSSpeakFrame({ text }));
  }

  /**
   * Speak the user's text with real silence between its parts.
   *
   * Each text is synthesized by the user TTS (cached), and the turn goes out
   * like a recording: one stretch of audio, paced to the bot and recorded.
   *
   * @param parts Text to speak, or the milliseconds of silence between texts.
   */
  async sayWithPauses(parts: (string | number)[]): Promise<void> {
    const sink = this._sink;
    const tts = this._userTts;
    if (sink === null) throw new Error("assertion failed: pipeline built before any send");
    if (tts === null) throw new Error("assertion failed: pauses need a voice to speak them");
    await this._dropBotSpeechIfTalkingOver();
    const sampleRate = tts.sampleRate;
    const chunks: Uint8Array[] = [];
    for (const part of parts) {
      if (typeof part === "string") {
        chunks.push(await tts.synthesize(part));
      } else {
        chunks.push(new Uint8Array(2 * Math.floor((sampleRate * part) / 1000)));
      }
    }
    const pcm = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }
    for (const frame of [
      new TTSStartedFrame(),
      new TTSAudioRawFrame({ audio: pcm, sampleRate, numChannels: 1 }),
      new TTSStoppedFrame(),
    ]) {
      await sink.inject(frame);
    }
  }

  /**
   * Play a recording to the bot as the user's turn, instead of synthesizing one.
   *
   * It goes out like a spoken turn: resampled to the user audio rate, paced to
   * the bot, and recorded.
   *
   * @param path Path to the audio file.
   */
  async play(path: string): Promise<void> {
    const sink = this._sink;
    if (sink === null) throw new Error("assertion failed: pipeline built before any send");
    await this._dropBotSpeechIfTalkingOver();
    const [pcm, sampleRate] = await loadUserAudio(path);
    for (const frame of [
      new TTSStartedFrame(),
      new TTSAudioRawFrame({ audio: pcm, sampleRate, numChannels: 1 }),
      new TTSStoppedFrame(),
    ]) {
      await sink.inject(frame);
    }
  }

  /**
   * Before a send that talks over the bot, drop its speech held in an open turn.
   *
   * An ordinary send waits for the bot's speech to be transcribed and closed
   * into a turn. A send over a speaking bot cannot, and the bot's turn open at
   * that moment holds transcripts of what it said before the send; left there,
   * they would close into a turn after the bot's LLM has restarted and pass
   * for the reply. The transcripts still with the STT are dropped by the gate
   * as they land (see `_BotSpeechGate`).
   */
  protected async _dropBotSpeechIfTalkingOver(): Promise<void> {
    if (this._botTurns === null || !this._stream.botSpeaking) {
      return;
    }
    this._trace.log("discard: bot speech held in its open turn before the interrupting send");
    await this._botTurns.reset();
  }

  /** End the persona's part of the conversation: it answers nothing more. */
  async hangUp(): Promise<void> {
    if (this._persona === null) throw new Error("assertion failed: persona is not set");
    this._persona.hangUp();
  }

  /**
   * Append the persona's `end_call` event once the reply that made the call has gone out.
   *
   * @param event The `end_call` event.
   */
  async reportEndCall(event: EvalEvent): Promise<void> {
    if (this._relay === null) {
      throw new Error("assertion failed: pipeline built before the persona replies");
    }
    await this._relay.endCall(event);
  }

  /** Give the persona LLM its instruction, and say whether its replies are spoken or sent as text. */
  protected async _configurePersona(instruction: string): Promise<void> {
    const sink = this._sink;
    if (sink === null) {
      throw new Error("assertion failed: pipeline built before the persona is configured");
    }
    await sink.inject(
      new LLMUpdateSettingsFrame({ delta: new LLMSettings({ systemInstruction: instruction }) }),
    );
    await sink.inject(new LLMConfigureOutputFrame({ skipTts: !this._params.userAudio }));
  }

  /** End the handshake with a refusal, unless it is already over. */
  protected _refuse(kind: string, reason: string): void {
    if (!this._handshakeOver.isSet()) {
      this._refusal = new EvalBotUnavailableError(kind, reason);
      this._handshakeOver.set();
    }
  }

  /**
   * What this connection asks of the bot.
   *
   * `skip_tts` in text mode, `capture_bot_audio` when the harness needs the
   * bot's audio, `capture_bot_images` when it needs the bot's images.
   */
  protected _connectionFlags(): EvalConnectionFlags {
    return new EvalConnectionFlags({
      skipTts: !this._params.botAudio,
      // Forward the bot's audio when something listens to it (the response
      // transcription, a persona) or when recording an audio run.
      captureBotAudio:
        this._params.captureBotAudio || Boolean(this._recordPath && this._params.botAudio),
      captureBotImages: this._params.captureBotImages,
    });
  }

  /**
   * The bot's URL with this connection's eval flags as query params.
   *
   * The flags, and `trigger_disconnect` when the scenario asks for it, for a
   * bot serving the eval transport's WebSocket server.
   */
  protected _connectUrl(): string {
    const connection = this._connectionFlags();
    const flags: string[] = [];
    if (connection.skipTts) {
      flags.push("skip_tts=true");
    }
    if (connection.captureBotAudio) {
      flags.push("capture_bot_audio=true");
    }
    if (connection.captureBotImages) {
      flags.push("capture_bot_images=true");
    }
    // The deprecated `EvalSessionParams.trigger_disconnect` is not ported; only
    // the scenario's own ask remains.
    if (this._params.triggerDisconnect) {
      flags.push("trigger_disconnect=true");
    }
    if (flags.length === 0) {
      return this._botUrl;
    }
    const sep = this._botUrl.includes("?") ? "&" : "?";
    return `${this._botUrl}${sep}${flags.join("&")}`;
  }

  /** Where the run records the conversation, or `null`. */
  protected get _recordPath(): string | null {
    return this._sessionParams.recordPath ?? null;
  }

  /** The rate the user's audio is synthesized at; 0 in text mode. */
  protected get _userAudioRate(): number {
    return this._params.userSpeech ? ttsSampleRate(this._params.userSpeech) : 0;
  }

  /** The transport to the bot, with the recorder when the run records, and its two handlers. */
  protected _transport(): EvalClientTransport {
    const params = new WebsocketClientParams({
      audioInEnabled: this._params.botAudio,
      audioOutEnabled: this.sendsUserAudio,
      audioInSampleRate: this._params.botAudio ? EVAL_STT_SAMPLE_RATE : 0,
      audioOutSampleRate: this._userAudioRate,
      serializer: new EvalClientSerializer(),
    });
    // The recorder is fed the raw audio by both edges; the paced streams
    // would make the recording stutter.
    if (this._recordPath && this._params.botAudio) {
      this._recorder = new EvalClientRecorder(this._userAudioRate || EVAL_STT_SAMPLE_RATE);
    }
    const transport = new EvalClientTransport(this._connectUrl(), params, {
      flags: this._connectionFlags(),
      recorder: this._recorder,
    });

    transport.eventHandler("on_bot_ready", async () => {
      this._handshakeOver.set();
    });

    transport.eventHandler(
      "on_disconnected",
      async (_transport: EvalClientTransport, websocket: WebsocketConnection) => {
        // The bot ended the call by closing the connection; our own teardown
        // closes it too, and that is not the bot's doing.
        if (this._stopping) {
          return;
        }
        // Before bot-ready a close is a refusal, such as Pipecat Cloud's
        // bot-starter turning away a session over the agent's limit.
        this._refuse("closed_before_ready", _closeDescription(websocket));
        this._stream.botEnded();
        await this._stream.append({ type: BOT_ENDED_EVENT });
      },
    );

    return transport;
  }

  /**
   * The pipeline's processors: inbound from the bot, the sink, outbound to the bot.
   *
   * The STT and the turn aggregator exist in audio mode; the persona LLM, its
   * relay, and the assistant aggregator in a simulation.
   */
  protected async _processors(transport: EvalClientTransport): Promise<FrameProcessor[]> {
    // The context the aggregators keep: the persona's in a simulation, else a
    // throwaway that only gives the user aggregator somewhere to put turns.
    const persona = this._persona;
    const userTts = this._userTts;
    const botStt = this._botStt;
    const context = persona !== null ? persona.context : new LLMContext();
    // With no STT there is no aggregator to hand the persona the bot's turns;
    // it hears them through the sink instead.
    this._sink = new _BotFrameSink(this._stream, { persona, personaHears: botStt === null });

    const inbound: FrameProcessor[] = [transport.input()];
    if (botStt !== null) {
      let starts: number[] | null = null;
      if (botStt instanceof SegmentedSTTService) {
        starts = [];
        _tagBotSegments(botStt, starts);
      }
      this._botTurns = await this._botTurnAggregator(context);
      inbound.push(botStt, new _BotSpeechGate(this._stream, this._trace, starts), this._botTurns);
    }

    const speech: FrameProcessor[] = userTts !== null ? [userTts] : [];
    let outbound: FrameProcessor[];
    if (persona === null) {
      outbound = [...speech, transport.output()];
    } else {
      this._relay = new _PersonaTurnRelay(
        (text) => this._textTurnMessage(text),
        this._trace,
        this._stream,
      );
      outbound = [
        persona.llm,
        ...speech,
        this._relay,
        transport.output(),
        new LLMAssistantAggregator(context),
      ];
    }
    return [...inbound, this._sink, ...outbound];
  }

  /**
   * The aggregator that cuts the bot's transcribed speech into turns (audio mode).
   *
   * Its turn hooks give the stream the timing of the bot's replies, and its
   * finished turn is the persona's next user message.
   */
  protected async _botTurnAggregator(context: LLMContext): Promise<LLMUserAggregator> {
    // Silero is an optional peer, imported only when the harness transcribes
    // the bot's speech.
    const { SileroVADAnalyzer } = await import("@pipedog/audio-silero/silero");
    const aggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        vadAnalyzer: new SileroVADAnalyzer({ params: new VADParams({ stopSecs: 0.4 }) }),
      }),
    });

    // The aggregator consumes the STT's TranscriptionFrames to build the
    // bot's turn, so the response comes from the aggregated turn text here
    // (not from a frame at the sink). Transcripts of audio from before an
    // interrupting send never reach it (see _BotSpeechGate); the stream
    // still holds a turn back until the bot's LLM has answered the send
    // (see EvalEventStream.botTurnStopped).
    aggregator.eventHandler("on_user_turn_started", async () => {
      this._stream.botTurnStarted();
    });

    aggregator.eventHandler(
      "on_user_turn_stopped",
      async (_aggregator: unknown, _strategy: unknown, message: { content?: string | null }) => {
        await this._stream.botTurnStopped(message.content || "");
      },
    );

    return aggregator;
  }

  /**
   * The StartFrame's rates: the bot STT reads the input rate, the user TTS
   * produces the output rate.
   *
   * They come from the scenario so the user TTS synthesizes at the configured
   * rate; in text mode the STT rate is a placeholder.
   */
  protected _pipelineParams(): PipelineParams {
    return new PipelineParams({
      audioInSampleRate: EVAL_STT_SAMPLE_RATE,
      audioOutSampleRate: this._userAudioRate || EVAL_STT_SAMPLE_RATE,
    });
  }

  /** One RTVI client message, numbered in order of creation. */
  protected _message(messageType: string, data: Dict): Message {
    this._nextId += 1;
    return new Message({ type: messageType, id: String(this._nextId), data });
  }

  /** Send one of the eval transport's own messages, in the `client-message` envelope. */
  protected async _sendEval(evalType: string, data: Dict): Promise<void> {
    await this.send(this._message("client-message", { t: evalType, d: data }));
  }

  /**
   * The RTVI `send-text` message for a user turn, as a dict.
   *
   * The bot answers right away, and speaks the answer only in audio mode.
   */
  protected _textTurnMessage(text: string): Dict {
    const data = new SendTextData({
      content: text,
      options: new SendTextOptions({ runImmediately: true, audioResponse: this._params.botAudio }),
    });
    return this._message("send-text", data.modelDump()).modelDump();
  }

  /**
   * Ask the bot to cancel its pipeline, ending its session.
   *
   * Best-effort: the connection may already be gone.
   */
  protected async _sendCancel(): Promise<void> {
    try {
      await this._sendEval(EVAL_CANCEL_MESSAGE_TYPE, {});
    } catch (e) {
      rethrowIfCancelled(e);
    }
  }

  /** Write the recorded conversation audio (bot + user) to `recordPath`. */
  protected async _writeRecording(): Promise<void> {
    const recordPath = this._recordPath;
    if (this._recorder === null || !recordPath || !this._recorder.hasAudio()) {
      return;
    }
    if (await this._recorder.write(recordPath)) {
      this._trace.log(`recording saved: ${recordPath}`);
    }
  }
}
