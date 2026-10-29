// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_evals_scenario.py

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LOG_LEVELS, logger } from "@pipedog/core/utils/logger";
import * as scenarioModule from "../src/scenario.ts";
import {
  _loadMapping,
  EvalExpectation,
  EvalFunctionCall,
  EvalScenarioFile,
  EvalScriptScenario,
  EvalScriptTurn,
  EvalSendAfter,
  EvalSimulationScenario,
} from "../src/scenario.ts";
import { _parseScript } from "../src/script.ts";

/** Write yaml_text to a temp file and return the path. */
function _write(yamlText: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "evals-scenario-")), "scenario.yaml");
  writeFileSync(path, yamlText, "utf8");
  return path;
}

/** Parse a file holding one scripted scenario's own keys at its top level. */
async function _script(path: string): Promise<EvalScriptScenario> {
  return _parseScript(await _loadMapping(path), path);
}

/** The error an async call rejects with. */
async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

const GROUP = `
name: turn_completion
judge: {modality: text}
context:
  - role: system
    content: "You are a travel assistant."
stop_on_failure: false

scenarios:
  - name: short_answer
    turns:
      - user: "Japan."
        expect: [{event: response}]
  - name: with_history
    stop_on_failure: true
    context:
      - role: system
        content: "You are a travel assistant."
      - role: assistant
        content: "Where would you go?"
    turns:
      - user: "Japan."
        expect: [{event: response}]
`;

describe("TestScenarioGroups", () => {
  test("test_a_file_of_one_scenario_names_it_under_the_file", async () => {
    const scenarios = await EvalScenarioFile.load(
      _write("name: greet\nscenarios:\n  - name: greet\n    turns: [{user: hi}]\n"),
    );
    expect([...scenarios].map((s) => s.name)).toEqual(["greet/greet"]);
  });

  // Exercises only the flat file shape, deprecated since 1.11.0 and not ported.
  test.skip("test_a_flat_file_is_deprecated_and_keeps_its_name", () => {});

  test("test_entries_are_named_under_the_group", async () => {
    const scenarios = await EvalScenarioFile.load(_write(GROUP));
    expect([...scenarios].map((s) => s.name)).toEqual([
      "turn_completion/short_answer",
      "turn_completion/with_history",
    ]);
    expect([...scenarios].every((s) => s instanceof EvalScriptScenario)).toBe(true);
  });

  test("test_header_keys_are_defaults_and_an_entry_replaces_a_whole_value", async () => {
    const [short, history] = [...(await EvalScenarioFile.load(_write(GROUP)))] as [
      EvalScriptScenario,
      EvalScriptScenario,
    ];
    // Inherited from the header.
    expect(short.context).toEqual([{ role: "system", content: "You are a travel assistant." }]);
    expect(short.stopOnFailure).toBe(false);
    expect(short.botAudio).toBe(false);
    // Replaced as a whole, not merged.
    expect(history.context.length).toEqual(2);
    expect(history.context[1]!.role).toEqual("assistant");
    expect(history.stopOnFailure).toBe(true);
    expect(history.botAudio).toBe(false);
  });

  test("test_entries_can_be_simulations", async () => {
    const scenarios = await EvalScenarioFile.load(
      _write(
        `
                name: diner
                persona: "An impatient diner."
                success: "the bot confirms"
                scenarios:
                  - name: book
                    goal: "Book a table."
                  - name: cancel
                    goal: "Cancel a booking."
                `,
      ),
    );
    expect([...scenarios].every((s) => s instanceof EvalSimulationScenario)).toBe(true);
    expect([...scenarios].map((s) => (s as EvalSimulationScenario).goal)).toEqual([
      "Book a table.",
      "Cancel a booking.",
    ]);
    expect((scenarios.get("diner/book") as EvalSimulationScenario).persona).toEqual(
      "An impatient diner.",
    );
  });

  test("test_a_file_knows_its_name_and_path_and_finds_a_scenario_by_name", async () => {
    const path = _write(GROUP);
    const file = await EvalScenarioFile.load(path);
    expect([file.name, file.path, file.length]).toEqual(["turn_completion", path, 2]);
    expect(file.get("turn_completion/with_history").name).toEqual("turn_completion/with_history");
    expect(() => file.get("turn_completion/nope")).toThrow(
      "no scenario called 'turn_completion/nope'",
    );
  });

  // Exercises only EvalScriptScenario.load / EvalSimulationScenario.load,
  // deprecated since 1.11.0 and not ported.
  test.skip("test_the_class_loaders_are_deprecated", () => {});

  // Exercises only load_scenario_file, deprecated since 1.11.0 and not ported.
  test.skip("test_load_scenario_file_is_deprecated_and_wants_a_lone_scenario", () => {});

  test("test_group_needs_a_name", async () => {
    const e = await rejection(() =>
      EvalScenarioFile.load(_write("scenarios: [{name: a, turns: []}]\n")),
    );
    expect(e.message).toContain("missing or invalid 'name:'");
  });

  test("test_group_needs_entries", async () => {
    const e = await rejection(() => EvalScenarioFile.load(_write("name: g\nscenarios: []\n")));
    expect(e.message).toContain("non-empty list");
  });

  test("test_entry_needs_a_name", async () => {
    const e = await rejection(() =>
      EvalScenarioFile.load(_write("name: g\nscenarios: [{turns: []}]\n")),
    );
    expect(e.message).toContain("scenario #0 needs a 'name:'");
  });

  test("test_entry_cannot_nest_a_group", async () => {
    const e = await rejection(() =>
      EvalScenarioFile.load(_write("name: g\nscenarios: [{name: a, scenarios: []}]\n")),
    );
    expect(e.message).toContain("cannot hold a 'scenarios:'");
  });

  test("test_duplicate_entry_names_rejected", async () => {
    const e = await rejection(() =>
      EvalScenarioFile.load(
        _write("name: g\nscenarios: [{name: a, turns: []}, {name: a, turns: []}]\n"),
      ),
    );
    expect(e.message).toContain("duplicate scenario names: g/a");
  });

  test("test_entry_errors_name_the_file", async () => {
    const path = _write("name: g\nscenarios: [{name: a, turns: [{user: hi, expect: nope}]}]\n");
    const e = await rejection(() => EvalScenarioFile.load(path));
    expect(e.message).toContain(path);
  });
});

describe("TestScenarioFacade", () => {
  test("test_both_kinds_and_the_released_names_import_from_scenario", () => {
    // The deprecated load_scenario_file, EvalScenario and EvalTurn are not
    // ported, so they are left out of the list.
    for (const name of [
      "EvalScriptScenario",
      "EvalScriptTurn",
      "EvalExpectation",
      "EvalFunctionCall",
      "EvalSendAfter",
      "EvalSimulationScenario",
      "EvalSimulationMetric",
      "describeConfig",
      "describeSimulation",
    ]) {
      expect(name in scenarioModule).toBe(true);
    }
  });
});

describe("TestEvalsScenarioParser", () => {
  test("test_minimal_valid", async () => {
    const s = await _script(
      _write(
        `
                name: minimal
                turns:
                  - user: "hello"
                    expect:
                      - event: user_started_speaking
                `,
      ),
    );
    expect(s.name).toEqual("minimal");
    expect(s.turns.length).toEqual(1);
    expect(s.turns[0]!.user).toEqual("hello");
    expect(s.turns[0]!.expect[0]!.event).toEqual("user_started_speaking");
    expect(s.turns[0]!.sendAfter).toBeNull();
    // botAudio defaults to false: evals are text/silent unless they opt in.
    expect(s.botAudio).toBe(false);
    expect(s.transcriber).toBeNull();
  });

  test("test_judge_audio_modality_enables_transcriber", async () => {
    const s = await _script(
      _write(
        "name: a\n" +
          "judge:\n" +
          "  modality: audio\n" +
          "  transcription: {service: whisper, model: base}\n" +
          "turns: [{user: hi, expect: [{event: tts_response, eval: ok}]}]\n",
      ),
    );
    expect(s.botAudio).toBe(true);
    expect(s.transcriber).toEqual({ service: "whisper", model: "base" });
  });

  test("test_judge_audio_requires_transcription", async () => {
    const e = await rejection(() =>
      _script(
        _write(
          "name: a\njudge: {modality: audio}\n" +
            "turns: [{user: hi, expect: [{event: tts_response, eval: ok}]}]\n",
        ),
      ),
    );
    expect(e.message).toContain("transcription");
  });

  test("test_judge_invalid_modality_rejected", async () => {
    await expect(
      _script(
        _write(
          "name: a\njudge: {modality: bogus}\n" +
            "turns: [{user: hi, expect: [{event: llm_started}]}]\n",
        ),
      ),
    ).rejects.toThrow();
  });

  test("test_user_audio_modality", async () => {
    const s = await _script(
      _write(
        "name: a\n" +
          "user:\n" +
          "  modality: audio\n" +
          "  speech: {service: cartesia, voice: v1}\n" +
          "turns: [{user: hi, expect: [{event: llm_started}]}]\n",
      ),
    );
    expect(s.userAudio).toBe(true);
    expect(s.userSpeech).toEqual({ service: "cartesia", voice: "v1" });
  });

  test("test_user_turn_with_pauses", async () => {
    const s = await _script(
      _write(
        "name: a\n" +
          "user: {modality: audio, speech: {service: kokoro, voice: v1}}\n" +
          "turns:\n" +
          "  - user: ['So last week I went to', {pause_ms: 2000}, 'Spain.']\n",
      ),
    );
    const turn = s.turns[0]!;
    expect(turn.user).toEqual("So last week I went to Spain.");
    expect(turn.parts).toEqual(["So last week I went to", 2000, "Spain."]);
  });

  test("test_user_turn_pauses_are_validated", async () => {
    const audio = "user: {modality: audio, speech: {service: kokoro, voice: v1}}\n";
    const cases: Record<string, string> = {
      "pauses but no text": `${audio}turns: [{user: [{pause_ms: 500}]}]\n`,
      "items must be text": `${audio}turns: [{user: ['Hi', {pause_ms: 0}]}]\n`,
      "text modality": "turns: [{user: ['Hi', {pause_ms: 500}, 'there']}]\n",
    };
    for (const [message, body] of Object.entries(cases)) {
      const e = await rejection(() => _script(_write(`name: a\n${body}`)));
      expect(e.message).toContain(message);
    }
  });

  test("test_user_audio_requires_speech", async () => {
    const e = await rejection(() =>
      _script(
        _write(
          "name: a\nuser: {modality: audio}\n" +
            "turns: [{user: hi, expect: [{event: llm_started}]}]\n",
        ),
      ),
    );
    expect(e.message).toContain("speech");
  });

  test("test_response_event_resolves_to_modality", async () => {
    // judge.modality audio -> response stays response (the audio transcription)
    const audio = await _script(
      _write(
        "name: a\n" +
          "judge: {modality: audio, transcription: {service: whisper}}\n" +
          "turns: [{user: hi, expect: [{event: response, eval: ok}]}]\n",
      ),
    );
    expect(audio.turns[0]!.expect[0]!.event).toEqual("response");
    // text (default) -> response falls back to llm_response (no audio)
    const text = await _script(
      _write("name: a\nturns: [{user: hi, expect: [{event: response, eval: ok}]}]\n"),
    );
    expect(text.turns[0]!.expect[0]!.event).toEqual("llm_response");
  });

  test("test_tts_response_in_text_modality_rejected", async () => {
    const e = await rejection(() =>
      _script(_write("name: a\nturns: [{user: hi, expect: [{event: tts_response, eval: ok}]}]\n")),
    );
    expect(e.message).toContain("tts_response");
  });

  test("test_all_expectation_fields", async () => {
    const s = await _script(
      _write(
        `
                name: all_fields
                turns:
                  - user: "x"
                    expect:
                      - event: llm_response
                        within_ms: 500
                        text_contains: "bar"
                        text_excludes: "baz"
                        eval: "is friendly"
                `,
      ),
    );
    const exp = s.turns[0]!.expect[0]!;
    expect(exp.withinMs).toEqual(500);
    expect(exp.textContains).toEqual("bar");
    expect(exp.textExcludes).toEqual("baz");
    expect(exp.eval).toEqual("is friendly");
    expect(exp.calls).toBeNull();
    expect(exp.absent).toBe(false);
  });

  test("test_text_matches_parsed", async () => {
    const s = await _script(
      _write(
        `
                name: matches
                turns:
                  - user: "x"
                    expect:
                      - event: llm_response
                        text_matches: "^Hi"
                      - event: llm_response
                        text_matches: ["^Hi", "!$"]
                `,
      ),
    );
    expect(s.turns[0]!.expect[0]!.textMatches).toEqual(["^Hi"]);
    expect(s.turns[0]!.expect[1]!.textMatches).toEqual(["^Hi", "!$"]);
  });

  test("test_text_matches_rejects_bad_patterns", async () => {
    for (const value of ['"(unclosed"', "[1, 2]"]) {
      await expect(
        _script(
          _write(
            `
                        name: bad_matches
                        turns:
                          - user: "x"
                            expect:
                              - event: llm_response
                                text_matches: ${value}
                        `,
          ),
        ),
      ).rejects.toThrow();
    }
  });

  test("test_absent_expectation_parsed", async () => {
    const s = await _script(
      _write(
        `
                name: absent
                turns:
                  - user: "x"
                    expect:
                      - event: llm_response
                        eval: "answers"
                      - event: llm_response
                        absent: true
                        within_ms: 5000
                `,
      ),
    );
    const exp = s.turns[0]!.expect[1]!;
    expect(exp.absent).toBe(true);
    expect(exp.withinMs).toEqual(5000);
  });

  test("test_absent_rejects_content_checks", async () => {
    for (const extra of [
      'eval: "repeats itself"',
      'text_contains: "again"',
      'text_excludes: "x"',
      'text_matches: "x"',
    ]) {
      await expect(
        _script(
          _write(
            `
                        name: bad_absent
                        turns:
                          - user: "x"
                            expect:
                              - event: llm_response
                                absent: true
                                ${extra}
                        `,
          ),
        ),
      ).rejects.toThrow();
    }
  });

  test("test_absent_must_be_boolean", async () => {
    await expect(
      _script(
        _write(
          `
                    name: bad_absent_type
                    turns:
                      - user: "x"
                        expect:
                          - event: llm_response
                            absent: "yes please"
                    `,
        ),
      ),
    ).rejects.toThrow();
  });

  test("test_function_call_name_args_shorthand", async () => {
    // A single function_call uses the `name:`/`args:` shorthand.
    const s = await _script(
      _write(
        `
                name: one_call
                turns:
                  - user: "weather?"
                    expect:
                      - event: function_call
                        name: get_weather
                        args: {city: Paris}
                `,
      ),
    );
    expect(s.turns[0]!.expect[0]!.calls).toEqual([
      new EvalFunctionCall({ name: "get_weather", args: { city: "Paris" } }),
    ]);
  });

  test("test_function_call_calls_list_any_order", async () => {
    // Multiple calls in a turn go under `calls:` (matched in any order).
    const s = await _script(
      _write(
        `
                name: two_calls
                turns:
                  - user: "weather and food?"
                    expect:
                      - event: function_call
                        calls:
                          - get_weather
                          - {name: get_restaurants, args: {city: Paris}}
                `,
      ),
    );
    expect(s.turns[0]!.expect[0]!.calls).toEqual([
      new EvalFunctionCall({ name: "get_weather" }),
      new EvalFunctionCall({ name: "get_restaurants", args: { city: "Paris" } }),
    ]);
  });

  test("test_bare_function_call_matches_any", async () => {
    // A bare function_call (no name/calls) matches any single call.
    const s = await _script(
      _write("name: bare\nturns: [{user: hi, expect: [{event: function_call}]}]\n"),
    );
    expect(s.turns[0]!.expect[0]!.calls).toEqual([new EvalFunctionCall({ name: null })]);
  });

  // Upstream loads these with the deprecated EvalScriptScenario.load, which is
  // `_parse_script(_load_mapping(path), path)`: the `_script` helper here.
  test("test_llm_marker_expectation", async () => {
    const s = await _script(
      _write(
        `
                name: markers
                turns:
                  - user: "Let me think, hmmm"
                    expect:
                      - event: llm_marker
                        marker: incomplete
                  - user: "Japan."
                    expect:
                      - event: llm_marker
                        marker: complete
                      - event: response
                `,
      ),
    );
    expect(s.turns[0]!.expect[0]!.marker).toEqual("incomplete");
    expect(s.turns[1]!.expect[0]!.marker).toEqual("complete");
    expect(s.needsMarkerEvents()).toBe(true);
  });

  test("test_llm_marker_format_fields", async () => {
    const s = await _script(
      _write(
        `
                name: markers
                turns:
                  - user: "I'd go to Japan because"
                    expect:
                      - event: llm_marker
                        marker: short
                        marker_first: true
                        markers: 1
                        text_after: false
                `,
      ),
    );
    const exp = s.turns[0]!.expect[0]!;
    expect([exp.markerFirst, exp.markers, exp.textAfter]).toEqual([true, 1, false]);
    for (const [bad, message] of [
      ["expect: [{event: response, markers: 1}]", "only applies to the 'llm_marker' event"],
      ["expect: [{event: llm_marker, markers: yes}]", "'markers:' must be a int"],
      ["expect: [{event: llm_marker, marker_first: 1}]", "'marker_first:' must be a bool"],
      ["expect: [{event: llm_marker, absent: true, text_after: false}]", "cannot be combined"],
    ] as const) {
      const e = await rejection(() =>
        _script(_write(`name: bad\nturns:\n  - user: "x"\n    ${bad}\n`)),
      );
      expect(e.message).toContain(message);
    }
  });

  test("test_llm_marker_unknown_kind_rejected", async () => {
    const e = await rejection(() =>
      _script(
        _write(
          `
                    name: bad_marker
                    turns:
                      - user: "x"
                        expect: [{event: llm_marker, marker: done}]
                    `,
        ),
      ),
    );
    expect(e.message).toContain("'marker:' must be one of");
  });

  test("test_marker_on_other_event_rejected", async () => {
    const e = await rejection(() =>
      _script(
        _write(
          `
                    name: bad_marker_event
                    turns:
                      - user: "x"
                        expect: [{event: response, marker: complete}]
                    `,
        ),
      ),
    );
    expect(e.message).toContain("only applies to the 'llm_marker' event");
  });

  test("test_absent_rejects_marker", async () => {
    await expect(
      _script(
        _write(
          `
                    name: absent_marker
                    turns:
                      - user: "x"
                        expect: [{event: llm_marker, absent: true, marker: complete}]
                    `,
        ),
      ),
    ).rejects.toThrow();
  });

  test("test_send_after_parsed", async () => {
    const s = await _script(
      _write(
        `
                name: with_send_after
                turns:
                  - user: "first"
                    expect: [{event: user_stopped_speaking}]
                  - send_after: {event: user_stopped_speaking, delay_ms: 200}
                    user: "second"
                    expect: [{event: user_stopped_speaking}]
                `,
      ),
    );
    expect(s.turns[0]!.sendAfter).toBeNull();
    expect(s.turns[1]!.sendAfter).toBeInstanceOf(EvalSendAfter);
    expect(s.turns[1]!.sendAfter!.event).toEqual("user_stopped_speaking");
    expect(s.turns[1]!.sendAfter!.delayMs).toEqual(200);
  });

  test("test_expect_only_turn", async () => {
    // A turn without `user:` is observation-only (bot-first scenarios).
    const s = await _script(
      _write(
        `
                name: bot_first
                turns:
                  - expect:
                      - event: llm_response
                `,
      ),
    );
    expect(s.turns[0]!.user).toBeNull();
    expect(s.turns[0]!.expect[0]!.event).toEqual("llm_response");
  });

  test("test_dtmf_turn_parsed", async () => {
    const s = await _script(
      _write(
        `
                name: dtmf
                turns:
                  - dtmf: "123#"
                    expect:
                      - event: user_transcription
                        text_contains: "DTMF: 123#"
                `,
      ),
    );
    expect(s.turns[0]!.dtmf).toEqual("123#");
    expect(s.turns[0]!.user).toBeNull();
  });

  test("test_dtmf_unquoted_int_normalized", async () => {
    // An unquoted digit sequence parses as int; it's coerced to a string.
    const s = await _script(_write("name: dtmf\nturns: [{dtmf: 123}]\n"));
    expect(s.turns[0]!.dtmf).toEqual("123");
  });

  test("test_dtmf_unquoted_leading_zero_preserved", async () => {
    // A leading zero must stay literal digits, not be read as YAML octal.
    //
    // YAML 1.1 would otherwise parse `012` as octal 10, silently sending the
    // wrong keys; the scenario loader resolves only plain decimal as int.
    for (const seq of ["012", "010", "007", "0420", "000"]) {
      const s = await _script(_write(`name: dtmf\nturns: [{dtmf: ${seq}}]\n`));
      expect(s.turns[0]!.dtmf).toEqual(seq);
    }
  });

  test("test_dtmf_unquoted_hex_rejected", async () => {
    // A hex-looking token isn't read as a number; `x` fails validation.
    const e = await rejection(() => _script(_write("name: bad\nturns: [{dtmf: 0x10}]\n")));
    expect(e.message).toContain("invalid keypad entry");
  });

  test("test_dtmf_invalid_entry_rejected", async () => {
    const e = await rejection(() => _script(_write('name: bad\nturns: [{dtmf: "1A"}]\n')));
    expect(e.message).toContain("invalid keypad entry");
  });

  test("test_dtmf_and_user_mutually_exclusive", async () => {
    const e = await rejection(() => _script(_write('name: bad\nturns: [{user: hi, dtmf: "1"}]\n')));
    expect(e.message).toContain("one or the other");
  });

  test("test_send_after_allowed_on_dtmf_turn", async () => {
    const s = await _script(
      _write(
        `
                name: bargein
                turns:
                  - dtmf: "0"
                    send_after: {event: llm_started, delay_ms: 300}
                `,
      ),
    );
    expect(s.turns[0]!.sendAfter).not.toBeNull();
    expect(s.turns[0]!.sendAfter!.event).toEqual("llm_started");
  });

  test("test_judge_eval_preserved", async () => {
    const s = await _script(
      _write(
        `
                name: with_judge
                judge:
                  eval:
                    service: openai
                    model: gpt-4o-mini
                    endpoint: http://custom-endpoint
                turns:
                  - user: "hi"
                    expect: [{event: user_stopped_speaking}]
                `,
      ),
    );
    expect(s.judge).toEqual({
      service: "openai",
      model: "gpt-4o-mini",
      endpoint: "http://custom-endpoint",
    });
  });

  test("test_judge_block_defaults_to_ollama", async () => {
    const s = await _script(
      _write("name: e\nturns: [{user: hi, expect: [{event: user_stopped_speaking}]}]\n"),
    );
    expect(s.judge).toEqual({
      service: "ollama",
      model: "gemma4:12b",
      extra: { reasoning_effort: "none" },
    });
  });

  test("test_judge_block_non_mapping_rejected", async () => {
    const e = await rejection(() =>
      _script(
        _write("name: bad\njudge: not_a_mapping\nturns: [{user: hi, expect: [{event: x}]}]\n"),
      ),
    );
    expect(e.message).toContain("'judge:'");
  });

  test("test_missing_name_field", async () => {
    const e = await rejection(() => _script(_write("turns: []\n")));
    expect(e.message).toContain("'name:'");
  });

  test("test_send_after_without_user_rejected", async () => {
    const e = await rejection(() =>
      _script(
        _write(
          `
                    name: bad
                    turns:
                      - send_after: {event: x, delay_ms: 100}
                        expect: [{event: y}]
                    `,
        ),
      ),
    );
    expect(e.message).toContain("send_after");
    expect(e.message).toContain("no 'user:'");
  });

  test("test_invalid_send_after_delay_rejected", async () => {
    const e = await rejection(() =>
      _script(
        _write(
          `
                    name: bad
                    turns:
                      - send_after: {event: x, delay_ms: -1}
                        user: "y"
                        expect: [{event: z}]
                    `,
        ),
      ),
    );
    expect(e.message).toContain("non-negative");
  });

  test("test_send_after_without_event_is_pure_delay", async () => {
    const s = await _script(
      _write(
        `
                name: paced
                turns:
                  - user: "first"
                    expect: [{event: llm_started}]
                  - user: "second"
                    send_after: {delay_ms: 500}
                    expect: [{event: llm_started}]
                `,
      ),
    );
    expect(s.turns[1]!.sendAfter).not.toBeNull();
    expect(s.turns[1]!.sendAfter!.event).toBeNull();
    expect(s.turns[1]!.sendAfter!.delayMs).toEqual(500);
  });

  test("test_send_after_without_event_or_delay_rejected", async () => {
    const e = await rejection(() =>
      _script(
        _write(
          "name: bad\n" + "turns: [{user: hi, send_after: {delay_ms: 0}, expect: [{event: x}]}]\n",
        ),
      ),
    );
    expect(e.message).toContain("positive 'delay_ms:'");
  });

  test("test_missing_expect_defaults_to_empty", async () => {
    // A turn without `expect:` just sends/waits (e.g. paced keypresses).
    const s = await _script(_write("name: ok\nturns: [{user: hi}]\n"));
    expect(s.turns[0]!.expect).toEqual([]);
  });

  test("test_expect_non_list_rejected", async () => {
    const e = await rejection(() =>
      _script(_write("name: bad\nturns: [{user: hi, expect: nope}]\n")),
    );
    expect(e.message).toContain("expect");
  });

  test("test_expectation_missing_event_rejected", async () => {
    const e = await rejection(() =>
      _script(_write("name: bad\nturns: [{user: hi, expect: [{within_ms: 100}]}]\n")),
    );
    expect(e.message).toContain("event");
  });

  test("test_expectation_dataclass_defaults", () => {
    // Construct EvalExpectation directly to lock its defaults.
    const e = new EvalExpectation({ event: "foo" });
    expect(e.withinMs).toBeNull();
    expect(e.textContains).toBeNull();
    expect(e.eval).toBeNull();
  });

  /** Parse `yamlText`, collecting the warnings the parser logs. */
  async function loadCapturingWarnings(yamlText: string): Promise<[EvalScriptScenario, string[]]> {
    const warnings: string[] = [];
    const remove = logger.addSink((record) => {
      if (LOG_LEVELS[record.level] >= LOG_LEVELS.WARNING) warnings.push(record.message);
    });
    try {
      return [await _script(_write(yamlText)), warnings];
    } finally {
      remove();
    }
  }

  test("test_eval_on_non_bot_event_warns", async () => {
    // eval: on user-side events produces a parser warning (the user
    // transcript is deterministic, so judging it adds cost without signal),
    // but the parse succeeds and the field is preserved.
    const [s, warnings] = await loadCapturingWarnings(
      `
            name: misused_eval
            turns:
              - user: "hi"
                expect:
                  - event: user_stopped_speaking
                    eval: "is a greeting"
            `,
    );
    expect(s.turns[0]!.expect[0]!.eval).toEqual("is a greeting");
    expect(warnings.length).toEqual(1);
    expect(warnings[0]).toContain("'eval:' on event 'user_stopped_speaking'");
  });

  test("test_eval_on_function_call_is_accepted", async () => {
    // eval: on a function call judges the matched calls, so it is not a misuse.
    const [s, warnings] = await loadCapturingWarnings(
      `
            name: judged_call
            turns:
              - user: "suggest a session"
                expect:
                  - event: function_call
                    calls: [{name: submit_session_suggestion}]
                    eval: "the suggestion is about tracing"
            `,
    );
    const exp = s.turns[0]!.expect[0]!;
    expect(exp.event).toEqual("function_call");
    expect(exp.calls).toEqual([new EvalFunctionCall({ name: "submit_session_suggestion" })]);
    expect(exp.eval).toEqual("the suggestion is about tracing");
    expect(warnings).toEqual([]);
  });

  test("test_eval_on_a_stopped_call_is_rejected", async () => {
    // A stopped call carries no arguments, so there is nothing for a judge to see.
    const e = await rejection(() =>
      _script(
        _write(
          `
                    name: judged_stop
                    turns:
                      - user: "suggest a session"
                        expect:
                          - event: function_call_stopped
                            calls: [{name: submit_session_suggestion}]
                            eval: "the suggestion is about tracing"
                    `,
        ),
      ),
    );
    expect(e.message).toContain("'function_call_stopped'");
  });

  test("test_turn_dataclass_construction", () => {
    // Direct construction (used by tests / programmatic eval generation).
    const t = new EvalScriptTurn({ user: "hi", expect: [new EvalExpectation({ event: "x" })] });
    expect(t.user).toEqual("hi");
    expect(t.sendAfter).toBeNull();
    expect(t.image).toBeNull();
  });

  test("test_turn_image_resolved_relative_to_scenario", async () => {
    const p = _write(
      "name: t\nturns: [{user: hi, image: pics/cat.jpg, expect: [{event: llm_response}]}]\n",
    );
    const s = await _script(p);
    // `(p.parent / "pics/cat.jpg").resolve()`: the existing part has its symlinks resolved.
    expect(s.turns[0]!.image).toEqual(join(realpathSync(dirname(p)), "pics/cat.jpg"));
  });

  test("test_turn_image_non_string_rejected", async () => {
    const e = await rejection(() =>
      _script(_write("name: t\nturns: [{user: hi, image: 5, expect: [{event: x}]}]\n")),
    );
    expect(e.message).toContain("image");
  });

  test("test_context_defaults_to_empty", async () => {
    const s = await _script(
      _write("name: e\nturns: [{user: hi, expect: [{event: user_stopped_speaking}]}]\n"),
    );
    expect(s.context).toEqual([]);
  });

  test("test_context_parsed_as_list", async () => {
    const s = await _script(
      _write(
        `
                name: with_context
                context:
                  - role: system
                    content: "You are a helpful assistant."
                turns:
                  - user: hi
                    expect: [{event: user_stopped_speaking}]
                `,
      ),
    );
    expect(s.context.length).toEqual(1);
    expect(s.context[0]!.role).toEqual("system");
    expect(s.context[0]!.content).toEqual("You are a helpful assistant.");
  });

  test("test_context_non_list_rejected", async () => {
    const e = await rejection(() =>
      _script(
        _write("name: bad\ncontext: not_a_list\nturns: [{user: hi, expect: [{event: x}]}]\n"),
      ),
    );
    expect(e.message).toContain("'context:'");
  });

  test("test_include_resolves_judge_and_user_blocks", async () => {
    // `judge: !include ...` / `user: !include ...` let scenarios share config.
    // Includes resolve relative to the scenario file's directory, so the
    // fragments are written alongside the scenario.
    const d = mkdtempSync(join(tmpdir(), "evals-scenario-"));
    writeFileSync(
      join(d, "judge_audio.yaml"),
      "modality: audio\n" +
        "eval: {service: ollama, model: llama3:latest}\n" +
        "transcription: {service: whisper, model: base}\n",
      "utf8",
    );
    writeFileSync(
      join(d, "user_audio.yaml"),
      "modality: audio\nspeech: {service: kokoro, voice: af_heart}\n",
      "utf8",
    );
    const scenario = join(d, "math.yaml");
    writeFileSync(
      scenario,
      "name: math\n" +
        "user: !include user_audio.yaml\n" +
        "judge: !include judge_audio.yaml\n" +
        "turns: [{user: hi, expect: [{event: response, eval: ok}]}]\n",
      "utf8",
    );

    const s = await _script(scenario);
    expect(s.botAudio).toBe(true);
    expect(s.transcriber).toEqual({ service: "whisper", model: "base" });
    expect(s.judge).toEqual({ service: "ollama", model: "llama3:latest" });
    expect(s.userAudio).toBe(true);
    expect(s.userSpeech).toEqual({ service: "kokoro", voice: "af_heart" });
  });

  test("test_stop_on_failure_defaults_true", async () => {
    const s = await _script(
      _write("name: a\nturns: [{user: hi, expect: [{event: llm_response}]}]\n"),
    );
    expect(s.stopOnFailure).toBe(true);
  });

  test("test_stop_on_failure_false", async () => {
    const s = await _script(
      _write(
        "name: a\n" +
          "stop_on_failure: false\n" +
          "turns: [{user: hi, expect: [{event: llm_response}]}]\n",
      ),
    );
    expect(s.stopOnFailure).toBe(false);
  });
});

describe("TestTurnAudioFile", () => {
  // A turn can name an audio file to play instead of synthesizing its text.

  const AUDIO_USER = "user:\n  modality: audio\n  speech: {service: kokoro, voice: af_heart}\n";

  test("test_audio_path_resolves_against_the_scenario", async () => {
    const d = mkdtempSync(join(tmpdir(), "evals-scenario-"));
    mkdirSync(join(d, "clips"));
    writeFileSync(join(d, "clips", "hi.wav"), new Uint8Array());
    const scenario = join(d, "s.yaml");
    writeFileSync(
      scenario,
      `name: a\n${AUDIO_USER}turns: [{user: hi, audio: clips/hi.wav}]\n`,
      "utf8",
    );

    const s = await _script(scenario);
    expect(s.turns[0]!.audio).toEqual(realpathSync(join(d, "clips", "hi.wav")));
    // The text stays the turn's input for the judge and text_contains.
    expect(s.turns[0]!.user).toEqual("hi");
  });

  test("test_audio_without_user_is_rejected", async () => {
    const e = await rejection(() =>
      _script(_write(`name: a\n${AUDIO_USER}turns: [{audio: hi.wav}]\n`)),
    );
    expect(e.message).toContain("no 'user:'");
  });

  test("test_audio_with_dtmf_is_rejected", async () => {
    const e = await rejection(() =>
      _script(_write(`name: a\n${AUDIO_USER}turns: [{user: hi, audio: hi.wav, dtmf: "1"}]\n`)),
    );
    expect(e.message).toContain("one or the other");
  });

  test("test_audio_needs_audio_modality", async () => {
    const e = await rejection(() =>
      _script(_write("name: a\nturns: [{user: hi, audio: hi.wav}]\n")),
    );
    expect(e.message).toContain("text modality");
  });

  test("test_audio_must_be_a_path", async () => {
    const e = await rejection(() =>
      _script(_write(`name: a\n${AUDIO_USER}turns: [{user: hi, audio: 3}]\n`)),
    );
    expect(e.message).toContain("must be a path string");
  });

  test("test_file_only_scenario_needs_no_speech_config", async () => {
    // Nothing is synthesized, so the scenario should not have to name a TTS
    // (building one loads a model for no reason).
    const d = mkdtempSync(join(tmpdir(), "evals-scenario-"));
    writeFileSync(join(d, "hi.wav"), new Uint8Array());
    const scenario = join(d, "s.yaml");
    writeFileSync(
      scenario,
      "name: a\nuser: {modality: audio}\nturns: [{user: hi, audio: hi.wav}]\n",
      "utf8",
    );

    const s = await _script(scenario);
    expect(s.userAudio).toBe(true);
    expect(s.userSpeech).toBeNull();
  });

  test("test_a_synthesized_turn_still_needs_speech", async () => {
    const e = await rejection(() =>
      _script(
        _write(
          "name: a\nuser: {modality: audio}\n" +
            "turns: [{user: recorded, audio: hi.wav}, {user: synthesized}]\n",
        ),
      ),
    );
    expect(e.message).toContain("turn(s) [1]");
  });
});

describe("TestDeprecatedTriggerDisconnect", () => {
  // `trigger_disconnect:` is deprecated since 1.13.0 and not ported: the key
  // is ignored and scenarios have no such field.
  test.skip("test_the_field_is_deprecated_and_still_read", () => {});
  test.skip("test_a_scenario_without_it_does_not_warn", () => {});
});

describe("TestCheckFrom", () => {
  // The `check_from:` key on an expectation.

  const turns = (expectation: string): string =>
    "name: g\nscenarios:\n  - name: a\n    turns:\n      - user: hi\n" +
    `        expect:\n          - ${expectation}\n`;

  const first = async (yamlText: string): Promise<EvalScriptScenario> =>
    (await EvalScenarioFile.load(_write(yamlText))).scenarios[0] as EvalScriptScenario;

  test("test_defaults_to_previous", async () => {
    const scenario = await first(turns("{event: response}"));
    expect(scenario.turns[0]!.expect[0]!.checkFrom).toEqual("previous");
  });

  test("test_turn_start_is_accepted", async () => {
    const scenario = await first(turns("{event: response, check_from: turn_start}"));
    expect(scenario.turns[0]!.expect[0]!.checkFrom).toEqual("turn_start");
  });

  test("test_other_values_are_rejected", async () => {
    const e = await rejection(() => first(turns("{event: response, check_from: later}")));
    expect(e.message).toContain("'check_from:' must be one of previous, turn_start");
  });

  test("test_not_combined_with_absent", async () => {
    const e = await rejection(() =>
      first(turns("{event: response, absent: true, check_from: turn_start}")),
    );
    expect(e.message).toContain("cannot be combined with 'check_from'");
  });
});
