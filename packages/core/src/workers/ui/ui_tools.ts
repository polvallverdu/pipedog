// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/workers/ui/ui_tools.py

/**
 * Tools for a voice LLM to work with a `UIWorker`.
 *
 * Ships `screenTools`, the tool a voice LLM uses to ask a `UIWorker` about
 * the screen, or act on it.
 *
 * Porting notes:
 * - `ReplyToolMixin` is deprecated upstream (since 1.12.0, use
 *   `screen_tools`) and is not ported.
 * - The tool's description and parameter types, which upstream reads from
 *   the docstring and type hints, are attached as direct-function metadata.
 */

import { type DirectFunction, toolOptions } from "../../adapters/schemas/direct_function.ts";
import { JobError, JobParams } from "../../pipeline/job_context.ts";
import type { FunctionCallParams } from "../../services/llm_service.ts";
import { logger } from "../../utils/logger.ts";

const SCREEN_DESCRIPTION = `Ask about what is on the user's screen right now, or act on it.

Actions, with what \`\`target\`\` means for each:

- "find": which element a description refers to, such as "the
  checkout button". Returns its label and how confident the match is,
  or no label when nothing fits.
- "check": whether something is true of the screen, such as "is
  anything on the list still unchecked?". Returns yes or no with a
  probability.
- "select": which elements match a description, such as "dairy
  products". Returns the matching labels, most likely first.
- "list": the named elements on screen, with their state and values,
  optionally only those of one role such as "checkbox" or "textbox".
  Use it to see what is on the page and which inputs are filled.
- "selection": the text the user has selected on the page, or no text
  when nothing is selected. Nothing else can tell; call it whenever
  the user says "this", "that" or "what I selected".
- "click", "scroll_to", "highlight", "select_text", "fill": do that to
  the element a description refers to. "fill" writes \`\`value\`\` into
  it. Returns whether it was done and the label of the element.`;

/**
 * The tools that let a voice LLM ask a `UIWorker` about the screen, or act on
 * it.
 *
 * One tool, `screen(action, target, value)`, sends the worker's `screen` job
 * and returns its answer as data, so the voice LLM learns what it asked and
 * nothing more of the page. Hand them to the voice LLM's context:
 *
 * @example
 * const context = new LLMContext({ tools: screenTools("ui") });
 *
 * @param worker The name of the `UIWorker` to ask.
 * @param options.timeout Seconds to wait for an answer. Defaults to 30.
 * @returns The tools, as functions for an `LLMContext`.
 */
export function screenTools(worker: string, options: { timeout?: number } = {}): DirectFunction[] {
  const timeout = options.timeout ?? 30.0;

  /**
   * @param params Framework-provided tool invocation context.
   * @param action One of "find", "check", "select", "list", "selection",
   *   "click", "scroll_to", "highlight", "select_text" or "fill".
   * @param target The description, criteria or role the action needs; none
   *   for "selection".
   * @param value The text to write, only for "fill".
   */
  async function screen(
    params: FunctionCallParams,
    action: string,
    target: string | null = null,
    value: string | null = null,
  ): Promise<void> {
    const payload: Record<string, unknown> = { action };
    if (target !== null && target !== undefined) {
      payload.target = target;
    }
    if (value !== null && value !== undefined) {
      payload.value = value;
    }
    const t = params.pipelineWorker.job(worker, {
      params: new JobParams({ name: "screen", payload, timeout }),
    });
    try {
      await t.run(async () => {});
    } catch (e) {
      if (e instanceof JobError) {
        logger.warning(`screen job on ${worker} failed: ${e.message}`);
        await params.resultCallback({ error: e.message });
        return;
      }
      throw e;
    }
    await params.resultCallback(t.response);
  }

  const tool = screen as DirectFunction;
  tool.description = SCREEN_DESCRIPTION;
  // Upstream reads each parameter's description from the docstring's
  // ``Args`` section; here they are attached to the JSON schemas directly.
  tool.parameters = {
    action: {
      type: "string",
      description:
        'One of "find", "check", "select", "list", "selection",\n' +
        '"click", "scroll_to", "highlight", "select_text" or "fill".',
    },
    target: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: 'The description, criteria or role the action needs; none\nfor "selection".',
    },
    value: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: 'The text to write, only for "fill".',
    },
  };
  return [toolOptions(tool, { cancelOnInterruption: false, timeoutSecs: timeout })];
}
