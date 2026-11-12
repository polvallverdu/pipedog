// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_llm_switcher.py

/** Unit tests for LLMSwitcher. */

import { describe, expect, test } from "bun:test";

import { toolOptions } from "../src/adapters/llm/schemas/direct_function.ts";
import { type Frame, LLMUpdateSettingsFrame } from "../src/frames/frames.ts";
import { LLMSwitcher } from "../src/pipeline/llm_switcher.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import type { FrameDirection } from "../src/processors/frame_processor.ts";
import {
  type FunctionCallParams,
  type FunctionCallRegistryItem,
  LLMService,
  type LLMServiceOptions,
} from "../src/services/llm_service.ts";
import { LLMSettings } from "../src/services/settings.ts";
import { runTest } from "../src/tests/utils.ts";
import { UserTurnCompletionConfig } from "../src/turns/user_turn_completion_mixin.ts";

/** Minimal LLM service for testing direct-function registration. */
class _MockLLMService extends LLMService {
  constructor(options: LLMServiceOptions = {}) {
    const settings = new LLMSettings({
      model: "test-model",
      systemInstruction: null,
      temperature: null,
      maxTokens: null,
      topP: null,
      topK: null,
      frequencyPenalty: null,
      presencePenalty: null,
      seed: null,
      filterIncompleteUserTurns: null,
      userTurnCompletionConfig: null,
    });
    super({ ...options, settings });
  }

  /** Process a frame, pushing everything onward like a concrete service does. */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);
  }

  // Test access to protected members (Python reads them directly).
  get functions(): Map<string | null, FunctionCallRegistryItem> {
    return this._functions;
  }

  get filterIncompleteUserTurns(): boolean {
    return this._filterIncompleteUserTurns;
  }

  get settings(): LLMSettings {
    return this._settings;
  }

  syncRegisteredToolHandlers(tools: unknown): void {
    this._syncRegisteredToolHandlers(tools as never);
  }
}

/** Exposes the switcher's protected `_syncRegisteredToolHandlers` for the test. */
class _TestLLMSwitcher extends LLMSwitcher {
  syncRegisteredToolHandlers(tools: unknown): void {
    this._syncRegisteredToolHandlers(tools);
  }
}

/** Get the current weather. */
async function get_current_weather(params: FunctionCallParams, location: string): Promise<void> {
  void location;
  await params.resultCallback({ conditions: "nice" });
}
Object.assign(get_current_weather, {
  description: "Get the current weather.",
  parameters: {
    location: { type: "string", description: 'The city and state, e.g. "San Francisco, CA".' },
  },
});

/** A classic handler carrying toolOptions() call options. */
const end_call_handler = toolOptions({ cancelOnInterruption: false, timeoutSecs: 60 })(
  async function end_call_handler(params: FunctionCallParams): Promise<void> {
    await params.resultCallback({ status: "ending" });
  },
);

describe("TestLLMSwitcherDirectFunctions", () => {
  test("test_sync_registered_tool_handlers_registers_handler", () => {
    // LLMService._sync_registered_tool_handlers registers the handler.
    const llm = new _MockLLMService();
    llm.syncRegisteredToolHandlers(new LLMContext({ tools: [get_current_weather] }).tools);
    expect(llm.functions.has("get_current_weather")).toBe(true);
  });

  test("test_context_direct_functions_registered_on_all_member_llms", () => {
    // A direct function advertised via the context registers on all members.
    //
    // Member LLMs sit behind per-branch filters, so at runtime only the active
    // LLM receives the LLMContextFrame. The switcher must still register the
    // direct-function handler on every member — active or not — so the tool
    // keeps working after a service switch.
    const llm1 = new _MockLLMService();
    const llm2 = new _MockLLMService();
    const switcher = new _TestLLMSwitcher([llm1, llm2]);

    switcher.syncRegisteredToolHandlers(new LLMContext({ tools: [get_current_weather] }).tools);

    for (const llm of [llm1, llm2]) {
      expect(llm.functions.has("get_current_weather")).toBe(true);
    }
  });

  // Deprecated upstream (LLMSwitcher.register_direct_function warns
  // DeprecationWarning) and not ported.
  test.skip("test_register_direct_function_is_deprecated_but_fans_out", () => {});
});

describe("TestLLMSwitcherSettings", () => {
  test("test_turn_completion_setting_applied_to_all_member_llms", async () => {
    // Enabling filter_incomplete_user_turns reaches inactive members too.
    //
    // LLMTurnCompletionUserTurnStopStrategy enables the setting with a single
    // frame on StartFrame. A member LLM that missed it would emit none of the
    // completion markers the strategy waits on, so user turns would stop being
    // finalized as soon as it became the active LLM.
    const llm1 = new _MockLLMService();
    const llm2 = new _MockLLMService();
    const switcher = new LLMSwitcher([llm1, llm2]);

    await runTest(switcher, {
      framesToSend: [
        new LLMUpdateSettingsFrame({
          delta: new LLMSettings({ filterIncompleteUserTurns: true }),
          reachInactiveServices: true,
        }),
      ],
    });

    for (const llm of [llm1, llm2]) {
      expect(llm.filterIncompleteUserTurns).toBe(true);
      expect(llm.settings.systemInstruction).toEqual(
        new UserTurnCompletionConfig().completionInstructions,
      );
    }
  });
});

// Explicit arg > toolOptions() decorator > default, propagated to every member.
//
// The switcher forwards values to each member, which does the resolution; these
// check it forwards to all members — passing null when no explicit arg is given,
// so a member reads the decorator rather than a default that would clobber it.
// Covers both register_function and register_direct_function.
describe("TestLLMSwitcherRegisterFunctionOptionPrecedence", () => {
  function _switcher(): [LLMSwitcher, _MockLLMService[]] {
    const members = [new _MockLLMService(), new _MockLLMService()];
    return [new LLMSwitcher([...members]), members];
  }

  test("test_register_function_decorator_values_used_when_no_explicit_args", () => {
    const [switcher, members] = _switcher();
    switcher.registerFunction("end_call", end_call_handler); // decorated: false / 60
    for (const llm of members) {
      const item = llm.functions.get("end_call") as FunctionCallRegistryItem;
      expect(item.cancelOnInterruption).toBe(false);
      expect(item.timeoutSecs).toEqual(60);
    }
  });

  test("test_register_function_explicit_arg_overrides_decorator", () => {
    const [switcher, members] = _switcher();
    switcher.registerFunction("end_call", end_call_handler, { cancelOnInterruption: true });
    for (const llm of members) {
      const item = llm.functions.get("end_call") as FunctionCallRegistryItem;
      expect(item.cancelOnInterruption).toBe(true); // explicit wins
      expect(item.timeoutSecs).toEqual(60); // decorator still applies
    }
  });

  // Deprecated upstream (LLMSwitcher.register_direct_function warns
  // DeprecationWarning) and not ported.
  test.skip("test_register_direct_function_decorator_values_used_when_no_explicit_args", () => {});

  // Deprecated upstream (LLMSwitcher.register_direct_function warns
  // DeprecationWarning) and not ported.
  test.skip("test_register_direct_function_explicit_arg_overrides_decorator", () => {});
});
