// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_settings.py

/**
 * Tests for the typed settings infrastructure in pipecat.services.settings.
 *
 * Upstream's file covers the settings of many services. This file holds its
 * Inworld Realtime sections (`TestInworldRealtimeSettingsApplyUpdate`,
 * `TestInworldRealtimeSettingsFromMapping`); the other sections live with
 * their own packages.
 */

import { describe, expect, test } from "bun:test";

import { isGiven } from "@pipedog/core/utils/types";

import * as inworldEvents from "../src/realtime/events.ts";
import { InworldRealtimeLLMSettings } from "../src/realtime/llm.ts";

// ---------------------------------------------------------------------------
// InworldRealtimeLLMSettings: applyUpdate with bidirectional sync
// ---------------------------------------------------------------------------

function _storeDefaults(): Record<string, unknown> {
  return {
    model: "openai/gpt-4.1-nano",
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
    sessionProperties: new inworldEvents.SessionProperties(),
  };
}

describe("TestInworldRealtimeSettingsApplyUpdate", () => {
  /** Helper to build a store-mode InworldRealtimeLLMSettings. */
  function _makeStore(kwargs: Record<string, unknown> = {}): InworldRealtimeLLMSettings {
    return new InworldRealtimeLLMSettings({ ..._storeDefaults(), ...kwargs });
  }

  function sp(store: InworldRealtimeLLMSettings): inworldEvents.SessionProperties {
    return store.sessionProperties as inworldEvents.SessionProperties;
  }

  test("test_top_level_model_syncs_to_sp", () => {
    const store = _makeStore();
    const delta = new InworldRealtimeLLMSettings({ model: "openai/gpt-4.1" });
    const changed = store.applyUpdate(delta);

    expect("model" in changed).toBe(true);
    expect(store.model).toBe("openai/gpt-4.1");
    expect(sp(store).model).toBe("openai/gpt-4.1");
  });

  test("test_top_level_system_instruction_syncs_to_sp", () => {
    const store = _makeStore();
    const delta = new InworldRealtimeLLMSettings({ systemInstruction: "Be helpful." });
    const changed = store.applyUpdate(delta);

    expect("systemInstruction" in changed).toBe(true);
    expect(store.systemInstruction).toBe("Be helpful.");
    expect(sp(store).instructions).toBe("Be helpful.");
  });

  test("test_sp_replaces_wholesale", () => {
    const store = _makeStore({
      sessionProperties: new inworldEvents.SessionProperties({
        outputModalities: ["audio", "text"],
        instructions: "Old instructions.",
      }),
      systemInstruction: "Old instructions.",
    });

    const newSp = new inworldEvents.SessionProperties({ outputModalities: ["text"] });
    const delta = new InworldRealtimeLLMSettings({ sessionProperties: newSp });
    const changed = store.applyUpdate(delta);

    expect("sessionProperties" in changed).toBe(true);
    expect(sp(store).outputModalities).toEqual(["text"]);
    // model is synced from top-level
    expect(sp(store).model).toBe("openai/gpt-4.1-nano");
  });

  test("test_sp_model_syncs_to_top_level", () => {
    const store = _makeStore();
    const newSp = new inworldEvents.SessionProperties({ model: "openai/gpt-4.1" });
    const delta = new InworldRealtimeLLMSettings({ sessionProperties: newSp });
    const changed = store.applyUpdate(delta);

    expect("model" in changed).toBe(true);
    expect(store.model).toBe("openai/gpt-4.1");
    expect(sp(store).model).toBe("openai/gpt-4.1");
  });

  test("test_sp_instructions_syncs_to_top_level", () => {
    const store = _makeStore();
    const newSp = new inworldEvents.SessionProperties({ instructions: "New instructions." });
    const delta = new InworldRealtimeLLMSettings({ sessionProperties: newSp });
    const changed = store.applyUpdate(delta);

    expect("systemInstruction" in changed).toBe(true);
    expect(store.systemInstruction).toBe("New instructions.");
    expect(sp(store).instructions).toBe("New instructions.");
  });

  test("test_top_level_model_takes_precedence_over_sp_model", () => {
    const store = _makeStore();
    const newSp = new inworldEvents.SessionProperties({ model: "sp-model" });
    const delta = new InworldRealtimeLLMSettings({ model: "top-model", sessionProperties: newSp });
    store.applyUpdate(delta);

    expect(store.model).toBe("top-model");
    expect(sp(store).model).toBe("top-model");
  });

  test("test_top_level_si_takes_precedence_over_sp_instructions", () => {
    const store = _makeStore();
    const newSp = new inworldEvents.SessionProperties({ instructions: "sp instructions" });
    const delta = new InworldRealtimeLLMSettings({
      systemInstruction: "top instructions",
      sessionProperties: newSp,
    });
    store.applyUpdate(delta);

    expect(store.systemInstruction).toBe("top instructions");
    expect(sp(store).instructions).toBe("top instructions");
  });

  test("test_non_synced_field_update_does_not_affect_sp", () => {
    const store = _makeStore({
      sessionProperties: new inworldEvents.SessionProperties({ instructions: "Keep me." }),
      systemInstruction: "Keep me.",
    });
    const originalSp = store.sessionProperties;

    const delta = new InworldRealtimeLLMSettings({ temperature: 0.5 });
    const changed = store.applyUpdate(delta);

    expect("temperature" in changed).toBe(true);
    expect(store.temperature).toBe(0.5);
    // SP should be untouched (same object)
    expect(store.sessionProperties).toBe(originalSp);
    expect(sp(store).instructions).toBe("Keep me.");
  });
});

// ---------------------------------------------------------------------------
// InworldRealtimeLLMSettings: fromMapping
// ---------------------------------------------------------------------------

describe("TestInworldRealtimeSettingsFromMapping", () => {
  test("test_sp_keys_route_to_session_properties", () => {
    const delta = InworldRealtimeLLMSettings.fromMapping({
      instructions: "Be concise.",
      output_modalities: ["text"],
    });
    expect(isGiven(delta.sessionProperties)).toBe(true);
    const sp = delta.sessionProperties as inworldEvents.SessionProperties;
    expect(sp.instructions).toBe("Be concise.");
    expect(sp.outputModalities).toEqual(["text"]);
  });

  test("test_model_routes_to_top_level", () => {
    const delta = InworldRealtimeLLMSettings.fromMapping({ model: "openai/gpt-4.1" });
    expect(delta.model).toBe("openai/gpt-4.1");
    // No sessionProperties should be created since no SP keys were present
    expect(isGiven(delta.sessionProperties)).toBe(false);
  });

  test("test_unknown_keys_go_to_extra", () => {
    const delta = InworldRealtimeLLMSettings.fromMapping({ unknown_param: 42 });
    expect(isGiven(delta.model)).toBe(false);
    expect(isGiven(delta.sessionProperties)).toBe(false);
    expect(delta.extra).toEqual({ unknown_param: 42 });
  });

  test("test_mixed_keys", () => {
    const delta = InworldRealtimeLLMSettings.fromMapping({
      model: "openai/gpt-4.1",
      instructions: "Be helpful.",
      unknown: "val",
    });
    expect(delta.model).toBe("openai/gpt-4.1");
    expect(isGiven(delta.sessionProperties)).toBe(true);
    expect((delta.sessionProperties as inworldEvents.SessionProperties).instructions).toBe(
      "Be helpful.",
    );
    expect(delta.extra).toEqual({ unknown: "val" });
  });

  test("test_roundtrip_from_mapping_apply_update", () => {
    const store = new InworldRealtimeLLMSettings(_storeDefaults());

    const raw = { instructions: "Be concise.", output_modalities: ["text"] };
    const delta = InworldRealtimeLLMSettings.fromMapping(raw);
    const changed = store.applyUpdate(delta);

    expect("sessionProperties" in changed).toBe(true);
    const sp = store.sessionProperties as inworldEvents.SessionProperties;
    expect(sp.instructions).toBe("Be concise.");
    expect(sp.outputModalities).toEqual(["text"]);
    expect(store.systemInstruction).toBe("Be concise.");
  });
});
