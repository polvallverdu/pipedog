// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/scenario_config.py

/**
 * The `user:` and `judge:` blocks every scenario file carries, and their summary.
 *
 * `user:` decides how the user's turns reach the bot (text, or speech synthesized
 * by a TTS) and `judge:` how the bot's reply is judged (its LLM text, or a
 * transcription of its speech, by which judge LLM). `describeConfig`
 * renders both as the two-line summary printed before a run.
 *
 * Porting notes: the deprecated `trigger_disconnect:` key (and its parser,
 * `_parse_trigger_disconnect`) is not ported; a scenario that still sets it
 * has the key ignored, like any other unknown key. This module also holds the
 * small helpers that reproduce Python's semantics on loaded YAML values
 * (`dict.get`, truthiness, `repr`, `str`, `format(x, "g")`) for the scenario
 * parsers in `script.ts` and `simulation.ts`.
 */

import { pyNumberRepr } from "@pipedog/core/utils/py_json";
import { pyStrRepr } from "./_pyutil.ts";
import {
  DEFAULT_OLLAMA_JUDGE_EXTRA,
  DEFAULT_OLLAMA_JUDGE_MODEL,
  type ServiceConfig,
} from "./services.ts";

// --- Python semantics on loaded YAML values ------------------------------------

/** `isinstance(value, dict)`: a plain object, as a YAML mapping loads. */
export function _isDict(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `d.get(key, default)`: the value when `key` is present (even `null`), else `fallback`. */
export function _get(d: Record<string, unknown>, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(d, key) ? d[key] : fallback;
}

/** `key in d`. */
export function _has(d: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(d, key);
}

/** `isinstance(value, int)`: an integral number, or a boolean (Python's `bool` is an `int`). */
export function _isInt(value: unknown): value is number | boolean {
  return typeof value === "boolean" || (typeof value === "number" && Number.isInteger(value));
}

/** Python's truthiness (`bool(value)`). */
export function _pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0; // NaN is truthy in Python too
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Set || value instanceof Map) return value.size > 0;
  if (_isDict(value)) return Object.keys(value).length > 0;
  return true;
}

/** Python's `repr(value)` for the values YAML loads. */
export function _pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return pyStrRepr(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Number.POSITIVE_INFINITY) return "inf";
    if (value === Number.NEGATIVE_INFINITY) return "-inf";
    return pyNumberRepr(value);
  }
  if (Array.isArray(value)) return `[${value.map(_pyRepr).join(", ")}]`;
  if (_isDict(value)) {
    const items = Object.entries(value).map(([k, v]) => `${pyStrRepr(k)}: ${_pyRepr(v)}`);
    return `{${items.join(", ")}}`;
  }
  return String(value);
}

/** Python's `str(value)`: a string as is, anything else as its `repr`. */
export function _pyStr(value: unknown): string {
  return typeof value === "string" ? value : _pyRepr(value);
}

/** Python's `format(value, "g")`: six significant digits, trailing zeros dropped. */
export function _formatG(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const [mantissa, expStr] = value.toExponential(5).split("e") as [string, string];
  const exp = Number(expStr);
  const strip = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (exp >= -4 && exp < 6) return strip(value.toFixed(5 - exp));
  const absExp = Math.abs(exp);
  return `${strip(mantissa)}e${exp < 0 ? "-" : "+"}${absExp < 10 ? "0" : ""}${absExp}`;
}

// --- The user: and judge: blocks ---------------------------------------------------

export const _DEFAULT_JUDGE: ServiceConfig = {
  service: "ollama",
  model: DEFAULT_OLLAMA_JUDGE_MODEL,
  extra: { ...DEFAULT_OLLAMA_JUDGE_EXTRA },
};

/** Parse the `user:` block into `[userAudio, speech config]`. */
export function _parseUserBlock(user: unknown, path: string): [boolean, ServiceConfig | null] {
  if (user === null || user === undefined) return [false, null]; // default: text modality
  if (!_isDict(user)) throw new Error(`${path}: 'user:' must be a mapping`);
  const modality = _get(user, "modality", "text");
  if (modality !== "audio" && modality !== "text") {
    throw new Error(
      `${path}: 'user.modality:' must be 'audio' or 'text', got ${_pyRepr(modality)}`,
    );
  }
  if (modality === "text") return [false, null];
  const speech = _get(user, "speech");
  if (speech !== null && !_isDict(speech)) {
    throw new Error(`${path}: 'user.speech:' must be a mapping`);
  }
  return [true, speech];
}

/** Parse the `judge:` block into `[botAudio, transcriber, eval-config]`. */
export function _parseJudgeBlock(
  judge: unknown,
  path: string,
): [boolean, ServiceConfig | null, ServiceConfig] {
  const block = judge === null || judge === undefined ? {} : judge;
  if (!_isDict(block)) throw new Error(`${path}: 'judge:' must be a mapping`);
  const modality = _get(block, "modality", "text");
  if (modality !== "audio" && modality !== "text") {
    throw new Error(
      `${path}: 'judge.modality:' must be 'audio' or 'text', got ${_pyRepr(modality)}`,
    );
  }
  const rawEval = _get(block, "eval");
  const evalCfg = _pyTruthy(rawEval) ? rawEval : { ..._DEFAULT_JUDGE };
  if (!_isDict(evalCfg)) {
    throw new Error(`${path}: 'judge.eval:' must be a mapping (the judge LLM service)`);
  }
  if (modality === "text") return [false, null, evalCfg];
  const transcription = _get(block, "transcription");
  if (!_isDict(transcription)) {
    throw new Error(
      `${path}: 'judge.modality: audio' requires a 'judge.transcription:' block ` +
        "(STT service to transcribe the bot's audio)",
    );
  }
  return [true, transcription, evalCfg];
}

// --- The config summary ------------------------------------------------------------

// ANSI codes for the colored config summary (applied only when color=true). The
// section labels are bold, the separators dim, and each segment's keyword gets one
// hue per category so modality / service / judge LLM are easy to tell apart; the
// values are left uncolored.
export const _CFG_LABEL = "1"; // bold — the "user" / "judge" section labels
export const _CFG_SEP = "2"; // dim — the "->" arrow and "|" separators
export const _CFG_MODALITY = "33"; // yellow — modality keyword
export const _CFG_SERVICE = "32"; // green — speech (TTS) / transcription (STT) keywords
export const _CFG_EVAL = "35"; // magenta — LLM keywords: the judge's eval, a simulation's persona
export const _CFG_LIMIT = "36"; // cyan — a simulation's run caps

/** A config line's segment: keyword, value, and the ANSI code the keyword is painted with. */
export type _ConfigSegment = [key: string, value: string, code: string];
/** A labeled config line: its label, then its segments or plain text. */
export type _ConfigLine = [label: string, segments: _ConfigSegment[] | string];

/** The modality and service config a scenario and a simulation share. */
export interface EvalConfigured {
  userAudio: boolean;
  userSpeech: ServiceConfig | null;
  botAudio: boolean;
  transcriber: ServiceConfig | null;
  judge: ServiceConfig;
}

// The model each LLM service builds with when the block names none.
// DIVERGENCE: upstream also names `openai` (DEFAULT_OPENAI_MODEL) here, for the
// `service: openai` LLM block deprecated since 1.9.0 and not ported; a block
// that still names it is summarized as `openai` alone.
const _DEFAULT_LLM_MODELS: Record<string, string> = {
  ollama: DEFAULT_OLLAMA_JUDGE_MODEL,
};

/**
 * What a service config block builds, as the run summary names it.
 *
 * `factory:<path>` for a factory, else `service/model`, the model being
 * the block's or the one the service builds with by default, or the service
 * alone when neither is known.
 */
export function _svcModel(
  cfg: ServiceConfig,
  defaultService: string,
  modelKey: string,
  defaultModels: Record<string, string> | null = null,
): string {
  const factory = _get(cfg, "factory");
  if (_pyTruthy(factory)) return `factory:${_pyStr(factory)}`;
  const service = _pyStr(_get(cfg, "service", defaultService));
  const own = _get(cfg, modelKey);
  const fallback = defaultModels ?? {};
  const model = _pyTruthy(own)
    ? own
    : Object.hasOwn(fallback, service.toLowerCase())
      ? fallback[service.toLowerCase()]
      : null;
  return _pyTruthy(model) ? `${service}/${_pyStr(model)}` : service;
}

/** What a `judge.eval` or `simulator` block builds, as the run summary names it. */
export function _llmIdentity(cfg: ServiceConfig): string {
  return _svcModel(cfg, "ollama", "model", _DEFAULT_LLM_MODELS);
}

/** The `user` line's segments: modality, and the TTS the user's turns are spoken with. */
export function _userSegments(scenario: EvalConfigured): _ConfigSegment[] {
  const segs: _ConfigSegment[] = [
    ["modality", scenario.userAudio ? "audio" : "text", _CFG_MODALITY],
  ];
  if (_pyTruthy(scenario.userSpeech)) {
    // The TTS "voice" is the speech config's model-equivalent.
    segs.push(["speech", _svcModel(scenario.userSpeech!, "?", "voice"), _CFG_SERVICE]);
  }
  return segs;
}

/** The `judge` line's segments: modality, the bot-speech STT, and the judge LLM. */
export function _judgeSegments(scenario: EvalConfigured): _ConfigSegment[] {
  const segs: _ConfigSegment[] = [
    ["modality", scenario.botAudio ? "audio" : "text", _CFG_MODALITY],
  ];
  if (scenario.botAudio) {
    const transcriber = _pyTruthy(scenario.transcriber) ? scenario.transcriber! : {};
    segs.push(["transcription", _svcModel(transcriber, "whisper", "model"), _CFG_SERVICE]);
  }
  segs.push(["eval", _llmIdentity(scenario.judge), _CFG_EVAL]);
  return segs;
}

/**
 * Render labeled config lines, `label -> key: value | key: value`.
 *
 * With `color`, the label is bold, the separators dim, and each keyword
 * takes its segment's ANSI code.
 */
export function _configLines(lines: _ConfigLine[], options: { color: boolean }): string {
  const { color } = options;
  const paint = (text: string, code: string): string =>
    color ? `\x1b[${code}m${text}\x1b[0m` : text;

  const arrow = paint(" -> ", _CFG_SEP);
  const sep = paint(" | ", _CFG_SEP);

  const body = (segs: _ConfigSegment[] | string): string => {
    if (typeof segs === "string") return segs;
    return segs.map(([key, value, code]) => `${paint(`${key}:`, code)} ${value}`).join(sep);
  };

  return lines
    .map(([label, segs]) => `${paint(label.padEnd(5), _CFG_LABEL)}${arrow}${body(segs)}`)
    .join("\n");
}

export interface DescribeConfigOptions {
  /**
   * When true, ANSI-color each segment's keyword by category (modality,
   * service, judge LLM) so they're easy to tell apart.
   */
  color?: boolean;
}

/**
 * Two-line summary of a scenario's user + judge config, for pre-run logs.
 *
 * @param scenario The parsed scenario to summarize.
 * @param options `color`: ANSI-color the keywords.
 * @returns A `user` line and a `judge` line, each a set of `key: value` segments
 *   separated by `|`, e.g.:
 *
 * ```
 * user  -> modality: audio | speech: kokoro/af_heart
 * judge -> modality: audio | transcription: moonshine/small-streaming | eval: ollama/gemma4:12b
 * ```
 */
export function describeConfig(
  scenario: EvalConfigured,
  options: DescribeConfigOptions = {},
): string {
  const lines: _ConfigLine[] = [
    ["user", _userSegments(scenario)],
    ["judge", _judgeSegments(scenario)],
  ];
  return _configLines(lines, { color: options.color ?? false });
}
