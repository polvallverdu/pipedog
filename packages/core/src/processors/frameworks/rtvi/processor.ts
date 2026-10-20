// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/frameworks/rtvi/processor.py

/**
 * RTVIProcessor: main RTVI protocol processor.
 *
 * Porting notes:
 * - Deprecated upstream APIs are not ported: the `transport` constructor
 *   option (ignored upstream) and `handleFunctionCall()` (superseded by
 *   `RTVIObserver`'s `llm-function-call-in-progress` events).
 * - Pydantic models from `models.ts` are dumped to their wire form with
 *   `modelDump({ excludeNone })` and parsed with `Model.modelValidate(obj)`.
 * - `ErrorFrame.fatal` is deprecated upstream and not ported, so RTVI `error`
 *   messages always carry `fatal: false`.
 */

import { Queue, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import {
  CancelFrame,
  EndFrame,
  EndWorkerFrame,
  ErrorFrame,
  type Frame,
  FunctionCallResultFrame,
  InputAudioRawFrame,
  InputDTMFFrame,
  InputTransportMessageFrame,
  InputTransportStartAudioStreamingFrame,
  LLMConfigureOutputFrame,
  LLMMessagesAppendFrame,
  OutputTransportMessageUrgentFrame,
  StartFrame,
  SystemFrame,
  UserFileRawFrame,
  UserImageRawFrame,
} from "../../../frames/frames.ts";
import { version as pipecatVersion } from "../../../index.ts";
import { logger } from "../../../utils/logger.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "../../frame_processor.ts";
import {
  RTVIClientMessageFrame,
  RTVISendTextFrame,
  RTVIUICancelJobGroupFrame,
  RTVIUIEventFrame,
  RTVIUISnapshotFrame,
} from "./frames.ts";
import * as RTVI from "./models.ts";
import { RTVIObserver, type RTVIObserverOptions } from "./observer.ts";

/**
 * Any RTVI model (a pydantic `BaseModel` upstream) that can be dumped to its
 * wire form.
 */
export interface RTVIModelLike {
  modelDump(options?: { excludeNone?: boolean }): Record<string, unknown>;
}

/**
 * Whether `e` is a model validation error (pydantic's `ValidationError`
 * upstream; a `ValidationError` or `ZodError` here).
 */
export function isValidationError(e: unknown): boolean {
  return e instanceof Error && (e.name === "ValidationError" || e.name === "ZodError");
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Python's int(): optional sign, digits, surrounding whitespace allowed.
function parsePythonInt(value: string): number {
  if (!/^\s*[+-]?\d+\s*$/.test(value)) {
    throw new RangeError(`invalid literal for int() with base 10: '${value}'`);
  }
  return Number.parseInt(value, 10);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Options for `RTVIProcessor`. */
export interface RTVIProcessorOptions extends FrameProcessorOptions {}

/**
 * Main processor for handling RTVI protocol messages and actions.
 *
 * This processor manages the RTVI protocol communication including
 * client-server handshaking, configuration management, action execution, and
 * message routing. It serves as the central hub for RTVI protocol operations.
 *
 * Event handlers available:
 *
 * - on_bot_started
 * - on_client_ready
 * - on_client_message: called with an `RTVI.ClientMessage`
 * - on_ui_message: called with an `RTVI.UIEventMessage`,
 *   `RTVI.UISnapshotMessage` or `RTVI.UICancelJobGroupMessage`
 */
export class RTVIProcessor extends FrameProcessor {
  protected _botReady = false;
  protected _clientReady = false;
  protected _clientReadyId = "";
  // Default to 0.0.0 to indicate unknown version.
  protected _clientVersion: number[] = [0, 0, 0];
  protected _llmSkipTts = false; // Keep in sync with llm_service.ts's configuration.

  // A task to process incoming transport messages.
  protected _messageTask: Task<unknown> | null = null;
  protected _messageQueue!: Queue<[RTVI.Message, string | null]>;

  /**
   * Initialize the RTVI processor.
   *
   * @param options Options passed to the parent class.
   */
  constructor(options: RTVIProcessorOptions = {}) {
    super(options);

    this._registerEventHandler("on_bot_started");
    this._registerEventHandler("on_client_ready");
    this._registerEventHandler("on_client_message");
    this._registerEventHandler("on_ui_message");
  }

  /**
   * The negotiated client protocol version as [major, minor, patch].
   *
   * Defaults to [0, 0, 0] until the client sends a `client-ready` message.
   */
  get clientVersion(): number[] {
    return this._clientVersion;
  }

  /**
   * Creates a new RTVI Observer.
   *
   * @param options.params Settings to enable/disable specific messages.
   *   Other options are passed to the observer.
   * @returns A new RTVI observer.
   */
  createRtviObserver(options: RTVIObserverOptions = {}): RTVIObserver {
    return new RTVIObserver(this, options);
  }

  /** Mark the client as ready and trigger the ready event. */
  async setClientReady(): Promise<void> {
    logger.debug(`${this}: client is ready`);
    this._clientReady = true;
    await this._callEventHandler("on_client_ready");
  }

  /**
   * Mark the bot as ready and send the bot-ready message.
   *
   * @param about Optional information about the bot to include in the ready
   *   message. If left as null, the Pipecat library and version will be used.
   */
  async setBotReady(about: Record<string, unknown> | null = null): Promise<void> {
    this._botReady = true;
    await this._sendBotReady(about);
  }

  /** Send a bot interruption frame upstream. */
  async interruptBot(): Promise<void> {
    await this.broadcastInterruption();
  }

  /** Send a server message to the client. */
  async sendServerMessage(data: unknown): Promise<void> {
    const message = new RTVI.ServerMessage({ data });
    await this._sendServerMessage(message);
  }

  /** Send a server response for a given client message. */
  async sendServerResponse(clientMsg: RTVI.ClientMessage, data: unknown): Promise<void> {
    const message = new RTVI.ServerResponse({
      id: clientMsg.msgId,
      data: new RTVI.RawServerResponseData({ t: clientMsg.type, d: data }),
    });
    await this._sendServerMessage(message);
  }

  /** Send an error response for a given client message. */
  async sendErrorResponse(clientMsg: RTVI.ClientMessage, error: string): Promise<void> {
    await this._sendErrorResponse(clientMsg.msgId, error);
  }

  /**
   * Send an error message to the client.
   *
   * @param error The error message to send.
   */
  async sendError(error: string): Promise<void> {
    await this._sendErrorFrame(new ErrorFrame({ error }));
  }

  /** Push a transport message frame. */
  async pushTransportMessage(model: RTVIModelLike, excludeNone = true): Promise<void> {
    const frame = new OutputTransportMessageUrgentFrame({
      message: model.modelDump({ excludeNone }),
    });
    await this.pushFrame(frame);
  }

  /**
   * Handle an incoming RTVI message.
   *
   * @param message The RTVI message to handle.
   * @param userId Identifier for the user who sent it, if known.
   */
  async handleMessage(message: RTVI.Message, userId: string | null = null): Promise<void> {
    await this._messageQueue.put([message, userId]);
  }

  /**
   * Process incoming frames through the RTVI processor.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    // Specific system frames
    if (frame instanceof StartFrame) {
      // Push StartFrame before start(), because we want StartFrame to be
      // processed by every processor before any other frame is processed.
      await this.pushFrame(frame, direction);
      await this._start(frame);
    } else if (frame instanceof CancelFrame) {
      await this._cancel(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof ErrorFrame) {
      await this._sendErrorFrame(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof InputTransportMessageFrame) {
      await this._handleTransportMessage(frame);
    }
    // All other system frames
    else if (frame instanceof SystemFrame) {
      await this.pushFrame(frame, direction);
    }
    // Control frames
    else if (frame instanceof EndFrame) {
      // Push EndFrame before stop(), because stop() waits on the task to
      // finish and the task finishes when EndFrame is processed.
      await this.pushFrame(frame, direction);
      await this._stop(frame);
    }
    // Data frames
    else if (frame instanceof LLMConfigureOutputFrame) {
      this._llmSkipTts = frame.skipTts;
      await this.pushFrame(frame, direction);
    }
    // Other frames
    else {
      await this.pushFrame(frame, direction);
    }
  }

  /** Release resources held by the processor. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._cancelTasks();
  }

  /** Start the RTVI processor tasks. */
  protected async _start(_frame: StartFrame): Promise<void> {
    if (!this._messageTask) {
      this._messageQueue = new Queue();
      this._messageTask = this.createTask(() => this._messageTaskHandler(), "_messageTaskHandler");
    }
    await this._callEventHandler("on_bot_started");
  }

  /** Stop the RTVI processor tasks. */
  protected async _stop(_frame: EndFrame): Promise<void> {
    await this._cancelTasks();
  }

  /** Cancel the RTVI processor tasks. */
  protected async _cancel(_frame: CancelFrame): Promise<void> {
    await this._cancelTasks();
  }

  /** Cancel all running tasks. */
  protected async _cancelTasks(): Promise<void> {
    if (this._messageTask) {
      await this.cancelTask(this._messageTask);
      this._messageTask = null;
    }
  }

  /** Handle incoming transport messages. */
  protected async _messageTaskHandler(): Promise<void> {
    while (true) {
      const [message, userId] = await this._messageQueue.get();
      await this._handleMessage(message, userId);
      this._messageQueue.taskDone();
    }
  }

  /** Handle an incoming transport message frame. */
  protected async _handleTransportMessage(frame: InputTransportMessageFrame): Promise<void> {
    try {
      const transportMessage = frame.message as Record<string, unknown>;
      if (transportMessage.label !== RTVI.MESSAGE_LABEL) {
        logger.warning(`Ignoring not RTVI message: ${JSON.stringify(transportMessage)}`);
        return;
      }
      const message = RTVI.Message.modelValidate(transportMessage);
      // Transports that know the sender, such as Daily and LiveKit, set it
      // as `participantId` on their subclass of the frame.
      const userId =
        ((frame as unknown as { participantId?: string | null }).participantId as
          | string
          | null
          | undefined) ?? null;
      await this._messageQueue.put([message, userId]);
    } catch (e) {
      rethrowIfCancelled(e);
      if (!isValidationError(e)) throw e;
      await this.sendError(`Invalid RTVI transport message: ${errorMessage(e)}`);
      logger.warning(`Invalid RTVI transport message: ${errorMessage(e)}`);
    }
  }

  /** Handle a parsed RTVI message. */
  protected async _handleMessage(
    message: RTVI.Message,
    userId: string | null = null,
  ): Promise<void> {
    try {
      switch (message.type) {
        case "client-ready": {
          let data: RTVI.ClientReadyData | null = null;
          const raw = (message.data ?? {}) as Record<string, unknown>;
          const version = raw.version;
          if (typeof version === "string") {
            let about = new RTVI.AboutClientData({ library: "unknown" });
            const aboutRaw = raw.about;
            if (aboutRaw !== null && aboutRaw !== undefined) {
              try {
                about = RTVI.AboutClientData.modelValidate(aboutRaw);
              } catch (e) {
                rethrowIfCancelled(e);
                if (!isValidationError(e)) throw e;
                logger.warning("Invalid 'about' data in client-ready message, ignoring.");
              }
            }
            data = new RTVI.ClientReadyData({ version, about });
          }
          await this._handleClientReady(message.id, data);
          break;
        }
        case "disconnect-bot":
          await this.pushFrame(new EndWorkerFrame());
          break;
        case "client-message": {
          const data = RTVI.RawClientMessageData.modelValidate(message.data);
          await this._handleClientMessage(message.id, data);
          break;
        }
        case "ui-event": {
          const eventData = RTVI.UIEventData.modelValidate(message.data ?? {});
          await this.pushFrame(
            new RTVIUIEventFrame({
              msgId: message.id,
              event: eventData.event,
              payload: eventData.payload,
            }),
          );
          await this._callEventHandler(
            "on_ui_message",
            new RTVI.UIEventMessage({ id: message.id, data: eventData }),
          );
          break;
        }
        case "ui-snapshot": {
          const snapshotData = RTVI.UISnapshotData.modelValidate(message.data ?? {});
          await this.pushFrame(
            new RTVIUISnapshotFrame({ msgId: message.id, tree: snapshotData.tree }),
          );
          await this._callEventHandler(
            "on_ui_message",
            new RTVI.UISnapshotMessage({ id: message.id, data: snapshotData }),
          );
          break;
        }
        case "ui-cancel-job-group": {
          const cancelData = RTVI.UICancelJobGroupData.modelValidate(message.data ?? {});
          await this.pushFrame(
            new RTVIUICancelJobGroupFrame({
              msgId: message.id,
              jobId: cancelData.jobId,
              reason: cancelData.reason,
            }),
          );
          await this._callEventHandler(
            "on_ui_message",
            new RTVI.UICancelJobGroupMessage({ id: message.id, data: cancelData }),
          );
          break;
        }
        case "llm-function-call-result": {
          const data = RTVI.LLMFunctionCallResultData.modelValidate(message.data);
          await this._handleFunctionCallResult(data);
          break;
        }
        case "send-text": {
          const data = RTVI.SendTextData.modelValidate(message.data);
          await this._handleSendText(data, message.id, userId);
          break;
        }
        case "send-file": {
          const data = RTVI.SendFileData.modelValidate(message.data);
          await this._handleSendFile(data, message.id);
          break;
        }
        case "raw-audio":
        case "raw-audio-batch":
          await this._handleAudioBuffer(message.data);
          break;
        case "dtmf": {
          const data = RTVI.DTMFInputData.modelValidate(message.data);
          await this._handleDtmf(data);
          break;
        }

        default:
          logger.warning(`Unsupported RTVI message type: ${message.type}`);
          await this._sendErrorResponse(message.id, `Unsupported type ${message.type}`);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (isValidationError(e)) {
        await this._sendErrorResponse(message.id, `Invalid message: ${errorMessage(e)}`);
        logger.warning(`Invalid message: ${errorMessage(e)}`);
      } else {
        await this._sendErrorResponse(
          message.id,
          `Exception processing message: ${errorMessage(e)}`,
        );
        logger.warning(`Exception processing message: ${errorMessage(e)}`);
      }
    }
  }

  /** Handle the client-ready message from the client. */
  protected async _handleClientReady(
    requestId: string,
    data: RTVI.ClientReadyData | null,
  ): Promise<void> {
    const version = data ? data.version : null;
    logger.debug(`Received client-ready: version ${version}`);
    let versionError: string | null = null;
    if (version) {
      try {
        const parts = version.split(".").map(parsePythonInt);
        if (parts.length !== 3) {
          throw new RangeError("invalid version");
        }
        this._clientVersion = parts;
        const serverMajor = parsePythonInt(RTVI.PROTOCOL_VERSION.split(".")[0] as string);
        const clientMajor = this._clientVersion[0];
        if (clientMajor === serverMajor) {
          // fully compatible
        } else if (clientMajor === RTVI.LEGACY_SUPPORTED_MAJOR) {
          // Any 1.x client is deprecated but still served with the v1 bot-output format.
          // TODO: enable this once RTVI 2.0.0 is supported by all our client SDKs.
          // 1.x.x is deprecated but still served with the v1 bot-output format.
          // const legacyWarning =
          //   `RTVI client version ${version} is deprecated. ` +
          //   `Please upgrade to protocol ${RTVI.PROTOCOL_VERSION}. ` +
          //   "The bot-output event format has changed in 2.0.0.";
          // logger.warning(legacyWarning);
          // await this._sendErrorResponse(requestId, legacyWarning);
          // versionError intentionally left as null — connection proceeds.
        } else {
          versionError = `RTVI version ${version} is not compatible with server protocol ${RTVI.PROTOCOL_VERSION}.`;
        }
      } catch (e) {
        rethrowIfCancelled(e);
        if (!(e instanceof RangeError)) throw e;
        versionError = `Invalid client version format (${version}).`;
      }
    } else {
      versionError = "Client version unknown.";
    }
    const about = data ? data.about : { library: "unknown" };
    if (versionError) {
      versionError += " Compatibility issues may occur.";
      logger.warning(versionError);
      await this._sendErrorResponse(requestId, versionError);
    }

    logger.debug(`Client Details: ${JSON.stringify(about)}`);
    // Ask the input transport to start streaming audio now that the client
    // is ready.
    await this.pushFrame(new InputTransportStartAudioStreamingFrame());

    this._clientReadyId = requestId;
    await this.setClientReady();
  }

  /**
   * Handle incoming audio buffer data.
   *
   * The RTVIProcessor is prepended to the very top of the pipeline, so
   * pushing `InputAudioRawFrame` downstream reaches the input transport,
   * which feeds it through its VAD/processing path. Frame-based so we don't
   * hold a transport reference.
   */
  protected async _handleAudioBuffer(data: unknown): Promise<void> {
    const raw = data as Record<string, unknown>;
    // Extract audio batch ensuring it's a list
    // Python `or`: an empty batch list is falsy, so fall back to the single chunk.
    const batch = raw.base64AudioBatch;
    const audioList = (
      batch && !(Array.isArray(batch) && batch.length === 0) ? batch : [raw.base64Audio]
    ) as unknown[];

    try {
      // Filter out null/empty values
      for (const base64Audio of audioList.filter(Boolean)) {
        if (typeof base64Audio !== "string") {
          throw new TypeError("base64 audio must be a string");
        }
        for (const key of ["sampleRate", "numChannels"]) {
          if (!(key in raw)) throw new RangeError(`missing key '${key}'`);
        }
        const pcmBytes = base64ToBytes(base64Audio);
        const frame = new InputAudioRawFrame({
          audio: pcmBytes,
          sampleRate: raw.sampleRate as number,
          numChannels: raw.numChannels as number,
        });
        await this.pushFrame(frame);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      // Upstream catches only (KeyError, TypeError, ValueError); anything else
      // (e.g. from pushFrame) propagates to `_handleMessage`.
      const handled =
        e instanceof TypeError ||
        e instanceof RangeError ||
        (e instanceof Error && e.name === "InvalidCharacterError");
      if (!handled) throw e;
      // Handle missing keys, decoding errors, and invalid types
      logger.error(`Error processing audio buffer: ${errorMessage(e)}`);
    }
  }

  /**
   * Handle DTMF keypresses from the client.
   *
   * Like `_handleAudioBuffer`, the RTVIProcessor sits at the top of the
   * pipeline, so pushing `InputDTMFFrame` downstream reaches the input
   * transport and the bot's DTMF handling exactly as a telephony transport's
   * keypresses would. A multi-key sequence is pushed as one frame per key,
   * in order.
   */
  protected async _handleDtmf(data: RTVI.DTMFInputData): Promise<void> {
    for (const button of data.buttons) {
      await this.pushFrame(new InputDTMFFrame({ button }));
    }
  }

  /** Handle a send-text message from the client. */
  protected async _handleSendText(
    data: RTVI.SendTextData,
    messageId: string,
    userId: string | null = null,
  ): Promise<void> {
    const opts = data.options ?? new RTVI.SendTextOptions();
    if (opts.runImmediately) {
      await this.interruptBot();
      // Drain the pipeline before appending the new message. The
      // interruption commits the in-progress assistant response into the
      // context; flushing guarantees that lands *before* we append (and
      // run) the new user message, so the context stays correctly ordered
      // (otherwise the append can overtake the commit and the model
      // continues the interrupted turn). This runs in the message task, so
      // awaiting here doesn't block the frame loop that forwards the probe.
      await this.pipelineWorker.flushPipeline();
    }
    const curLlmSkipTts = this._llmSkipTts;
    const shouldSkipTts = !opts.audioResponse;
    const toggleSkipTts = curLlmSkipTts !== shouldSkipTts;
    if (toggleSkipTts) {
      const outputFrame = new LLMConfigureOutputFrame({ skipTts: shouldSkipTts });
      await this.pushFrame(outputFrame);
    }
    const textFrame = new LLMMessagesAppendFrame({
      messages: [{ role: "user", content: data.content }],
      runLlm: opts.runImmediately,
    });
    await this.pushFrame(textFrame);
    await this.pushFrame(new RTVISendTextFrame({ msgId: messageId, text: data.content, userId }));
    if (toggleSkipTts) {
      const outputFrame = new LLMConfigureOutputFrame({ skipTts: curLlmSkipTts });
      await this.pushFrame(outputFrame);
    }
  }

  /**
   * Handle a send-file message from the client.
   *
   * Validation and framing only: a URL source is passed through unresolved,
   * and whether the LLM provider fetches it itself or the LLM service's
   * `FileResolver` downloads it is decided at completion time.
   */
  protected async _handleSendFile(data: RTVI.SendFileData, messageId: string): Promise<void> {
    const file = data.file;
    const opts = data.options ?? new RTVI.SendFileOptions();

    logger.debug(`Handling file from RTVI: format=${file.format}, type=${file.source.type}`);

    let source: string;
    let sourceType: RTVI.RTVIFileSourceType;
    const fs = file.source;
    if (fs instanceof RTVI.FileBytes) {
      // `bytes` is raw base64, but tolerate clients that send a full data URL.
      if (fs.bytes.startsWith("data:")) {
        source = fs.bytes;
      } else {
        source = `data:${file.format};base64,${fs.bytes}`;
      }
      sourceType = "bytes";
    } else if (fs instanceof RTVI.FileUrl) {
      source = fs.url;
      sourceType = "url";
    } else {
      const type = (file.source as { type?: unknown }).type;
      logger.warning(`Unsupported file source type: ${type}`);
      await this._sendErrorResponse(messageId, `Unsupported file source type: ${type}`);
      return;
    }

    let fileFrame: Frame;
    if (file.format.startsWith("image/") && sourceType === "bytes") {
      const size: [number, number] =
        file.source instanceof RTVI.FileBytes
          ? [file.source.width || 0, file.source.height || 0]
          : [0, 0];
      const marker = source.indexOf("base64,");
      if (marker < 0) {
        throw new RangeError("list index out of range");
      }
      const imageBytes = base64ToBytes(source.slice(marker + "base64,".length));
      fileFrame = new UserImageRawFrame({
        text: data.content,
        image: imageBytes,
        size,
        format: file.format,
        appendToContext: true,
        runLlm: opts.runImmediately,
      });
    } else {
      fileFrame = new UserFileRawFrame({
        text: data.content,
        file: source,
        type: sourceType,
        filename: file.name,
        format: file.format,
        customOptions: opts.customOptions,
        appendToContext: true,
        runLlm: opts.runImmediately,
      });
    }

    if (opts.runImmediately) {
      await this.interruptBot();
    }

    const curLlmSkipTts = this._llmSkipTts;
    const shouldSkipTts = !opts.audioResponse;
    const toggleSkipTts = curLlmSkipTts !== shouldSkipTts;
    if (toggleSkipTts) {
      const outputFrame = new LLMConfigureOutputFrame({ skipTts: shouldSkipTts });
      await this.pushFrame(outputFrame);
    }
    await this.pushFrame(fileFrame);
    if (toggleSkipTts) {
      const outputFrame = new LLMConfigureOutputFrame({ skipTts: curLlmSkipTts });
      await this.pushFrame(outputFrame);
    }
  }

  /** Handle a client message frame. */
  protected async _handleClientMessage(
    msgId: string,
    data: RTVI.RawClientMessageData,
  ): Promise<void> {
    // Create a RTVIClientMessageFrame to push the message
    const frame = new RTVIClientMessageFrame({ msgId, type: data.t, data: data.d });
    await this.pushFrame(frame);
    await this._callEventHandler(
      "on_client_message",
      new RTVI.ClientMessage({
        msgId,
        type: data.t,
        data: data.d,
      }),
    );
  }

  /** Handle a function call result from the client. */
  protected async _handleFunctionCallResult(data: RTVI.LLMFunctionCallResultData): Promise<void> {
    const frame = new FunctionCallResultFrame({
      functionName: data.functionName,
      toolCallId: data.toolCallId,
      arguments: data.arguments,
      result: data.result,
    });
    await this.pushFrame(frame);
  }

  /**
   * Send the bot-ready message to the client.
   *
   * @param about Optional information about the bot to include in the ready
   *   message. If left as null, the pipecat library and version will be used.
   */
  protected async _sendBotReady(about: Record<string, unknown> | null = null): Promise<void> {
    if (!about || Object.keys(about).length === 0) {
      about = { library: "pipecat-ai", library_version: `${pipecatVersion()}` };
    }
    // Negotiate the protocol version we advertise back to the client.
    // The server observer serves v1-formatted bot-output events to
    // 1.x clients (see `_isLegacyClient`), so advertising the
    // server's own 2.0.0 PROTOCOL_VERSION here would push the client's
    // aggregator onto its v2 path (server-side speech progress) while
    // the wire actually carries v1 events, and the two would collide.
    // For legacy clients, echo their declared version back.
    let version: string;
    if (this._clientVersion[0] === RTVI.LEGACY_SUPPORTED_MAJOR) {
      version = this._clientVersion.map((v) => String(v)).join(".");
    } else {
      version = RTVI.PROTOCOL_VERSION;
    }
    const message = new RTVI.BotReady({
      id: this._clientReadyId,
      data: new RTVI.BotReadyData({
        version,
        about,
        capabilities: this.pipelineWorker.capabilities,
      }),
    });
    await this.pushTransportMessage(message);
  }

  /** Send a message or response to the client. */
  protected async _sendServerMessage(
    message: RTVI.ServerMessage | RTVI.ServerResponse,
  ): Promise<void> {
    await this.pushTransportMessage(message);
  }

  /** Send an error frame as an RTVI error message. */
  protected async _sendErrorFrame(frame: ErrorFrame): Promise<void> {
    // `ErrorFrame.fatal` is deprecated upstream and not ported.
    const message = new RTVI.Error({
      data: new RTVI.ErrorData({ error: frame.error, fatal: false }),
    });
    await this.pushTransportMessage(message);
  }

  /** Send an error response message. */
  protected async _sendErrorResponse(id: string, error: string): Promise<void> {
    const message = new RTVI.ErrorResponse({ id, data: new RTVI.ErrorResponseData({ error }) });
    await this.pushTransportMessage(message);
  }
}
