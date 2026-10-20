// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/workers/llm/llm_context_worker.py

/**
 * LLM worker with a built-in `LLMContext` and aggregator pair.
 *
 * Provides the `LLMContextWorker` class that extends `LLMWorker` with a
 * self-contained conversation context, removing the need for subclasses to
 * manually wire `LLMContextAggregatorPair`.
 */

import { Pipeline } from "../../pipeline/pipeline.ts";
import { LLMContext } from "../../processors/aggregators/llm_context.ts";
import {
  type LLMAssistantAggregator,
  type LLMAssistantAggregatorParams,
  LLMContextAggregatorPair,
  type LLMUserAggregator,
  type LLMUserAggregatorParams,
} from "../../processors/aggregators/llm_response_universal.ts";
import type { LLMService } from "../../services/llm_service.ts";
import { LLMWorker } from "./llm_worker.ts";

export interface LLMContextWorkerOptions {
  /**
   * Unique name for this worker on the bus. Auto-generated when omitted; give
   * one when other workers address this one by name, as they must when it
   * runs in another process.
   */
  name?: string | null;
  /** The LLM service. */
  llm: LLMService;
  /** Whether the worker starts active. Defaults to false. */
  active?: boolean;
  /**
   * Bridge configuration forwarded to `PipelineWorker`. Pass `[]` to wrap the
   * pipeline with bus edges so it can exchange frames with another bridged
   * worker.
   */
  bridged?: readonly string[] | null;
  /**
   * Whether to defer frames queued during tool execution until all tools
   * complete. Defaults to true.
   */
  deferToolFrames?: boolean;
  /** Optional pre-built `LLMContext`. When omitted, a fresh empty context is created. */
  context?: LLMContext | null;
  /** Optional parameters for the user aggregator. */
  userParams?: LLMUserAggregatorParams | null;
  /** Optional parameters for the assistant aggregator. */
  assistantParams?: LLMAssistantAggregatorParams | null;
}

/**
 * LLM worker that owns an `LLMContext` and a context aggregator pair.
 *
 * Useful for workers that need to track their own conversation history,
 * typically workers that run their own LLM pipeline outside of a shared
 * transport pipeline. Subclasses do not need to instantiate the context or
 * aggregators themselves; the pipeline is built as
 * `[userAggregator, llm, assistantAggregator]` automatically.
 *
 * @example
 * const worker = new LLMContextWorker({
 *   name: "worker",
 *   llm: new OpenAILLMService({ ... }),
 * });
 *
 * worker.assistantAggregator.addEventHandler(
 *   "on_assistant_turn_stopped",
 *   async (aggregator, message) => { ... },
 * );
 */
export class LLMContextWorker extends LLMWorker {
  protected _context: LLMContext;
  protected _aggregators: LLMContextAggregatorPair;

  /** Initialize the LLMContextWorker. */
  constructor(options: LLMContextWorkerOptions) {
    const context = options.context || new LLMContext();
    const aggregators = new LLMContextAggregatorPair(context, {
      userParams: options.userParams ?? null,
      assistantParams: options.assistantParams ?? null,
    });

    const pipeline = new Pipeline([aggregators.user(), options.llm, aggregators.assistant()]);

    super({
      name: options.name ?? null,
      llm: options.llm,
      pipeline,
      active: options.active ?? false,
      bridged: options.bridged ?? null,
      deferToolFrames: options.deferToolFrames ?? true,
    });

    this._context = context;
    this._aggregators = aggregators;
  }

  /** The `LLMContext` owned by this worker. */
  get context(): LLMContext {
    return this._context;
  }

  /** The user-side context aggregator. */
  get userAggregator(): LLMUserAggregator {
    return this._aggregators.user();
  }

  /** The assistant-side context aggregator. */
  get assistantAggregator(): LLMAssistantAggregator {
    return this._aggregators.assistant();
  }
}
