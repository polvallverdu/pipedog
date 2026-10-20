// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/frameworks/langchain.py

/** Langchain integration processor for Pipecat. */

import { AIMessageChunk } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import {
  type Frame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  TextFrame,
} from "@pipedog/core/frames/frames";
import { LLMSpecificMessage } from "@pipedog/core/processors/aggregators/llm_context";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { logger } from "@pipedog/core/utils/logger";

/** Options for LangchainProcessor. */
export interface LangchainProcessorOptions {
  /** The key to use when passing input to the chain. Defaults to `"input"`. */
  transcriptKey?: string;
}

/** `str(e)` for an exception, as upstream's f-strings print it. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Processor that integrates Langchain runnables with Pipecat's frame pipeline.
 *
 * This processor takes LLM message frames, extracts the latest user message,
 * and processes it through a Langchain runnable chain. The response is streamed
 * back as text frames with appropriate response markers.
 */
export class LangchainProcessor extends FrameProcessor {
  protected _chain: Runnable;
  protected _transcriptKey: string;
  protected _participantId: string | null;

  /**
   * Initialize the Langchain processor.
   *
   * @param chain The Langchain runnable to use for processing messages.
   * @param options.transcriptKey The key to use when passing input to the chain.
   */
  constructor(chain: Runnable, options: LangchainProcessorOptions = {}) {
    super();
    this._chain = chain;
    this._transcriptKey = options.transcriptKey ?? "input";
    this._participantId = null;
  }

  /**
   * Set the participant ID for session tracking.
   *
   * @param participantId The participant ID to use for session configuration.
   */
  setParticipantId(participantId: string): void {
    this._participantId = participantId;
  }

  /**
   * Process incoming frames and handle LLM message frames.
   *
   * @param frame The incoming frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof LLMContextFrame) {
      // Messages are accumulated on the context as a list of messages.
      // The last one by the human is the one we want to send to the LLM.
      logger.debug(`Got transcription frame ${frame}`);
      const messages = frame.context.getMessages();
      // Historically this processor has only handled plain-text user
      // messages; the guards below make that contract explicit for the
      // type checker. TODO: maybe handle other message shapes (provider-
      // specific messages, multi-modal content lists, etc.).
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
      // Upstream checks `isinstance(last_message, dict)`: a standard message is a
      // plain object, a provider-specific one is an LLMSpecificMessage.
      if (
        lastMessage === null ||
        lastMessage === undefined ||
        typeof lastMessage !== "object" ||
        lastMessage instanceof LLMSpecificMessage
      ) {
        await this.pushFrame(frame, direction);
        return;
      }
      const content = lastMessage.content;
      if (typeof content !== "string") {
        await this.pushFrame(frame, direction);
        return;
      }

      await this._ainvoke(content.trim());
    } else {
      await this.pushFrame(frame, direction);
    }
  }

  /**
   * Extract token value from various text types.
   *
   * @param text The text or message chunk to extract value from.
   * @returns The extracted string value.
   */
  static #getTokenValue(text: unknown): string {
    if (typeof text === "string") {
      return text;
    }
    if (AIMessageChunk.isInstance(text)) {
      // `content` is `str | list[...]` (multi-modal); stringify if
      // it's a list, since downstream consumers want plain text.
      // DIVERGENCE: upstream stringifies the list with Python's `str()` (its
      // repr); we use JSON.
      const content = text.content;
      return typeof content === "string" ? content : JSON.stringify(content);
    }
    return "";
  }

  /** Invoke the Langchain runnable with the provided text. */
  protected async _ainvoke(text: string): Promise<void> {
    logger.debug(`Invoking chain with ${text}`);
    await this.pushFrame(new LLMFullResponseStartFrame());
    try {
      const stream = await abortable(
        this._chain.stream(
          { [this._transcriptKey]: text },
          {
            configurable: { session_id: this._participantId },
            signal: currentSignal(),
          },
        ),
      );
      const iterator = stream[Symbol.asyncIterator]();
      try {
        while (true) {
          // Awaiting the stream is a foreign await; make each step a
          // cancellation point.
          const result = await abortable(iterator.next());
          if (result.done) break;
          const frame = new TextFrame({ text: LangchainProcessor.#getTokenValue(result.value) });
          frame.includesInterFrameSpaces = true;
          await this.pushFrame(frame);
        }
      } finally {
        // Upstream logs a warning on GeneratorExit (the generator closed
        // prematurely); in JS that is closing the iterator early.
        await iterator.return?.().catch(() => undefined);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    } finally {
      await this.pushFrame(new LLMFullResponseEndFrame());
    }
  }
}
