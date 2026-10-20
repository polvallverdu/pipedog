// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/workers/ui/ui_worker.py

/**
 * UIWorker: an LLM worker that observes and drives a client GUI over RTVI.
 *
 * Porting notes:
 * - Deprecated upstream and not ported: `UIWorker.ui_job_group` and
 *   `UIWorker.start_ui_job_group` (since 1.8.0; use `jobGroup` /
 *   `requestJobGroup`), and the `tts_speak` option of `respond_to_job`
 *   (since 1.12.0; respond with the answer and let the voice LLM say it).
 * - `sendCommand` converts an RTVI `BaseModel` payload with `modelDump()`;
 *   other objects are forwarded as-is (JavaScript has no dataclasses).
 * - `renderUiEvent` encodes the payload as Python's `json.dumps(payload,
 *   default=str)` does (`", "` / `": "` separators, non-ASCII escaped), so the
 *   injected `<ui_event>` text is identical across ports.
 */

import { Event, rethrowIfCancelled, time } from "@pipecat-ts/asyncio";
import type {
  BusJobRequestMessage,
  BusJobResponseMessage,
  BusJobResponseUrgentMessage,
  BusJobStreamEndMessage,
  BusJobUpdateMessage,
  BusJobUpdateUrgentMessage,
  BusMessage,
} from "../../bus/messages.ts";
import {
  BusUICommandMessage,
  BusUIEventMessage,
  BusUIJobCompletedMessage,
  BusUIJobGroupCompletedMessage,
  BusUIJobGroupStartedMessage,
  BusUIJobUpdateMessage,
  UI_CANCEL_JOB_GROUP_EVENT_NAME,
  UI_SNAPSHOT_EVENT_NAME,
} from "../../bus/ui/messages.ts";
import {
  type BaseClassifier,
  ChoiceQuestion,
  ClassifierError,
  YesNoQuestion,
  type YesNoResult,
} from "../../classifiers/base_classifier.ts";
import { LLMClassifier } from "../../classifiers/llm/classifier.ts";
import {
  type Frame,
  LLMContextFrame,
  LLMMessagesAppendFrame,
  LLMMessagesUpdateFrame,
} from "../../frames/frames.ts";
import { type JobGroup, type JobGroupResponse, JobStatus } from "../../pipeline/job_context.ts";
import { job } from "../../pipeline/job_decorator.ts";
import { type LLMContext, LLMSpecificMessage } from "../../processors/aggregators/llm_context.ts";
import type {
  AssistantTurnStoppedMessage,
  LLMAssistantAggregator,
  LLMAssistantAggregatorParams,
} from "../../processors/aggregators/llm_response_universal.ts";
import {
  BaseModel,
  Click,
  Highlight,
  ScrollTo,
  SelectText,
  SetInputValue,
} from "../../processors/frameworks/rtvi/models.ts";
import type { LLMService } from "../../services/llm_service.ts";
import { logger } from "../../utils/logger.ts";
import type { JobGroupOptions } from "../base_worker.ts";
import { LLMContextWorker } from "../llm/llm_context_worker.ts";
import { _collectUiEventHandlers } from "./ui_event_decorator.ts";
import { UI_STATE_PROMPT_GUIDE } from "./ui_prompts.ts";

type Dict = Record<string, unknown>;

/** The confidence below which the classifier's pick of an element is no answer. */
const ELEMENT_THRESHOLD = 0.5;

/** The text the user has selected on the page, and the element it is in. */
export class UISelection {
  readonly ref: string;
  readonly text: string;

  constructor(options: { ref: string; text: string }) {
    this.ref = options.ref;
    this.text = options.text;
  }
}

/** A named element of the snapshot, as the screen questions see it. */
interface _Element {
  ref: string;
  role: string;
  name: string;
  state: string[];
  value: string | null;
}

/** What `act` can do to an element, each a command helper on the worker. */
const ACTIONS: ReadonlySet<string> = new Set([
  "click",
  "scroll_to",
  "highlight",
  "select_text",
  "set_input_value",
]);

/** The method on the worker for each of `ACTIONS` (Python's `getattr(self, action)`). */
const ACTION_METHODS = {
  click: "click",
  scroll_to: "scrollTo",
  highlight: "highlight",
  select_text: "selectText",
} as const;

function isPlainObject(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** Python's `repr()` of a string (or None), for log lines. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return `'${value}'`;
  return String(value);
}

/**
 * Encode a value as Python's `json.dumps(value, default=str)` does: `", "` and
 * `": "` separators, non-ASCII characters escaped, and anything that is not
 * JSON encoded as its string form.
 */
function pyJsonDumps(value: unknown): string {
  const encodeString = (s: string): string =>
    JSON.stringify(s).replace(
      /[\u0080-￿]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Number.POSITIVE_INFINITY) return "Infinity";
    if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
    return String(value);
  }
  if (typeof value === "string") return encodeString(value);
  if (Array.isArray(value)) return `[${value.map((v) => pyJsonDumps(v)).join(", ")}]`;
  if (isPlainObject(value) && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value).map(([k, v]) => `${encodeString(k)}: ${pyJsonDumps(v)}`);
    return `{${entries.join(", ")}}`;
  }
  return encodeString(String(value));
}

/**
 * Raised by `UIWorker.act` for an action that is not one of the five
 * (upstream: `ValueError`).
 */
export class UnknownScreenActionError extends Error {
  override name = "UnknownScreenActionError";
}

/** A pending job answer (upstream: an `asyncio.Future`). */
class _PendingAnswer {
  readonly #event = new Event();
  #result: { response: Dict | null; status: JobStatus } | null = null;

  done(): boolean {
    return this.#event.isSet();
  }

  setResult(result: { response: Dict | null; status: JobStatus }): void {
    if (this.done()) {
      throw new Error("result is already set");
    }
    this.#result = result;
    this.#event.set();
  }

  async wait(): Promise<{ response: Dict | null; status: JobStatus }> {
    await this.#event.wait();
    return this.#result as { response: Dict | null; status: JobStatus };
  }
}

export interface UIWorkerOptions {
  /** Unique name for this worker. */
  name: string;
  /** The LLM service. */
  llm: LLMService;
  /**
   * Optional pre-built `LLMContext`. Seeded messages are part of the mutable
   * history and are cleared on each `keepHistory: false` reset; put durable
   * instructions in the LLM's `systemInstruction` instead.
   */
  context?: LLMContext | null;
  /**
   * Answers the small questions about the screen (`shouldRespond`,
   * `whichElement`). Without one, the `llm` answers them through an
   * `LLMClassifier`, which costs an LLM call per question; a `JevClassifier`
   * answers in about a tenth of a second with a calibrated probability.
   */
  classifier?: BaseClassifier | null;
  /**
   * Optional assistant-aggregator parameters, e.g. to enable context
   * summarization for `keepHistory: true` workers.
   */
  assistantParams?: LLMAssistantAggregatorParams | null;
  /**
   * When true (the default), append each UI event to the context as a
   * `<ui_event>` developer message. Override `renderUiEvent` to change the
   * content, or set false to disable.
   */
  injectEvents?: boolean;
  /**
   * When true (the default), append the latest `<ui_state>` snapshot to the
   * context before every inference (via the LLM's `on_before_process_frame`
   * hook). Set false to inject manually with `injectUiState()`.
   */
  autoInjectUiState?: boolean;
  /**
   * When false (the default), the context is cleared at the start of every
   * job, so each turn sees only the current `<ui_state>` and query -- best for
   * the stateless-delegate role. When true, history accumulates across jobs
   * so the LLM can resolve multi-turn references ("the next one", "the Pro
   * version"), at the cost of more tokens and possible confusion from stale
   * `<ui_state>` blocks. Use context summarization to prune the history when
   * it gets too large.
   */
  keepHistory?: boolean;
  /**
   * Wire-format guide appended to the LLM's `systemInstruction` so it can
   * parse the `<ui_state>` / `<ui_event>` messages. Defaults to
   * `UI_STATE_PROMPT_GUIDE`; pass a string to override or null to disable.
   * Living in `systemInstruction`, it survives context resets.
   */
  promptGuide?: string | null;
}

/**
 * LLM worker that reads and drives a client GUI over the RTVI UI channel.
 *
 * A `UIWorker` connects an LLM to whatever the user is looking at: it sees the
 * screen as accessibility snapshots, reacts to the user's UI events, and acts
 * on the page by sending commands to the client. It is the delegate side of a
 * voice/UI split -- a voice layer (the main pipeline's LLM, or a separate
 * `LLMWorker`) handles speech and hands screen-relevant work to this worker.
 *
 * Capabilities:
 *
 * - See the screen. The latest accessibility snapshot is rendered as
 *   `<ui_state>` and auto-injected into the LLM context before each
 *   inference. Code reads it through `snapshot` and the user's `selection`.
 * - React to UI events, dispatched to `uiEvent(name)` handlers.
 * - Drive the UI with `sendCommand` and the `scrollTo` / `highlight` /
 *   `selectText` / `click` / `setInputValue` helpers.
 * - Decide small things with a classifier, not an LLM turn: whether a UI
 *   event deserves a comment (`shouldRespond`), which element on screen the
 *   user means (`whichElement`), whether something is true of the screen
 *   (`checkScreen`), which elements match a description (`selectElements`),
 *   and `act` on an element named in words.
 * - Answer a voice LLM's questions about the screen through the `screen`
 *   job: find an element, check whether something is true, select the
 *   elements matching a description, list what is on screen, read the user's
 *   selection, or click, scroll to, highlight, select or fill an element.
 *   Every answer is short data and never the page; `screenTools` gives the
 *   voice LLM the tool that sends it.
 * - Answer as a delegate. The built-in single-flight `respond` job runs one
 *   screen-grounded LLM turn and answers with the reply the LLM writes. A
 *   `tool` that calls `respondToJob` answers instead when it needs to decide
 *   how the answer reaches the user.
 * - Surface long work. Every job group this worker dispatches is reported to
 *   the client as it goes: a card when the group starts, a line per worker's
 *   progress and completion, and the close when the group completes, whether
 *   normally, by cancellation or by timeout. The client can cancel a group
 *   dispatched as cancellable.
 *
 * `PipelineWorker` connects a UIWorker to the client automatically when RTVI
 * is enabled -- no extra wiring. A working worker needs only an LLM; subclass
 * it to react to UI events or add jobs and tools, and override `renderQuery`
 * to read a non-default job payload.
 *
 * @example
 * class MyUIWorker extends UIWorker {
 *   async onNav(message: BusUIEventMessage) {
 *     const view = (message.payload as Record<string, unknown>).view;
 *     ...
 *   }
 *   static {
 *     uiEvent("nav_click")(this.prototype.onNav);
 *   }
 * }
 *
 * const worker = new MyUIWorker({ name: "ui", llm: new OpenAILLMService({ apiKey: "..." }) });
 *
 * Note: with client `trackViewport` on (the default), off-screen nodes carry
 * `[offscreen]` in `<ui_state>`; `scrollTo` before acting on them.
 */
export class UIWorker extends LLMContextWorker {
  protected _classifier: BaseClassifier;
  protected _injectEvents: boolean;
  protected _autoInjectUiState: boolean;
  protected _keepHistory: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: handlers take handler-specific arguments.
  protected _uiEventHandlers: Map<string, (...args: any[]) => any>;
  // Latest accessibility snapshot received from the client. Updated in
  // `onBusMessage` when a `__ui_snapshot` event arrives. Rendered into LLM
  // context via `injectUiState`.
  protected _latestSnapshot: Dict | null = null;
  // Job currently being processed by this worker. Set in `_runLlmTurn`,
  // cleared when the job completes. Lets `tool` methods close out the job
  // without having to thread the job id through every call.
  protected _currentJob: BusJobRequestMessage | null = null;
  // Resolved by `respondToJob` to hand the result back to the in-flight
  // `_runLlmTurn` handler, which then sends the job response.
  protected _pending: _PendingAnswer | null = null;

  /** Initialize the UIWorker. */
  constructor(options: UIWorkerOptions) {
    super({
      name: options.name,
      llm: options.llm,
      active: true,
      deferToolFrames: true,
      context: options.context ?? null,
      assistantParams: options.assistantParams ?? null,
    });
    // Auto-append the UI wire-format guide to the LLM's system instruction so
    // the author doesn't have to concatenate it manually and it survives the
    // per-job context reset. Pass a string to `promptGuide` to override the
    // text, or null to disable.
    const promptGuide =
      options.promptGuide === undefined ? UI_STATE_PROMPT_GUIDE : options.promptGuide;
    if (promptGuide) {
      this.llm.appendSystemInstruction(promptGuide);
    }
    this._classifier = options.classifier || new LLMClassifier({ llm: options.llm });
    this._injectEvents = options.injectEvents ?? true;
    this._autoInjectUiState = options.autoInjectUiState ?? true;
    this._keepHistory = options.keepHistory ?? false;
    this._uiEventHandlers = _collectUiEventHandlers(this);

    // Auto-inject the current `<ui_state>` snapshot into the context just
    // before each inference. Driven by the LLM's `on_before_process_frame` so
    // it fires whenever the worker runs its LLM (e.g. a `respond` job),
    // appending the snapshot to the same context the request is built from.
    // The snapshot is a normal, persistent developer message; growth is
    // managed by `keepHistory` + context summarization.
    this.llm.addEventHandler("on_before_process_frame", async (_llm: unknown, frame: Frame) => {
      if (!(this._autoInjectUiState && frame instanceof LLMContextFrame)) {
        return;
      }
      // Only inject on a user-turn-initiating inference, not the follow-up
      // inference the LLM runs after a tool result (which would stack a
      // duplicate `<ui_state>` within the same turn).
      if (!_isUserTurn(frame.context)) {
        return;
      }
      const content = this.renderUiState();
      if (content) {
        frame.context.addMessage({ role: "developer", content });
      }
    });

    // The reply the LLM writes answers the in-flight job, unless a tool is
    // answering it: a reply that comes with tool calls is a preamble.
    this.assistantAggregator.addEventHandler(
      "on_assistant_turn_stopped",
      async (aggregator: LLMAssistantAggregator, message: AssistantTurnStoppedMessage) => {
        if (message.interrupted || !message.content) {
          return;
        }
        if (aggregator.hasFunctionCallsInProgress) {
          return;
        }
        await this.respondToJob(message.content);
      },
    );
  }

  /** The classifier this worker asks the small questions about the screen. */
  get classifier(): BaseClassifier {
    return this._classifier;
  }

  /** The latest accessibility snapshot of the page, or null before the first. */
  get snapshot(): Dict | null {
    return this._latestSnapshot;
  }

  /** The text the user has selected on the page, or null when nothing is. */
  get selection(): UISelection | null {
    const selection = (this._latestSnapshot ?? {}).selection;
    if (!isPlainObject(selection)) {
      return null;
    }
    const ref = selection.ref;
    const text = selection.text;
    if (typeof ref !== "string" || !ref || typeof text !== "string" || !text.trim()) {
      return null;
    }
    return new UISelection({ ref, text: text.trim() });
  }

  /**
   * Set the classifier up with this worker's task manager, then activate as
   * usual.
   *
   * @param args Optional activation arguments.
   */
  override async onActivated(args: Dict | null): Promise<void> {
    await this._classifier.setup(this.taskManager);
    await super.onActivated(args);
  }

  /** Clean up the classifier along with the worker. */
  override async cleanup(): Promise<void> {
    await this._classifier.cleanup();
    await super.cleanup();
  }

  /**
   * Send a named UI command to the client.
   *
   * Publishes a `BusUICommandMessage`; when RTVI is enabled, `PipelineWorker`
   * translates it into an `RTVIUICommandFrame` on the pipeline. Client-side
   * handlers subscribed to `RTVIEvent.UICommand` (or React's
   * `useUICommandHandler`) dispatch on the command name.
   *
   * @param name App-defined command name (e.g. `"toast"`, `"navigate"`, or any
   *   app-specific name).
   * @param payload One of:
   *   - An RTVI `BaseModel` instance (including the built-in command models
   *     in `processors/frameworks/rtvi/models`). Converted to a plain object
   *     with `modelDump()`.
   *   - A plain object, forwarded as-is.
   *   - null, forwarded as an empty object.
   */
  async sendCommand(name: string, payload: unknown = null): Promise<void> {
    let serialized: unknown;
    if (payload === null || payload === undefined) {
      serialized = {};
    } else if (payload instanceof BaseModel) {
      serialized = payload.modelDump();
    } else {
      serialized = payload;
    }

    await this.sendBusMessage(
      new BusUICommandMessage({
        source: this.name,
        target: null,
        commandName: name,
        payload: serialized,
      }),
    );
  }

  /**
   * Send a `scroll_to` UI command to bring an element into view.
   *
   * Convenience wrapper around `sendCommand("scroll_to", new ScrollTo({ ref }))`.
   * These `scrollTo` / `highlight` / `selectText` / `click` / `setInputValue`
   * helpers are plain methods, not LLM tools: compose them inside a `job`
   * handler or a custom `tool` body.
   *
   * @param ref Snapshot ref (e.g. `"e42"`) from the latest `<ui_state>`.
   */
  async scrollTo(ref: string): Promise<void> {
    await this.sendCommand("scroll_to", new ScrollTo({ ref }));
  }

  /**
   * Send a `highlight` UI command to briefly flash an element.
   *
   * @param ref Snapshot ref (e.g. `"e42"`) from the latest `<ui_state>`.
   */
  async highlight(ref: string): Promise<void> {
    await this.sendCommand("highlight", new Highlight({ ref }));
  }

  /**
   * Send a `select_text` UI command to select an element's text.
   *
   * Selects the whole element by default, or the `startOffset`..`endOffset`
   * character sub-range (over the element's concatenated `textContent`) when
   * both are given. Used for deixis -- pointing at content via the page's
   * text selection.
   *
   * @param ref Snapshot ref (e.g. `"e42"`) from the latest `<ui_state>`.
   * @param options.startOffset Optional start character offset of the selection.
   * @param options.endOffset Optional end character offset (exclusive).
   */
  async selectText(
    ref: string,
    options: { startOffset?: number | null; endOffset?: number | null } = {},
  ): Promise<void> {
    await this.sendCommand(
      "select_text",
      new SelectText({
        ref,
        startOffset: options.startOffset ?? null,
        endOffset: options.endOffset ?? null,
      }),
    );
  }

  /**
   * Send a `click` UI command (checkboxes, radios, submit buttons).
   *
   * The standard client handler no-ops on `disabled` targets, so the worker
   * can't bypass affordances meant to be user-controlled.
   *
   * @param ref Snapshot ref (e.g. `"e42"`) from the latest `<ui_state>`.
   */
  async click(ref: string): Promise<void> {
    await this.sendCommand("click", new Click({ ref }));
  }

  /**
   * Send a `set_input_value` UI command to fill a text input/textarea.
   *
   * @param ref Snapshot ref (e.g. `"e42"`) of the input or textarea.
   * @param value Text to write into the field.
   * @param options.replace When true (the default), overwrite the field; when
   *   false, append (e.g. to continue a long answer in a textarea).
   */
  async setInputValue(
    ref: string,
    value: string,
    options: { replace?: boolean } = {},
  ): Promise<void> {
    await this.sendCommand(
      "set_input_value",
      new SetInputValue({ ref, value, replace: options.replace ?? true }),
    );
  }

  /**
   * Ask the classifier whether a UI event calls for the assistant to speak.
   *
   * Most clicks and edits need no comment, and a handler that reacts to
   * events has to tell the few that do apart without an LLM turn. The
   * question carries the event and the latest `<ui_state>` snapshot.
   *
   * @param message The UI event.
   * @param criteria What is being checked for, as a yes or no question.
   * @returns Whether the assistant should respond to the event.
   * @throws ClassifierError If the classifier could not answer.
   */
  async shouldRespond(
    message: BusUIEventMessage,
    criteria = "the assistant should say something about what the user just did",
  ): Promise<boolean> {
    const state: Dict = {
      event: { name: message.eventName, payload: message.payload },
    };
    const screen = this.renderUiState();
    if (screen) {
      state.screen = screen;
    }
    const question = new YesNoQuestion({
      instructions: criteria,
      yes: "the event changes what the user is doing or asks for the assistant's attention",
      no: "a routine click, scroll, hover or edit that needs no comment",
    });
    const result = (await this._classifier.yesNo(state, { respond: question }))
      .respond as YesNoResult;
    logger.debug(
      `${this.name}: respond to '${message.eventName}'? ${result.probability.toFixed(2)}`,
    );
    return result.isYes;
  }

  /**
   * Ask the classifier which element on screen the user means.
   *
   * The candidates are the snapshot's named elements, described by their role
   * and name. The user's words and the screen are the state.
   *
   * @param description What the user said, such as "the blue button".
   * @param threshold The probability below which no element is returned.
   * @returns The element's snapshot ref, or null when there is no snapshot,
   *   no named element, or no confident answer.
   * @throws ClassifierError If the classifier could not answer.
   */
  async whichElement(
    description: string,
    threshold: number = ELEMENT_THRESHOLD,
  ): Promise<string | null> {
    const found = await this._find(description);
    if (found.confidence < threshold) {
      return null;
    }
    return found.ref;
  }

  /**
   * Ask the classifier whether something is true of the screen.
   *
   * @param criteria What is being checked for, as a yes or no question, such
   *   as "is anything on the list still unchecked?".
   * @returns How likely the answer is yes.
   * @throws ClassifierError If the classifier could not answer.
   */
  async checkScreen(criteria: string): Promise<YesNoResult> {
    const question = new YesNoQuestion({ instructions: criteria });
    const state = { screen: this.renderUiState() };
    const result = (await this._classifier.yesNo(state, { check: question })).check as YesNoResult;
    logger.debug(`${this.name}: '${criteria}'? ${result.probability.toFixed(2)}`);
    return result;
  }

  /**
   * Ask the classifier which named elements on screen match a description.
   *
   * One yes or no question per element, all in one call.
   *
   * @param criteria What the elements should be, such as "dairy products".
   * @returns The matching elements, each as `ref`, `label` and `probability`,
   *   most likely first. Empty when nothing on screen matches or there is no
   *   snapshot.
   * @throws ClassifierError If the classifier could not answer.
   */
  async selectElements(
    criteria: string,
  ): Promise<{ ref: string; label: string; probability: number }[]> {
    const elements = this._namedElements();
    if (elements.length === 0) {
      return [];
    }
    const questions: Record<string, YesNoQuestion> = {};
    for (const e of elements) {
      questions[e.ref] = new YesNoQuestion({
        instructions: `${criteria}: does ${e.role} "${e.name}" match?`,
      });
    }
    const state = { criteria, screen: this.renderUiState() };
    const results = await this._classifier.yesNo(state, questions);
    const matches = elements
      .filter((e) => (results[e.ref] as YesNoResult).isYes)
      .map((e) => ({
        ref: e.ref,
        label: e.name,
        probability: (results[e.ref] as YesNoResult).probability,
      }));
    // Stable sort, highest probability first (Python's sort(reverse=True)).
    matches.sort((a, b) => b.probability - a.probability);
    logger.debug(
      `${this.name}: '${criteria}' -> [${matches.map((m) => pyRepr(m.label)).join(", ")}]`,
    );
    return matches;
  }

  /**
   * Find the element the description means and act on it.
   *
   * @param action One of `click`, `scroll_to`, `highlight`, `select_text` or
   *   `set_input_value`.
   * @param description The element in words, such as "the checkout button".
   * @param options.value The text to write, for `set_input_value`.
   * @returns The ref of the element acted on, or null when no element matched
   *   with enough confidence.
   * @throws UnknownScreenActionError If `action` is not one of the five.
   * @throws ClassifierError If the classifier could not answer.
   */
  async act(
    action: string,
    description: string,
    options: { value?: string | null } = {},
  ): Promise<string | null> {
    if (!ACTIONS.has(action)) {
      const sorted = [...ACTIONS].sort().map((a) => pyRepr(a));
      throw new UnknownScreenActionError(
        `unknown screen action ${pyRepr(action)}, not one of [${sorted.join(", ")}]`,
      );
    }
    const ref = await this.whichElement(description);
    if (!ref) {
      return null;
    }
    if (action === "set_input_value") {
      await this.setInputValue(ref, options.value || "");
    } else {
      const method = ACTION_METHODS[action as keyof typeof ACTION_METHODS];
      await this[method](ref);
    }
    return ref;
  }

  /**
   * The named elements on screen, without their refs.
   *
   * @param role Only elements of this role, such as `checkbox`; all when null.
   * @returns One entry per element: `role`, `name`, its `state` tags and, for
   *   an input, its `value`.
   */
  listElements(
    role: string | null = null,
  ): { role: string; name: string; state: string[]; value: string | null }[] {
    return this._namedElements()
      .filter((e) => role === null || e.role === role)
      .map((e) => ({ role: e.role, name: e.name, state: e.state, value: e.value }));
  }

  /** Dispatch UI events alongside base lifecycle handling. */
  override async onBusMessage(message: BusMessage): Promise<void> {
    await super.onBusMessage(message);

    if (!(message instanceof BusUIEventMessage)) {
      return;
    }
    if (message.target && message.target !== this.name) {
      return;
    }

    // Reserved snapshot event: store and return without dispatch or
    // `<ui_event>` injection. Apps render via `injectUiState`.
    if (message.eventName === UI_SNAPSHOT_EVENT_NAME) {
      if (isPlainObject(message.payload)) {
        this._latestSnapshot = message.payload;
      }
      return;
    }

    // Reserved cancel event: a cancel request, never an app event.
    if (message.eventName === UI_CANCEL_JOB_GROUP_EVENT_NAME) {
      await this._handleCancelJobEvent(message);
      return;
    }

    await this._handleUiEvent(message);
  }

  /**
   * The job this worker is currently processing, or null when idle.
   *
   * Set when a respond turn starts and cleared when the job completes. Lets
   * `tool` methods inspect the in-flight job without threading the message
   * through every call.
   *
   * @returns The in-flight `BusJobRequestMessage`, or null when idle.
   */
  get currentJob(): BusJobRequestMessage | null {
    return this._currentJob;
  }

  protected async _respondJob(message: BusJobRequestMessage): Promise<void> {
    await this._runLlmTurn(message);
  }

  /**
   * Answer a question about the screen, or act on it, for a voice LLM.
   *
   * The payload names the `action`, its `target` and, for a fill, the
   * `value`. Every answer is short data and never the page.
   */
  protected async _screenJob(message: BusJobRequestMessage): Promise<void> {
    const payload = message.payload ?? {};
    const action = this._text(message, "action");
    const target = this._text(message, "target");
    const value = payload.value;
    let answer: Dict;
    try {
      answer = await this._screen(action, target, value ? String(value) : null);
    } catch (e) {
      rethrowIfCancelled(e);
      if (!(e instanceof ClassifierError) && !(e instanceof UnknownScreenActionError)) throw e;
      logger.warning(`${this.name}: screen ${pyRepr(action)} failed: ${e.message}`);
      await this.sendJobResponse(message.jobId, { error: e.message }, { status: JobStatus.ERROR });
      return;
    }
    await this.sendJobResponse(message.jobId, answer);
  }

  static {
    job({ name: "respond", sequential: true })(UIWorker.prototype._respondJob);
    job({ name: "screen" })(UIWorker.prototype._screenJob);
  }

  /**
   * Extract the user's query text from a job request.
   *
   * Override to read a different payload shape. The returned string is
   * appended to the LLM context as a user message before the LLM runs. The
   * default reads `payload["query"]`.
   *
   * @param message The inbound job request.
   * @returns The query text to feed into the LLM.
   */
  renderQuery(message: BusJobRequestMessage): string {
    const payload = message.payload ?? {};
    return ("query" in payload ? payload.query : "") as string;
  }

  /**
   * Run one LLM turn for a job and respond when the turn answers it.
   *
   * Body of the built-in `respond` job. Records the in-flight job, clears the
   * context when `keepHistory` is false, appends the rendered query, and runs
   * the LLM (the current `<ui_state>` is injected by the
   * `on_before_process_frame` hook). Then blocks until the LLM's reply ends
   * the turn or a `tool` calls `respondToJob`, which chooses how the answer
   * is delivered, and sends the job response.
   *
   * Spanning the full round-trip is what makes the job single-flight
   * (`job({ ..., sequential: true })`).
   *
   * @param message The inbound job request.
   */
  protected async _runLlmTurn(message: BusJobRequestMessage): Promise<void> {
    this._currentJob = message;
    const pending = new _PendingAnswer();
    this._pending = pending;
    try {
      if (!this._keepHistory) {
        await this._resetContext();
      }
      // The query goes in as a "user" message, not "developer": it's the
      // request to act on, whereas the SDK-injected <ui_state> / <ui_event>
      // messages are the "developer" (programmatic context) content. The
      // "user" role also marks the turn boundary that gates <ui_state>
      // injection -- see _isUserTurn() and the on_before_process_frame hook
      // in the constructor (a non-user tail would skip the snapshot).
      await this.queueFrame(
        new LLMMessagesAppendFrame({
          messages: [{ role: "user", content: this.renderQuery(message) }],
          runLlm: true,
        }),
      );
      const result = await pending.wait();
      await this.sendJobResponse(message.jobId, result.response, { status: result.status });
    } finally {
      this._currentJob = null;
      this._pending = null;
    }
  }

  /**
   * Clear the LLM conversation history.
   *
   * Replaces all messages in the running context with an empty list via
   * `LLMMessagesUpdateFrame`. The system prompt (`systemInstruction`) is
   * unaffected, but messages seeded via `context` live in the same mutable
   * list and ARE cleared. `keepHistory: false` workers reset automatically
   * per job; `keepHistory: true` workers call this to deliberately start
   * over.
   */
  protected async _resetContext(): Promise<void> {
    await this.queueFrame(new LLMMessagesUpdateFrame({ messages: [], runLlm: false }));
  }

  /**
   * Complete the in-flight job with the worker's answer.
   *
   * The reply the LLM writes completes the job on its own; call this from a
   * `tool` to answer with something else. The job responds with
   * `{"answer": answer}` for the requester's voice LLM to phrase, and a falsy
   * `answer` completes the turn silently. No-op when no job is in flight or
   * it was already answered.
   *
   * @param answer The worker's answer, handed to the requester's voice LLM to
   *   phrase.
   * @param options.status Completion status. Defaults to `JobStatus.COMPLETED`.
   */
  async respondToJob(
    answer: string | null = null,
    options: { status?: JobStatus } = {},
  ): Promise<void> {
    const status = options.status ?? JobStatus.COMPLETED;
    const pending = this._pending;
    if (pending === null || pending.done() || this._currentJob === null) {
      return;
    }
    const response: Dict | null = answer ? { answer } : null;
    pending.setResult({ response, status });
  }

  /**
   * Dispatch a job group and announce it to the client.
   *
   * @param workerNames Names of the workers to send the job to.
   * @param options Everything `BaseWorker.createJobGroupAndRequestJob` takes,
   *   forwarded unchanged.
   * @returns The created `JobGroup`.
   */
  override async createJobGroupAndRequestJob(
    workerNames: string[],
    options: JobGroupOptions = {},
  ): Promise<JobGroup> {
    const group = await super.createJobGroupAndRequestJob(workerNames, options);
    await this.sendBusMessage(
      new BusUIJobGroupStartedMessage({
        source: this.name,
        target: null,
        jobId: group.jobId,
        workers: [...group.workerNames],
        label: group.label,
        cancellable: group.cancellable,
        at: Math.trunc(time() * 1000),
      }),
    );
    return group;
  }

  /**
   * Cancel a running job group and complete its client card.
   *
   * @param jobId The job identifier to cancel.
   * @param options.reason Optional human-readable reason for cancellation.
   */
  override async cancelJobGroup(
    jobId: string,
    options: { reason?: string | null } = {},
  ): Promise<void> {
    // Capture the group before `super` tears it down: the client's card is
    // completed from it below.
    const group = this._jobGroups.get(jobId);
    await super.cancelJobGroup(jobId, { reason: options.reason ?? null });
    if (!group) {
      return;
    }
    // The workers' own CANCELLED responses arrive after the group is gone,
    // so synthesize the terminal envelope for every worker the cancellation
    // actually cut short, deterministically instead of racing the round trip.
    // Workers that already finished keep the status the client saw.
    for (const workerName of group.workerNames) {
      if (group.terminated.has(workerName)) {
        continue;
      }
      await this._sendJobCompleted({
        jobId,
        workerName,
        status: JobStatus.CANCELLED,
        response: null,
      });
    }
    await this._sendGroupCompleted(jobId);
  }

  /** Forward a worker's progress update to the client. */
  override async onJobUpdate(
    message: BusJobUpdateMessage | BusJobUpdateUrgentMessage,
  ): Promise<void> {
    await super.onJobUpdate(message);
    // A group torn down by a cancellation still has messages in flight from
    // its workers; the client's card is already closed.
    if (!this._jobGroups.has(message.jobId)) {
      return;
    }
    await this.sendBusMessage(
      new BusUIJobUpdateMessage({
        source: this.name,
        target: null,
        jobId: message.jobId,
        workerName: message.source,
        data: message.update,
        at: Math.trunc(time() * 1000),
      }),
    );
  }

  /**
   * Forward a worker's response to the client as its terminal envelope.
   *
   * Runs before the group is torn down, so on an error status (with
   * `cancelOnError`) the client learns which worker failed before the card
   * closes.
   */
  override async onJobResponse(
    message: BusJobResponseMessage | BusJobResponseUrgentMessage,
  ): Promise<void> {
    await super.onJobResponse(message);
    // A cancelled group is already gone, and every worker it cut short was
    // reported at cancellation; their own CANCELLED responses land here
    // afterwards and would double up.
    if (!this._jobGroups.has(message.jobId)) {
      return;
    }
    await this._sendJobCompleted({
      jobId: message.jobId,
      workerName: message.source,
      status: String(message.status),
      response: message.response,
    });
  }

  /**
   * Forward a worker's stream end as its terminal envelope.
   *
   * A worker may finish by ending its stream instead of responding; the
   * client is told it completed, with the final stream data as the response
   * payload.
   */
  override async onJobStreamEnd(message: BusJobStreamEndMessage): Promise<void> {
    await super.onJobStreamEnd(message);
    if (!this._jobGroups.has(message.jobId)) {
      return;
    }
    await this._sendJobCompleted({
      jobId: message.jobId,
      workerName: message.source,
      status: JobStatus.COMPLETED,
      response: message.data,
    });
  }

  /** Complete the client's card for a group whose workers all finished. */
  override async onJobCompleted(result: JobGroupResponse): Promise<void> {
    await super.onJobCompleted(result);
    await this._sendGroupCompleted(result.jobId);
  }

  /**
   * Render the latest accessibility snapshot as a `<ui_state>` block.
   *
   * Produces Playwright-MCP-style indented text with stable element refs.
   * Apps inject the output via `injectUiState()` when they want the LLM to
   * see what's on screen.
   *
   * When the snapshot carries a current text selection, a nested
   * `<selection ref="...">...</selection>` block is appended inside
   * `<ui_state>` so the LLM can resolve deictic references ("this
   * paragraph", "what I selected") against on-page content.
   *
   * Override to customize the rendered form.
   *
   * @returns The `<ui_state>` block, or an empty string if no snapshot has
   *   been received yet.
   */
  renderUiState(): string {
    if (!this._latestSnapshot || Object.keys(this._latestSnapshot).length === 0) {
      return "";
    }
    const root = this._latestSnapshot.root;
    if (!isPlainObject(root)) {
      return "";
    }
    const lines = ["<ui_state>"];
    _renderNode(root, { depth: 0, lines });
    const selection = this._latestSnapshot.selection;
    if (isPlainObject(selection)) {
      _renderSelection(selection, lines);
    }
    lines.push("</ui_state>");
    return lines.join("\n");
  }

  /**
   * Append the latest `<ui_state>` block to the LLM context.
   *
   * No-op when no snapshot has been received. Frame has `runLlm: false` —
   * the snapshot is context, not a user turn.
   */
  async injectUiState(): Promise<void> {
    const content = this.renderUiState();
    if (!content) {
      return;
    }
    await this.queueFrame(
      new LLMMessagesAppendFrame({
        messages: [{ role: "developer", content }],
        runLlm: false,
      }),
    );
  }

  /**
   * Render a UI event as a string for LLM context injection.
   *
   * Override to customize the injected content. The default wraps the event
   * in a single `<ui_event>` XML tag with a `name` attribute and a
   * JSON-encoded payload as inner text.
   *
   * @param message The UI event to render.
   * @returns A string to append to the LLM context as a developer message.
   */
  renderUiEvent(message: BusUIEventMessage): string {
    const payloadRepr = pyJsonDumps(message.payload);
    return `<ui_event name="${message.eventName}">${payloadRepr}</ui_event>`;
  }

  /**
   * Inject the event into LLM context, then dispatch to the handler.
   *
   * Injection runs synchronously first so the `<ui_event>` developer message
   * lands in the context before any side effects the handler triggers. The
   * matching `uiEvent` handler then runs in its own task so the bus
   * dispatcher isn't held open while the handler awaits downstream work (job
   * requests, network calls). Events with no registered handler are a no-op
   * after injection.
   */
  protected async _handleUiEvent(message: BusUIEventMessage): Promise<void> {
    if (this._injectEvents) {
      const content = this.renderUiEvent(message);
      if (content) {
        await this.queueFrame(
          new LLMMessagesAppendFrame({
            messages: [{ role: "developer", content }],
            runLlm: false,
          }),
        );
      }
    }

    const handler = this._uiEventHandlers.get(message.eventName);
    if (handler === undefined) {
      return;
    }

    // Handlers run in their own task so the bus dispatcher is never held open
    // while a handler awaits downstream work (job requests, network calls,
    // etc.). Same pattern as `job`.
    this.createTask(() => handler(message), `${this.name}::ui_event_${message.eventName}`);
  }

  /**
   * The element the description means: `ref`, `label` and `confidence`.
   *
   * The candidates are the snapshot's named elements, described by role and
   * name; `ref` and `label` are null when there are none.
   */
  protected async _find(
    description: string,
  ): Promise<{ ref: string | null; label: string | null; confidence: number }> {
    const elements = this._namedElements();
    if (elements.length === 0) {
      return { ref: null, label: null, confidence: 0.0 };
    }
    const options: Record<string, string> = {};
    for (const e of elements) {
      options[e.ref] = `${e.role} "${e.name}"`;
    }
    const state = { utterance: description, screen: this.renderUiState() };
    const question = new ChoiceQuestion({
      instructions: "the element on screen the user is referring to",
      options,
    });
    const result = (await this._classifier.choice(state, { element: question })).element;
    if (result === undefined) {
      throw new ClassifierError("the classifier returned no answer for 'element'");
    }
    logger.debug(
      `${this.name}: '${description}' -> ${result.choice} (${result.confidence.toFixed(2)})`,
    );
    const match = elements.find((e) => e.ref === result.choice);
    if (match === undefined) {
      // Python's next() on an exhausted generator raises StopIteration.
      throw new Error(`the classifier chose an unknown element: ${pyRepr(result.choice)}`);
    }
    return { ref: result.choice, label: match.name, confidence: result.confidence };
  }

  /** The snapshot's named elements, breadth first. */
  protected _namedElements(): _Element[] {
    const elements: _Element[] = [];
    const root = (this._latestSnapshot ?? {}).root;
    if (!isPlainObject(root)) {
      return elements;
    }
    const pending: Dict[] = [root];
    while (pending.length > 0) {
      const node = pending.shift() as Dict;
      const ref = node.ref;
      const name = node.name;
      if (typeof ref === "string" && ref && typeof name === "string" && name) {
        const rawState = Array.isArray(node.state) ? node.state : [];
        const state = rawState.filter((s): s is string => typeof s === "string");
        const value = node.value;
        elements.push({
          ref,
          role: String("role" in node ? node.role : "element"),
          name,
          state,
          value: typeof value === "string" ? value : null,
        });
      }
      const children = Array.isArray(node.children) ? node.children : [];
      pending.push(...children.filter((c): c is Dict => isPlainObject(c)));
    }
    return elements;
  }

  /** The string a job's payload carries under `key`, empty when missing. */
  protected _text(message: BusJobRequestMessage, key: string): string {
    const value = (message.payload ?? {})[key];
    return typeof value === "string" ? value : "";
  }

  /** The answer to one screen action, as the `screen` job returns it. */
  protected async _screen(action: string, target: string, value: string | null): Promise<Dict> {
    if (action === "find") {
      const found = await this._find(target);
      const confident = found.confidence >= ELEMENT_THRESHOLD;
      return {
        label: confident ? found.label : null,
        confidence: found.confidence,
      };
    }
    if (action === "check") {
      const result = await this.checkScreen(target);
      return { yes: result.isYes, probability: result.probability };
    }
    if (action === "select") {
      const matches = await this.selectElements(target);
      return { matches: matches.map((m) => ({ label: m.label, probability: m.probability })) };
    }
    if (action === "list") {
      return { elements: this.listElements(target || null) };
    }
    if (action === "selection") {
      const selection = this.selection;
      return { text: selection ? selection.text : null };
    }
    const command = action === "fill" ? "set_input_value" : action;
    const ref = await this.act(command, target, { value });
    const label = this._namedElements().find((e) => e.ref === ref)?.name ?? null;
    return { done: ref !== null, label };
  }

  /** Publish one worker's terminal envelope. */
  protected async _sendJobCompleted(options: {
    jobId: string;
    workerName: string;
    status: string;
    response: Dict | null;
  }): Promise<void> {
    await this.sendBusMessage(
      new BusUIJobCompletedMessage({
        source: this.name,
        target: null,
        jobId: options.jobId,
        workerName: options.workerName,
        status: options.status,
        response: options.response,
        at: Math.trunc(time() * 1000),
      }),
    );
  }

  /**
   * Publish the envelope that closes the client's card.
   *
   * Reached once per group: a group either completes with every worker
   * having finished, or is cancelled, and the two paths are exclusive.
   */
  protected async _sendGroupCompleted(jobId: string): Promise<void> {
    await this.sendBusMessage(
      new BusUIJobGroupCompletedMessage({
        source: this.name,
        target: null,
        jobId,
        at: Math.trunc(time() * 1000),
      }),
    );
  }

  /**
   * Translate the client's cancel event into a cancel request.
   *
   * Hands the request to `BaseWorker.requestCancelJobGroup`, which refuses it
   * for a group that is unknown or was dispatched as non-cancellable.
   */
  protected async _handleCancelJobEvent(message: BusUIEventMessage): Promise<void> {
    const payload = isPlainObject(message.payload) ? message.payload : {};
    const jobId = payload.job_id;
    if (typeof jobId !== "string" || !jobId) {
      logger.warning(`${this.name}: received a cancel event with no job_id; ignoring`);
      return;
    }
    let reason = payload.reason;
    if (reason !== null && reason !== undefined && typeof reason !== "string") {
      reason = null;
    }
    const cancelled = await this.requestCancelJobGroup(jobId, {
      reason: (reason as string | null | undefined) || "cancelled by user",
    });
    if (!cancelled) {
      logger.debug(
        `${this.name}: cancel event for unknown or non-cancellable group ${jobId}; ignoring`,
      );
    }
  }
}

/**
 * Whether the context's last message is the user's turn.
 *
 * Distinguishes a fresh user-turn inference (tail is the user message) from
 * the follow-up inference the LLM runs after a tool result (tail is the tool
 * result / assistant output), so the `<ui_state>` snapshot is injected once
 * per turn rather than again on each tool round.
 */
export function _isUserTurn(context: LLMContext): boolean {
  const messages = context.messages;
  if (messages.length === 0) {
    return false;
  }
  const last = messages[messages.length - 1];
  return isPlainObject(last) && !(last instanceof LLMSpecificMessage) && last.role === "user";
}

/**
 * Render one A11yNode object as Playwright-MCP-style indented text.
 *
 * Format per node:
 *
 *     - role "name" [level=N] [cols=N] [rows=N] [state1] [state2] [ref=eN]:
 *
 * Trailing `:` when the node has children. `name`, `level`, grid dims, and
 * state tags are emitted only when present on the node.
 */
export function _renderNode(node: Dict, options: { depth: number; lines: string[] }): void {
  const { depth, lines } = options;
  const role = "role" in node ? node.role : "generic";
  const name = node.name;
  const value = node.value;
  const state = node.state || [];
  const level = node.level;
  const colcount = node.colcount;
  const rowcount = node.rowcount;
  const ref = "ref" in node ? node.ref : "";
  const children = node.children || [];

  const parts: string[] = [`- ${role}`];
  if (typeof name === "string" && name) {
    parts.push(`"${name}"`);
  }
  if (typeof value === "string" && value) {
    parts.push(`= "${value}"`);
  }
  if (isInt(level)) {
    parts.push(`[level=${level}]`);
  }
  if (isInt(colcount)) {
    parts.push(`[cols=${colcount}]`);
  }
  if (isInt(rowcount)) {
    parts.push(`[rows=${rowcount}]`);
  }
  if (Array.isArray(state)) {
    for (const s of state) {
      if (typeof s === "string" && s) {
        parts.push(`[${s}]`);
      }
    }
  }
  if (typeof ref === "string" && ref) {
    parts.push(`[ref=${ref}]`);
  }

  const indent = "  ".repeat(depth);
  let line = indent + parts.join(" ");
  const hasChildren = Array.isArray(children)
    ? children.length > 0
    : isPlainObject(children)
      ? Object.keys(children).length > 0
      : Boolean(children);
  if (hasChildren) {
    line += ":";
  }
  lines.push(line);

  if (Array.isArray(children)) {
    for (const child of children) {
      if (isPlainObject(child)) {
        _renderNode(child, { depth: depth + 1, lines });
      }
    }
  }
}

/**
 * Render an `A11ySelection` object as a `<selection>` block.
 *
 * Emitted at the root of `<ui_state>` (no leading indent) so the LLM can spot
 * it without parsing the tree:
 *
 *     <selection ref="e42">
 *     the actual selected text
 *     </selection>
 *
 * No-op when the selection lacks a `ref` or `text`.
 */
export function _renderSelection(selection: Dict, lines: string[]): void {
  const ref = selection.ref;
  const text = selection.text;
  if (typeof ref !== "string" || !ref) {
    return;
  }
  if (typeof text !== "string" || !text) {
    return;
  }
  lines.push(`<selection ref="${ref}">`);
  lines.push(text);
  lines.push("</selection>");
}
