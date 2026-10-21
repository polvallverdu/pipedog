// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/aws/nova_sonic/session_continuation.py

/**
 * Session continuation helper for AWS Nova Sonic.
 *
 * Nova Sonic sessions have an AWS-imposed time limit (~8 minutes). This module
 * provides transparent session continuation that rotates sessions in the background
 * before the limit is reached, preserving conversation context with no
 * user-perceptible interruption.
 *
 * Implementation follows the AWS reference architecture:
 * https://github.com/aws-samples/amazon-nova-samples/tree/main/speech-to-speech/amazon-nova-2-sonic/repeatable-patterns/session-continuation/console-python
 *
 * Porting notes:
 * - The sender protocol's streams are `BidirectionalStream`s
 *   (`bidirectional_stream.ts`): `stream.input_stream.close()` is
 *   `closeInput()`.
 * - `create_task` / `cancel_task` callables take a function, as
 *   `BaseObject.createTask` does.
 */

import {
  CancelledError,
  rethrowIfCancelled,
  shield,
  sleep,
  type Task,
  time,
  waitFor,
} from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import type { BidirectionalStream } from "../bidirectional_stream.ts";

const _MAX_HISTORY_MESSAGE_BYTES = 50 * 1024; // 50 KB per message
const _MAX_HISTORY_TOTAL_BYTES = 200 * 1024; // 200 KB total history

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The audio fields the helper reads (see `AudioConfig` in `llm.ts`). */
export interface NovaSonicAudioConfigLike {
  inputSampleRate: number;
  inputSampleSize: number;
  inputChannelCount: number;
}

/**
 * Protocol for sending events to a Nova Sonic session stream.
 *
 * The LLM service implements this to expose the Nova Sonic wire protocol to
 * the session continuation helper without coupling the helper to service
 * internals (audio config, voice, model, etc.). Each method targets an
 * explicit `stream` / `promptName` so the same implementation can write
 * to either the current session or the next (pre-created) session.
 */
export interface NovaSonicSessionSender<TClient = unknown> {
  /** Open a bidirectional stream on the given client. */
  openStream(client: TClient): Promise<BidirectionalStream>;
  /** Send a raw event JSON string to the given stream. */
  sendEvent(eventJson: string, stream: BidirectionalStream | null): Promise<void>;
  /** Build the `sessionStart` event JSON string. */
  buildSessionStartJson(): string;
  /** Send a `promptStart` event to the given stream. */
  sendPromptStart(tools: unknown[], promptName: string, stream: BidirectionalStream): Promise<void>;
  /** Send a text content block (contentStart/textInput/contentEnd) to the given stream. */
  sendText(
    text: string,
    role: string,
    promptName: string,
    stream: BidirectionalStream,
    interactive: boolean,
  ): Promise<void>;
  /** Send an audio input `contentStart` to the given stream. */
  sendAudioInputStart(
    promptName: string,
    contentName: string,
    stream: BidirectionalStream,
  ): Promise<void>;
  /** Send an `audioInput` event to the given stream. */
  sendAudio(
    audio: Uint8Array,
    promptName: string,
    contentName: string,
    stream: BidirectionalStream,
  ): Promise<void>;
  /** Create a new Bedrock runtime client. */
  createClient(): TClient;
  /** The audio configuration (`AudioConfig` instance). */
  readonly audioConfig: NovaSonicAudioConfigLike;
  /** Return `[systemInstruction, tools]` for the next session setup. */
  getSetupParams(): Promise<[string | null, unknown[]]>;
}

export interface SessionContinuationParamsOptions {
  enabled?: boolean;
  transitionThresholdSeconds?: number;
  audioBufferDurationSeconds?: number;
  audioStartTimeoutSeconds?: number;
}

/**
 * Configuration for automatic session continuation.
 *
 * Nova Sonic sessions have an AWS-imposed time limit (~8 minutes). When enabled,
 * session continuation proactively creates a new session in the background before
 * the limit is reached, buffers user audio during the transition, and seamlessly
 * hands off — preserving conversation context with no user-perceptible gap.
 *
 * - `enabled`: Whether automatic session continuation is enabled.
 * - `transitionThresholdSeconds`: How many seconds into a session to begin
 *   monitoring for a transition opportunity. The transition will occur
 *   when the assistant next starts speaking after this threshold.
 * - `audioBufferDurationSeconds`: Duration of the rolling audio buffer
 *   (in seconds) that captures user audio during the transition window.
 *   This audio is replayed into the new session so no user input is lost.
 * - `audioStartTimeoutSeconds`: Maximum time to wait for the assistant to
 *   start speaking after the threshold is reached. If no assistant audio
 *   arrives within this window, the transition is forced. Set to 0 to
 *   disable the timeout (wait indefinitely).
 */
export class SessionContinuationParams {
  enabled: boolean;
  transitionThresholdSeconds: number;
  audioBufferDurationSeconds: number;
  audioStartTimeoutSeconds: number;

  constructor(options: SessionContinuationParamsOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.transitionThresholdSeconds = options.transitionThresholdSeconds ?? 360.0;
    this.audioBufferDurationSeconds = options.audioBufferDurationSeconds ?? 3.0;
    this.audioStartTimeoutSeconds = options.audioStartTimeoutSeconds ?? 80.0;
  }
}

/** Holds pre-created resources for the next session during a transition. */
export class _NextSession<TClient = unknown> {
  client: TClient;
  stream: BidirectionalStream;
  promptName: string;
  inputAudioContentName: string;

  constructor(options: {
    client: TClient;
    stream: BidirectionalStream;
    promptName: string;
    inputAudioContentName: string;
  }) {
    this.client = options.client;
    this.stream = options.stream;
    this.promptName = options.promptName;
    this.inputAudioContentName = options.inputAudioContentName;
  }
}

export interface SessionContinuationHelperOptions<TClient = unknown> {
  /**
   * Object implementing the `NovaSonicSessionSender` protocol. The LLM
   * service provides this to expose Nova Sonic wire I/O without coupling the
   * helper to service internals. Audio configuration is read from
   * `sender.audioConfig`.
   */
  sender: NovaSonicSessionSender<TClient>;
  /** Spawns a task managed by the service's task manager. */
  createTask: (fn: () => Promise<unknown>) => Task<unknown>;
  /** Cancels a task (typically the service's `cancelTask`). */
  cancelTask: (task: Task<unknown>, timeout: number) => Promise<void>;
}

/** Truncate UTF-8 bytes, dropping a trailing partial character (`errors="ignore"`). */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = encoder.encode(text);
  if (encoded.length <= maxBytes) return text;
  return decoder.decode(encoded.subarray(0, maxBytes)).replace(/�+$/, "");
}

/**
 * Manages proactive session rotation for Nova Sonic.
 *
 * This helper encapsulates all session continuation state and logic, providing
 * a clean API for the LLM service to integrate with. It delegates stream I/O
 * back to the LLM service via callbacks.
 *
 * The LLM service hooks into this helper at key points:
 *
 * - `onAudioInput(audio)`: called for each user audio frame
 * - `onAssistantAudioStarted()`: called on AUDIO contentStart from assistant
 * - `onTextOutput(role, stage)`: called on textOutput events
 * - `onContentEnd*()`: called on contentEnd events
 * - `onCompletionEnd()`: called on completionEnd events
 * - `onUserContentStarted()`: called on USER contentStart events
 */
export class SessionContinuationHelper<TClient = unknown> {
  protected _params: SessionContinuationParams;
  protected _sender: NovaSonicSessionSender<TClient>;
  protected _createTask: (fn: () => Promise<unknown>) => Task<unknown>;
  protected _cancelTask: (task: Task<unknown>, timeout: number) => Promise<void>;

  protected _audioBuffer: Uint8Array[] = [];
  protected _audioBufferMaxBytes: number;

  // Transition state
  protected _nextSession: _NextSession<TClient> | null = null;
  protected _isBuffering = false;
  protected _waitingForAudioStart = false;
  protected _waitingForCompletion = false;
  protected _handoffInProgress = false;
  protected _audioStartWaitTime: number | null = null;
  protected _nextSessionCreatedTime: number | null = null;
  protected _monitorTask: Task<unknown> | null = null;
  protected _connectedTime: number | null = null;
  protected _wantsConnection = false;

  // Session-level text counters — always incremented, never gated.
  // Matches reference: counts live on SessionInfo from session start.
  protected _speculativeTextCount = 0;
  protected _finalTextCount = 0;
  protected _bargeInDetected = false;

  // Conversation history — tracked in real-time from FINAL text events.
  // TODO: Integrate with pipecat's LLMContext once the pipeline supports
  // synchronous context reads or a flush mechanism.
  protected _conversationHistory: { role: string; text: string }[] = [];

  /**
   * Initialize the session continuation helper.
   *
   * @param params Configuration for session continuation behavior.
   */
  constructor(
    params: SessionContinuationParams,
    options: SessionContinuationHelperOptions<TClient>,
  ) {
    this._params = params;
    this._sender = options.sender;
    this._createTask = options.createTask;
    this._cancelTask = options.cancelTask;

    // Audio buffer — sized from the sender's audio config
    const ac = options.sender.audioConfig;
    this._audioBufferMaxBytes = Math.trunc(
      params.audioBufferDurationSeconds *
        ac.inputSampleRate *
        (ac.inputSampleSize / 8) *
        ac.inputChannelCount,
    );
  }

  // --- Public API for the LLM service ---

  /** Whether user audio is currently being buffered for the transition. */
  get isBuffering(): boolean {
    return this._isBuffering;
  }

  /** The pre-created next session, if any. */
  get nextSession(): _NextSession<TClient> | null {
    return this._nextSession;
  }

  /** Whether a handoff is currently in progress. */
  get handoffInProgress(): boolean {
    return this._handoffInProgress;
  }

  /**
   * Called when the current session finishes connecting.
   *
   * Resets session-level counters. In the reference these live on
   * SessionInfo and are zero-initialized per session.
   */
  setConnected(connectedTime: number): void {
    this._connectedTime = connectedTime;
    this._wantsConnection = true;
    this._speculativeTextCount = 0;
    this._finalTextCount = 0;
    this._bargeInDetected = false;
  }

  /** Called when the current session disconnects. */
  setDisconnected(): void {
    this._wantsConnection = false;
    this._connectedTime = null;
  }

  /** Seed conversation history with initial context messages. */
  seedHistory(role: string, text: string): void {
    if (text) {
      this._conversationHistory.push({ role, text });
    }
  }

  /** Start the session duration monitor. */
  startMonitor(): void {
    if (!this._params.enabled || this._monitorTask) {
      return;
    }
    this._monitorTask = this._createTask(() => this._monitorLoop());
  }

  /** Stop the session duration monitor. */
  async stopMonitor(): Promise<void> {
    if (this._monitorTask) {
      await this._cancelTask(this._monitorTask, 1.0);
      this._monitorTask = null;
    }
  }

  /** Called for each user audio frame. Buffers audio during transition. */
  onAudioInput(audio: Uint8Array): void {
    if (this._isBuffering) {
      this._audioBuffer.push(audio);
      let total = this._audioBuffer.reduce((n, c) => n + c.length, 0);
      while (total > this._audioBufferMaxBytes && this._audioBuffer.length > 0) {
        const removed = this._audioBuffer.shift() as Uint8Array;
        total -= removed.length;
      }
    }
  }

  /**
   * Called when assistant AUDIO contentStart is detected.
   *
   * Starts buffering and creates the next session if we're past the threshold.
   * Returns true if session continuation was triggered.
   */
  async onAssistantAudioStarted(): Promise<boolean> {
    if (!this._waitingForAudioStart || this._handoffInProgress) {
      return false;
    }

    this._waitingForAudioStart = false;
    this._audioStartWaitTime = null;
    this._isBuffering = true;
    this._waitingForCompletion = true;

    logger.info(
      "Session continuation: assistant audio started, " +
        "buffering user audio and creating next session",
    );

    if (!this._nextSession) {
      try {
        await this._prepareNextSession();
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`Session continuation: failed to prepare next session: ${e}`);
        this._isBuffering = false;
        this._waitingForCompletion = false;
        return false;
      }
    }

    return true;
  }

  /**
   * Called on textOutput events. Always tracks speculative/final counts.
   *
   * Matches reference: counts are session-level, always incremented for
   * ASSISTANT text regardless of transition state. The completion check
   * (in onContentEndAssistantFinalText) gates on _waitingForCompletion.
   */
  onTextOutput(role: string, stage: string | null): void {
    if (role !== "ASSISTANT") {
      return;
    }

    if (stage === "SPECULATIVE") {
      this._speculativeTextCount += 1;
      logger.debug(`Session continuation: SPECULATIVE text #${this._speculativeTextCount}`);
    } else if (stage === "FINAL") {
      this._finalTextCount += 1;
      logger.debug(
        `Session continuation: FINAL text #${this._finalTextCount} ` +
          `(speculative=${this._speculativeTextCount})`,
      );
    }
  }

  /**
   * Called on contentEnd for ASSISTANT FINAL TEXT (non-interrupted).
   *
   * Adds text to history and checks for completion signal.
   * Returns true if handoff should be triggered.
   */
  onContentEndAssistantFinalText(text: string | null): boolean {
    if (text) {
      this._conversationHistory.push({ role: "ASSISTANT", text });
    }

    // Check completion signal after adding to history
    if (
      this._waitingForCompletion &&
      this._speculativeTextCount > 0 &&
      this._finalTextCount > 0 &&
      this._finalTextCount >= this._speculativeTextCount &&
      !this._handoffInProgress
    ) {
      logger.info(
        "Session continuation: completion signal — text pairs matched " +
          `(final=${this._finalTextCount} >= speculative=${this._speculativeTextCount})`,
      );
      this._waitingForCompletion = false;
      return true;
    }
    return false;
  }

  /**
   * Called on contentEnd for TEXT with stopReason=INTERRUPTED.
   *
   * Marks barge-in detected. If we're waiting for completion, triggers
   * handoff immediately (matches reference lines 650-654).
   * Returns true if handoff should be triggered.
   */
  onContentEndTextInterrupted(): boolean {
    this._bargeInDetected = true;
    if (this._waitingForCompletion && !this._handoffInProgress) {
      logger.info("Session continuation: completion signal — TEXT INTERRUPTED (barge-in)");
      this._waitingForCompletion = false;
      return true;
    }
    return false;
  }

  /**
   * Called on contentEnd for USER FINAL TEXT. Adds to history.
   *
   * Also handles barge-in count reconciliation: when the user speaks after
   * a barge-in, remaining FINAL texts for the interrupted response will
   * never arrive. Force final = speculative so the counts match.
   * Matches reference lines 602-609.
   */
  onContentEndUserFinalText(text: string | null): void {
    if (text) {
      this._conversationHistory.push({ role: "USER", text });
    }

    if (this._bargeInDetected && this._speculativeTextCount > this._finalTextCount) {
      logger.info(
        "Session continuation: user spoke after barge-in — " +
          `setting final=${this._speculativeTextCount} (was ${this._finalTextCount})`,
      );
      this._finalTextCount = this._speculativeTextCount;
    }
  }

  /**
   * Called on USER contentStart during transition.
   *
   * Marks barge-in during transition (matches reference lines 527-534).
   * Returns true if handoff should be triggered (forced transition, no
   * assistant response yet — matches reference lines 579-583).
   */
  onUserContentStarted(): boolean {
    if (this._waitingForCompletion && this._nextSession) {
      this._bargeInDetected = true;
    }

    if (
      this._waitingForCompletion &&
      !this._handoffInProgress &&
      this._nextSession &&
      this._finalTextCount === 0
    ) {
      logger.info(
        "Session continuation: user spoke during forced transition " +
          "(no assistant response yet) — completing handoff immediately",
      );
      this._waitingForCompletion = false;
      return true;
    }
    return false;
  }

  /**
   * Called on completionEnd. Fallback completion signal.
   *
   * Returns true if handoff should be triggered.
   */
  onCompletionEnd(): boolean {
    if (this._waitingForCompletion && !this._handoffInProgress) {
      logger.info("Session continuation: completion signal — completionEnd (fallback)");
      this._waitingForCompletion = false;
      return true;
    }
    return false;
  }

  /**
   * Execute the session handoff.
   *
   * Sends conversation history + audioInputStart + buffered audio to the next
   * session. Returns the next session for the caller to swap in and clean
   * up the old one, or null if handoff couldn't proceed.
   */
  async executeHandoff(): Promise<_NextSession<TClient> | null> {
    if (this._handoffInProgress) {
      return null;
    }
    this._handoffInProgress = true;

    try {
      const ns = this._nextSession;
      if (!ns) {
        logger.warning("Session continuation: no next session available for handoff");
        return null;
      }

      logger.info("Session continuation: executing handoff");

      // Build trimmed history: walk backwards to prioritize recent
      // messages, truncate individual messages, and cap total size.
      const prepared: { role: string; text: string }[] = [];
      let totalBytes = 0;
      for (const msg of [...this._conversationHistory].reverse()) {
        const text = truncateUtf8(msg.text, _MAX_HISTORY_MESSAGE_BYTES);
        const msgBytes = encoder.encode(text).length;
        if (totalBytes + msgBytes > _MAX_HISTORY_TOTAL_BYTES) {
          logger.debug(
            "Session continuation: dropping older history to fit " +
              `${_MAX_HISTORY_TOTAL_BYTES} byte limit ` +
              `(total_bytes=${totalBytes}, msg_bytes=${msgBytes})`,
          );
          break;
        }
        totalBytes += msgBytes;
        prepared.push({ role: msg.role, text });
      }
      prepared.reverse();

      // Ensure history starts with a USER message
      while (prepared.length > 0 && (prepared[0] as { role: string }).role !== "USER") {
        const dropped = prepared.shift() as { role: string };
        logger.debug(`Session continuation: dropping leading ${dropped.role} message from history`);
      }

      // Send conversation history
      if (prepared.length > 0) {
        logger.info(
          `Session continuation: sending ${prepared.length} history ` +
            `messages (${totalBytes} bytes) to new session`,
        );
        for (const msg of prepared) {
          logger.debug(
            `Session continuation: history [${msg.role}]: ` +
              `${msg.text.slice(0, 80)}${msg.text.length > 80 ? "..." : ""}`,
          );
          await this._sender.sendText(msg.text, msg.role, ns.promptName, ns.stream, false);
        }
      }

      // Send audioInputStart
      await this._sender.sendAudioInputStart(ns.promptName, ns.inputAudioContentName, ns.stream);

      // Send buffered audio
      const bufferChunks = [...this._audioBuffer];
      const ac = this._sender.audioConfig;
      const bytesPerSecond = ac.inputSampleRate * (ac.inputSampleSize / 8) * ac.inputChannelCount;
      const bufferDuration = bufferChunks.reduce((n, c) => n + c.length, 0) / bytesPerSecond;
      logger.info(
        `Session continuation: sending ${bufferChunks.length} buffered audio chunks ` +
          `(~${bufferDuration.toFixed(1)}s) to new session`,
      );
      for (const chunk of bufferChunks) {
        await this._sender.sendAudio(chunk, ns.promptName, ns.inputAudioContentName, ns.stream);
      }

      // Return the next session info for the caller to promote
      logger.info("Session continuation: promoting new session");
      const result = ns;
      this._nextSession = null;
      this._isBuffering = false;
      this._audioBuffer = [];

      return result;
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Session continuation: handoff error: ${e}`);
      await this.cleanupNextSession();
      return null;
    } finally {
      this._handoffInProgress = false;
      this._waitingForAudioStart = false;
      this._waitingForCompletion = false;
      this._audioStartWaitTime = null;
      this._nextSessionCreatedTime = null;
      // Note: speculative/final counts and barge_in_detected are NOT
      // reset here — they are session-level and get reset in
      // setConnected() when the new session starts.
    }
  }

  /**
   * Close the old session's resources in the background.
   *
   * Audio input to the old stream is already stopped (handoffInProgress
   * gate in _handleInputAudioFrame). Sends contentEnd (audio) →
   * promptEnd → sessionEnd → closes stream → waits for the receive task.
   */
  async closeOldSession(
    _client: TClient | null,
    stream: BidirectionalStream | null,
    receiveTask: Task<unknown> | null,
    promptName: string | null,
    inputAudioContentName: string | null = null,
  ): Promise<void> {
    try {
      if (stream && promptName) {
        try {
          if (inputAudioContentName) {
            const audioContentEndJson = pyJsonDumps({
              event: {
                contentEnd: {
                  promptName,
                  contentName: inputAudioContentName,
                },
              },
            });
            await this._sender.sendEvent(audioContentEndJson, stream);
          }

          const promptEndJson = pyJsonDumps({ event: { promptEnd: { promptName } } });
          const sessionEndJson = pyJsonDumps({ event: { sessionEnd: {} } });
          await this._sender.sendEvent(promptEndJson, stream);
          await this._sender.sendEvent(sessionEndJson, stream);
        } catch (e) {
          rethrowIfCancelled(e);
        }
      }

      if (stream) {
        try {
          await waitFor(() => stream.closeInput(), 2.0);
        } catch (e) {
          rethrowIfCancelled(e);
        }
      }

      // Wait for the receive task to exit naturally (the stream is
      // closed, so it will hit an error or the stale-stream check).
      if (receiveTask) {
        try {
          await waitFor(() => shield(receiveTask), 5.0);
        } catch (e) {
          rethrowIfCancelled(e);
        }
      }

      logger.debug("Session continuation: old session closed");
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`Session continuation: error closing old session: ${e}`);
    }
  }

  /** Clean up the pre-created next session if it exists. */
  async cleanupNextSession(): Promise<void> {
    const ns = this._nextSession;
    if (!ns) {
      return;
    }

    if (ns.stream) {
      try {
        await ns.stream.close();
      } catch (e) {
        rethrowIfCancelled(e);
      }
    }

    this._nextSession = null;
    this._isBuffering = false;
    this._audioBuffer = [];
    this._nextSessionCreatedTime = null;
  }

  // --- Internal methods ---

  /** Periodically check session age and manage next session lifecycle. */
  protected async _monitorLoop(): Promise<void> {
    try {
      while (this._wantsConnection) {
        await sleep(1);

        if (!this._connectedTime || this._handoffInProgress) {
          continue;
        }

        const sessionAge = time() - this._connectedTime;
        const threshold = this._params.transitionThresholdSeconds;

        // Threshold reached — start waiting for assistant audio
        if (
          sessionAge >= threshold &&
          !this._waitingForAudioStart &&
          !this._nextSession &&
          !this._waitingForCompletion
        ) {
          logger.info(
            `Session continuation: session age ${sessionAge.toFixed(0)}s >= ` +
              `threshold ${threshold.toFixed(0)}s, waiting for assistant audio`,
          );
          this._waitingForAudioStart = true;
          this._audioStartWaitTime = time();
        }

        // Audio start timeout — force transition
        const audioStartTimeout = this._params.audioStartTimeoutSeconds;
        if (
          this._waitingForAudioStart &&
          this._audioStartWaitTime &&
          audioStartTimeout > 0 &&
          time() - this._audioStartWaitTime > audioStartTimeout
        ) {
          logger.info(
            "Session continuation: TIMEOUT — no assistant audio after " +
              `${audioStartTimeout.toFixed(0)}s, forcing transition`,
          );
          this._waitingForAudioStart = false;
          this._audioStartWaitTime = null;
          this._isBuffering = true;
          this._waitingForCompletion = false;
          try {
            if (!this._nextSession) {
              await this._prepareNextSession();
            }
            this._createTask(() => this.executeHandoff());
          } catch (e) {
            rethrowIfCancelled(e);
            logger.error(`Session continuation: forced transition failed: ${e}`);
            this._isBuffering = false;
          }
        }

        // Dead session detection — recreate if idle too long
        const nextSessionTimeout = 30.0;
        if (
          this._nextSession &&
          this._nextSessionCreatedTime &&
          !this._handoffInProgress &&
          time() - this._nextSessionCreatedTime > nextSessionTimeout
        ) {
          logger.warning(
            "Session continuation: next session idle for " +
              `>${nextSessionTimeout.toFixed(0)}s, recreating`,
          );
          await this.cleanupNextSession();
          try {
            await this._prepareNextSession();
          } catch (e) {
            rethrowIfCancelled(e);
            logger.error(`Session continuation: failed to recreate next session: ${e}`);
          }
        }
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        return;
      }
      logger.error(`Session continuation monitor error: ${e}`);
    }
  }

  /**
   * Create a new session and send setup (sessionStart + promptStart + system instruction).
   *
   * Conversation history and audio are deferred to handoff time.
   */
  protected async _prepareNextSession(): Promise<void> {
    const promptName = crypto.randomUUID();
    const inputAudioContentName = crypto.randomUUID();

    const client = this._sender.createClient();
    const stream = await this._sender.openStream(client);

    this._nextSession = new _NextSession({
      client,
      stream,
      promptName,
      inputAudioContentName,
    });
    this._nextSessionCreatedTime = time();

    const ns = this._nextSession;

    // Send sessionStart
    await this._sender.sendEvent(this._sender.buildSessionStartJson(), ns.stream);

    // Get setup params: (systemInstruction, tools)
    const [systemInstruction, tools] = await this._sender.getSetupParams();

    // Send promptStart with tools
    await this._sender.sendPromptStart(tools, ns.promptName, ns.stream);

    // Send system instruction
    if (systemInstruction) {
      await this._sender.sendText(systemInstruction, "SYSTEM", ns.promptName, ns.stream, false);
    }

    logger.debug(
      `Session continuation: next session prepared (prompt=${promptName.slice(0, 8)}...)`,
    );
  }
}
