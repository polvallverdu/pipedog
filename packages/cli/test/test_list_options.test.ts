// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/cli/test_list_options.py

// Tests for the `pipedog init --list-options` flag.
//
// DIVERGENCE: the output has two more keys than upstream's: `runtime` and `client_framework`.

import { describe, expect, test } from "bun:test";
import { ServiceRegistry } from "../src/service_metadata.ts";
import { cli } from "./helpers.ts";

const values = (defs: readonly { value: string }[]) => defs.map((s) => s.value);

describe("TestListOptions", () => {
  test("test_exits_successfully", async () => {
    const result = await cli(["init", "--list-options"]);
    expect(result.code).toEqual(0);
  });

  test("test_returns_valid_json", async () => {
    const data = JSON.parse((await cli(["init", "--list-options"])).stdout);
    expect(typeof data).toEqual("object");
    expect(Array.isArray(data)).toBe(false);
  });

  test("test_top_level_keys", async () => {
    const data = JSON.parse((await cli(["init", "--list-options"])).stdout);
    expect(new Set(Object.keys(data))).toEqual(
      new Set([
        "bot_type",
        "transports",
        "stt",
        "llm",
        "tts",
        "realtime",
        "video",
        "runtime",
        "client_framework",
      ]),
    );
  });

  test("test_bot_type_values", async () => {
    const data = JSON.parse((await cli(["init", "--list-options"])).stdout);
    expect(data.bot_type).toEqual(["web", "telephony"]);
  });

  test("test_transports_grouped_by_bot_type", async () => {
    const data = JSON.parse((await cli(["init", "--list-options"])).stdout);
    expect(new Set(Object.keys(data.transports))).toEqual(new Set(["web", "telephony"]));
    expect(Array.isArray(data.transports.web)).toBe(true);
    expect(Array.isArray(data.transports.telephony)).toBe(true);
  });

  test("test_transports_match_registry", async () => {
    const data = JSON.parse((await cli(["init", "--list-options"])).stdout);
    expect(data.transports.web).toEqual(values(ServiceRegistry.WEBRTC_TRANSPORTS));
    expect(data.transports.telephony).toEqual(values(ServiceRegistry.TELEPHONY_TRANSPORTS));
  });

  test("test_services_match_registry", async () => {
    const data = JSON.parse((await cli(["init", "--list-options"])).stdout);
    expect(data.stt).toEqual(values(ServiceRegistry.STT_SERVICES));
    expect(data.llm).toEqual(values(ServiceRegistry.LLM_SERVICES));
    expect(data.tts).toEqual(values(ServiceRegistry.TTS_SERVICES));
    expect(data.realtime).toEqual(values(ServiceRegistry.REALTIME_SERVICES));
    expect(data.video).toEqual(values(ServiceRegistry.VIDEO_SERVICES));
  });

  test("test_all_lists_non_empty", async () => {
    const data = JSON.parse((await cli(["init", "--list-options"])).stdout);
    expect(data.bot_type.length).toBeGreaterThan(0);
    expect(data.transports.web.length).toBeGreaterThan(0);
    expect(data.transports.telephony.length).toBeGreaterThan(0);
    expect(data.stt.length).toBeGreaterThan(0);
    expect(data.llm.length).toBeGreaterThan(0);
    expect(data.tts.length).toBeGreaterThan(0);
    expect(data.realtime.length).toBeGreaterThan(0);
    expect(data.video.length).toBeGreaterThan(0);
  });

  test("test_no_project_generated", async () => {
    // --list-options should exit before any project generation happens.
    const result = await cli(["init", "--list-options", "--name", "should-not-run"]);
    expect(result.code).toEqual(0);
    expect(JSON.parse(result.stdout).bot_type).toBeDefined();
  });

  test("NEW: no value is one that isn't ported", async () => {
    const data = JSON.parse((await cli(["init", "--list-options"])).stdout);
    expect(data.transports.web).not.toContain("daily");
    expect(data.stt).not.toContain("gradium_stt");
    expect(data.video).not.toContain("tavus_video");
  });
});
