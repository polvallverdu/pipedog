// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/llm_switcher.py

/** LLM switcher for switching between different LLMs at runtime, with different switching strategies. */

import { type Frame, LLMContextFrame } from "../frames/frames.ts";
import type { LLMContext } from "../processors/aggregators/llm_context.ts";
import type { FrameDirection, FrameProcessor } from "../processors/frame_processor.ts";
import type { FunctionCallHandler, LLMService } from "../services/llm_service.ts";
import {
  ServiceSwitcher,
  type ServiceSwitcherOptions,
  type ServiceSwitcherStrategy,
  type ServiceSwitcherStrategyManual,
} from "./service_switcher.ts";

type AnyLLMService = LLMService<any>;

/** Options forwarded to the active LLM's `runInference()`. */
export type LLMSwitcherRunInferenceOptions = Parameters<AnyLLMService["runInference"]>[1];

/**
 * A pipeline that switches between different LLMs at runtime.
 *
 * @example
 * const llmSwitcher = new LLMSwitcher([openaiLlm, anthropicLlm]);
 */
export class LLMSwitcher<
  S extends ServiceSwitcherStrategy = ServiceSwitcherStrategyManual,
> extends ServiceSwitcher<S> {
  /**
   * Initialize the service switcher with a list of LLMs and a switching strategy.
   *
   * @param llms List of LLM services to switch between.
   * @param options.strategyType The strategy class to use for switching
   *   between LLMs. Defaults to `ServiceSwitcherStrategyManual`.
   */
  constructor(llms: AnyLLMService[], options: ServiceSwitcherOptions<S> = {}) {
    super(llms as FrameProcessor[], options);
  }

  /**
   * Process a frame, syncing context tool handlers on all member LLMs.
   *
   * On an `LLMContextFrame`, the handlers advertised in the context are synced
   * on every member LLM — active or not — so that tools listed via
   * `new LLMContext({ tools: [...] })` keep working across service switches.
   *
   * This is needed because member LLMs sit behind per-branch filters: only the
   * active LLM receives the context frame and would otherwise sync its
   * handlers, leaving inactive LLMs out of step with the advertised tools.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof LLMContextFrame) {
      this._syncRegisteredToolHandlers(frame.context.tools);
    }
  }

  /**
   * Sync the context's tool handlers on every member LLM.
   *
   * @param tools The advertised tools whose handlers should be synced on all
   *   member LLMs.
   */
  protected _syncRegisteredToolHandlers(tools: unknown): void {
    for (const llm of this.llms) {
      // Protected on LLMService; the switcher drives its members' sync, as upstream does.
      (
        llm as unknown as { _syncRegisteredToolHandlers(tools: unknown): void }
      )._syncRegisteredToolHandlers(tools);
    }
  }

  /** The list of LLMs managed by this switcher. */
  get llms(): AnyLLMService[] {
    return this.services as AnyLLMService[];
  }

  /** The currently active LLM. */
  get activeLlm(): AnyLLMService {
    return this.strategy.activeService as AnyLLMService;
  }

  /**
   * Run a one-shot, out-of-band (i.e. out-of-pipeline) inference with the
   * given LLM context, using the currently active LLM.
   *
   * @param context The LLM context containing conversation history.
   * @param options Additional options forwarded to the active LLM's
   *   `runInference` (e.g. maxTokens, systemInstruction).
   * @returns The LLM's response as a string, or null if no response is generated.
   */
  async runInference(
    context: LLMContext,
    options: LLMSwitcherRunInferenceOptions = {},
  ): Promise<string | null> {
    if (this.activeLlm) {
      return await this.activeLlm.runInference(context, options);
    }
    return null;
  }

  /**
   * Register a function handler for LLM function calls, on all LLMs, active or not.
   *
   * @param functionName The name of the function to handle. Use null to handle
   *   all function calls with a catch-all handler.
   * @param handler The function handler. Should accept a single
   *   FunctionCallParams parameter.
   * @param options.cancelOnInterruption Whether to cancel this function call
   *   when an interruption occurs. Defaults to null (fall back to the
   *   `toolOptions()` value on the handler, then to true).
   * @param options.timeoutSecs Optional timeout in seconds for the function call.
   * @param options.cancellableByLlm Whether the LLM may cancel this call while
   *   it runs, through the `cancel_<name>` tool advertised alongside it. Pair
   *   it with `cancelOnInterruption: false`. Defaults to null (fall back to the
   *   `toolOptions()` value, then to false).
   */
  registerFunction(
    functionName: string | null,
    handler: FunctionCallHandler,
    options: {
      cancelOnInterruption?: boolean | null;
      timeoutSecs?: number | null;
      cancellableByLlm?: boolean | null;
    } = {},
  ): void {
    for (const llm of this.llms) {
      llm.registerFunction(functionName, handler, {
        cancelOnInterruption: options.cancelOnInterruption ?? null,
        timeoutSecs: options.timeoutSecs ?? null,
        cancellableByLlm: options.cancellableByLlm ?? null,
      });
    }
  }
}
