// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_expression_formatter.py

/** Tests for reading expression tags and formatting them for a TTS service. */

import { describe, expect, test } from "bun:test";

import { BaseExpressionAdapter } from "@pipedog/core/adapters/tts/base_expression_adapter";
import {
  DeliveryScope,
  ExpressionCapabilities,
  ExpressionTerm,
} from "@pipedog/core/expressive/expression";
import {
  EXPRESSION_TAG_PATTERN,
  EXPRESSION_TAGS,
  ExpressionFormatter,
  ExpressionSpan,
  type Segment,
  Sound,
  stripExpressionTags,
  Text,
} from "@pipedog/core/expressive/formatter";
import { TextType } from "@pipedog/core/utils/text/base_text_aggregator";
import { SkipTagsAggregator } from "@pipedog/core/utils/text/skip_tags_aggregator";

import { ElevenLabsAudioTagExpressionAdapter } from "../../elevenlabs/src/elevenlabs_adapter.ts";
import { MiniMaxExpressionAdapter } from "../../minimax/src/minimax_adapter.ts";
import { CartesiaExpressionAdapter } from "../src/cartesia_adapter.ts";

interface DeclaredAdapterOptions {
  sounds?: string[];
  delivery?: string[];
  deliveryScope?: DeliveryScope;
}

/** Declares sounds and delivery, and formats delivery as <delivery> where it changes. */
class DeclaredAdapter extends BaseExpressionAdapter {
  sounds: string[];
  delivery: string[];
  deliveryScope: DeliveryScope;

  constructor(options: DeclaredAdapterOptions = {}) {
    super();
    this.sounds = [...(options.sounds ?? [])];
    this.delivery = [...(options.delivery ?? [])];
    this.deliveryScope = options.deliveryScope ?? DeliveryScope.ANYWHERE;
  }

  override capabilities(): ExpressionCapabilities {
    return new ExpressionCapabilities({
      sounds: this.sounds.map((name) => new ExpressionTerm({ name })),
      delivery: this.delivery.map((name) => new ExpressionTerm({ name })),
      pauseRangeMs: [100, 1000],
      emphasis: true,
      deliveryScope: this.deliveryScope,
    });
  }

  override formatText(text: string, delivery: string[], previousDelivery: string[] | null): string {
    const previous = previousDelivery ?? [];
    const changed =
      delivery.length !== previous.length || delivery.some((d, i) => d !== previous[i]);
    return changed && delivery.length > 0 ? `<${delivery.join(",")}> ${text}` : text;
  }

  override formatSound(name: string): string {
    return ` <${name}> `;
  }
}

function formatter(options: DeclaredAdapterOptions = {}): ExpressionFormatter {
  const adapter = new DeclaredAdapter(options);
  return new ExpressionFormatter(() => adapter, { owner: "tts" });
}

type Shape = [string, string | number] | [string, string, string[]];

/** A Text segment, compared without its position. */
function words(text: string, delivery: readonly string[]): Shape {
  return ["text", text, [...delivery]];
}

function shape(segment: Segment): Shape {
  if (segment instanceof Text) {
    return words(segment.text, segment.delivery);
  }
  if (segment instanceof Sound) {
    return ["sound", segment.name];
  }
  return ["pause", segment.durationMs];
}

function parse(text: string, options: DeclaredAdapterOptions = {}): Shape[] {
  return formatter(options)
    .parse(text)
    .map((s) => shape(s));
}

const REPLY =
  "<<apologetic>> I'm so sorry about the outage. <<enunciate>> Your ticket is 2, 3, 8, 7. " +
  "[[pause 600]] <<cheerful>> The good news is it's ^^back up^^ now. [[laugh]] Finally!";

test("test_a_reply_splits_into_words_with_their_delivery_and_sounds", () => {
  expect(parse(REPLY)).toEqual([
    words(" I'm so sorry about the outage. ", ["apologetic"]),
    words(" Your ticket is 2, 3, 8, 7. ", ["enunciate"]),
    ["pause", 600],
    words(" ", ["enunciate"]),
    words(" The good news is it's ", ["cheerful"]),
    words("back up", ["cheerful", "emphasis"]),
    words(" now. ", ["cheerful"]),
    ["sound", "laugh"],
    words(" Finally!", ["cheerful"]),
  ]);
});

test("test_each_segment_says_where_it_was_written", () => {
  for (const segment of formatter().parse(REPLY)) {
    const written = REPLY.slice(segment.start, segment.end);
    if (segment instanceof Text) {
      expect(written).toEqual(segment.text);
    } else {
      expect(written.startsWith("[[") && written.endsWith("]]")).toBe(true);
    }
  }
});

test("test_text_without_tags_is_in_the_baseline", () => {
  expect(parse("Hello there. How are you?")).toEqual([words("Hello there. How are you?", [])]);
});

test("test_a_delivery_name_may_be_several_words", () => {
  expect(parse("<<soft  tone>>Hi")).toEqual([words("Hi", ["soft tone"])]);
});

test("test_a_delivery_lasts_until_the_next_delivery_tag_across_units", () => {
  const parser = formatter();

  expect(parser.parse("<<calm>>One. ").map(shape)).toEqual([words("One. ", ["calm"])]);
  expect(parser.parse("Two. <<warm>>Three.").map(shape)).toEqual([
    words("Two. ", ["calm"]),
    words("Three.", ["warm"]),
  ]);
});

test("test_neutral_returns_to_the_baseline", () => {
  expect(parse("<<calm>>One. <<neutral>>Two.")).toEqual([
    words("One. ", ["calm"]),
    words("Two.", []),
  ]);
});

test("test_the_delivery_ends_with_the_response", () => {
  const parser = formatter();
  parser.parse("<<calm>>One.");
  parser.reset();

  expect(parser.parse("Two").map(shape)).toEqual([words("Two", [])]);
});

test("test_text_that_stands_on_its_own_leaves_the_responses_delivery", () => {
  const parser = formatter();
  parser.parse("<<calm>>One. ");

  expect(parser.parse("Hello.", { whole: true }).map(shape)).toEqual([words("Hello.", [])]);
  expect(parser.parse("Two.").map(shape)).toEqual([words("Two.", ["calm"])]);
});

test("test_a_delivery_tag_ending_the_text_says_nothing", () => {
  expect(parse("Bye! <<warm>>")).toEqual([words("Bye! ", [])]);
});

test("test_a_pause_is_a_duration_in_milliseconds", () => {
  expect(parse("[[pause 1500]]")).toEqual([["pause", 1500]]);
});

describe("test_anything_else_between_the_brackets_is_passed_on_as_written", () => {
  test.each<[string, Shape]>([
    ["[[pause]]x", ["sound", "pause"]],
    ["[[pause 800ms]]x", ["sound", "pause 800ms"]],
    ["[[clear throat]]x", ["sound", "clear throat"]],
    ["<<pause 500>>x", words("x", ["pause 500"])],
    ["<</cheerful>>x", words("x", ["/cheerful"])],
  ])("%p", (text, segment) => {
    expect(parse(text)[0]).toEqual(segment);
  });
});

test("test_a_declared_delivery_in_sound_brackets_sets_the_delivery", () => {
  expect(parse("[[cheerful]] Hi", { delivery: ["cheerful"] })).toEqual([
    words(" Hi", ["cheerful"]),
  ]);
});

test("test_a_declared_sound_in_delivery_brackets_stays_a_sound", () => {
  expect(parse("<<laugh>> Hi", { sounds: ["laugh"] })).toEqual([
    ["sound", "laugh"],
    words(" Hi", []),
  ]);
});

describe("test_text_that_only_looks_like_a_tag_is_spoken", () => {
  test.each([
    "He said [sic].",
    "Hi [cheerful] there.",
    "a < b",
    "a <b> c",
    "Shift it left: a << b.",
    "Brackets [[like this.]] stay text.",
  ])("%p", (text) => {
    expect(parse(text, { delivery: ["cheerful"] })).toEqual([words(text, [])]);
  });
});

test("test_a_span_adds_its_delivery_to_just_its_words", () => {
  expect(parse("<<calm>> Your code is <<slow: A B 7>>. Bye.")).toEqual([
    words(" Your code is ", ["calm"]),
    words("A B 7", ["calm", "slow"]),
    words(". Bye.", ["calm"]),
  ]);
});

test("test_a_neutral_span_speaks_its_words_in_the_baseline", () => {
  expect(parse("<<calm>> Say <<neutral: hi there>>, okay.")).toEqual([
    words(" Say ", ["calm"]),
    words("hi there", []),
    words(", okay.", ["calm"]),
  ]);
});

test("test_emphasis_in_a_span_is_added_to_its_delivery", () => {
  expect(parse("It's <<slow: A ^^B^^ 7>>.")).toEqual([
    words("It's ", []),
    words("A ", ["slow"]),
    words("B", ["slow", "emphasis"]),
    words(" 7", ["slow"]),
    words(".", []),
  ]);
});

test("test_emphasis_is_a_span_written_short", () => {
  expect(parse("Now ^^that's^^ it.")).toEqual(parse("Now <<emphasis: that's>> it."));
});

test("test_each_span_segment_says_where_it_was_written", () => {
  const text = "<<calm>> Your code is <<slow: A ^^B^^ 7>>, okay.";
  for (const segment of formatter().parse(text)) {
    expect(text.slice(segment.start, segment.end)).toEqual((segment as Text).text);
  }
});

test("test_a_span_left_unfinished_is_removed", () => {
  expect(parse("Your code is <<slow: A B")).toEqual([words("Your code is ", [])]);
});

test("test_word_tracking_passes_over_a_spans_markup_but_not_its_words", () => {
  const masked = "Code <<slow: A B>>, ok. <<calm>> [[laugh]] Bye.".replace(
    EXPRESSION_TAG_PATTERN,
    "#",
  );

  expect(masked).toEqual("Code #A B#, ok. # # Bye.");
});

test("test_a_tag_left_unfinished_is_removed", () => {
  expect(parse("Thanks for calling. <<chee")).toEqual([words("Thanks for calling. ", [])]);
  expect(parse("Thanks for calling. [[")).toEqual([words("Thanks for calling. ", [])]);
});

test("test_emphasis_is_added_to_the_active_delivery", () => {
  expect(parse("<<calm>>It's ^^fixed^^ now.")).toEqual([
    words("It's ", ["calm"]),
    words("fixed", ["calm", "emphasis"]),
    words(" now.", ["calm"]),
  ]);
});

describe("test_emphasis", () => {
  test.each([
    ["It's ^^back up^^.", "back up"],
    ["The code is ^^8492^^.", "8492"],
    ["^^Wow^^, nice.", "Wow"],
  ])("%p", (text, stressed) => {
    expect(parse(text)).toContainEqual(words(stressed, ["emphasis"]));
  });
});

describe("test_single_carets_and_asterisks_are_text", () => {
  test.each(["Two to the tenth is 2^10.", "a^b^c", "Thanks ^_^ bye", "It's ^fixed^ and *done*."])(
    "%p",
    (text) => {
      expect(parse(text)).toEqual([words(text, [])]);
    },
  );
});

test("test_emphasis_that_never_closes_is_spoken_plainly", () => {
  expect(parse("It's ^^back up")).toEqual([words("It's back up", [])]);
});

describe("test_an_aggregator_keeps_each_tag_in_one_unit", () => {
  test.each([TextType.TOKEN, TextType.SENTENCE])("%p", async (textType) => {
    const aggregator = new SkipTagsAggregator({ tags: EXPRESSION_TAGS, aggregationType: textType });
    const units: string[] = [];
    for (const chunk of ["<<chee", "rful>> It's [[la", "ugh]] ^^back", " up^", "^ now."]) {
      for await (const a of aggregator.aggregate(chunk)) {
        units.push(a.text);
      }
    }
    const flushed = await aggregator.flush();
    if (flushed) {
      units.push(flushed.text);
    }

    const parser = formatter();
    const segments = units.flatMap((unit) => parser.parse(unit).map(shape));
    expect(segments).toContainEqual(["sound", "laugh"]);
    expect(segments).toContainEqual(words("back up", ["cheerful", "emphasis"]));
  });
});

test("test_names_declared_after_the_formatter_is_made_are_known", () => {
  const adapter = new DeclaredAdapter();
  const expression = new ExpressionFormatter(() => adapter, { owner: "tts" });
  adapter.sounds = ["laugh"];

  // A declared sound keeps its kind in delivery brackets.
  const segments = expression.parse("<<laugh>> Hi.");

  expect(segments[0] instanceof Sound && segments[0].name === "laugh").toBe(true);
  expect(segments[1]).toBeInstanceOf(Text);
});

test("test_a_units_words_are_shown_without_its_tags", () => {
  const segments = formatter().parse("<<calm>> It's [[laugh]] fine. [[pause 400]]");

  expect(ExpressionFormatter.shownText(segments, TextType.SENTENCE)).toEqual("It's fine.");
  expect(ExpressionFormatter.shownText(segments, TextType.TOKEN)).toEqual(" It's fine. ");
});

async function same(words: string, _textType: TextType | string): Promise<string | null> {
  return words;
}

const identity = (w: string): string | null => w;

test("test_a_request_formats_what_the_service_performs_and_says_where", async () => {
  const expression = formatter({ sounds: ["laugh"], delivery: ["calm"] });
  const text = "<<calm>> Hi. [[laugh]] [[pause 50]]";

  const formatted = await expression.format(
    expression.parse(text),
    TextType.SENTENCE,
    same,
    identity,
  );
  const request = formatted.text;
  const spans = formatted.spans;

  expect(request).toEqual("<calm> Hi. <laugh>");
  expect(spans).toEqual([
    new ExpressionSpan({ start: 8, end: 13, delivery: ["calm"] }),
    new ExpressionSpan({ start: 13, end: 22, sound: [TextType.EXPRESSION_SOUND, "laugh"] }),
    new ExpressionSpan({ start: 22, end: 23, delivery: ["calm"] }),
    new ExpressionSpan({ start: 23, end: 35, sound: [TextType.EXPRESSION_PAUSE, "100"] }),
  ]);
});

describe("test_punctuation_after_a_tag_closes_the_words_before_it", () => {
  test.each([
    ["Hi [[laugh]], there.", "Hi, there.", "Hi, <laugh> there."],
    ["It's ^^back^^ [[laugh]]!", "It's back!", "It's <emphasis> back! <laugh>"],
    ["Hi[[laugh]], there.", "Hi, there.", "Hi, <laugh> there."],
    ["Well [[laugh]]... okay.", "Well... okay.", "Well... <laugh> okay."],
    ["Really [[laugh]]？ Yes.", "Really？ Yes.", "Really？ <laugh> Yes."],
    ["مرحبا [[laugh]]؟", "مرحبا؟", "مرحبا؟ <laugh>"],
    // A sound the service can't perform is removed the same way.
    ["Hi [[sigh]], there.", "Hi, there.", "Hi, there."],
    // Spacing the LLM wrote before the punctuation is kept.
    ["Hi [[laugh]] , there.", "Hi , there.", "Hi <laugh> , there."],
    ["It's [[laugh]] back.", "It's back.", "It's <laugh> back."],
    // So does punctuation after a span or a delivery tag.
    ["It's <<slow: A B 7>>, okay.", "It's A B 7, okay.", "It's <slow> A B 7, okay."],
    ["Hi <<calm>>, there.", "Hi, there.", "Hi, <calm> there."],
  ])("%p", async (text, shown, sent) => {
    const expression = formatter({ sounds: ["laugh"], delivery: ["calm", "slow"] });
    const segments = expression.parse(text);

    expect(ExpressionFormatter.shownText(segments, TextType.SENTENCE)).toEqual(shown);
    expect((await expression.format(segments, TextType.SENTENCE, same, identity)).text).toEqual(
      sent,
    );
  });
});

/** Closes each request with the delivery its last words are spoken in. */
class ClosingAdapter extends DeclaredAdapter {
  override formatEnd(delivery: string[]): string {
    return ` </${delivery.join(",")}>`;
  }
}

describe("test_a_sentence_request_is_closed_by_the_adapter", () => {
  test.each<[TextType, string]>([
    [TextType.SENTENCE, "</calm>"],
    [TextType.TOKEN, " up."],
  ])("%p", async (textType, endsWith) => {
    const adapter = new ClosingAdapter({ delivery: ["calm"] });
    const expression = new ExpressionFormatter(() => adapter, { owner: "tts" });

    const request = (
      await expression.format(expression.parse("<<calm>> It's back up."), textType, same, identity)
    ).text;

    // A streamed token is followed by more of the same request, so isn't closed.
    expect(request.endsWith(endsWith)).toBe(true);
  });
});

test("test_a_request_leaves_out_what_the_service_cant_perform", async () => {
  const expression = formatter();
  const segments = expression.parse("<<calm>> Hi. [[laugh]]", { whole: true });

  const formatted = await expression.format(segments, TextType.SENTENCE, same, identity);
  const request = formatted.text;
  const spans = formatted.spans;

  expect(request).toEqual("Hi.");
  expect(spans).toEqual([new ExpressionSpan({ start: 8, end: 13, delivery: [] })]);
});

test("test_a_span_sets_the_delivery_of_its_whole_request_on_a_sentence_service", async () => {
  const expression = formatter({
    delivery: ["calm", "slow"],
    deliveryScope: DeliveryScope.SENTENCE,
  });
  const segments = expression.parse("<<calm>> Your code is <<slow: A B 7>>, okay.");

  const formatted = await expression.format(segments, TextType.SENTENCE, same, identity);
  const request = formatted.text;
  const spans = formatted.spans;

  expect(request).toEqual("<calm,slow> Your code is A B 7, okay.");
  expect(new Set(spans.map((span) => JSON.stringify(span.delivery)))).toEqual(
    new Set([JSON.stringify(["calm", "slow"])]),
  );
});

test("test_emphasis_stays_on_its_words_on_a_sentence_service", async () => {
  const expression = formatter({ delivery: ["calm"], deliveryScope: DeliveryScope.SENTENCE });
  const segments = expression.parse("<<calm>> It's ^^back^^ now.");

  const formatted = await expression.format(segments, TextType.SENTENCE, same, identity);
  const request = formatted.text;
  const spans = formatted.spans;

  expect(request).toEqual("<calm> It's back now.");
  expect(new Set(spans.map((span) => JSON.stringify(span.delivery)))).toEqual(
    new Set([JSON.stringify(["calm"])]),
  );
});

test("test_tags_are_stripped_to_the_words_clients_are_shown", () => {
  expect(stripExpressionTags("<<cheerful>> It's [[laughs]] ^^back^^ up.")).toEqual("It's back up.");
  expect(stripExpressionTags("Hi [[laughs]], <<calm: there>>.")).toEqual("Hi, there.");
});

async function formattedWith(adapter: BaseExpressionAdapter, text: string) {
  const expression = new ExpressionFormatter(() => adapter, { owner: "tts" });
  return await expression.format(expression.parse(text), TextType.SENTENCE, same, identity);
}

test("test_a_universal_delivery_is_sent_by_the_services_name", async () => {
  const formatted = await formattedWith(
    new ElevenLabsAudioTagExpressionAdapter(),
    "<<warm>> Hi there.",
  );

  expect(formatted.text).toEqual("[warmly] Hi there.");
  expect(formatted.spans).toEqual([new ExpressionSpan({ start: 8, end: 18, delivery: ["warm"] })]);
});

test("test_a_universal_sound_is_sent_by_the_services_name", async () => {
  const formatted = await formattedWith(new CartesiaExpressionAdapter(), "Ha [[laugh]] okay.");

  expect(formatted.text).toContain("[laughter]");
  expect(formatted.spans).toContainEqual(
    new ExpressionSpan({ start: 3, end: 12, sound: [TextType.EXPRESSION_SOUND, "laugh"] }),
  );
});

test("test_a_delivery_sent_as_a_setting_is_named_as_the_service_names_it", async () => {
  const formatted = await formattedWith(new MiniMaxExpressionAdapter(), "<<warm>> Hi there.");

  expect(formatted.settings.emotion).toEqual("happy");
  expect(formatted.spans[0]!.delivery).toEqual(["warm"]);
});

test("test_a_name_of_the_services_own_is_sent_as_written", async () => {
  const formatted = await formattedWith(
    new ElevenLabsAudioTagExpressionAdapter(),
    "<<mischievously>> Hi there.",
  );

  expect(formatted.text).toEqual("[mischievously] Hi there.");
  expect(formatted.spans[0]!.delivery).toEqual(["mischievously"]);
});

test("test_a_universal_delivery_a_fixed_list_lacks_is_left_out", async () => {
  const formatted = await formattedWith(
    new MiniMaxExpressionAdapter(),
    "<<grateful>> Thanks so much.",
  );

  expect("emotion" in formatted.settings).toBe(false);
  expect(formatted.spans[0]!.delivery).toEqual([]);
});

test("test_a_universal_name_is_performed_by_the_first_name_the_service_performs", () => {
  const capabilities = new CartesiaExpressionAdapter().capabilities();

  expect(capabilities.deliveryName("warm")).toEqual("content");
  expect(capabilities.deliveryName("calm")).toEqual("calm");
  expect(capabilities.deliveryName("grateful")).toEqual("grateful");
  expect(capabilities.soundName("chuckle")).toEqual("laughter");
  expect(capabilities.deliveryName("mischievously")).toBeNull();
});

test("test_a_universal_name_keeps_its_kind_in_the_other_brackets", () => {
  const expression = new ExpressionFormatter(() => new ElevenLabsAudioTagExpressionAdapter(), {
    owner: "tts",
  });

  expect(expression.parse("[[warm]] Hi. <<laugh>>").map(shape)).toEqual([
    words(" Hi. ", ["warm"]),
    ["sound", "laugh"],
  ]);
});
