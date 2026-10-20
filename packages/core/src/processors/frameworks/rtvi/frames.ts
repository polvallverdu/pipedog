// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/frameworks/rtvi/frames.py

/** RTVI pipeline frame definitions. */

import { SystemFrame } from "../../../frames/frames.ts";
import type { UIJobGroupData } from "./models.ts";
// Imported for typing only: observer.ts imports this module, so a runtime
// import back would be circular.
import type { RTVIFunctionCallReportLevel } from "./observer.ts";

function formatValue(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export interface RTVIClientMessageFrameOptions {
  msgId: string;
  type: string;
  data?: unknown;
}

/**
 * A frame for sending messages from the client to the RTVI server.
 *
 * This frame is meant for custom messaging from the client to the server and
 * expects a server-response message.
 */
export class RTVIClientMessageFrame extends SystemFrame {
  msgId: string;
  type: string;
  data: unknown;

  constructor(options: RTVIClientMessageFrameOptions) {
    super(options);
    this.msgId = options.msgId;
    this.type = options.type;
    this.data = options.data ?? null;
  }
}

export interface RTVIServerMessageFrameOptions {
  /** The message data to send to the client. */
  data: unknown;
}

/**
 * A frame for sending server messages to the client.
 *
 * - `data`: the message data to send to the client.
 */
export class RTVIServerMessageFrame extends SystemFrame {
  data: unknown;

  constructor(options: RTVIServerMessageFrameOptions) {
    super(options);
    this.data = options.data;
  }

  override toString(): string {
    return `${this.name}(data: ${formatValue(this.data)})`;
  }
}

export interface RTVIServerResponseFrameOptions {
  clientMsg: RTVIClientMessageFrame;
  data?: unknown;
  error?: string | null;
}

/**
 * A frame for responding to a client RTVI message.
 *
 * This frame should be sent in response to an RTVIClientMessageFrame and
 * include the original RTVIClientMessageFrame to ensure the response is
 * properly attributed to the original request. To respond with an error, set
 * the `error` field to a string describing the error. This will result in the
 * client receiving an `error-response` message instead of a `server-response`
 * message.
 */
export class RTVIServerResponseFrame extends SystemFrame {
  clientMsg: RTVIClientMessageFrame;
  data: unknown;
  error: string | null;

  constructor(options: RTVIServerResponseFrameOptions) {
    super(options);
    this.clientMsg = options.clientMsg;
    this.data = options.data ?? null;
    this.error = options.error ?? null;
  }
}

export interface RTVIConfigureObserverFrameOptions {
  functionCallReportLevel?: Record<string, RTVIFunctionCallReportLevel> | null;
  vadUserSpeakingEnabled?: boolean | null;
  botLlmMarkerEnabled?: boolean | null;
}

/**
 * Dynamically reconfigure a running `RTVIObserver`.
 *
 * Lets a trusted, server-side source adjust what the observer exposes at
 * runtime without baking the setting into the agent (where it would apply to
 * every client). Only the fields that are set are applied; `null` fields
 * leave the current observer configuration unchanged.
 *
 * The eval harness pushes this (via the eval-only `EvalSerializer`) to raise
 * the function-call report level for the calls a scenario asserts on, so
 * production agents can keep the secure default.
 *
 * - `functionCallReportLevel`: per-function report-level map to apply to the
 *   observer (e.g. `{ "*": RTVIFunctionCallReportLevel.FULL }`), or `null` to
 *   leave it unchanged.
 * - `vadUserSpeakingEnabled`: whether the observer should emit raw VAD user
 *   started/stopped speaking messages, or `null` to leave it unchanged.
 * - `botLlmMarkerEnabled`: whether the observer should emit the sideband
 *   markers the bot's LLM produces, or `null` to leave it unchanged.
 */
export class RTVIConfigureObserverFrame extends SystemFrame {
  functionCallReportLevel: Record<string, RTVIFunctionCallReportLevel> | null;
  vadUserSpeakingEnabled: boolean | null;
  botLlmMarkerEnabled: boolean | null;

  constructor(options: RTVIConfigureObserverFrameOptions = {}) {
    super(options);
    this.functionCallReportLevel = options.functionCallReportLevel ?? null;
    this.vadUserSpeakingEnabled = options.vadUserSpeakingEnabled ?? null;
    this.botLlmMarkerEnabled = options.botLlmMarkerEnabled ?? null;
  }

  override toString(): string {
    return (
      `${this.name}(function_call_report_level: ${formatValue(this.functionCallReportLevel)}, ` +
      `vad_user_speaking_enabled: ${this.vadUserSpeakingEnabled}, ` +
      `bot_llm_marker_enabled: ${this.botLlmMarkerEnabled})`
    );
  }
}

export interface RTVISendTextFrameOptions {
  /** The RTVI message id, as set by the client. */
  msgId: string;
  /** The text the client sent. */
  text: string;
  /** Identifier for the user who sent it, if the transport knows. */
  userId?: string | null;
}

/**
 * Text the client sent in a `send-text` message.
 *
 * Pushed downstream by `RTVIProcessor` right after the frame that appends the
 * text to the LLM context. `RTVIObserver` acknowledges it to the client with
 * a `user-input` message.
 *
 * - `msgId`: the RTVI message id, as set by the client.
 * - `text`: the text the client sent.
 * - `userId`: identifier for the user who sent it, if the transport knows.
 */
export class RTVISendTextFrame extends SystemFrame {
  msgId: string;
  text: string;
  userId: string | null;

  constructor(options: RTVISendTextFrameOptions) {
    super(options);
    this.msgId = options.msgId;
    this.text = options.text;
    this.userId = options.userId ?? null;
  }

  override toString(): string {
    return `${this.name}(msg_id: ${this.msgId}, text: [${this.text}])`;
  }
}

export interface RTVIUICommandFrameOptions {
  /** App-defined command (e.g. "toast", "navigate", or any app-specific command). */
  command?: string;
  /** App-defined payload. */
  payload?: unknown;
}

/**
 * A frame for sending a UI command to the client.
 *
 * Pipeline-side counterpart of the `ui-command` RTVI message. The observer
 * wraps the `command` + `payload` into a `UICommandMessage` envelope before
 * pushing it to the transport, so the wire shape is:
 * `{label, type: "ui-command", data: {command, payload}}`.
 *
 * - `command`: app-defined command (e.g. `"toast"`, `"navigate"`, or any
 *   app-specific command).
 * - `payload`: app-defined payload. Command models (`Toast`, `Navigate`,
 *   `ScrollTo`, ...) should be converted to a plain object via `modelDump()`
 *   before being placed here; an arbitrary object works as well.
 */
export class RTVIUICommandFrame extends SystemFrame {
  command: string;
  payload: unknown;

  constructor(options: RTVIUICommandFrameOptions = {}) {
    super(options);
    this.command = options.command ?? "";
    this.payload = options.payload ?? null;
  }

  override toString(): string {
    return `${this.name}(command: ${this.command})`;
  }
}

export interface RTVIUIJobGroupFrameOptions {
  /** One of the four job-group lifecycle data models. */
  data?: UIJobGroupData | null;
}

/**
 * A frame for sending a UI job-group lifecycle envelope to the client.
 *
 * Pipeline-side counterpart of the `ui-job-group` RTVI message. The observer
 * wraps the `data` into a `UIJobGroupMessage` envelope before pushing it to
 * the transport, so the wire shape is:
 * `{label, type: "ui-job-group", data: <one of the four kinds>}`.
 *
 * - `data`: one of the four job-group lifecycle data models from
 *   `rtvi/models` (`UIJobGroupStartedData`, `UIJobUpdateData`,
 *   `UIJobCompletedData`, or `UIJobGroupCompletedData`). The `kind` field on
 *   each discriminates which lifecycle phase this is.
 */
export class RTVIUIJobGroupFrame extends SystemFrame {
  data: UIJobGroupData | null;

  constructor(options: RTVIUIJobGroupFrameOptions = {}) {
    super(options);
    this.data = options.data ?? null;
  }

  override toString(): string {
    const kind = this.data?.kind ?? "?";
    return `${this.name}(kind: ${kind})`;
  }
}

export interface RTVIUIEventFrameOptions {
  /** The RTVI message id, as set by the client. */
  msgId?: string;
  /** App-defined event (the `data.event` field). */
  event?: string;
  /** App-defined payload (the `data.payload` field). */
  payload?: unknown;
}

/**
 * An inbound UI event from the client.
 *
 * Pushed downstream by `RTVIProcessor` whenever a `ui-event` message arrives
 * from the client, alongside firing the `on_ui_message` event handler.
 * Mirrors the frame-and-event pattern used by `client-message`: pipeline
 * observers and processors that want to react to UI events at the pipeline
 * level can match on this frame; code that subscribes to events instead
 * (like `UIWorker`) keeps using the event handler.
 *
 * - `msgId`: the RTVI message id, as set by the client.
 * - `event`: app-defined event (the `data.event` field).
 * - `payload`: app-defined payload (the `data.payload` field).
 */
export class RTVIUIEventFrame extends SystemFrame {
  msgId: string;
  event: string;
  payload: unknown;

  constructor(options: RTVIUIEventFrameOptions = {}) {
    super(options);
    this.msgId = options.msgId ?? "";
    this.event = options.event ?? "";
    this.payload = options.payload ?? null;
  }

  override toString(): string {
    return `${this.name}(event: ${this.event})`;
  }
}

export interface RTVIUISnapshotFrameOptions {
  /** The RTVI message id, as set by the client. */
  msgId?: string;
  /** The serialized accessibility tree. */
  tree?: unknown;
}

/**
 * An inbound accessibility-snapshot from the client.
 *
 * Pushed downstream by `RTVIProcessor` whenever a `ui-snapshot` message
 * arrives, alongside firing `on_ui_message`. Carries the serialized
 * accessibility tree the client took of its DOM.
 *
 * - `msgId`: the RTVI message id, as set by the client.
 * - `tree`: the serialized accessibility tree.
 */
export class RTVIUISnapshotFrame extends SystemFrame {
  msgId: string;
  tree: unknown;

  constructor(options: RTVIUISnapshotFrameOptions = {}) {
    super(options);
    this.msgId = options.msgId ?? "";
    this.tree = options.tree ?? null;
  }

  override toString(): string {
    return `${this.name}`;
  }
}

export interface RTVIUICancelJobGroupFrameOptions {
  /** The RTVI message id, as set by the client. */
  msgId?: string;
  /** The job group id the client wants cancelled. */
  jobId?: string;
  /** Optional human-readable reason. */
  reason?: string | null;
}

/**
 * An inbound user-job-group cancellation request from the client.
 *
 * Pushed downstream by `RTVIProcessor` whenever a `ui-cancel-job-group`
 * message arrives, alongside firing `on_ui_message`. The server-side
 * framework should look up the matching job group and cancel it (subject to
 * whatever cancellable policy the group was registered with).
 *
 * - `msgId`: the RTVI message id, as set by the client.
 * - `jobId`: the job group id the client wants cancelled.
 * - `reason`: optional human-readable reason.
 */
export class RTVIUICancelJobGroupFrame extends SystemFrame {
  msgId: string;
  jobId: string;
  reason: string | null;

  constructor(options: RTVIUICancelJobGroupFrameOptions = {}) {
    super(options);
    this.msgId = options.msgId ?? "";
    this.jobId = options.jobId ?? "";
    this.reason = options.reason ?? null;
  }

  override toString(): string {
    return `${this.name}(job_id: ${this.jobId})`;
  }
}
