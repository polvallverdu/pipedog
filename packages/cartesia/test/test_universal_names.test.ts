// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_universal_names.py

/** Tests for the universal expression names, and the names TTS services perform them by. */

import { expect, test } from "bun:test";

import {
  CORE_DELIVERY,
  CORE_SOUNDS,
  ExpressionCapabilities,
  ExpressionDelivery,
  ExpressionSound,
  ExpressionTerm,
} from "@pipedog/core/expressive/expression";
import { ExpressionGuidance, ExpressionPolicy } from "@pipedog/core/expressive/policy";
import { LabelSpace } from "@pipedog/core/processors/tone/tagger/_labels";

import { ElevenLabsAudioTagExpressionAdapter } from "../../elevenlabs/src/elevenlabs_adapter.ts";
import { FishAudioS2ExpressionAdapter } from "../../fish/src/fish_adapter.ts";
import { MiniMaxExpressionAdapter } from "../../minimax/src/minimax_adapter.ts";
import { CartesiaExpressionAdapter } from "../src/cartesia_adapter.ts";

const ADAPTERS = [
  CartesiaExpressionAdapter,
  ElevenLabsAudioTagExpressionAdapter,
  FishAudioS2ExpressionAdapter,
  MiniMaxExpressionAdapter,
];

// Sounds services declare that aren't a voice, so they have no universal name.
const NOT_A_VOICE = new Set([
  "applause",
  "clapping",
  "gunshot",
  "explosion",
  "fart",
  "audience laughing",
  "background laughter",
  "crowd laughing",
]);

const DELIVERIES = new Set<string>(Object.values(ExpressionDelivery));
const SOUNDS = new Set<string>(Object.values(ExpressionSound));
const UNIVERSAL = new Set<string>([...DELIVERIES, ...SOUNDS]);

/** The name the tagger writes a label as, with a policy offering `offered`. */
function taggerName(
  capabilities: ExpressionCapabilities,
  label: string,
  offered: string[] | null = null,
): string | null {
  const policy = new ExpressionPolicy({
    guidance: [ExpressionGuidance.BREATHE],
    delivery: offered,
    sounds: offered,
  });
  const space = LabelSpace.resolve(capabilities, policy);
  const merged: Record<string, string> = { ...space.deliveries, ...space.sounds, ...space.breaths };
  return Object.hasOwn(merged, label) ? (merged[label] as string) : null;
}

test("test_a_name_is_either_a_delivery_or_a_sound", () => {
  expect([...DELIVERIES].filter((name) => SOUNDS.has(name))).toEqual([]);
});

test("test_the_core_names_are_universal", () => {
  expect(CORE_DELIVERY.filter((name) => !DELIVERIES.has(name))).toEqual([]);
  expect(CORE_SOUNDS.filter((name) => !SOUNDS.has(name))).toEqual([]);
});

for (const adapter of ADAPTERS) {
  test(`test_a_service_names_universal_names_by_names_it_performs[${adapter.name}]`, () => {
    const capabilities = new adapter().capabilities();

    expect(Object.keys(capabilities.serviceVocabulary).filter((n) => !UNIVERSAL.has(n))).toEqual(
      [],
    );
    for (const [universal, names] of Object.entries(capabilities.serviceVocabulary) as [
      string,
      string[],
    ][]) {
      let declared: ExpressionTerm[];
      let performed: string | null;
      if (DELIVERIES.has(universal)) {
        declared = capabilities.delivery;
        performed = capabilities.deliveryName(universal);
      } else {
        declared = capabilities.sounds;
        performed = capabilities.soundName(universal);
      }
      expect(names).toContain(performed as string);
      if (!capabilities.allowsFreeText) {
        const declaredNames = new Set(declared.map((term) => term.name));
        expect(names.filter((name) => declaredNames.has(name)).length).toBeGreaterThan(0);
      }
    }
  });
}

for (const adapter of ADAPTERS) {
  test(`test_every_voice_a_service_declares_is_reached_by_a_universal_name[${adapter.name}]`, () => {
    const capabilities = new adapter().capabilities();
    const reached = new Set((Object.values(capabilities.serviceVocabulary) as string[][]).flat());

    for (const term of [...capabilities.delivery, ...capabilities.sounds]) {
      expect(
        UNIVERSAL.has(term.name) || reached.has(term.name) || NOT_A_VOICE.has(term.name),
        term.name,
      ).toBe(true);
    }
  });
}

for (const adapter of ADAPTERS) {
  test(`test_the_tagger_writes_each_core_name_the_service_performs_as_itself[${adapter.name}]`, () => {
    const capabilities = new adapter().capabilities();

    for (const name of CORE_DELIVERY) {
      expect(taggerName(capabilities, name)).toBe(capabilities.deliveryName(name) ? name : null);
    }
    for (const name of CORE_SOUNDS) {
      expect(taggerName(capabilities, name)).toBe(capabilities.soundName(name) ? name : null);
    }
  });
}

const BREATH_CASES: [(typeof ADAPTERS)[number], string[]][] = [
  [CartesiaExpressionAdapter, []],
  [ElevenLabsAudioTagExpressionAdapter, ["light breath", "deep breath", "exhale"]],
  [FishAudioS2ExpressionAdapter, ["light breath", "deep breath", "exhale"]],
  [MiniMaxExpressionAdapter, ["light breath", "deep breath", "exhale"]],
];

for (const [adapter, kinds] of BREATH_CASES) {
  test(`test_each_kind_of_breath_the_service_performs_is_offered[${adapter.name}-${kinds}]`, () => {
    const policy = new ExpressionPolicy({ guidance: [ExpressionGuidance.BREATHE] });

    const space = LabelSpace.resolve(new adapter().capabilities(), policy);

    expect(space.breaths).toEqual(Object.fromEntries(kinds.map((kind) => [kind, kind])));
  });
}

const OFFERED_CASES: [string[], string[]][] = [
  [["deep breath"], ["deep breath"]],
  [["sigh", "deep breath"], ["deep breath"]],
  [
    ["light breath", "exhale"],
    ["light breath", "exhale"],
  ],
];

for (const [offered, kinds] of OFFERED_CASES) {
  test(`test_a_policy_that_names_only_a_kind_still_breathes[${offered}-${kinds}]`, () => {
    const policy = new ExpressionPolicy({
      guidance: [ExpressionGuidance.BREATHE],
      sounds: offered,
    });

    const space = LabelSpace.resolve(
      new ElevenLabsAudioTagExpressionAdapter().capabilities(),
      policy,
    );

    expect(space.breaths).toEqual(Object.fromEntries(kinds.map((kind) => [kind, kind])));
    expect(space.sounds.breath).toBe(kinds[0] as string);
  });
}

test("test_a_label_is_written_as_itself_where_the_service_performs_it", () => {
  const capabilities = new ExpressionCapabilities({
    sounds: [new ExpressionTerm({ name: "laughter" })],
    delivery: [new ExpressionTerm({ name: "happy" })],
    serviceVocabulary: {
      [ExpressionDelivery.WARM]: ["content", "happy"],
      [ExpressionSound.LAUGH]: ["laughter"],
    },
  });

  expect(taggerName(capabilities, "warm")).toBe("warm");
  expect(taggerName(capabilities, "laugh")).toBe("laugh");
  expect(taggerName(capabilities, "sad")).toBeNull();
  expect(taggerName(capabilities, "sigh")).toBeNull();
});

test("test_a_developers_name_for_a_label_is_written_where_the_policy_offers_it", () => {
  const capabilities = new ExpressionCapabilities({
    delivery: [new ExpressionTerm({ name: "calm" }), new ExpressionTerm({ name: "reassuring" })],
  });
  const vocabulary = { calm: ["reassuring"] };

  const written = (offered: string[] | null): string | null => {
    const policy = new ExpressionPolicy({ delivery: offered });
    const deliveries = LabelSpace.resolve(capabilities, policy, "", vocabulary).deliveries;
    return Object.hasOwn(deliveries, "calm") ? (deliveries.calm as string) : null;
  };

  expect(written(null)).toBe("reassuring");
  expect(written(["calm"])).toBe("calm");
  expect(written(["happy"])).toBeNull();
});
