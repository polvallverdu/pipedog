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
 *   new MinWordsUserTurnStartStrategy({ minWords: 3 }),
 *   ...defaultUserTurnStartStrategies(),
 * ];
 *
 * DIVERGENCE: upstream's example puts a `WakePhraseUserTurnStartStrategy` first, which relies on
 * the deprecated `ProcessFrameResult.STOP` gating of a FIRST list. pipedog doesn't port that: use the
 * wake phrase alone, or with `startMode: StrategyMode.ALL`.
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

/**
 * How a bot's list of user turn strategies combines with a service's.
 *
 * - `EXTEND`: The strategies the bot gave are added to the service's list, or
 *   to the defaults when no service recommends any.
 * - `REPLACE`: The bot's list is used on its own.
 */
export const MergeMode = {
  EXTEND: "extend",
  REPLACE: "replace",
} as const;
export type MergeMode = (typeof MergeMode)[keyof typeof MergeMode];

/**
 * How a list of user turn strategies reaches a decision.
 *
 * - `ALL`: Every strategy has to agree, and each one sees every frame.
 * - `FIRST`: The first strategy to decide wins.
 */
export const StrategyMode = {
  ALL: "all",
  FIRST: "first",
} as const;
export type StrategyMode = (typeof StrategyMode)[keyof typeof StrategyMode];

export interface UserTurnStrategiesParamsOptions {
  /**
   * How the bot's start strategies combine with the ones a service
   * recommends. Defaults to `MergeMode.REPLACE`.
   */
  startMergeMode?: MergeMode;
  /**
   * How the bot's stop strategies combine with the ones a service recommends.
   * Defaults to `MergeMode.REPLACE`.
   */
  stopMergeMode?: MergeMode;
  /**
   * Whether the turn starts on the first start strategy that decides the user
   * started, or once every start strategy has. Defaults to
   * `StrategyMode.FIRST`.
   */
  startMode?: StrategyMode;
  /**
   * Whether the turn ends once every stop strategy has decided the user is
   * done, or on the first one that does. Defaults to `StrategyMode.ALL`.
   */
  stopMode?: StrategyMode;
}

/**
 * How the user turn strategies combine with a service's and decide.
 *
 * A service with its own turn detection, such as an STT service, can
 * recommend user turn strategies. Only the bot sets these parameters: a
 * service's recommendation contributes its lists.
 *
 * - `startMergeMode`: How the bot's start strategies combine with the ones a
 *   service recommends. Defaults to `MergeMode.REPLACE`.
 * - `stopMergeMode`: How the bot's stop strategies combine with the ones a
 *   service recommends. Defaults to `MergeMode.REPLACE`.
 * - `startMode`: Whether the turn starts on the first start strategy that
 *   decides the user started, or once every start strategy has. Defaults to
 *   `StrategyMode.FIRST`, so speech or a transcript starts a turn on its own.
 *   In a `StrategyMode.ALL` list every strategy is a condition the turn
 *   needs, so a fallback such as `TranscriptionUserTurnStartStrategy`, which
 *   starts a turn when VAD misses speech, belongs in a `StrategyMode.FIRST`
 *   list.
 * - `stopMode`: Whether the turn ends once every stop strategy has decided
 *   the user is done, or on the first one that does. A stop strategy that
 *   waits for the turn's inference, such as
 *   `LLMTurnCompletionUserTurnStopStrategy`, decides on it in either mode.
 *   The user speaking again clears the decisions made so far. Defaults to
 *   `StrategyMode.ALL`.
 */
export class UserTurnStrategiesParams {
  startMergeMode: MergeMode;
  stopMergeMode: MergeMode;
  startMode: StrategyMode;
  stopMode: StrategyMode;

  constructor(options: UserTurnStrategiesParamsOptions = {}) {
    this.startMergeMode = options.startMergeMode ?? MergeMode.REPLACE;
    this.stopMergeMode = options.stopMergeMode ?? MergeMode.REPLACE;
    this.startMode = options.startMode ?? StrategyMode.FIRST;
    this.stopMode = options.stopMode ?? StrategyMode.ALL;
  }

  /** Whether the bot's strategies replace both of a service's lists. */
  get replacesServiceStrategies(): boolean {
    return this.startMergeMode === MergeMode.REPLACE && this.stopMergeMode === MergeMode.REPLACE;
  }
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
 * A bot's strategies replace the ones a service recommends, unless
 * `UserTurnStrategiesParams` extends a list.
 *
 * - `start`: A list of user turn start strategies used to detect when the
 *   user starts speaking.
 * - `stop`: A list of user turn stop strategies used to decide when the user
 *   stops speaking.
 */
export class UserTurnStrategies {
  start: BaseUserTurnStartStrategy[];
  stop: BaseUserTurnStopStrategy[];
  // What extending a service's lists adds: the strategies given, without the
  // defaults filled in for a list left out. null means the whole list.
  protected _startExtension: BaseUserTurnStartStrategy[] | null = null;
  protected _stopExtension: BaseUserTurnStopStrategy[] | null = null;

  constructor(options: UserTurnStrategiesOptions = {}) {
    this.start = options.start ?? [];
    this.stop = options.stop ?? [];
    if (runsPostInit(new.target, UserTurnStrategies)) this._postInit();
  }

  protected _postInit(): void {
    this._startExtension = [...(this.start ?? [])];
    this._stopExtension = [...(this.stop ?? [])];
    if (!this.start || this.start.length === 0) {
      this.start = defaultUserTurnStartStrategies();
    }
    if (!this.stop || this.stop.length === 0) {
      this.stop = defaultUserTurnStopStrategies();
    }
  }

  /**
   * Combine these strategies with the ones a service recommends.
   *
   * @param recommended The strategies a service recommends, or null when no
   *   service recommends any, in which case the defaults stand in.
   * @param params How each list combines with the service's.
   * @returns The strategies to run.
   */
  mergeWith(
    recommended: UserTurnStrategies | null,
    params: UserTurnStrategiesParams,
  ): UserTurnStrategies {
    return new UserTurnStrategies({
      start: UserTurnStrategies._mergeList(
        this.start ?? [],
        this._startExtension,
        params.startMergeMode,
        recommended ? recommended.start : null,
        defaultUserTurnStartStrategies,
      ),
      stop: UserTurnStrategies._mergeList(
        this.stop ?? [],
        this._stopExtension,
        params.stopMergeMode,
        recommended ? recommended.stop : null,
        defaultUserTurnStopStrategies,
      ),
    });
  }

  /** Merge one list with the service's, the defaults standing in for none. */
  protected static _mergeList<S>(
    own: S[],
    extension: S[] | null,
    mode: MergeMode,
    recommended: S[] | null,
    defaults: () => S[],
  ): S[] {
    if (mode === MergeMode.REPLACE) {
      return own;
    }
    const added = extension === null ? own : extension;
    return [...(recommended !== null ? recommended : defaults()), ...added];
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
 * Configuring strategies this way keeps the stop strategies (defaults or
 * user-supplied) and adds LLMTurnCompletionUserTurnStopStrategy, which waits
 * for the turn's inference. Once the other stop strategies decide the user
 * stopped, the inference runs, and the turn ends once the LLM marks it
 * complete. This works with either `stopMode`.
 *
 * With `new UserTurnStrategiesParams({ stopMergeMode: MergeMode.EXTEND })`,
 * the LLM gate and any stop strategies given join the ones a service
 * recommends instead, such as an STT service's own turn detection.
 *
 * - `config`: Optional configuration applied to the LLM via the
 *   `filter_incomplete_user_turns` setting. Customizes the turn-completion
 *   instructions, incomplete-turn timeouts, and re-prompts. If null, defaults
 *   from UserTurnCompletionConfig are used.
 *
 * @example
 * userTurnStrategies: new FilterIncompleteUserTurnStrategies()
 *
 * // Custom stop strategies:
 * userTurnStrategies: new FilterIncompleteUserTurnStrategies({
 *   stop: [new SpeechTimeoutUserTurnStopStrategy({ ... })],
 * })
 *
 * // On top of the turn detection a service recommends:
 * userTurnStrategies: new FilterIncompleteUserTurnStrategies(),
 * userTurnStrategiesParams: new UserTurnStrategiesParams({
 *   stopMergeMode: MergeMode.EXTEND,
 * }),
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
    const gate = new LLMTurnCompletionUserTurnStopStrategy({ config: this.config });
    this.stop = [...(this.stop ?? []), gate];
    // Extending a service's stop strategies adds the LLM gate and the stop
    // strategies given, never the default ones.
    this._stopExtension = [...(this._stopExtension ?? []), gate];
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
