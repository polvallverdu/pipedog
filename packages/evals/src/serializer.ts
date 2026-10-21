// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/serializer.py

/**
 * The two ends of the eval wire.
 *
 * `EvalSerializer` runs in the bot, as the serializer of its
 * `EvalFastAPIWebsocketTransport`; `EvalClientSerializer` runs in the harness,
 * in `EvalClientTransport`. Both speak RTVI. The eval adds messages of its own
 * on top: `eval-connect`, `eval-configure`, `eval-context`, `eval-cancel`, and
 * `eval-image` from the harness, and `eval-bot-audio` and `eval-bot-image` from
 * the bot when the harness asks for them.
 */

import type { BaseAudioResampler } from "@pipedog/core/audio/resamplers/base_audio_resampler";
import { createStreamResampler } from "@pipedog/core/audio/utils";
import {
  CancelWorkerFrame,
  type Frame,
  InputAudioRawFrame,
  InputTransportMessageFrame,
  LLMMessagesUpdateFrame,
  OutputAudioRawFrame,
  OutputImageRawFrame,
  OutputTransportMessageFrame,
  OutputTransportMessageUrgentFrame,
  UserImageRawFrame,
  type UserImageRequestFrame,
} from "@pipedog/core/frames/frames";
import type { LLMContextMessage } from "@pipedog/core/processors/aggregators/llm_context";
import { RTVIConfigureObserverFrame } from "@pipedog/core/processors/frameworks/rtvi/frames";
import * as RTVI from "@pipedog/core/processors/frameworks/rtvi/models";
import { RTVIFunctionCallReportLevel } from "@pipedog/core/processors/frameworks/rtvi/observer";
import {
  FrameSerializer,
  type FrameSerializerOptions,
  type SerializedData,
} from "@pipedog/core/serializers/base_serializer";
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import {
  RTVIClientSerializer,
  type RTVIClientSerializerOptions,
} from "@pipedog/serializer-rtvi-client/rtvi_client";

// A `client-message` with this `t` is the first message the harness sends on
// every connection, carrying the connection's flags (`EvalConnectionFlags`).
// On a WebSocket the bot accepted itself, as on Pipecat Cloud, it is how
// `createTransport` recognizes an eval and how the flags reach the bot, since
// only the session body survives the hops in between. The serializer consumes it.
export const EVAL_CONNECT_MESSAGE_TYPE = "eval-connect";

// A `client-message` with this `t` is intercepted by the serializer and
// turned into an `LLMMessagesUpdateFrame` instead of being forwarded to the
// RTVIProcessor. Keeps per-eval context seeding out of the bot.
export const EVAL_CONTEXT_MESSAGE_TYPE = "eval-context";

// A `client-message` with this `t` is intercepted and turned into an
// `RTVIConfigureObserverFrame`. This is the trust boundary for raising the
// function-call report level: only the eval transport understands it, so a
// production RTVI serializer can't be elevated by a remote client.
export const EVAL_CONFIGURE_MESSAGE_TYPE = "eval-configure";

// A `client-message` with this `t` is intercepted and turned into a
// `CancelWorkerFrame`, so the harness can end a scenario by gracefully tearing down the
// bot's pipeline (closing its service connections) instead of the orchestrator
// having to kill the process.
export const EVAL_CANCEL_MESSAGE_TYPE = "eval-cancel";

// A `client-message` with this `t` registers an image (base64-encoded
// PNG/JPEG/... bytes plus its MIME `format`) on the serializer. The eval input
// transport hands it back as a `UserImageRawFrame` when the bot asks for a user
// image (`UserImageRequestFrame`), so a function-calling-video bot can be driven
// without a real camera. The harness sends the image encoded over the wire; the
// eval input transport decodes it and pushes a raw `UserImageRawFrame` (matching
// a real camera transport).
export const EVAL_IMAGE_MESSAGE_TYPE = "eval-image";

// Outbound message carrying a chunk of the bot's synthesized audio (base64), used
// only when a scenario asserts on `tts_response`. Emitted under the RTVI label
// so the harness reader sees it; the harness transcribes the audio locally.
export const EVAL_BOT_AUDIO_TYPE = "eval-bot-audio";

// Outbound message describing an image the bot output (its size and color
// format, not its pixels), used only when a scenario asserts on `image`.
export const EVAL_BOT_IMAGE_TYPE = "eval-bot-image";

// Rate the harness resamples the bot's audio to before its pipeline VAD/STT see
// it. 16 kHz is what Silero and the local STT models (Whisper/Moonshine) expect;
// the harness configures its input transport at this rate to match.
export const EVAL_STT_SAMPLE_RATE = 16000;

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

/** Python's `json.loads(data)` for `str | bytes`. */
function jsonLoads(data: SerializedData): unknown {
  if (typeof data === "string") return pyJsonLoads(data);
  if (data instanceof Uint8Array) {
    // Python decodes bytes strictly: invalid UTF-8 raises UnicodeDecodeError,
    // which the callers do not catch (it is neither a JSON nor a type error).
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch (e) {
      throw new Error(`UnicodeDecodeError: ${e}`);
    }
    return pyJsonLoads(text);
  }
  throw new TypeError("the JSON object must be str, bytes or bytearray");
}

/** Pydantic's lax `bool` validation. */
function validateBool(name: string, value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (["0", "off", "f", "false", "n", "no"].includes(v)) return false;
    if (["1", "on", "t", "true", "y", "yes"].includes(v)) return true;
  }
  throw new Error(
    `1 validation error for EvalConnectionFlags\n${name}\n  Input should be a valid boolean`,
  );
}

/** Options for {@link EvalConnectionFlags}. */
export interface EvalConnectionFlagsOptions {
  /** Silence the bot's speech for the connection (text mode). */
  skipTts?: boolean;
  /** Forward the bot's synthesized audio to the harness. */
  captureBotAudio?: boolean;
  /** Report the images the bot outputs to the harness. */
  captureBotImages?: boolean;
}

/**
 * What one eval connection asks of the bot, sent in the `eval-connect` message.
 *
 * - `skipTts`: Silence the bot's speech for the connection (text mode).
 * - `captureBotAudio`: Forward the bot's synthesized audio to the harness.
 * - `captureBotImages`: Report the images the bot outputs to the harness.
 */
export class EvalConnectionFlags {
  skipTts: boolean;
  captureBotAudio: boolean;
  captureBotImages: boolean;

  constructor(options: EvalConnectionFlagsOptions = {}) {
    this.skipTts = options.skipTts ?? false;
    this.captureBotAudio = options.captureBotAudio ?? false;
    this.captureBotImages = options.captureBotImages ?? false;
  }

  /** The flags as their wire (snake_case) dict, pydantic's `model_dump()`. */
  modelDump(): { skip_tts: boolean; capture_bot_audio: boolean; capture_bot_images: boolean } {
    return {
      skip_tts: this.skipTts,
      capture_bot_audio: this.captureBotAudio,
      capture_bot_images: this.captureBotImages,
    };
  }

  /**
   * Validate wire (snake_case) data into flags, pydantic's `model_validate()`.
   * Missing keys default off; unknown keys are ignored.
   */
  static modelValidate(data: unknown): EvalConnectionFlags {
    if (data instanceof EvalConnectionFlags) return data;
    if (!isDict(data)) {
      throw new Error(
        "1 validation error for EvalConnectionFlags\n  Input should be a valid dictionary or instance of EvalConnectionFlags",
      );
    }
    const flag = (key: string): boolean | undefined =>
      Object.hasOwn(data, key) ? validateBool(key, data[key]) : undefined;
    return new EvalConnectionFlags({
      skipTts: flag("skip_tts"),
      captureBotAudio: flag("capture_bot_audio"),
      captureBotImages: flag("capture_bot_images"),
    });
  }
}

/** The `eval-connect` message carrying `flags`, as JSON text. */
export function evalConnectMessage(flags: EvalConnectionFlags): string {
  const message = new RTVI.Message({
    type: "client-message",
    id: EVAL_CONNECT_MESSAGE_TYPE,
    data: { t: EVAL_CONNECT_MESSAGE_TYPE, d: flags.modelDump() },
  });
  // pydantic's `model_dump_json()`: compact JSON, as `JSON.stringify` writes it.
  return JSON.stringify(message.modelDump());
}

/**
 * The flags of an `eval-connect` message, or `null` for any other message.
 *
 * @param message A decoded JSON message.
 */
export function parseEvalConnect(message: unknown): EvalConnectionFlags | null {
  if (!isDict(message) || get(message, "label") !== RTVI.MESSAGE_LABEL) {
    return null;
  }
  if (get(message, "type") !== "client-message") {
    return null;
  }
  const data = get(message, "data");
  if (!isDict(data) || get(data, "t") !== EVAL_CONNECT_MESSAGE_TYPE) {
    return null;
  }
  const payload = get(data, "d");
  return EvalConnectionFlags.modelValidate(isDict(payload) ? payload : {});
}

/** A decoded image: interleaved RGB pixels and the image's size. */
export interface EvalDecodedImage {
  /** Raw RGB pixel bytes. */
  image: Uint8Array;
  /** Image dimensions as [width, height]. */
  size: [number, number];
}

/**
 * Decodes encoded image bytes to RGB pixels (Pillow's
 * `Image.open(io.BytesIO(data)).convert("RGB")`).
 *
 * @param data The encoded image bytes.
 * @param format The MIME type the harness sent with them.
 */
export type EvalImageDecoder = (data: Uint8Array, format: string) => Promise<EvalDecodedImage>;

/** Options for {@link EvalSerializer}. */
export interface EvalSerializerOptions extends Omit<FrameSerializerOptions, "params"> {
  /**
   * Decodes the harness's image for `userImageFrame`. Defaults to a built-in
   * PNG decoder; pass one (e.g. built on `sharp` or `@jsquash/*`) for JPEG or
   * other formats.
   */
  imageDecoder?: EvalImageDecoder | null;
}

/**
 * Bridges RTVI messages and frames on the bot's side of an eval.
 *
 * The serializer of `EvalFastAPIWebsocketTransport`; `EvalClientSerializer` is
 * the harness's end. The bot pipeline needs an `RTVIProcessor` and an
 * `RTVIObserver`.
 */
export class EvalSerializer extends FrameSerializer {
  protected _captureAudio: boolean;
  protected _captureImages: boolean;
  protected _userImage: [Uint8Array, string] | null;
  protected _imageDecoder: EvalImageDecoder;

  /**
   * Initialize the serializer.
   *
   * @param options Additional arguments passed to `FrameSerializer`.
   */
  constructor(options: EvalSerializerOptions = {}) {
    // Do not ignore RTVI messages: the whole point is to put them on the
    // wire so the harness can observe semantic events.
    super({ ...options, params: new FrameSerializer.InputParams({ ignoreRtviMessages: false }) });
    // Off by default; the eval transport flips this on per connection (from
    // its capture_bot_audio flag) only for tts_response scenarios, so we
    // don't ship the bot's audio over the wire unless something asserts on it.
    this._captureAudio = false;
    // Off by default like the audio; the eval transport flips it on per
    // connection (from its capture_bot_images flag) for scenarios
    // that assert on `image`, so a bot animating its video output doesn't
    // flood the harness.
    this._captureImages = false;
    // The most recent image the harness registered (still-encoded bytes, MIME
    // type), served back on a UserImageRequestFrame. See EVAL_IMAGE_MESSAGE_TYPE.
    this._userImage = null;
    // DIVERGENCE: upstream decodes with Pillow (any format). There is no
    // edge-compatible JS image decoder in pipedog, so the default decodes PNG
    // only (with the runtime's DecompressionStream); other formats need an
    // injected `imageDecoder`.
    this._imageDecoder = options.imageDecoder ?? decodePng;
  }

  /** Enable/disable forwarding the bot's synthesized audio to the harness. */
  setCaptureAudio(capture: boolean): void {
    this._captureAudio = capture;
  }

  /** Enable/disable reporting the images the bot outputs to the harness. */
  setCaptureImages(capture: boolean): void {
    this._captureImages = capture;
  }

  /** The image registered for the current turn as `[bytes, mime]`, or null. */
  getUserImage(): [Uint8Array, string] | null {
    return this._userImage;
  }

  /**
   * The registered image as the frame answering `request`, or `null` if none is registered.
   *
   * The harness sends the image encoded, but a real camera transport pushes
   * raw frames, so it is decoded to raw RGB. The LLM context re-encodes raw
   * frames to JPEG anyway, and consumers that decode directly (e.g. a local
   * vision model) need the raw pixels and real size.
   */
  async userImageFrame(request: UserImageRequestFrame): Promise<UserImageRawFrame | null> {
    if (this._userImage === null) {
      return null;
    }
    const [data, fmt] = this._userImage;
    const decoded = await this._imageDecoder(data, fmt);
    return new UserImageRawFrame({
      image: decoded.image,
      size: decoded.size,
      format: "RGB",
      userId: request.userId,
      text: request.text,
      appendToContext: request.appendToContext,
      request,
    });
  }

  /**
   * Serialize an outbound frame for the harness; only RTVI server messages go out.
   *
   * @param frame The frame to serialize.
   * @returns JSON text for an RTVI server message, or `null` to drop the frame.
   */
  override async serialize(frame: Frame): Promise<SerializedData | null> {
    if (
      frame instanceof OutputTransportMessageFrame ||
      frame instanceof OutputTransportMessageUrgentFrame
    ) {
      const message = frame.message;
      if (isDict(message) && get(message, "label") === RTVI.MESSAGE_LABEL) {
        return pyJsonDumps(message);
      }
    } else if (this._captureAudio && frame instanceof OutputAudioRawFrame) {
      return pyJsonDumps({
        label: RTVI.MESSAGE_LABEL,
        type: EVAL_BOT_AUDIO_TYPE,
        data: {
          audio: bytesToBase64(frame.audio),
          sampleRate: frame.sampleRate,
        },
      });
    } else if (this._captureImages && frame instanceof OutputImageRawFrame) {
      const [width, height] = frame.size;
      return pyJsonDumps({
        label: RTVI.MESSAGE_LABEL,
        type: EVAL_BOT_IMAGE_TYPE,
        data: { width, height, format: frame.format },
      });
    }
    return null;
  }

  /**
   * Deserialize an inbound JSON RTVI message into a frame.
   *
   * @param data JSON text (or bytes) sent by the harness.
   * @returns An `LLMMessagesUpdateFrame` for the eval-context control message, an
   *   `InputTransportMessageFrame` wrapping any other RTVI message, or `null` if
   *   the payload is not a valid RTVI message.
   */
  override async deserialize(data: SerializedData): Promise<Frame | null> {
    let message: unknown;
    try {
      message = jsonLoads(data);
    } catch (e) {
      if (!(e instanceof SyntaxError || e instanceof TypeError)) throw e;
      logger.warning(`EvalSerializer: dropping non-JSON message: ${e.message}`);
      return null;
    }

    if (!isDict(message) || get(message, "label") !== RTVI.MESSAGE_LABEL) {
      logger.warning(`EvalSerializer: ignoring non-RTVI message: ${pyJsonDumps(message)}`);
      return null;
    }

    // The transport already applied the connection's flags from this message
    // when it was built.
    if (parseEvalConnect(message) !== null) {
      return null;
    }

    const context = this._maybeContextFrame(message);
    if (context !== null) {
      return context;
    }

    const configure = this._maybeConfigureFrame(message);
    if (configure !== null) {
      return configure;
    }

    const cancel = this._maybeCancelFrame(message);
    if (cancel !== null) {
      return cancel;
    }

    if (this._maybeStoreImage(message)) {
      return null;
    }

    return new InputTransportMessageFrame({ message });
  }

  /** The eval control message's `data` dict when it is a `client-message` with `t`, else null. */
  private _controlData(message: Dict, t: string): Dict | null {
    if (get(message, "type") !== "client-message") {
      return null;
    }
    const data = or(get(message, "data"), {});
    if (!isDict(data) || get(data, "t") !== t) {
      return null;
    }
    return data;
  }

  /** Return an `LLMMessagesUpdateFrame` for the eval-context message, else null. */
  protected _maybeContextFrame(message: Dict): Frame | null {
    const data = this._controlData(message, EVAL_CONTEXT_MESSAGE_TYPE);
    if (data === null) {
      return null;
    }
    const payload = or(get(data, "d"), {});
    const messages = isDict(payload) ? get(payload, "messages", []) : [];
    // run_llm=False: seed the context, don't trigger a response.
    return new LLMMessagesUpdateFrame({
      messages: [...(messages as LLMContextMessage[])],
      runLlm: false,
    });
  }

  /** The frame for an eval-cancel message, else null: it cancels the whole pipeline so the bot exits on its own. */
  protected _maybeCancelFrame(message: Dict): Frame | null {
    if (this._controlData(message, EVAL_CANCEL_MESSAGE_TYPE) === null) {
      return null;
    }
    return new CancelWorkerFrame();
  }

  /** Keep the image from an eval-image message for the input transport to serve; true when consumed. */
  protected _maybeStoreImage(message: Dict): boolean {
    const data = this._controlData(message, EVAL_IMAGE_MESSAGE_TYPE);
    if (data === null) {
      return false;
    }
    const payload = or(get(data, "d"), {});
    const encoded = isDict(payload) ? get(payload, "image") : null;
    if (truthy(encoded) && isDict(payload)) {
      const fmt = String(or(get(payload, "format"), "image/jpeg"));
      this._userImage = [base64ToBytes(encoded as string), fmt];
    }
    return true;
  }

  /** Return an `RTVIConfigureObserverFrame` for the eval-configure message, else null. */
  protected _maybeConfigureFrame(message: Dict): Frame | null {
    const data = this._controlData(message, EVAL_CONFIGURE_MESSAGE_TYPE);
    if (data === null) {
      return null;
    }
    let payload = or(get(data, "d"), {});
    if (!isDict(payload)) {
      payload = {};
    }
    const p = payload as Dict;
    const levels = get(p, "function_call_report_level");
    let reportLevel: Record<string, RTVIFunctionCallReportLevel> | null = null;
    if (isDict(levels)) {
      // Values arrive as strings ("none"/"name"/"full"); coerce to the enum.
      const valid = Object.values(RTVIFunctionCallReportLevel) as unknown[];
      reportLevel = Object.fromEntries(
        Object.entries(levels).map(([k, v]) => {
          if (!valid.includes(v)) {
            throw new Error(`${pyJsonDumps(v)} is not a valid RTVIFunctionCallReportLevel`);
          }
          return [k, v as RTVIFunctionCallReportLevel];
        }),
      );
    }
    const vad = get(p, "vad_user_speaking");
    const vadUserSpeakingEnabled = vad !== null ? truthy(vad) : null;
    const markers = get(p, "llm_markers");
    const botLlmMarkerEnabled = markers !== null ? truthy(markers) : null;
    return new RTVIConfigureObserverFrame({
      functionCallReportLevel: reportLevel,
      vadUserSpeakingEnabled,
      botLlmMarkerEnabled,
    });
  }
}

// The bot's reports about *the user it is talking to* (i.e. about the harness):
// its raw VAD, turn-level speaking, and the transcription of what it heard. The
// harness surfaces these as scenario events, but does not let them drive its own
// pipeline. They are kept as raw messages (mapped to events by the sink) for two
// reasons: a `TranscriptionFrame` in the eval pipeline already means "our STT
// transcribed the bot's audio" (the `response`), and the VAD/speaking frames are
// computed locally by the harness's own user aggregator from the bot's audio (a
// different signal than the bot's VAD on the harness's audio). Routing the reports
// as messages keeps both sides available without colliding by frame type.
const _REPORTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "user-started-speaking",
  "user-stopped-speaking",
  "vad-user-started-speaking",
  "vad-user-stopped-speaking",
  // The bot reporting *its* output was interrupted. Kept as a message so it
  // doesn't become an InterruptionFrame, which the harness's own user
  // aggregator already broadcasts when our VAD detects the bot speaking.
  "bot-interrupted",
  // What the bot said, read for its backchannels, and what the user said:
  // its transcriptions and backchannels.
  "bot-output",
  "user-input",
]);

/**
 * The harness's serializer: RTVI client messages, plus the eval's own.
 *
 * `eval-bot-audio` becomes an `InputAudioRawFrame` so the harness's STT
 * can transcribe what the bot actually said. The bot's reports about the
 * harness (its transcription, VAD, and speaking messages) stay raw messages
 * rather than becoming frames, so they cannot be mistaken for what the
 * harness computes from the bot's audio. So does `eval-bot-image`, which
 * has no frame on the harness's side to become. The deprecated
 * `user-transcription` is dropped: `user-input` carries the same
 * transcriptions.
 */
export class EvalClientSerializer extends RTVIClientSerializer {
  // Lazily created on the first bot-audio chunk; resamples the bot's audio to
  // EVAL_STT_SAMPLE_RATE for the pipeline's VAD/STT.
  protected _resampler: BaseAudioResampler | null = null;

  /**
   * Initialize the serializer.
   *
   * @param options Additional arguments passed to `RTVIClientSerializer`.
   */
  constructor(options: RTVIClientSerializerOptions = {}) {
    super(options);
  }

  /**
   * Deserialize an RTVI server message, handling the eval-specific types.
   *
   * @param data JSON text (or bytes) sent by the bot.
   * @returns The corresponding frame, or `null` to drop the message.
   */
  override async deserialize(data: SerializedData): Promise<Frame | null> {
    let message: unknown;
    try {
      message = jsonLoads(data);
    } catch (e) {
      if (!(e instanceof SyntaxError || e instanceof TypeError)) throw e;
      return await super.deserialize(data);
    }

    if (isDict(message) && get(message, "label") === RTVI.MESSAGE_LABEL) {
      const msgType = get(message, "type");
      if (msgType === EVAL_BOT_AUDIO_TYPE) {
        const payload = or(get(message, "data"), {}) as Dict;
        let audio: Uint8Array = base64ToBytes(get(payload, "audio", "") as string);
        let sampleRate = Math.trunc(Number(get(payload, "sampleRate", 0)));
        if (sampleRate && sampleRate !== EVAL_STT_SAMPLE_RATE && audio.length > 0) {
          audio = await this._resample(audio, sampleRate);
          sampleRate = EVAL_STT_SAMPLE_RATE;
        }
        return new InputAudioRawFrame({ audio, sampleRate, numChannels: 1 });
      }
      if (msgType === "user-transcription") {
        return null;
      }
      if (
        (typeof msgType === "string" && _REPORTED_EVENT_TYPES.has(msgType)) ||
        msgType === EVAL_BOT_IMAGE_TYPE
      ) {
        // Kept as the raw message so the sink maps it to a scenario event;
        // see the class docstring for why these aren't frames.
        return new InputTransportMessageFrame({ message });
      }
    }

    return await super.deserialize(data);
  }

  /** Resample the bot's audio to the STT rate, with a stream resampler so chunk boundaries do not garble it. */
  protected async _resample(audio: Uint8Array, inRate: number): Promise<Uint8Array> {
    if (this._resampler === null) {
      this._resampler = createStreamResampler();
    }
    return await this._resampler.resample(audio, inRate, EVAL_STT_SAMPLE_RATE);
  }
}

//
// PNG decoding (the default `EvalImageDecoder`).
//

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Channels per PNG color type. */
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode a non-interlaced PNG to RGB, as Pillow's `.convert("RGB")` does:
 * alpha is dropped, grayscale is widened, palettes are looked up, and 16-bit
 * samples keep their high byte (16-bit grayscale is clipped to 255, as
 * Pillow's `I;16` to `RGB` conversion does).
 */
async function decodePng(data: Uint8Array, format: string): Promise<EvalDecodedImage> {
  if (data.length < 8 || PNG_SIGNATURE.some((b, i) => data[i] !== b)) {
    throw new Error(
      `cannot identify image file (format ${format}): the default EvalSerializer image decoder only decodes PNG; pass an \`imageDecoder\` option`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let pos = 8;
  while (pos + 8 <= data.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...data.subarray(pos + 4, pos + 8));
    const body = data.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === "IHDR") {
      const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = v.getUint32(0);
      height = v.getUint32(4);
      bitDepth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === "PLTE") {
      palette = body;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
  }
  const channels = PNG_CHANNELS[colorType];
  if (channels === undefined || width === 0 || height === 0) {
    throw new Error("broken PNG file");
  }
  if (interlace !== 0) {
    throw new Error("interlaced PNG is not supported; pass an `imageDecoder` option");
  }
  let total = 0;
  for (const chunk of idat) total += chunk.length;
  const compressed = new Uint8Array(total);
  let offset = 0;
  for (const chunk of idat) {
    compressed.set(chunk, offset);
    offset += chunk.length;
  }
  const raw = await inflate(compressed);

  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  if (raw.length < height * (stride + 1)) {
    throw new Error("image file is truncated");
  }
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x]!;
      const a = x >= bpp ? pixels[dst + x - bpp]! : 0;
      const b = y > 0 ? pixels[prev + x]! : 0;
      const c = x >= bpp && y > 0 ? pixels[prev + x - bpp]! : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + a;
          break;
        case 2:
          out = value + b;
          break;
        case 3:
          out = value + ((a + b) >> 1);
          break;
        case 4:
          out = value + paeth(a, b, c);
          break;
        default:
          throw new Error(`unknown PNG filter type ${filter}`);
      }
      pixels[dst + x] = out & 0xff;
    }
  }

  // Sample `i` (0-based channel index across the row) of row `y`, as 8 bits.
  const sample = (y: number, i: number): number => {
    const row = y * stride;
    if (bitDepth === 8) return pixels[row + i]!;
    if (bitDepth === 16) {
      const hi = pixels[row + i * 2]!;
      if (colorType === 0) return hi > 0 ? 255 : pixels[row + i * 2 + 1]!;
      return hi;
    }
    const bit = i * bitDepth;
    const value = (pixels[row + (bit >> 3)]! >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
    // Palette indices stay indices; grayscale is scaled to 8 bits.
    return colorType === 3 ? value : (value * 255) / ((1 << bitDepth) - 1);
  };

  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      if (colorType === 2 || colorType === 6) {
        rgb[o] = sample(y, x * channels);
        rgb[o + 1] = sample(y, x * channels + 1);
        rgb[o + 2] = sample(y, x * channels + 2);
      } else if (colorType === 3) {
        if (palette === null) throw new Error("broken PNG file: missing palette");
        const index = sample(y, x);
        rgb[o] = palette[index * 3] ?? 0;
        rgb[o + 1] = palette[index * 3 + 1] ?? 0;
        rgb[o + 2] = palette[index * 3 + 2] ?? 0;
      } else {
        const gray = sample(y, x * channels);
        rgb[o] = rgb[o + 1] = rgb[o + 2] = gray;
      }
    }
  }
  return { image: rgb, size: [width, height] };
}
