// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_expression_instructions.py

/** Tests for the instruction that teaches an LLM to write expression tags. */

import { expect, test } from "bun:test";
import {
  ExpressionCapabilities,
  ExpressionDelivery,
  ExpressionSound,
  ExpressionTerm,
  SPEED_DELIVERY,
} from "../src/expressive/expression.ts";
import { expressionInstructions, expressionPolicyWarning } from "../src/expressive/instructions.ts";
import { PerceptionCapabilities, PerceptionTerm } from "../src/expressive/perception.ts";
import {
  ExpressionGuidance,
  ExpressionPolicy,
  type ExpressionPolicyOptions,
} from "../src/expressive/policy.ts";
import { ValidationError } from "../src/processors/frameworks/rtvi/models.ts";

const FIXED = new ExpressionCapabilities({
  sounds: [new ExpressionTerm({ name: "laughter" })],
  delivery: [
    new ExpressionTerm({ name: "calm" }),
    new ExpressionTerm({ name: "happy" }),
    new ExpressionTerm({ name: "sad" }),
  ],
  pauseRangeMs: [100, 5000],
  serviceVocabulary: {
    [ExpressionDelivery.WARM]: ["happy"],
    [ExpressionSound.LAUGH]: ["laughter"],
  },
});

const FREE_TEXT = new ExpressionCapabilities({
  sounds: [
    new ExpressionTerm({ name: "laughs" }),
    new ExpressionTerm({ name: "woo", description: "an excited whoop" }),
  ],
  delivery: [
    new ExpressionTerm({ name: "excited" }),
    new ExpressionTerm({ name: "whispers", description: "speaking in a whisper" }),
  ],
  allowsFreeText: true,
  emphasis: true,
  serviceVocabulary: { [ExpressionDelivery.WHISPERING]: ["whispers"] },
});

test("test_nothing_is_taught_for_a_service_that_performs_nothing", () => {
  expect(expressionInstructions(null)).toBeNull();
  expect(expressionInstructions(new ExpressionCapabilities())).toBeNull();
});

test("test_a_service_is_offered_the_core_universal_names_it_performs", () => {
  const instructions = expressionInstructions(FIXED);

  expect(instructions).toContain(
    "Use only these deliveries, written exactly as listed: <<calm>>, <<warm>>, <<sad>>.",
  );
  expect(instructions).toContain("Use only these sounds, written exactly as listed: [[laugh]].");
});

test("test_a_service_that_performs_delivery_is_taught_spans", () => {
  const instructions = expressionInstructions(FIXED);

  expect(instructions).toContain("- <<calm: A B 7>> speaks just the words after the colon, A B 7");
  expect(
    expressionInstructions(
      new ExpressionCapabilities({
        sounds: [new ExpressionTerm({ name: "laughter" })],
        serviceVocabulary: { [ExpressionSound.LAUGH]: ["laughter"] },
      }),
    ),
  ).not.toContain("speaks just the words after the colon");
});

test("test_a_free_text_service_is_offered_universal_names_as_the_only_choices", () => {
  const instructions = expressionInstructions(FREE_TEXT);

  expect(instructions).toContain(
    "Use only these deliveries, written exactly as listed: <<calm>>, <<sympathetic>>, " +
      "<<apologetic>>, <<warm>>, <<excited>>, <<surprised>>, <<sad>>, <<grateful>>, " +
      "<<curious>>, <<confident>>, <<slow>>, <<fast>>.",
  );
  expect(instructions).toContain(
    "Use only these sounds, written exactly as listed: [[laugh]], [[chuckle]], [[sigh]].",
  );
  expect(instructions).not.toContain("Others work too");
});

test("test_a_breath_is_offered_only_to_a_policy_that_asks_for_breaths", () => {
  const breathes = new ExpressionPolicy({ guidance: [ExpressionGuidance.BREATHE] });

  expect(expressionInstructions(FREE_TEXT)).not.toContain("[[breath]]");
  expect(expressionInstructions(FREE_TEXT, breathes)).toContain("[[sigh]], [[breath]].");
});

test("test_only_the_controls_a_service_performs_are_taught", () => {
  const fixed = expressionInstructions(FIXED);
  const freeText = expressionInstructions(FREE_TEXT);

  expect(fixed).not.toContain("^^word^^");
  expect(fixed).toContain("[[pause 500]]");
  expect(freeText).toContain("^^word^^ stresses a word.");
  expect(freeText).not.toContain("[[pause");
});

test("test_a_policy_narrows_a_fixed_list_in_its_own_order", () => {
  const policy = new ExpressionPolicy({ delivery: ["sad", "relieved", "calm"], sounds: [] });

  const instructions = expressionInstructions(FIXED, policy);

  expect(instructions).toContain("exactly as listed: <<sad>>, <<calm>>.");
  expect(instructions).not.toContain("[[sound]]");
});

test("test_a_policy_names_any_delivery_for_a_free_text_service", () => {
  const policy = new ExpressionPolicy({ delivery: ["whispering", "relieved"] });

  const instructions = expressionInstructions(FREE_TEXT, policy);

  // A universal name is described as the service describes its own name for it.
  expect(instructions).toContain(
    "exactly as listed: <<whispering>> (speaking in a whisper), <<relieved>>.",
  );
});

test("test_nothing_is_taught_when_a_policy_offers_nothing_performable", () => {
  const capabilities = new ExpressionCapabilities({
    delivery: [new ExpressionTerm({ name: "calm" })],
  });
  const policy = new ExpressionPolicy({
    guidance: [ExpressionGuidance.MATCH_STYLE],
    delivery: ["relieved"],
  });

  expect(expressionInstructions(capabilities, policy)).toBeNull();
});

test("test_guidance_follows_the_tags_in_order", () => {
  const policy = new ExpressionPolicy({
    guidance: [ExpressionGuidance.MATCH_STYLE, "Never laugh while discussing billing."],
  });

  const instructions = expressionInstructions(FIXED, policy);

  expect(
    instructions?.endsWith(
      `\n\n${ExpressionGuidance.MATCH_STYLE}\nNever laugh while discussing billing.`,
    ),
  ).toBe(true);
});

test("test_neutral_in_a_policy_is_taught_on_its_own_line", () => {
  const instructions = expressionInstructions(
    FIXED,
    new ExpressionPolicy({ delivery: ["neutral", "calm"] }),
  );

  expect(instructions).toContain("exactly as listed: <<calm>>.");
  expect(instructions).toContain("<<neutral>> returns to your normal voice.");
});

test("test_a_service_that_performs_speed_is_offered_slow_with_when_to_use_it", () => {
  const capabilities = new ExpressionCapabilities({
    delivery: [new ExpressionTerm({ name: "calm" }), ...SPEED_DELIVERY],
  });
  const policy = new ExpressionPolicy({
    guidance: [ExpressionGuidance.SLOW_FOR_DETAILS],
    delivery: ["calm", "slow"],
  });

  const instructions = expressionInstructions(capabilities, policy);

  expect(instructions).toContain(
    "<<slow>> (to say something carefully, such as a number, a code or an address)",
  );
  // A span is shown slowing a detail, as details are said.
  expect(instructions).toContain("- <<slow: A B 7>> speaks just the words after the colon");
  expect(instructions?.endsWith(ExpressionGuidance.SLOW_FOR_DETAILS.value)).toBe(true);
});

test("test_a_free_text_service_with_no_examples_is_offered_the_core_names", () => {
  const capabilities = new ExpressionCapabilities({ allowsFreeText: true });

  const instructions = expressionInstructions(capabilities);

  expect(instructions).toContain("written exactly as listed: <<calm>>, <<sympathetic>>,");
  expect(instructions).toContain("- <<slow: A B 7>> speaks just the words after the colon");
  expect(instructions).toContain("written exactly as listed: [[laugh]], [[chuckle]], [[sigh]].");
});

test("test_a_free_text_service_is_taught_none_of_a_kind_the_policy_names_none_of", () => {
  const capabilities = new ExpressionCapabilities({ allowsFreeText: true, emphasis: true });

  const instructions = expressionInstructions(
    capabilities,
    new ExpressionPolicy({ delivery: [], sounds: [] }),
  );

  expect(instructions).toEqual(
    "You can direct how your words are spoken with tags:\n- ^^word^^ stresses a word.",
  );
});

test("test_a_policy_keeps_presets_apart_from_lines_with_the_same_text", () => {
  const policy = new ExpressionPolicy({
    guidance: [ExpressionGuidance.MATCH_STYLE, String(ExpressionGuidance.MATCH_STYLE)],
  });

  const [preset, line] = policy.guidance;
  expect(preset).toBeInstanceOf(ExpressionGuidance);
  expect(line).not.toBeInstanceOf(ExpressionGuidance);
  // DIVERGENCE: a preset is a class instance, not a `str`, so it equals the
  // line by its text (see `ExpressionGuidance`).
  expect(String(preset)).toEqual(line as string);
});

test.each(["guidance", "delivery", "sounds"])(
  "test_a_policy_list_given_as_a_bare_string_is_rejected[%s]",
  (field) => {
    // A bare string would otherwise be offered letter by letter.
    expect(
      () => new ExpressionPolicy({ [field]: "calm" } as unknown as ExpressionPolicyOptions),
    ).toThrow(ValidationError);
  },
);

const PERCEPTION = new PerceptionCapabilities({
  signals: [
    new PerceptionTerm({ name: "tone", labels: ["positive", "neutral", "sad", "frustrated"] }),
    new PerceptionTerm({ name: "speech_rate", description: "Words per second." }),
  ],
});

test("test_perception_is_taught_with_an_example_and_its_signals", () => {
  const instructions = expressionInstructions(null, null, { perception: PERCEPTION });

  expect(instructions).toContain(
    "in parentheses, such as ([tone positive=0.86, neutral=0.10]), each",
  );
  expect(instructions).toContain("A reading below 0.5 is a guess: don't act on it.");
  expect(
    instructions?.endsWith(
      "- tone: positive, neutral, sad, frustrated.\n- speech_rate: Words per second.",
    ),
  ).toBe(true);
});

test("test_perception_comes_before_the_tags_and_the_guidance_last", () => {
  const policy = new ExpressionPolicy({ guidance: [ExpressionGuidance.MATCH_STYLE] });

  const instructions = expressionInstructions(FIXED, policy, { perception: PERCEPTION }) as string;

  const reading = instructions.indexOf("([tone");
  const tags = instructions.indexOf("You can direct how your words are spoken");
  expect(reading).toBeGreaterThanOrEqual(0);
  expect(reading).toBeLessThan(tags);
  expect(tags).toBeLessThan(instructions.indexOf(ExpressionGuidance.MATCH_STYLE.value));
});

test("test_only_the_developer_guidance_is_kept_for_perception_without_tags", () => {
  const policy = new ExpressionPolicy({
    guidance: [
      ExpressionGuidance.MATCH_STYLE,
      "If the user sounds frustrated, apologize once.",
      ExpressionGuidance.SLOW_FOR_DETAILS,
    ],
  });

  const instructions = expressionInstructions(null, policy, { perception: PERCEPTION });

  expect(instructions?.endsWith("\n\nIf the user sounds frustrated, apologize once.")).toBe(true);
  expect(instructions).not.toContain(ExpressionGuidance.MATCH_STYLE.value);
  expect(instructions).not.toContain("<<slow");
});

test("test_no_warning_without_a_policy_or_when_every_tag_is_performable", () => {
  expect(expressionPolicyWarning(FIXED, null)).toBeNull();
  expect(expressionPolicyWarning(null, null)).toBeNull();
  expect(expressionPolicyWarning(FIXED, new ExpressionPolicy({ delivery: ["calm"] }))).toBeNull();
  // A free-text service performs any delivery or sound it's given.
  expect(
    expressionPolicyWarning(FREE_TEXT, new ExpressionPolicy({ delivery: ["relieved"] })),
  ).toBeNull();
});

test("test_a_warning_names_the_policy_tags_the_service_cant_perform", () => {
  const policy = new ExpressionPolicy({
    delivery: ["neutral", "calm", "relieved"],
    sounds: ["sighs"],
  });

  const warning = expressionPolicyWarning(FIXED, policy);

  // Every service returns to its baseline, so neutral is never left out.
  expect(warning).toEqual(
    "the TTS service can't perform <<relieved>>, [[sighs]] from the expression " +
      "policy, so they aren't offered",
  );
});

test("test_a_warning_says_when_the_service_performs_none_of_the_policy", () => {
  const capabilities = new ExpressionCapabilities({
    delivery: [new ExpressionTerm({ name: "calm" })],
  });
  const expected =
    "the TTS service performs none of the expression policy's tags, so they " +
    "and its guidance presets aren't taught";

  expect(
    expressionPolicyWarning(capabilities, new ExpressionPolicy({ delivery: ["relieved"] })),
  ).toEqual(expected);
  expect(expressionPolicyWarning(null, new ExpressionPolicy())).toEqual(expected);
});

test("test_a_developer_line_with_a_presets_text_is_kept_for_perception_without_tags", () => {
  const line = String(ExpressionGuidance.MATCH_STYLE);

  const instructions = expressionInstructions(null, new ExpressionPolicy({ guidance: [line] }), {
    perception: PERCEPTION,
  });

  expect(instructions?.endsWith(`\n\n${line}`)).toBe(true);
});
