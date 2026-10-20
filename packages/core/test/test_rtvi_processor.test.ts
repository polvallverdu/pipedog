// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rtvi_processor.py

import { afterEach, beforeEach, describe, expect, type Mock, mock, test } from "bun:test";

import { Queue } from "@pipedog/asyncio";
import { KeypadEntry } from "../src/audio/dtmf/types.ts";
import {
  type Frame,
  InputAudioRawFrame,
  InputDTMFFrame,
  InputTransportMessageFrame,
  type InputTransportMessageFrameOptions,
  InputTransportStartAudioStreamingFrame,
  LLMConfigureOutputFrame,
  LLMMessagesAppendFrame,
  UserFileRawFrame,
  UserImageRawFrame,
} from "../src/frames/frames.ts";
import { RTVISendTextFrame } from "../src/processors/frameworks/rtvi/frames.ts";
import * as RTVI from "../src/processors/frameworks/rtvi/models.ts";
import { RTVIProcessor } from "../src/processors/frameworks/rtvi/processor.ts";

type AnyMock = Mock<(...args: any[]) => any>;

/**
 * View of the processor's protected members, which the upstream tests
 * reach into (and monkeypatch) directly.
 */
interface Internals {
  _sendErrorResponse: AnyMock;
  setClientReady: AnyMock;
  pushFrame: AnyMock;
  interruptBot: AnyMock;
  _clientVersion: number[];
  _messageQueue: Queue<[RTVI.Message, string | null]>;
  _handleClientReady(requestId: string, data: RTVI.ClientReadyData | null): Promise<void>;
  _handleAudioBuffer(data: unknown): Promise<void>;
  _handleDtmf(data: RTVI.DTMFInputData): Promise<void>;
  _handleSendFile(data: RTVI.SendFileData, messageId: string): Promise<void>;
  _handleSendText(data: RTVI.SendTextData, messageId: string): Promise<void>;
  _handleTransportMessage(frame: InputTransportMessageFrame): Promise<void>;
  _handleMessage(message: RTVI.Message, userId: string | null): Promise<void>;
}

function internals(processor: RTVIProcessor): Internals {
  return processor as unknown as Internals;
}

function asyncMock(): AnyMock {
  return mock(async () => {});
}

function latin1Bytes(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function b64encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function pushedFrames(p: Internals): Frame[] {
  return p.pushFrame.mock.calls.map((c) => c[0] as Frame);
}

describe("TestRTVIClientReadyVersionHandling", () => {
  let processor: RTVIProcessor;
  let p: Internals;

  beforeEach(() => {
    processor = new RTVIProcessor();
    p = internals(processor);
  });

  afterEach(async () => {
    await processor.cleanup();
  });

  /** Helper to call _handleClientReady with a mocked _sendErrorResponse. */
  async function callHandleClientReady(data: RTVI.ClientReadyData | null): Promise<void> {
    p._sendErrorResponse = asyncMock();
    p.setClientReady = asyncMock();
    await p._handleClientReady("req-1", data);
  }

  // -- Fully compatible versions (protocol major 2) -------------------------

  test("test_valid_version_2_0_0_sends_no_error", async () => {
    const data = new RTVI.ClientReadyData({
      version: "2.0.0",
      about: new RTVI.AboutClientData({ library: "test-client" }),
    });
    await callHandleClientReady(data);
    expect(p._sendErrorResponse).not.toHaveBeenCalled();
    expect(p._clientVersion).toEqual([2, 0, 0]);
  });

  test("test_valid_version_2_3_1_sends_no_error", async () => {
    const data = new RTVI.ClientReadyData({
      version: "2.3.1",
      about: new RTVI.AboutClientData({ library: "test-client" }),
    });
    await callHandleClientReady(data);
    expect(p._sendErrorResponse).not.toHaveBeenCalled();
    expect(p._clientVersion).toEqual([2, 3, 1]);
  });

  // -- Deprecated legacy version (1.4.x) ------------------------------------

  // TODO: enable this once RTVI 2.0.0 is supported by all our client SDKs, and
  // we start to emit the warnings again. (Commented out upstream:
  // test_legacy_version_1_4_0_sends_deprecation_warning.)

  test("test_legacy_version_sets_client_ready", async () => {
    // 1.4.x clients still become client-ready despite the warning.
    const data = new RTVI.ClientReadyData({
      version: "1.4.0",
      about: new RTVI.AboutClientData({ library: "test-client" }),
    });
    await callHandleClientReady(data);
    expect(p.setClientReady).toHaveBeenCalledTimes(1);
  });

  test("test_legacy_version_1_0_0_sets_client_ready", async () => {
    // Any 1.x client is accepted as legacy.
    const data = new RTVI.ClientReadyData({
      version: "1.0.0",
      about: new RTVI.AboutClientData({ library: "test-client" }),
    });
    await callHandleClientReady(data);
    expect(p._sendErrorResponse).not.toHaveBeenCalled();
    expect(p.setClientReady).toHaveBeenCalledTimes(1);
  });

  test("test_legacy_version_1_2_0_sets_client_ready", async () => {
    // Any 1.x client is accepted as legacy.
    const data = new RTVI.ClientReadyData({
      version: "1.2.0",
      about: new RTVI.AboutClientData({ library: "test-client" }),
    });
    await callHandleClientReady(data);
    expect(p._sendErrorResponse).not.toHaveBeenCalled();
    expect(p.setClientReady).toHaveBeenCalledTimes(1);
  });

  // -- Incompatible versions ------------------------------------------------

  test("test_version_below_1_0_0_sends_error", async () => {
    const data = new RTVI.ClientReadyData({
      version: "0.3.0",
      about: new RTVI.AboutClientData({ library: "test-client" }),
    });
    await callHandleClientReady(data);
    expect(p._sendErrorResponse).toHaveBeenCalledTimes(1);
    const errorMsg = p._sendErrorResponse.mock.calls[0]?.[1] as string;
    expect(errorMsg).toContain("0.3.0");
    expect(errorMsg).toContain("not compatible");
  });

  test("test_no_version_sends_error", async () => {
    // Client sends no data (data=None).
    await callHandleClientReady(null);
    expect(p._sendErrorResponse).toHaveBeenCalledTimes(1);
    const errorMsg = p._sendErrorResponse.mock.calls[0]?.[1] as string;
    expect(errorMsg).toContain("unknown");
  });

  test("test_invalid_version_format_sends_error", async () => {
    const badVersions = ["not-a-version", "123", "1.2.3.0", "junk", "1.2"];
    for (const version of badVersions) {
      // subTest(version=version)
      const data = new RTVI.ClientReadyData({
        version,
        about: new RTVI.AboutClientData({ library: "test-client" }),
      });
      await callHandleClientReady(data);
      expect(p._sendErrorResponse).toHaveBeenCalledTimes(1);
      const errorMsg = p._sendErrorResponse.mock.calls[0]?.[1] as string;
      expect(errorMsg).toContain("Invalid client version format");
      expect(errorMsg).toContain(version);
    }
  });

  test("test_error_message_includes_compatibility_warning", async () => {
    // Incompatible version errors should append the compatibility warning.
    for (const version of ["0.9.9", "3.0.0"]) {
      // subTest(version=version)
      const data = new RTVI.ClientReadyData({
        version,
        about: new RTVI.AboutClientData({ library: "test-client" }),
      });
      await callHandleClientReady(data);
      const calls = p._sendErrorResponse.mock.calls;
      const errorMsg = calls[calls.length - 1]?.[1] as string;
      expect(errorMsg).toContain("Compatibility issues may occur");
    }
  });

  test("test_client_ready_is_set_even_on_version_error", async () => {
    // Client-ready state should be set regardless of version errors.
    const data = new RTVI.ClientReadyData({
      version: "0.3.0",
      about: new RTVI.AboutClientData({ library: "test-client" }),
    });
    await callHandleClientReady(data);
    expect(p.setClientReady).toHaveBeenCalledTimes(1);
  });

  test("test_client_ready_is_set_when_no_data", async () => {
    await callHandleClientReady(null);
    expect(p.setClientReady).toHaveBeenCalledTimes(1);
  });

  test("test_client_ready_pushes_start_audio_streaming_frame", async () => {
    p.pushFrame = asyncMock();
    await callHandleClientReady(null);
    const pushed = pushedFrames(p);
    expect(pushed.some((f) => f instanceof InputTransportStartAudioStreamingFrame)).toBe(true);
  });
});

describe("TestRTVIFrameBasedAudio", () => {
  let processor: RTVIProcessor | undefined;

  afterEach(async () => {
    await processor?.cleanup();
    processor = undefined;
  });

  // The `transport` constructor parameter is deprecated upstream and not ported.
  test.skip("test_transport_param_is_deprecated", () => {});

  test("test_audio_buffer_pushes_input_audio_frame_downstream", async () => {
    processor = new RTVIProcessor();
    const p = internals(processor);
    p.pushFrame = asyncMock();
    await p._handleAudioBuffer({ base64Audio: "AAAA", sampleRate: 16000, numChannels: 1 });
    const pushed = pushedFrames(p);
    expect(pushed.length).toEqual(1);
    expect(pushed[0]).toBeInstanceOf(InputAudioRawFrame);
    expect((pushed[0] as InputAudioRawFrame).sampleRate).toEqual(16000);
  });
});

describe("TestRTVIDTMF", () => {
  let processor: RTVIProcessor | undefined;

  afterEach(async () => {
    await processor?.cleanup();
    processor = undefined;
  });

  test("test_dtmf_pushes_input_dtmf_frame_downstream", async () => {
    processor = new RTVIProcessor();
    const p = internals(processor);
    p.pushFrame = asyncMock();
    await p._handleDtmf(new RTVI.DTMFInputData({ buttons: [KeypadEntry.ONE] }));
    const pushed = pushedFrames(p);
    expect(pushed.length).toEqual(1);
    expect(pushed[0]).toBeInstanceOf(InputDTMFFrame);
    expect((pushed[0] as InputDTMFFrame).button).toEqual(KeypadEntry.ONE);
  });

  test("test_dtmf_sequence_pushes_one_frame_per_key_in_order", async () => {
    processor = new RTVIProcessor();
    const p = internals(processor);
    p.pushFrame = asyncMock();
    const data = RTVI.DTMFInputData.modelValidate({ buttons: ["1", "2", "#"] });
    await p._handleDtmf(data);
    const pushed = pushedFrames(p);
    expect(pushed.length).toEqual(3);
    for (const frame of pushed) {
      expect(frame).toBeInstanceOf(InputDTMFFrame);
    }
    expect(pushed.map((f) => (f as InputDTMFFrame).button)).toEqual([
      KeypadEntry.ONE,
      KeypadEntry.TWO,
      KeypadEntry.POUND,
    ]);
  });

  test("test_dtmf_input_data_rejects_invalid_button", () => {
    expect(() => RTVI.DTMFInputData.modelValidate({ buttons: ["1", "Z"] })).toThrow(
      RTVI.ValidationError,
    );
  });

  test("test_dtmf_input_data_rejects_empty_list", () => {
    expect(() => RTVI.DTMFInputData.modelValidate({ buttons: [] })).toThrow(RTVI.ValidationError);
  });

  test("test_dtmf_input_data_rejects_legacy_button_field", () => {
    expect(() => RTVI.DTMFInputData.modelValidate({ button: "1" })).toThrow(RTVI.ValidationError);
  });
});

describe("TestRTVISendFile", () => {
  let processor: RTVIProcessor;
  let p: Internals;

  beforeEach(() => {
    processor = new RTVIProcessor();
    p = internals(processor);
    p.pushFrame = asyncMock();
    p._sendErrorResponse = asyncMock();
    p.interruptBot = asyncMock();
  });

  afterEach(async () => {
    await processor.cleanup();
  });

  function makeSendFileData(
    source: RTVI.FileBytes | RTVI.FileUrl,
    {
      fmt = "application/pdf",
      name = null,
      content = "",
      options = null,
    }: {
      fmt?: string;
      name?: string | null;
      content?: string;
      options?: RTVI.SendFileOptions | null;
    } = {},
  ): RTVI.SendFileData {
    return new RTVI.SendFileData({
      content,
      file: new RTVI.File({ format: fmt, name, source }),
      options: options ?? new RTVI.SendFileOptions({ runImmediately: false, audioResponse: true }),
    });
  }

  // -- FileBytes ------------------------------------------------------------

  test("test_file_bytes_pdf_pushes_user_file_frame", async () => {
    const raw = latin1Bytes("%PDF-1.4 fake content");
    const b64 = b64encode(raw);
    const data = makeSendFileData(new RTVI.FileBytes({ bytes: b64 }), { fmt: "application/pdf" });
    await p._handleSendFile(data, "msg-1");

    const frames = pushedFrames(p);
    expect(frames.length).toEqual(1);
    expect(frames[0]).toBeInstanceOf(UserFileRawFrame);
    const frame = frames[0] as UserFileRawFrame;
    expect(frame.file).toEqual(`data:application/pdf;base64,${b64}`);
    expect(frame.format).toEqual("application/pdf");
  });

  test("test_file_bytes_pdf_stores_filename", async () => {
    const raw = latin1Bytes("%PDF-1.4 fake content");
    const b64 = b64encode(raw);
    const data = makeSendFileData(new RTVI.FileBytes({ bytes: b64 }), {
      fmt: "application/pdf",
      name: "report.pdf",
    });
    await p._handleSendFile(data, "msg-1");

    const frames = pushedFrames(p);
    expect((frames[0] as UserFileRawFrame).filename).toEqual("report.pdf");
  });

  test("test_file_bytes_image_pushes_user_image_frame_with_bytes", async () => {
    const raw = latin1Bytes("\x89PNG\r\n\x1a\n fake png");
    const b64 = b64encode(raw);
    const data = makeSendFileData(new RTVI.FileBytes({ bytes: b64 }), { fmt: "image/png" });
    await p._handleSendFile(data, "msg-1");

    const frames = pushedFrames(p);
    expect(frames.length).toEqual(1);
    expect(frames[0]).toBeInstanceOf(UserImageRawFrame);
    const frame = frames[0] as UserImageRawFrame;
    expect(frame.image).toBeInstanceOf(Uint8Array);
    expect(frame.image).toEqual(raw);
  });

  // -- FileBytes carrying a full data URL -----------------------------------

  test("test_file_bytes_data_url_not_double_wrapped", async () => {
    const raw = latin1Bytes("%PDF-1.4 fake content");
    const b64 = b64encode(raw);
    const dataUrl = `data:application/pdf;base64,${b64}`;
    const data = makeSendFileData(new RTVI.FileBytes({ bytes: dataUrl }), {
      fmt: "application/pdf",
    });
    await p._handleSendFile(data, "msg-1");

    const frames = pushedFrames(p);
    expect(frames.length).toEqual(1);
    expect(frames[0]).toBeInstanceOf(UserFileRawFrame);
    expect((frames[0] as UserFileRawFrame).file).toEqual(dataUrl);
  });

  test("test_file_bytes_image_data_url_decodes_to_raw_bytes", async () => {
    const raw = latin1Bytes("\x89PNG\r\n\x1a\n fake png");
    const b64 = b64encode(raw);
    const dataUrl = `data:image/png;base64,${b64}`;
    const data = makeSendFileData(new RTVI.FileBytes({ bytes: dataUrl }), { fmt: "image/png" });
    await p._handleSendFile(data, "msg-1");

    const frames = pushedFrames(p);
    expect(frames.length).toEqual(1);
    expect(frames[0]).toBeInstanceOf(UserImageRawFrame);
    expect((frames[0] as UserImageRawFrame).image).toEqual(raw);
  });

  // -- FileUrl (always passed through unresolved) ----------------------------

  test("test_file_url_pushes_user_file_frame_with_url_source", async () => {
    const data = makeSendFileData(new RTVI.FileUrl({ url: "https://example.com/doc.pdf" }), {
      fmt: "application/pdf",
    });
    await p._handleSendFile(data, "msg-1");

    const frames = pushedFrames(p);
    expect(frames.length).toEqual(1);
    expect(frames[0]).toBeInstanceOf(UserFileRawFrame);
    const frame = frames[0] as UserFileRawFrame;
    expect(frame.type).toEqual("url");
    expect(frame.file).toEqual("https://example.com/doc.pdf");
  });

  test("test_file_url_image_pushes_user_file_frame_not_image_frame", async () => {
    // A URL-sourced image stays a file frame; resolution happens at the LLM service.
    const data = makeSendFileData(new RTVI.FileUrl({ url: "https://example.com/photo.png" }), {
      fmt: "image/png",
    });
    await p._handleSendFile(data, "msg-1");

    const frames = pushedFrames(p);
    expect(frames.length).toEqual(1);
    expect(frames[0]).toBeInstanceOf(UserFileRawFrame);
    expect((frames[0] as UserFileRawFrame).type).toEqual("url");
  });

  test("test_file_url_cloud_and_storage_schemes_pass_through", async () => {
    for (const url of [
      "s3://my-bucket/doc.pdf",
      "gs://my-bucket/doc.pdf",
      "pipecat:0123456789abcdef0123456789abcdef",
    ]) {
      // subTest(url=url)
      p.pushFrame.mockClear();
      const data = makeSendFileData(new RTVI.FileUrl({ url }), { fmt: "application/pdf" });
      await p._handleSendFile(data, "msg-1");

      const frames = pushedFrames(p);
      expect(frames.length).toEqual(1);
      expect(frames[0]).toBeInstanceOf(UserFileRawFrame);
      const frame = frames[0] as UserFileRawFrame;
      expect(frame.type).toEqual("url");
      expect(frame.file).toEqual(url);
    }
  });

  // -- Options ---------------------------------------------------------------

  test("test_run_immediately_true_interrupts_bot", async () => {
    const data = makeSendFileData(new RTVI.FileUrl({ url: "https://example.com/doc.pdf" }), {
      fmt: "application/pdf",
      options: new RTVI.SendFileOptions({ runImmediately: true }),
    });
    await p._handleSendFile(data, "msg-1");

    expect(p.interruptBot).toHaveBeenCalledTimes(1);
    const frames = pushedFrames(p);
    expect(frames.length).toEqual(1);
    expect((frames[0] as UserFileRawFrame).runLlm).toBe(true);
  });

  test("test_run_immediately_false_does_not_interrupt_bot", async () => {
    const data = makeSendFileData(new RTVI.FileUrl({ url: "https://example.com/doc.pdf" }), {
      fmt: "application/pdf",
    });
    await p._handleSendFile(data, "msg-1");

    expect(p.interruptBot).not.toHaveBeenCalled();
    const frames = pushedFrames(p);
    expect((frames[0] as UserFileRawFrame).runLlm).toBe(false);
  });
});

interface ParticipantMessageFrameOptions extends InputTransportMessageFrameOptions {
  participantId?: string | null;
}

/** A transport message that names its sender, as Daily's and LiveKit's do. */
class ParticipantMessageFrame extends InputTransportMessageFrame {
  participantId: string | null;

  constructor(options: ParticipantMessageFrameOptions) {
    super(options);
    this.participantId = options.participantId ?? null;
  }
}

describe("TestRTVISendText", () => {
  let processor: RTVIProcessor;
  let p: Internals;

  beforeEach(() => {
    processor = new RTVIProcessor();
    p = internals(processor);
    p.pushFrame = asyncMock();
    p.interruptBot = asyncMock();
    p._messageQueue = new Queue();
  });

  afterEach(async () => {
    await processor.cleanup();
  });

  test("test_the_text_is_acknowledged_once_it_is_appended", async () => {
    const data = new RTVI.SendTextData({
      content: "Hello.",
      options: new RTVI.SendTextOptions({ runImmediately: false }),
    });
    await p._handleSendText(data, "msg-1");

    const frames = pushedFrames(p);
    expect(frames.map((f) => f.constructor)).toEqual([LLMMessagesAppendFrame, RTVISendTextFrame]);
    const ack = frames[1] as RTVISendTextFrame;
    expect([ack.msgId, ack.text]).toEqual(["msg-1", "Hello."]);
  });

  async function receive(frame: InputTransportMessageFrame): Promise<void> {
    await p._handleTransportMessage(frame);
    await p._handleMessage(...p._messageQueue.getNowait());
  }

  function sendTextMessage(): Record<string, unknown> {
    return {
      label: RTVI.MESSAGE_LABEL,
      type: "send-text",
      id: "msg-1",
      data: { content: "Hello.", options: { run_immediately: false } },
    };
  }

  test("test_the_text_is_acknowledged_with_the_sender_the_transport_names", async () => {
    await receive(
      new ParticipantMessageFrame({ message: sendTextMessage(), participantId: "user" }),
    );

    const frame = pushedFrames(p).at(-1);
    expect(frame).toBeInstanceOf(RTVISendTextFrame);
    const ack = frame as RTVISendTextFrame;
    expect([ack.msgId, ack.userId]).toEqual(["msg-1", "user"]);
  });

  test("test_the_text_is_acknowledged_without_a_sender_the_transport_doesnt_name", async () => {
    await receive(new InputTransportMessageFrame({ message: sendTextMessage() }));

    const frame = pushedFrames(p).at(-1);
    expect(frame).toBeInstanceOf(RTVISendTextFrame);
    const ack = frame as RTVISendTextFrame;
    expect([ack.msgId, ack.userId]).toEqual(["msg-1", null]);
  });

  test("test_the_text_is_acknowledged_before_the_tts_setting_is_restored", async () => {
    const data = new RTVI.SendTextData({
      content: "Hello.",
      options: new RTVI.SendTextOptions({ runImmediately: false, audioResponse: false }),
    });
    await p._handleSendText(data, "msg-1");

    expect(pushedFrames(p).map((f) => f.constructor)).toEqual([
      LLMConfigureOutputFrame,
      LLMMessagesAppendFrame,
      RTVISendTextFrame,
      LLMConfigureOutputFrame,
    ]);
  });
});
