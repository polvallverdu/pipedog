// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_llm_context.py

/** Unit tests for LLMContext core functionality. */

import { describe, expect, test } from "bun:test";

import { OpenAILLMAdapter } from "../src/adapters/services/open_ai_adapter.ts";
import {
  LLMContext,
  type LLMContextMessage,
  LLMSpecificMessage,
} from "../src/processors/aggregators/llm_context.ts";
import { jpegInfo } from "./jpeg_info.ts";

// Messages are loosely-typed dicts upstream; index them the same way here.
type Any = any;

function msgs(messages: unknown[]): LLMContextMessage[] {
  return messages as LLMContextMessage[];
}

function at(result: LLMContextMessage[], i: number): Any {
  return result[i] as Any;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const PNG_FAKE = new Uint8Array([0x89, ...new TextEncoder().encode("PNG fake")]);

describe("TestGetMessagesTruncateLargeValues", () => {
  // -- Standard messages: binary elision -----------------------------------

  test("test_default_preserves_all_data", () => {
    // truncate_large_values defaults to False, preserving all data.
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image" },
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" },
          },
        ],
      },
    ];
    const context = new LLMContext({ messages: msgs(messages) });
    const result = context.getMessages();

    expect(at(result, 0).content[1].image_url.url).toEqual(
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
    );
  });

  test("test_elides_base64_image_url", () => {
    // Base64 data:image/ URLs are replaced with a placeholder.
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image" },
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" },
          },
        ],
      },
    ];
    const context = new LLMContext({ messages: msgs(messages) });
    const result = context.getMessages(null, { truncateLargeValues: true });

    expect(at(result, 0).content[0].text).toEqual("Describe this image");
    expect(at(result, 0).content[1].image_url.url).toEqual("data:image/...");
  });

  test("test_preserves_http_image_url", () => {
    // HTTP image URLs are not elided (they aren't binary data).
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "https://example.com/image.jpg" },
          },
        ],
      },
    ];
    const context = new LLMContext({ messages: msgs(messages) });
    const result = context.getMessages(null, { truncateLargeValues: true });

    expect(at(result, 0).content[0].image_url.url).toEqual("https://example.com/image.jpg");
  });

  test("test_elides_input_audio_data", () => {
    // input_audio items have their data field elided.
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Audio follows" },
          {
            type: "input_audio",
            input_audio: { data: "UklGRiQA".repeat(1000), format: "wav" },
          },
        ],
      },
    ];
    const context = new LLMContext({ messages: msgs(messages) });
    const result = context.getMessages(null, { truncateLargeValues: true });

    expect(at(result, 0).content[1].input_audio.data).toEqual("...");
    expect(at(result, 0).content[1].input_audio.format).toEqual("wav");
  });

  test("test_elides_audio_field", () => {
    // Items with an 'audio' field are elided (used by some realtime adapters).
    const messages = [
      {
        role: "user",
        content: [
          { type: "input_audio", audio: "UklGRiQA".repeat(1000) },
          { type: "audio", audio: "UklGRiQA".repeat(1000) },
        ],
      },
    ];
    const context = new LLMContext({ messages: msgs(messages) });
    const result = context.getMessages(null, { truncateLargeValues: true });

    expect(at(result, 0).content[0].audio).toEqual("...");
    expect(at(result, 0).content[1].audio).toEqual("...");
  });

  test("test_elides_top_level_mime_type_image", () => {
    // Messages with top-level mime_type image/ have their data elided.
    const messages = [
      {
        role: "user",
        mime_type: "image/png",
        data: "iVBORw0KGgoAAAANSU".repeat(1000),
      },
    ];
    const context = new LLMContext({ messages: msgs(messages) });
    const result = context.getMessages(null, { truncateLargeValues: true });

    expect(at(result, 0).data).toEqual("...");
    expect(at(result, 0).mime_type).toEqual("image/png");
  });

  test("test_mixed_content_elides_only_binary", () => {
    // In a message with text, image, and audio, only binary parts are elided.
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Here is an image and audio" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,iVBORw==" },
          },
          {
            type: "input_audio",
            input_audio: { data: "UklGRiQA", format: "wav" },
          },
        ],
      },
    ];
    const context = new LLMContext({ messages: msgs(messages) });
    const result = context.getMessages(null, { truncateLargeValues: true });

    expect(at(result, 0).content[0].text).toEqual("Here is an image and audio");
    expect(at(result, 0).content[1].image_url.url).toEqual("data:image/...");
    expect(at(result, 0).content[2].input_audio.data).toEqual("...");
  });

  test("test_text_only_messages_unchanged", () => {
    // Plain text messages are completely unaffected.
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello!" },
      { role: "assistant", content: "Hi there!" },
    ];
    const context = new LLMContext({ messages: msgs(messages) });
    const result = context.getMessages(null, { truncateLargeValues: true });

    expect(result).toEqual(msgs(messages));
  });

  test("test_does_not_mutate_original", () => {
    // Returns copies; originals are untouched.
    const originalUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: originalUrl },
          },
        ],
      },
    ];
    const context = new LLMContext({ messages: msgs(messages) });
    context.getMessages(null, { truncateLargeValues: true });

    expect(at(context.getMessages(), 0).content[0].image_url.url).toEqual(originalUrl);
  });

  test("test_multiple_images_all_elided", () => {
    // Multiple image_url items in the same message are all elided.
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,AAAA" },
          },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,BBBB" },
          },
          {
            type: "image_url",
            image_url: { url: "https://example.com/photo.jpg" },
          },
        ],
      },
    ];
    const context = new LLMContext({ messages: msgs(messages) });
    const result = context.getMessages(null, { truncateLargeValues: true });

    expect(at(result, 0).content[0].image_url.url).toEqual("data:image/...");
    expect(at(result, 0).content[1].image_url.url).toEqual("data:image/...");
    expect(at(result, 0).content[2].image_url.url).toEqual("https://example.com/photo.jpg");
  });

  test("test_works_with_llm_specific_filter", () => {
    // truncate_large_values works together with llm_specific_filter.
    const adapter = new OpenAILLMAdapter();
    const stdMsg = {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" },
        },
      ],
    };
    const specificMsg = adapter.createLlmSpecificMessage({
      role: "assistant",
      content: "response",
    });
    const context = new LLMContext({ messages: msgs([stdMsg, specificMsg]) });

    const result = context.getMessages("openai", { truncateLargeValues: true });

    expect(result.length).toEqual(2);
    expect(at(result, 0).content[0].image_url.url).toEqual("data:image/...");
  });

  test("test_string_content_with_no_binary", () => {
    // Messages with string content (not list) pass through fine.
    const messages = [{ role: "user", content: "Just a string" }];
    const context = new LLMContext({ messages: msgs(messages) });
    const result = context.getMessages(null, { truncateLargeValues: true });

    expect(at(result, 0).content).toEqual("Just a string");
  });

  // -- LLMSpecificMessage: long-string truncation --------------------------

  test("test_llm_specific_short_values_preserved", () => {
    // Short string values in LLMSpecificMessage are kept as-is.
    const inner = { type: "thought", text: "brief thought" };
    const specificMsg = new LLMSpecificMessage({ llm: "anthropic", message: inner });
    const context = new LLMContext({ messages: [specificMsg] });

    const result = context.getMessages(null, { truncateLargeValues: true });

    expect(result[0]).toBeInstanceOf(LLMSpecificMessage);
    expect(at(result, 0).message.type).toEqual("thought");
    expect(at(result, 0).message.text).toEqual("brief thought");
  });

  test("test_llm_specific_long_string_truncated", () => {
    // Long string values in LLMSpecificMessage are truncated.
    const longSignature = "a".repeat(500);
    const inner = { type: "thought", text: "short", signature: longSignature };
    const specificMsg = new LLMSpecificMessage({ llm: "anthropic", message: inner });
    const context = new LLMContext({ messages: [specificMsg] });

    const result = context.getMessages(null, { truncateLargeValues: true });

    const msg = at(result, 0).message;
    expect(msg.type).toEqual("thought");
    expect(msg.text).toEqual("short");
    // Signature should be truncated
    expect(msg.signature).toContain("...");
    expect(msg.signature).toContain("500 chars");
    expect(msg.signature.length < longSignature.length).toBe(true);
  });

  test("test_llm_specific_nested_dict_truncated", () => {
    // Long strings nested in dicts within LLMSpecificMessage are truncated.
    const inner = {
      type: "thought_signature",
      signature: "x".repeat(200),
      bookmark: { text: "y".repeat(200) },
    };
    const specificMsg = new LLMSpecificMessage({ llm: "google", message: inner });
    const context = new LLMContext({ messages: [specificMsg] });

    const result = context.getMessages(null, { truncateLargeValues: true });

    const msg = at(result, 0).message;
    expect(msg.type).toEqual("thought_signature");
    expect(msg.signature).toContain("...");
    expect(msg.bookmark.text).toContain("...");
  });

  test("test_llm_specific_list_values_truncated", () => {
    // Long strings inside lists within LLMSpecificMessage are truncated.
    const inner = { items: ["short", "a".repeat(200)] };
    const specificMsg = new LLMSpecificMessage({ llm: "test", message: inner });
    const context = new LLMContext({ messages: [specificMsg] });

    const result = context.getMessages(null, { truncateLargeValues: true });

    const msg = at(result, 0).message;
    expect(msg.items[0]).toEqual("short");
    expect(msg.items[1]).toContain("...");
  });

  test("test_llm_specific_non_string_values_preserved", () => {
    // Non-string values (ints, bools, None) in LLMSpecificMessage are untouched.
    const inner = { type: "test", count: 42, active: true, extra: null };
    const specificMsg = new LLMSpecificMessage({ llm: "test", message: inner });
    const context = new LLMContext({ messages: [specificMsg] });

    const result = context.getMessages(null, { truncateLargeValues: true });

    const msg = at(result, 0).message;
    expect(msg.count).toEqual(42);
    expect(msg.active).toEqual(true);
    expect(msg.extra).toBeNull();
  });

  test("test_llm_specific_does_not_mutate_original", () => {
    // Truncation returns a copy; original LLMSpecificMessage is untouched.
    const longSig = "a".repeat(500);
    const inner = { signature: longSig };
    const specificMsg = new LLMSpecificMessage({ llm: "anthropic", message: inner });
    const context = new LLMContext({ messages: [specificMsg] });

    context.getMessages(null, { truncateLargeValues: true });

    expect((specificMsg.message as Any).signature).toEqual(longSig);
  });
});

describe("TestCreateFileMessage", () => {
  // Tests for LLMContext.create_file_message and create_file_url_message.

  test("test_bytes_type_produces_file_content_item", async () => {
    const b64 = "JVBERi0xLjQ=";
    const msg: Any = await LLMContext.createFileMessage({
      type: "bytes",
      format: "application/pdf",
      file: `data:application/pdf;base64,${b64}`,
    });
    expect(msg.role).toEqual("user");
    const content = msg.content;
    expect(content.length).toEqual(1);
    const item = content[0];
    expect(item.type).toEqual("file_base64");
    expect(item.file.file_data).toEqual(`data:application/pdf;base64,${b64}`);
    expect(item.file.mime_type).toEqual("application/pdf");
  });

  test("test_bytes_type_includes_filename_when_provided", async () => {
    const msg: Any = await LLMContext.createFileMessage({
      type: "bytes",
      format: "application/pdf",
      file: "data:application/pdf;base64,abc123",
      name: "report.pdf",
    });
    expect(msg.content[0].file.filename).toEqual("report.pdf");
  });

  test("test_bytes_type_filename_empty_string_when_not_provided", async () => {
    const msg: Any = await LLMContext.createFileMessage({
      type: "bytes",
      format: "application/pdf",
      file: "data:application/pdf;base64,abc123",
    });
    expect(msg.content[0].file.filename).toEqual("");
  });

  test("test_bytes_type_includes_text_when_provided", async () => {
    const msg: Any = await LLMContext.createFileMessage({
      type: "bytes",
      format: "application/pdf",
      file: "data:application/pdf;base64,abc123",
      text: "Please summarize this document",
    });
    const content = msg.content;
    expect(content.length).toEqual(2);
    expect(content[0].type).toEqual("text");
    expect(content[0].text).toEqual("Please summarize this document");
    expect(content[1].type).toEqual("file_base64");
  });

  test("test_url_type_delegates_to_file_url_message", async () => {
    const msg: Any = await LLMContext.createFileMessage({
      type: "url",
      format: "application/pdf",
      file: "https://example.com/doc.pdf",
      name: "doc.pdf",
    });
    const content = msg.content;
    expect(content.length).toEqual(1);
    const item = content[0];
    expect(item.type).toEqual("file_url");
    expect(item.file.url).toEqual("https://example.com/doc.pdf");
    expect(item.file.filename).toEqual("doc.pdf");
    expect(item.file.mime_type).toEqual("application/pdf");
  });

  test("test_create_file_url_message_structure", () => {
    const msg: Any = LLMContext.createFileUrlMessage({
      format: "image/jpeg",
      url: "https://example.com/photo.jpg",
      filename: "photo.jpg",
      text: "What is in this image?",
    });
    const content = msg.content;
    expect(content.length).toEqual(2);
    expect(content[0].type).toEqual("text");
    expect(content[0].text).toEqual("What is in this image?");
    expect(content[1].type).toEqual("file_url");
    expect(content[1].file.url).toEqual("https://example.com/photo.jpg");
    expect(content[1].file.filename).toEqual("photo.jpg");
    expect(content[1].file.mime_type).toEqual("image/jpeg");
  });

  test("test_add_file_frame_message_appends_to_context", async () => {
    const context = new LLMContext();
    await context.addFileFrameMessage({
      type: "bytes",
      format: "application/pdf",
      file: "data:application/pdf;base64,abc123",
      name: "test.pdf",
    });
    const messages = context.getMessages();
    expect(messages.length).toEqual(1);
    expect(at(messages, 0).role).toEqual("user");
    expect(at(messages, 0).content[0].file.filename).toEqual("test.pdf");
  });
});

describe("TestCreateImageMessage", () => {
  // Tests for LLMContext.create_image_message.

  test("test_encoded_image_keeps_its_bytes_and_type", async () => {
    const png = PNG_FAKE;
    const msg: Any = await LLMContext.createImageMessage({
      format: "image/png",
      size: [2, 2],
      image: png,
    });
    const url = msg.content[0].image_url.url;
    expect(url).toEqual(`data:image/png;base64,${bytesToBase64(png)}`);
  });

  test("test_pixels_with_alpha_are_encoded_as_a_jpeg", async () => {
    // Image.new("RGBA", (4, 4), (255, 0, 0, 128)).tobytes()
    const pixels = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([255, 0, 0, 128], i);
    const msg: Any = await LLMContext.createImageMessage({
      format: "RGBA",
      size: [4, 4],
      image: pixels,
    });
    const url: string = msg.content[0].image_url.url;
    const prefix = "data:image/jpeg;base64,";
    expect(url.startsWith(prefix)).toBe(true);
    const decoded = jpegInfo(
      Uint8Array.from(atob(url.slice(prefix.length)), (c) => c.charCodeAt(0)),
    );
    expect([decoded.format, decoded.mode, decoded.size]).toEqual(["JPEG", "RGB", [4, 4]]);
  });
});

describe("TestRemoveInvalidFileMessage", () => {
  // Tests for LLMContext.remove_invalid_file_message.
  //
  // Deciding *when* a request was invalid is the calling LLM service's job
  // (it's the one that understands its own provider's error shape); these
  // tests cover which message gets picked, derived purely from message-list
  // structure — no separate tracking state. See test_openai_llm_timeout.py
  // and test_google_stream_timeout.py for the service-level wiring.

  test("test_removes_the_only_file_message", async () => {
    const context = new LLMContext();
    context.addMessage({ role: "user", content: "hello" });
    await context.addFileFrameMessage({
      type: "bytes",
      format: "application/pdf",
      file: "data:application/pdf;base64,abc123",
    });

    const removed = context.removeInvalidFileMessage();

    expect(removed).toBe(true);
    const messages = context.getMessages();
    expect(messages.length).toEqual(1);
    expect(at(messages, 0).content).toEqual("hello");
  });

  test("test_recognizes_file_url_type", async () => {
    const context = new LLMContext({
      messages: msgs([
        {
          role: "user",
          content: [{ type: "file_url", file: { url: "https://example.com/doc.pdf" } }],
        },
      ]),
    });

    const removed = context.removeInvalidFileMessage();

    expect(removed).toBe(true);
    expect(context.getMessages().length).toEqual(0);
  });

  test("test_removes_an_image_message", async () => {
    // Images count as files here: a provider rejecting a bad image (e.g.
    // bytes that don't match the declared media type) would otherwise leave
    // the context permanently stuck resending it.
    const context = new LLMContext();
    context.addMessage({ role: "user", content: "hello" });
    await context.addImageFrameMessage({ format: "image/png", size: [2, 2], image: PNG_FAKE });

    const removed = context.removeInvalidFileMessage();

    expect(removed).toBe(true);
    const messages = context.getMessages();
    expect(messages.length).toEqual(1);
    expect(at(messages, 0).content).toEqual("hello");
  });

  test("test_does_not_remove_an_image_already_confirmed_by_an_assistant_reply", async () => {
    const context = new LLMContext();
    await context.addImageFrameMessage({ format: "image/png", size: [2, 2], image: PNG_FAKE });
    context.addMessage({ role: "assistant", content: "Nice photo." });
    context.addMessage({ role: "user", content: "thanks" });

    const removed = context.removeInvalidFileMessage();

    expect(removed).toBe(false);
    expect(context.getMessages().length).toEqual(3);
  });

  test("test_does_not_remove_an_audio_message", async () => {
    // Audio-in-context is ordinary conversation appended every turn, not a
    // discrete attachment — removing it on an unrelated rejection would
    // discard real conversation.
    const context = new LLMContext({
      messages: msgs([
        {
          role: "user",
          content: [{ type: "input_audio", input_audio: { data: "aGk=", format: "wav" } }],
        },
      ]),
    });

    const removed = context.removeInvalidFileMessage();

    expect(removed).toBe(false);
    expect(context.getMessages().length).toEqual(1);
  });

  test("test_removes_oldest_of_several_pending_files", async () => {
    // Several files sent before either went through a completion.
    //
    // Removing the oldest first means a wrong guess self-corrects: if it
    // wasn't the culprit, the next retry fails again and removes the
    // next-oldest.
    const context = new LLMContext();
    await context.addFileFrameMessage({
      type: "bytes",
      format: "application/pdf",
      file: "data:application/pdf;base64,first",
    });
    await context.addFileFrameMessage({
      type: "bytes",
      format: "application/pdf",
      file: "data:application/pdf;base64,second",
    });

    const removed = context.removeInvalidFileMessage();

    expect(removed).toBe(true);
    const messages = context.getMessages();
    expect(messages.length).toEqual(1);
    expect(at(messages, 0).content[0].file.file_data).toEqual("data:application/pdf;base64,second");
  });

  test("test_does_not_remove_a_file_already_confirmed_by_an_assistant_reply", async () => {
    // A file from an already-successful turn is never a removal candidate.
    const context = new LLMContext();
    await context.addFileFrameMessage({
      type: "bytes",
      format: "application/pdf",
      file: "data:application/pdf;base64,abc123",
    });
    context.addMessage({ role: "assistant", content: "Here's a summary." });
    context.addMessage({ role: "user", content: "what does it say?" });

    const removed = context.removeInvalidFileMessage();

    expect(removed).toBe(false);
    expect(context.getMessages().length).toEqual(3);
  });

  test("test_removes_file_message_despite_a_newer_non_file_message", async () => {
    // A file is still found even if it's no longer the newest message.
    //
    // A file arriving alongside a separately-aggregated user utterance
    // (e.g. the user was mid-turn when the file was sent) can end up with a
    // plain-text message added after it, before either has gone through a
    // completion. Since no assistant reply has confirmed either, the file
    // is still the right removal candidate.
    const context = new LLMContext();
    await context.addFileFrameMessage({
      type: "bytes",
      format: "application/pdf",
      file: "data:application/pdf;base64,abc123",
    });
    context.addMessage({ role: "user", content: "what does it say?" });

    const removed = context.removeInvalidFileMessage();

    expect(removed).toBe(true);
    const messages = context.getMessages();
    expect(messages.length).toEqual(1);
    expect(at(messages, 0).content).toEqual("what does it say?");
  });

  test("test_returns_false_when_no_file_message_present", async () => {
    const context = new LLMContext({ messages: msgs([{ role: "user", content: "hello" }]) });

    const removed = context.removeInvalidFileMessage();

    expect(removed).toBe(false);
    expect(context.getMessages().length).toEqual(1);
  });

  test("test_skips_llm_specific_messages", async () => {
    const context = new LLMContext({
      messages: msgs([
        new LLMSpecificMessage({
          llm: "openai",
          message: { role: "user", content: [{ type: "file_base64", file: {} }] },
        }),
        { role: "user", content: "plain text" },
      ]),
    });

    const removed = context.removeInvalidFileMessage();

    expect(removed).toBe(false);
    expect(context.getMessages().length).toEqual(2);
  });
});
