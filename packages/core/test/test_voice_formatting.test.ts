// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_voice_formatting.py

import { describe, expect, test } from "bun:test";

import { alnumOnly } from "../src/utils/text/alnum_utils.ts";
import { normalizeAcronyms } from "../src/utils/text/transforms/acronyms.ts";
import { expandCurrency } from "../src/utils/text/transforms/currency.ts";
import { normalizeDates } from "../src/utils/text/transforms/dates.ts";
import { emailToSpeech } from "../src/utils/text/transforms/email.ts";
import { expandNumbers } from "../src/utils/text/transforms/numbers.ts";
import { expandPercentages } from "../src/utils/text/transforms/percentages.ts";
import { expandPhoneNumbers } from "../src/utils/text/transforms/phone.ts";
import { replaceText } from "../src/utils/text/transforms/replacements.ts";
import { StripMarkdown, stripMarkdown } from "../src/utils/text/transforms/strip_markdown.ts";
import { expandUnits } from "../src/utils/text/transforms/units.ts";
import { VoiceFormatter } from "../src/utils/text/transforms/voice_formatter.ts";

describe("TestStripMarkdown", () => {
  test("test_bold", async () => {
    const result = await stripMarkdown("**Hello** world", "*");
    expect(result).toEqual("Hello world");
  });

  test("test_italic_asterisk", async () => {
    const result = await stripMarkdown("*italic*", "*");
    expect(result).toEqual("italic");
  });

  test("test_italic_underscore", async () => {
    const result = await stripMarkdown("_italic_", "*");
    expect(result).toEqual("italic");
  });

  test("test_headers", async () => {
    const result = await stripMarkdown("# Title\n\nBody", "*");
    expect(result).not.toContain("#");
    expect(result).toContain("Title");
  });

  test("test_inline_code", async () => {
    const result = await stripMarkdown("`code`", "*");
    expect(result).toEqual("code");
  });

  test("test_alnum_preserving", async () => {
    const text = "**Hello** and _world_";
    const result = await stripMarkdown(text, "*");
    expect(alnumOnly(result)).toEqual(alnumOnly(text));
  });

  test("test_no_change_to_plain_text", async () => {
    const text = "Hello world";
    const result = await stripMarkdown(text, "*");
    expect(result).toEqual(text);
  });

  test("test_content_asterisks_kept", async () => {
    const cases: Record<string, string> = {
      "Press * then #": "Press * then #",
      "5 * 3 = 15": "5 * 3 = 15",
      "2 * 3 * 4 = 24": "2 * 3 * 4 = 24",
      "Use the * key, then * again": "Use the * key, then * again",
      "2*3*4 is 24": "2*3*4 is 24",
      "2**3 is 8": "2**3 is 8",
      "Type \\*literal\\* asterisks": "Type *literal* asterisks",
    };
    for (const [text, expected] of Object.entries(cases)) {
      expect(await stripMarkdown(text, "*"), text).toEqual(expected);
    }
  });

  test("test_list_bullets", async () => {
    const cases: Record<string, string> = {
      "\n- Coffee for three dollars.": "\nCoffee for three dollars.",
      "- Step one.\n    - Sub step.": "Step one.\n    Sub step.",
      "* item one\n* item two": "item one\nitem two",
      "+ plus item": "plus item",
      "1. First\n2. Second": "1. First\n2. Second",
      "a - b": "a - b",
    };
    for (const [text, expected] of Object.entries(cases)) {
      expect(await stripMarkdown(text, "*"), text).toEqual(expected);
    }
  });

  test("test_strikethrough_dropped", async () => {
    const cases: Record<string, string> = {
      "The price was ~~ten~~ eight dollars.": "The price was eight dollars.",
      "It is ~~not ready~~ ready now.": "It is ready now.",
      "~~Old.~~ New.": " New.",
      "About ~~ 5 minutes": "About ~~ 5 minutes",
      "Roughly ~5 minutes": "Roughly ~5 minutes",
    };
    for (const [text, expected] of Object.entries(cases)) {
      expect(await stripMarkdown(text, "*"), text).toEqual(expected);
    }
  });

  test("test_links_reduced_to_label", async () => {
    const cases: Record<string, string> = {
      "See [the docs](https://example.com/docs) here.": "See the docs here.",
      "See ![a cat](cat.png) here.": "See a cat here.",
      "Go to [example.com](https://example.com).": "Go to example.com.",
      "Visit https://example.com today": "Visit https://example.com today",
      "[**bold** link](x)": "bold link",
    };
    for (const [text, expected] of Object.entries(cases)) {
      expect(await stripMarkdown(text, "*"), text).toEqual(expected);
    }
  });

  test("test_links_kept", async () => {
    const keep = new StripMarkdown({ stripUrls: false });
    const text = "See [the docs](https://example.com/docs) here.";
    expect(await keep(text, "*")).toEqual(text);
  });

  test("test_horizontal_rules", async () => {
    const cases: Record<string, string> = {
      "First part.\n\n---\n\nSecond part.": "First part.\n\n\nSecond part.",
      "* * *\ntext": "text",
      "___\ntext": "text",
    };
    for (const [text, expected] of Object.entries(cases)) {
      expect(await stripMarkdown(text, "*"), text).toEqual(expected);
    }
  });
});

describe("TestExpandPhoneNumbers", () => {
  test("test_dashes", async () => {
    const result = await expandPhoneNumbers("Call 123-456-7890", "*");
    expect(result).toContain("1 2 3");
  });

  test("test_dots", async () => {
    const result = await expandPhoneNumbers("123.456.7890", "*");
    expect(result).toContain("1 2 3");
  });

  test("test_alnum_preserving", async () => {
    const text = "123-456-7890";
    const result = await expandPhoneNumbers(text, "*");
    expect(alnumOnly(result)).toEqual(alnumOnly(text));
  });

  test("test_no_change_to_non_phone", async () => {
    const text = "Hello world";
    const result = await expandPhoneNumbers(text, "*");
    expect(result).toEqual(text);
  });

  test("test_no_match_inside_longer_digit_sequence", async () => {
    // A 16-digit credit card number must not be treated as a phone number.
    const text = "Card 4111111111111111 is invalid";
    const result = await expandPhoneNumbers(text, "*");
    expect(result).toEqual(text);
  });
});

describe("TestNormalizeAcronyms", () => {
  test("test_nasa", async () => {
    const result = await normalizeAcronyms("NASA launched", "*");
    expect(result).toContain("N A S A");
  });

  test("test_http", async () => {
    const result = await normalizeAcronyms("HTTP request", "*");
    expect(result).toContain("H T T P");
  });

  test("test_alnum_preserving", async () => {
    const text = "NASA and HTTP";
    const result = await normalizeAcronyms(text, "*");
    expect(alnumOnly(result)).toEqual(alnumOnly(text));
  });

  test("test_does_not_split_camelcase", async () => {
    const text = "iPhone";
    const result = await normalizeAcronyms(text, "*");
    expect(result).toEqual(text);
  });
});

describe("TestReplaceText", () => {
  test("test_exact_match", async () => {
    const transform = replaceText([[String.raw`\bDr\.`, "Doctor"]]);
    const result = await transform("Dr. Smith", "*");
    expect(result).toContain("Doctor");
  });

  test("test_multiple_replacements", async () => {
    const transform = replaceText([
      [String.raw`\bSt\.`, "Street"],
      [String.raw`\bvs\b`, "versus"],
    ]);
    const result = await transform("Main St. vs Oak St.", "*");
    expect(result).toContain("Street");
    expect(result).toContain("versus");
  });

  test("test_no_match_unchanged", async () => {
    const transform = replaceText([["xyz", "abc"]]);
    const result = await transform("Hello world", "*");
    expect(result).toEqual("Hello world");
  });

  /** A replacement is allowed to turn one word into several. */
  test("test_word_splitting_replacement", async () => {
    const transform = replaceText([[String.raw`\bBODYPUMP\b`, "body pump"]]);
    const result = await transform("Try BODYPUMP on Monday morning.", "*");
    expect(result).toEqual("Try body pump on Monday morning.");
  });

  /** A replacement is allowed to change only the case of a word. */
  test("test_case_only_replacement", async () => {
    const transform = replaceText([[String.raw`\bSQL\b`, "sql"]]);
    const result = await transform("Contact SQL support today.", "*");
    expect(result).toEqual("Contact sql support today.");
  });

  test("test_inline_ipa_tag_replacement", async () => {
    const transform = replaceText([[String.raw`\bleisure\b`, "<<l|ɛ|ʒ|ə|r>>"]]);
    const result = await transform("The leisure centre opens at six.", "*");
    expect(result).toContain("<<l|ɛ|ʒ|ə|r>>");
  });

  /**
   * A word can be wrapped in an SSML phoneme tag (e.g. ElevenLabs'
   * <phoneme alphabet="ipa" ph="...">word</phoneme>) instead of respelled.
   */
  test("test_ssml_phoneme_tag_replacement", async () => {
    // Python's inline `(?i)` flag is a RegExp `i` flag in JavaScript.
    const transform = replaceText([
      [/\bSiobhan\b/i, '<phoneme alphabet="ipa" ph="ʃəˈvɔːn">Siobhan</phoneme>'],
    ]);
    const result = await transform("My name is Siobhan.", "*");
    expect(result).toContain('<phoneme alphabet="ipa" ph="ʃəˈvɔːn">Siobhan</phoneme>');
  });
});

/**
 * Whether alnumOnly() treats a case-only or word-splitting replacement as
 * unchanged. alnumOnly() lowercases text and drops whitespace/punctuation, so a
 * replacement that only changes case, or that splits one word into several,
 * normalizes identically on both sides even though the original text cannot be
 * recovered by simple proportional advancement.
 */
describe("TestNormalizeCollapsesCaseAndSplitReplacements", () => {
  test("test_word_split_normalizes_the_same_as_original", async () => {
    const transform = replaceText([[String.raw`\bBODYPUMP\b`, "body pump"]]);
    const result = await transform("BODYPUMP", "*");
    expect(alnumOnly(result)).toEqual(alnumOnly("BODYPUMP"));
  });

  test("test_case_change_normalizes_the_same_as_original", async () => {
    const transform = replaceText([[String.raw`\bSQL\b`, "sql"]]);
    const result = await transform("SQL", "*");
    expect(alnumOnly(result)).toEqual(alnumOnly("SQL"));
  });

  /**
   * Contrast case: a genuine 1-to-1 respelling ("leisure" -> "lezher") does
   * change the normalized alnum content, so it is correctly flagged as transformed.
   */
  test("test_pronunciation_respelling_does_not_normalize_the_same", async () => {
    const transform = replaceText([[String.raw`\bleisure\b`, "lezher"]]);
    const result = await transform("leisure", "*");
    expect(alnumOnly(result)).not.toEqual(alnumOnly("leisure"));
  });

  /**
   * An SSML phoneme tag wraps the word without altering it, so tag-stripped
   * normalization matches the original — unlike a respelling. (The wrapping
   * markup itself is still picked up as a transformed segment by
   * TextSegmentMap, not by alnumOnly() here.)
   */
  test("test_ssml_phoneme_tag_normalizes_the_same_as_original", async () => {
    const transform = replaceText([
      [String.raw`\bSiobhan\b`, '<phoneme alphabet="ipa" ph="ʃəˈvɔːn">Siobhan</phoneme>'],
    ]);
    const result = await transform("Siobhan", "*");
    expect(alnumOnly(result)).toEqual(alnumOnly("Siobhan"));
  });
});

describe("TestExpandPercentages", () => {
  test("test_integer_percent", async () => {
    const result = await expandPercentages("50% off", "*");
    expect(result).toContain("percent");
    expect(result).not.toContain("%");
  });

  test("test_decimal_percent", async () => {
    const result = await expandPercentages("3.5% rate", "*");
    expect(result).toContain("percent");
  });

  test("test_alnum_changes", async () => {
    const text = "50%";
    const result = await expandPercentages(text, "*");
    expect(alnumOnly(result)).not.toEqual(alnumOnly(text));
  });
});

describe("TestExpandUnits", () => {
  test("test_km", async () => {
    const result = await expandUnits("5km away", "*");
    expect(result).toContain("kilometers");
  });

  test("test_mph", async () => {
    const result = await expandUnits("60mph speed", "*");
    expect(result).toContain("miles per hour");
  });

  test("test_gb", async () => {
    const result = await expandUnits("2GB file", "*");
    expect(result).toContain("gigabytes");
  });

  test("test_no_match_unchanged", async () => {
    const result = await expandUnits("Hello world", "*");
    expect(result).toEqual("Hello world");
  });

  /** 'in' as a preposition after a number must not be treated as inches. */
  test("test_ambiguous_in_preposition_not_expanded", async () => {
    const result = await expandUnits("1 in 5 people", "*");
    expect(result).not.toContain("inches");
    expect(result).toEqual("1 in 5 people");
  });

  /** '9 in 10 dentists' must not expand 'in' to 'inches'. */
  test("test_ambiguous_in_ratio_not_expanded", async () => {
    const result = await expandUnits("9 in 10 dentists recommend it", "*");
    expect(result).not.toContain("inches");
  });

  /** 'm' alone after a number is highly ambiguous and must not be auto-expanded. */
  test("test_ambiguous_m_not_expanded_as_meters", async () => {
    const result = await expandUnits("1 m people voted", "*");
    expect(result).not.toContain("meters");
  });

  /** 'g' standing alone in prose must not expand to 'grams'. */
  test("test_ambiguous_g_not_expanded_as_grams", async () => {
    const result = await expandUnits("1 g of something", "*");
    expect(result).not.toContain("grams");
  });
});

/** A quantity of exactly one takes the singular form of the unit. */
describe("TestExpandUnitsSingular", () => {
  test("test_singular_forms", async () => {
    const cases: Record<string, string> = {
      "Only 1km left": "Only 1 kilometer left",
      "Only 1mi left": "Only 1 mile left",
      "Only 1ft left": "Only 1 foot left",
      "Only 1in left": "Only 1 inch left",
      "Only 1lb left": "Only 1 pound left",
      "Only 1gb left": "Only 1 gigabyte left",
      "Only 1mph left": "Only 1 mile per hour left",
    };
    for (const [text, expected] of Object.entries(cases)) {
      expect({ text, result: await expandUnits(text, "*") }).toEqual({ text, result: expected });
    }
  });

  test("test_singular_with_space", async () => {
    const result = await expandUnits("1 km away", "*");
    expect(result).toEqual("1 kilometer away");
  });

  test("test_plural_forms_kept", async () => {
    const cases: Record<string, string> = {
      "5km away": "5 kilometers away",
      "0.5 mi away": "0.5 miles away",
      "21 lb of flour": "21 pounds of flour",
    };
    for (const [text, expected] of Object.entries(cases)) {
      expect({ text, result: await expandUnits(text, "*") }).toEqual({ text, result: expected });
    }
  });

  /** A decimal such as "1.0" reads as plural in speech, unlike a bare "1". */
  test("test_decimal_one_is_plural", async () => {
    const result = await expandUnits("1.0km away", "*");
    expect(result).toEqual("1.0 kilometers away");
  });

  /** Units whose singular and plural forms match expand identically. */
  test("test_invariant_units_unchanged", async () => {
    expect(await expandUnits("1hz tone", "*")).toEqual("1 hertz tone");
    expect(await expandUnits("3 GHz processor", "*")).toEqual("3 gigahertz processor");
  });
});

/** Units that are unambiguous even with a space before them should still expand. */
describe("TestExpandUnitsUnambiguous", () => {
  test("test_km_with_space", async () => {
    const result = await expandUnits("5 km away", "*");
    expect(result).toContain("kilometers");
  });

  test("test_mph_with_space", async () => {
    const result = await expandUnits("60 mph speed limit", "*");
    expect(result).toContain("miles per hour");
  });

  test("test_ghz_with_space", async () => {
    const result = await expandUnits("3 GHz processor", "*");
    expect(result).toContain("gigahertz");
  });
});

describe("TestEmailToSpeech", () => {
  test("test_simple_email", async () => {
    const result = await emailToSpeech("user@example.com", "*");
    expect(result).toContain("at");
    expect(result).not.toContain("@");
  });

  test("test_dot_expanded", async () => {
    const result = await emailToSpeech("user@example.com", "*");
    expect(result).toContain("dot");
  });

  test("test_embedded_in_sentence", async () => {
    const result = await emailToSpeech("Email user@example.com today", "*");
    expect(result).toContain("at");
    expect(result).toContain("Email");
  });
});

describe("TestVoiceFormatter", () => {
  test("test_default_strips_markdown", async () => {
    const formatter = new VoiceFormatter();
    const result = await formatter("**Hello** world", "*");
    expect(result).not.toContain("**");
    expect(result).toContain("Hello");
  });

  test("test_disabled_option_skipped", async () => {
    const formatter = new VoiceFormatter({ stripMarkdown: false });
    const result = await formatter("**Hello**", "*");
    expect(result).toContain("**");
  });

  test("test_strip_urls_passthrough", async () => {
    const text = "See [the docs](https://example.com/docs) here.";
    const stripped = await new VoiceFormatter()(text, "*");
    const kept = await new VoiceFormatter({ stripUrls: false })(text, "*");
    expect(stripped).toEqual("See the docs here.");
    expect(kept).toContain("https://example.com/docs");
  });

  test("test_custom_replacements_applied", async () => {
    const formatter = new VoiceFormatter({
      stripMarkdown: false,
      expandPhoneNumbers: false,
      normalizeAcronyms: false,
      expandCurrency: false,
      expandPercentages: false,
      expandUnits: false,
      emailToSpeech: false,
      normalizeDates: false,
      customReplacements: [[String.raw`\bDr\.`, "Doctor"]],
    });
    const result = await formatter("Dr. Smith", "*");
    expect(result).toContain("Doctor");
  });

  test("test_all_disabled_no_change", async () => {
    const formatter = new VoiceFormatter({
      stripMarkdown: false,
      expandPhoneNumbers: false,
      normalizeAcronyms: false,
      expandCurrency: false,
      expandPercentages: false,
      expandUnits: false,
      emailToSpeech: false,
      normalizeDates: false,
      expandNumbers: false,
    });
    const text = "Hello world";
    const result = await formatter(text, "*");
    expect(result).toEqual(text);
  });

  test("test_expand_numbers_enabled", async () => {
    const formatter = new VoiceFormatter({ expandNumbers: true, numberDigitCutoff: 2025 });
    expect(await formatter("Room 42", "*")).toContain("forty-two");
  });

  test("test_all_caps_email_not_mangled_by_acronym_expander", async () => {
    // emailToSpeech must run before normalizeAcronyms so all-caps addresses
    // like USER@EXAMPLE.COM are detected before letters are spaced out.
    const formatter = new VoiceFormatter();
    const result = await formatter("Contact USER@EXAMPLE.COM today", "*");
    expect(result).toContain("at");
    expect(result).not.toContain("@");
  });

  test("test_uppercase_unit_not_broken_by_acronym_expander", async () => {
    // expandUnits must run before normalizeAcronyms so "100 MB" is expanded
    // to "100 megabytes" before "MB" gets letter-spaced to "M B".
    const formatter = new VoiceFormatter();
    const result = await formatter("100 MB file", "*");
    expect(result).toContain("megabytes");
    expect(result).not.toContain("M B");
  });
});

describe("TestExpandCurrency", () => {
  test("test_dollars_and_cents", async () => {
    const result = await expandCurrency("Your balance is $42.50", "*");
    expect(result).toContain("forty-two dollars");
    expect(result).toContain("fifty cents");
    expect(result).not.toContain("$");
  });

  test("test_singular_unit", async () => {
    // "$1" -> "one dollar" (singular), not "one dollars".
    expect(await expandCurrency("$1", "*")).toEqual("one dollar");
  });

  test("test_singular_subunit", async () => {
    // "£1.01" -> singular pound + singular penny.
    const result = await expandCurrency("£1.01", "*");
    expect(result).toContain("one pound");
    expect(result).toContain("one penny");
  });

  test("test_zero_cents_omitted", async () => {
    // A ".00" fraction must not produce "and zero cents".
    const result = await expandCurrency("$5.00", "*");
    expect(result).toContain("five dollars");
    expect(result).not.toContain("cent");
  });

  test("test_subunit_less_currency_drops_fraction", async () => {
    // Yen has no subunit, so the fractional part is dropped.
    const result = await expandCurrency("¥500.50", "*");
    expect(result).toContain("five hundred yen");
    expect(result).not.toContain("cent");
  });

  test("test_thousands_separator", async () => {
    const result = await expandCurrency("$1,000", "*");
    expect(result).toContain("one thousand dollars");
    expect(result).not.toContain("1,000");
  });

  test("test_multi_digit_without_separator", async () => {
    // Regression: 4+ digit amounts without commas must capture the full integer.
    // The integer group needs a \b so the regex backtracks onto the \d+ branch
    // instead of matching only the first 3 digits and leaving a stray digit.
    expect(await expandCurrency("$1000", "*")).toEqual("one thousand dollars");
    const result = await expandCurrency("$1000.50", "*");
    expect(result).toContain("one thousand dollars");
    expect(result).toContain("fifty cents");
  });

  test("test_extra_fractional_digits_not_leaked", async () => {
    // Regression: a fraction with 3+ digits must be fully consumed by the match,
    // read to cent precision, with no stray digit glued onto the subunit word.
    const result = await expandCurrency("The item costs $5.500 today", "*");
    expect(result).toEqual("The item costs five dollars and fifty cents today");
    expect(result).not.toContain("cents0");
    // Sub-cent precision is dropped (read like a 2-digit amount), not spoken.
    expect(await expandCurrency("$3.567", "*")).toEqual("three dollars and fifty-six cents");
    expect(await expandCurrency("£1.999", "*")).toEqual("one pound and ninety-nine pence");
  });
});

describe("TestNormalizeDates", () => {
  test("test_iso_date", async () => {
    const result = await normalizeDates("Meeting on 2023-05-10", "*");
    expect(result).toContain("May 10th");
    expect(result).toContain("twenty-three"); // year expanded to words
    expect(result).not.toContain("2023-05-10");
  });

  test("test_us_date_slash", async () => {
    const result = await normalizeDates("Meeting on 05/10/2023", "*");
    expect(result).toContain("May 10th");
    expect(result).not.toContain("05/10/2023");
  });

  test("test_us_date_dash", async () => {
    const result = await normalizeDates("Meeting on 05-10-2023", "*");
    expect(result).toContain("May 10th");
    expect(result).not.toContain("05-10-2023");
  });

  test("test_invalid_date_unchanged", async () => {
    // An out-of-range month/day makes date construction fail, so the text passes
    // through unchanged — checked for both the ISO and US replacement paths.
    const iso = "Order 2023-13-45 shipped";
    expect(await normalizeDates(iso, "*")).toEqual(iso);
    const us = "Due 13/45/2023 now";
    expect(await normalizeDates(us, "*")).toEqual(us);
  });

  test("test_ordinal_teens_use_th", async () => {
    // 11/12/13 take the "th" suffix, not st/nd/rd.
    expect(await normalizeDates("2023-05-11", "*")).toContain("11th");
    expect(await normalizeDates("2023-05-12", "*")).toContain("12th");
    expect(await normalizeDates("2023-05-13", "*")).toContain("13th");
  });

  test("test_ordinal_suffixes", async () => {
    expect(await normalizeDates("2023-05-01", "*")).toContain("1st");
    expect(await normalizeDates("2023-05-21", "*")).toContain("21st");
    expect(await normalizeDates("2023-05-02", "*")).toContain("2nd");
    expect(await normalizeDates("2023-05-03", "*")).toContain("3rd");
  });

  test("test_month_is_english_under_non_english_locale", async () => {
    // The month must stay English even when LC_TIME is a non-English locale,
    // to match the hardcoded-English year and ordinal suffix. JavaScript has no
    // process-wide setlocale(); the closest equivalent is the LC_TIME / LC_ALL
    // environment, which is set for the duration of the call.
    const saved = { LC_TIME: process.env.LC_TIME, LC_ALL: process.env.LC_ALL };
    process.env.LC_TIME = "de_DE.UTF-8";
    process.env.LC_ALL = "de_DE.UTF-8";
    let result: string;
    try {
      result = await normalizeDates("Meeting on 2023-05-10", "*");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(result).toContain("May 10th");
    expect(result).not.toContain("Mai");
  });
});

describe("TestExpandNumbers", () => {
  test("test_below_cutoff_expands_to_words", async () => {
    const result = await expandNumbers(2025)("Room 42", "*");
    expect(result).toContain("forty-two");
  });

  test("test_above_cutoff_read_digit_by_digit", async () => {
    const result = await expandNumbers(2025)("opens in 2026", "*");
    expect(result).toContain("2 0 2 6");
  });

  test("test_cutoff_is_inclusive", async () => {
    // The cutoff uses `>` not `>=`, so a number equal to it is still expanded.
    const result = await expandNumbers(2025)("2025", "*");
    expect(result).toContain("thousand");
    expect(result).not.toContain("2 0 2 5");
  });

  test("test_decimal_expands", async () => {
    const result = await expandNumbers(null)("3.5", "*");
    expect(result).toContain("three point five");
  });

  test("test_none_cutoff_expands_all", async () => {
    const result = await expandNumbers(null)("9999", "*");
    expect(result).not.toContain("9999");
    expect(result).toContain("thousand");
  });

  test("test_above_cutoff_decimal_preserves_fraction", async () => {
    // Integer part above cutoff → digit-by-digit; fraction must not be dropped.
    const result = await expandNumbers(2025)("3000.5 units", "*");
    expect(result).toContain("3 0 0 0");
    expect(result).toContain("point");
    expect(result).toContain("5");
    expect(result).not.toContain("3000");
  });

  test("test_above_cutoff_multi_digit_fraction", async () => {
    const result = await expandNumbers(2025)("2500.75", "*");
    expect(result).toContain("2 5 0 0");
    expect(result).toContain("point");
    expect(result).toContain("7 5");
  });

  test("test_trailing_fractional_zero_is_spoken", async () => {
    // Every written digit is spoken, trailing zeros included -- the above-cutoff
    // branch reads fractions the same way.
    const transform = expandNumbers(2025);
    const cases: Record<string, string> = {
      "1.0": "one point zero",
      "1.00": "one point zero zero",
      "2.0": "two point zero",
      "0.50": "zero point five zero",
      "1.10": "one point one zero",
      "10.0": "ten point zero",
    };
    for (const [text, expected] of Object.entries(cases)) {
      expect({ text, result: await transform(text, "*") }).toEqual({ text, result: expected });
    }
  });

  test("test_fractions_without_trailing_zeros_unchanged", async () => {
    // The digit-by-digit reading covers every decimal, not just the ones with a
    // trailing zero.
    const transform = expandNumbers(null);
    const cases: Record<string, string> = {
      "3.5": "three point five",
      "1.05": "one point zero five",
      "1.25": "one point two five",
      "12.345": "twelve point three four five",
      "5.0001": "five point zero zero zero one",
    };
    for (const [text, expected] of Object.entries(cases)) {
      expect({ text, result: await transform(text, "*") }).toEqual({ text, result: expected });
    }
  });
});

/**
 * `expandUnits` and `expandNumbers` have to agree on decimal quantities.
 *
 * `expandUnits` keeps the plural for a decimal such as "1.0" because it reads as
 * "one point zero" in speech, and `expandNumbers` runs after it in the default
 * `VoiceFormatter` order. Both have to spell the decimal out the same way, or the
 * composed output is ungrammatical: "one kilometers".
 */
describe("TestUnitsAndNumbersComposition", () => {
  test("test_decimal_one_agrees_with_plural_unit", async () => {
    const formatter = new VoiceFormatter({ expandNumbers: true });
    const cases: Record<string, string> = {
      "1.0km left": "one point zero kilometers left",
      "1.0kg of flour": "one point zero kilograms of flour",
      "1.0 mi away": "one point zero miles away",
      "1.00km left": "one point zero zero kilometers left",
    };
    for (const [text, expected] of Object.entries(cases)) {
      expect({ text, result: await formatter(text, "*") }).toEqual({ text, result: expected });
    }
  });

  test("test_singular_and_plural_quantities_still_agree", async () => {
    const formatter = new VoiceFormatter({ expandNumbers: true });
    const cases: Record<string, string> = {
      "1km left": "one kilometer left",
      "2.0km left": "two point zero kilometers left",
      "1.5km left": "one point five kilometers left",
      "1.0hz tone": "one point zero hertz tone",
    };
    for (const [text, expected] of Object.entries(cases)) {
      expect({ text, result: await formatter(text, "*") }).toEqual({ text, result: expected });
    }
  });
});
