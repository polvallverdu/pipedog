// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Tracing and error alerts for the voice bot. Both are off unless configured:
//
// - OTEL_EXPORTER_OTLP_ENDPOINT: an OTLP/HTTP traces endpoint (for example
//   http://localhost:4318/v1/traces). Each conversation is traced: its turns, and
//   the speech-to-text, LLM and speech synthesis calls in them.
// - ERROR_WEBHOOK_URL: pipeline errors are POSTed there as JSON. The body has a
//   `text` field, so a Slack-style incoming webhook can take it as is.

import { rethrowIfCancelled } from "@pipedog/asyncio";
import type { ErrorFrame } from "@pipedog/core/frames/frames";
import type { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { logger } from "@pipedog/core/utils/logger";
import { OTLPTraceExporter, setupTracing } from "@pipedog/tracing";

/** Alerts per conversation, at most: a broken session shouldn't flood the channel. */
const MAX_ALERTS_PER_CONVERSATION = 5;

let tracing: boolean | null = null;

/** Starts tracing once per process when OTEL_EXPORTER_OTLP_ENDPOINT is set; returns whether it's on. */
export function startTracing(): boolean {
  if (tracing === null) {
    const url = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    tracing = url
      ? setupTracing({ serviceName: "voice-bot", exporter: new OTLPTraceExporter({ url }) })
      : false;
  }
  return tracing;
}

/** An error alert, as POSTed to the webhook. */
export interface ErrorAlert {
  text: string;
  conversationId: string;
  error: string;
  processor: string | null;
  category: string | null;
  at: string;
}

/**
 * Logs each pipeline error of `worker`, and POSTs it to `webhookUrl` (default:
 * ERROR_WEBHOOK_URL) once per distinct message, up to a few per conversation.
 */
export function reportErrors(
  worker: PipelineWorker,
  conversationId: string,
  webhookUrl: string | undefined = process.env.ERROR_WEBHOOK_URL,
): void {
  const alerted = new Set<string>();
  worker.eventHandler("on_pipeline_error", async (_worker: PipelineWorker, frame: ErrorFrame) => {
    logger.error(`conversation ${conversationId}: ${frame.error}`);
    if (!webhookUrl || alerted.has(frame.error) || alerted.size >= MAX_ALERTS_PER_CONVERSATION) {
      return;
    }
    alerted.add(frame.error);
    const alert: ErrorAlert = {
      text: `Voice bot error in conversation ${conversationId}: ${frame.error}`,
      conversationId,
      error: frame.error,
      processor: frame.processor ? String(frame.processor) : null,
      category: frame.category?.value ?? null,
      at: new Date().toISOString(),
    };
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(alert),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`Error alert not sent: ${e}`);
    }
  });
}
