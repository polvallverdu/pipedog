// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/aws/agent_core.py

/**
 * AWS AgentCore Processor Module.
 *
 * This module defines the AWSAgentCoreProcessor, which invokes agents hosted on
 * Amazon Bedrock AgentCore Runtime and streams their responses as LLMTextFrames.
 *
 * Porting notes:
 * - `invoke_agent_runtime` is a SigV4-signed `fetch` (service
 *   `bedrock-agentcore`) to `POST /runtimes/{agentRuntimeArn}/invocations`,
 *   with the payload as the body and a fresh
 *   `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` (botocore fills that
 *   idempotency token with a UUID). Runs on Bun, Node, Deno and Cloudflare
 *   Workers.
 * - DIVERGENCE: no botocore default credential chain; keys come from the
 *   options, the environment, or the `credentialsProvider` option (called for
 *   every request).
 * - DIVERGENCE: a `text/event-stream` response is split into lines across
 *   body chunks (a line split between two chunks is joined), and a
 *   single-part response is read whole. Upstream treats each body chunk
 *   aiobotocore yields as its own set of lines, or its own response.
 */

import { abortable, currentSignal, monotonic, sleep, type Task } from "@pipedog/asyncio";
import {
  type Frame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
} from "@pipedog/core/frames/frames";
import {
  type LLMContext,
  LLMSpecificMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "@pipedog/core/processors/frame_processor";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { type AWSClientOptions, AWSSession, awsEndpoint } from "./aws_session.ts";
import { encodePathSegments } from "./sigv4.ts";

type Dict = Record<string, any>;

/**
 * Default transformer to create AgentCore payload from LLM context.
 *
 * Extracts the latest user or system message text and wraps it in {"prompt": "<text>"}.
 *
 * @param context The LLM context containing conversation messages.
 * @returns A JSON string payload for AgentCore, or null if no valid message found.
 */
export function defaultContextToPayloadTransformer(context: LLMContext): string | null {
  const messages = context.messages;

  if (messages.length === 0) {
    return null;
  }

  const lastMessage = messages[messages.length - 1];
  if (
    lastMessage instanceof LLMSpecificMessage ||
    !["user", "system"].includes((lastMessage as Dict).role)
  ) {
    return null;
  }

  const content = (lastMessage as Dict).content;
  if (!content) {
    return null;
  }

  let prompt: string;
  if (typeof content === "string") {
    prompt = content;
  } else if (Array.isArray(content)) {
    prompt = content.map((part: Dict) => part.text ?? "").join(" ");
  } else {
    return null;
  }

  return pyJsonDumps({ prompt });
}

/**
 * Default transformer to extract output text from AgentCore response.
 *
 * Expects responses with {"response": "<text>"} format.
 *
 * @param responseLine The raw response line from AgentCore (without "data: " prefix).
 * @returns The extracted output text, or null if no text found.
 */
export function defaultResponseToOutputTransformer(responseLine: string): string | null {
  const responseJson = pyJsonLoads(responseLine) as Dict;
  return responseJson.response ?? null;
}

export interface AWSAgentCoreProcessorOptions extends FrameProcessorOptions, AWSClientOptions {
  /** The Amazon Web Services Resource Name (ARN) of the agent. */
  agentArn: string;
  /** AWS access key ID. If null, falls back to environment variables and `credentialsProvider`. */
  awsAccessKey?: string | null;
  /** AWS secret access key. Same fallback behaviour as `awsAccessKey`. */
  awsSecretKey?: string | null;
  /** AWS session token for temporary credentials. */
  awsSessionToken?: string | null;
  /** AWS region. */
  awsRegion?: string | null;
  /**
   * Optional function to transform LLMContext into AgentCore payload string.
   * If null, uses `defaultContextToPayloadTransformer`.
   */
  contextToPayloadTransformer?: ((context: LLMContext) => string | null) | null;
  /**
   * Optional function to extract output text from AgentCore response. If null,
   * uses `defaultResponseToOutputTransformer`.
   */
  responseToOutputTransformer?: ((responseLine: string) => string | null) | null;
}

/**
 * Processor that runs an Amazon Bedrock AgentCore agent.
 *
 * Input:
 * - LLMContextFrame: Supplies a context used to invoke the agent.
 *
 * Output:
 * - LLMTextFrame: The agent's text response(s). A single agent invocation may
 *   result in multiple text frames.
 *
 * This processor transforms the input context to a payload for the AgentCore
 * agent, and transforms the agent's response(s) into output text frame(s). Both
 * mappings are configurable via transformers. Below is the default behavior.
 *
 * Input transformer (contextToPayloadTransformer):
 * - Grabs the latest user or system message (if it's the latest message)
 * - Extracts its text content
 * - Constructs a payload that looks like {"prompt": "<text>"}
 *
 * Output transformer (responseToOutputTransformer):
 * - Expects responses that look like {"response": "<text>"}
 * - Extracts the text for use in the LLMTextFrame(s)
 */
export class AWSAgentCoreProcessor extends FrameProcessor {
  protected _agentArn: string;
  protected _awsSession: AWSSession;
  protected _endpointUrl: string | null;
  protected _contextToPayloadTransformer: (context: LLMContext) => string | null;
  protected _responseToOutputTransformer: (responseLine: string) => string | null;
  protected _outputResponseOpen = false;
  protected _lastTextFrameTime: number | null = null;
  protected _closeTask: Task<unknown> | null = null;
  protected _outputResponseTimeout = 1.0; // seconds

  /**
   * Initialize the AWS AgentCore processor.
   *
   * @param options See `AWSAgentCoreProcessorOptions`. Other options are
   *   passed to the parent FrameProcessor.
   */
  constructor(options: AWSAgentCoreProcessorOptions) {
    super(options);

    this._agentArn = options.agentArn;

    // Explicit or environment keys. Without them, each request is signed
    // with keys from `credentialsProvider`.
    this._awsSession = AWSSession.fromOptions({
      awsAccessKeyId: options.awsAccessKey,
      awsSecretAccessKey: options.awsSecretKey,
      awsSessionToken: options.awsSessionToken,
      region: options.awsRegion,
      credentialsProvider: options.credentialsProvider,
      fetch: options.fetch,
    });
    this._endpointUrl = options.endpointUrl ?? null;

    // Set transformers with defaults
    this._contextToPayloadTransformer =
      options.contextToPayloadTransformer ?? defaultContextToPayloadTransformer;
    this._responseToOutputTransformer =
      options.responseToOutputTransformer ?? defaultResponseToOutputTransformer;
  }

  /** Close the output response after timeout if no new text frames arrive. */
  protected async _closeOutputResponseAfterTimeout(): Promise<void> {
    await sleep(this._outputResponseTimeout);
    if (this._outputResponseOpen) {
      this._outputResponseOpen = false;
      await this.pushFrame(new LLMFullResponseEndFrame());
    }
  }

  /** Push a text frame, managing output response bookends. */
  protected async _pushTextFrame(text: string): Promise<void> {
    // Cancel any pending close task
    if (this._closeTask && !this._closeTask.done()) {
      await this.cancelTask(this._closeTask);
    }

    // Open output response if needed
    if (!this._outputResponseOpen) {
      await this.pushFrame(new LLMFullResponseStartFrame());
      this._outputResponseOpen = true;
    }

    // Push the text frame
    await this.pushFrame(new LLMTextFrame({ text }));
    this._lastTextFrameTime = monotonic();

    // Schedule closing the output response after timeout
    this._closeTask = this.createTask(() => this._closeOutputResponseAfterTimeout());
  }

  /** Release resources held by this processor. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    if (this._closeTask) {
      await this.cancelTask(this._closeTask);
      this._closeTask = null;
    }
  }

  /** Invoke the agent runtime (botocore's `invoke_agent_runtime`). */
  protected async _invokeAgentRuntime(payload: string): Promise<Response> {
    const endpoint = awsEndpoint("bedrock-agentcore", this._awsSession.region, this._endpointUrl);
    const path = encodePathSegments("runtimes", this._agentArn, "invocations");
    return await abortable(
      this._awsSession.requestOk({
        service: "bedrock-agentcore",
        url: `${endpoint}${path}`,
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": crypto.randomUUID(),
        },
        body: new TextEncoder().encode(payload),
        signal: currentSignal(),
      }),
    );
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
      // Create payload to invoke AgentCore agent
      const payload = this._contextToPayloadTransformer(frame.context);

      if (!payload) {
        return;
      }

      // Invoke the AgentCore agent
      const response = await this._invokeAgentRuntime(payload);

      // Determine if this is a streamed multi-part response, which will
      // affect our parsing
      const isMultiPartResponse = (response.headers.get("content-type") ?? "").includes(
        "text/event-stream",
      );

      if (isMultiPartResponse) {
        // In streamed multi-part responses, each part might have one or more
        // lines, each of which starts with "data: ". Treat each line as a
        // response.
        const decoder = new TextDecoder();
        let pending = "";
        const handleLine = async (line: string) => {
          // Get response text from this line
          if (!line) {
            return;
          }
          if (!line.startsWith("data: ")) {
            logger.warning(`Expected line to start with 'data: ', got: ${line}`);
            return;
          }
          // Transform response line to output text
          const text = this._responseToOutputTransformer(line.slice(6)); // omit "data: "
          if (text) {
            await this._pushTextFrame(text);
          }
        };
        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await abortable(reader.read());
              if (done) break;
              pending += decoder.decode(value, { stream: true });
              const lines = pending.split("\n");
              pending = lines.pop() ?? "";
              for (const line of lines) await handleLine(line);
            }
          } finally {
            reader.releaseLock();
          }
        }
        pending += decoder.decode();
        await handleLine(pending);
      } else {
        // In single-part responses, the whole part is one response and
        // there's no "data: " prefix
        const partString = await abortable(response.text());
        if (partString) {
          // Transform response part string to output text
          const text = this._responseToOutputTransformer(partString);
          if (text) {
            await this._pushTextFrame(text);
          }
        }
      }

      // Final close if output response is still open after all parts processed
      if (this._outputResponseOpen) {
        if (this._closeTask && !this._closeTask.done()) {
          await this.cancelTask(this._closeTask);
        }
        this._outputResponseOpen = false;
        await this.pushFrame(new LLMFullResponseEndFrame());
      }
    } else {
      await this.pushFrame(frame, direction);
    }
  }
}
