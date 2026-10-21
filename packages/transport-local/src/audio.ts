// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/local/audio.py

/**
 * Local audio transport implementation for Pipecat.
 *
 * This module provides a local audio transport for real-time audio input and
 * output through the system's default audio devices.
 *
 * PORTING NOTES:
 * - DIVERGENCE: upstream uses PyAudio (PortAudio, a native library). Here the transport
 *   spawns `sox` or `ffmpeg` (see `audio_tools.ts`) and pipes raw 16-bit PCM through the
 *   child's stdin and stdout, so there is no native addon. Runtimes: Node, Bun and Deno.
 *   Cloudflare Workers cannot start processes. With neither tool installed `setup()` throws
 *   `LocalAudioToolNotFoundError`, which says what to install.
 * - `PyAudio` (the shared device handle) becomes `LocalAudioBackend`: it finds the tool once and
 *   starts the processes, for both directions.
 * - `input_device_index` / `output_device_index` (PortAudio indices) become `inputDevice` /
 *   `outputDevice`: a device name or index in the selected tool's terms (see `AudioStreamSpec`).
 *   `tool` (sox, ffmpeg or auto) and `spawner` are new.
 * - The recorder or player starts in `start()` (upstream opens the stream in `setup()` and starts
 *   it in `start()`): a process has no "open but stopped" state.
 * - `ThreadPoolExecutor` is gone. The pipe's backpressure paces writes, and, like the other
 *   non-blocking output transports, `writeAudioFrame` sleeps to the audio's duration so the
 *   player is never more than a chunk ahead (interruptions stay quick).
 */

import { abortable, monotonic, rethrowIfCancelled, sleep, type Task } from "@pipedog/asyncio";
import {
  type CancelFrame,
  type Frame,
  InputAudioRawFrame,
  InterruptionFrame,
  type OutputAudioRawFrame,
  type StartFrame,
} from "@pipedog/core/frames/frames";
import type {
  FrameDirection,
  FrameProcessor,
  FrameProcessorSetup,
} from "@pipedog/core/processors/frame_processor";
import { BaseInputTransport } from "@pipedog/core/transports/base_input";
import { BaseOutputTransport } from "@pipedog/core/transports/base_output";
import {
  BaseTransport,
  TransportParams,
  type TransportParamsOptions,
} from "@pipedog/core/transports/base_transport";
import { logger } from "@pipedog/core/utils/logger";
import {
  type AudioTool,
  type AudioToolChoice,
  detectAudioTool,
  playCommand,
  recordCommand,
} from "./audio_tools.ts";
import { defaultSpawner, type ProcessSpawner, type SpawnedProcess } from "./process.ts";

export interface LocalAudioTransportParamsOptions extends TransportParamsOptions {
  /** The input (microphone) device, in the selected tool's terms. Default: the system default. */
  inputDevice?: string | number | null;
  /** The output (speakers) device, in the selected tool's terms. Default: the system default. */
  outputDevice?: string | number | null;
  /** The tool to run: "sox", "ffmpeg", or "auto" (default: sox, else ffmpeg). */
  tool?: AudioToolChoice;
  /** How to start processes (default: the runtime's own: Bun.spawn, Deno.Command, child_process). */
  spawner?: ProcessSpawner | null;
}

/**
 * Configuration parameters for local audio transport.
 *
 * - `inputDevice`: device for audio input. If null, uses the default.
 * - `outputDevice`: device for audio output. If null, uses the default.
 * - `tool`: "sox", "ffmpeg" or "auto".
 */
export class LocalAudioTransportParams extends TransportParams {
  inputDevice: string | number | null;
  outputDevice: string | number | null;
  tool: AudioToolChoice;
  spawner: ProcessSpawner | null;

  constructor(options: LocalAudioTransportParamsOptions = {}) {
    super(options);
    this.inputDevice = options.inputDevice ?? null;
    this.outputDevice = options.outputDevice ?? null;
    this.tool = options.tool ?? "auto";
    this.spawner = options.spawner ?? null;
  }
}

/**
 * The shared handle for the audio tool (what `pyaudio.PyAudio` is upstream): finds `sox` or
 * `ffmpeg` once and starts the recorder and player processes.
 */
export class LocalAudioBackend {
  protected _params: LocalAudioTransportParams;
  protected _spawner: ProcessSpawner | null;
  protected _tool: Promise<AudioTool> | null = null;
  protected _processes = new Set<SpawnedProcess>();

  constructor(params: LocalAudioTransportParams) {
    this._params = params;
    this._spawner = params.spawner;
  }

  protected get spawner(): ProcessSpawner {
    this._spawner ??= defaultSpawner();
    return this._spawner;
  }

  /**
   * The tool to use, found on first call.
   *
   * @throws LocalAudioToolNotFoundError If it is not installed.
   */
  resolveTool(): Promise<AudioTool> {
    this._tool ??= detectAudioTool({ tool: this._params.tool, spawner: this.spawner });
    // A failed lookup is retried by the next call.
    this._tool.catch(() => {
      this._tool = null;
    });
    return this._tool;
  }

  /** Start the recorder: its stdout is raw 16-bit PCM. */
  async startRecorder(tool: AudioTool, sampleRate: number, channels: number) {
    const cmd = recordCommand(tool, {
      sampleRate,
      channels,
      device: this._params.inputDevice,
    });
    return this.#spawn(cmd, { stdin: false, stdout: true });
  }

  /** Start the player: raw 16-bit PCM written to its stdin comes out of the speakers. */
  async startPlayer(tool: AudioTool, sampleRate: number, channels: number) {
    const cmd = playCommand(tool, {
      sampleRate,
      channels,
      device: this._params.outputDevice,
    });
    return this.#spawn(cmd, { stdin: true, stdout: false });
  }

  async #spawn(
    cmd: string[],
    options: { stdin: boolean; stdout: boolean },
  ): Promise<SpawnedProcess> {
    logger.debug(`Local audio: starting ${cmd.join(" ")}`);
    const proc = await this.spawner(cmd, options);
    this._processes.add(proc);
    void proc.exited.then(() => this._processes.delete(proc));
    return proc;
  }

  /** Stop one process (closing its stdin first, so a player can drain). */
  async stop(proc: SpawnedProcess): Promise<void> {
    proc.kill();
    this._processes.delete(proc);
  }

  /** Kill every process still running (`PyAudio.terminate()`). */
  terminate(): void {
    for (const proc of this._processes) proc.kill();
    this._processes.clear();
  }
}

/**
 * Local audio input transport using sox or ffmpeg.
 *
 * Captures audio from the system's audio input device and converts it to
 * InputAudioRawFrame objects for processing in the pipeline.
 */
export class LocalAudioInputTransport extends BaseInputTransport {
  declare protected _params: LocalAudioTransportParams;
  protected _backend: LocalAudioBackend;
  protected _tool: AudioTool | null = null;
  protected _proc: SpawnedProcess | null = null;
  protected _readTask: Task<unknown> | null = null;

  /**
   * Initialize the local audio input transport.
   *
   * @param backend The audio backend for device management.
   * @param params Transport configuration parameters.
   */
  constructor(backend: LocalAudioBackend, params: LocalAudioTransportParams) {
    super(params);
    this._backend = backend;
    this._params = params;
  }

  /**
   * Set up the transport and find the audio tool.
   *
   * @param setup Configuration object containing setup parameters.
   * @throws LocalAudioToolNotFoundError If neither sox nor ffmpeg is installed.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._tool = await this._backend.resolveTool();
  }

  /** Stop and cleanup the audio input stream. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._stopRecording();
  }

  /**
   * Start the audio input stream.
   *
   * @param frame The start frame containing initialization parameters.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);

    if (!this._tool) return;
    this._proc = await this._backend.startRecorder(
      this._tool,
      this.sampleRate,
      this._params.audioInChannels,
    );
    this._readTask = this.createTask(
      () => this._readLoop(this._proc as SpawnedProcess),
      "audio_in",
    );
    await this.setTransportReady(frame);
  }

  /** Cancel the input transport and stop recording. */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._stopRecording();
  }

  protected async _stopRecording(): Promise<void> {
    const proc = this._proc;
    this._proc = null;
    if (proc) await this._backend.stop(proc);
    if (this._readTask) {
      const task = this._readTask;
      this._readTask = null;
      await this.cancelTask(task);
    }
  }

  /** Cut the recorder's output into 20ms frames and push them (upstream's PyAudio callback). */
  protected async _readLoop(proc: SpawnedProcess): Promise<void> {
    if (!proc.stdout) return;
    // 20ms of 16-bit audio: `num_frames` upstream.
    const channels = this._params.audioInChannels;
    const chunkBytes = Math.trunc(this.sampleRate / 100) * 2 * channels * 2;
    let pending = new Uint8Array(0);
    try {
      const iterator = proc.stdout[Symbol.asyncIterator]();
      while (true) {
        const next = await abortable(iterator.next());
        if (next.done) break;
        const joined = new Uint8Array(pending.length + next.value.length);
        joined.set(pending);
        joined.set(next.value, pending.length);
        let offset = 0;
        while (joined.length - offset >= chunkBytes) {
          const frame = new InputAudioRawFrame({
            audio: joined.slice(offset, offset + chunkBytes),
            sampleRate: this.sampleRate,
            numChannels: channels,
          });
          offset += chunkBytes;
          await this.pushAudioFrame(frame);
        }
        pending = joined.slice(offset);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this}: reading the microphone failed: ${e}`);
    }
    if (this._proc === proc) {
      // The recorder ended on its own.
      const code = await proc.exited;
      const detail = proc.stderrTail().trim();
      await this.pushError(
        `The audio recorder (${this._tool}) exited${code === null ? "" : ` with code ${code}`}${detail ? `: ${detail}` : ""}`,
      );
    }
  }
}

/**
 * Local audio output transport using sox or ffmpeg.
 *
 * Plays audio frames through the system's audio output device by converting
 * OutputAudioRawFrame objects to playable audio data.
 */
export class LocalAudioOutputTransport extends BaseOutputTransport {
  declare protected _params: LocalAudioTransportParams;
  protected _backend: LocalAudioBackend;
  protected _tool: AudioTool | null = null;
  protected _proc: SpawnedProcess | null = null;

  // Audio is written ahead of what has played by one chunk at most, like a blocking
  // device write: the send interval is a chunk's duration.
  protected _sendInterval = 0;
  protected _nextSendTime = 0;

  /**
   * Initialize the local audio output transport.
   *
   * @param backend The audio backend for device management.
   * @param params Transport configuration parameters.
   */
  constructor(backend: LocalAudioBackend, params: LocalAudioTransportParams) {
    super(params);
    this._backend = backend;
    this._params = params;
  }

  /**
   * Set up the transport and find the audio tool.
   *
   * @param setup Configuration object containing setup parameters.
   * @throws LocalAudioToolNotFoundError If neither sox nor ffmpeg is installed.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._tool = await this._backend.resolveTool();
    this._sendInterval =
      this.audioChunkSize / (this.sampleRate * 2 * this._params.audioOutChannels);
  }

  /** Stop and cleanup the audio output stream. */
  override async cleanup(): Promise<void> {
    try {
      await super.cleanup();
      await this._stopPlayback();
    } finally {
      this._backend.terminate();
    }
  }

  /**
   * Start the audio output stream.
   *
   * @param frame The start frame containing initialization parameters.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);

    if (!this._tool) return;
    this._proc = await this._backend.startPlayer(
      this._tool,
      this.sampleRate,
      this._params.audioOutChannels,
    );
    await this.setTransportReady(frame);
  }

  /** Cancel the output transport and stop playback. */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._stopPlayback();
  }

  protected async _stopPlayback(): Promise<void> {
    const proc = this._proc;
    this._proc = null;
    if (proc) await this._backend.stop(proc);
  }

  /** Reset the playback clock on interruption. */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof InterruptionFrame) this._nextSendTime = 0;
  }

  /**
   * Write an audio frame to the output stream.
   *
   * @param frame The audio frame to write to the output device.
   * @returns True if the audio frame was written successfully, False otherwise.
   */
  override async writeAudioFrame(frame: OutputAudioRawFrame): Promise<boolean> {
    const proc = this._proc;
    if (!proc) return false;
    try {
      await abortable(proc.write(frame.audio));
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this}: writing to the audio player failed: ${e}`);
      return false;
    }
    await this._writeAudioSleep();
    return true;
  }

  /** Simulate a blocking device write with a sleep of the audio's duration. */
  protected async _writeAudioSleep(): Promise<void> {
    const currentTime = monotonic();
    const sleepDuration = Math.max(0, this._nextSendTime - currentTime);
    await sleep(sleepDuration);
    if (sleepDuration === 0) {
      this._nextSendTime = monotonic() + this._sendInterval;
    } else {
      this._nextSendTime += this._sendInterval;
    }
  }
}

/**
 * Complete local audio transport with input and output capabilities.
 *
 * Provides a unified interface for local audio I/O using sox or ffmpeg, supporting
 * both audio capture and playback through the system's audio devices.
 */
export class LocalAudioTransport extends BaseTransport {
  protected _params: LocalAudioTransportParams;
  protected _backend: LocalAudioBackend;
  protected _input: LocalAudioInputTransport | null = null;
  protected _output: LocalAudioOutputTransport | null = null;

  /**
   * Initialize the local audio transport.
   *
   * @param params Transport configuration parameters.
   */
  constructor(params: LocalAudioTransportParams = new LocalAudioTransportParams()) {
    super();
    this._params = params;
    this._backend = new LocalAudioBackend(params);
  }

  //
  // BaseTransport
  //

  /**
   * Get the input frame processor for this transport.
   *
   * @returns The audio input transport processor.
   */
  input(): FrameProcessor {
    if (!this._input) {
      this._input = new LocalAudioInputTransport(this._backend, this._params);
    }
    return this._input;
  }

  /**
   * Get the output frame processor for this transport.
   *
   * @returns The audio output transport processor.
   */
  output(): FrameProcessor {
    if (!this._output) {
      this._output = new LocalAudioOutputTransport(this._backend, this._params);
    }
    return this._output;
  }
}
