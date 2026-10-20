// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_turn_strategies.py

/** Turn start strategy configuration. */

import { LocalSmartTurnAnalyzerV3 } from "../audio/turn/smart_turn/local_smart_turn_v3.ts";
import {
  type BaseUserTurnStartStrategy,
  ExternalUserTurnStartStrategy,
  TranscriptionUserTurnStartStrategy,
  VADUserTurnStartStrategy,
} from "./user_start/index.ts";
import {
  type BaseUserTurnStopStrategy,
  deferred,
  type EagerMatchPolicy,
  EagerUserTurnStopStrategy,
  ExternalUserTurnStopStrategy,
  LLMTurnCompletionUserTurnStopStrategy,
  TurnAnalyzerUserTurnStopStrategy,
} from "./user_stop/index.ts";
import type { UserTurnCompletionConfig } from "./user_turn_completion_mixin.ts";

/**
 * Return the default user turn start strategies.
 *
 * Returns `[VADUserTurnStartStrategy, TranscriptionUserTurnStartStrategy]`.
 * Useful when building a custom strategy list that extends the defaults.
 *
 * @example
 * const startStrategies = [
 *   new WakePhraseUserTurnStartStrategy({ phrases: ["hey pipecat"] }),
 *   ...defaultUserTurnStartStrategies(),
 * ];
 */
export function defaultUserTurnStartStrategies(): BaseUserTurnStartStrategy[] {
  return [new VADUserTurnStartStrategy(), new TranscriptionUserTurnStartStrategy()];
}

/**
 * Return the default user turn stop strategies.
 *
 * Returns `[TurnAnalyzerUserTurnStopStrategy(LocalSmartTurnAnalyzerV3)]`.
 * Useful when building a custom strategy list that extends the defaults.
 */
export function defaultUserTurnStopStrategies(): BaseUserTurnStopStrategy[] {
  return [new TurnAnalyzerUserTurnStopStrategy({ turnAnalyzer: new LocalSmartTurnAnalyzerV3() })];
}

export interface UserTurnStrategiesOptions {
  /**
   * A list of user turn start strategies used to detect when the user starts
   * speaking.
   */
  start?: BaseUserTurnStartStrategy[] | null;
  /**
   * A list of user turn stop strategies used to decide when the user stops
   * speaking.
   */
  stop?: BaseUserTurnStopStrategy[] | null;
}

// Python dataclasses run `__post_init__` once, after every field of the most
// derived class is set. Each constructor below assigns its own fields and then
// runs `_postInit()` only when it is the most derived of these dataclasses in
// `new.target`'s chain, so the override chain behaves like upstream's (a user
// subclass that adds no dataclass fields gets it from its nearest parent).
const postInitClasses = new Set<Function>();

function runsPostInit(target: Function, cls: Function): boolean {
  let proto: Function | null = target;
  while (proto && !postInitClasses.has(proto)) {
    proto = Object.getPrototypeOf(proto) as Function | null;
  }
  return proto === cls;
}

/**
 * Container for user turn start and stop strategies.
 *
 * If no strategies are specified, the following defaults are used:
 *
 *     start: [VADUserTurnStartStrategy, TranscriptionUserTurnStartStrategy]
 *      stop: [TurnAnalyzerUserTurnStopStrategy(LocalSmartTurnAnalyzerV3)]
 *
 * - `start`: A list of user turn start strategies used to detect when the
 *   user starts speaking.
 * - `stop`: A list of user turn stop strategies used to decide when the user
 *   stops speaking.
 */
export class UserTurnStrategies {
  start: BaseUserTurnStartStrategy[];
  stop: BaseUserTurnStopStrategy[];

  constructor(options: UserTurnStrategiesOptions = {}) {
    this.start = options.start ?? [];
    this.stop = options.stop ?? [];
    if (runsPostInit(new.target, UserTurnStrategies)) this._postInit();
  }

  protected _postInit(): void {
    if (!this.start || this.start.length === 0) {
      this.start = defaultUserTurnStartStrategies();
    }
    if (!this.stop || this.stop.length === 0) {
      this.stop = defaultUserTurnStopStrategies();
    }
  }
}

export interface ExternalUserTurnStrategiesOptions extends UserTurnStrategiesOptions {
  /**
   * Whether to broadcast an interruption when a proposal starts a turn.
   * Services route their `should_interrupt` setting here.
   */
  enableInterruptions?: boolean;
}

/**
 * Container for turn strategies driven by another component in the pipeline.
 *
 * Preconfigures UserTurnStrategies with ExternalUserTurnStartStrategy and
 * ExternalUserTurnStopStrategy, so a service with its own turn detection — or
 * a shared UserTurnProcessor — controls when user turns start and stop.
 *
 * What the aggregator emits depends on which signal drives the turn.
 * `ProposedUserStarted/StoppedSpeakingFrame` leaves the decision here, so the
 * aggregator pushes the turn frames and broadcasts interruptions.
 * `UserStarted/StoppedSpeakingFrame` means the emitter already announced the
 * turn, so the aggregator emits nothing and the parameter below doesn't apply.
 *
 * - `enableInterruptions`: Whether to broadcast an interruption when a
 *   proposal starts a turn. Services route their `should_interrupt` setting
 *   here.
 */
export class ExternalUserTurnStrategies extends UserTurnStrategies {
  enableInterruptions: boolean;

  constructor(options: ExternalUserTurnStrategiesOptions = {}) {
    super(options);
    this.enableInterruptions = options.enableInterruptions ?? true;
    if (runsPostInit(new.target, ExternalUserTurnStrategies)) this._postInit();
  }

  protected override _postInit(): void {
    this.start = [
      new ExternalUserTurnStartStrategy({ enableInterruptions: this.enableInterruptions }),
    ];
    this.stop = [new ExternalUserTurnStopStrategy()];
  }
}

export interface FilterIncompleteUserTurnStrategiesOptions extends UserTurnStrategiesOptions {
  /**
   * Optional configuration applied to the LLM via the
   * `filter_incomplete_user_turns` setting. Customizes the turn-completion
   * instructions, incomplete-turn timeouts, and re-prompts. If null, defaults
   * from UserTurnCompletionConfig are used.
   */
  config?: UserTurnCompletionConfig | null;
}

/**
 * Stop strategies gated on the LLM's turn-completion verdict.
 *
 * The LLM is asked to begin every response with one of three markers: ●
 * (complete), ◐ (incomplete short), or ○ (incomplete long). Only ● finalizes
 * the user turn; ◐ / ○ keep the turn open so the user can continue speaking
 * and the LLM can re-evaluate later.
 *
 * Configuring strategies this way preserves the existing detector chain
 * (defaults or user-supplied) for inference triggering and appends
 * LLMTurnCompletionUserTurnStopStrategy as the finalizer. The detector
 * strategies are wrapped with `deferred()` automatically so they fire only
 * `on_user_turn_inference_triggered` and leave finalization to the LLM gate.
 *
 * - `config`: Optional configuration applied to the LLM via the
 *   `filter_incomplete_user_turns` setting. Customizes the turn-completion
 *   instructions, incomplete-turn timeouts, and re-prompts. If null, defaults
 *   from UserTurnCompletionConfig are used.
 *
 * @example
 * userTurnStrategies: new FilterIncompleteUserTurnStrategies()
 *
 * // Custom detector chain:
 * userTurnStrategies: new FilterIncompleteUserTurnStrategies({
 *   stop: [new SpeechTimeoutUserTurnStopStrategy({ ... })],
 * })
 *
 * // Custom completion config:
 * userTurnStrategies: new FilterIncompleteUserTurnStrategies({
 *   config: new UserTurnCompletionConfig({
 *     incompleteShortTimeout: 5.0,
 *     incompleteLongTimeout: 10.0,
 *   }),
 * })
 */
export class FilterIncompleteUserTurnStrategies extends UserTurnStrategies {
  config: UserTurnCompletionConfig | null;

  constructor(options: FilterIncompleteUserTurnStrategiesOptions = {}) {
    super(options);
    this.config = options.config ?? null;
    if (runsPostInit(new.target, FilterIncompleteUserTurnStrategies)) this._postInit();
  }

  protected override _postInit(): void {
    super._postInit();
    // Defer the detector chain so it only fires inference-triggered, then
    // append the LLM gate as the sole finalizer.
    const gated: BaseUserTurnStopStrategy[] = (this.stop ?? []).map((s) => deferred(s));
    gated.push(new LLMTurnCompletionUserTurnStopStrategy({ config: this.config }));
    this.stop = gated;
  }
}

export interface EagerUserTurnStrategiesOptions extends ExternalUserTurnStrategiesOptions {
  /**
   * Decides whether the committed transcript is close enough to the eager one
   * to keep the speculative response. Defaults to NormalizedMatch.
   */
  matchPolicy?: EagerMatchPolicy | null;
  /**
   * Seconds a prediction may go unresolved before it is withdrawn and the
   * turn falls back to answering the committed transcript.
   */
  speculationTimeout?: number;
}

/**
 * Strategies for a service that predicts the end of a turn before committing.
 *
 * Answers the prediction while the turn is still open, so the gap before the
 * committed end of turn is spent generating a response instead of waiting for
 * one. The response is discarded if the user resumes speaking or the
 * committed transcript differs from the eager one. See
 * EagerUserTurnStopStrategy.
 *
 * The response is held by the LLM service until the turn is confirmed, so no
 * extra processor is needed in the pipeline.
 *
 * The service owns turn detection here, so this replaces the detector chain
 * rather than extending it: a local detector running alongside would trigger
 * a second inference for the same turn.
 *
 * - `matchPolicy`: Decides whether the committed transcript is close enough to
 *   the eager one to keep the speculative response. Defaults to
 *   NormalizedMatch, since services commonly format the transcript they
 *   commit (capitalization, punctuation) while leaving the eager one raw. Pass
 *   ExactMatch to require the two to be identical.
 * - `speculationTimeout`: Seconds a prediction may go unresolved before it is
 *   withdrawn and the turn falls back to answering the committed transcript.
 *   Guards against a service that stops sending turn signals
 *   mid-speculation, which would otherwise leave the response held and the
 *   bot silent.
 * - `enableInterruptions`: Whether to broadcast an interruption when a
 *   proposal starts a turn. Services route their `should_interrupt` setting
 *   here.
 *
 * @example
 * userTurnStrategies: new EagerUserTurnStrategies()
 *
 * // Require the committed transcript to match the eager one exactly:
 * userTurnStrategies: new EagerUserTurnStrategies({ matchPolicy: new ExactMatch() })
 */
export class EagerUserTurnStrategies extends ExternalUserTurnStrategies {
  matchPolicy: EagerMatchPolicy | null;
  speculationTimeout: number;

  constructor(options: EagerUserTurnStrategiesOptions = {}) {
    super(options);
    this.matchPolicy = options.matchPolicy ?? null;
    this.speculationTimeout = options.speculationTimeout ?? 5.0;
    if (runsPostInit(new.target, EagerUserTurnStrategies)) this._postInit();
  }

  protected override _postInit(): void {
    super._postInit();
    this.stop = [
      new EagerUserTurnStopStrategy({
        matchPolicy: this.matchPolicy,
        speculationTimeout: this.speculationTimeout,
      }),
    ];
  }
}

postInitClasses.add(UserTurnStrategies);
postInitClasses.add(ExternalUserTurnStrategies);
postInitClasses.add(FilterIncompleteUserTurnStrategies);
postInitClasses.add(EagerUserTurnStrategies);
