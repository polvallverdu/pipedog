// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/serializers/protobuf.py

/** Protobuf frame serialization for Pipecat. */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import {
  type Frame,
  InputAudioRawFrame,
  InputTransportMessageFrame,
  InterruptionFrame,
  OutputAudioRawFrame,
  OutputTransportMessageFrame,
  OutputTransportMessageUrgentFrame,
  TextFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import * as frame_protos from "@pipedog/core/frames/protobufs/frames_pb2";
import {
  FrameSerializer,
  type FrameSerializerOptions,
  type SerializedData,
} from "@pipedog/core/serializers/base_serializer";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps as jsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";

export interface MessageFrameOptions {
  /** JSON-encoded message data for transport. */
  data: string;
}

/**
 * Data class for converting transport messages into Protobuf format.
 *
 * - `data`: JSON-encoded message data for transport.
 */
export class MessageFrame {
  data: string;

  constructor(options: MessageFrameOptions) {
    this.data = options.data;
  }

  toString(): string {
    return `MessageFrame(data=${JSON.stringify(this.data)})`;
  }
}

// `any` here: constructor types must accept any argument list (Python looks frames up by `type(frame)`).
type AnyCtor = abstract new (...args: any[]) => unknown;
type ConcreteCtor = new (options: any) => Frame | MessageFrame;

/** Python's truthiness, for the values a frame field can hold. */
function isTruthy(value: unknown): boolean {
  if (value instanceof Uint8Array) {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Boolean(value);
}

/**
 * Serializer for converting Pipecat frames to/from Protocol Buffer format.
 *
 * Provides efficient binary serialization for frame transport over network
 * connections. Supports text, audio, transcription, and message frames with
 * automatic conversion between transport message types.
 */
export class ProtobufFrameSerializer extends FrameSerializer {
  static readonly SERIALIZABLE_TYPES: ReadonlyMap<AnyCtor, frame_protos.FrameOneofName> = new Map<
    AnyCtor,
    frame_protos.FrameOneofName
  >([
    [TextFrame, "text"],
    [OutputAudioRawFrame, "audio"],
    [TranscriptionFrame, "transcription"],
    [MessageFrame, "message"],
    [InterruptionFrame, "interruption"],
  ]);
  static readonly SERIALIZABLE_FIELDS: ReadonlyMap<frame_protos.FrameOneofName, AnyCtor> = new Map(
    [...ProtobufFrameSerializer.SERIALIZABLE_TYPES].map(([k, v]) => [v, k]),
  );

  static readonly DESERIALIZABLE_TYPES: ReadonlyMap<ConcreteCtor, frame_protos.FrameOneofName> =
    new Map<ConcreteCtor, frame_protos.FrameOneofName>([
      [TextFrame, "text"],
      [InputAudioRawFrame, "audio"],
      [TranscriptionFrame, "transcription"],
      [MessageFrame, "message"],
      [InterruptionFrame, "interruption"],
    ]);
  static readonly DESERIALIZABLE_FIELDS: ReadonlyMap<string, ConcreteCtor> = new Map(
    [...ProtobufFrameSerializer.DESERIALIZABLE_TYPES].map(([k, v]) => [v, k]),
  );

  /**
   * Initialize the Protobuf frame serializer.
   *
   * @param options.params Configuration parameters.
   */
  constructor(options: FrameSerializerOptions = {}) {
    super(options);
    // The base serializer defaults to filtering out RTVI protocol messages
    // to avoid sending them over telephony media streams. ProtobufFrameSerializer
    // is used by WebSocket transports, which are the delivery channel for
    // these messages, so we disable the filter.
    this._params.ignoreRtviMessages = false;
  }

  /**
   * Serialize a frame to Protocol Buffer binary format.
   *
   * @param frame The frame to serialize.
   * @returns Serialized frame as bytes, or null if frame type is not serializable.
   */
  async serialize(frame: Frame): Promise<SerializedData | null> {
    // Wrapping this messages as a JSONFrame to send
    let serializable: Frame | MessageFrame = frame;
    if (
      frame instanceof OutputTransportMessageFrame ||
      frame instanceof OutputTransportMessageUrgentFrame
    ) {
      if (this.shouldIgnoreFrame(frame)) {
        return null;
      }
      serializable = new MessageFrame({
        data: jsonDumps(frame.message),
      });
    }

    const protoFrame = new frame_protos.Frame();
    const ctor = serializable.constructor as AnyCtor;
    const protoOptionalName = ProtobufFrameSerializer.SERIALIZABLE_TYPES.get(ctor);
    if (protoOptionalName === undefined) {
      logger.warning(`Frame type ${ctor.name} is not serializable`);
      return null;
    }

    // As protobuf's `getattr(proto_frame, name)`: the submessage only becomes
    // the oneof's member once one of its fields is set.
    const protoField = frame_protos.Frame.DESCRIPTOR.fieldsByName[protoOptionalName];
    const ProtoType = PROTO_TYPES[protoOptionalName];
    // Casts: Python sets and reads fields by name with getattr/setattr, genuinely dynamic.
    const protoAttr = new ProtoType() as unknown as Record<string, unknown>;
    const source = serializable as unknown as Record<string, unknown>;
    let anySet = false;
    for (const field of protoField?.messageType?.fields ?? []) {
      if (!(field.attr in source)) {
        continue;
      }
      const value = source[field.attr];
      if (isTruthy(value)) {
        protoAttr[field.attr] = value;
        anySet = true;
      }
    }
    if (anySet) {
      (protoFrame as unknown as Record<string, unknown>)[protoOptionalName] = protoAttr;
    }

    return protoFrame.serializeToString();
  }

  /**
   * Deserialize Protocol Buffer binary data to a frame.
   *
   * @param data Binary protobuf data to deserialize.
   * @returns Deserialized frame instance, or null if deserialization fails.
   */
  async deserialize(data: SerializedData): Promise<Frame | null> {
    if (typeof data === "string") {
      // As protobuf's `FromString`, which only accepts bytes.
      throw new TypeError("a bytes-like object is required, not 'str'");
    }
    const proto = frame_protos.Frame.fromString(data);
    const which = proto.whichOneof("frame");
    const className =
      which === null ? undefined : ProtobufFrameSerializer.DESERIALIZABLE_FIELDS.get(which);
    if (which === null || className === undefined) {
      logger.error("Unable to deserialize a valid frame");
      return null;
    }

    // Cast: Python reads the oneof member via getattr(proto, which), genuinely dynamic.
    const args = proto[which] as unknown as Record<string, unknown>;
    const argsDict: Record<string, unknown> = {};
    for (const field of frame_protos.Frame.DESCRIPTOR.fieldsByName[which]?.messageType?.fields ??
      []) {
      argsDict[field.attr] = args[field.attr];
    }

    // Remove special fields if needed
    const id = args.id as number | undefined;
    const name = args.name as string | undefined;
    const pts = args.pts as number | null | undefined;
    delete argsDict.id;
    delete argsDict.name;
    delete argsDict.pts;

    let instance: Frame;
    // Special handling for MessageFrame -> InputTransportMessageFrame
    if (className === MessageFrame) {
      try {
        const msg = pyJsonLoads(argsDict.data as string);
        instance = new InputTransportMessageFrame({ message: msg });
        logger.debug(`ProtobufFrameSerializer: Transport message ${instance}`);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`Error parsing MessageFrame data: ${e instanceof Error ? e.message : e}`);
        return null;
      }
    } else {
      // Normal deserialization, create the instance
      instance = new className(argsDict) as Frame;
    }

    // Set special fields
    if (id) {
      instance.id = id;
    }
    if (name) {
      instance.name = name;
    }
    if (pts) {
      instance.pts = pts;
    }

    return instance;
  }
}

const PROTO_TYPES: Record<frame_protos.FrameOneofName, new () => frame_protos.Message> = {
  text: frame_protos.TextFrame,
  audio: frame_protos.AudioRawFrame,
  transcription: frame_protos.TranscriptionFrame,
  message: frame_protos.MessageFrame,
  interruption: frame_protos.InterruptionFrame,
};
