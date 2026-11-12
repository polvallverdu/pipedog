// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/llm_with_backend/llm_with_backend.py

/**
 * The `LLMWithBackend` pipeline, which puts a frontend and its backend where
 * an LLM goes.
 */

import type { Task } from "@pipedog/asyncio";
import type { FunctionSchema } from "../../adapters/llm/schemas/function_schema.ts";
import type { FrameProcessorSetup } from "../../processors/frame_processor.ts";
import type { FunctionCallHandler, LLMService } from "../../services/llm_service.ts";
import { logger } from "../../utils/logger.ts";
import { BackendLLMWorker } from "../../workers/llm/backend_llm_worker.ts";
import { Pipeline } from "../pipeline.ts";
import type { PipelineWorker } from "../worker.ts";
import { BackendConnector, ConnectorContext } from "./connector.ts";
import type { PredictiveDelegation } from "./predictive_delegation.ts";

type AnyLLMService = LLMService<any>;

export interface LLMWithBackendOptions {
  /** The conversational LLM service, text or speech-to-speech. */
  frontend: AnyLLMService;
  /**
   * The backend worker, or the name of one registered elsewhere (in the app,
   * or in another process on a shared bus). A worker given here is added to
   * the pipeline worker at setup.
   */
  backend: BackendLLMWorker | string;
  /** How delegation works. A default `BackendConnector` when omitted. */
  connector?: BackendConnector | null;
  /**
   * A `PredictiveDelegation`, to speed up responses that need backend
   * involvement: its classifier determines whether to wait for the frontend's
   * inference or go ahead and trigger an early backend delegation. Only for a
   * text frontend.
   */
  predictiveDelegation?: PredictiveDelegation | null;
}

/**
 * A conversational LLM, kept fast and light, with a backend that does the
 * work it hands off.
 *
 * **Alpha.** The API is unstable: names, arguments, the strategies and the job
 * contract are likely to change between releases.
 *
 * Put it where the LLM goes in a pipeline. It is a `Pipeline`, not an
 * `LLMService`: functions, settings updates, event handlers and a
 * `FlowManager` go on `frontend`. It wraps the frontend service, installs the
 * connector's tools on it as built-in tools, appends the connector's guidance
 * to the frontend's system instruction, adds a local backend worker to the
 * pipeline worker so the app never wires it up, and holds the session with
 * the backend for the pipeline's life. A built-in tool is sent on every
 * inference beside whatever tools the frontend has, and never enters the
 * context's tool set, so a tool change announced to the model never mentions
 * it. The tools are the backend's; the frontend has `delegate` and no more,
 * though a tool it must keep, in its context or configured on the service,
 * stays.
 *
 * The guidance is the connector's pairing instruction (how to work with a
 * backend: when and how to delegate, and what to do with the backend's
 * messages) with the strategy's (how the request is worded) in place. The
 * frontend's own system instruction is the place to say what the backend is
 * for, in plain words, as the backend's own instruction does: no tool names,
 * nothing to update when a tool changes.
 *
 * @example
 * const llm = new LLMWithBackend({
 *   frontend: new OpenAILLMService({ ... }),
 *   backend: new BackendLLMWorker({
 *     llm: new AnthropicLLMService({ ... }),
 *     context: new LLMContext({ tools: [getWeather] }),
 *   }),
 * });
 * const pipeline = new Pipeline([transport.input(), stt, userAgg, llm, tts, transport.output(), assistantAgg]);
 */
export class LLMWithBackend extends Pipeline {
  protected _frontend: AnyLLMService;
  protected _backend: BackendLLMWorker | string;
  protected _connector: BackendConnector;
  protected _predictiveDelegation: PredictiveDelegation | null;
  protected _sessionTask: Task<unknown> | null = null;

  /**
   * Initialize the service.
   *
   * @param options See `LLMWithBackendOptions`.
   * @throws Error If the frontend service declines the role; if the
   *   connector's request strategy reads the frontend's context and the
   *   frontend is speech-to-speech; or if predictive delegation is given with
   *   a speech-to-speech frontend or with a request strategy whose `delegate`
   *   call needs arguments.
   */
  constructor(options: LLMWithBackendOptions) {
    const { frontend, backend } = options;
    const predictiveDelegation = options.predictiveDelegation ?? null;
    logger.warning("LLMWithBackend is alpha: its API is likely to change between releases.");
    const objection = frontend.llmWithBackendRoleObjection("frontend");
    if (objection) {
      throw new Error(objection);
    }
    // DIVERGENCE: upstream assigns its fields before calling the base
    // constructor; JS needs `super()` first, so the setup runs on locals and
    // the fields are assigned after it.
    const connector = options.connector || new BackendConnector();
    const frontendIsRealtime = frontend.serviceMetadataFrame().isRealtimeService;
    connector.bind(
      new ConnectorContext({
        backendName: typeof backend === "string" ? backend : backend.name,
        frontendIsRealtime,
      }),
    );
    if (predictiveDelegation !== null) {
      if (frontendIsRealtime) {
        throw new Error(
          "Predictive delegation needs a text frontend: a speech-to-speech frontend " +
            "replies to the user's audio before the turn's transcript reaches its " +
            "context, so there is no turn to classify in time.",
        );
      }
      if (connector.requestStrategy.delegateNeedsArguments) {
        throw new Error(
          "Predictive delegation makes its delegate call with no arguments, which " +
            `${connector.requestStrategy.constructor.name} can't build a request ` +
            "from. Use a strategy that needs none, such as " +
            "TranscriptBackendRequestStrategy.",
        );
      }
    }
    const instruction = connector.frontendInstruction;
    if (instruction) {
      frontend.appendSystemInstruction(instruction);
    }
    for (const tool of connector.tools) {
      frontend.registerFunction(tool.name, tool.handler as FunctionCallHandler, {
        cancelOnInterruption: false,
      });
      frontend.getLlmAdapter().builtinTools[tool.name] = tool;
    }
    if (predictiveDelegation !== null) {
      predictiveDelegation._bind(frontend, connector);
      super([predictiveDelegation, frontend]);
    } else {
      super([frontend]);
    }
    this._frontend = frontend;
    this._backend = backend;
    this._connector = connector;
    this._predictiveDelegation = predictiveDelegation;
  }

  /** The frontend LLM service. */
  get frontend(): AnyLLMService {
    return this._frontend;
  }

  /** The backend worker, or its name. */
  get backend(): BackendLLMWorker | string {
    return this._backend;
  }

  /** The connector joining the two layers. */
  get connector(): BackendConnector {
    return this._connector;
  }

  /** The PredictiveDelegation in front of the frontend, if there is one. */
  get predictiveDelegation(): PredictiveDelegation | null {
    return this._predictiveDelegation;
  }

  /** The `delegate` tool installed on the frontend. */
  get tool(): FunctionSchema {
    return this._connector.tool;
  }

  /**
   * Register a local backend worker as a child of the pipeline worker, set up
   * the frontend, and open the session.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    // Before setting the frontend up: it gets the StartFrame as soon as its
    // own setup is done, and can delegate from then on.
    if (this._backend instanceof BackendLLMWorker) {
      await (setup.pipelineWorker as PipelineWorker).addWorkers(this._backend);
    }
    await super.setup(setup);
    this._sessionTask = this.createTask(
      () => this._connector.runSession(this.pipelineWorker, this._frontend),
      `${this}::backend_session`,
    );
  }

  /** Close the session with the backend, then clean up the frontend. */
  override async cleanup(): Promise<void> {
    if (this._sessionTask !== null) {
      await this.cancelTask(this._sessionTask);
      this._sessionTask = null;
    }
    await super.cleanup();
  }
}
