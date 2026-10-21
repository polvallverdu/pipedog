// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_gemini_live_interaction_status.py

/**
 * Tests for model capability detection and interaction-status turn gating.
 *
 * Models that perform background reasoning report an `interactionStatus` on
 * `serverContent`: `turnComplete` only closes an output chunk, while the
 * status says whether the server is still working. These tests drive
 * `_handleServerMessage` with fabricated server messages and assert on the
 * frames the service pushes downstream.
 */

import { expect, test } from "bun:test";
import { sleep, type Task } from "@pipedog/asyncio";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  type Frame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LLMAssistantAggregator } from "@pipedog/core/processors/aggregators/llm_response_universal";
import { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { runTest } from "@pipedog/core/tests/utils";
import { TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { LOG_LEVELS, logger } from "@pipedog/core/utils/logger";
import { GeminiLiveLLMService } from "../src/gemini_live/llm.ts";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/**
 * Stands in for `LiveServerContent`.
 *
 * Only the attributes the receive loop reads are defined. `interactionStatus`
 * is omitted entirely when not supplied, mirroring SDK versions predating the
 * field.
 */
class _FakeServerContent {
  modelTurn: unknown = null;
  inputTranscription: unknown = null;
  outputTranscription: { text: string } | null = null;
  groundingMetadata: unknown = null;
  turnComplete: boolean;
  interrupted: boolean;
  interactionStatus?: unknown;

  constructor(
    options: {
      turnComplete?: boolean;
      interrupted?: boolean;
      interactionStatus?: unknown;
      hasStatusAttr?: boolean;
    } = {},
  ) {
    this.turnComplete = options.turnComplete ?? false;
    this.interrupted = options.interrupted ?? false;
    if (options.hasStatusAttr ?? true) {
      this.interactionStatus = options.interactionStatus ?? null;
    }
  }
}

/** Stands in for `LiveServerMessage`. */
class _FakeServerMessage {
  serverContent: unknown;
  toolCall: unknown = null;
  usageMetadata: unknown = null;
  sessionResumptionUpdate: unknown = null;

  constructor(serverContent: unknown = null) {
    this.serverContent = serverContent;
  }
}

// Test access to protected members, as upstream does with `service._x`.
type Service = GeminiLiveLLMService & {
  pushedFrames: Frame[];
  _supportsNonBlockingTools: boolean;
  _isGemini3: boolean;
  _botIsResponding: boolean;
  _settings: { thinking: unknown };
  _deferredTurnCompleteTimeoutTask: Task<unknown> | null;
  _resolvedThinkingConfig(): { thinkingLevel?: string; includeThoughts?: boolean } | null;
  _setBotIsResponding(responding: boolean): Promise<void>;
  _handleServerMessage(message: unknown): Promise<void>;
  _handleMsgTurnComplete(message: unknown): Promise<void>;
  _handleInterruption(): Promise<void>;
  _warnIfInteractionStatusUnsupported(): void;
  _functionIsAsync(name: string): boolean;
  _tagToolBehaviors(tools: unknown[]): void;
};

type ServiceStatics = {
  _DEFERRED_TURN_COMPLETE_TIMEOUT_SECS: number;
  _SDK_SUPPORTS_INTERACTION_STATUS: boolean;
  _INTERACTION_STATUS_MIN_SDK: string;
};
const Statics = GeminiLiveLLMService as unknown as ServiceStatics;

/** Construct a service with a captured frame sink. The constructor does no I/O. */
function _makeService(options: { model?: string } = {}): Service {
  const model = options.model ?? "models/gemini-3.8-live-extended-thinking";
  const service = new GeminiLiveLLMService({
    apiKey: "test-key",
    settings: new GeminiLiveLLMService.Settings({ model }),
  }) as unknown as Service;

  const pushed: Frame[] = [];

  service.pushFrame = async (frame: Frame) => {
    pushed.push(frame);
  };
  service.pushedFrames = pushed;
  return service;
}

/** Give the service a task manager so it can start the deferral watchdog. */
async function _setupService(service: Service): Promise<void> {
  // `setup()` also connects; upstream lets that attempt fail in the background
  // with the fake key. Skip it so the test makes no real network call.
  (service as unknown as { _connect: () => Promise<void> })._connect = async () => {};
  await service.setup(
    new FrameProcessorSetup({
      clock: new SystemClock(),
      taskManager: new TaskManager(),
      pipelineWorker: { appResources: null } as any,
    }),
  );
}

function _frameTypes(service: Service): unknown[] {
  return service.pushedFrames.map((f) => f.constructor);
}

/** Put the service into the mid-response state a model turn would leave it in. */
async function _startBotTurn(service: Service): Promise<void> {
  await _setupService(service);
  await service._setBotIsResponding(true);
  await service.pushFrame(new TTSStartedFrame());
  await service.pushFrame(new LLMFullResponseStartFrame());
  service.pushedFrames.length = 0;
}

/** Temporarily override the held-turn watchdog timeout (upstream sets it per instance). */
async function _withDeferredTimeout(secs: number, fn: () => Promise<void>): Promise<void> {
  const original = Statics._DEFERRED_TURN_COMPLETE_TIMEOUT_SECS;
  Statics._DEFERRED_TURN_COMPLETE_TIMEOUT_SECS = secs;
  try {
    await fn();
  } finally {
    Statics._DEFERRED_TURN_COMPLETE_TIMEOUT_SECS = original;
  }
}

/** Collect the messages logged at WARNING or above while `fn` runs. */
function _captureWarnings(fn: () => void): string {
  const lines: string[] = [];
  const remove = logger.addSink((record) => {
    if (LOG_LEVELS[record.level] >= LOG_LEVELS.WARNING) lines.push(`${record.message}\n`);
  });
  try {
    fn();
  } finally {
    remove();
  }
  return lines.join("");
}

// ---------------------------------------------------------------------------
// Model capability detection
// ---------------------------------------------------------------------------

for (const [model, expected] of [
  ["models/gemini-2.5-flash-native-audio-preview-12-2025", true],
  ["models/gemini-3-pro-preview", false],
  ["models/gemini-3.8-live", true],
  ["models/gemini-3.8-live-extended-thinking", true],
  ["models/gemini-4-live", true],
  ["models/gemini-2.0-flash-live-001", true],
] as const) {
  /** Gemini 3.x models before 3.8 lack NON_BLOCKING; everything else has it. */
  test(`test_non_blocking_tool_support_by_model[${model}-${expected ? "True" : "False"}]`, () => {
    const service = _makeService({ model });
    expect(service._supportsNonBlockingTools).toBe(expected);
  });
}

for (const model of [
  "models/gemini-3-pro-preview",
  "models/gemini-3.8-live",
  "models/gemini-3.8-live-extended-thinking",
]) {
  /** Every Gemini 3.x model, including the 3.8 Live family, uses the 3.x protocol. */
  test(`test_gemini_3_protocol_detection[${model}]`, () => {
    const service = _makeService({ model });
    expect(service._isGemini3).toBe(true);
  });
}

for (const [model, expectedLevel] of [
  // Live thinking models require a thinking_level; an unset one defaults.
  ["models/gemini-3.8-live-extended-thinking", "LOW"],
  ["models/gemini-3.8-live", null],
  ["models/gemini-2.0-flash-live-001", null],
  ["models/gemini-2.5-flash-exp-native-audio-thinking-dialog", null],
] as const) {
  /** Models that require a thinking_level get one; other models get no config. */
  test(`test_thinking_level_defaults_only_on_live_thinking_models[${model}-${expectedLevel ?? "None"}]`, () => {
    const service = _makeService({ model });

    const thinking = service._resolvedThinkingConfig();

    if (expectedLevel === null) {
      expect(thinking).toBeNull();
    } else {
      expect(thinking).not.toBeNull();
      expect(thinking?.thinkingLevel).toBe(expectedLevel);
    }
  });
}

/** A configured thinking_level is never overridden by the default. */
test("test_explicit_thinking_level_is_kept", () => {
  const service = new GeminiLiveLLMService({
    apiKey: "test-key",
    settings: new GeminiLiveLLMService.Settings({
      model: "models/gemini-3.8-live-extended-thinking",
      thinking: { thinkingLevel: "HIGH" as any },
    }),
  }) as unknown as Service;

  const thinking = service._resolvedThinkingConfig();

  expect(thinking).not.toBeNull();
  expect(thinking?.thinkingLevel).toBe("HIGH");
});

/** Defaulting the level keeps the rest of the config and leaves settings untouched. */
test("test_thinking_level_default_merges_with_other_thinking_settings", () => {
  const service = new GeminiLiveLLMService({
    apiKey: "test-key",
    settings: new GeminiLiveLLMService.Settings({
      model: "models/gemini-3.8-live-extended-thinking",
      thinking: { includeThoughts: true },
    }),
  }) as unknown as Service;

  const thinking = service._resolvedThinkingConfig();

  expect(thinking).not.toBeNull();
  expect(thinking?.includeThoughts).toBe(true);
  expect(thinking?.thinkingLevel).toBe("LOW");
  expect(service._settings.thinking).toEqual({ includeThoughts: true });
});

// ---------------------------------------------------------------------------
// interaction_status gating
// ---------------------------------------------------------------------------

/** IN_PROGRESS means background work continues, so the bot turn stays open. */
test("test_turn_complete_while_in_progress_holds_end_of_turn", async () => {
  const service = _makeService();
  await _startBotTurn(service);

  await service._handleServerMessage(
    new _FakeServerMessage(
      new _FakeServerContent({ turnComplete: true, interactionStatus: "IN_PROGRESS" }),
    ),
  );

  // end-of-turn frames must wait for an idle status
  expect(_frameTypes(service)).toEqual([]);
  expect(service._botIsResponding).toBe(true);
});

for (const idleStatus of ["IDLE", "REQUIRES_ACTION"]) {
  /** Either spelling of the idle status releases the held end-of-turn frames. */
  test(`test_idle_status_closes_a_held_turn[${idleStatus}]`, async () => {
    const service = _makeService();
    await _startBotTurn(service);

    await service._handleServerMessage(
      new _FakeServerMessage(
        new _FakeServerContent({ turnComplete: true, interactionStatus: "IN_PROGRESS" }),
      ),
    );
    expect(_frameTypes(service)).toEqual([]);

    await service._handleServerMessage(
      new _FakeServerMessage(new _FakeServerContent({ interactionStatus: idleStatus })),
    );

    expect(_frameTypes(service)).toEqual([TTSStoppedFrame, LLMFullResponseEndFrame]);
    expect(service._botIsResponding).toBe(false);
  });
}

/** A turn_complete that already reports idle needs no deferral. */
test("test_turn_complete_bundled_with_idle_closes_immediately", async () => {
  const service = _makeService();
  await _startBotTurn(service);

  await service._handleServerMessage(
    new _FakeServerMessage(
      new _FakeServerContent({ turnComplete: true, interactionStatus: "IDLE" }),
    ),
  );

  expect(_frameTypes(service)).toEqual([TTSStoppedFrame, LLMFullResponseEndFrame]);
  expect(service._botIsResponding).toBe(false);
});

/** Models that never report a status keep the plain turn_complete behavior. */
test("test_turn_complete_without_interaction_status_closes_turn", async () => {
  const service = _makeService({ model: "models/gemini-2.5-flash-native-audio-preview-12-2025" });
  await _startBotTurn(service);

  await service._handleServerMessage(
    new _FakeServerMessage(new _FakeServerContent({ turnComplete: true, hasStatusAttr: false })),
  );

  expect(_frameTypes(service)).toEqual([TTSStoppedFrame, LLMFullResponseEndFrame]);
  expect(service._botIsResponding).toBe(false);
});

/** An UNSPECIFIED status carries no information and must not defer the turn. */
test("test_unspecified_status_does_not_hold_the_turn", async () => {
  const service = _makeService();
  await _startBotTurn(service);

  await service._handleServerMessage(
    new _FakeServerMessage(
      new _FakeServerContent({
        turnComplete: true,
        interactionStatus: "INTERACTION_STATUS_UNSPECIFIED",
      }),
    ),
  );

  expect(_frameTypes(service)).toEqual([TTSStoppedFrame, LLMFullResponseEndFrame]);
});

/** An idle status outside a deferred turn is a no-op. */
test("test_idle_without_a_held_turn_pushes_nothing", async () => {
  const service = _makeService();

  await service._handleServerMessage(
    new _FakeServerMessage(new _FakeServerContent({ interactionStatus: "IDLE" })),
  );

  expect(_frameTypes(service)).toEqual([]);
});

/** After a barge-in the held turn is dropped, so a later idle emits nothing. */
test("test_interruption_discards_a_held_turn", async () => {
  const service = _makeService();
  await _startBotTurn(service);

  await service._handleServerMessage(
    new _FakeServerMessage(
      new _FakeServerContent({ turnComplete: true, interactionStatus: "IN_PROGRESS" }),
    ),
  );
  await service._handleInterruption();
  service.pushedFrames.length = 0;

  await service._handleServerMessage(
    new _FakeServerMessage(new _FakeServerContent({ interactionStatus: "IDLE" })),
  );

  // an interrupted turn must not be closed later
  expect(_frameTypes(service)).toEqual([]);
});

/** The watchdog closes the turn if the server never reports going idle. */
test("test_held_turn_is_released_when_idle_never_arrives", async () => {
  await _withDeferredTimeout(0.05, async () => {
    const service = _makeService();
    await _startBotTurn(service);

    await service._handleServerMessage(
      new _FakeServerMessage(
        new _FakeServerContent({ turnComplete: true, interactionStatus: "IN_PROGRESS" }),
      ),
    );
    expect(_frameTypes(service)).toEqual([]);

    await service._deferredTurnCompleteTimeoutTask;

    expect(_frameTypes(service)).toEqual([TTSStoppedFrame, LLMFullResponseEndFrame]);
    expect(service._botIsResponding).toBe(false);
  });
});

/**
 * Server messages restart the watchdog, so a reply still streaming past
 * the timeout window is not forced closed; the watchdog fires only once the
 * server actually goes silent.
 */
test("test_streaming_content_keeps_held_turn_open", async () => {
  await _withDeferredTimeout(0.1, async () => {
    const service = _makeService();
    await _startBotTurn(service);

    await service._handleServerMessage(
      new _FakeServerMessage(
        new _FakeServerContent({ turnComplete: true, interactionStatus: "IN_PROGRESS" }),
      ),
    );
    // Stream transcription chunks across several timeout windows.
    for (let i = 0; i < 5; i++) {
      await sleep(0.05);
      const content = new _FakeServerContent();
      content.outputTranscription = { text: "still talking " };
      await service._handleServerMessage(new _FakeServerMessage(content));
    }

    // a held turn must stay open while content is still streaming
    expect(_frameTypes(service)).not.toContain(LLMFullResponseEndFrame);

    await service._deferredTurnCompleteTimeoutTask;

    expect(_frameTypes(service).slice(-2)).toEqual([TTSStoppedFrame, LLMFullResponseEndFrame]);
    expect(service._botIsResponding).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unsupported-SDK warning
// ---------------------------------------------------------------------------

/**
 * Run the SDK-support check, returning whatever was logged at WARNING.
 *
 * Upstream monkeypatches `LiveServerContent.model_fields`; the TS port reads
 * SDK support from `_SDK_SUPPORTS_INTERACTION_STATUS`, so that is what we patch.
 */
function _warningsWhile(
  service: Service,
  options: { sdkHasField: boolean; calls?: number },
): string {
  const original = Statics._SDK_SUPPORTS_INTERACTION_STATUS;
  Statics._SDK_SUPPORTS_INTERACTION_STATUS = options.sdkHasField;
  try {
    return _captureWarnings(() => {
      for (let i = 0; i < (options.calls ?? 1); i++) {
        service._warnIfInteractionStatusUnsupported();
      }
    });
  } finally {
    Statics._SDK_SUPPORTS_INTERACTION_STATUS = original;
  }
}

/** A thinking model on an SDK without the field can't get the turn gating. */
test("test_warns_when_sdk_predates_interaction_status", () => {
  const service = _makeService({ model: "models/gemini-3.8-live-extended-thinking" });

  const output = _warningsWhile(service, { sdkHasField: false });

  expect(output).toContain("google-genai");
  // the warning must name the version that fixes it
  expect(output).toContain(Statics._INTERACTION_STATUS_MIN_SDK);
});

/** With a current SDK there is nothing to warn about. */
test("test_no_warning_when_sdk_supports_interaction_status", () => {
  const service = _makeService({ model: "models/gemini-3.8-live-extended-thinking" });

  const output = _warningsWhile(service, { sdkHasField: true });

  expect(output).toBe("");
});

for (const model of [
  "models/gemini-3.8-live",
  "models/gemini-2.5-flash-native-audio-preview-12-2025",
  "models/gemini-2.5-flash-exp-native-audio-thinking-dialog",
]) {
  /** Models that never report a status lose nothing on an older SDK. */
  test(`test_no_warning_for_models_that_report_no_status[${model}]`, () => {
    const service = _makeService({ model });

    const output = _warningsWhile(service, { sdkHasField: false });

    expect(output).toBe("");
  });
}

/** Reconnects must not repeat the warning. */
test("test_sdk_warning_is_logged_once", () => {
  const service = _makeService({ model: "models/gemini-3.8-live-extended-thinking" });

  const output = _warningsWhile(service, { sdkHasField: false, calls: 3 });

  expect(output.split("Upgrade to google-genai").length - 1).toBe(1);
});

/** A held turn is superseded, not closed twice, by a turn_complete that reports idle. */
test("test_turn_complete_bundled_with_idle_supersedes_a_held_turn", async () => {
  const service = _makeService();
  await _startBotTurn(service);

  const closes: unknown[] = [];
  const original = service._handleMsgTurnComplete.bind(service);

  service._handleMsgTurnComplete = async (message: unknown) => {
    closes.push(message);
    await original(message);
  };

  await service._handleServerMessage(
    new _FakeServerMessage(
      new _FakeServerContent({ turnComplete: true, interactionStatus: "IN_PROGRESS" }),
    ),
  );
  await service._handleServerMessage(
    new _FakeServerMessage(
      new _FakeServerContent({ turnComplete: true, interactionStatus: "REQUIRES_ACTION" }),
    ),
  );

  // the turn must be closed exactly once
  expect(closes.length).toBe(1);
  expect(_frameTypes(service)).toEqual([TTSStoppedFrame, LLMFullResponseEndFrame]);
});

// ---------------------------------------------------------------------------
// Tool behavior declarations
// ---------------------------------------------------------------------------

/** Tag one sync and one async declaration, returning the declarations. */
function _taggedDeclarations(service: Service): Record<string, unknown>[] {
  service._functionIsAsync = (name: string) => name === "async_tool";
  const tools = [{ function_declarations: [{ name: "sync_tool" }, { name: "async_tool" }] }];
  service._tagToolBehaviors(tools);
  return (tools[0] as { function_declarations: Record<string, unknown>[] }).function_declarations;
}

for (const [model, syncBehavior] of [
  // BLOCKING is already the default outside the 3.8 Live family.
  ["models/gemini-2.0-flash-live-001", null],
  // The 3.8 Live family defaults to NON_BLOCKING, so blocking is declared.
  ["models/gemini-3.8-live", "BLOCKING"],
  // Live thinking models accept only NON_BLOCKING.
  ["models/gemini-3.8-live-extended-thinking", null],
] as const) {
  /** Synchronous tools keep blocking semantics wherever the model can honor them. */
  test(`test_sync_tools_block_where_the_model_allows_it[${model}-${syncBehavior ?? "None"}]`, () => {
    const service = _makeService({ model });

    const declarations = _taggedDeclarations(service);

    expect(declarations[0]?.behavior ?? null).toBe(syncBehavior);
    expect(declarations[1]?.behavior ?? null).toBe("NON_BLOCKING");
  });
}

/** Synchronous tools can't block on live thinking models; say so once. */
test("test_sync_tool_on_a_strictly_non_blocking_model_warns_once", () => {
  const service = _makeService({ model: "models/gemini-3.8-live-extended-thinking" });

  const output = _captureWarnings(() => {
    _taggedDeclarations(service);
    _taggedDeclarations(service);
  });

  expect(output.split("won't pause").length - 1).toBe(1);
});

/** On gemini-3.8-live the BLOCKING declaration restores sync semantics silently. */
test("test_no_warning_when_sync_tools_can_block", () => {
  const service = _makeService({ model: "models/gemini-3.8-live" });

  const output = _captureWarnings(() => {
    _taggedDeclarations(service);
  });

  expect(output).toBe("");
});

// ---------------------------------------------------------------------------
// Context recording across an interruption
// ---------------------------------------------------------------------------

/**
 * Text streamed before a barge-in reaches the context even though the
 * turn-closing frames are still held waiting for an idle status.
 */
test("test_partial_assistant_message_survives_interruption", async () => {
  // Capture the frames the service pushes while streaming a reply that is
  // cut short: transcription chunks arrive, turn_complete is held because
  // the status is IN_PROGRESS, then the user barges in.
  const service = _makeService();
  await _setupService(service);

  for (const chunk of ["The answer ", "is 42."]) {
    const content = new _FakeServerContent();
    content.outputTranscription = { text: chunk };
    await service._handleServerMessage(new _FakeServerMessage(content));
  }
  await service._handleServerMessage(
    new _FakeServerMessage(
      new _FakeServerContent({ turnComplete: true, interactionStatus: "IN_PROGRESS" }),
    ),
  );
  await service._handleInterruption();
  const streamed = [...service.pushedFrames];

  // Replay that exact sequence into an assistant aggregator, along with the
  // InterruptionFrame the pipeline broadcasts at the barge-in.
  const context = new LLMContext();
  const aggregator = new LLMAssistantAggregator(context);
  await runTest(aggregator, { framesToSend: [...streamed, new InterruptionFrame()] });

  const assistantMessages = context
    .getMessages()
    .filter(
      (m): m is Record<string, unknown> =>
        typeof m === "object" && m !== null && (m as { role?: unknown }).role === "assistant",
    );
  // the partial reply must be recorded on interruption
  expect(assistantMessages.length).toBeGreaterThan(0);
  expect(assistantMessages[assistantMessages.length - 1]?.content).toBe("The answer is 42.");
});
