// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_ui_worker.py

/**
 * Tests for UIWorker dispatch, LLM-context injection, and single-flight respond.
 *
 * Porting notes:
 * - The `tts_speak` option of `respond_to_job` is deprecated upstream (since
 *   1.12.0) and not ported, so the two tests that exercise it are skipped.
 * - Python's `ValueError` from `act` is `UnknownScreenActionError`; the
 *   duplicate-handler `ValueError` is a plain `Error`.
 */

import { describe, expect, mock, test } from "bun:test";

import { createTask, Event, sleep, type Task, waitFor } from "@pipedog/asyncio";
import { DirectFunctionWrapper } from "@pipedog/core/adapters/llm/schemas/direct_function";
import {
  BusJobCancelMessage,
  BusJobRequestMessage,
  type BusJobRequestMessage as BusJobRequestMessageT,
  type BusMessage,
} from "@pipedog/core/bus/messages";
import {
  BusUICommandMessage,
  BusUIEventMessage,
  UI_SNAPSHOT_EVENT_NAME,
} from "@pipedog/core/bus/ui/messages";
import {
  BaseClassifier,
  ChoiceQuestion,
  ChoiceResult,
  ClassifierError,
  type ClassifierQuestion,
  type ClassifierResult,
  type ClassifierValue,
  YesNoResult,
} from "@pipedog/core/classifiers/base_classifier";
import { LLMClassifier } from "@pipedog/core/classifiers/llm/classifier";
import {
  type Frame,
  LLMContextFrame,
  LLMMessagesAppendFrame,
  LLMMessagesUpdateFrame,
} from "@pipedog/core/frames/frames";
import { JobError, JobParams, JobStatus } from "@pipedog/core/pipeline/job_context";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { AssistantTurnStoppedMessage } from "@pipedog/core/processors/aggregators/llm_response_universal";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import type { LLMService } from "@pipedog/core/services/llm_service";
import { TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import {
  UI_STATE_PROMPT_GUIDE,
  UISelection,
  UIWorker,
  uiEvent,
} from "@pipedog/core/workers/ui/index";
import { screenTools } from "@pipedog/core/workers/ui/ui_tools";
import { UnknownScreenActionError } from "@pipedog/core/workers/ui/ui_worker";
import { OpenAILLMService } from "../src/llm.ts";

/**
 * Minimal stand-in for `unittest.mock.MagicMock`: every attribute access
 * returns a callable mock, and calling it returns another such mock.
 */
function magicMock(): any {
  const cache = new Map<PropertyKey, unknown>();
  const fn = mock((..._args: unknown[]) => magicMock());
  return new Proxy(fn, {
    get(target, prop, receiver) {
      if (prop === "then") {
        return undefined;
      }
      if (prop === Symbol.toPrimitive || prop === "toString") {
        return () => "<MagicMock>";
      }
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      if (!cache.has(prop)) {
        cache.set(prop, magicMock());
      }
      return cache.get(prop);
    },
    set(_target, prop, value) {
      cache.set(prop, value);
      return true;
    },
  });
}

/** An `AsyncMock()` stand-in. */
function asyncMock() {
  return mock(async (..._args: unknown[]): Promise<void> => {});
}

/** The worker with its protected members and test spies reachable. */
type AnyWorker = UIWorker & Record<string, any>;

class _StubUIWorker extends UIWorker {
  captured: BusUIEventMessage[] = [];

  async _onNav(message: BusUIEventMessage): Promise<void> {
    this.captured.push(message);
  }

  static {
    // biome-ignore lint/complexity/noThisInStatic: decorates this class's own methods.
    uiEvent("nav_click")(this.prototype._onNav);
  }
}

class _PlainWorker extends UIWorker {}

type WorkerCtor = new (options: any) => UIWorker;

/**
 * A UIWorker wired with a task manager and a `queueFrame` spy.
 *
 * `queueFrame` is replaced with a recorder so tests can assert the frames the
 * UI logic produces without running the pipeline. The respond handler sends
 * its own response, so `sendJobResponse` is mocked to let `_runLlmTurn` run
 * without an active job entry.
 */
async function _makeWorker(
  cls: WorkerCtor = _StubUIWorker,
  kwargs: Record<string, unknown> = {},
): Promise<AnyWorker> {
  const worker = new cls({ name: "ui", llm: magicMock() as LLMService, ...kwargs }) as AnyWorker;
  const tm = new TaskManager();
  worker._taskManager = tm;

  const recorded: Frame[] = [];

  worker.queueFrame = async (
    frame: Frame,
    _direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> => {
    recorded.push(frame);
  };
  worker._recorded = recorded;
  worker.sendJobResponse = asyncMock();
  return worker;
}

/** Yield enough times for spawned task handlers to run/park. */
async function _settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await sleep(0);
  }
}

/**
 * Start a respond turn; it parks at `await this._pending` until resolved.
 *
 * The task is returned boxed: an async function returning a Task (a
 * thenable) would adopt it and wait for the turn to finish.
 */
async function _start(
  worker: AnyWorker,
  message: BusJobRequestMessageT,
): Promise<{ task: Task<void> }> {
  const task = createTask(() => worker._runLlmTurn(message) as Promise<void>);
  await _settle();
  return { task };
}

function _respondMsg(jobId: string, query = "hi"): BusJobRequestMessage {
  return new BusJobRequestMessage({
    source: "voice",
    target: "ui",
    jobName: "respond",
    jobId,
    payload: { query },
  });
}

async function _dispatch(worker: AnyWorker, message: BusUIEventMessage): Promise<void> {
  await worker.onBusMessage(message);
  for (let i = 0; i < 5; i++) {
    await sleep(0);
  }
}

function _appendFrames(worker: AnyWorker): LLMMessagesAppendFrame[] {
  return (worker._recorded as Frame[]).filter(
    (f): f is LLMMessagesAppendFrame => f instanceof LLMMessagesAppendFrame,
  );
}

function _updateFrames(worker: AnyWorker): LLMMessagesUpdateFrame[] {
  return (worker._recorded as Frame[]).filter(
    (f): f is LLMMessagesUpdateFrame => f instanceof LLMMessagesUpdateFrame,
  );
}

function _msg(frame: LLMMessagesAppendFrame, i = 0): Record<string, any> {
  return frame.messages[i] as Record<string, any>;
}

describe("TestUIWorkerDispatch", () => {
  test("test_dispatches_to_matching_ui_event_handler", async () => {
    const worker = await _makeWorker();

    await _dispatch(
      worker,
      new BusUIEventMessage({
        source: "music",
        target: "ui",
        eventName: "nav_click",
        payload: { view: "home" },
      }),
    );

    expect(worker.captured.length).toEqual(1);
    expect(worker.captured[0].eventName).toEqual("nav_click");
    expect(worker.captured[0].payload).toEqual({ view: "home" });
  });

  test("test_unknown_event_name_does_not_raise", async () => {
    const worker = await _makeWorker();

    await _dispatch(
      worker,
      new BusUIEventMessage({
        source: "music",
        target: "ui",
        eventName: "never_registered",
        payload: { x: 1 },
      }),
    );

    expect(worker.captured).toEqual([]);
  });

  test("test_ignores_events_targeted_at_other_workers", async () => {
    const worker = await _makeWorker();

    await _dispatch(
      worker,
      new BusUIEventMessage({
        source: "music",
        target: "someone_else",
        eventName: "nav_click",
        payload: { view: "home" },
      }),
    );

    expect(worker.captured).toEqual([]);
    expect(_appendFrames(worker)).toEqual([]);
  });

  test("test_broadcast_event_with_no_target_is_handled", async () => {
    const worker = await _makeWorker();

    await _dispatch(
      worker,
      new BusUIEventMessage({
        source: "music",
        target: null,
        eventName: "nav_click",
        payload: { view: "home" },
      }),
    );

    expect(worker.captured.length).toEqual(1);
  });

  test("test_handler_runs_in_separate_task_so_bus_is_not_blocked", async () => {
    const gate = new Event();
    const observed: boolean[] = [];

    class _BlockingWorker extends _StubUIWorker {
      async _slow(_message: BusUIEventMessage): Promise<void> {
        await gate.wait();
        observed.push(true);
      }

      static {
        // biome-ignore lint/complexity/noThisInStatic: decorates this class's own methods.
        uiEvent("slow")(this.prototype._slow);
      }
    }

    const worker = await _makeWorker(_BlockingWorker);

    await worker.onBusMessage(
      new BusUIEventMessage({ source: "music", target: "ui", eventName: "slow", payload: {} }),
    );
    expect(observed).toEqual([]);

    gate.set();
    await _settle();
    expect(observed).toEqual([true]);
  });

  test("test_duplicate_handler_names_raise_at_init", async () => {
    // Python raises ValueError; the port raises a plain Error.
    expect(() => {
      class _Bad extends UIWorker {
        async a(_message: BusUIEventMessage): Promise<void> {}

        async b(_message: BusUIEventMessage): Promise<void> {}

        static {
          // biome-ignore lint/complexity/noThisInStatic: decorates this class's own methods.
          uiEvent("nav")(this.prototype.a);
          // biome-ignore lint/complexity/noThisInStatic: decorates this class's own methods.
          uiEvent("nav")(this.prototype.b);
        }
      }

      new _Bad({ name: "ui", llm: magicMock() as LLMService });
    }).toThrow(Error);
  });

  test("test_default_construction_unaffected", async () => {
    const worker = new _PlainWorker({ name: "ui", llm: magicMock() as LLMService }) as AnyWorker;
    expect(worker._autoInjectUiState).toBe(true);
    expect(worker.active).toBe(true);
  });
});

describe("TestUIWorkerInjection", () => {
  test("test_injects_xml_developer_message_by_default", async () => {
    const worker = await _makeWorker();

    await _dispatch(
      worker,
      new BusUIEventMessage({
        source: "music",
        target: "ui",
        eventName: "nav_click",
        payload: { view: "home" },
      }),
    );

    const frames = _appendFrames(worker);
    expect(frames.length).toEqual(1);

    const frame = frames[0];
    expect(frame.runLlm).toBeFalsy();
    expect(frame.messages.length).toEqual(1);
    const msg = _msg(frame);
    expect(msg.role).toEqual("developer");

    const content: string = msg.content;
    expect(content).toContain('<ui_event name="nav_click">');
    expect(content).toContain("</ui_event>");
    const inner = content.slice(
      '<ui_event name="nav_click">'.length,
      content.length - "</ui_event>".length,
    );
    expect(JSON.parse(inner)).toEqual({ view: "home" });
  });

  test("test_inject_events_false_disables_injection", async () => {
    const worker = await _makeWorker(_StubUIWorker, { injectEvents: false });

    await _dispatch(
      worker,
      new BusUIEventMessage({
        source: "music",
        target: "ui",
        eventName: "nav_click",
        payload: { view: "home" },
      }),
    );

    expect(_appendFrames(worker)).toEqual([]);
    expect(worker.captured.length).toEqual(1);
  });

  test("test_render_override_replaces_default_xml", async () => {
    class _CustomRender extends _StubUIWorker {
      override renderUiEvent(message: BusUIEventMessage): string {
        return `[UI] ${message.eventName}`;
      }
    }

    const worker = await _makeWorker(_CustomRender);

    await _dispatch(
      worker,
      new BusUIEventMessage({
        source: "music",
        target: "ui",
        eventName: "nav_click",
        payload: { view: "home" },
      }),
    );

    const frames = _appendFrames(worker);
    expect(frames.length).toEqual(1);
    expect(_msg(frames[0]).content).toEqual("[UI] nav_click");
  });

  test("test_empty_render_skips_injection", async () => {
    class _NoRender extends _StubUIWorker {
      override renderUiEvent(_message: BusUIEventMessage): string {
        return "";
      }
    }

    const worker = await _makeWorker(_NoRender);

    await _dispatch(
      worker,
      new BusUIEventMessage({
        source: "music",
        target: "ui",
        eventName: "nav_click",
        payload: { view: "home" },
      }),
    );

    expect(_appendFrames(worker)).toEqual([]);
  });
});

const _SAMPLE_SNAPSHOT = {
  root: {
    ref: "e1",
    role: "generic",
    children: [
      {
        ref: "e2",
        role: "main",
        children: [
          { ref: "e3", role: "heading", name: "Home", level: 1 },
          {
            ref: "e4",
            role: "region",
            name: "Trending artists",
            children: [
              { ref: "e5", role: "button", name: "Bad Bunny" },
              {
                ref: "e6",
                role: "button",
                name: "Taylor Swift",
                state: ["focused"],
              },
            ],
          },
        ],
      },
    ],
  },
  captured_at: 1700000000000,
};

describe("TestUIWorkerSnapshot", () => {
  test("test_reserved_snapshot_event_stored_without_dispatch", async () => {
    const worker = await _makeWorker();

    await _dispatch(
      worker,
      new BusUIEventMessage({
        source: "music",
        target: "ui",
        eventName: UI_SNAPSHOT_EVENT_NAME,
        payload: _SAMPLE_SNAPSHOT,
      }),
    );

    expect(worker._latestSnapshot).toEqual(_SAMPLE_SNAPSHOT);
    expect(worker.captured).toEqual([]);
    expect(_appendFrames(worker)).toEqual([]);
  });

  test("test_snapshot_and_selection_read_the_latest_snapshot", async () => {
    const worker = await _makeWorker();
    expect(worker.snapshot).toBeNull();
    expect(worker.selection).toBeNull();

    worker._latestSnapshot = {
      ..._SAMPLE_SNAPSHOT,
      selection: { ref: "e2", text: "  the highlighted passage\n" },
    };
    expect(worker.snapshot).toBe(worker._latestSnapshot);
    expect(worker.selection).toEqual(
      new UISelection({ ref: "e2", text: "the highlighted passage" }),
    );
  });

  test("test_selection_is_none_without_a_ref_and_text", async () => {
    const worker = await _makeWorker();
    for (const selection of [
      null,
      "e2",
      { ref: "e2" },
      { text: "stuff" },
      { ref: "e2", text: " " },
    ]) {
      worker._latestSnapshot = { ..._SAMPLE_SNAPSHOT, selection };
      expect(worker.selection).toBeNull();
    }
  });

  test("test_non_dict_snapshot_payload_is_ignored", async () => {
    const worker = await _makeWorker();

    await _dispatch(
      worker,
      new BusUIEventMessage({
        source: "music",
        target: "ui",
        eventName: UI_SNAPSHOT_EVENT_NAME,
        payload: "not a snapshot",
      }),
    );

    expect(worker._latestSnapshot).toBeNull();
  });

  test("test_render_ui_state_empty_without_snapshot", async () => {
    const worker = await _makeWorker();
    expect(worker.renderUiState()).toEqual("");
  });

  test("test_render_ui_state_produces_indented_block", async () => {
    const worker = await _makeWorker();
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;

    const rendered = worker.renderUiState();

    expect(rendered.startsWith("<ui_state>\n")).toBe(true);
    expect(rendered.endsWith("\n</ui_state>")).toBe(true);

    expect(rendered).toContain("- generic [ref=e1]:");
    expect(rendered).toContain("- main [ref=e2]:");
    expect(rendered).toContain('- heading "Home" [level=1] [ref=e3]');
    expect(rendered).toContain('- region "Trending artists" [ref=e4]:');
    expect(rendered).toContain('- button "Bad Bunny" [ref=e5]');
    expect(rendered).toContain('- button "Taylor Swift" [focused] [ref=e6]');

    expect(rendered).toContain("  - main");
    expect(rendered).toContain("    - heading");
    expect(rendered).toContain("      - button");
  });

  test("test_inject_ui_state_queues_expected_frame", async () => {
    const worker = await _makeWorker();
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;

    await worker.injectUiState();

    const frames = _appendFrames(worker);
    expect(frames.length).toEqual(1);
    const frame = frames[0];
    expect(frame.runLlm).toBeFalsy();
    expect(frame.messages.length).toEqual(1);
    const msg = _msg(frame);
    expect(msg.role).toEqual("developer");
    expect(msg.content.startsWith("<ui_state>")).toBe(true);
    expect(msg.content.endsWith("</ui_state>")).toBe(true);
  });

  test("test_inject_ui_state_no_op_without_snapshot", async () => {
    const worker = await _makeWorker();
    await worker.injectUiState();
    expect(_appendFrames(worker)).toEqual([]);
  });

  test("test_render_emits_grid_dims", async () => {
    const worker = await _makeWorker();
    worker._latestSnapshot = {
      root: {
        ref: "e1",
        role: "generic",
        children: [
          {
            ref: "e2",
            role: "grid",
            name: "Trending artists",
            colcount: 8,
            rowcount: 2,
            children: [{ ref: "e3", role: "button", name: "Bad Bunny" }],
          },
        ],
      },
      captured_at: 1700000000000,
    };

    const rendered = worker.renderUiState();
    expect(rendered).toContain('- grid "Trending artists" [cols=8] [rows=2] [ref=e2]');
  });

  test("test_render_preserves_offscreen_tag", async () => {
    const worker = await _makeWorker();
    worker._latestSnapshot = {
      root: {
        ref: "e1",
        role: "generic",
        children: [
          { ref: "e2", role: "button", name: "Visible" },
          { ref: "e3", role: "button", name: "Below fold", state: ["offscreen"] },
        ],
      },
      captured_at: 1700000000000,
    };

    const rendered = worker.renderUiState();
    expect(rendered).toContain('- button "Visible" [ref=e2]');
    expect(rendered).toContain('- button "Below fold" [offscreen] [ref=e3]');
  });

  test("test_render_emits_selection_block_when_present", async () => {
    const worker = await _makeWorker();
    worker._latestSnapshot = {
      root: { ref: "e1", role: "generic", children: [{ ref: "e2", role: "main" }] },
      captured_at: 1700000000000,
      selection: { ref: "e2", text: "the highlighted passage" },
    };

    const rendered: string = worker.renderUiState();
    expect(rendered).toContain('<selection ref="e2">');
    expect(rendered).toContain("the highlighted passage");
    expect(rendered).toContain("</selection>");
    expect(rendered.endsWith("</ui_state>")).toBe(true);
    const selIdx = rendered.indexOf('<selection ref="e2">');
    const closeIdx = rendered.indexOf("</ui_state>");
    expect(selIdx).toBeGreaterThanOrEqual(0);
    expect(selIdx).toBeLessThan(closeIdx);
  });

  test("test_render_omits_selection_when_missing", async () => {
    const worker = await _makeWorker();
    worker._latestSnapshot = {
      root: { ref: "e1", role: "generic" },
      captured_at: 1700000000000,
    };

    const rendered = worker.renderUiState();
    expect(rendered).not.toContain("<selection");
  });

  test("test_render_skips_selection_with_missing_ref_or_text", async () => {
    const worker = await _makeWorker();
    worker._latestSnapshot = {
      root: { ref: "e1", role: "generic" },
      captured_at: 1,
      selection: { ref: "e2" },
    };
    expect(worker.renderUiState()).not.toContain("<selection");

    worker._latestSnapshot = {
      root: { ref: "e1", role: "generic" },
      captured_at: 1,
      selection: { text: "stuff" },
    };
    expect(worker.renderUiState()).not.toContain("<selection");
  });
});

/**
 * The <ui_state> snapshot is injected just before inference via the LLM's
 * on_before_process_frame hook (e.g. during a respond job).
 */
describe("TestUIWorkerSnapshotInjection", () => {
  const _worker = (cls: WorkerCtor = _PlainWorker, kwargs: Record<string, unknown> = {}) => {
    // A real LLM service so the on_before_process_frame event actually fires.
    const llm = new OpenAILLMService({ apiKey: "sk-test" });
    return new cls({ name: "ui", llm, ...kwargs }) as AnyWorker;
  };

  const _fire = async (worker: AnyWorker, context: LLMContext): Promise<void> => {
    await (worker.llm as any)._callEventHandler(
      "on_before_process_frame",
      new LLMContextFrame({ context }),
    );
  };

  const _developerMessages = (context: LLMContext): any[] =>
    context.messages.filter(
      (m: any) => typeof m === "object" && m !== null && m.role === "developer",
    );

  test("test_injects_ui_state_on_user_turn", async () => {
    const worker = _worker();
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;
    const ctx = new LLMContext({ messages: [{ role: "user", content: "hi" }] });
    await _fire(worker, ctx);
    const devs = _developerMessages(ctx);
    expect(devs.length).toEqual(1);
    expect(devs[0].content.startsWith("<ui_state>")).toBe(true);
  });

  test("test_skips_tool_result_continuation", async () => {
    // The follow-up inference after a tool result must not stack a second
    // <ui_state> within the same turn.
    const worker = _worker();
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;
    const ctx = new LLMContext({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok" },
        { role: "tool", content: "result" } as any,
      ],
    });
    const before = ctx.messages.length;
    await _fire(worker, ctx);
    expect(ctx.messages.length).toEqual(before);
  });

  test("test_no_injection_when_disabled", async () => {
    const worker = _worker(_PlainWorker, { autoInjectUiState: false });
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;
    const ctx = new LLMContext({ messages: [{ role: "user", content: "hi" }] });
    await _fire(worker, ctx);
    expect(ctx.messages.length).toEqual(1);
  });

  test("test_no_injection_without_snapshot", async () => {
    const worker = _worker();
    const ctx = new LLMContext({ messages: [{ role: "user", content: "hi" }] });
    await _fire(worker, ctx);
    expect(ctx.messages.length).toEqual(1);
  });

  test("test_render_ui_state_override_amends_injected_content", async () => {
    // Apps override render_ui_state to amend what the LLM sees of the screen
    // (e.g. prepend app context or trim the tree). The auto-inject hook uses
    // the override's output, not the default rendering.
    class _CustomState extends _PlainWorker {
      override renderUiState(): string {
        const base = super.renderUiState();
        return base ? `<app_note>cart has 2 items</app_note>\n${base}` : base;
      }
    }

    const worker = _worker(_CustomState);
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;
    const ctx = new LLMContext({ messages: [{ role: "user", content: "hi" }] });
    await _fire(worker, ctx);
    const devs = _developerMessages(ctx);
    expect(devs.length).toEqual(1);
    expect(devs[0].content.startsWith("<app_note>cart has 2 items</app_note>")).toBe(true);
    expect(devs[0].content).toContain("<ui_state>");
  });

  test("test_render_ui_state_override_empty_skips_injection", async () => {
    // An override returning "" suppresses injection even with a snapshot.
    class _NoState extends _PlainWorker {
      override renderUiState(): string {
        return "";
      }
    }

    const worker = _worker(_NoState);
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;
    const ctx = new LLMContext({ messages: [{ role: "user", content: "hi" }] });
    await _fire(worker, ctx);
    expect(ctx.messages.length).toEqual(1);
  });

  test("test_injects_once_per_turn", async () => {
    // After injecting, the tail is the developer message, so a re-fire on the
    // same context is a no-op (no accumulation within a turn).
    const worker = _worker();
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;
    const ctx = new LLMContext({ messages: [{ role: "user", content: "hi" }] });
    await _fire(worker, ctx);
    await _fire(worker, ctx);
    expect(_developerMessages(ctx).length).toEqual(1);
  });
});

describe("TestUIWorkerKeepHistory", () => {
  test("test_default_resets_context_per_job", async () => {
    const worker = await _makeWorker();
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;

    const { task: t } = await _start(
      worker,
      new BusJobRequestMessage({
        source: "voice",
        target: "ui",
        jobId: "t1",
        payload: { query: "hi" },
      }),
    );

    const updates = _updateFrames(worker);
    expect(updates.length).toEqual(1);
    expect(updates[0].messages).toEqual([]);
    expect(updates[0].runLlm).toBeFalsy();

    await worker.respondToJob();
    await t;
  });

  test("test_reset_runs_before_inject", async () => {
    const worker = await _makeWorker();
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;

    const { task: t } = await _start(
      worker,
      new BusJobRequestMessage({
        source: "voice",
        target: "ui",
        jobId: "t1",
        payload: { query: "hi" },
      }),
    );

    const frameTypes = (worker._recorded as Frame[]).map((f) => f.constructor.name);
    const updateIdx = frameTypes.indexOf("LLMMessagesUpdateFrame");
    const appendIdx = frameTypes.indexOf("LLMMessagesAppendFrame");
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(appendIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeLessThan(appendIdx);

    await worker.respondToJob();
    await t;
  });

  test("test_keep_history_true_skips_reset", async () => {
    const worker = await _makeWorker(_StubUIWorker, { keepHistory: true });
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;

    const { task: t } = await _start(
      worker,
      new BusJobRequestMessage({
        source: "voice",
        target: "ui",
        jobId: "t1",
        payload: { query: "hi" },
      }),
    );

    // Injection moved to the on_before_process_frame hook, so _run_llm_turn
    // itself queues only the query append.
    expect(_updateFrames(worker)).toEqual([]);
    const appends = _appendFrames(worker);
    expect(appends.length).toEqual(1);
    expect(_msg(appends[0]).content).toEqual("hi");

    await worker.respondToJob();
    await t;
  });

  test("test_reset_context_method_emits_update_frame", async () => {
    const worker = await _makeWorker(_StubUIWorker, { keepHistory: true });

    await worker._resetContext();

    const updates = _updateFrames(worker);
    expect(updates.length).toEqual(1);
    expect(updates[0].messages).toEqual([]);
    expect(updates[0].runLlm).toBeFalsy();
  });
});

describe("TestUIWorkerRespondToJob", () => {
  test("test_current_job_tracks_in_flight_request", async () => {
    const worker = await _makeWorker();
    expect(worker.currentJob).toBeNull();
    const message = new BusJobRequestMessage({
      source: "voice",
      target: "ui",
      jobId: "t1",
      payload: { query: "hi" },
    });
    const { task: t } = await _start(worker, message);
    expect(worker.currentJob).toBe(message);

    await worker.respondToJob();
    await t;
  });

  test("test_respond_to_job_responds_with_answer", async () => {
    const worker = await _makeWorker();
    const message = new BusJobRequestMessage({
      source: "voice",
      target: "ui",
      jobName: "respond",
      jobId: "t1",
    });
    const { task: t } = await _start(worker, message);

    await worker.respondToJob("hello");
    await t;

    expect(worker.sendJobResponse).toHaveBeenCalledTimes(1);
    const call = worker.sendJobResponse.mock.calls[0];
    expect(call[0]).toEqual("t1");
    expect(call[1]).toEqual({ answer: "hello" });
    expect(worker.currentJob).toBeNull();
  });

  test("test_respond_to_job_no_op_when_idle", async () => {
    const worker = await _makeWorker();
    await worker.respondToJob("hello");
    expect(worker.sendJobResponse).not.toHaveBeenCalled();
  });

  test("test_respond_to_job_none_answer_responds_none", async () => {
    const worker = await _makeWorker();
    const message = new BusJobRequestMessage({
      source: "voice",
      target: "ui",
      jobName: "respond",
      jobId: "t1",
    });
    const { task: t } = await _start(worker, message);

    await worker.respondToJob();
    await t;

    const calls = worker.sendJobResponse.mock.calls;
    expect(calls[calls.length - 1][1]).toBeNull();
  });

  // Skipped: `respond_to_job(tts_speak=True)` is deprecated upstream (since
  // 1.12.0) and not ported.
  test.skip("test_respond_to_job_tts_speak_speaks_and_responds_none", () => {});

  // Skipped: `respond_to_job(tts_speak=True)` is deprecated upstream (since
  // 1.12.0) and not ported.
  test.skip("test_respond_to_job_tts_speak_empty_answer_does_not_speak", () => {});

  test("test_cancellation_frees_lock_for_subsequent_jobs", async () => {
    const worker = await _makeWorker();
    const msgA = _respondMsg("a");
    const msgB = _respondMsg("b");

    await worker._handleJobRequest(msgA);
    await _settle();
    expect(worker.currentJob).toBe(msgA);
    expect(worker._jobLocks.get("respond").locked()).toBe(true);

    await worker._handleJobCancel(
      new BusJobCancelMessage({ source: "voice", target: "ui", jobId: "a" }),
    );
    await _settle();
    expect(worker.currentJob).toBeNull();
    expect(worker._jobLocks.get("respond").locked()).toBe(false);

    await worker._handleJobRequest(msgB);
    await _settle();
    expect(worker.currentJob).toBe(msgB);

    await worker.respondToJob("B done");
    await _settle();
  });

  test("test_cancel_unknown_job_id_is_noop", async () => {
    const worker = await _makeWorker();
    const msgA = _respondMsg("a");

    await worker._handleJobRequest(msgA);
    await _settle();

    await worker._handleJobCancel(
      new BusJobCancelMessage({ source: "voice", target: "ui", jobId: "unrelated" }),
    );
    await _settle();

    expect(worker.currentJob).toBe(msgA);
    expect(worker._jobLocks.get("respond").locked()).toBe(true);

    await worker.respondToJob("A done");
    await _settle();
  });

  test("test_concurrent_same_name_jobs_serialize", async () => {
    const worker = await _makeWorker();
    const msgA = _respondMsg("a");
    const msgB = _respondMsg("b");

    await worker._handleJobRequest(msgA);
    await _settle();
    expect(worker.currentJob).toBe(msgA);

    await worker._handleJobRequest(msgB);
    await _settle();
    expect(worker.currentJob).toBe(msgA);

    await worker.respondToJob("A done");
    await _settle();
    expect(worker.currentJob).toBe(msgB);

    await worker.respondToJob("B done");
    await _settle();
    expect(worker.currentJob).toBeNull();
  });
});

describe("TestUIWorkerRespondJob", () => {
  test("test_respond_handler_runs_after_setup", async () => {
    const worker = await _makeWorker();
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;

    const { task: t } = await _start(
      worker,
      new BusJobRequestMessage({
        source: "voice",
        target: "ui",
        jobId: "t1",
        payload: { query: "hello" },
      }),
    );

    // The snapshot is injected by the hook at inference time, so the handler
    // itself queues only the rendered query.
    const appends = _appendFrames(worker);
    expect(appends.length).toEqual(1);
    expect(_msg(appends[0]).content).toEqual("hello");
    expect(appends[0].runLlm).toBe(true);
    expect(worker.currentJob.jobId).toEqual("t1");

    await worker.respondToJob("done");
    await t;
    expect(worker.currentJob).toBeNull();
    expect(worker.sendJobResponse).toHaveBeenCalledTimes(1);
  });

  const _stopAssistantTurn = async (
    worker: AnyWorker,
    content: string,
    options: { interrupted?: boolean } = {},
  ): Promise<void> => {
    const message = new AssistantTurnStoppedMessage({
      content,
      interrupted: options.interrupted ?? false,
      timestamp: "",
    });
    await (worker.assistantAggregator as any)._callEventHandler(
      "on_assistant_turn_stopped",
      message,
    );
    await _settle();
  };

  test("test_the_llm_reply_answers_the_job", async () => {
    const worker = await _makeWorker();
    const { task: t } = await _start(
      worker,
      new BusJobRequestMessage({
        source: "voice",
        target: "ui",
        jobId: "t1",
        payload: { query: "hi" },
      }),
    );

    await _stopAssistantTurn(worker, "Three stories and a sidebar.");
    await waitFor(() => t, 2);

    expect(worker.sendJobResponse).toHaveBeenCalledTimes(1);
    expect(worker.sendJobResponse).toHaveBeenCalledWith(
      "t1",
      { answer: "Three stories and a sidebar." },
      { status: JobStatus.COMPLETED },
    );
    expect(worker.currentJob).toBeNull();
  });

  test("test_a_reply_that_comes_with_tool_calls_does_not_answer", async () => {
    const worker = await _makeWorker();
    const { task: t } = await _start(
      worker,
      new BusJobRequestMessage({
        source: "voice",
        target: "ui",
        jobId: "t1",
        payload: { query: "hi" },
      }),
    );

    await _stopAssistantTurn(worker, "", { interrupted: true });
    await _stopAssistantTurn(worker, "");
    (worker.assistantAggregator as any)._functionCallsInProgress.set("c1", null);
    await _stopAssistantTurn(worker, "Let me check.");
    expect(worker.currentJob.jobId).toEqual("t1");

    await worker.respondToJob("done");
    await t;
    expect(worker.sendJobResponse).toHaveBeenCalledTimes(1);
    expect(worker.sendJobResponse).toHaveBeenCalledWith(
      "t1",
      { answer: "done" },
      { status: JobStatus.COMPLETED },
    );
  });

  test("test_render_query_override", async () => {
    class _Custom extends _StubUIWorker {
      override renderQuery(message: BusJobRequestMessageT): string {
        return `Q: ${(message.payload as Record<string, unknown>).q}`;
      }
    }

    const worker = await _makeWorker(_Custom);
    const { task: t } = await _start(
      worker,
      new BusJobRequestMessage({
        source: "voice",
        target: "ui",
        jobId: "t1",
        payload: { q: "hi" },
      }),
    );

    const queryFrames = _appendFrames(worker).filter((f) => f.runLlm);
    expect(_msg(queryFrames[0]).content).toEqual("Q: hi");

    await worker.respondToJob();
    await t;
  });

  test("test_handler_failure_clears_state", async () => {
    class RuntimeError extends Error {}

    class _Boom extends _StubUIWorker {
      override renderQuery(_message: BusJobRequestMessageT): string {
        throw new RuntimeError("boom");
      }
    }

    const worker = await _makeWorker(_Boom);

    await expect(
      worker._runLlmTurn(
        new BusJobRequestMessage({
          source: "voice",
          target: "ui",
          jobId: "t1",
          payload: { query: "x" },
        }),
      ),
    ).rejects.toThrow(RuntimeError);

    expect(worker.currentJob).toBeNull();
    expect(worker._pending).toBeNull();
  });
});

describe("TestUIWorkerPromptGuide", () => {
  test("test_default_appends_ui_state_prompt_guide", async () => {
    // bun's matchers need the mock itself, not a MagicMock proxy child.
    const llm = magicMock();
    llm.appendSystemInstruction = mock();
    const worker = new UIWorker({ name: "ui", llm: llm as LLMService }) as AnyWorker;
    const append = (worker.llm as any).appendSystemInstruction;
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(UI_STATE_PROMPT_GUIDE);
  });

  test("test_custom_prompt_guide_overrides", async () => {
    // bun's matchers need the mock itself, not a MagicMock proxy child.
    const llm = magicMock();
    llm.appendSystemInstruction = mock();
    const worker = new UIWorker({
      name: "ui",
      llm: llm as LLMService,
      promptGuide: "MY GUIDE",
    }) as AnyWorker;
    const append = (worker.llm as any).appendSystemInstruction;
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith("MY GUIDE");
  });

  test("test_none_disables_injection", async () => {
    // bun's matchers need the mock itself, not a MagicMock proxy child.
    const llm = magicMock();
    llm.appendSystemInstruction = mock();
    const worker = new UIWorker({
      name: "ui",
      llm: llm as LLMService,
      promptGuide: null,
    }) as AnyWorker;
    expect((worker.llm as any).appendSystemInstruction).not.toHaveBeenCalled();
  });
});

/** Answers from a scripted probability and records what it was asked. */
class _FakeClassifier extends BaseClassifier {
  probability: number;
  choiceLabel = "";
  asked: [any, any][] = [];
  setupTaskManager: unknown = null;
  cleanedUp = false;

  constructor(probability: number) {
    super();
    this.probability = probability;
  }

  override async setup(taskManager: unknown): Promise<void> {
    this.setupTaskManager = taskManager;
  }

  override async cleanup(): Promise<void> {
    this.cleanedUp = true;
  }

  protected async _ask(
    state: ClassifierValue,
    questions: Readonly<Record<string, ClassifierQuestion>>,
    _images: readonly unknown[] = [],
  ): Promise<[Record<string, ClassifierResult>, null]> {
    const results: Record<string, ClassifierResult> = {};
    for (const [name, question] of Object.entries(questions)) {
      this.asked.push([state, question]);
      if (question instanceof ChoiceQuestion) {
        const options = Object.keys(question.options);
        const label = options.includes(this.choiceLabel) ? this.choiceLabel : options[0];
        const probabilities: Record<string, number> = {};
        for (const o of options) {
          probabilities[o] = o === label ? 1.0 : 0.0;
        }
        results[name] = new ChoiceResult({
          choice: label,
          probabilities,
          confidence: this.probability,
        });
      } else {
        results[name] = new YesNoResult({ probability: this.probability });
      }
    }
    return [results, null];
  }
}

describe("TestUIWorkerClassifier", () => {
  test("test_defaults_to_an_llm_classifier_over_the_llm", async () => {
    const worker = await _makeWorker();
    expect(worker.classifier).toBeInstanceOf(LLMClassifier);
    expect((worker.classifier as LLMClassifier).llm).toBe(worker.llm);
  });

  test("test_activation_sets_the_classifier_up_and_cleanup_cleans_it", async () => {
    const classifier = new _FakeClassifier(0.9);
    const worker = await _makeWorker(_StubUIWorker, { classifier });

    await worker.onActivated(null);
    expect(classifier.setupTaskManager).toBe(worker.taskManager);
    expect(worker.classifier).toBe(classifier);

    await worker.cleanup();
    expect(classifier.cleanedUp).toBe(true);
  });

  test("test_should_respond_asks_with_the_event_and_the_screen", async () => {
    const classifier = new _FakeClassifier(0.9);
    const worker = await _makeWorker(_StubUIWorker, { classifier });
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;
    const event = new BusUIEventMessage({
      source: "music",
      target: "ui",
      eventName: "nav_click",
      payload: { view: "home" },
    });

    expect(await worker.shouldRespond(event)).toBe(true);

    const [state, question] = classifier.asked[0];
    expect(state.event).toEqual({ name: "nav_click", payload: { view: "home" } });
    expect(state.screen.startsWith("<ui_state>")).toBe(true);
    expect(question.instructions).toContain("say something");
    expect(question.no).toContain("routine click");
  });

  test("test_should_respond_is_false_when_no_is_likelier", async () => {
    const worker = await _makeWorker(_StubUIWorker, { classifier: new _FakeClassifier(0.3) });
    const event = new BusUIEventMessage({
      source: "music",
      target: "ui",
      eventName: "scroll",
      payload: {},
    });
    expect(await worker.shouldRespond(event)).toBe(false);
  });

  test("test_should_respond_without_a_snapshot_sends_only_the_event", async () => {
    const classifier = new _FakeClassifier(0.9);
    const worker = await _makeWorker(_StubUIWorker, { classifier });
    const event = new BusUIEventMessage({
      source: "music",
      target: "ui",
      eventName: "scroll",
      payload: {},
    });

    await worker.shouldRespond(event);

    const [state] = classifier.asked[0];
    expect("screen" in state).toBe(false);
  });

  test("test_which_element_asks_over_the_named_elements", async () => {
    const classifier = new _FakeClassifier(0.9);
    classifier.choiceLabel = "e6";
    const worker = await _makeWorker(_StubUIWorker, { classifier });
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;

    const ref = await worker.whichElement("the Taylor Swift one");

    expect(ref).toEqual("e6");
    const [state, question] = classifier.asked[0];
    expect(state.utterance).toEqual("the Taylor Swift one");
    expect(state.screen).toContain("<ui_state>");
    expect(question.options.e5).toEqual('button "Bad Bunny"');
    expect(question.options.e6).toEqual('button "Taylor Swift"');
    expect("e1" in question.options).toBe(false);
    expect(question.instructions).toContain("referring to");
  });

  test("test_which_element_returns_none_below_the_threshold", async () => {
    const classifier = new _FakeClassifier(0.2);
    classifier.choiceLabel = "e5";
    const worker = await _makeWorker(_StubUIWorker, { classifier });
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;
    expect(await worker.whichElement("that one")).toBeNull();
  });

  test("test_which_element_without_a_snapshot_asks_nothing", async () => {
    const classifier = new _FakeClassifier(0.9);
    const worker = await _makeWorker(_StubUIWorker, { classifier });
    expect(await worker.whichElement("that one")).toBeNull();
    expect(classifier.asked).toEqual([]);
  });
});

function _job(name: string, payload: Record<string, unknown>): BusJobRequestMessage {
  return new BusJobRequestMessage({
    source: "voice",
    target: "ui",
    jobName: name,
    jobId: "j1",
    payload,
  });
}

describe("TestUIWorkerScreenJobs", () => {
  const _worker = async (
    probability = 0.9,
    choice = "e6",
  ): Promise<[AnyWorker, _FakeClassifier]> => {
    const classifier = new _FakeClassifier(probability);
    classifier.choiceLabel = choice;
    const worker = await _makeWorker(_StubUIWorker, { classifier });
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;
    worker.sendBusMessage = asyncMock();
    return [worker, classifier];
  };

  const _response = (worker: AnyWorker): [any, JobStatus] => {
    const calls = worker.sendJobResponse.mock.calls;
    const args = calls[calls.length - 1];
    return [args[1], args[2]?.status ?? JobStatus.COMPLETED];
  };

  const _lastSent = (worker: AnyWorker): BusMessage => {
    const calls = worker.sendBusMessage.mock.calls;
    return calls[calls.length - 1][0];
  };

  test("test_find_answers_with_the_element_and_its_confidence", async () => {
    const [worker] = await _worker();
    await worker._screenJob(_job("screen", { action: "find", target: "the Taylor Swift one" }));
    const [response, status] = _response(worker);
    expect(status).toEqual(JobStatus.COMPLETED);
    expect(response).toEqual({ label: "Taylor Swift", confidence: 0.9 });
  });

  test("test_selection_answers_with_the_selected_text", async () => {
    const [worker, classifier] = await _worker();
    worker._latestSnapshot = {
      ..._SAMPLE_SNAPSHOT,
      selection: { ref: "e2", text: "the highlighted passage" },
    };
    await worker._screenJob(_job("screen", { action: "selection" }));
    const [response, status] = _response(worker);
    expect(status).toEqual(JobStatus.COMPLETED);
    expect(response).toEqual({ text: "the highlighted passage" });
    expect(classifier.asked).toEqual([]);
  });

  test("test_selection_answers_no_text_when_nothing_is_selected", async () => {
    const [worker] = await _worker();
    await worker._screenJob(_job("screen", { action: "selection" }));
    const [response] = _response(worker);
    expect(response).toEqual({ text: null });
  });

  test("test_find_below_the_threshold_answers_no_label", async () => {
    const [worker] = await _worker(0.3);
    await worker._screenJob(_job("screen", { action: "find", target: "the blue one" }));
    const [response] = _response(worker);
    expect(response).toEqual({ label: null, confidence: 0.3 });
  });

  test("test_find_without_named_elements_answers_nothing", async () => {
    const [worker, classifier] = await _worker();
    worker._latestSnapshot = null;
    await worker._screenJob(_job("screen", { action: "find", target: "anything" }));
    const [response] = _response(worker);
    expect(response).toEqual({ label: null, confidence: 0.0 });
    expect(classifier.asked).toEqual([]);
  });

  test("test_check_answers_yes_or_no_about_the_screen", async () => {
    const [worker, classifier] = await _worker(0.8);
    await worker._screenJob(_job("screen", { action: "check", target: "is an artist focused?" }));
    const [response] = _response(worker);
    expect(response).toEqual({ yes: true, probability: 0.8 });
    const [state, question] = classifier.asked[0];
    expect(state.screen.startsWith("<ui_state>")).toBe(true);
    expect(question.instructions).toEqual("is an artist focused?");
  });

  test("test_select_asks_one_question_per_element_in_one_call", async () => {
    const [worker, classifier] = await _worker(0.7);
    await worker._screenJob(_job("screen", { action: "select", target: "musicians" }));
    const [response] = _response(worker);
    expect(response).toEqual({
      matches: [
        { label: "Home", probability: 0.7 },
        { label: "Trending artists", probability: 0.7 },
        { label: "Bad Bunny", probability: 0.7 },
        { label: "Taylor Swift", probability: 0.7 },
      ],
    });
    // One call, four questions, keyed by ref.
    expect(new Set(classifier.asked.map(([state]) => state)).size).toEqual(1);
    expect(classifier.asked.length).toEqual(4);
  });

  test("test_act_finds_the_element_and_sends_the_command", async () => {
    const [worker] = await _worker(0.9, "e5");
    await worker._screenJob(_job("screen", { action: "click", target: "Bad Bunny" }));
    const [response] = _response(worker);
    expect(response).toEqual({ done: true, label: "Bad Bunny" });
    const sent = _lastSent(worker) as BusUICommandMessage;
    expect(sent).toBeInstanceOf(BusUICommandMessage);
    expect(sent.commandName).toEqual("click");
    expect((sent.payload as any).ref).toEqual("e5");
  });

  test("test_act_below_the_threshold_does_nothing", async () => {
    const [worker] = await _worker(0.2, "e5");
    await worker._screenJob(_job("screen", { action: "click", target: "that" }));
    const [response] = _response(worker);
    expect(response).toEqual({ done: false, label: null });
    expect(worker.sendBusMessage).not.toHaveBeenCalled();
  });

  test("test_act_writes_a_value_into_an_input", async () => {
    const [worker] = await _worker(0.9, "e6");
    await worker._screenJob(_job("screen", { action: "fill", target: "Taylor", value: "hi" }));
    const sent = _lastSent(worker) as BusUICommandMessage;
    expect(sent.commandName).toEqual("set_input_value");
    const payload = sent.payload as any;
    expect([payload.ref, payload.value]).toEqual(["e6", "hi"]);
  });

  test("test_act_with_an_unknown_action_is_a_value_error", async () => {
    const [worker] = await _worker();
    await expect(worker.act("explode", "the button")).rejects.toThrow(UnknownScreenActionError);
  });

  test("test_elements_lists_names_roles_and_state_without_refs", async () => {
    const [worker] = await _worker();
    await worker._screenJob(_job("screen", { action: "list", target: "button" }));
    const [response] = _response(worker);
    expect(response).toEqual({
      elements: [
        { role: "button", name: "Bad Bunny", state: [], value: null },
        { role: "button", name: "Taylor Swift", state: ["focused"], value: null },
      ],
    });
  });

  test("test_elements_carry_an_input_value", async () => {
    const [worker] = await _worker();
    worker._latestSnapshot = {
      root: {
        ref: "e1",
        role: "form",
        children: [
          { ref: "e2", role: "textbox", name: "Email", value: "a@b.c" },
          { ref: "e3", role: "textbox", name: "Phone" },
        ],
      },
    };
    await worker._screenJob(_job("screen", { action: "list", target: "textbox" }));
    const [response] = _response(worker);
    expect(response).toEqual({
      elements: [
        { role: "textbox", name: "Email", state: [], value: "a@b.c" },
        { role: "textbox", name: "Phone", state: [], value: null },
      ],
    });
  });

  test("test_an_unknown_action_answers_with_an_error_status", async () => {
    const [worker] = await _worker();
    await worker._screenJob(_job("screen", { action: "explode", target: "the button" }));
    const [response, status] = _response(worker);
    expect(status).toEqual(JobStatus.ERROR);
    expect(response.error).toContain("explode");
  });

  test("test_a_classifier_failure_answers_with_an_error_status", async () => {
    class _Broken extends _FakeClassifier {
      protected override async _ask(): Promise<[Record<string, ClassifierResult>, null]> {
        throw new ClassifierError("down");
      }
    }

    const worker = await _makeWorker(_StubUIWorker, { classifier: new _Broken(0.9) });
    worker._latestSnapshot = _SAMPLE_SNAPSHOT;
    await worker._screenJob(_job("screen", { action: "check", target: "?" }));
    const [response, status] = _response(worker);
    expect(status).toEqual(JobStatus.ERROR);
    expect(response).toEqual({ error: "down" });
  });
});

/** What `pipelineWorker.job(...)` returns: a context whose response is scripted. */
class _FakeJob {
  response: unknown;
  #error: string | null;

  constructor(response: unknown = null, error: string | null = null) {
    this.response = response;
    this.#error = error;
  }

  async run<R>(fn: (ctx: this) => Promise<R> | R): Promise<R> {
    if (this.#error) {
      throw new JobError(this.#error);
    }
    return await fn(this);
  }
}

describe("TestScreenTool", () => {
  test("test_the_tool_describes_itself_to_the_llm", () => {
    const tools = screenTools("ui");
    expect(tools.length).toEqual(1);
    const [tool] = tools;
    const schema = new DirectFunctionWrapper(tool);
    expect(schema.name).toEqual("screen");
    expect(Object.keys(schema.properties).sort()).toEqual(["action", "target", "value"]);
    expect(schema.required).toEqual(["action"]);
    expect(schema.properties.action.description).toContain("fill");
    expect(schema.description).toContain("checkout button");
  });

  test("test_the_tool_sends_the_job_and_returns_its_answer", async () => {
    const tools = screenTools("ui", { timeout: 5 });
    expect(tools.length).toEqual(1);
    const [tool] = tools;
    const params = magicMock();
    params.pipelineWorker.job = mock(() => new _FakeJob({ label: "Taylor Swift" }));
    params.resultCallback = asyncMock();

    await tool(params, "find", "the Taylor Swift one");

    expect(params.pipelineWorker.job).toHaveBeenCalledTimes(1);
    expect(params.pipelineWorker.job).toHaveBeenCalledWith("ui", {
      params: new JobParams({
        name: "screen",
        payload: { action: "find", target: "the Taylor Swift one" },
        timeout: 5,
      }),
    });
    expect(params.resultCallback).toHaveBeenCalledTimes(1);
    expect(params.resultCallback).toHaveBeenCalledWith({ label: "Taylor Swift" });
  });

  test("test_a_failed_job_returns_the_error_as_data", async () => {
    const [tool] = screenTools("ui");
    const params = magicMock();
    params.pipelineWorker.job = mock(() => new _FakeJob(null, "no such worker"));
    params.resultCallback = asyncMock();

    await tool(params, "check", "anything?");

    expect(params.resultCallback).toHaveBeenCalledTimes(1);
    expect(params.resultCallback).toHaveBeenCalledWith({ error: "no such worker" });
  });
});
