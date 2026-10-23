// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A transport between a pipedog bot and a Cloudflare Realtime SFU session.
 *
 * The user talks over WebRTC to the SFU. The bot never speaks WebRTC: the SFU's WebSocket
 * adapters convert the media, and **the SFU dials the bot** on two WebSocket endpoints:
 *
 * - **input** (an adapter with `location: "remote"`): the SFU decodes the user's Opus
 *   microphone and streams it to the bot as 48 kHz stereo PCM;
 * - **output** (an adapter with `location: "local"`): the bot streams 48 kHz stereo PCM to the
 *   SFU, which publishes it as a WebRTC track for the user to subscribe to.
 *
 * Each message is a small protobuf packet (`packet.ts`). The transport converts to and from the
 * pipeline's sample rate and channel count, and paces its output in real time.
 *
 * App messages (RTVI) can't ride the adapters, so they go over an optional third WebSocket,
 * **messages**, which the browser opens to the bot directly. It carries the same JSON messages
 * SmallWebRTC sends over its data channel, one per text frame.
 *
 * Because the sockets arrive over HTTP, the transport doesn't listen: your server hands it each
 * upgraded request with `acceptSocket(role, request)` (or an upgraded socket with
 * `attachSocket`). That works in a Worker, a Durable Object, or a Bun, Node or Deno server.
 */

import {
  Event,
  monotonic,
  rethrowIfCancelled,
  sleep,
  type Task,
  TimeoutError,
  waitFor,
} from "@pipedog/asyncio";
import type { BaseAudioResampler } from "@pipedog/core/audio/resamplers/base_audio_resampler";
import { createStreamResampler } from "@pipedog/core/audio/utils";
import {
  type CancelFrame,
  ClientConnectedFrame,
  type EndFrame,
  type Frame,
  InputAudioRawFrame,
  InputTransportMessageFrame,
  InterruptionFrame,
  type OutputAudioRawFrame,
  type OutputTransportMessageFrame,
  type OutputTransportMessageUrgentFrame,
  type StartFrame,
} from "@pipedog/core/frames/frames";
import type {
  FrameDirection,
  FrameProcessorOptions,
} from "@pipedog/core/processors/frame_processor";
import { BaseInputTransport } from "@pipedog/core/transports/base_input";
import { BaseOutputTransport } from "@pipedog/core/transports/base_output";
import {
  BaseTransport,
  TransportParams,
  type TransportParamsOptions,
} from "@pipedog/core/transports/base_transport";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { type UpgradeWebSocketOptions, upgradeWebSocket } from "@pipedog/transport-websocket/fetch";
import { State, WebsocketConnection } from "@pipedog/transport-websocket/socket";

import {
  decodePacket,
  encodePacket,
  MAX_PAYLOAD_BYTES,
  monoToStereo,
  PacketError,
  SFU_CHANNELS,
  SFU_SAMPLE_RATE,
  stereoToMono,
} from "./packet.ts";

/**
 * Which socket a request carries:
 *
 * - `input`: the SFU streams the user's audio to the bot (a `remote` adapter).
 * - `output`: the bot streams its audio to the SFU (a `local` adapter).
 * - `messages`: app messages (RTVI) between the browser and the bot, as JSON text.
 */
export type SocketRole = "input" | "output" | "messages";

// Messages kept while no messages socket is attached.
const MAX_PENDING_MESSAGES = 100;

function errorName(e: unknown): string {
  return e instanceof Error ? e.constructor.name : typeof e;
}

export interface CloudflareRealtimeParamsOptions extends TransportParamsOptions {
  /**
   * Seconds to wait for the SFU to reconnect the input adapter after its socket drops, before
   * the client counts as disconnected. The SFU retries the same endpoint for up to 15 seconds.
   * Defaults to 15.
   */
  inputReconnectTimeout?: number;
  /**
   * Whether the messages socket closing counts as the client disconnecting. With a browser
   * client it is the most reliable signal that the user left, since the SFU keeps the
   * adapters open. Defaults to true.
   */
  disconnectOnMessagesClose?: boolean;
}

/**
 * Configuration for `CloudflareRealtimeTransport`.
 *
 * The pipeline's audio rates and channels apply as usual (`audioInSampleRate`,
 * `audioOutSampleRate`, `audioInChannels`, `audioOutChannels`); the transport resamples
 * between them and the SFU's 48 kHz stereo. Set `audioOutSampleRate: 48000` to skip output
 * resampling.
 */
export class CloudflareRealtimeParams extends TransportParams {
  inputReconnectTimeout: number;
  disconnectOnMessagesClose: boolean;

  constructor(options: CloudflareRealtimeParamsOptions = {}) {
    super(options);
    this.inputReconnectTimeout = options.inputReconnectTimeout ?? 15;
    this.disconnectOnMessagesClose = options.disconnectOnMessagesClose ?? true;
  }
}

export interface CloudflareRealtimeCallbacks {
  onClientConnected(client: CloudflareRealtimeClient): Promise<void>;
  onClientDisconnected(client: CloudflareRealtimeClient): Promise<void>;
  onAppMessage(message: unknown, sender: string): Promise<void>;
}

/**
 * The sockets of one call, shared by the input and output transports. This is the `client`
 * passed to the transport's client events.
 */
export class CloudflareRealtimeClient {
  /** The client's id (see `CloudflareRealtimeTransportOptions.clientId`). */
  readonly id: string;

  #callbacks: CloudflareRealtimeCallbacks;
  #input: WebsocketConnection | null = null;
  #output: WebsocketConnection | null = null;
  #messages: WebsocketConnection | null = null;
  #inputChanged = new Event();
  #outputChanged = new Event();
  #messagesChanged = new Event();
  #pendingMessages: string[] = [];
  #closing = false;
  #connected = false;
  #disconnected = false;

  constructor(id: string, callbacks: CloudflareRealtimeCallbacks) {
    this.id = id;
    this.#callbacks = callbacks;
  }

  /** The socket the SFU streams the user's audio on, once attached. */
  get inputSocket(): WebsocketConnection | null {
    return this.#input;
  }

  /** The socket the bot's audio goes to the SFU on, once attached. */
  get outputSocket(): WebsocketConnection | null {
    return this.#output;
  }

  /** The app messages socket, once attached. */
  get messagesSocket(): WebsocketConnection | null {
    return this.#messages;
  }

  /** Whether the transport is shutting down. */
  get isClosing(): boolean {
    return this.#closing;
  }

  /** Whether `on_client_connected` has fired. */
  get isConnected(): boolean {
    return this.#connected && !this.#disconnected;
  }

  /**
   * Attach a socket. A socket for a role that already has one replaces it (the SFU reconnects
   * the input adapter after a network drop); the old one is closed.
   */
  attach(role: SocketRole, socket: WebsocketConnection): void {
    if (this.#closing) {
      logger.debug(`${this}: refusing the ${role} socket, the transport is closing`);
      void socket.close(1001, "transport closing").catch(() => {});
      return;
    }
    const previous =
      role === "input" ? this.#input : role === "output" ? this.#output : this.#messages;
    if (role === "input") {
      this.#input = socket;
      this.#inputChanged.set();
    } else if (role === "output") {
      this.#output = socket;
      this.#outputChanged.set();
    } else {
      this.#messages = socket;
      this.#messagesChanged.set();
      this.#flushMessages();
    }
    if (previous && previous !== socket) {
      void previous.close(1000, "replaced").catch(() => {});
    }
  }

  /** Wait until a socket other than `previous` is attached for `role`, at most `timeout` seconds. */
  async waitForSocket(
    role: SocketRole,
    previous: WebsocketConnection | null,
    timeout: number | null = null,
  ): Promise<WebsocketConnection | null> {
    const current = () =>
      role === "input" ? this.#input : role === "output" ? this.#output : this.#messages;
    const event =
      role === "input"
        ? this.#inputChanged
        : role === "output"
          ? this.#outputChanged
          : this.#messagesChanged;
    const deadline = timeout === null ? null : monotonic() + timeout;
    for (;;) {
      const socket = current();
      if (socket && socket !== previous && socket.state !== State.CLOSED) return socket;
      if (this.#closing) return null;
      event.clear();
      if (deadline === null) {
        await event.wait();
      } else {
        const remaining = deadline - monotonic();
        if (remaining <= 0) return null;
        try {
          await waitFor(() => event.wait(), remaining);
        } catch (e) {
          if (e instanceof TimeoutError) return null;
          throw e;
        }
      }
    }
  }

  /** Fire `on_client_connected`, once. */
  async triggerConnected(): Promise<void> {
    if (this.#connected || this.#closing) return;
    this.#connected = true;
    await this.#callbacks.onClientConnected(this);
  }

  /** Fire `on_client_disconnected`, once, unless the transport itself is closing. */
  async triggerDisconnected(): Promise<void> {
    if (this.#disconnected || this.#closing) return;
    this.#disconnected = true;
    await this.#callbacks.onClientDisconnected(this);
  }

  /** Deliver an app message from the messages socket. */
  async triggerAppMessage(message: unknown): Promise<void> {
    await this.#callbacks.onAppMessage(message, this.id);
  }

  /**
   * Send PCM packet bytes to the SFU.
   *
   * @returns Whether the output socket took it.
   */
  async sendAudio(packet: Uint8Array): Promise<boolean> {
    const socket = this.#output;
    if (this.#closing || !socket || socket.state !== State.OPEN) return false;
    try {
      await socket.send(packet);
      return true;
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`${this}: exception sending audio: ${errorName(e)} (${e})`);
      return false;
    }
  }

  /** Send an app message (JSON-encoded) over the messages socket, or queue it until one attaches. */
  async sendMessage(message: unknown): Promise<void> {
    if (this.#closing) return;
    const json = pyJsonDumps(message);
    const socket = this.#messages;
    if (socket && socket.state === State.OPEN) {
      try {
        await socket.send(json);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this}: exception sending a message: ${errorName(e)} (${e})`);
      }
      return;
    }
    if (this.#pendingMessages.length < MAX_PENDING_MESSAGES) {
      this.#pendingMessages.push(json);
    } else {
      logger.warning(`${this}: message queue is full, discarding a message`);
    }
  }

  #flushMessages(): void {
    const socket = this.#messages;
    if (!socket) return;
    const pending = this.#pendingMessages.splice(0);
    for (const json of pending) {
      void socket.send(json).catch(() => {});
    }
  }

  /** Close every socket. Idempotent. */
  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#inputChanged.set();
    this.#outputChanged.set();
    this.#messagesChanged.set();
    const sockets = [this.#input, this.#output, this.#messages].filter(
      (s): s is WebsocketConnection => s !== null,
    );
    await Promise.all(
      sockets.map(async (socket) => {
        try {
          await socket.close(1000, "bot finished");
        } catch (e) {
          rethrowIfCancelled(e);
        }
      }),
    );
  }

  toString(): string {
    return `CloudflareRealtimeClient(${this.id})`;
  }
}

/**
 * Input transport: reads the user's audio from the input socket, and app messages from the
 * messages socket.
 */
export class CloudflareRealtimeInputTransport extends BaseInputTransport {
  protected _transport: BaseTransport;
  protected _client: CloudflareRealtimeClient;
  declare protected _params: CloudflareRealtimeParams;
  protected _receiveTask: Task<unknown> | null = null;
  protected _messagesTask: Task<unknown> | null = null;
  protected _resampler: BaseAudioResampler = createStreamResampler();
  protected _warnedChannels = false;

  constructor(
    transport: BaseTransport,
    client: CloudflareRealtimeClient,
    params: CloudflareRealtimeParams,
    options: FrameProcessorOptions = {},
  ) {
    super(params, options);
    this._transport = transport;
    this._client = client;
    this._params = params;
  }

  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    if (!this._receiveTask) {
      this._receiveTask = this.createTask(() => this._receiveAudio(), "_receive_audio");
    }
    if (!this._messagesTask) {
      this._messagesTask = this.createTask(() => this._receiveMessages(), "_receive_messages");
    }
    await this.setTransportReady(frame);
  }

  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._teardown();
  }

  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._teardown();
  }

  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._teardown();
    await this._transport.cleanup();
  }

  protected async _teardown(): Promise<void> {
    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }
    if (this._messagesTask) {
      await this.cancelTask(this._messagesTask);
      this._messagesTask = null;
    }
    await this._client.close();
  }

  /**
   * Wait for both media sockets, report the client connected, then read audio. When the input
   * socket drops, wait `inputReconnectTimeout` for the SFU to reconnect it.
   */
  protected async _receiveAudio(): Promise<void> {
    let socket = await this._client.waitForSocket("input", null);
    if (!socket) return;
    if (!(await this._client.waitForSocket("output", null))) return;
    await this._client.triggerConnected();
    await this.pushFrame(new ClientConnectedFrame());

    for (;;) {
      try {
        for await (const message of socket) {
          await this._handleAudioMessage(message);
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this}: input socket closed: ${errorName(e)} (${e})`);
      }
      if (this._client.isClosing) return;
      logger.debug(
        `${this}: input socket closed, waiting ${this._params.inputReconnectTimeout}s for the SFU to reconnect`,
      );
      const next = await this._client.waitForSocket(
        "input",
        socket,
        this._params.inputReconnectTimeout,
      );
      if (!next) {
        await this._client.triggerDisconnected();
        return;
      }
      // A new stream: don't carry the old one's resampler state over.
      await this._resampler.reset();
      socket = next;
    }
  }

  /** Convert one adapter packet to an `InputAudioRawFrame` at the pipeline's format. */
  protected async _handleAudioMessage(message: string | Uint8Array): Promise<void> {
    if (typeof message === "string") {
      logger.debug(`${this}: ignoring a text message on the input socket`);
      return;
    }
    let payload: Uint8Array;
    try {
      payload = decodePacket(message).payload;
    } catch (e) {
      if (e instanceof PacketError) {
        logger.warning(`${this}: dropping an invalid packet: ${e.message}`);
        return;
      }
      throw e;
    }
    if (payload.length === 0) return;
    if (payload.length % 4 !== 0) {
      logger.warning(`${this}: dropping PCM that isn't whole stereo 16-bit frames`);
      return;
    }

    const sampleRate = this.sampleRate;
    let audio: Uint8Array;
    let numChannels: number;
    if (this._params.audioInChannels === SFU_CHANNELS && sampleRate === SFU_SAMPLE_RATE) {
      audio = payload.slice();
      numChannels = SFU_CHANNELS;
    } else {
      if (this._params.audioInChannels !== 1 && !this._warnedChannels) {
        this._warnedChannels = true;
        logger.warning(
          `${this}: stereo input needs a 48 kHz pipeline; sending mono at ${sampleRate} Hz`,
        );
      }
      audio = stereoToMono(payload);
      numChannels = 1;
      if (sampleRate !== SFU_SAMPLE_RATE) {
        audio = await this._resampler.resample(audio, SFU_SAMPLE_RATE, sampleRate);
      }
    }
    if (audio.length === 0) return;
    await this.pushAudioFrame(new InputAudioRawFrame({ audio, sampleRate, numChannels }));
  }

  /** Read app messages until the messages socket closes. */
  protected async _receiveMessages(): Promise<void> {
    let previous: WebsocketConnection | null = null;
    for (;;) {
      const socket = await this._client.waitForSocket("messages", previous);
      if (!socket) return;
      previous = socket;
      try {
        for await (const message of socket) {
          const text = typeof message === "string" ? message : new TextDecoder().decode(message);
          let parsed: unknown;
          try {
            parsed = pyJsonLoads(text);
          } catch {
            logger.warning(`${this}: ignoring a message that isn't JSON`);
            continue;
          }
          await this.broadcastFrame(InputTransportMessageFrame, { message: parsed });
          await this._client.triggerAppMessage(parsed);
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.debug(`${this}: messages socket closed: ${errorName(e)} (${e})`);
      }
      if (this._client.isClosing) return;
      // Another messages socket may already have replaced this one.
      if (this._client.messagesSocket !== socket) continue;
      if (this._params.disconnectOnMessagesClose) {
        await this._client.triggerDisconnected();
        return;
      }
    }
  }
}

/**
 * Output transport: sends the bot's audio to the SFU as 48 kHz stereo PCM packets, paced in real
 * time, and app messages over the messages socket.
 */
export class CloudflareRealtimeOutputTransport extends BaseOutputTransport {
  protected _transport: BaseTransport;
  protected _client: CloudflareRealtimeClient;
  declare protected _params: CloudflareRealtimeParams;
  protected _resampler: BaseAudioResampler = createStreamResampler();
  protected _watchTask: Task<unknown> | null = null;
  protected _sequenceNumber = 0;
  protected _timestamp = 0;

  // writeAudioFrame() is called as soon as audio is available (e.g. from the TTS), and this is
  // just a network connection, so it would send audio faster than real time. Block to emulate
  // an audio device instead; the interval is computed in setup().
  protected _sendInterval = 0;
  protected _nextSendTime = 0;

  constructor(
    transport: BaseTransport,
    client: CloudflareRealtimeClient,
    params: CloudflareRealtimeParams,
    options: FrameProcessorOptions = {},
  ) {
    super(params, options);
    this._transport = transport;
    this._client = client;
    this._params = params;
  }

  override async setup(setup: Parameters<BaseOutputTransport["setup"]>[0]): Promise<void> {
    await super.setup(setup);
    this._sendInterval =
      this.audioChunkSize / this.sampleRate / (2 * this._params.audioOutChannels);
  }

  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    if (!this._watchTask) {
      this._watchTask = this.createTask(() => this._watchOutput(), "_watch_output");
    }
    await this.setTransportReady(frame);
  }

  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._teardown();
  }

  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._teardown();
  }

  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._teardown();
    await this._transport.cleanup();
  }

  protected async _teardown(): Promise<void> {
    if (this._watchTask) {
      await this.cancelTask(this._watchTask);
      this._watchTask = null;
    }
    await this._client.close();
  }

  /**
   * Drain the output socket (the SFU sends nothing on it) to notice when it closes. The ingest
   * adapter doesn't reconnect, so a closed output socket ends the call.
   */
  protected async _watchOutput(): Promise<void> {
    let previous: WebsocketConnection | null = null;
    for (;;) {
      const socket = await this._client.waitForSocket("output", previous);
      if (!socket) return;
      previous = socket;
      try {
        for await (const _ of socket) {
          // Nothing is expected here.
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.debug(`${this}: output socket closed: ${errorName(e)} (${e})`);
      }
      if (this._client.isClosing) return;
      if (this._client.outputSocket !== socket) continue;
      await this._client.triggerDisconnected();
      return;
    }
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof InterruptionFrame) {
      // Drop the resampler's tail so stale audio doesn't lead the next response.
      await this._resampler.reset();
      this._nextSendTime = 0;
    }
  }

  override async sendMessage(
    frame: OutputTransportMessageFrame | OutputTransportMessageUrgentFrame,
  ): Promise<void> {
    await this._client.sendMessage(frame.message);
  }

  /** Convert the bot's audio to the SFU's 48 kHz stereo PCM. */
  protected async _toSfuPcm(frame: OutputAudioRawFrame): Promise<Uint8Array> {
    const channels = this._params.audioOutChannels;
    const rate = this.sampleRate;
    if (rate === SFU_SAMPLE_RATE) {
      return channels === SFU_CHANNELS ? frame.audio : monoToStereo(frame.audio);
    }
    const mono = channels === SFU_CHANNELS ? stereoToMono(frame.audio) : frame.audio;
    return monoToStereo(await this._resampler.resample(mono, rate, SFU_SAMPLE_RATE));
  }

  override async writeAudioFrame(frame: OutputAudioRawFrame): Promise<boolean> {
    const socket = this._client.outputSocket;
    if (this._client.isClosing || !socket || socket.state !== State.OPEN) {
      return false;
    }
    const pcm = await this._toSfuPcm(frame);
    for (let offset = 0; offset < pcm.length; offset += MAX_PAYLOAD_BYTES) {
      const payload = pcm.subarray(offset, Math.min(pcm.length, offset + MAX_PAYLOAD_BYTES));
      const packet = encodePacket({
        sequenceNumber: this._sequenceNumber,
        timestamp: this._timestamp,
        payload,
      });
      this._sequenceNumber = (this._sequenceNumber + 1) >>> 0;
      this._timestamp = (this._timestamp + payload.length / (2 * SFU_CHANNELS)) >>> 0;
      if (!(await this._client.sendAudio(packet))) return false;
    }
    await this._writeAudioSleep();
    return true;
  }

  /** Simulate audio playback timing. */
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

export interface CloudflareRealtimeTransportOptions {
  /** The client's id, as `getClientId` returns it. Defaults to a random UUID. */
  clientId?: string | null;
  /** Optional name for the transport. */
  name?: string | null;
  /** Optional name for the input processor. */
  inputName?: string | null;
  /** Optional name for the output processor. */
  outputName?: string | null;
}

/**
 * Transport for a bot in a Cloudflare Realtime SFU session, over the SFU's WebSocket adapters.
 * See the module docs for the sockets and who dials whom.
 *
 * Event handlers available:
 *
 * - on_client_connected(transport, client): both adapter sockets are attached
 * - on_client_disconnected(transport, client): the input adapter didn't reconnect in time, the
 *   output adapter closed, or (by default) the messages socket closed
 * - on_app_message(transport, message, sender): a JSON message arrived on the messages socket
 *
 * @example
 * const transport = new CloudflareRealtimeTransport(
 *   new CloudflareRealtimeParams({ audioInEnabled: true, audioOutEnabled: true }),
 * );
 * // In your fetch handler, for the URLs you gave the adapters:
 * return transport.acceptSocket("input", request);
 */
export class CloudflareRealtimeTransport extends BaseTransport {
  protected _params: CloudflareRealtimeParams;
  protected _client: CloudflareRealtimeClient;
  protected _input: CloudflareRealtimeInputTransport;
  protected _output: CloudflareRealtimeOutputTransport;

  constructor(
    params: CloudflareRealtimeParams = new CloudflareRealtimeParams(),
    options: CloudflareRealtimeTransportOptions = {},
  ) {
    super({
      name: options.name ?? null,
      inputName: options.inputName ?? null,
      outputName: options.outputName ?? null,
    });
    this._params = params;
    this._client = new CloudflareRealtimeClient(options.clientId ?? crypto.randomUUID(), {
      onClientConnected: (client) => this._callEventHandler("on_client_connected", client),
      onClientDisconnected: (client) => this._callEventHandler("on_client_disconnected", client),
      onAppMessage: (message, sender) => this._callEventHandler("on_app_message", message, sender),
    });
    this._input = new CloudflareRealtimeInputTransport(this, this._client, params, {
      name: this._inputName,
    });
    this._output = new CloudflareRealtimeOutputTransport(this, this._client, params, {
      name: this._outputName,
    });

    this._registerEventHandler("on_client_connected");
    this._registerEventHandler("on_client_disconnected");
    this._registerEventHandler("on_app_message");
  }

  /** The input transport. */
  input(): CloudflareRealtimeInputTransport {
    return this._input;
  }

  /** The output transport. */
  output(): CloudflareRealtimeOutputTransport {
    return this._output;
  }

  /** The call's sockets. */
  get client(): CloudflareRealtimeClient {
    return this._client;
  }

  /** The id of the client passed to the client events. */
  override getClientId(client: unknown): string {
    return (client as CloudflareRealtimeClient).id;
  }

  /**
   * Attach an upgraded socket. Sockets can arrive before or after the pipeline starts.
   *
   * @param role Which socket it is (see `SocketRole`).
   * @param socket The socket, wrapped as a `WebsocketConnection`.
   */
  attachSocket(role: SocketRole, socket: WebsocketConnection): void {
    this._client.attach(role, socket);
  }

  /**
   * Upgrade a request to a WebSocket and attach it. Authenticate the request first: the SFU
   * can't send headers, so put a per-call token in the endpoint URL and check it.
   *
   * On Cloudflare Workers, Durable Objects and Deno this works from the request alone; on Bun,
   * pass the `server` from `fetch(request, server)` and serve with `bunWebSocket` (see
   * `@pipedog/transport-websocket/fetch`).
   *
   * @param role Which socket the request carries.
   * @param request The upgrade request.
   * @param options The upgrading server, on Bun.
   * @returns The response that completes the upgrade.
   */
  acceptSocket(
    role: SocketRole,
    request: Request,
    options: UpgradeWebSocketOptions = {},
  ): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const { response, socket } = upgradeWebSocket(request, options);
    const connection = WebsocketConnection.fromWebSocket(socket, {
      headers: request.headers,
      path: new URL(request.url).pathname,
    });
    this.attachSocket(role, connection);
    return response;
  }

  /** Send a message to the client over the messages socket (queued until it attaches). */
  async sendMessage(message: unknown): Promise<void> {
    await this._client.sendMessage(message);
  }
}
