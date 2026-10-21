// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/events.py

/**
 * The bot's output as the harness sees it.
 *
 * `EvalEventStream` turns the frames the bot-facing transport produces into
 * the events scenarios assert on, queues them for the matcher, and keeps the
 * bookkeeping the rest of the harness reads: every event seen, when each event
 * type last arrived (for `send_after`), and whether the bot's next output is
 * still the tail of an interrupted response.
 *
 * The events, and the RTVI server messages the bot emits them as:
 *
 * | scenario `event:`           | RTVI server message(s) |
 * |-----------------------------|------------------------|
 * | `user_started_speaking`     | `user-started-speaking` |
 * | `user_stopped_speaking`     | `user-stopped-speaking` |
 * | `vad_user_started_speaking` | `vad-user-started-speaking` (raw VAD, ungated by turn detection) |
 * | `vad_user_stopped_speaking` | `vad-user-stopped-speaking` (raw VAD, ungated by turn detection) |
 * | `user_transcription`        | `user-input` of type `transcription` (final only) |
 * | `llm_started`               | `bot-llm-started` |
 * | `llm_response`              | the LLM text: `bot-llm-text` joined at `bot-llm-stopped` |
 * | `llm_marker`                | `bot-llm-marker`: the sideband marker the LLM emitted in a response, such as a turn-completion marker, with its `kind` and the response's raw text; sent when the response ends, only on request |
 * | `tts_response`              | the TTS's spoken text: one segment per `bot-tts-text` (audio modality only) |
 * | `response`                  | the harness's own transcription of the bot's audio (audio modality only); `llm_response` in text modality |
 * | `function_call`             | `llm-function-call-in-progress`; a call made outside the bot's pipeline and reported into it (`ExternalFunctionCall*Frame`), such as a backend's, counts the same |
 * | `function_call_stopped`     | `llm-function-call-stopped`; its `args` carry `tool_call_id` and `cancelled`, so a scenario can tell work that was stopped from work that finished on its own |
 * | `image`                     | `eval-bot-image`: an image the bot output, with its `width`, `height`, and `format`; sent only on request |
 * | `bot_backchannel`           | `bot-output` of type `backchannel`, once spoken to the end: a short acknowledgment the bot said while the user talked, such as "Mm-hmm." |
 * | `user_backchannel`          | `user-input` of type `backchannel`: a short acknowledgment the user said while the bot talked, which neither interrupted it nor reached the LLM |
 */

import {
  Event,
  monotonic,
  Queue,
  QueueEmpty,
  TimeoutError,
  timeout,
  waitFor,
} from "@pipedog/asyncio";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  ExternalFunctionCallCancelFrame,
  ExternalFunctionCallInProgressFrame,
  ExternalFunctionCallResultFrame,
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallInProgressFrame,
  FunctionCallResultFrame,
  InputTransportMessageFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMMarkerResponseFrame,
  LLMTextFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { pyStr, pyStrRepr } from "./_pyutil.ts";
import type { EvalTrace } from "./results.ts";
import { EVAL_BOT_IMAGE_TYPE } from "./serializer.ts";

/** One event, as a dict: its `type` and whatever else the event carries. */
export type EvalEvent = { type: string; [key: string]: unknown };

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python truthiness of a JSON value. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return true;
}

/** Python's `dict.get(key, default)`. */
function get(dict: Dict, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(dict, key) ? dict[key] : fallback;
}

/** Python's `a or b`. */
function or(value: unknown, fallback: unknown): unknown {
  return truthy(value) ? value : fallback;
}

// The bot's reports that end its current turn: what it produced so far is not
// its reply to what comes next.
const _INTERRUPTION_EVENTS: readonly string[] = ["user_started_speaking", "bot_interrupted"];

/** The bot ended the call before the awaited event arrived, so it never will. */
export class EvalBotEndedError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "EvalBotEndedError";
  }
}

/** Options for {@link EvalEventStream}. */
export interface EvalEventStreamOptions {
  /** Whether the scenario runs in audio mode; `tts_response` is emitted only then. */
  botAudio: boolean;
  /** The run's trace, where each event is logged as it arrives. */
  trace: EvalTrace;
}

/** Options for {@link EvalEventStream.nextEvent}. */
export interface NextEventOptions {
  /**
   * Position in the turn's log to look from; `null` looks only at what
   * arrives from now on.
   */
  since?: number | null;
  /**
   * A further check on an event of the type, such as a call's name; one it
   * turns down is left for another expectation.
   */
  accept?: ((event: EvalEvent) => boolean) | null;
}

/**
 * The bot's output as events: a queue the drivers read, fed by the pipeline.
 *
 * The sink turns each frame from the bot into an event and appends it; the
 * drivers pop events as they wait for them. One rule runs through it: what
 * the bot produced before the user's latest send is not the reply to it. An
 * LLM response still streaming at the send, or cut by an interruption, is
 * dropped until the bot's next `llm-started`, and a spoken turn that began
 * before the send is dropped when it ends.
 */
export class EvalEventStream {
  protected _botAudio: boolean;
  protected _trace: EvalTrace;
  protected _queue: Queue<EvalEvent>;
  // The events popped during the current turn, in order, and which of them
  // an expectation has claimed. An expectation looks for its event from
  // the point the turn had reached when it began, or from the start of the
  // turn (`check_from: turn_start`), so an event popped on the way to
  // another expectation's is not lost to one that may look back for it.
  protected _turnLog: EvalEvent[];
  protected _claimed: Set<number>;
  /** Every event in arrival order, for the result's diagnostics. */
  eventsSeen: EvalEvent[];
  /** When each event type last arrived, for send_after anchoring. */
  latestEventTimes: Record<string, number>;
  // Accumulates the bot's LLM text for the current response, emitted as one
  // llm_response segment when the response ends.
  protected _textBuffer: string[];
  // Events are stamped in seconds since here (`at`), and a reply with the
  // arrival of its first token (`started_at`), for the timing measures.
  protected _t0: number;
  /**
   * When either side last did anything: an event, or a frame that only
   * buffers toward one (a bot token, a persona sentence).
   */
  lastActivity: number;
  protected _llmTextAt: number | null;
  // The reply rule's flag: set by a send or an interruption, cleared at the
  // bot's next llm-started. While set, LLM text is dropped: an interrupted
  // response can still flush a trailing token after the interruption (it
  // was generated before the interrupt propagated), and that straggler
  // must not be attributed to the new turn.
  protected _awaitingReply: boolean;
  // When the driver last sent user input, and, when that send talked over
  // the bot, when the bot started speaking again (infinity until it
  // does): its speech from before then is what it was saying, not its
  // reply, however late its transcription lands (audio mode).
  protected _inputSentAt: number;
  protected _talkedOverUntil: number | null;
  // Whether the turn sends nothing and waits for the bot's next speech,
  // which is its reply whether or not the bot's LLM produced it (a
  // presence check, say). Cleared when the bot starts speaking.
  protected _observing: boolean;
  // Whether the bot is speaking, by its own report: cleared when it
  // starts, set when it stops or is interrupted. An event, so a driver
  // that must not talk over the bot can wait for it without polling.
  protected _botQuiet: Event;
  // Whether everything the bot has said is transcribed and closed into a
  // turn (audio mode): a segment of its speech the VAD still hears,
  // segments still to be transcribed, and whether a spoken turn is open.
  // An event, so a driver can wait for the bot's speech to be fully
  // accounted for before it sends.
  protected _botSegmentOpen: boolean;
  protected _botSegmentsPending: number;
  protected _botTurnOpen: boolean;
  protected _botTranscribed: Event;
  // Whether the bot closed the connection. Kept apart from its queued
  // bot_ended event, which a drop of the bot's pending output discards.
  protected _botEnded: boolean;

  /**
   * Initialize the stream.
   *
   * @param options.botAudio Whether the scenario runs in audio mode;
   *   `tts_response` is emitted only then.
   * @param options.trace The run's trace, where each event is logged as it arrives.
   */
  constructor(options: EvalEventStreamOptions) {
    this._botAudio = options.botAudio;
    this._trace = options.trace;
    this._queue = new Queue<EvalEvent>();
    this._turnLog = [];
    this._claimed = new Set();
    this.eventsSeen = [];
    this.latestEventTimes = {};
    this._textBuffer = [];
    this._t0 = monotonic();
    this.lastActivity = this._t0;
    this._llmTextAt = null;
    this._awaitingReply = false;
    this._inputSentAt = 0.0;
    this._talkedOverUntil = null;
    this._observing = false;
    this._botQuiet = new Event();
    this._botQuiet.set();
    this._botSegmentOpen = false;
    this._botSegmentsPending = 0;
    this._botTurnOpen = false;
    this._botTranscribed = new Event();
    this._botTranscribed.set();
    this._botEnded = false;
  }

  /** Whether the bot reports itself speaking right now. */
  get botSpeaking(): boolean {
    return !this._botQuiet.isSet();
  }

  /**
   * Monotonic time the bot started speaking again after the latest turn began.
   *
   * The bot's speech that began before then belongs to the turn before:
   * what it was saying when a send talked over it, or the reply an observing
   * turn waited out. Infinity until the bot starts speaking again, and
   * `null` when the latest send did not talk over it.
   */
  get talkedOverUntil(): number | null {
    return this._talkedOverUntil;
  }

  /** Whether everything the bot has said is transcribed and closed into a turn. */
  get botTranscribed(): boolean {
    return this._botTranscribed.isSet();
  }

  /** Whether the bot ended the call (see `botEnded`). */
  get botHasEnded(): boolean {
    return this._botEnded;
  }

  /** What of the bot's speech is not yet accounted for, for the trace. */
  get botSpeechOutstanding(): string {
    const parts: string[] = [];
    if (this._botSegmentOpen) {
      parts.push("a segment still being heard");
    }
    if (this._botSegmentsPending) {
      parts.push(`${this._botSegmentsPending} segment(s) awaiting transcription`);
    }
    if (this._botTurnOpen) {
      parts.push("a turn still open");
    }
    return parts.join(", ") || "nothing";
  }

  /**
   * Wait for everything the bot has said to be transcribed and closed into a turn.
   *
   * @param timeoutS Seconds to wait at most.
   * @returns Whether the bot's speech is fully accounted for, or false if some
   *   of it was still being transcribed at the timeout.
   */
  async waitBotTranscribed(timeoutS: number): Promise<boolean> {
    try {
      await waitFor(() => this._botTranscribed.wait(), timeoutS);
    } catch (e) {
      if (e instanceof TimeoutError) return false;
      throw e;
    }
    return true;
  }

  /** The VAD hears a segment of the bot's speech. */
  botSegmentStarted(): void {
    this._botSegmentOpen = true;
    this._botTranscribed.clear();
  }

  /** A segment of the bot's speech ended and awaits transcription. */
  botSegmentEnded(): void {
    this._botSegmentOpen = false;
    this._botSegmentsPending += 1;
    this._botTranscribed.clear();
  }

  /** A segment of the bot's speech was transcribed, whether or not it yielded text. */
  botSegmentTranscribed(): void {
    this._botSegmentsPending = Math.max(0, this._botSegmentsPending - 1);
    this._updateBotTranscribed();
  }

  /** The bot began a spoken turn. */
  botTurnStarted(): void {
    this._botTurnOpen = true;
    this._botTranscribed.clear();
  }

  /** The bot closed the connection: it sends nothing more, and is no longer speaking. */
  botEnded(): void {
    this._botEnded = true;
    this._botQuiet.set();
  }

  protected _updateBotTranscribed(): void {
    if (!this._botSegmentOpen && this._botSegmentsPending === 0 && !this._botTurnOpen) {
      this._botTranscribed.set();
    }
  }

  /**
   * Wait for the bot to stop speaking.
   *
   * @param timeoutS Seconds to wait at most.
   * @returns Whether the bot is quiet, or false if it was still speaking at the
   *   timeout.
   */
  async waitBotQuiet(timeoutS: number): Promise<boolean> {
    try {
      await waitFor(() => this._botQuiet.wait(), timeoutS);
    } catch (e) {
      if (e instanceof TimeoutError) return false;
      throw e;
    }
    return true;
  }

  /**
   * Queue an event for the drivers.
   *
   * Stamps its arrival time as `at` (seconds since the stream began) unless
   * it has one, records it, and logs it.
   *
   * @param event The event dict, with at least a `type`.
   */
  async append(event: EvalEvent): Promise<void> {
    if (!Object.hasOwn(event, "at")) {
      event.at = this.elapsed();
    }
    this.touch();
    this.eventsSeen.push(event);
    this.latestEventTimes[event.type] = monotonic();
    const preview = or(or(or(event.text, event.transcript), event.name), "");
    this._trace.log(
      `event: ${event.type}${truthy(preview) ? `  ${pyStrRepr(pyStr(preview))}` : ""}`,
    );
    await this._queue.put(event);
  }

  /**
   * Pop the next queued event, whatever its type.
   *
   * @param deadline Monotonic time to give up at.
   * @returns The event.
   * @throws TimeoutError If no event arrives before `deadline`.
   */
  async nextAny(deadline: number): Promise<EvalEvent> {
    const remaining = deadline - monotonic();
    if (remaining <= 0) {
      throw new TimeoutError();
    }
    return await timeout(remaining, () => this._queue.get());
  }

  /** How many events the turn has popped so far: where an expectation beginning now looks from. */
  get turnPosition(): number {
    return this._turnLog.length;
  }

  /** Forget the events popped during the previous turn. */
  beginTurn(): void {
    this._turnLog = [];
    this._claimed = new Set();
  }

  /** The events popped from position `since` on that no expectation has claimed. */
  unclaimedSince(since: number): EvalEvent[] {
    return this._turnLog.filter((_event, i) => i >= since && !this._claimed.has(i));
  }

  /**
   * The next unclaimed event of `eventType` that `accept` takes, looking from `since`.
   *
   * The turn's log is searched first, from `since` on, then the queue is
   * popped until such an event arrives. Events popped on the way stay in the
   * log, unclaimed: a scenario need not list every event the bot emits, and
   * an expectation that looks back from an earlier point can still claim
   * them. Every event stays in `eventsSeen`.
   *
   * @param eventType The event type to wait for.
   * @param deadline Monotonic time to give up at.
   * @param options.since Position in the turn's log to look from; `null` looks
   *   only at what arrives from now on.
   * @param options.accept A further check on an event of the type, such as a
   *   call's name; one it turns down is left for another expectation.
   * @returns The event.
   * @throws TimeoutError If none arrives before `deadline`.
   * @throws EvalBotEndedError If the bot ended the call and none is left to
   *   arrive. The harness's transcription of what the bot said last (audio
   *   mode) is waited for first, since it can land after the bot is gone.
   */
  async nextEvent(
    eventType: string,
    deadline: number,
    options: NextEventOptions = {},
  ): Promise<EvalEvent> {
    const since = options.since ?? null;
    const accept = options.accept ?? null;
    const wanted = (event: EvalEvent): boolean =>
      event.type === eventType && (accept === null || accept(event));

    if (since !== null) {
      for (let i = since; i < this._turnLog.length; i++) {
        if (!this._claimed.has(i) && wanted(this._turnLog[i]!)) {
          this._claimed.add(i);
          this._trace.log(`match: ${pyStrRepr(eventType)} from earlier in the turn`);
          return this._turnLog[i]!;
        }
      }
    }
    while (true) {
      if (this._botEnded && this._queue.empty()) {
        if (!(await this.waitBotTranscribed(deadline - monotonic()))) {
          throw new TimeoutError();
        }
        // A transcription that yields text queues its event as it closes.
        if (this._queue.empty()) {
          throw new EvalBotEndedError();
        }
      }
      const event = await this.nextAny(deadline);
      this._turnLog.push(event);
      if (wanted(event)) {
        this._claimed.add(this._turnLog.length - 1);
        return event;
      }
    }
  }

  /**
   * Drop the bot's queued output, so a later turn cannot match it.
   *
   * A queued `user_transcription` stays: a DTMF keypress reports its
   * transcription just before the turn starts, and that is the turn's input,
   * not stale bot output. `eventsSeen` and `latestEventTimes` are left as
   * they are.
   *
   * @param why What prompted the drop, for the trace.
   */
  dropPendingBotOutput(why: string): void {
    this._textBuffer = [];
    const preserved: EvalEvent[] = [];
    let dropped = 0;
    while (!this._queue.empty()) {
      let event: EvalEvent;
      try {
        event = this._queue.getNowait();
      } catch (e) {
        if (e instanceof QueueEmpty) break;
        throw e;
      }
      if (event.type === "user_transcription") {
        preserved.push(event);
      } else {
        dropped += 1;
      }
    }
    for (const event of preserved) {
      this._queue.putNowait(event);
    }
    if (dropped) {
      this._trace.log(`discard: dropped ${dropped} queued event(s) ${why}`);
    }
  }

  /** Seconds since the stream began, the clock the events' `at` is on. */
  elapsed(): number {
    // Python's `round(x, 3)`.
    return Number((monotonic() - this._t0).toFixed(3));
  }

  /** Note activity that makes no event, so a lull is measured from it. */
  touch(): void {
    this.lastActivity = monotonic();
  }

  /**
   * Translate one frame from the bot into the event it maps to, if any.
   *
   * The LLM text is buffered and emitted as one `llm_response` when the
   * response ends; a marker is its own `llm_marker` as soon as it
   * arrives; `tts_response` is emitted only in audio mode; the bot's
   * reports about the harness (its VAD, speaking, and transcription messages)
   * become their events. The audio-mode `response` is not made here: the
   * aggregator appends it when the bot's spoken turn ends.
   *
   * @param frame A frame the bot-facing transport produced.
   * @returns The event the frame maps to, or `null`; most frames map to none.
   */
  frameToEvent(frame: Frame): EvalEvent | null {
    this.touch();
    if (frame instanceof InputTransportMessageFrame) {
      const event = this._messageToEvent(frame.message);
      if (event !== null && _INTERRUPTION_EVENTS.includes(event.type)) {
        this._interrupted();
      }
      return event;
    } else if (frame instanceof LLMFullResponseStartFrame) {
      this._awaitingReply = false;
      this._textBuffer = [];
      this._llmTextAt = null;
      return { type: "llm_started" };
    } else if (frame instanceof LLMTextFrame) {
      if (this._awaitingReply) {
        return null;
      }
      if (this._textBuffer.length === 0) {
        this._llmTextAt = this.elapsed();
      }
      this._textBuffer.push(frame.text);
      return null;
    } else if (frame instanceof LLMMarkerResponseFrame) {
      if (this._awaitingReply) {
        return null;
      }
      return {
        type: "llm_marker",
        text: frame.marker || "",
        kind: frame.kind,
        raw: frame.raw,
        markers: [...frame.markers],
      };
    } else if (frame instanceof LLMFullResponseEndFrame) {
      if (this._awaitingReply) {
        this._textBuffer = [];
        return null;
      }
      const event = this._segmentEvent("llm_response", this._textBuffer.join(""));
      if (this._llmTextAt !== null) {
        event.started_at = this._llmTextAt;
      }
      return event;
    } else if (frame instanceof TTSTextFrame) {
      if (this._botAudio) {
        return this._segmentEvent("tts_response", frame.text);
      }
      return null;
    } else if (frame instanceof BotStartedSpeakingFrame) {
      this._botQuiet.clear();
      if (this._talkedOverUntil === Number.POSITIVE_INFINITY) {
        this._talkedOverUntil = monotonic();
      }
      if (this._observing) {
        this._observing = false;
        this._awaitingReply = false;
      }
      return { type: "bot_started_speaking" };
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      this._botQuiet.set();
      return { type: "bot_stopped_speaking" };
    } else if (
      frame instanceof FunctionCallInProgressFrame ||
      frame instanceof ExternalFunctionCallInProgressFrame
    ) {
      const args = or(frame.arguments, {});
      return {
        type: "function_call",
        name: frame.functionName || null,
        args: isDict(args) ? { ...args } : args,
      };
    } else if (frame instanceof ExternalFunctionCallResultFrame && !frame.isFinal) {
      return null;
    } else if (
      frame instanceof FunctionCallResultFrame ||
      frame instanceof FunctionCallCancelFrame ||
      frame instanceof ExternalFunctionCallResultFrame ||
      frame instanceof ExternalFunctionCallCancelFrame
    ) {
      // How the call ended is the assertable part, so `cancelled` sits in
      // `args` alongside the id: a scenario matches both through the same
      // `calls:`/`args:` check a function_call uses.
      return {
        type: "function_call_stopped",
        name: frame.functionName || null,
        args: {
          tool_call_id: frame.toolCallId,
          cancelled:
            frame instanceof FunctionCallCancelFrame ||
            frame instanceof ExternalFunctionCallCancelFrame,
        },
      };
    }
    return null;
  }

  /** Monotonic time of the user's latest send; bot speech from before it is not the reply. */
  get inputSentAt(): number {
    return this._inputSentAt;
  }

  /**
   * Append the bot's finished spoken turn as a `response`, unless it is stale.
   *
   * Speech the bot was saying when a send talked over it never reaches a
   * turn (the client drops it by its audio's time). A turn is still stale while the
   * bot's LLM has not restarted since the send: the bot going on with what
   * it was saying, which must not pass for the reply.
   *
   * @param text The turn's transcription; nothing is appended when empty.
   */
  async botTurnStopped(text: string): Promise<void> {
    this._botTurnOpen = false;
    this._updateBotTranscribed();
    if (!text) {
      return;
    }
    if (this._awaitingReply) {
      this._trace.log(`discard: bot turn from before the reply ${pyStrRepr(text)}`);
      return;
    }
    await this.append({ type: "response", text });
  }

  /** Mark the user's input as sent: the bot's reply is what it says from now on. */
  inputSent(): void {
    this.turnBoundary();
  }

  /**
   * Start a new turn: only what the bot says from now on belongs to it.
   *
   * When the bot is speaking at this point, the turn talks over it, and what
   * the bot says until it starts speaking again, however late its
   * transcription lands, is the previous turn's and is discarded.
   */
  turnBoundary(): void {
    this._awaitingReply = true;
    this._inputSentAt = monotonic();
    this._talkedOverUntil = this.botSpeaking ? Number.POSITIVE_INFINITY : null;
    this._observing = false;
  }

  /**
   * Start a turn that sends nothing: what the bot says next belongs to it.
   *
   * What the bot says until it starts speaking again, however late its
   * transcription lands, is the previous turn's and is discarded. What it
   * says from then on is the turn's, even when its LLM did not produce it.
   */
  observingBoundary(): void {
    this.turnBoundary();
    this._talkedOverUntil = Number.POSITIVE_INFINITY;
    this._observing = true;
  }

  /** The bot reported an interruption: drop its pending output and wait for a fresh reply. */
  protected _interrupted(): void {
    this.dropPendingBotOutput("on interruption");
    this._awaitingReply = true;
    this._botQuiet.set();
  }

  /** Map one of the bot's reports about the harness to its event, if any. */
  protected _messageToEvent(message: unknown): EvalEvent | null {
    if (!isDict(message)) {
      return null;
    }
    const msgType = get(message, "type");
    const data = or(get(message, "data"), {}) as Dict;
    if (msgType === "user-started-speaking") {
      return { type: "user_started_speaking" };
    } else if (msgType === "bot-interrupted") {
      return { type: "bot_interrupted" };
    } else if (msgType === "user-stopped-speaking") {
      return { type: "user_stopped_speaking" };
    } else if (msgType === "vad-user-started-speaking") {
      return { type: "vad_user_started_speaking" };
    } else if (msgType === "vad-user-stopped-speaking") {
      return { type: "vad_user_stopped_speaking" };
    } else if (msgType === "bot-output") {
      return this._botBackchannelEvent(data);
    } else if (msgType === "user-input") {
      return this._userInputEvent(data);
    } else if (msgType === EVAL_BOT_IMAGE_TYPE) {
      return {
        type: "image",
        width: get(data, "width"),
        height: get(data, "height"),
        format: get(data, "format"),
      };
    }
    return null;
  }

  /** The user's final transcription or backchannel, from a `user-input`. */
  protected _userInputEvent(data: Dict): EvalEvent | null {
    const inputType = get(data, "input_type");
    if (inputType === "transcription" && truthy(get(data, "final"))) {
      return { type: "user_transcription", transcript: get(data, "text", "") };
    } else if (inputType === "backchannel") {
      return { type: "user_backchannel", text: get(data, "text", "") };
    }
    return null;
  }

  /** The bot's backchannel, from the `bot-output` reporting it was spoken to the end. */
  protected _botBackchannelEvent(data: Dict): EvalEvent | null {
    if (get(data, "text_type") !== "backchannel" || get(data, "spoken_status") !== "completed") {
      return null;
    }
    const progress = or(get(data, "spoken_progress"), {}) as Dict;
    return {
      type: "bot_backchannel",
      text: or(get(progress, "accumulated_text"), get(data, "text", "")),
    };
  }

  /** One response segment; the text may be empty, as after an interruption. */
  protected _segmentEvent(eventType: string, text: string): EvalEvent {
    return { type: eventType, text };
  }
}
