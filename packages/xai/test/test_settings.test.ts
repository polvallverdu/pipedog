// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_settings.py

/**
 * Tests for the typed settings infrastructure in pipecat.services.settings.
 *
 * Upstream's file covers the settings of many services. This file holds its
 * Grok Realtime sections (`TestGrokRealtimeSettingsApplyUpdate`,
 * `TestGrokRealtimeSettingsFromMapping`); the other sections live with their
 * own packages.
 */

import { describe, expect, test } from "bun:test";

import { isGiven } from "@pipedog/core/utils/types";

import * as grokEvents from "../src/realtime/events.ts";
import { GrokRealtimeLLMSettings } from "../src/realtime/llm.ts";

function _storeDefaults(): Record<string, unknown> {
  return {
    model: null,
    systemInstruction: null,
    temperature: null,
    maxTokens: null,
    topP: null,
    topK: null,
    frequencyPenalty: null,
    presencePenalty: null,
    seed: null,
    filterIncompleteUserTurns: false,
    userTurnCompletionConfig: null,
    sessionProperties: new grokEvents.SessionProperties(),
  };
}

function sp(settings: GrokRealtimeLLMSettings): grokEvents.SessionProperties {
  return settings.sessionProperties as grokEvents.SessionProperties;
}

// ---------------------------------------------------------------------------
// GrokRealtimeLLMSettings: applyUpdate with bidirectional sync
// ---------------------------------------------------------------------------

describe("TestGrokRealtimeSettingsApplyUpdate", () => {
  /** Helper to build a store-mode GrokRealtimeLLMSettings. */
  function _makeStore(kwargs: Record<string, unknown> = {}): GrokRealtimeLLMSettings {
    return new GrokRealtimeLLMSettings({ ..._storeDefaults(), ...kwargs });
  }

  test("test_top_level_system_instruction_syncs_to_sp", () => {
    const store = _makeStore();
    const delta = new GrokRealtimeLLMSettings({ systemInstruction: "Be helpful." });
    const changed = store.applyUpdate(delta);

    expect("systemInstruction" in changed).toBe(true);
    expect(store.systemInstruction).toBe("Be helpful.");
    expect(sp(store).instructions).toBe("Be helpful.");
  });

  test("test_sp_replaces_wholesale", () => {
    const store = _makeStore({
      sessionProperties: new grokEvents.SessionProperties({
        voice: "Rex",
        instructions: "Old instructions.",
      }),
      systemInstruction: "Old instructions.",
    });

    const newSp = new grokEvents.SessionProperties({ voice: "Sal" });
    const delta = new GrokRealtimeLLMSettings({ sessionProperties: newSp });
    const changed = store.applyUpdate(delta);

    expect("sessionProperties" in changed).toBe(true);
    expect(sp(store).voice).toBe("Sal");
    // instructions is synced from top-level systemInstruction
    expect(sp(store).instructions).toBe("Old instructions.");
  });

  test("test_sp_instructions_syncs_to_top_level", () => {
    const store = _makeStore();
    const newSp = new grokEvents.SessionProperties({ instructions: "New instructions." });
    const delta = new GrokRealtimeLLMSettings({ sessionProperties: newSp });
    const changed = store.applyUpdate(delta);

    expect("systemInstruction" in changed).toBe(true);
    expect(store.systemInstruction).toBe("New instructions.");
    expect(sp(store).instructions).toBe("New instructions.");
  });

  test("test_top_level_si_takes_precedence_over_sp_instructions", () => {
    const store = _makeStore();
    const newSp = new grokEvents.SessionProperties({ instructions: "sp instructions" });
    const delta = new GrokRealtimeLLMSettings({
      systemInstruction: "top instructions",
      sessionProperties: newSp,
    });
    store.applyUpdate(delta);

    expect(store.systemInstruction).toBe("top instructions");
    expect(sp(store).instructions).toBe("top instructions");
  });

  test("test_non_synced_field_update_does_not_affect_sp", () => {
    const store = _makeStore({
      sessionProperties: new grokEvents.SessionProperties({ instructions: "Keep me." }),
      systemInstruction: "Keep me.",
    });
    const originalSp = store.sessionProperties;

    const delta = new GrokRealtimeLLMSettings({ temperature: 0.5 });
    const changed = store.applyUpdate(delta);

    expect("temperature" in changed).toBe(true);
    expect(store.temperature).toBe(0.5);
    // SP should be untouched (same object)
    expect(store.sessionProperties).toBe(originalSp);
    expect(sp(store).instructions).toBe("Keep me.");
  });
});

// ---------------------------------------------------------------------------
// GrokRealtimeLLMSettings: fromMapping
// ---------------------------------------------------------------------------

describe("TestGrokRealtimeSettingsFromMapping", () => {
  test("test_sp_keys_route_to_session_properties", () => {
    const delta = GrokRealtimeLLMSettings.fromMapping({
      instructions: "Be concise.",
      voice: "Rex",
    });
    expect(isGiven(delta.sessionProperties)).toBe(true);
    expect(sp(delta).instructions).toBe("Be concise.");
    expect(sp(delta).voice).toBe("Rex");
  });

  test("test_model_routes_to_top_level", () => {
    const delta = GrokRealtimeLLMSettings.fromMapping({ model: "some-model" });
    expect(delta.model).toBe("some-model");
    // No sessionProperties should be created since no SP keys were present
    expect(isGiven(delta.sessionProperties)).toBe(false);
  });

  test("test_unknown_keys_go_to_extra", () => {
    const delta = GrokRealtimeLLMSettings.fromMapping({ unknown_param: 42 });
    expect(isGiven(delta.model)).toBe(false);
    expect(isGiven(delta.sessionProperties)).toBe(false);
    expect(delta.extra).toEqual({ unknown_param: 42 });
  });

  test("test_mixed_keys", () => {
    const delta = GrokRealtimeLLMSettings.fromMapping({
      model: "some-model",
      instructions: "Be helpful.",
      unknown: "val",
    });
    expect(delta.model).toBe("some-model");
    expect(isGiven(delta.sessionProperties)).toBe(true);
    expect(sp(delta).instructions).toBe("Be helpful.");
    expect(delta.extra).toEqual({ unknown: "val" });
  });

  test("test_roundtrip_from_mapping_apply_update", () => {
    const store = new GrokRealtimeLLMSettings(_storeDefaults());

    const raw = { instructions: "Be concise.", voice: "Eve" };
    const delta = GrokRealtimeLLMSettings.fromMapping(raw);
    const changed = store.applyUpdate(delta);

    expect("sessionProperties" in changed).toBe(true);
    expect(sp(store).instructions).toBe("Be concise.");
    expect(sp(store).voice).toBe("Eve");
    expect(store.systemInstruction).toBe("Be concise.");
  });
});
