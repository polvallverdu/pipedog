// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/aws/llm.py

/**
 * AWS Bedrock integration for Large Language Model services.
 *
 * This module provides AWS Bedrock LLM service implementation with support for
 * Amazon Nova and Anthropic Claude models, including vision capabilities and
 * function calling.
 *
 * Porting notes:
 * - There is no aiobotocore client. The service calls the Converse and
 *   ConverseStream REST APIs with `fetch`, signed with SigV4 on WebCrypto
 *   (`AWSSession`), so it runs on Bun, Node, Deno and Cloudflare Workers.
 *   ConverseStream's `application/vnd.amazon.eventstream` body is decoded
 *   into the same `{ <eventType>: {...} }` dicts botocore yields. Inline file
 *   bytes are base64-encoded in the request JSON, as boto3 does on the wire.
 * - Errors: an HTTP rejection and an exception event arriving mid-stream are
 *   both `AWSServiceError` (botocore's `ClientError` / `EventStreamError`),
 *   with `code` holding the AWS error code (`ValidationException`, or
 *   `validationException` mid-stream). A mid-stream exception has `status` 0.
 * - DIVERGENCE: `client_config` (botocore `Config`) is not ported. There is no
 *   client-side retry of throttled or 5xx requests (botocore retries up to 3
 *   attempts by default) and no 300 s connect/read timeouts; pass a `fetch`
 *   to add either. `retryTimeoutSecs` / `retryOnTimeout` behave as upstream.
 * - DIVERGENCE: credentials come from the options, the environment, or a
 *   `credentialsProvider` function (called per request); there is no botocore
 *   default credential chain. See `aws_session.ts`.
 * - Deprecated upstream APIs are not ported: `AWSBedrockLLMService.InputParams`
 *   and the `model`, `params` and `stop_sequences` constructor arguments.
 */

import {
  abortable,
  CancelledError,
  currentSignal,
  rethrowIfCancelled,
  TimeoutError,
  waitFor,
} from "@pipedog/asyncio";
import { LLMContextConversionError } from "@pipedog/core/adapters/llm/base_llm_adapter";
import {
  type Frame,
  FunctionCallFromLLM,
  LLMContextFrame,
  LLMEnablePromptCachingFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
} from "@pipedog/core/frames/frames";
import { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import type { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import type { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { LLMService, type LLMServiceOptions } from "@pipedog/core/services/llm_service";
import { LLMSettings, type LLMSettingsOptions } from "@pipedog/core/services/settings";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { isTimeoutException } from "@pipedog/core/utils/http";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { tracedLlm } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { type AWSClientOptions, AWSServiceError, AWSSession, awsEndpoint } from "./aws_session.ts";
import { AWSBedrockLLMAdapter, type AWSBedrockLLMInvocationParams } from "./bedrock_adapter.ts";
import { decodeEventStream, headerString } from "./event_stream.ts";
import { encodePathSegments } from "./sigv4.ts";

type Dict = Record<string, any>;

/** `str(e)` for an exception, as upstream's f-strings print it. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Options for `AWSBedrockLLMSettings`. */
export interface AWSBedrockLLMSettingsOptions extends LLMSettingsOptions {
  /** List of strings that stop generation. */
  stopSequences?: string[] | null | NotGiven;
  /** Performance mode - "standard" or "optimized". */
  latency?: string | null | NotGiven;
  /**
   * How much reasoning the model spends before answering — "low", "medium",
   * "high", "xhigh" or "max". Sent as Converse's `outputConfig.effort`; only
   * reasoning models accept it, and a model that does not support it rejects
   * the request. See:
   * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_OutputConfig.html
   */
  effort?: string | null | NotGiven;
  /**
   * Whether to enable prompt caching by adding cachePoint markers to system
   * prompts and tool definitions. Can reduce TTFT by up to 85% for multi-turn
   * conversations. See:
   * https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
   */
  enablePromptCaching?: boolean | NotGiven;
  /** Additional model-specific parameters. */
  additionalModelRequestFields?: Record<string, unknown> | NotGiven;
}

/**
 * Settings for AWSBedrockLLMService.
 *
 * - `stopSequences`: list of strings that stop generation.
 * - `latency`: performance mode - "standard" or "optimized".
 * - `effort`: how much reasoning the model spends before answering.
 * - `enablePromptCaching`: whether to add cachePoint markers.
 * - `additionalModelRequestFields`: additional model-specific parameters.
 */
export class AWSBedrockLLMSettings extends LLMSettings {
  stopSequences: string[] | null | NotGiven = NOT_GIVEN;
  latency: string | null | NotGiven = NOT_GIVEN;
  effort: string | null | NotGiven = NOT_GIVEN;
  enablePromptCaching: boolean | NotGiven = NOT_GIVEN;
  additionalModelRequestFields: Record<string, unknown> | NotGiven = NOT_GIVEN;

  constructor(options: AWSBedrockLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/** Options for `AWSBedrockLLMService`. */
export interface AWSBedrockLLMServiceOptions extends LLMServiceOptions, AWSClientOptions {
  /** AWS access key ID. If null, falls back to the `AWS_ACCESS_KEY_ID` environment variable. */
  awsAccessKey?: string | null;
  /** AWS secret access key. Same fallback behaviour as `awsAccessKey`. */
  awsSecretKey?: string | null;
  /** AWS session token for temporary credentials. */
  awsSessionToken?: string | null;
  /** AWS region for the Bedrock service. */
  awsRegion?: string | null;
  /**
   * Runtime-updatable settings for this service. Values given here override
   * the service defaults.
   */
  settings?: AWSBedrockLLMSettings | null;
  /** Request timeout in seconds for retry logic. Defaults to 5.0. */
  retryTimeoutSecs?: number | null;
  /** Whether to retry the request once if it times out. Defaults to false. */
  retryOnTimeout?: boolean | null;
}

/** A Converse(Stream) response: the stream of events botocore would yield. */
export interface ConverseStreamResponse {
  stream: AsyncIterable<Dict>;
}

/**
 * The part of the `bedrock-runtime` client the service uses, over HTTP.
 * `modelId` is taken out of the params and put in the path.
 */
export class BedrockRuntimeHttpClient {
  readonly #session: AWSSession;
  readonly #endpoint: string;

  constructor(options: { session: AWSSession; endpointUrl?: string | null }) {
    this.#session = options.session;
    this.#endpoint = awsEndpoint("bedrock-runtime", options.session.region, options.endpointUrl);
  }

  async #post(operation: string, params: Dict, signal: AbortSignal): Promise<Response> {
    const { modelId, ...body } = params;
    const url = `${this.#endpoint}${encodePathSegments("model", String(modelId), operation)}`;
    return this.#session.requestOk({
      service: "bedrock",
      url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: pyJsonDumps(toWireJson(body)),
      signal,
    });
  }

  /** `Converse`: returns the parsed response JSON. */
  async converse(params: Dict, options: { signal: AbortSignal }): Promise<Dict> {
    const response = await this.#post("converse", params, options.signal);
    return pyJsonLoads(await abortable(response.text())) as Dict;
  }

  /** `ConverseStream`: resolves once the response headers arrive. */
  async converseStream(
    params: Dict,
    options: { signal: AbortSignal },
  ): Promise<ConverseStreamResponse> {
    const response = await this.#post("converse-stream", params, options.signal);
    if (!response.body) throw new Error("ConverseStream response has no body");
    return { stream: converseEvents(response.body) };
  }
}

/** Decode a ConverseStream body into botocore-shaped event dicts. */
async function* converseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Dict> {
  const decoder = new TextDecoder();
  for await (const message of decodeEventStream(body)) {
    const messageType = headerString(message, ":message-type");
    const text = decoder.decode(message.body);
    const payload = text ? (pyJsonLoads(text) as Dict) : {};
    if (messageType === "event") {
      const eventType = headerString(message, ":event-type") ?? "unknown";
      yield { [eventType]: payload };
    } else {
      const code =
        headerString(message, ":exception-type") ?? headerString(message, ":error-code") ?? null;
      const msg = String(
        payload.message ?? payload.Message ?? headerString(message, ":error-message") ?? "",
      );
      throw new AWSServiceError({
        status: 0,
        code,
        message: `An error occurred (${code}) when calling the ConverseStream operation: ${msg}`,
        body: text,
      });
    }
  }
}

/** Replace raw bytes with base64 strings, as boto3 serializes blobs. */
function toWireJson(value: unknown): unknown {
  if (value instanceof Uint8Array) return bytesToBase64(value);
  if (Array.isArray(value)) return value.map(toWireJson);
  if (value !== null && typeof value === "object") {
    const out: Dict = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = toWireJson(v);
    }
    return out;
  }
  return value;
}

/**
 * AWS Bedrock Large Language Model service implementation.
 *
 * Provides inference capabilities for AWS Bedrock models including Amazon Nova
 * and Anthropic Claude. Supports streaming responses, function calling, and
 * vision capabilities.
 */
export class AWSBedrockLLMService extends LLMService<AWSBedrockLLMAdapter> {
  static Settings = AWSBedrockLLMSettings;
  declare protected _settings: AWSBedrockLLMSettings;

  // Overriding the default adapter to use the Bedrock one.
  static override adapterClass = AWSBedrockLLMAdapter;

  /**
   * Claude models known to support assistant message prefilling (a request
   * whose message list ends with an assistant message). Anthropic dropped
   * prefill support starting with the 4.6-generation models, so this is a
   * frozen legacy set: any Claude model NOT matching is assumed to reject
   * prefill and gets a trailing user message injected when needed.
   */
  static _PREFILL_SUPPORTED_PATTERNS: readonly string[] = [
    "claude-2",
    "claude-instant",
    "claude-3",
    "claude-opus-4-0",
    "claude-opus-4-1",
    "claude-sonnet-4-0",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
  ];

  protected _awsSession: AWSSession;
  protected _endpointUrl: string | null;
  protected _retryTimeoutSecs: number | null;
  protected _retryOnTimeout: boolean | null;

  static {
    // `@traced_llm` on `_process_context`.
    AWSBedrockLLMService.prototype._processContext = tracedLlm(
      AWSBedrockLLMService.prototype._processContext,
    );
  }

  /**
   * Initialize the AWS Bedrock LLM service.
   *
   * @param options See `AWSBedrockLLMServiceOptions`.
   */
  constructor(options: AWSBedrockLLMServiceOptions = {}) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new AWSBedrockLLMSettings({
      model: "us.amazon.nova-lite-v1:0",
      systemInstruction: null,
      maxTokens: null,
      temperature: null,
      topP: null,
      topK: null,
      frequencyPenalty: null,
      presencePenalty: null,
      seed: null,
      filterIncompleteUserTurns: false,
      userTurnCompletionConfig: null,
      stopSequences: null,
      latency: null,
      effort: null,
      enablePromptCaching: false,
      additionalModelRequestFields: {},
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== null && options.settings !== undefined) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, settings: defaultSettings });

    // Explicit or environment keys. Without them, each request is signed with
    // the provider's current keys.
    this._awsSession = AWSSession.fromOptions({
      awsAccessKeyId: options.awsAccessKey,
      awsSecretAccessKey: options.awsSecretKey,
      awsSessionToken: options.awsSessionToken,
      region: options.awsRegion,
      credentialsProvider: options.credentialsProvider,
      fetch: options.fetch,
    });
    this._endpointUrl = options.endpointUrl ?? null;

    this._retryTimeoutSecs =
      options.retryTimeoutSecs === undefined ? 5.0 : options.retryTimeoutSecs;
    this._retryOnTimeout = options.retryOnTimeout ?? false;

    logger.info(`Using AWS Bedrock model: ${this._settings.model}`);
    if (this._settings.systemInstruction) {
      logger.debug(`${this}: Using system instruction: ${this._settings.systemInstruction}`);
    }
  }

  /**
   * Check if the service can generate usage metrics.
   *
   * @returns True if metrics generation is supported.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /** A `bedrock-runtime` client (upstream's `create_client("bedrock-runtime")`). */
  protected _createClient(): BedrockRuntimeHttpClient {
    return new BedrockRuntimeHttpClient({
      session: this._awsSession,
      endpointUrl: this._endpointUrl,
    });
  }

  /**
   * Build inference config with only the parameters that are set.
   *
   * This prevents conflicts with models (e.g., Claude Sonnet 4.5) that don't
   * allow certain parameter combinations like temperature and top_p together.
   *
   * @returns Object containing only the inference parameters that are not null.
   */
  protected _buildInferenceConfig(): Dict {
    const inferenceConfig: Dict = {};
    const s = this._settings;
    if (s.maxTokens !== null && s.maxTokens !== NOT_GIVEN) {
      inferenceConfig.maxTokens = s.maxTokens;
    }
    if (s.temperature !== null && s.temperature !== NOT_GIVEN) {
      inferenceConfig.temperature = s.temperature;
    }
    if (s.topP !== null && s.topP !== NOT_GIVEN) {
      inferenceConfig.topP = s.topP;
    }
    const stopSequences = s.stopSequences;
    if (Array.isArray(stopSequences) && stopSequences.length > 0) {
      inferenceConfig.stopSequences = stopSequences;
    }
    return inferenceConfig;
  }

  /**
   * Run a one-shot, out-of-band (i.e. out-of-pipeline) inference with the given LLM context.
   *
   * @param context The LLM context containing conversation history.
   * @param options.maxTokens Optional maximum number of tokens to generate. If
   *   provided, overrides the service's default max_tokens setting.
   * @param options.systemInstruction Optional system instruction to use for this
   *   inference. If provided, overrides any system instruction in the context.
   * @param options.responseSchema Accepted for interface compatibility.
   *   Bedrock's Converse API has no reply schema, so it is not enforced.
   * @returns The LLM's response as a string, or null if no response is generated.
   */
  override async runInference(
    context: LLMContext,
    options: {
      maxTokens?: number | null;
      systemInstruction?: string | null;
      responseSchema?: Record<string, unknown> | null;
    } = {},
  ): Promise<string | null> {
    this._checkResponseSchema(options.responseSchema);
    const effectiveInstruction =
      options.systemInstruction || assertGiven(this._settings.systemInstruction);
    const adapter = this.getLlmAdapter();
    const params = await adapter.getLlmInvocationParams(context, {
      systemInstruction: effectiveInstruction,
      ensureLastMessageIsUser: this._shouldInjectTrailingUserMessage(),
    });
    const messages = params.messages;
    const system = params.system; // [{"text": "system message"}] or null

    // Prepare request parameters using the same method as streaming
    const inferenceConfig = this._buildInferenceConfig();

    // Override maxTokens if provided
    if (options.maxTokens !== null && options.maxTokens !== undefined) {
      inferenceConfig.maxTokens = options.maxTokens;
    }

    const requestParams: Dict = {
      modelId: this._settings.model,
      messages,
      additionalModelRequestFields: this._settings.additionalModelRequestFields,
    };

    if (Object.keys(inferenceConfig).length > 0) {
      requestParams.inferenceConfig = inferenceConfig;
    }

    if (assertGiven(this._settings.effort)) {
      requestParams.outputConfig = { effort: this._settings.effort };
    }

    if (system && system.length > 0) {
      requestParams.system = system;
    }

    const client = this._createClient();
    // Call Bedrock without streaming
    const response = await client.converse(requestParams, { signal: currentSignal() });

    // Extract the response text
    const content = response?.output?.message?.content;
    if (content !== undefined) {
      if (Array.isArray(content)) {
        for (const item of content as Dict[]) {
          if (item?.text) {
            return item.text as string;
          }
        }
      } else if (typeof content === "string") {
        return content;
      }
    }

    return null;
  }

  /**
   * Create converse stream with optional timeout and retry.
   *
   * @param client The AWS Bedrock client instance.
   * @param requestParams Parameters for the converse_stream call.
   * @returns Async stream of response events.
   */
  protected async _createConverseStream(
    client: BedrockRuntimeHttpClient,
    requestParams: Dict,
  ): Promise<ConverseStreamResponse> {
    if (this._retryOnTimeout) {
      const attempt = new AbortController();
      try {
        const response = await waitFor(
          () =>
            client.converseStream(requestParams, {
              signal: AbortSignal.any([currentSignal(), attempt.signal]),
            }),
          this._retryTimeoutSecs,
        );
        return response;
      } catch (e) {
        if (e instanceof TimeoutError || isTimeoutException(e)) {
          // Stop the request that timed out.
          attempt.abort();
          // Retry, this time without a timeout so we get a response
          logger.debug(`${this}: Retrying converse_stream due to timeout`);
          const response = await client.converseStream(requestParams, { signal: currentSignal() });
          return response;
        }
        throw e;
      }
    }
    const response = await client.converseStream(requestParams, { signal: currentSignal() });
    return response;
  }

  /**
   * Create a no-operation tool for AWS Bedrock when tool content exists but no tools are defined.
   *
   * This is required because AWS Bedrock doesn't allow empty tool configurations after tools were
   * previously set. Other LLM vendors allow NOT_GIVEN or empty tool configurations,
   * but AWS Bedrock requires at least one tool to be defined.
   */
  protected _createNoOpTool(): Dict {
    return {
      toolSpec: {
        name: "no_operation",
        description: "Internal placeholder function. Do not call this function.",
        inputSchema: { json: { type: "object", properties: {}, required: [] } },
      },
    };
  }

  /**
   * Whether to fix up requests whose message list ends with an assistant message.
   *
   * Claude models without assistant-prefill support reject such requests,
   * so injection is on for any Claude model not known to support prefill.
   * Non-Claude Bedrock models are left untouched. Subclasses with exotic
   * model naming can override `_PREFILL_SUPPORTED_PATTERNS`.
   *
   * Bedrock model identifiers typically look like
   * `us.anthropic.claude-sonnet-4-6-v1:0` or `anthropic.claude-opus-4-6-v1:0`,
   * so patterns are matched as substrings.
   */
  protected _shouldInjectTrailingUserMessage(): boolean {
    const model = assertGiven(this._settings.model) || "";
    if (!model.includes("claude")) {
      return false;
    }
    const patterns = (this.constructor as typeof AWSBedrockLLMService)._PREFILL_SUPPORTED_PATTERNS;
    return !patterns.some((p) => model.includes(p));
  }

  protected async _getLlmInvocationParams(
    context: LLMContext,
  ): Promise<AWSBedrockLLMInvocationParams> {
    const adapter = this.getLlmAdapter();
    const params = await adapter.getLlmInvocationParams(context, {
      systemInstruction: assertGiven(this._settings.systemInstruction),
      ensureLastMessageIsUser: this._shouldInjectTrailingUserMessage(),
    });
    return params;
  }

  protected async _processContext(context: LLMContext): Promise<void> {
    // Usage tracking
    let promptTokens = 0;
    let completionTokens = 0;
    let completionTokensEstimate = 0;
    let cacheReadInputTokens = 0;
    let cacheCreationInputTokens = 0;
    let useCompletionTokensEstimate = false;

    let usingNoopTool = false;

    try {
      await this.pushFrame(new LLMFullResponseStartFrame());
      await this.startProcessingMetrics();

      await this.startTtfbMetrics();

      const paramsFromContext = await this._getLlmInvocationParams(context);
      const messages = paramsFromContext.messages;
      const system = paramsFromContext.system;
      let tools = paramsFromContext.tools;
      const toolChoice = paramsFromContext.tool_choice as unknown;

      // Set up inference config - only include parameters that are set
      const inferenceConfig = this._buildInferenceConfig();

      // Prepare request parameters
      const requestParams: Dict = {
        modelId: this._settings.model,
        messages,
        additionalModelRequestFields: this._settings.additionalModelRequestFields,
      };

      // Only add inference config if it has parameters
      if (Object.keys(inferenceConfig).length > 0) {
        requestParams.inferenceConfig = inferenceConfig;
      }

      // Add system message
      if (system && system.length > 0) {
        requestParams.system = system;
      }

      // Check if messages contain tool use or tool result content blocks
      let hasToolContent = false;
      for (const message of messages) {
        if (Array.isArray(message.content)) {
          for (const contentItem of message.content as Dict[]) {
            if ("toolUse" in contentItem || "toolResult" in contentItem) {
              hasToolContent = true;
              break;
            }
          }
        }
        if (hasToolContent) {
          break;
        }
      }

      // Handle tools: use current tools, or no-op if tool content exists but no current tools
      if (hasToolContent && tools.length === 0) {
        tools = [this._createNoOpTool()];
        usingNoopTool = true;
      }

      if (tools.length > 0) {
        const toolConfig: Dict = { tools };

        // Only add tool_choice if we have real tools (not just no-op)
        if (!usingNoopTool && toolChoice && toolChoice !== NOT_GIVEN) {
          if (toolChoice === "auto") {
            toolConfig.toolChoice = { auto: {} };
          } else if (toolChoice === "none") {
            // Skip adding toolChoice for "none"
          } else if (typeof toolChoice === "object" && "function" in (toolChoice as Dict)) {
            toolConfig.toolChoice = {
              tool: { name: (toolChoice as Dict).function.name },
            };
          }
        }

        requestParams.toolConfig = toolConfig;
      }

      // Add performance config if latency is specified
      const latency = this._settings.latency;
      if (latency === "standard" || latency === "optimized") {
        requestParams.performanceConfig = { latency };
      }

      if (assertGiven(this._settings.effort)) {
        requestParams.outputConfig = { effort: this._settings.effort };
      }

      // Add cache checkpoints to system prompts and tool definitions.
      // This enables prompt caching for providers that support it (e.g.
      // Anthropic Claude on Bedrock), reducing TTFT by up to 85% on
      // multi-turn conversations where the system prompt stays constant.
      if (assertGiven(this._settings.enablePromptCaching)) {
        const systemList = requestParams.system as Dict[] | undefined;
        if (systemList && systemList.length > 0) {
          if (!systemList.some((item) => "cachePoint" in item)) {
            systemList.push({ cachePoint: { type: "default" } });
          }
        }
        const toolsList = requestParams.toolConfig?.tools as Dict[] | undefined;
        if (toolsList && toolsList.length > 0) {
          if (!toolsList.some((t) => "cachePoint" in t)) {
            toolsList.push({ cachePoint: { type: "default" } });
          }
        }
      }

      this._logLlmResponse(context);

      const client = this._createClient();
      // Call AWS Bedrock with streaming
      const response = await this._createConverseStream(client, requestParams);

      // Process the streaming response. Bedrock emits each tool call as
      // its own content block, identified by contentBlockIndex, so we key
      // accumulators by index to capture parallel tool calls instead of
      // only the last one.
      const toolUseBlocks = new Map<number, { id: string; name: string }>();
      const jsonAccumulators = new Map<number, string>();

      const functionCalls: FunctionCallFromLLM[] = [];

      const iterator = response.stream[Symbol.asyncIterator]();
      while (true) {
        const next = await abortable(iterator.next());
        if (next.done) break;
        const event = next.value as Dict;

        // The events that open the stream (messageStart) carry no
        // model output, so TTFB ends at the first content block.
        if ("contentBlockStart" in event || "contentBlockDelta" in event) {
          await this.stopTtfbMetrics();
        }

        // Handle text content
        if ("contentBlockDelta" in event) {
          const block = event.contentBlockDelta as Dict;
          const delta = block.delta as Dict;
          if ("text" in delta) {
            await this._pushLlmText(delta.text);
            completionTokensEstimate += this._estimateTokens(delta.text);
          } else if ("toolUse" in delta && "input" in delta.toolUse) {
            // Handle partial JSON for tool use
            const index = block.contentBlockIndex as number;
            jsonAccumulators.set(index, (jsonAccumulators.get(index) ?? "") + delta.toolUse.input);
            completionTokensEstimate += this._estimateTokens(delta.toolUse.input);
          }
        }
        // Handle tool use start
        else if ("contentBlockStart" in event) {
          const block = event.contentBlockStart as Dict;
          const contentBlockStart = block.start as Dict;
          if ("toolUse" in contentBlockStart) {
            // A turn that only calls tools produces no answer text,
            // so the call itself is what the caller gets and TTFAT
            // ends here rather than going unmeasured.
            await this.stopTtfatMetrics();
            const index = block.contentBlockIndex as number;
            toolUseBlocks.set(index, {
              id: contentBlockStart.toolUse.toolUseId ?? "",
              name: contentBlockStart.toolUse.name ?? "",
            });
            jsonAccumulators.set(index, "");
          }
        }
        // Handle tool use completion
        else if ("contentBlockStop" in event) {
          const index = event.contentBlockStop.contentBlockIndex as number;
          const toolUseBlock = toolUseBlocks.get(index);
          toolUseBlocks.delete(index);
          if (toolUseBlock) {
            const jsonAccumulator = jsonAccumulators.get(index) ?? "";
            jsonAccumulators.delete(index);
            try {
              const args = jsonAccumulator
                ? (pyJsonLoads(jsonAccumulator) as Record<string, unknown>)
                : {};

              // Only call function if it's not the no_operation tool
              if (!usingNoopTool) {
                functionCalls.push(
                  new FunctionCallFromLLM({
                    context,
                    toolCallId: toolUseBlock.id,
                    functionName: toolUseBlock.name,
                    arguments: args,
                  }),
                );
              } else {
                logger.debug("Ignoring no_operation tool call");
              }
            } catch (e) {
              if (!(e instanceof SyntaxError)) throw e;
              logger.error(`Failed to parse tool arguments: ${jsonAccumulator}`);
            }
          }
        }

        // Handle usage metrics if available
        if ("metadata" in event && "usage" in event.metadata) {
          const usage = event.metadata.usage as Dict;
          promptTokens += usage.inputTokens ?? 0;
          completionTokens += usage.outputTokens ?? 0;
          cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
          cacheCreationInputTokens += usage.cacheWriteInputTokens ?? 0;
        }
      }

      await this.runFunctionCalls(functionCalls);
    } catch (e) {
      if (e instanceof CancelledError) {
        // If we're interrupted, we won't get a complete usage report. So set our flag to use the
        // token estimate. The reraise the exception so all the processors running in this task
        // also get cancelled.
        useCompletionTokensEstimate = true;
        throw e;
      }
      if (isTimeoutException(e)) {
        await this._callEventHandler("on_completion_timeout");
      } else if (e instanceof LLMContextConversionError) {
        await this.pushError(errorMessage(e), { exception: e });
        // A conversion failure (e.g. an unsupported file MIME type, corrupt
        // base64 data) can't reach the API at all, but is just as much
        // evidence of an invalid file as a rejection from Bedrock itself, so
        // it gets the same best-effort cleanup.
        context.removeInvalidFileMessage();
      } else if (e instanceof AWSServiceError) {
        // AWS uses a single exception class for the whole 4xx/5xx range, so
        // check the error code directly rather than the status code:
        // ValidationException (bad document name, unsupported format, etc.)
        // is grounds to remove a pending file message on a best-effort
        // basis, but AccessDeniedException, ThrottlingException, and the
        // rest say nothing about whether our request (or its file) was bad,
        // and removing the file there would discard it for no benefit. When
        // a message is removed as a result of this error, the fault lay in
        // application-supplied content and the context is repaired, so the
        // error is pushed as APPLICATION instead of letting the rejection
        // classify as permanent and cost the service its usability.
        // Compared case-insensitively: an up-front request rejection
        // reports ValidationException, but a rejection arriving mid-stream
        // (e.g. the model refusing a file's content) reports the event
        // stream's modeled code, validationException.
        const errorCode = e.code ?? "";
        const removed =
          errorCode.toLowerCase() === "validationexception" && context.removeInvalidFileMessage();
        await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, {
          exception: e,
          category: removed ? ErrorCategory.APPLICATION : null,
        });
      } else {
        rethrowIfCancelled(e);
        await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      }
    } finally {
      await this.stopProcessingMetrics();
      await this.pushFrame(new LLMFullResponseEndFrame());
      const compTokens = !useCompletionTokensEstimate ? completionTokens : completionTokensEstimate;
      await this._reportUsageMetrics(
        promptTokens,
        compTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
      );
    }
  }

  /**
   * Process incoming frames and handle LLM-specific frame types.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof LLMContextFrame) {
      await this._processContext(frame.context as LLMContext);
    } else if (frame instanceof LLMEnablePromptCachingFrame) {
      logger.debug(`Setting enable prompt caching to: [${frame.enable}]`);
      this._settings.enablePromptCaching = frame.enable;
    } else {
      await this.pushFrame(frame, direction);
    }
  }

  protected _estimateTokens(text: string): number {
    return Math.trunc(text.split(/[^\p{L}\p{N}_]+/u).length * 1.3);
  }

  protected async _reportUsageMetrics(
    promptTokens: number,
    completionTokens: number,
    cacheReadInputTokens: number,
    cacheCreationInputTokens: number,
  ): Promise<void> {
    if (promptTokens || completionTokens || cacheReadInputTokens || cacheCreationInputTokens) {
      const tokens = new LLMTokenUsage({
        promptTokens,
        completionTokens,
        // Bedrock reports inputTokens net of the cache, so the cached
        // tokens are added back. The provider's own totalTokens is unused
        // because an interrupted turn reports an estimated completion
        // count, which the total has to agree with.
        totalTokens:
          promptTokens + cacheCreationInputTokens + cacheReadInputTokens + completionTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
      });
      await this.startLlmUsageMetrics(tokens);
    }
  }
}
