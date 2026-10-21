// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/client_transport.py

/**
 * The harness's WebSocket transport and recorder.
 *
 * A live transport carries continuous audio both ways, speech or silence,
 * and VADs, turn detection, and streaming STT rely on that cadence. The eval
 * bot sends and receives audio only while a TTS produces it, so both edges
 * here reshape it: the output paces the user's audio to the bot one 40 ms
 * frame per tick, silence in between, and the input re-emits the bot's audio
 * at the same cadence, filling its gaps, so the harness's VAD finds the
 * bot's real turn ends.
 *
 * The recording does not use the paced streams, whose jitter would make it
 * stutter: `EvalClientRecorder` is fed the raw audio on both edges and
 * lays each side out on its own timeline.
 */

import { monotonic, sleep, type Task } from "@pipedog/asyncio";
import { createStreamResampler, mixAudio, pcmToWav } from "@pipedog/core/audio/utils";
import {
  type CancelFrame,
  type EndFrame,
  type Frame,
  InputAudioRawFrame,
  InputTransportMessageFrame,
  InterruptionFrame,
  OutputAudioRawFrame,
  type StartFrame,
} from "@pipedog/core/frames/frames";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import type { BaseTransport } from "@pipedog/core/transports/base_transport";
import {
  WebsocketClientInputTransport,
  WebsocketClientOutputTransport,
  type WebsocketClientParams,
  type WebsocketClientSession,
} from "@pipedog/transport-websocket/client";
import { RTVIClientTransport } from "@pipedog/transport-websocket/rtvi_client";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";
import { EvalConnectionFlags, evalConnectMessage } from "./serializer.ts";

// One audio frame per tick, on both edges. 40ms matches the bot's output chunking
// (`audio_out_10ms_chunks` defaults to 4), so the receive side re-emits the bot's
// chunks 1:1 rather than splitting them, and it's still fine-grained enough for the
// VAD/turn models (well under their start/stop windows).
export const FRAME_S = 0.04;

/**
 * Sleep to the next tick and return the one after.
 *
 * When the loop has fallen behind, the next tick is measured from now rather
 * than firing a burst of catch-up frames, which would compress the audio.
 */
async function _sleepToNextTick(nextSend: number): Promise<number> {
  const sleepS = Math.max(0.0, nextSend - monotonic());
  await sleep(sleepS);
  return sleepS === 0 ? monotonic() + FRAME_S : nextSend + FRAME_S;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Take one `chunk`-byte frame off the front of `buffer`: a full chunk, the
 * final partial chunk padded with silence, or silence when it is empty.
 * Returns the frame and what is left of the buffer.
 */
function takeChunk(buffer: Uint8Array, chunk: number): [Uint8Array, Uint8Array] {
  if (buffer.length >= chunk) {
    return [buffer.slice(0, chunk), buffer.slice(chunk)];
  }
  // Pad the utterance's final partial chunk to a full frame (or all silence).
  const pcm = new Uint8Array(chunk);
  pcm.set(buffer, 0);
  return [pcm, new Uint8Array(0)];
}

/**
 * Builds the conversation recording from the raw audio, not the paced streams.
 *
 * The 40 ms pacing tick cannot be held precisely, and a recording of the
 * paced streams stutters. So each side is recorded as it was produced or
 * received, laid out on its own timeline with silence only where a real
 * pause was, and mixed to mono at `write`. Audio the bot sent past an
 * interruption is dropped, as a real client would drop it.
 */
export class EvalClientRecorder {
  // A chunk arriving later than its side's playout position by more than this
  // is a real pause between turns; anything shorter is jitter within a
  // contiguous turn and stays gapless.
  static GAP_S = 0.2;

  protected _rate: number;
  _user: _RecorderTrack;
  _bot: _RecorderTrack;

  /**
   * Initialize the recorder.
   *
   * @param sampleRate Output sample rate; both sides are resampled to it on write.
   */
  constructor(sampleRate: number) {
    this._rate = sampleRate;
    this._user = new _RecorderTrack();
    this._bot = new _RecorderTrack();
  }

  /** Record a chunk of the user's TTS audio (raw, before pacing to the bot). */
  addUser(audio: Uint8Array, inRate: number): void {
    this._user.add(audio, inRate);
  }

  /** Record a chunk of the bot's audio (raw, before the gap-fill loop). */
  addBot(audio: Uint8Array, inRate: number): void {
    this._bot.add(audio, inRate);
  }

  /** Drop the last `numBytes` of the bot's audio: sent, but never played. */
  dropBotTail(numBytes: number): void {
    this._bot.dropTail(numBytes);
  }

  /** Drop the last `numBytes` of the user's audio: synthesized, but never sent. */
  dropUserTail(numBytes: number): void {
    this._user.dropTail(numBytes);
  }

  /** Whether any audio has been recorded on either side. */
  hasAudio(): boolean {
    return this._user.first !== null || this._bot.first !== null;
  }

  /**
   * Resample both sides to a common rate, align, mix to mono, and write a WAV.
   *
   * @returns True if a file was written, false if nothing was recorded.
   */
  async write(path: string): Promise<boolean> {
    const firsts = [this._user, this._bot]
      .map((t) => t.first)
      .filter((first): first is number => first !== null);
    if (firsts.length === 0) {
      return false;
    }
    const start = Math.min(...firsts);
    const user = await this._user.rendered(this._rate, start);
    const bot = await this._bot.rendered(this._rate, start);
    const mixed = mixAudio(user, bot);
    // Upstream writes the file with `wave` (mono, 16-bit) after creating its
    // parent directories.
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, pcmToWav(mixed, this._rate, 1));
    return true;
  }
}

/** Options for {@link _RecorderTrack}. */
export interface RecorderTrackOptions {
  /**
   * The clock chunks are stamped with, in seconds. Defaults to `monotonic`.
   * (Upstream's tests patch the module's `time`; here the clock is injected.)
   */
  clock?: () => number;
}

/**
 * One side of the recording: raw audio chunks and when each arrived.
 *
 * Chunks are laid out back to back. Silence is inserted only when a chunk
 * arrives later than the playout position by more than the gap threshold,
 * since within a turn both sources run ahead of real time.
 */
export class _RecorderTrack {
  _chunks: [number, Uint8Array][] = [];
  protected _rate: number | null = null;
  protected _clock: () => number;

  constructor(options: RecorderTrackOptions = {}) {
    this._clock = options.clock ?? monotonic;
  }

  /** When the first chunk arrived, or `null` before any audio. */
  get first(): number | null {
    return this._chunks.length > 0 ? this._chunks[0]![0] : null;
  }

  /** Record a raw audio chunk as of now. */
  add(audio: Uint8Array, inRate: number): void {
    if (audio.length === 0) {
      return;
    }
    this._rate = inRate;
    this._chunks.push([this._clock(), audio]);
  }

  /** Remove the last `numBytes` of audio, across as many chunks as it spans. */
  dropTail(numBytes: number): void {
    while (numBytes > 0 && this._chunks.length > 0) {
      const [arrived, chunk] = this._chunks[this._chunks.length - 1]!;
      if (chunk.length <= numBytes) {
        this._chunks.pop();
        numBytes -= chunk.length;
      } else {
        this._chunks[this._chunks.length - 1] = [
          arrived,
          chunk.subarray(0, chunk.length - numBytes),
        ];
        numBytes = 0;
      }
    }
  }

  /** Lay the track out, resample to `outRate`, and prepend its silence since `start`. */
  async rendered(outRate: number, start: number): Promise<Uint8Array> {
    const first = this.first;
    if (first === null || this._rate === null) {
      return new Uint8Array(0);
    }
    let audio = this._layout();
    if (this._rate !== outRate) {
      audio = await createStreamResampler().resample(audio, this._rate, outRate);
    }
    const lead = Math.trunc((first - start) * outRate * 2) & ~1;
    return concat(new Uint8Array(Math.max(0, lead)), audio);
  }

  /** Concatenate the chunks, with silence for each real pause. */
  protected _layout(): Uint8Array {
    const rate = this._rate!;
    const parts: Uint8Array[] = [];
    let position = this._chunks[0]![0]; // playout position, as a wall-clock time
    for (const [arrived, chunk] of this._chunks) {
      const late = arrived - position;
      if (late > EvalClientRecorder.GAP_S) {
        parts.push(new Uint8Array(Math.trunc(late * rate * 2) & ~1));
        position = arrived;
      } else if (late > 0) {
        position = arrived;
      }
      parts.push(chunk);
      position += chunk.length / (rate * 2);
    }
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

/** Options for the eval client input and output transports. */
export interface EvalClientEdgeOptions {
  /** Recorder fed the raw audio of this edge; `null` disables recording. */
  recorder?: EvalClientRecorder | null;
}

/**
 * Streams the user's audio to the bot as a continuous real-time stream.
 *
 * A real-time task sends one 40 ms frame per tick: queued TTS audio when
 * there is some, silence otherwise, so the bot's VAD and turn detection see
 * the silence they need to end a turn. Runs only when audio output is on.
 */
export class EvalClientOutputTransport extends WebsocketClientOutputTransport {
  _pending: Uint8Array = new Uint8Array(0);
  protected _sendTask: Task<unknown> | null = null;
  protected _recorder: EvalClientRecorder | null;

  /** Initialize the transport and its (lazily started) send stream. */
  constructor(
    transport: BaseTransport,
    session: WebsocketClientSession,
    params: WebsocketClientParams,
    options: EvalClientEdgeOptions = {},
  ) {
    super(transport, session, params);
    this._recorder = options.recorder ?? null;
  }

  /** Start the transport and, in audio mode, the real-time send stream. */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    if (this._params.audioOutEnabled && this._sendTask === null) {
      this._sendTask = this.createTask(() => this._sendTaskHandler());
    }
  }

  /** Stop the send stream, then the transport. */
  override async stop(frame: EndFrame): Promise<void> {
    await this._cancelSendTask();
    await super.stop(frame);
  }

  /** Cancel the send stream, then the transport. */
  override async cancel(frame: CancelFrame): Promise<void> {
    await this._cancelSendTask();
    await super.cancel(frame);
  }

  /** Pass a frame on; an interruption drops the user audio not yet sent, and the recorder drops the same bytes. */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    if (frame instanceof InterruptionFrame && this._pending.length > 0) {
      if (this._recorder !== null) {
        this._recorder.dropUserTail(this._pending.length);
      }
      this._pending = new Uint8Array(0);
    }
    await super.processFrame(frame, direction);
  }

  /**
   * Queue the user audio for the send task.
   *
   * Returns false so the media sender does not push this un-paced frame
   * downstream; the send task pushes the paced frames instead.
   */
  override async writeAudioFrame(frame: OutputAudioRawFrame): Promise<boolean> {
    if (this._session.isClosing || !this._session.isConnected) {
      return false;
    }
    // Record the raw TTS audio here (gapless), not the paced frames the send
    // task emits: pacing underruns/jitter would stutter the recording.
    if (this._recorder !== null) {
      this._recorder.addUser(frame.audio, frame.sampleRate);
    }
    this._pending = concat(this._pending, frame.audio);
    return false;
  }

  /** Send one ~40ms frame every tick: queued audio, or silence when idle. */
  async _sendTaskHandler(): Promise<void> {
    const chunk = Math.trunc(this.sampleRate * FRAME_S) * 2; // 16-bit mono
    let nextSend = monotonic();
    while (true) {
      const [pcm, rest] = takeChunk(this._pending, chunk);
      this._pending = rest;
      const frame = new OutputAudioRawFrame({
        audio: pcm,
        sampleRate: this.sampleRate,
        numChannels: this._params.audioOutChannels,
      });
      await this._sendFrame(frame);
      // Push every frame (audio and silence) downstream at this paced cadence:
      // the harness recorder aligns tracks by wall-clock, so a continuous
      // stream keeps the user turn at the right time (pushing only audio would
      // leave the track idle and the recorder would misplace it).
      await this.pushFrame(frame);
      nextSend = await _sleepToNextTick(nextSend);
    }
  }

  /** Serialize and send one frame (raw PCM, via the RTVI serializer). */
  async _sendFrame(frame: OutputAudioRawFrame): Promise<void> {
    if (this._session.isClosing || !this._session.isConnected) {
      return;
    }
    await this._writeFrame(frame);
  }

  protected async _cancelSendTask(): Promise<void> {
    if (this._sendTask !== null) {
      await this.cancelTask(this._sendTask);
      this._sendTask = null;
    }
  }
}

/**
 * Feeds the bot's audio to the harness's VAD and STT as a continuous stream.
 *
 * The bot sends audio only while its TTS produces it, with gaps at its
 * pauses. A gap reads as silence to a VAD, which would end the bot's turn
 * mid-sentence, so the audio is buffered and re-emitted one 40 ms frame per
 * tick, silence filling the gaps.
 */
export class EvalClientInputTransport extends WebsocketClientInputTransport {
  _botPcm: Uint8Array = new Uint8Array(0);
  protected _fillTask: Task<unknown> | null = null;
  protected _recorder: EvalClientRecorder | null;

  /** Initialize the transport and its (lazily started) fill stream. */
  constructor(
    transport: BaseTransport,
    session: WebsocketClientSession,
    params: WebsocketClientParams,
    options: EvalClientEdgeOptions = {},
  ) {
    super(transport, session, params);
    this._recorder = options.recorder ?? null;
  }

  /** Start the transport and, when audio is enabled, the gap-fill stream. */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    if (this._params.audioInEnabled && this._fillTask === null) {
      this._fillTask = this.createTask(() => this._fillTaskHandler());
    }
  }

  /** Stop the fill stream, then the transport. */
  override async stop(frame: EndFrame): Promise<void> {
    await this._cancelFillTask();
    await super.stop(frame);
  }

  /** Cancel the fill stream, then the transport. */
  override async cancel(frame: CancelFrame): Promise<void> {
    await this._cancelFillTask();
    await super.cancel(frame);
  }

  /** Push a frame on; when the bot reports an interruption, the audio it sent but a client would never play is dropped, and the recorder drops the same bytes. */
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    if (
      direction === FrameDirection.DOWNSTREAM &&
      frame instanceof InputTransportMessageFrame &&
      typeof frame.message === "object" &&
      frame.message !== null &&
      !Array.isArray(frame.message) &&
      (frame.message as Record<string, unknown>).type === "bot-interrupted"
    ) {
      if (this._recorder !== null) {
        this._recorder.dropBotTail(this._botPcm.length);
      }
      this._botPcm = new Uint8Array(0);
    }
    await super.pushFrame(frame, direction);
  }

  /** Buffer the bot's audio for the fill task. */
  override async pushAudioFrame(frame: InputAudioRawFrame): Promise<void> {
    // Record the raw bot audio here (gapless within a turn), not the gap-filled
    // frames the fill task emits: those underruns would stutter the recording.
    if (this._recorder !== null) {
      this._recorder.addBot(frame.audio, frame.sampleRate);
    }
    this._botPcm = concat(this._botPcm, frame.audio);
  }

  /** Push one ~40ms frame every tick: buffered bot audio, or silence. */
  protected async _fillTaskHandler(): Promise<void> {
    const chunk = Math.trunc(this.sampleRate * FRAME_S) * 2; // 16-bit mono
    let nextSend = monotonic();
    while (true) {
      const [pcm, rest] = takeChunk(this._botPcm, chunk);
      this._botPcm = rest;
      // super pushes through the normal input audio path (VAD/STT).
      await super.pushAudioFrame(
        new InputAudioRawFrame({ audio: pcm, sampleRate: this.sampleRate, numChannels: 1 }),
      );
      nextSend = await _sleepToNextTick(nextSend);
    }
  }

  protected async _cancelFillTask(): Promise<void> {
    if (this._fillTask !== null) {
      await this.cancelTask(this._fillTask);
      this._fillTask = null;
    }
  }
}

/** Options for {@link EvalClientTransport}. */
export interface EvalClientTransportOptions {
  /** The connection's flags, sent first on connect; `null` sends the defaults. */
  flags?: EvalConnectionFlags | null;
  /** Optional recorder fed the raw audio on both edges; `null` disables recording. */
  recorder?: EvalClientRecorder | null;
}

/**
 * The harness's RTVI client transport, with audio edges that behave like a live transport.
 *
 * The input fills the gaps in the bot's audio and the output paces the
 * user's; both feed the recorder the raw audio when one is given. On connect
 * it sends the connection's flags in an `eval-connect` message, ahead of
 * the RTVI handshake.
 */
export class EvalClientTransport extends RTVIClientTransport {
  protected _flags: EvalConnectionFlags;
  protected _recorder: EvalClientRecorder | null;

  /**
   * Initialize the transport, optionally wiring a recorder to both edges.
   *
   * @param uri The WebSocket URI of the bot's eval transport.
   * @param params Optional transport parameters (see `RTVIClientTransport`).
   * @param options.flags The connection's flags, sent first on connect; `null`
   *   sends the defaults.
   * @param options.recorder Optional `EvalClientRecorder` fed the raw audio on
   *   both edges; `null` disables recording.
   */
  constructor(
    uri: string,
    params: WebsocketClientParams | null = null,
    options: EvalClientTransportOptions = {},
  ) {
    super(uri, params);
    this._flags = options.flags ?? new EvalConnectionFlags();
    this._recorder = options.recorder ?? null;
  }

  /** Send `eval-connect` first, then fire the user's handler and start the handshake. */
  protected override async _onConnected(websocket: WebsocketConnection): Promise<void> {
    await this._session.send(evalConnectMessage(this._flags));
    await super._onConnected(websocket);
  }

  /** Return the gap-filling input transport. */
  override input(): EvalClientInputTransport {
    if (!this._input) {
      this._input = new EvalClientInputTransport(this, this._session, this._params, {
        recorder: this._recorder,
      });
    }
    return this._input as EvalClientInputTransport;
  }

  /** Return the stream-shaping output transport. */
  override output(): EvalClientOutputTransport {
    if (!this._output) {
      this._output = new EvalClientOutputTransport(this, this._session, this._params, {
        recorder: this._recorder,
      });
    }
    return this._output as EvalClientOutputTransport;
  }
}
