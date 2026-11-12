// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/llm/services/nvidia_omni_adapter.py

/**
 * NVIDIA Nemotron Omni LLM adapter for Pipecat.
 *
 * Nemotron Omni is served through an OpenAI-compatible Chat Completions endpoint
 * that also accepts audio and video. It reads media as data URLs under
 * `audio_url` and `video_url` content parts, so this adapter renames the
 * universal context's audio and media file parts to those shapes at the provider
 * boundary. Text and image parts are passed through unchanged.
 */

import {
  type ChatCompletionMessageParam,
  OpenAILLMAdapter,
} from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import type { LLMContextMessage } from "@pipedog/core/processors/aggregators/llm_context";

type Dict = Record<string, unknown>;

/**
 * Adapter for NVIDIA Nemotron Omni models.
 *
 * Extends `OpenAILLMAdapter` with the media content parts Omni accepts:
 *
 * - `input_audio` parts, as produced by `LLMContext.createAudioMessage()`
 *   and `addAudioFramesMessage()`, become `audio_url` data URLs.
 * - `audio/*` and `video/*` files, as produced by
 *   `LLMContext.createFileMessage()`, become `audio_url` and
 *   `video_url` data URLs.
 *
 * Converted messages are new objects, so the context keeps its universal shape.
 */
export class NvidiaOmniLLMAdapter extends OpenAILLMAdapter {
  /**
   * Convert universal content parts that are sent outside the context.
   *
   * @param parts Universal content parts, such as `input_audio` and `text`.
   * @returns The parts in the shape Omni reads.
   */
  toProviderContentParts(parts: readonly Dict[]): unknown[] {
    return parts.map((part) => audioUrlPart(part));
  }

  protected override _fromUniversalContextMessages(
    messages: LLMContextMessage[],
    options: { convertDeveloperToUser: boolean },
  ): ChatCompletionMessageParam[] {
    const converted = super._fromUniversalContextMessages(messages, {
      convertDeveloperToUser: options.convertDeveloperToUser,
    });
    return converted.map((message) => renameInputAudio(message));
  }

  /** Build the content item for an inline (base64) file, including audio and video. */
  protected override _inlineFileItem(
    fileDataUrl: string,
    filename: string,
    mimeType: string,
  ): Dict {
    if (mimeType.startsWith("audio/")) {
      return { type: "audio_url", audio_url: { url: fileDataUrl } };
    }
    if (mimeType.startsWith("video/")) {
      return { type: "video_url", video_url: { url: fileDataUrl } };
    }
    return super._inlineFileItem(fileDataUrl, filename, mimeType);
  }
}

function isMapping(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rewrite a message's `input_audio` parts as `audio_url` data URLs. */
function renameInputAudio(message: ChatCompletionMessageParam): ChatCompletionMessageParam {
  const content = (message as Dict).content;
  if (!Array.isArray(content)) {
    return message;
  }
  const parts = content.map((part: unknown) => (isMapping(part) ? audioUrlPart(part) : part));
  return { ...message, content: parts } as ChatCompletionMessageParam;
}

function audioUrlPart(part: Dict): Dict {
  if (part.type !== "input_audio") {
    return part;
  }
  const payload = (part.input_audio || {}) as Dict;
  const audioFormat = payload.format || "wav";
  const data = payload.data || "";
  return { type: "audio_url", audio_url: { url: `data:audio/${audioFormat};base64,${data}` } };
}
