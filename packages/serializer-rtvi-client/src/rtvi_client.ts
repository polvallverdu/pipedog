// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/serializers/rtvi_client.py

/**
 * Frame serializer for a Pipecat pipeline acting as an RTVI *client*.
 *
 * This is the client-side mirror of how a bot emits RTVI. It deserializes the
 * RTVI *server* messages a bot sends (`bot-llm-text`, `user-transcription`,
 * ...) into pipeline frames, and serializes a client's outgoing frames (audio,
 * and RTVI client messages the caller builds) onto the wire. Pair it with a
 * WebSocket client transport to let a Pipecat pipeline talk to a bot that runs
 * an RTVI *server* transport (e.g. the eval transport).
 *
 * It is the inverse of `RTVIObserver`, which turns pipeline frames into server
 * messages on the bot side.
 *
 * Note: this covers the messages a conversation needs (the LLM response
 * lifecycle, the TTS's spoken text, transcriptions, speaking/interruption
 * signals, function calls). Metrics and inbound bot audio are added as the
 * eval-simulation work progresses.
 *
 * @module
 */

import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallInProgressFrame,
  FunctionCallResultFrame,
  InterimTranscriptionFrame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMMarkerResponseFrame,
  LLMTextFrame,
  OutputAudioRawFrame,
  OutputTransportMessageFrame,
  OutputTransportMessageUrgentFrame,
  TranscriptionFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import * as RTVI from "@pipedog/core/processors/frameworks/rtvi/models";
import {
  FrameSerializer,
  type FrameSerializerOptions,
  type SerializedData,
} from "@pipedog/core/serializers/base_serializer";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps as jsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { TextType } from "@pipedog/core/utils/text/base_text_aggregator";

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python truthiness: `None`, `False`, `0`, `""`, `[]` and `{}` are falsy. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value).length > 0;
  }
  return true;
}

/** Python's `dict.get(key, default)`. */
function get(dict: Dict, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(dict, key) ? dict[key] : fallback;
}

/** Python's `a or b`. */
function or<T>(value: unknown, fallback: T): unknown {
  return truthy(value) ? value : fallback;
}

/** Python's `type(value).__name__` for JSON values. */
function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (Array.isArray(value)) return "list";
  if (isDict(value)) return "dict";
  return typeof value;
}

/** Python's `list(value)`: a dict yields its keys, a str its characters. */
function pyList(value: unknown): unknown[] {
  if (isDict(value)) return Object.keys(value);
  if (typeof value === "string" || Array.isArray(value)) return [...value];
  throw new TypeError(`'${pyTypeName(value)}' object is not iterable`);
}

/** Options for {@link RTVIClientSerializer}. */
export interface RTVIClientSerializerOptions extends Omit<FrameSerializerOptions, "params"> {}

/** Bridge pipeline frames and RTVI wire messages from the client side. */
export class RTVIClientSerializer extends FrameSerializer {
  protected _nextId: number;

  /**
   * Initialize the serializer.
   *
   * @param options Additional arguments passed to `FrameSerializer`.
   */
  constructor(options: RTVIClientSerializerOptions = {}) {
    // We must not ignore RTVI messages: the caller builds RTVI client messages
    // (client-ready, send-text, ...) as transport-message frames for us to emit.
    super({
      ...options,
      params: new FrameSerializer.InputParams({ ignoreRtviMessages: false }),
    });
    this._nextId = 0;
  }

  protected _messageId(): string {
    this._nextId += 1;
    return String(this._nextId);
  }

  /**
   * Serialize an outgoing client frame to an RTVI wire message.
   *
   * @param frame The frame to serialize.
   * @returns The JSON message, or `null` for frames that have no client-side
   *   wire form.
   */
  override async serialize(frame: Frame): Promise<SerializedData | null> {
    // An RTVI client message the caller built directly (client-ready, send-text,
    // dtmf, eval-*): emit its envelope as-is.
    if (
      frame instanceof OutputTransportMessageFrame ||
      frame instanceof OutputTransportMessageUrgentFrame
    ) {
      const message = frame.message;
      if (isDict(message) && get(message, "label") === RTVI.MESSAGE_LABEL) {
        return jsonDumps(message);
      }
      return null;
    }
    // The pipeline's audio output (e.g. the user-side TTS) -> raw-audio to the bot.
    if (frame instanceof OutputAudioRawFrame) {
      return jsonDumps({
        label: RTVI.MESSAGE_LABEL,
        type: "raw-audio",
        id: this._messageId(),
        data: {
          base64Audio: bytesToBase64(frame.audio),
          sampleRate: frame.sampleRate,
          numChannels: frame.numChannels,
        },
      });
    }
    return null;
  }

  /**
   * Deserialize an incoming RTVI server message into a pipeline frame.
   *
   * @param data JSON text (or bytes) sent by the bot.
   * @returns The corresponding frame, or `null` if the message is not an RTVI
   *   message or has no frame mapping yet (handled elsewhere).
   */
  override async deserialize(data: SerializedData): Promise<Frame | null> {
    // Python's json.loads decodes bytes strictly: invalid UTF-8 raises
    // UnicodeDecodeError, which upstream does not catch.
    const text =
      typeof data === "string" || !(data instanceof Uint8Array)
        ? data
        : new TextDecoder("utf-8", { fatal: true }).decode(data);
    let message: unknown;
    try {
      if (typeof text !== "string") {
        throw new TypeError(
          `the JSON object must be str, bytes or bytearray, not ${pyTypeName(text)}`,
        );
      }
      message = pyJsonLoads(text);
    } catch (e) {
      if (!(e instanceof SyntaxError || e instanceof TypeError)) throw e;
      logger.warning(`RTVIClientSerializer: dropping non-JSON message: ${e.message}`);
      return null;
    }

    if (!isDict(message) || get(message, "label") !== RTVI.MESSAGE_LABEL) {
      return null;
    }

    const msgType = get(message, "type");
    const payloadValue = or(get(message, "data"), {});
    // Upstream calls `payload.get(...)` only in the branches that read the
    // payload, and that raises on a non-dict payload; messages that never read
    // it (e.g. `bot-llm-started`) map to their frame whatever `data` holds.
    const payloadDict = (): Dict => {
      if (!isDict(payloadValue)) {
        throw new TypeError(`'${pyTypeName(payloadValue)}' object has no attribute 'get'`);
      }
      return payloadValue;
    };

    switch (msgType) {
      case "bot-llm-started":
        return new LLMFullResponseStartFrame();
      case "bot-llm-text":
        return new LLMTextFrame({ text: get(payloadDict(), "text", "") as string });
      case "bot-llm-marker":
        return new LLMMarkerResponseFrame({
          raw: get(payloadDict(), "raw", "") as string,
          marker: or(get(payloadDict(), "text"), null) as string | null,
          kind: get(payloadDict(), "kind") as string | null,
          markers: pyList(or(get(payloadDict(), "markers"), [])) as string[],
        });
      case "bot-llm-stopped":
        return new LLMFullResponseEndFrame();
      case "bot-tts-text":
        // The message carries only the text; its type (sentence, word)
        // isn't on the wire.
        return new TTSTextFrame({
          text: get(payloadDict(), "text", "") as string,
          textType: TextType.SENTENCE,
        });
      case "bot-started-speaking":
        return new BotStartedSpeakingFrame();
      case "bot-stopped-speaking":
        return new BotStoppedSpeakingFrame();
      case "bot-interrupted":
        return new InterruptionFrame();
      case "llm-function-call-in-progress":
        // function_name/arguments may be absent at the bot's default
        // report level; "" maps back to "no name reported" downstream.
        return new FunctionCallInProgressFrame({
          functionName: or(get(payloadDict(), "function_name"), "") as string,
          toolCallId: get(payloadDict(), "tool_call_id", "") as string,
          arguments: or(get(payloadDict(), "arguments"), {}),
        });
      case "llm-function-call-stopped":
        // A call ends either by being cancelled or by returning; the two
        // map to the frames the bot itself would have pushed.
        if (truthy(get(payloadDict(), "cancelled"))) {
          return new FunctionCallCancelFrame({
            functionName: or(get(payloadDict(), "function_name"), "") as string,
            toolCallId: get(payloadDict(), "tool_call_id", "") as string,
          });
        }
        return new FunctionCallResultFrame({
          functionName: or(get(payloadDict(), "function_name"), "") as string,
          toolCallId: get(payloadDict(), "tool_call_id", "") as string,
          arguments: {},
          result: get(payloadDict(), "result"),
        });
      case "user-transcription": {
        const text = get(payloadDict(), "text", "") as string;
        const userId = get(payloadDict(), "user_id", "") as string;
        const timestamp = get(payloadDict(), "timestamp", "") as string;
        if (truthy(get(payloadDict(), "final", true))) {
          return new TranscriptionFrame({ text, userId, timestamp });
        }
        return new InterimTranscriptionFrame({ text, userId, timestamp });
      }
      default:
        // bot-ready (handshake) and not-yet-mapped messages (metrics, bot
        // audio) are handled elsewhere / later.
        return null;
    }
  }
}
