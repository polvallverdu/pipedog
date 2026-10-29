// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/script.py

/**
 * Scripted scenario file format for Pipecat behavioral evaluations.
 *
 * A scripted scenario describes a conversation and the semantic events expected
 * to flow back from the bot. It lives in a scenario file's `scenarios:` list
 * (`scenario.ts`). Simple example:
 *
 * ```yaml
 * name: simple_user_input
 * scenarios:
 *   - name: simple_user_input
 *     turns:
 *       - user: "hello world"
 *         expect:
 *           - event: user_started_speaking
 *           - event: user_transcription
 *             text_contains: "hello world"
 * ```
 *
 * The harness plays each turn and checks the events the bot emits back, in
 * order. A scenario with a `persona:` instead of `turns:` is the other kind,
 * a simulation, where an LLM plays the user (`simulation.ts`).
 * The keys below are a scenario's; the file-level ones (`user:`, `judge:`,
 * `context:`, `stop_on_failure:`) may also sit at the top of the file as
 * defaults for every scenario in it.
 *
 * Event names are the friendly names the harness maps RTVI server messages onto:
 * `user_started_speaking`, `user_stopped_speaking`, `vad_user_started_speaking`,
 * `vad_user_stopped_speaking`, `user_transcription`, `bot_started_speaking`,
 * `bot_stopped_speaking`, `llm_started`, `response`, `llm_response`,
 * `llm_marker`, `tts_response`, `function_call`, `function_call_stopped`,
 * `image`, `bot_backchannel`, `user_backchannel`, `expression`. The `vad_*`
 * events are the raw VAD signal, useful as a timing anchor when a turn-detection strategy
 * gates or defers the turn-level `user_stopped_speaking` (e.g. filtering incomplete
 * turns).
 *
 * `image` is an image the bot output, such as a generated one; the bot reports
 * images only to a scenario that expects one:
 *
 * ```yaml
 * turns:
 *   - expect:
 *       - event: image
 *         within_ms: 60000
 * ```
 *
 * `llm_marker` is the sideband marker the bot's LLM emitted in a response, such
 * as the turn-completion markers of `filter_incomplete_user_turns`. It arrives
 * when the response ends. `marker:` says which one: `complete` (the turn was
 * finished and the bot answers), `short` (the user was cut off and the bot
 * waits), `long` (the user asked for time), or `incomplete` (either of the
 * last two). A bare `llm_marker` asserts only that the bot read a response.
 * Markers never reach clients by default; a scenario that asserts on one asks the
 * bot to report them:
 *
 * ```yaml
 * turns:
 *   - user: "Let me think about it, hmmm"
 *     expect:
 *       - event: llm_marker
 *         marker: incomplete        # the bot held the turn open
 *   - user: "I think I'd go to Japan."
 *     expect:
 *       - event: llm_marker
 *         marker: complete          # ... and answered this one
 *       - event: response
 *         eval: "engages with the user's answer about Japan"
 * ```
 *
 * The event also carries the response's raw text, as the LLM produced it before
 * the bot held anything back, so a scenario can check how well the LLM follows
 * the protocol: `marker_first` (nothing before the marker), `markers` (how
 * many markers the text holds), and `text_after` (whether text follows the
 * first marker, which a complete turn should have and an incomplete one should
 * not):
 *
 * ```yaml
 * - user: "I'd go to Japan because"
 *   expect:
 *     - event: llm_marker
 *       marker: short
 *       marker_first: true
 *       markers: 1
 *       text_after: false
 * ```
 *
 * A marker the LLM lets slip into its reply reaches the user, so the reply's
 * own text is worth checking too: `text_excludes` fails when the text holds
 * the given string, the mirror of `text_contains`:
 *
 * ```yaml
 * - user: "What is the capital of Germany?"
 *   expect:
 *     - event: llm_response
 *       text_contains: Berlin
 *       text_excludes: "●"
 * ```
 *
 * The bot's reply can be asserted three ways:
 *
 * - `response`: the transcription of the bot's *actual synthesized audio* (a
 *   local STT run by the harness) in audio modality, or the LLM text in text
 *   modality. The real end-to-end check — prefer this.
 * - `llm_response`: the LLM's text output (`bot-llm-text`). Available in both
 *   modalities.
 * - `tts_response`: the text the TTS reports speaking (`bot-tts-text`, with word
 *   timing). Audio modality only.
 *
 * Supported expectation fields (per event):
 *
 * - `event: <name>`: required — event type name
 * - `within_ms: <int>`: latency budget from the most recent anchor (optional;
 *   defaults to 60s when omitted)
 * - `text_contains: <str>`: substring check on the event's text content,
 *   ignoring whitespace differences
 * - `text_excludes: <str>`: the reverse: the event's text content must not hold
 *   this substring
 * - `text_matches: <regex> | [<regex>, ...]`: regular expressions (Python
 *   `re.search`) the event's text content must each match, such as a format the
 *   reply must open with. The failure names the first pattern that did not match
 * - `marker: <str>`: for `llm_marker` — the marker's meaning: `complete`,
 *   `short`, `long`, or `incomplete` for either of the last two
 * - `marker_first: <bool>`, `markers: <int>`, `text_after: <bool>`: for
 *   `llm_marker` — checks on the response's raw text: whether the first marker
 *   comes before any text, how many markers the text holds, and whether text
 *   follows the first marker
 * - `calls:`: for `function_call` — the set of calls the turn should make,
 *   matched by name in any order; the expectation passes only when all are
 *   found:
 *
 *   ```yaml
 *   - event: function_call
 *     calls:
 *       - name: get_current_weather
 *         args: { location: San Francisco }
 *       - name: get_restaurant_recommendation
 *   ```
 *
 *   `function_call_stopped` takes the same `calls:` shape, and its `args`
 *   say how the call ended — which is how a scenario tells work that was stopped
 *   from work that finished on its own:
 *
 *   ```yaml
 *   - event: function_call_stopped
 *     calls:
 *       - name: write_report
 *         args: { cancelled: true }
 *   ```
 *
 * - `eval: <str>`: natural-language criterion the event's text content must
 *   satisfy, evaluated by the judge (see `judge.ts`).
 *
 *   On `function_call` the criterion is about the call instead: each call
 *   `calls:` (or the `name:`/`args:` shorthand) matches is put to the
 *   judge by name and arguments, over the conversation so far, which is how a
 *   scenario checks what `args:` cannot match verbatim. A
 *   `function_call_stopped` carries no arguments, only how the call ended,
 *   so it takes no `eval:`:
 *
 *   ```yaml
 *   - event: function_call
 *     calls:
 *       - name: submit_session_suggestion
 *     eval: "a session about OpenTelemetry tracing, submitted for Jennifer Smith"
 *   ```
 *
 * - `absent: true`: invert the expectation: assert that NO event of this type
 *   arrives before the `within_ms` budget expires (default 60s — set
 *   `within_ms` explicitly to keep the quiet-window wait short). Matches on
 *   event type only, so it cannot be combined with `text_contains`, `eval:`,
 *   or `calls:`. A `response` that continues the reply an earlier expectation
 *   matched is not a new one; only a reply the bot began after that match
 *   counts. Used for duplicate-output regressions:
 *
 *   ```yaml
 *   - event: response
 *     eval: "answers the question"
 *   - event: response
 *     absent: true
 *     within_ms: 30000
 *   ```
 *
 * - `check_from: turn_start`: Expectations are met in order: each is looked
 *   for only once the one above it has been met, and an event of another type
 *   that arrives in the meantime is passed over. `check_from: turn_start` lets
 *   an expectation run against events since the beginning of the turn that
 *   were not used by the expectations above it. The default, `previous`, looks
 *   only from where the expectation above it was met. Use it for an event
 *   whose timing the bot does not control, such as a call a backend makes at
 *   its own pace, or a reply some models give before the tool call that others
 *   give after:
 *
 *   ```yaml
 *   - event: function_call
 *     calls:
 *       - name: delegate
 *   - event: response
 *     eval: "tells a joke"
 *     check_from: turn_start    # a model may say it before it delegates
 *   - event: function_call
 *     calls:
 *       - name: check_ci_status
 *     check_from: turn_start    # the backend makes it in its own time
 *   ```
 *
 * Instead of `user:`, a turn may press DTMF keys with `dtmf:` (the two are
 * mutually exclusive — you press keys or you talk):
 *
 * ```yaml
 * turns:
 *   - dtmf: "123#"            # quote it: an unquoted # starts a YAML comment
 *     expect:
 *       - event: user_transcription
 *         text_contains: "DTMF: 123#"
 *       - event: response
 *         eval: "confirms the entered digits"
 * ```
 *
 * Each character is sent as one `InputDTMFFrame` (`0`-`9`, `*`, `#`),
 * regardless of the scenario's user/judge modality. A bot running a
 * `DTMFAggregator` accumulates them and flushes — on the `#` terminator or its
 * idle timeout — into a `DTMF: ...` transcription it reacts to.
 *
 * A turn is sent once the bot has finished speaking, like a caller who waits for
 * the end of the sentence, so a reply the previous turn was satisfied with early
 * is never talked over. A turn may also include `send_after:` to schedule its
 * `user`/`dtmf` send relative to a prior event (used for interruption /
 * barge-in tests), or `image:` (a path, relative to the scenario file) to
 * register an image for the turn — when a function-calling-video bot requests
 * a user image, the eval transport serves it. `send_after` with only
 * `delay_ms` (no `event`) is a pure time delay relative to the previous send —
 * handy for pacing keypresses across `dtmf` turns to exercise the aggregator's
 * idle-timeout flush.
 *
 * In audio modality a turn may name a recording with `audio:` (a path, relative
 * to the scenario file) that is played to the bot in place of synthesizing its
 * `user` text: a real caller's voice, or a clip that reproduces a bug. The file
 * is sent at its own sample rate, so it need not match the bot's input rate, and
 * `user` still gives what the recording says, since that is what the judge and
 * `text_contains` see as the turn's input:
 *
 * ```yaml
 * turns:
 *   - user: "What is the capital of Germany?"
 *     audio: ../assets/capital_question.wav
 *     expect:
 *       - event: response
 *         eval: "the response says the capital of Germany is Berlin"
 * ```
 *
 * In audio modality a spoken turn may also pause, as a person does mid-thought:
 * `user:` is then a list of text and `pause_ms:` silences, played to the bot
 * as one stretch of audio. The judge and `text_contains` see the text alone:
 *
 * ```yaml
 * turns:
 *   - user:
 *       - "So last week I went to"
 *       - pause_ms: 2000
 *       - "Spain with my family."
 * ```
 *
 * `expect:` is optional; omit it for a turn that only sends input or only waits.
 *
 * Top-level optional fields:
 *
 * - `context:`: LLM messages the bot's context should start from. When given,
 *   the harness sends them before driving turns (replacing the bot's context);
 *   omit to leave the bot's own context untouched.
 * - `stop_on_failure:`: whether the first failed turn ends the scenario
 *   (default true). A failure leaves the conversation in an unknown state, so
 *   the remaining turns usually just burn a timeout each. Set it false for a
 *   scenario that scores every turn independently — a benchmark that reports a
 *   per-turn pass rate needs all of its turns driven, not just the ones before
 *   the first miss. Give those turns an explicit `within_ms`: with the 60s
 *   default, a silent bot costs one full budget per remaining turn.
 * - `user:`: how user turns are delivered:
 *
 *   ```yaml
 *   user:
 *     modality: audio          # audio | text (default text)
 *     speech:                  # needed unless every spoken turn has audio:
 *       factory: ./my_evals.ts.voice  # a function taking this mapping and
 *                              # returning a TTSService (see services.ts)
 *       voice: <voice id>
 *       language: en           # optional; must match the voice
 *       sample_rate: 16000     # optional
 *   ```
 *
 *   `audio` streams synthesized user audio to the bot (exercising its STT for
 *   real); `text` (the default) sends RTVI `send-text`. A scenario whose
 *   spoken turns all name an `audio:` recording needs no `speech:` block.
 * - `judge:`: what the judge evaluates, and what decides the verdicts:
 *
 *   ```yaml
 *   judge:
 *     modality: audio          # audio | text (default text)
 *     eval:                    # what judges (default ollama)
 *       service: ollama
 *       model: gemma4:12b
 *       # or factory: my_evals.judge, a callable taking this mapping and
 *       # returning a BaseClassifier or an OpenAI-compatible LLM service
 *       # explainer: an LLM block giving the reasons behind the verdicts
 *       # (see judge.ts)
 *     transcription:           # required when modality is audio
 *       factory: ./my_evals.ts.stt  # STT for the bot's audio (see services.ts)
 *       language: en           # optional; the language the bot speaks
 *       padding_secs: 0        # optional; silence padded around the
 *                              # segment (default: 2)
 *   ```
 *
 *   `audio` makes the bot speak and judges the transcription of its actual
 *   audio (`tts_response`); `text` (the default) skips TTS and judges the
 *   LLM text (`llm_response`), which is faster and silent.
 *
 * Any value can be pulled from a separate file with `!include`, resolved
 * relative to the scenario file's directory. This is handy for sharing the
 * `judge:` and `user:` blocks across scenarios:
 *
 * ```yaml
 * user: !include user_audio.yaml
 * judge: !include judge_audio.yaml
 * ```
 *
 * Porting notes: the deprecated `EvalTurn` / `EvalScenario` aliases,
 * `EvalScriptScenario.load` and the `trigger_disconnect:` key / field are not
 * ported. `_parseScript` is async because it resolves the turns' `audio:` and
 * `image:` paths on disk (`Path.resolve()`, symlinks included).
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { KeypadEntry } from "@pipedog/core/audio/dtmf/types";
import { logger } from "@pipedog/core/utils/logger";
import { pyRegExp } from "./_pyutil.ts";
import {
  _DEFAULT_JUDGE,
  _get,
  _has,
  _isDict,
  _isInt,
  _parseJudgeBlock,
  _parseUserBlock,
  _pyRepr,
  _pyStr,
  _pyTruthy,
  type EvalConfigured,
} from "./scenario_config.ts";
import type { ServiceConfig } from "./services.ts";

/**
 * Events whose payloads carry bot-generated text the judge can sensibly
 * evaluate, including the expression the bot's TTS performed. Asserting
 * `eval:` on anything else but a function call (user transcripts,
 * interruption signals) produces a parser warning — the test controls user
 * input deterministically, so judging it adds cost without signal.
 * `response` is the modality-agnostic alias, resolved to one of the others
 * after parsing (see `_resolveResponseEvents`).
 */
export const JUDGEABLE_EVENTS: ReadonlySet<string> = new Set([
  "response",
  "llm_response",
  "tts_response",
  "expression",
]);

/**
 * Events carrying a function call, matched by name and arguments rather than by
 * text: `function_call` when one starts, `function_call_stopped` when it ends
 * (its `args` say whether it was cancelled or ran to completion).
 */
export const FUNCTION_CALL_EVENTS = ["function_call", "function_call_stopped"] as const;

/**
 * What a `marker:` may name on an `llm_marker` expectation. The first three
 * are the kinds the turn-completion mixin stamps on its markers; `incomplete`
 * accepts `short` or `long`.
 */
export const MARKER_KINDS = ["complete", "short", "long", "incomplete"] as const;

/**
 * Where an expectation checks for its event from: where the expectation above
 * it was met, or the beginning of the turn.
 */
export const CHECK_FROM = ["previous", "turn_start"] as const;

function isFunctionCallEvent(event: unknown): boolean {
  return (FUNCTION_CALL_EVENTS as readonly unknown[]).includes(event);
}

export interface EvalFunctionCallOptions {
  name?: string | null;
  args?: Record<string, unknown> | null;
}

/** One expected function call within a `function_call` expectation. */
export class EvalFunctionCall {
  /**
   * The function name to match. `null` matches any call (used by a bare
   * `function_call` expectation that just asserts a call happened).
   */
  name: string | null;
  /**
   * Optional subset check on the call's arguments (every listed key/value must
   * be present; extra arguments are ignored).
   */
  args: Record<string, unknown> | null;

  constructor(options: EvalFunctionCallOptions = {}) {
    this.name = options.name ?? null;
    this.args = options.args ?? null;
  }

  /** A short label for the call: `name(arg=value, ...)`. */
  get signature(): string {
    const name = _pyTruthy(this.name) ? (this.name as string) : "any function";
    if (!_pyTruthy(this.args)) return name;
    const args = Object.entries(this.args!)
      .map(([k, v]) => `${k}=${_pyRepr(v)}`)
      .join(", ");
    return `${name}(${args})`;
  }
}

export interface EvalExpectationOptions {
  event: string;
  withinMs?: number | null;
  textContains?: string | null;
  textExcludes?: string | null;
  textMatches?: string[] | null;
  calls?: EvalFunctionCall[] | null;
  eval?: string | null;
  marker?: string | null;
  markerFirst?: boolean | null;
  markers?: number | null;
  textAfter?: boolean | null;
  checkFrom?: string;
  absent?: boolean;
}

/** A single expected event in a scenario turn. */
export class EvalExpectation {
  /** Required — the semantic event name (e.g. `user_stopped_speaking`). */
  event: string;
  /**
   * Optional latency budget, measured from the turn's user send — all of a
   * turn's expectations share that one anchor, so a stalled turn fails within a
   * single budget rather than one per expectation. For audio turns the anchor
   * is when the utterance was *sent*, not when it finishes streaming to the
   * bot. Defaults to 60s when omitted, so timing isn't asserted unless set
   * explicitly.
   */
  withinMs: number | null;
  /**
   * Optional substring check on the event's text content (`llm_response.text`
   * or `user_transcription.transcript`).
   */
  textContains: string | null;
  /**
   * Optional substring the event's text content must not hold. Checked on the
   * text the expectation matched; with `textContains`, on the reply
   * accumulated up to the match.
   */
  textExcludes: string | null;
  /**
   * Optional regular expressions (`re.search`) the event's text content must
   * each match, checked on the same text as `textExcludes`.
   */
  textMatches: string[] | null;
  /**
   * For a `function_call` event, the set of calls expected in the turn. They
   * are matched by name in any order and the expectation passes only when all
   * of them are found. Built from `calls:` in the YAML, or from the single
   * `name:`/`args:` shorthand.
   */
  calls: EvalFunctionCall[] | null;
  /**
   * Optional natural-language criterion the event's text content must
   * satisfy. Evaluated by a judge LLM. Meaningful on the bot-generated text
   * events (`response`, `llm_response`, `tts_response`, and the `expression`
   * its TTS performed) and on the function-call events, where it is about each
   * matched call's name and arguments rather than text.
   */
  eval: string | null;
  /**
   * For an `llm_marker` event, the meaning the marker must have: one of
   * `MARKER_KINDS`, where `incomplete` accepts `short` or `long`.
   */
  marker: string | null;
  /** For an `llm_marker` event, whether the first marker in the response's raw text must come before any text. */
  markerFirst: boolean | null;
  /** For an `llm_marker` event, how many markers the response's raw text must hold. */
  markers: number | null;
  /** For an `llm_marker` event, whether text must (true) or must not (false) follow the first marker in the raw text. */
  textAfter: boolean | null;
  /**
   * Where the expectation checks for its event from: `previous` (the
   * default), where the expectation above it was met; or `turn_start`, the
   * beginning of the turn, at events the expectations above it did not use.
   */
  checkFrom: string;
  /**
   * When true, the expectation is inverted: it passes only when NO event of
   * this type arrives before the `withinMs` budget expires, and fails as soon
   * as one does. Matches on event type only; `textContains`, `textExcludes`,
   * `textMatches`, `eval`, `calls` and the marker checks are not allowed
   * alongside it.
   */
  absent: boolean;

  constructor(options: EvalExpectationOptions) {
    this.event = options.event;
    this.withinMs = options.withinMs ?? null;
    this.textContains = options.textContains ?? null;
    this.textExcludes = options.textExcludes ?? null;
    this.textMatches = options.textMatches ?? null;
    this.calls = options.calls ?? null;
    this.eval = options.eval ?? null;
    this.marker = options.marker ?? null;
    this.markerFirst = options.markerFirst ?? null;
    this.markers = options.markers ?? null;
    this.textAfter = options.textAfter ?? null;
    this.checkFrom = options.checkFrom ?? "previous";
    this.absent = options.absent ?? false;
  }

  /**
   * Whether the check accumulates text across events rather than matching one.
   *
   * A reply with a content check accumulates the bot's segments, and an
   * `expression` check the expression performed in the turn; a
   * `user_transcription` with `textContains` accumulates an STT's pieces.
   */
  get aggregates(): boolean {
    if (
      this.event === "response" ||
      this.event === "llm_response" ||
      this.event === "tts_response" ||
      this.event === "expression"
    ) {
      return this.textContains !== null || this.eval !== null;
    }
    if (this.event === "user_transcription") {
      return this.textContains !== null && this.eval === null;
    }
    return false;
  }
}

export interface EvalSendAfterOptions {
  event: string | null;
  delayMs: number;
}

/**
 * Scheduling for when a turn's input (`user` or `dtmf`) is sent.
 *
 * When set on an `EvalScriptTurn`, the harness waits for `event` to have been
 * seen (either earlier in the run or arriving now), then waits an additional
 * `delayMs` before sending the turn's input. Used for barge-in tests:
 * `send_after: {event: llm_started, delay_ms: 500}` means "interrupt 500ms
 * after the bot started responding."
 *
 * `event` is optional: a bare `send_after: {delay_ms: 500}` is a pure time
 * delay with no event anchor (500ms after the previous turn's send). Handy for
 * pacing keypresses across `dtmf` turns, where there is no per-key event to
 * anchor on.
 */
export class EvalSendAfter {
  /** Name of the event to schedule from, or `null` for a pure `delayMs` time delay with no event anchor. */
  event: string | null;
  /**
   * Additional delay in milliseconds after the event was received (or, when
   * `event` is `null`, after the previous turn's send).
   */
  delayMs: number;

  constructor(options: EvalSendAfterOptions) {
    this.event = options.event;
    this.delayMs = options.delayMs;
  }
}

export interface EvalScriptTurnOptions {
  user: string | null;
  expect?: EvalExpectation[];
  parts?: (string | number)[] | null;
  audio?: string | null;
  dtmf?: string | null;
  sendAfter?: EvalSendAfter | null;
  image?: string | null;
}

/**
 * One turn in a scenario.
 *
 * A turn drives the bot one of three ways: the harness sends a `user`
 * utterance (the person speaks), it sends a `dtmf` keypress sequence (the
 * person presses keys), or it is observation-only (neither field — useful for
 * bot-first scenarios like opening greetings). `user` and `dtmf` are
 * mutually exclusive: a turn is one or the other.
 *
 * A `user` turn is spoken by the harness's TTS unless the turn names an
 * `audio` file to play instead.
 */
export class EvalScriptTurn {
  /**
   * Optional text the harness sends as the user's turn — an RTVI `send-text` in
   * text modality, or synthesized speech (`raw-audio`) in audio modality. If
   * absent, the turn just waits for and asserts on expected events.
   */
  user: string | null;
  /**
   * Expected events, in the order they should arrive. Optional — omit it for a
   * pure pacing/observation turn (e.g. a `dtmf` turn that only presses keys,
   * with the assertion on a later turn).
   */
  expect: EvalExpectation[];
  /**
   * The turn's text and pauses, in order, when it pauses: text to speak, or the
   * milliseconds of silence between texts. `user` then holds the text alone.
   * Requires `user.modality: audio`.
   */
  parts: (string | number)[] | null;
  /**
   * Optional path to an audio file (resolved relative to the scenario file)
   * played as this turn instead of synthesizing `user`. Multi-channel audio is
   * downmixed to mono. `user` is required alongside it and is what the
   * recording says — the judge reads it as the turn's input and
   * `text_contains` matches against it, neither of which can be recovered from
   * the audio. Requires `user.modality: audio`, and is mutually exclusive with
   * `dtmf`.
   */
  audio: string | null;
  /**
   * Optional DTMF keypad sequence the harness sends, one `InputDTMFFrame` per
   * character (e.g. `"123#"`). Each character must be a valid `KeypadEntry`
   * (`0`-`9`, `*`, `#`). Mutually exclusive with `user`. The keys are injected
   * the same way regardless of the scenario's user/judge modality; a bot with a
   * `DTMFAggregator` turns them into a transcription it reacts to. Quote the
   * value in YAML (`dtmf: "123#"`) — an unquoted `#` starts a comment.
   */
  dtmf: string | null;
  /** Optional schedule for when the turn's input should fire. Only meaningful when `user` or `dtmf` is set. */
  sendAfter: EvalSendAfter | null;
  /**
   * Optional path to an image to register for this turn (resolved relative to
   * the scenario file). When a function-calling-video bot requests a user image
   * during the turn, the eval transport serves this one. Stays registered until
   * a later turn provides a different image.
   */
  image: string | null;

  constructor(options: EvalScriptTurnOptions) {
    this.user = options.user;
    this.expect = options.expect ?? [];
    this.parts = options.parts ?? null;
    this.audio = options.audio ?? null;
    this.dtmf = options.dtmf ?? null;
    this.sendAfter = options.sendAfter ?? null;
    this.image = options.image ?? null;
  }
}

export interface EvalScriptScenarioOptions {
  name: string;
  turns: EvalScriptTurn[];
  context?: Record<string, unknown>[];
  judge?: ServiceConfig;
  botAudio?: boolean;
  transcriber?: ServiceConfig | null;
  userAudio?: boolean;
  userSpeech?: ServiceConfig | null;
  stopOnFailure?: boolean;
  sourcePath?: string | null;
}

/** A parsed scripted scenario. */
export class EvalScriptScenario implements EvalConfigured {
  /** The eval name (from `name:`). */
  name: string;
  /** Ordered list of turns. */
  turns: EvalScriptTurn[];
  /**
   * LLM messages the bot's context should start from for this eval. When
   * non-empty, the harness sends them as an `eval-context` client message right
   * after the bot-ready handshake (the eval serializer turns it into an
   * `LLMMessagesUpdateFrame`, which replaces the context); bots without an LLM
   * context aggregator ignore the frame. Omitted or empty (the default): the
   * harness sends nothing and the bot keeps the context it set up itself.
   */
  context: Record<string, unknown>[];
  /**
   * Judge LLM configuration with keys `service`, `model`, optional `endpoint`,
   * and an optional `extra` mapping forwarded to the model as top-level request
   * parameters. Defaults to `{service: "ollama", model: "gemma4:12b", extra:
   * {reasoning_effort: "none"}}`.
   */
  judge: ServiceConfig;
  /**
   * Whether the bot produces speech, derived from `judge.modality`. False
   * (text, the default): the bot skips TTS — the harness configures skip-TTS at
   * connect, so even an on-connect greeting is silent. True (audio): the bot
   * speaks, and the judge evaluates the transcription of its actual audio.
   */
  botAudio: boolean;
  /**
   * Parsed from the `judge.transcription:` block; the STT config used to
   * transcribe the bot's audio for the `response` event (`null` in text
   * modality). Set `language` when the bot speaks a non-English language so
   * the STT doesn't default to English.
   */
  transcriber: ServiceConfig | null;
  /**
   * Whether the user's turns reach the bot as speech, derived from
   * `user.modality`. False (text, the default): each turn is sent as an RTVI
   * `send-text`. True (audio): the harness streams RTVI `raw-audio`,
   * exercising the bot's STT for real.
   */
  userAudio: boolean;
  /**
   * Parsed from the `user.speech:` block; the TTS config the harness
   * synthesizes user turns with (`null` in text modality). Mapping with
   * `service`, `voice`, and optional `model` / `language` / `speed` /
   * `sample_rate` / `api_key`.
   */
  userSpeech: ServiceConfig | null;
  /**
   * Whether the first failed turn ends the scenario (default true). A failed
   * turn leaves the conversation in an unknown state, so continuing usually
   * costs one timeout per remaining turn. Set false for a scenario whose turns
   * are scored independently, where the turns after a failure are still worth
   * driving. This governs turn-to-turn progression only: within a turn, an
   * expectation that times out still ends that turn's matching, because a
   * turn's expectations share one deadline anchored at the send.
   */
  stopOnFailure: boolean;
  /** Path the scenario was loaded from, for error messages. */
  sourcePath: string | null;

  constructor(options: EvalScriptScenarioOptions) {
    this.name = options.name;
    this.turns = options.turns;
    this.context = options.context ?? [];
    this.judge = options.judge ?? { ..._DEFAULT_JUDGE };
    this.botAudio = options.botAudio ?? false;
    this.transcriber = options.transcriber ?? null;
    this.userAudio = options.userAudio ?? false;
    this.userSpeech = options.userSpeech ?? null;
    this.stopOnFailure = options.stopOnFailure ?? true;
    this.sourcePath = options.sourcePath ?? null;
  }

  /** Whether any expectation asserts on the transcription of the bot's audio. */
  wantsResponse(): boolean {
    return this.turns.some((turn) => turn.expect.some((exp) => exp.event === "response"));
  }

  /**
   * The function-call report level the scenario's assertions need: `full` for
   * args, `name` for names, else `null`.
   *
   * A call with an `eval:` needs `full` too: the judge is asked about the
   * call's arguments.
   */
  requiredReportLevel(): string | null {
    let needsName = false;
    for (const turn of this.turns) {
      for (const exp of turn.expect) {
        if (!isFunctionCallEvent(exp.event)) continue;
        if (exp.eval !== null) return "full";
        // name/args live in exp.calls (the parser normalizes the single
        // name:/args: shorthand into it too).
        for (const call of exp.calls ?? []) {
          if (call.args !== null) return "full";
          if (call.name !== null) needsName = true;
        }
      }
    }
    return needsName ? "name" : null;
  }

  /** Whether the scenario uses the raw VAD speaking events, which the bot emits only on request. */
  needsVadEvents(): boolean {
    const vadEvents = new Set(["vad_user_started_speaking", "vad_user_stopped_speaking"]);
    for (const turn of this.turns) {
      if (turn.sendAfter !== null && turn.sendAfter.event !== null) {
        if (vadEvents.has(turn.sendAfter.event)) return true;
      }
      if (turn.expect.some((exp) => vadEvents.has(exp.event))) return true;
    }
    return false;
  }

  /** Whether the scenario asserts on the images the bot outputs, which it reports only on request. */
  needsBotImages(): boolean {
    return this.turns.some((turn) => turn.expect.some((exp) => exp.event === "image"));
  }

  /** Whether the scenario asserts on the LLM's markers, which the bot emits only on request. */
  needsMarkerEvents(): boolean {
    return this.turns.some((turn) => turn.expect.some((exp) => exp.event === "llm_marker"));
  }
}

/**
 * `(Path(path).parent / relative).resolve()`: an absolute path with symlinks
 * resolved as far as the path exists, as Python's non-strict `resolve()` does.
 */
async function resolveRelativeTo(path: string, relative: string): Promise<string> {
  const nodePath = await import("node:path");
  const { realpath } = await import("node:fs/promises");
  const absolute = nodePath.resolve(nodePath.dirname(path), relative);
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length ? nodePath.join(real, ...tail.reverse()) : real;
    } catch (e) {
      rethrowIfCancelled(e);
      const parent = nodePath.dirname(current);
      if (parent === current) return absolute;
      tail.push(nodePath.basename(current));
      current = parent;
    }
  }
}

/**
 * Parse a scripted scenario's mapping, as read from `path`.
 *
 * @param data The scenario's top-level mapping.
 * @param path The file it came from; error messages name it and the turns'
 *   `audio:` and `image:` paths resolve relative to it.
 * @returns The parsed scenario.
 * @throws Error If the mapping is invalid (upstream: ValueError).
 */
export async function _parseScript(
  data: Record<string, unknown>,
  path: string,
): Promise<EvalScriptScenario> {
  const name = _get(data, "name");
  if (!_pyTruthy(name) || typeof name !== "string") {
    throw new Error(`${path}: missing or invalid 'name:' field`);
  }

  const rawTurns = _get(data, "turns");
  if (!Array.isArray(rawTurns)) throw new Error(`${path}: 'turns:' must be a list`);

  const turns = rawTurns.map((t, idx) => _parseTurn(t, path, idx));

  const rawContext = _get(data, "context");
  let context: Record<string, unknown>[];
  if (rawContext === null) {
    context = [];
  } else if (Array.isArray(rawContext)) {
    context = rawContext;
  } else {
    throw new Error(`${path}: 'context:' must be a list of message dicts`);
  }

  // user: { modality: audio|text, speech: {...} }. Audio synthesizes each user
  // turn via TTS (exercising the bot's STT); text sends it as text.
  const [userAudio, userSpeech] = _parseUserBlock(_get(data, "user"), path);
  _checkUserAudio(turns, userAudio, userSpeech, path);

  // judge: { modality: audio|text, eval: {...}, transcription: {...} }. Audio
  // means the bot speaks and the judge evaluates the transcription of its
  // actual audio (tts_response); text means the bot's LLM text directly
  // (llm_response, bot skips TTS). Stored as botAudio/transcriber/judge.
  const [botAudio, transcriber, judge] = _parseJudgeBlock(_get(data, "judge"), path);

  // Resolve the modality-agnostic `response` event and check event/modality
  // consistency now that the judge modality is known.
  _resolveResponseEvents(turns, botAudio, path);

  // Audio and image paths resolve relative to the scenario file, so a scenario
  // is portable. Resolving never fails, so doing it after the checks above
  // reports the same errors, in the same order, as upstream.
  for (const turn of turns) {
    if (turn.audio !== null) turn.audio = await resolveRelativeTo(path, turn.audio);
    if (turn.image !== null) turn.image = await resolveRelativeTo(path, turn.image);
  }

  return new EvalScriptScenario({
    name,
    turns,
    context,
    judge,
    botAudio,
    transcriber,
    userAudio,
    userSpeech,
    stopOnFailure: _pyTruthy(_get(data, "stop_on_failure", true)),
    sourcePath: path,
  });
}

/** Check the turns against the `user:` block they are delivered by. */
function _checkUserAudio(
  turns: EvalScriptTurn[],
  userAudio: boolean,
  speech: ServiceConfig | null,
  path: string,
): void {
  turns.forEach((turn, idx) => {
    if (turn.audio !== null && !userAudio) {
      throw new Error(
        `${path}: turn #${idx} has 'audio:' but the scenario is text modality — ` +
          "set 'user.modality: audio' to play it to the bot",
      );
    }
    if (turn.parts !== null && !userAudio) {
      throw new Error(
        `${path}: turn #${idx} pauses in 'user:' but the scenario is text modality — ` +
          "set 'user.modality: audio' to speak it to the bot",
      );
    }
  });

  // A turn naming a file is played as-is; only the rest need a voice to speak them.
  if (userAudio && speech === null) {
    const spoken = turns.flatMap((t, i) => (t.user !== null && t.audio === null ? [i] : []));
    if (spoken.length) {
      throw new Error(
        `${path}: 'user.modality: audio' requires a 'user.speech:' block ` +
          `(TTS service + voice) to synthesize turn(s) [${spoken.join(", ")}] — ` +
          "or give each of them an 'audio:' file",
      );
    }
  }
}

/**
 * Resolve `response` for the modality and check consistency.
 *
 * In audio modality `response` is the transcription of the bot's audio; in
 * text modality it becomes `llm_response`. `tts_response` needs the bot
 * to speak, so it is an error in text modality.
 */
function _resolveResponseEvents(turns: EvalScriptTurn[], botAudio: boolean, path: string): void {
  turns.forEach((turn, ti) => {
    for (const exp of turn.expect) {
      if (exp.event === "response" && !botAudio) {
        exp.event = "llm_response";
      } else if (exp.event === "tts_response" && !botAudio) {
        throw new Error(
          `${path}: turn #${ti} asserts 'tts_response' but 'judge.modality' is text ` +
            "(the bot doesn't speak). Use 'response'/'llm_response', or set " +
            "'judge.modality: audio'.",
        );
      }
    }
  });
}

/** Parse one entry from the `turns:` list (paths are left unresolved; `_parseScript` resolves them). */
function _parseTurn(t: unknown, path: string, idx: number): EvalScriptTurn {
  if (!_isDict(t)) throw new Error(`${path}: turn #${idx} must be a mapping`);

  const [user, parts] = _parseUser(_get(t, "user"), path, idx);

  const dtmf = _parseDtmf(_get(t, "dtmf"), path, idx);
  if (user !== null && dtmf !== null) {
    throw new Error(
      `${path}: turn #${idx} has both 'user:' and 'dtmf:' — a turn is one or the other`,
    );
  }

  // `expect:` is optional: a turn may just send input (e.g. paced keypresses)
  // or just wait, with the assertion living on another turn.
  const rawExpect = _get(t, "expect", []);
  if (!Array.isArray(rawExpect)) {
    throw new Error(`${path}: turn #${idx} 'expect:' must be a list if present`);
  }

  const expect = rawExpect.map((e, ei) => _parseExpectation(e, path, idx, ei));

  const sendAfter = _has(t, "send_after") ? _parseSendAfter(t.send_after, path, idx) : null;
  if (sendAfter !== null && user === null && dtmf === null) {
    throw new Error(
      `${path}: turn #${idx} has 'send_after:' but no 'user:' or 'dtmf:' — ` +
        "send_after only schedules when the turn's input gets sent",
    );
  }

  const audio = _get(t, "audio");
  if (audio !== null) {
    if (typeof audio !== "string") {
      throw new Error(`${path}: turn #${idx} 'audio:' must be a path string`);
    }
    if (dtmf !== null) {
      throw new Error(
        `${path}: turn #${idx} has both 'audio:' and 'dtmf:' — a turn is one or the other`,
      );
    }
    if (user === null) {
      throw new Error(
        `${path}: turn #${idx} has 'audio:' but no 'user:' — give the text the ` +
          "recording says, so the judge and 'text_contains' have the turn's input",
      );
    }
    if (parts !== null) {
      throw new Error(
        `${path}: turn #${idx} has both 'audio:' and pauses in 'user:' — ` +
          "a recording has its own pauses",
      );
    }
  }

  const image = _get(t, "image");
  if (image !== null && typeof image !== "string") {
    throw new Error(`${path}: turn #${idx} 'image:' must be a path string`);
  }

  return new EvalScriptTurn({
    user,
    parts,
    dtmf,
    expect,
    sendAfter,
    image: image as string | null,
    audio: audio as string | null,
  });
}

/** Parse a turn's `user:`: its text, and its text and pauses when it pauses. */
function _parseUser(
  user: unknown,
  path: string,
  turnIdx: number,
): [string | null, (string | number)[] | null] {
  if (user === null || typeof user === "string") return [user, null];
  if (!Array.isArray(user)) {
    throw new Error(
      `${path}: turn #${turnIdx} 'user:' must be a string, or a list of text and pauses`,
    );
  }
  const parts = user.map((part) => _parseUserPart(part, path, turnIdx));
  const texts = parts.filter((part): part is string => typeof part === "string");
  if (!texts.length) throw new Error(`${path}: turn #${turnIdx} 'user:' has pauses but no text`);
  return [texts.join(" "), parts];
}

/** Parse one item of a pausing `user:`: text, or a pause's milliseconds. */
function _parseUserPart(part: unknown, path: string, turnIdx: number): string | number {
  if (typeof part === "string" && part.trim()) return part.trim();
  if (_isDict(part)) {
    const keys = Object.keys(part);
    if (keys.length === 1 && keys[0] === "pause_ms") {
      const pauseMs = part.pause_ms;
      // DIVERGENCE: JS numbers carry no int/float distinction, so an integral
      // float (`pause_ms: 2000.0`) is accepted where upstream rejects it.
      if (typeof pauseMs === "number" && Number.isInteger(pauseMs) && pauseMs > 0) return pauseMs;
    }
  }
  throw new Error(
    `${path}: turn #${turnIdx} 'user:' items must be text or 'pause_ms: <positive int>'`,
  );
}

const KEYPAD_VALUES: readonly string[] = Object.values(KeypadEntry);

/** Parse and validate a turn's `dtmf:` keypad sequence. */
function _parseDtmf(dtmf: unknown, path: string, turnIdx: number): string | null {
  if (dtmf === null) return null;
  // YAML parses an unquoted digit sequence as an int (`dtmf: 123`); normalize so
  // both `dtmf: 123` and `dtmf: "123#"` work the same.
  let value = dtmf;
  if (_isInt(value)) value = _pyStr(value);
  if (typeof value !== "string" || !value) {
    throw new Error(
      `${path}: turn #${turnIdx} 'dtmf:' must be a non-empty string of keypad entries`,
    );
  }
  for (const ch of value) {
    if (!KEYPAD_VALUES.includes(ch)) {
      const valid = KEYPAD_VALUES.join(", ");
      throw new Error(
        `${path}: turn #${turnIdx} 'dtmf:' has invalid keypad entry ${_pyRepr(ch)} ` +
          `(valid entries: ${valid})`,
      );
    }
  }
  return value;
}

/** Parse a `send_after:` block. */
function _parseSendAfter(s: unknown, path: string, turnIdx: number): EvalSendAfter {
  if (!_isDict(s)) throw new Error(`${path}: turn #${turnIdx} 'send_after:' must be a mapping`);

  const event = _get(s, "event");
  if (event !== null && typeof event !== "string") {
    throw new Error(`${path}: turn #${turnIdx} 'send_after.event' must be a string if present`);
  }

  const rawDelay = _get(s, "delay_ms", 0);
  // DIVERGENCE: an integral float (`delay_ms: 500.0`) is accepted (JS numbers
  // carry no int/float distinction). A boolean counts as an int, as upstream.
  if (!_isInt(rawDelay) || Number(rawDelay) < 0) {
    throw new Error(`${path}: turn #${turnIdx} 'send_after.delay_ms' must be a non-negative int`);
  }
  const delayMs = Number(rawDelay);

  // With no event to anchor on, a zero delay would be a no-op send_after.
  if (event === null && delayMs === 0) {
    throw new Error(
      `${path}: turn #${turnIdx} 'send_after:' needs an 'event:' or a positive 'delay_ms:'`,
    );
  }

  return new EvalSendAfter({ event, delayMs });
}

const ABSENT_CONFLICTS = [
  "text_contains",
  "text_excludes",
  "text_matches",
  "eval",
  "calls",
  "name",
  "args",
  "marker",
  "marker_first",
  "markers",
  "text_after",
];

/** Parse one entry from a turn's `expect:` list. */
function _parseExpectation(
  e: unknown,
  path: string,
  turnIdx: number,
  expIdx: number,
): EvalExpectation {
  if (!_isDict(e)) {
    throw new Error(`${path}: turn #${turnIdx} expectation #${expIdx} must be a mapping`);
  }

  const event = _get(e, "event");
  if (!_pyTruthy(event) || typeof event !== "string") {
    throw new Error(`${path}: turn #${turnIdx} expectation #${expIdx} missing or invalid 'event:'`);
  }

  const criterion = _get(e, "eval");
  if (criterion !== null && event === "function_call_stopped") {
    throw new Error(
      `${path}: turn #${turnIdx} expectation #${expIdx}: 'eval:' on ` +
        "'function_call_stopped': a stopped call carries no arguments to judge; " +
        "put the 'eval:' on the 'function_call' instead",
    );
  }
  if (criterion !== null && !JUDGEABLE_EVENTS.has(event) && event !== "function_call") {
    logger.warning(
      `${path}: turn #${turnIdx} expectation #${expIdx}: 'eval:' on ` +
        `event ${_pyRepr(event)} — judge only makes sense on bot-generated text ` +
        `events (${[...JUDGEABLE_EVENTS].sort().join(", ")}) and 'function_call'. ` +
        "Will run but is unlikely to be meaningful.",
    );
  }

  const absent = _get(e, "absent", false);
  if (typeof absent !== "boolean") {
    throw new Error(`${path}: turn #${turnIdx} expectation #${expIdx} 'absent:' must be a boolean`);
  }
  const checkFrom = _get(e, "check_from", "previous");
  if (!(CHECK_FROM as readonly unknown[]).includes(checkFrom)) {
    throw new Error(
      `${path}: turn #${turnIdx} expectation #${expIdx} 'check_from:' must be one of ` +
        `${CHECK_FROM.join(", ")}, not ${_pyRepr(checkFrom)}`,
    );
  }
  if (absent && _has(e, "check_from")) {
    // An absence is about what arrives after the expectations before it;
    // looking back for it has no meaning.
    throw new Error(
      `${path}: turn #${turnIdx} expectation #${expIdx} 'absent: true' ` +
        "cannot be combined with 'check_from'",
    );
  }
  if (absent) {
    // An absent expectation matches on event type only: content and call
    // checks describe an event that must arrive, which contradicts absence.
    const conflicting = ABSENT_CONFLICTS.filter((key) => _has(e, key));
    if (conflicting.length) {
      throw new Error(
        `${path}: turn #${turnIdx} expectation #${expIdx} 'absent: true' ` +
          `cannot be combined with ${conflicting.map((k) => _pyRepr(k)).join(", ")}`,
      );
    }
  }

  const calls = absent ? null : _parseFunctionCalls(e, event, path, turnIdx, expIdx);

  const where = `${path}: turn #${turnIdx} expectation #${expIdx}`;
  const markerKeys = ["marker", "marker_first", "markers", "text_after"].filter((key) =>
    _has(e, key),
  );
  if (markerKeys.length && event !== "llm_marker") {
    throw new Error(
      `${where} ${markerKeys.map((k) => `${_pyRepr(k)}:`).join(", ")} only applies to ` +
        `the 'llm_marker' event, not ${_pyRepr(event)}`,
    );
  }
  const marker = _get(e, "marker");
  if (marker !== null && !(MARKER_KINDS as readonly unknown[]).includes(marker)) {
    throw new Error(
      `${where} 'marker:' must be one of ${MARKER_KINDS.join(", ")}, not ${_pyRepr(marker)}`,
    );
  }
  for (const [key, kind] of [
    ["marker_first", "bool"],
    ["text_after", "bool"],
    ["markers", "int"],
  ] as const) {
    const value = _get(e, key);
    if (value === null) continue;
    // DIVERGENCE: an integral float (`markers: 1.0`) counts as an int.
    const ok =
      kind === "bool"
        ? typeof value === "boolean"
        : typeof value === "number" && Number.isInteger(value);
    if (!ok) throw new Error(`${where} '${key}:' must be a ${kind}`);
  }

  let textMatches = _get(e, "text_matches");
  if (typeof textMatches === "string") {
    textMatches = [textMatches];
  }
  if (textMatches !== null) {
    if (!Array.isArray(textMatches) || !textMatches.every((p) => typeof p === "string")) {
      throw new Error(`${where} 'text_matches:' must be a pattern or a list of patterns`);
    }
    for (const pattern of textMatches as string[]) {
      try {
        pyRegExp(pattern);
      } catch (ex) {
        rethrowIfCancelled(ex);
        throw new Error(
          `${where} 'text_matches:' pattern ${_pyRepr(pattern)}: ${(ex as Error).message}`,
          { cause: ex },
        );
      }
    }
  }

  return new EvalExpectation({
    event,
    withinMs: _get(e, "within_ms") as number | null,
    textContains: _get(e, "text_contains") as string | null,
    textExcludes: _get(e, "text_excludes") as string | null,
    textMatches: textMatches as string[] | null,
    calls,
    eval: criterion as string | null,
    marker: marker as string | null,
    markerFirst: _get(e, "marker_first") as boolean | null,
    markers: _get(e, "markers") as number | null,
    textAfter: _get(e, "text_after") as boolean | null,
    checkFrom: checkFrom as string,
    absent,
  });
}

/**
 * Normalize a `function_call` expectation's calls into a list.
 *
 * A `calls:` list (names, or `{name, args}` mappings), the single
 * `name:`/`args:` shorthand, or nothing, which matches any one call.
 * `null` for other events.
 */
function _parseFunctionCalls(
  e: Record<string, unknown>,
  event: string,
  path: string,
  turnIdx: number,
  expIdx: number,
): EvalFunctionCall[] | null {
  if (!isFunctionCallEvent(event)) return null;

  const where = `${path}: turn #${turnIdx} expectation #${expIdx}`;
  const rawCalls = _get(e, "calls");
  if (rawCalls === null) {
    return [
      new EvalFunctionCall({
        name: _get(e, "name") as string | null,
        args: _get(e, "args") as Record<string, unknown> | null,
      }),
    ];
  }

  if (!Array.isArray(rawCalls) || !rawCalls.length) {
    throw new Error(`${where}: 'calls:' must be a non-empty list`);
  }
  const out: EvalFunctionCall[] = [];
  for (const c of rawCalls) {
    if (typeof c === "string") {
      out.push(new EvalFunctionCall({ name: c }));
    } else if (_isDict(c)) {
      out.push(
        new EvalFunctionCall({
          name: _get(c, "name") as string | null,
          args: _get(c, "args") as Record<string, unknown> | null,
        }),
      );
    } else {
      throw new Error(`${where}: each 'calls:' entry must be a name or a mapping`);
    }
  }
  return out;
}
