// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_user_turn_completion_mixin.py

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import {
  type Frame,
  FunctionCallsStartedFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMMarkerFrame,
  LLMMarkerResponseFrame,
  LLMTextFrame,
  UserTurnCompletionFrame,
  UserTurnInferenceCompletedFrame,
} from "../src/frames/frames.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import { FrameDirection, FrameProcessor } from "../src/processors/frame_processor.ts";
import { LLMService, type LLMServiceOptions } from "../src/services/llm_service.ts";
import { LLMSettings } from "../src/services/settings.ts";
import {
  TurnMarker,
  USER_TURN_COMPLETE_MARKER,
  USER_TURN_COMPLETION_INSTRUCTIONS,
  USER_TURN_INCOMPLETE_LONG_MARKER,
  USER_TURN_INCOMPLETE_SHORT_MARKER,
  UserTurnCompletionConfig,
  UserTurnCompletionLLMServiceMixin,
} from "../src/turns/user_turn_completion_mixin.ts";

/** Simple mock processor using the turn completion mixin, as LLMService does. */
class MockProcessor extends UserTurnCompletionLLMServiceMixin(FrameProcessor) {
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    await this._trackPushedFrame(frame);
    await super.pushFrame(frame, direction);
  }
}

// Python tests replace methods on the instance (AsyncMock) and read
// protected attributes; give the tests the same freedom.
type Loose = any;

/** Replace `processor.pushFrame` on the instance, capturing frames (bypasses the mixin). */
function captureInstancePush(processor: MockProcessor, pushed?: Frame[]) {
  const fn = mock(async (f: Frame, ..._args: unknown[]) => {
    pushed?.push(f);
  });
  (processor as Loose).pushFrame = fn;
  return fn;
}

/** `unittest.mock.patch.object(FrameProcessor, "push_frame", AsyncMock(...))`. */
function patchFrameProcessorPush(pushed?: Frame[]) {
  return spyOn(FrameProcessor.prototype, "pushFrame").mockImplementation(
    async (f: Frame, ..._args: unknown[]) => {
      pushed?.push(f);
    },
  );
}

/** `unittest.mock.patch.object(FrameProcessor, "process_frame", AsyncMock())`. */
function patchFrameProcessorProcess() {
  return spyOn(FrameProcessor.prototype, "processFrame").mockImplementation(async () => {});
}

/** Run `fn` with a class-level patch active, restoring it afterwards. */
async function withPatch(patch: { mockRestore(): void }, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } finally {
    patch.mockRestore();
  }
}

afterEach(() => {
  mock.restore();
});

describe("TestUserUserTurnCompletionLLMServiceMixin", () => {
  test("test_complete_marker_pushes_text", async () => {
    const processor = new MockProcessor();

    // Capture frames that get pushed
    const pushedFrames: Frame[] = [];
    captureInstancePush(processor, pushedFrames);

    // Simulate LLM generating: "● Hello there!"
    await processor._pushTurnText(`${USER_TURN_COMPLETE_MARKER} Hello there!`);

    // The marker rides as LLMMarkerFrame(appendToContextImmediately=false);
    // only the spoken text is pushed as an LLMTextFrame.
    const textFrames = pushedFrames.filter((f) => f instanceof LLMTextFrame) as LLMTextFrame[];
    expect(textFrames.length).toEqual(1);
    expect(textFrames[0]!.text).toEqual("Hello there!");
    expect(textFrames[0]!.skipTts).toBeFalsy();

    const markerFrames = pushedFrames.filter(
      (f) => f instanceof LLMMarkerFrame,
    ) as LLMMarkerFrame[];
    expect(markerFrames.length).toEqual(1);
    expect(markerFrames[0]!.marker).toEqual(USER_TURN_COMPLETE_MARKER);
    expect(markerFrames[0]!.appendToContextImmediately).toBe(false);

    // UserTurnInferenceCompletedFrame broadcast in both directions.
    const completed = pushedFrames.filter((f) => f instanceof UserTurnInferenceCompletedFrame);
    expect(completed.length).toEqual(2);
  });

  test("test_incomplete_short_marker_suppresses_text", async () => {
    const processor = new MockProcessor();

    const pushedFrames: Frame[] = [];
    captureInstancePush(processor, pushedFrames);

    await processor._pushTurnText(USER_TURN_INCOMPLETE_SHORT_MARKER);

    // No LLMTextFrame: response is suppressed.
    const textFrames = pushedFrames.filter((f) => f instanceof LLMTextFrame);
    expect(textFrames.length).toEqual(0);

    const markerFrames = pushedFrames.filter(
      (f) => f instanceof LLMMarkerFrame,
    ) as LLMMarkerFrame[];
    expect(markerFrames.length).toEqual(1);
    expect(markerFrames[0]!.marker).toEqual(USER_TURN_INCOMPLETE_SHORT_MARKER);
    expect(markerFrames[0]!.appendToContextImmediately).toBe(true);

    // Incomplete markers do not emit UserTurnInferenceCompletedFrame.
    const completed = pushedFrames.filter((f) => f instanceof UserTurnInferenceCompletedFrame);
    expect(completed.length).toEqual(0);
  });

  test("test_incomplete_long_marker_suppresses_text", async () => {
    const processor = new MockProcessor();

    const pushedFrames: Frame[] = [];
    captureInstancePush(processor, pushedFrames);

    await processor._pushTurnText(USER_TURN_INCOMPLETE_LONG_MARKER);

    const textFrames = pushedFrames.filter((f) => f instanceof LLMTextFrame);
    expect(textFrames.length).toEqual(0);

    const markerFrames = pushedFrames.filter(
      (f) => f instanceof LLMMarkerFrame,
    ) as LLMMarkerFrame[];
    expect(markerFrames.length).toEqual(1);
    expect(markerFrames[0]!.marker).toEqual(USER_TURN_INCOMPLETE_LONG_MARKER);
    expect(markerFrames[0]!.appendToContextImmediately).toBe(true);

    const completed = pushedFrames.filter((f) => f instanceof UserTurnInferenceCompletedFrame);
    expect(completed.length).toEqual(0);
  });

  test("test_text_buffered_until_marker_found", async () => {
    const processor = new MockProcessor();

    const pushedFrames: Frame[] = [];
    captureInstancePush(processor, pushedFrames);

    // Simulate token-by-token streaming without marker
    await processor._pushTurnText("Hello");
    await processor._pushTurnText(" there");

    // No frames should be pushed yet (buffering)
    expect(pushedFrames.length).toEqual(0);

    // Now send the complete marker
    await processor._pushTurnText(` ${USER_TURN_COMPLETE_MARKER} How are you?`);

    // One LLMTextFrame for the spoken portion; one LLMMarkerFrame for the
    // marker; UserTurnInferenceCompletedFrame broadcast in both directions.
    const textFrames = pushedFrames.filter((f) => f instanceof LLMTextFrame);
    expect(textFrames.length).toEqual(1);
    const markerFrames = pushedFrames.filter((f) => f instanceof LLMMarkerFrame);
    expect(markerFrames.length).toEqual(1);
  });

  test("test_turn_state_reset_after_llm_full_response_end_frame", async () => {
    const processor = new MockProcessor();

    // Mock pushFrame on the instance so _pushTurnText can call it without a
    // live pipeline, but keep _turnReset as the real implementation.
    captureInstancePush(processor);

    // Simulate first LLM response: complete marker sets the marker to COMPLETE
    await processor._pushTurnText(`${USER_TURN_COMPLETE_MARKER} Hello!`);
    expect(processor._turnMarker).toEqual(TurnMarker.COMPLETE);

    // Restore the real pushFrame so the mixin override runs, then call it
    // with LLMFullResponseEndFrame as the LLM service would.
    delete (processor as Loose).pushFrame; // removes instance mock, restores class method

    // Patch only the FrameProcessor-level send so no live pipeline is needed.
    await withPatch(patchFrameProcessorPush(), async () => {
      const endFrame = new LLMFullResponseEndFrame();
      await processor.pushFrame(endFrame);
    });

    // The marker must now be cleared — ready for the next response
    expect(processor._turnMarker).toBeNull();
    expect(processor._turnTextBuffer).toEqual("");
  });

  test("test_response_end_reports_the_raw_text_and_marker", async () => {
    const processor = new MockProcessor();
    const pushedFrames: Frame[] = [];
    await withPatch(patchFrameProcessorPush(pushedFrames), async () => {
      await processor.pushFrame(new LLMFullResponseStartFrame());
      await processor._pushTurnText("Well, ");
      await processor._pushTurnText(`${USER_TURN_INCOMPLETE_SHORT_MARKER} go on`);
      await processor._pushTurnText(" please");
      await processor.pushFrame(new LLMFullResponseEndFrame());
    });

    const reports = pushedFrames.filter(
      (f) => f instanceof LLMMarkerResponseFrame,
    ) as LLMMarkerResponseFrame[];
    expect(reports.length).toEqual(1);
    const report = reports[0]!;
    // Everything the LLM produced, including what the mixin held back.
    expect(report.raw).toEqual(`Well, ${USER_TURN_INCOMPLETE_SHORT_MARKER} go on please`);
    expect([report.marker, report.kind]).toEqual([USER_TURN_INCOMPLETE_SHORT_MARKER, "short"]);
    expect(report.markers).toEqual([
      USER_TURN_COMPLETE_MARKER,
      USER_TURN_INCOMPLETE_SHORT_MARKER,
      USER_TURN_INCOMPLETE_LONG_MARKER,
    ]);
    // The report precedes the end-of-response frame.
    expect(pushedFrames.indexOf(report)).toBeLessThan(
      pushedFrames.findIndex((f) => f instanceof LLMFullResponseEndFrame),
    );
  });

  test("test_a_response_without_a_marker_is_reported_as_such", async () => {
    const processor = new MockProcessor();
    const pushedFrames: Frame[] = [];
    await withPatch(patchFrameProcessorPush(pushedFrames), async () => {
      await processor.pushFrame(new LLMFullResponseStartFrame());
      await processor._pushTurnText("Hello there");
      await processor.pushFrame(new LLMFullResponseEndFrame());
    });
    const reports = pushedFrames.filter(
      (f) => f instanceof LLMMarkerResponseFrame,
    ) as LLMMarkerResponseFrame[];
    expect(reports.length).toEqual(1);
    const report = reports[0]!;
    expect([report.raw, report.marker, report.kind]).toEqual(["Hello there", null, null]);
  });

  test("test_a_response_the_mixin_never_saw_is_not_reported", async () => {
    const processor = new MockProcessor();
    const pushedFrames: Frame[] = [];
    await withPatch(patchFrameProcessorPush(pushedFrames), async () => {
      await processor.pushFrame(new LLMFullResponseStartFrame());
      await processor.pushFrame(new LLMFullResponseEndFrame());
    });
    expect(pushedFrames.filter((f) => f instanceof LLMMarkerResponseFrame)).toEqual([]);
  });
});

interface MockLLMServiceOptions extends LLMServiceOptions {
  systemInstruction?: string | null;
}

/** Minimal LLM service for testing systemInstruction composition. */
class MockLLMService extends LLMService {
  constructor(options: MockLLMServiceOptions = {}) {
    const { systemInstruction, ...rest } = options;
    const settings = new LLMSettings({
      model: "test-model",
      systemInstruction: systemInstruction ?? null,
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
    super({ ...rest, settings });
  }

  // Test access to protected members (Python reads them directly).
  get settings(): LLMSettings {
    return this._settings as LLMSettings;
  }

  get baseSystemInstruction(): string | null {
    return this._baseSystemInstruction;
  }

  async updateSettings(delta: LLMSettings): Promise<Record<string, unknown>> {
    return this._updateSettings(delta);
  }
}

describe("TestSystemInstructionComposition", () => {
  test("test_enable_turn_completion_sets_system_instruction", async () => {
    // Enabling turn completion should set systemInstruction to completion instructions.
    const service = new MockLLMService();
    expect(service.settings.systemInstruction).toBeNull();

    const delta = new LLMSettings({ filterIncompleteUserTurns: true });
    await service.updateSettings(delta);

    expect(service.settings.systemInstruction).toEqual(USER_TURN_COMPLETION_INSTRUCTIONS);
    expect(service.baseSystemInstruction).toBeNull();
  });

  test("test_enable_turn_completion_appends_to_existing_system_instruction", async () => {
    const service = new MockLLMService({ systemInstruction: "You are a helpful assistant." });

    const delta = new LLMSettings({ filterIncompleteUserTurns: true });
    await service.updateSettings(delta);

    const expected = `You are a helpful assistant.\n\n${USER_TURN_COMPLETION_INSTRUCTIONS}`;
    expect(service.settings.systemInstruction).toEqual(expected);
    expect(service.baseSystemInstruction).toEqual("You are a helpful assistant.");
  });

  test("test_disable_turn_completion_restores_system_instruction", async () => {
    const service = new MockLLMService({ systemInstruction: "You are a helpful assistant." });

    // Enable
    await service.updateSettings(new LLMSettings({ filterIncompleteUserTurns: true }));
    expect(service.settings.systemInstruction as string).toContain(
      USER_TURN_COMPLETION_INSTRUCTIONS,
    );

    // Disable
    await service.updateSettings(new LLMSettings({ filterIncompleteUserTurns: false }));
    expect(service.settings.systemInstruction).toEqual("You are a helpful assistant.");
    // The base prompt is retained — it's the single source of truth that
    // composition rebuilds from; disabling just recomposes without the
    // turn-completion addon.
    expect(service.baseSystemInstruction).toEqual("You are a helpful assistant.");
  });

  test("test_disable_turn_completion_restores_none", async () => {
    const service = new MockLLMService();

    await service.updateSettings(new LLMSettings({ filterIncompleteUserTurns: true }));
    expect(service.settings.systemInstruction).toEqual(USER_TURN_COMPLETION_INSTRUCTIONS);

    await service.updateSettings(new LLMSettings({ filterIncompleteUserTurns: false }));
    expect(service.settings.systemInstruction).toBeNull();
  });

  test("test_update_system_instruction_while_turn_completion_active", async () => {
    const service = new MockLLMService({ systemInstruction: "Original prompt." });

    await service.updateSettings(new LLMSettings({ filterIncompleteUserTurns: true }));
    let expected = `Original prompt.\n\n${USER_TURN_COMPLETION_INSTRUCTIONS}`;
    expect(service.settings.systemInstruction).toEqual(expected);

    // Now update systemInstruction
    await service.updateSettings(new LLMSettings({ systemInstruction: "New prompt." }));
    expected = `New prompt.\n\n${USER_TURN_COMPLETION_INSTRUCTIONS}`;
    expect(service.settings.systemInstruction).toEqual(expected);
    expect(service.baseSystemInstruction).toEqual("New prompt.");
  });

  test("test_update_config_recomposes_with_custom_instructions", async () => {
    const service = new MockLLMService({ systemInstruction: "Base prompt." });

    await service.updateSettings(new LLMSettings({ filterIncompleteUserTurns: true }));

    const customConfig = new UserTurnCompletionConfig({
      instructions: "Custom turn instructions.",
    });
    await service.updateSettings(new LLMSettings({ userTurnCompletionConfig: customConfig }));

    const expected = "Base prompt.\n\nCustom turn instructions.";
    expect(service.settings.systemInstruction).toEqual(expected);
  });

  test("test_simultaneous_enable_and_system_instruction_change", async () => {
    // Enabling turn completion and changing systemInstruction in the same
    // delta should use the new systemInstruction as the base.
    const service = new MockLLMService({ systemInstruction: "Original prompt." });

    await service.updateSettings(
      new LLMSettings({
        filterIncompleteUserTurns: true,
        systemInstruction: "New prompt.",
      }),
    );

    // applyUpdate sets systemInstruction to "New prompt." before
    // _updateSettings runs, so the base should be the new value the user
    // explicitly set.
    expect(service.baseSystemInstruction).toEqual("New prompt.");
    const expected = `New prompt.\n\n${USER_TURN_COMPLETION_INSTRUCTIONS}`;
    expect(service.settings.systemInstruction).toEqual(expected);
  });
});

describe("TestConfigurableMarkers", () => {
  test("test_default_markers_are_the_fill_gradient", () => {
    // Full is a finished turn, half is cut off mid-thought, empty is not started.
    expect(USER_TURN_COMPLETE_MARKER).toEqual("●");
    expect(USER_TURN_INCOMPLETE_SHORT_MARKER).toEqual("◐");
    expect(USER_TURN_INCOMPLETE_LONG_MARKER).toEqual("○");
  });

  test("test_prompts_follow_configured_markers", () => {
    // Custom markers reach the instructions and both re-prompts.
    const config = new UserTurnCompletionConfig({
      completeMarker: "Y",
      incompleteShortMarker: "N",
      incompleteLongMarker: "W",
    });

    for (const prompt of [config.completionInstructions, config.shortPrompt, config.longPrompt]) {
      for (const def of [
        USER_TURN_COMPLETE_MARKER,
        USER_TURN_INCOMPLETE_SHORT_MARKER,
        USER_TURN_INCOMPLETE_LONG_MARKER,
      ]) {
        expect(prompt).not.toContain(def);
      }
    }

    expect(config.completionInstructions).toContain("Write Y, a space, then your full reply");
    expect(config.completionInstructions).toContain("Respond with only N");
    expect(config.completionInstructions).toContain("Respond with only W");
    expect(config.shortPrompt).toContain("respond with Y");
    expect(config.longPrompt).toContain("respond with Y");
  });

  test("test_custom_instructions_still_win", () => {
    // An explicit instructions string overrides the rendered default.
    const config = new UserTurnCompletionConfig({ instructions: "do it my way" });
    expect(config.completionInstructions).toEqual("do it my way");
  });

  test("test_parser_detects_configured_markers", async () => {
    // The detector matches the configured markers, not the defaults.
    const processor = new MockProcessor();
    processor.setUserTurnCompletionConfig(
      new UserTurnCompletionConfig({
        completeMarker: "Y",
        incompleteShortMarker: "N",
        incompleteLongMarker: "W",
      }),
    );

    const pushedFrames: Frame[] = [];
    captureInstancePush(processor, pushedFrames);

    await processor._pushTurnText("Y Hello there!");

    const textFrames = pushedFrames.filter((f) => f instanceof LLMTextFrame) as LLMTextFrame[];
    expect(textFrames.map((f) => f.text)).toEqual(["Hello there!"]);

    const markerFrames = pushedFrames.filter(
      (f) => f instanceof LLMMarkerFrame,
    ) as LLMMarkerFrame[];
    expect(markerFrames.map((f) => f.marker)).toEqual(["Y"]);
  });
});

describe("TestUserTurnCompletionReports", () => {
  // The turn-completion judgment pushed upstream as UserTurnCompletionFrame.

  function processorFor(options: { filtering?: boolean } = {}): MockProcessor {
    const processor = new MockProcessor();
    processor._filterIncompleteUserTurns = options.filtering ?? true;
    return processor;
  }

  type Pushed = [Frame, FrameDirection];

  function recorder(pushed: Pushed[]) {
    return async (f: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM) => {
      pushed.push([f, direction]);
    };
  }

  function reports(pushed: Pushed[]): UserTurnCompletionFrame[] {
    return pushed
      .map(([f]) => f)
      .filter((f): f is UserTurnCompletionFrame => f instanceof UserTurnCompletionFrame);
  }

  test("test_each_marker_is_reported_upstream", async () => {
    for (const [marker, kind] of [
      [USER_TURN_COMPLETE_MARKER, "complete"],
      [USER_TURN_INCOMPLETE_SHORT_MARKER, "short"],
      [USER_TURN_INCOMPLETE_LONG_MARKER, "long"],
    ] as const) {
      const processor = processorFor();
      const pushed: Pushed[] = [];
      (processor as Loose).pushFrame = mock(recorder(pushed));

      await processor._pushTurnText(`${marker} Hello`);

      const found = pushed.filter(([f]) => f instanceof UserTurnCompletionFrame);
      expect(found.length).toEqual(1);
      const [report, direction] = found[0]! as [UserTurnCompletionFrame, FrameDirection];
      expect([report.kind, report.marker]).toEqual([kind, marker]);
      expect(direction).toEqual(FrameDirection.UPSTREAM);
    }
  });

  test("test_reports_carry_the_context_frame_id", async () => {
    const processor = processorFor();
    const contextFrame = new LLMContextFrame({ context: new LLMContext() });
    await withPatch(patchFrameProcessorProcess(), async () => {
      await processor.processFrame(contextFrame, FrameDirection.DOWNSTREAM);
    });
    const pushed: Pushed[] = [];
    (processor as Loose).pushFrame = mock(recorder(pushed));

    await processor._pushTurnText(`${USER_TURN_COMPLETE_MARKER} Hello`);

    const found = reports(pushed);
    expect(found.length).toEqual(1);
    expect(found[0]!.contextFrameId).toEqual(contextFrame.id);
  });

  test("test_a_tool_call_is_reported_as_complete", async () => {
    const processor = processorFor();
    const pushed: Pushed[] = [];
    await withPatch(
      spyOn(FrameProcessor.prototype, "pushFrame").mockImplementation(recorder(pushed)),
      async () => {
        await processor.pushFrame(new FunctionCallsStartedFrame({ functionCalls: [] }));
      },
    );

    const found = reports(pushed);
    expect(found.length).toEqual(1);
    expect([found[0]!.kind, found[0]!.marker]).toEqual(["complete", null]);
    const completed = pushed.filter(([f]) => f instanceof UserTurnInferenceCompletedFrame);
    expect(completed.length).toEqual(2);
  });

  test("test_a_response_without_a_marker_is_reported_with_no_kind", async () => {
    const processor = processorFor();
    const pushed: Pushed[] = [];
    await withPatch(
      spyOn(FrameProcessor.prototype, "pushFrame").mockImplementation(recorder(pushed)),
      async () => {
        await processor.pushFrame(new LLMFullResponseStartFrame());
        await processor._pushTurnText("Hello there");
        await processor.pushFrame(new LLMFullResponseEndFrame());
      },
    );

    const found = reports(pushed);
    expect(found.length).toEqual(1);
    expect([found[0]!.kind, found[0]!.marker]).toEqual([null, null]);
  });

  test("test_each_inference_is_reported_once", async () => {
    const processor = processorFor();
    const pushed: Pushed[] = [];
    const processPatch = patchFrameProcessorProcess();
    await withPatch(processPatch, async () => {
      await withPatch(
        spyOn(FrameProcessor.prototype, "pushFrame").mockImplementation(recorder(pushed)),
        async () => {
          await processor.processFrame(
            new LLMContextFrame({ context: new LLMContext() }),
            FrameDirection.DOWNSTREAM,
          );
          await processor.pushFrame(new LLMFullResponseStartFrame());
          await processor._pushTurnText(`${USER_TURN_COMPLETE_MARKER} Let me check`);
          await processor.pushFrame(new FunctionCallsStartedFrame({ functionCalls: [] }));
          await processor.pushFrame(new LLMFullResponseEndFrame());

          // The next inference is reported afresh.
          await processor.processFrame(
            new LLMContextFrame({ context: new LLMContext() }),
            FrameDirection.DOWNSTREAM,
          );
          await processor.pushFrame(new LLMFullResponseStartFrame());
          await processor._pushTurnText(USER_TURN_INCOMPLETE_SHORT_MARKER);
          await processor.pushFrame(new LLMFullResponseEndFrame());
        },
      );
    });

    expect(reports(pushed).map((r) => r.kind)).toEqual(["complete", "short"]);
  });

  test("test_nothing_is_reported_while_filtering_is_off", async () => {
    const processor = processorFor({ filtering: false });
    const pushed: Pushed[] = [];
    await withPatch(
      spyOn(FrameProcessor.prototype, "pushFrame").mockImplementation(recorder(pushed)),
      async () => {
        await processor.pushFrame(new LLMFullResponseStartFrame());
        await processor.pushFrame(new FunctionCallsStartedFrame({ functionCalls: [] }));
        await processor.pushFrame(new LLMFullResponseEndFrame());
      },
    );

    expect(reports(pushed)).toEqual([]);
  });
});
