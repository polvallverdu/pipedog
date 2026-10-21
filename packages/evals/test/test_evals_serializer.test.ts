// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_evals_serializer.py

/** Tests for `EvalSerializer` and `EvalClientSerializer`. */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  InputAudioRawFrame,
  InputTransportMessageFrame,
  LLMFullResponseStartFrame,
  LLMMessagesUpdateFrame,
  OutputAudioRawFrame,
  OutputImageRawFrame,
  OutputTransportMessageUrgentFrame,
  TranscriptionFrame,
  UserImageRawFrame,
  UserImageRequestFrame,
} from "@pipedog/core/frames/frames";
import { RTVIConfigureObserverFrame } from "@pipedog/core/processors/frameworks/rtvi/frames";
import * as RTVI from "@pipedog/core/processors/frameworks/rtvi/models";
import { RTVIFunctionCallReportLevel } from "@pipedog/core/processors/frameworks/rtvi/observer";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { RTVIClientSerializer } from "@pipedog/serializer-rtvi-client/rtvi_client";
import {
  EVAL_BOT_AUDIO_TYPE,
  EVAL_BOT_IMAGE_TYPE,
  EVAL_CONFIGURE_MESSAGE_TYPE,
  EVAL_CONTEXT_MESSAGE_TYPE,
  EVAL_IMAGE_MESSAGE_TYPE,
  EvalClientSerializer,
  EvalConnectionFlags,
  EvalSerializer,
  evalConnectMessage,
  parseEvalConnect,
} from "../src/serializer.ts";

const json = { dumps: pyJsonDumps, loads: pyJsonLoads };

function bytes(...values: number[]) {
  return new Uint8Array(values);
}

function repeat(pattern: number[], times: number): Uint8Array {
  const out = new Uint8Array(pattern.length * times);
  for (let i = 0; i < times; i++) out.set(pattern, i * pattern.length);
  return out;
}

// -- A minimal PNG encoder (upstream builds the image with Pillow) --

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** `Image.new("RGB", (width, height), color).save(buffer, format="PNG")`. */
async function solidPng(width: number, height: number, color: [number, number, number]) {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(color, y * (1 + width * 3) + 1 + x * 3);
  }
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"));
  const idat = new Uint8Array(await new Response(stream).arrayBuffer());
  const parts = [
    bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

describe("TestEvalSerializerDeserialize", () => {
  let serializer: EvalSerializer;

  beforeEach(() => {
    serializer = new EvalSerializer();
  });

  test("test_send_text_wraps_as_transport_message", async () => {
    const msg = {
      label: RTVI.MESSAGE_LABEL,
      type: "send-text",
      id: "1",
      data: { content: "hi" },
    };
    const frame = await serializer.deserialize(json.dumps(msg));
    expect(frame).toBeInstanceOf(InputTransportMessageFrame);
    expect((frame as InputTransportMessageFrame).message).toEqual(msg);
  });

  test("test_raw_audio_wraps_as_transport_message", async () => {
    // raw-audio is forwarded to the RTVIProcessor, which decodes it and
    // pushes an InputAudioRawFrame downstream into the input transport.
    const msg = {
      label: RTVI.MESSAGE_LABEL,
      type: "raw-audio",
      id: "2",
      data: { base64Audio: "AAAA", sampleRate: 16000, numChannels: 1 },
    };
    const frame = await serializer.deserialize(json.dumps(msg));
    expect(frame).toBeInstanceOf(InputTransportMessageFrame);
    expect(((frame as InputTransportMessageFrame).message as { type: string }).type).toEqual(
      "raw-audio",
    );
  });

  test("test_other_rtvi_message_wraps_as_transport_message", async () => {
    const msg = { label: RTVI.MESSAGE_LABEL, type: "client-ready", id: "3", data: {} };
    const frame = await serializer.deserialize(json.dumps(msg));
    expect(frame).toBeInstanceOf(InputTransportMessageFrame);
  });

  test("test_eval_context_short_circuits_to_messages_update", async () => {
    const msg = {
      label: RTVI.MESSAGE_LABEL,
      type: "client-message",
      id: "4",
      data: {
        t: EVAL_CONTEXT_MESSAGE_TYPE,
        d: { messages: [{ role: "system", content: "be terse" }] },
      },
    };
    const frame = await serializer.deserialize(json.dumps(msg));
    expect(frame).toBeInstanceOf(LLMMessagesUpdateFrame);
    expect((frame as LLMMessagesUpdateFrame).messages).toEqual([
      { role: "system", content: "be terse" },
    ]);
    expect((frame as LLMMessagesUpdateFrame).runLlm).toBe(false);
  });

  test("test_eval_configure_short_circuits_to_observer_config", async () => {
    const msg = {
      label: RTVI.MESSAGE_LABEL,
      type: "client-message",
      id: "6",
      data: {
        t: EVAL_CONFIGURE_MESSAGE_TYPE,
        d: { function_call_report_level: { "*": "full" } },
      },
    };
    const frame = await serializer.deserialize(json.dumps(msg));
    expect(frame).toBeInstanceOf(RTVIConfigureObserverFrame);
    expect((frame as RTVIConfigureObserverFrame).functionCallReportLevel).toEqual({
      "*": RTVIFunctionCallReportLevel.FULL,
    });
  });

  test("test_eval_configure_enables_vad_user_speaking", async () => {
    const msg = {
      label: RTVI.MESSAGE_LABEL,
      type: "client-message",
      id: "8",
      data: {
        t: EVAL_CONFIGURE_MESSAGE_TYPE,
        d: { vad_user_speaking: true },
      },
    };
    const frame = (await serializer.deserialize(json.dumps(msg))) as RTVIConfigureObserverFrame;
    expect(frame).toBeInstanceOf(RTVIConfigureObserverFrame);
    expect(frame.vadUserSpeakingEnabled).toBe(true);
    // Unset report level stays None, so it isn't disturbed.
    expect(frame.functionCallReportLevel).toBeNull();
    expect(frame.botLlmMarkerEnabled).toBeNull();
  });

  test("test_eval_configure_enables_llm_markers", async () => {
    const msg = {
      label: RTVI.MESSAGE_LABEL,
      type: "client-message",
      id: "9",
      data: {
        t: EVAL_CONFIGURE_MESSAGE_TYPE,
        d: { llm_markers: true },
      },
    };
    const frame = (await serializer.deserialize(json.dumps(msg))) as RTVIConfigureObserverFrame;
    expect(frame).toBeInstanceOf(RTVIConfigureObserverFrame);
    expect(frame.botLlmMarkerEnabled).toBe(true);
    expect(frame.vadUserSpeakingEnabled).toBeNull();
  });

  test("test_eval_image_stored_and_not_forwarded", async () => {
    const img = new Uint8Array([0x89, ...new TextEncoder().encode("PNG-fake-bytes")]);
    const msg = {
      label: RTVI.MESSAGE_LABEL,
      type: "client-message",
      id: "7",
      data: {
        t: EVAL_IMAGE_MESSAGE_TYPE,
        d: { image: bytesToBase64(img), format: "image/png" },
      },
    };
    // eval-image is consumed (not forwarded) and kept for a later image request.
    expect(await serializer.deserialize(json.dumps(msg))).toBeNull();
    expect(serializer.getUserImage()).toEqual([img, "image/png"]);
  });

  test("test_eval_connect_consumed_and_not_forwarded", async () => {
    const message = evalConnectMessage(new EvalConnectionFlags({ skipTts: true }));
    expect(await serializer.deserialize(message)).toBeNull();
  });

  test("test_user_image_frame_decodes_the_registered_image", async () => {
    const png = await solidPng(4, 3, [255, 0, 0]);
    const msg = {
      label: RTVI.MESSAGE_LABEL,
      type: "client-message",
      id: "7",
      data: {
        t: EVAL_IMAGE_MESSAGE_TYPE,
        d: {
          image: bytesToBase64(png),
          format: "image/png",
        },
      },
    };
    await serializer.deserialize(json.dumps(msg));
    const request = new UserImageRequestFrame({ userId: "user", text: "what is this?" });

    const frame = (await serializer.userImageFrame(request)) as UserImageRawFrame;

    expect(frame).toBeInstanceOf(UserImageRawFrame);
    expect(frame.size).toEqual([4, 3]);
    expect(frame.format).toEqual("RGB");
    expect(frame.image.slice(0, 3)).toEqual(bytes(255, 0, 0));
    expect(frame.request).toBe(request);
  });

  test("test_user_image_frame_without_an_image_is_none", async () => {
    const request = new UserImageRequestFrame({ userId: "user" });
    expect(await serializer.userImageFrame(request)).toBeNull();
  });

  test("test_dtmf_message_forwarded_to_processor", async () => {
    // DTMF is now a first-class RTVI message handled by the RTVIProcessor, so
    // the serializer just forwards it like any other RTVI message.
    const msg = {
      label: RTVI.MESSAGE_LABEL,
      type: "dtmf",
      id: "9",
      data: { button: "#" },
    };
    const frame = await serializer.deserialize(json.dumps(msg));
    expect(frame).toBeInstanceOf(InputTransportMessageFrame);
    expect(((frame as InputTransportMessageFrame).message as { type: string }).type).toEqual(
      "dtmf",
    );
  });

  test("test_non_context_client_message_is_forwarded", async () => {
    const msg = {
      label: RTVI.MESSAGE_LABEL,
      type: "client-message",
      id: "5",
      data: { t: "something-else", d: {} },
    };
    const frame = await serializer.deserialize(json.dumps(msg));
    expect(frame).toBeInstanceOf(InputTransportMessageFrame);
  });

  test("test_non_rtvi_message_dropped", async () => {
    const frame = await serializer.deserialize(json.dumps({ type: "send-text" }));
    expect(frame).toBeNull();
  });

  test("test_non_json_dropped", async () => {
    expect(await serializer.deserialize("not json")).toBeNull();
  });
});

describe("TestEvalSerializerSerialize", () => {
  let serializer: EvalSerializer;

  beforeEach(() => {
    serializer = new EvalSerializer();
  });

  test("test_rtvi_server_message_serialized_to_json", async () => {
    const message = new RTVI.BotLLMStartedMessage().modelDump();
    const frame = new OutputTransportMessageUrgentFrame({ message });
    const payload = await serializer.serialize(frame);
    expect((json.loads(payload as string) as { type: string }).type).toEqual("bot-llm-started");
  });

  test("test_non_rtvi_transport_message_dropped", async () => {
    const frame = new OutputTransportMessageUrgentFrame({ message: { label: "other", type: "x" } });
    expect(await serializer.serialize(frame)).toBeNull();
  });

  test("test_audio_frame_dropped", async () => {
    const frame = new OutputAudioRawFrame({
      audio: bytes(0, 0),
      sampleRate: 16000,
      numChannels: 1,
    });
    expect(await serializer.serialize(frame)).toBeNull();
  });
});

/** The client-side serializer the harness pipeline uses to talk to the bot. */
describe("TestEvalClientSerializer", () => {
  let serializer: EvalClientSerializer;

  beforeEach(() => {
    serializer = new EvalClientSerializer();
  });

  const _server = (msgType: string, data: Record<string, unknown> | null = null): string =>
    json.dumps({ label: RTVI.MESSAGE_LABEL, type: msgType, data });

  test("test_eval_bot_audio_becomes_input_audio", async () => {
    // Already at the harness STT rate (16 kHz): passes through unchanged.
    const pcm = bytes(1, 2, 3, 4);
    const frame = (await serializer.deserialize(
      _server(EVAL_BOT_AUDIO_TYPE, { audio: bytesToBase64(pcm), sampleRate: 16000 }),
    )) as InputAudioRawFrame;
    expect(frame).toBeInstanceOf(InputAudioRawFrame);
    expect(frame.audio).toEqual(pcm);
    expect(frame.sampleRate).toEqual(16000);
    expect(frame.numChannels).toEqual(1);
  });

  test("test_eval_bot_audio_resampled_to_harness_rate", async () => {
    // A different rate is resampled to the harness STT rate for the pipeline VAD/STT.
    const pcm = repeat([0, 0], 480); // 20ms @ 24kHz
    const frame = (await serializer.deserialize(
      _server(EVAL_BOT_AUDIO_TYPE, { audio: bytesToBase64(pcm), sampleRate: 24000 }),
    )) as InputAudioRawFrame;
    expect(frame).toBeInstanceOf(InputAudioRawFrame);
    expect(frame.sampleRate).toEqual(16000);
  });

  test("test_user_transcription_is_dropped", async () => {
    // user-input carries the same transcriptions; the base serializer would
    // make this a TranscriptionFrame, the STT's transcription of the bot's audio.
    const data = { text: "hello", user_id: "u", final: true };
    expect(await serializer.deserialize(_server("user-transcription", data))).toBeNull();
  });

  test("test_bot_output_and_user_input_stay_raw_messages", async () => {
    // Kept as raw messages (not a TranscriptionFrame) so the sink can tell the
    // user's transcriptions apart from the STT's transcription of the bot's
    // audio, and find the backchannels.
    for (const msgType of ["bot-output", "user-input"]) {
      const frame = await serializer.deserialize(_server(msgType, { text: "mhm" }));
      expect(frame).toBeInstanceOf(InputTransportMessageFrame);
      expect(((frame as InputTransportMessageFrame).message as { type: string }).type).toEqual(
        msgType,
      );
    }
  });

  test("test_generic_messages_delegate_to_base", async () => {
    // Non-eval RTVI messages keep the base RTVIClientSerializer mapping.
    expect(await serializer.deserialize(_server("bot-llm-started"))).toBeInstanceOf(
      LLMFullResponseStartFrame,
    );
    expect(await serializer.deserialize(_server("bot-ready"))).toBeNull();
    expect(await serializer.deserialize("not json")).toBeNull();
  });

  test("test_base_no_longer_maps_user_transcription_to_transcription", async () => {
    // Sanity: only the eval subclass diverts user-transcription; the generic
    // base still produces a TranscriptionFrame (unchanged for other clients).
    const frame = await new RTVIClientSerializer().deserialize(
      _server("user-transcription", { text: "hi", final: true }),
    );
    expect(frame).toBeInstanceOf(TranscriptionFrame);
  });
});

/** The bot reports its output images by size and format, only when asked. */
describe("TestEvalSerializerBotImages", () => {
  const _image = (): OutputImageRawFrame =>
    new OutputImageRawFrame({ image: new Uint8Array(12), size: [2, 2], format: "RGB" });

  test("test_image_dropped_by_default", async () => {
    expect(await new EvalSerializer().serialize(_image())).toBeNull();
  });

  test("test_image_reported_when_captured", async () => {
    const serializer = new EvalSerializer();
    serializer.setCaptureImages(true);
    const message = json.loads((await serializer.serialize(_image())) as string) as {
      type: string;
      data: unknown;
    };
    expect(message.type).toEqual(EVAL_BOT_IMAGE_TYPE);
    expect(message.data).toEqual({ width: 2, height: 2, format: "RGB" });
  });
});

/** The bot's image reports reach the harness as raw messages. */
describe("TestEvalClientSerializerBotImages", () => {
  test("test_bot_image_stays_a_raw_message", async () => {
    const frame = await new EvalClientSerializer().deserialize(
      json.dumps({
        label: RTVI.MESSAGE_LABEL,
        type: EVAL_BOT_IMAGE_TYPE,
        data: { width: 2, height: 2 },
      }),
    );
    expect(frame).toBeInstanceOf(InputTransportMessageFrame);
    expect(((frame as InputTransportMessageFrame).message as { type: string }).type).toEqual(
      EVAL_BOT_IMAGE_TYPE,
    );
  });
});

describe("TestEvalConnectMessage", () => {
  test("test_round_trips_its_flags", () => {
    const flags = new EvalConnectionFlags({ skipTts: true, captureBotImages: true });
    const parsed = parseEvalConnect(json.loads(evalConnectMessage(flags)));
    expect(parsed).toEqual(flags);
  });

  test("test_is_an_rtvi_client_message", () => {
    const message = json.loads(evalConnectMessage(new EvalConnectionFlags())) as Record<
      string,
      unknown
    >;
    expect(message.label).toEqual(RTVI.MESSAGE_LABEL);
    expect(message.type).toEqual("client-message");
  });

  test("test_missing_flags_default_off", () => {
    const message = json.loads(evalConnectMessage(new EvalConnectionFlags())) as {
      data: Record<string, unknown>;
    };
    delete message.data.d;
    expect(parseEvalConnect(message)).toEqual(new EvalConnectionFlags());
  });

  test("test_other_messages_are_not_eval_connect", () => {
    expect(parseEvalConnect({ label: RTVI.MESSAGE_LABEL, type: "client-ready" })).toBeNull();
    expect(
      parseEvalConnect({
        label: RTVI.MESSAGE_LABEL,
        type: "client-message",
        data: { t: EVAL_CONTEXT_MESSAGE_TYPE, d: {} },
      }),
    ).toBeNull();
    expect(parseEvalConnect({ event: "start" })).toBeNull();
    expect(parseEvalConnect("not a dict")).toBeNull();
  });
});
