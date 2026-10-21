// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Runtime tool and settings updates on GeminiLiveLLMService.
 *
 * The Live API session keeps the tools and settings it was opened with. As
 * upstream, an `LLMSetToolsFrame` is dropped and a settings update is stored
 * without touching the open session; both log a warning (upstream's warning
 * for the dropped frame is a pipedog DIVERGENCE).
 */

import { afterEach, expect, spyOn, test } from "bun:test";
import { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import { type Frame, LLMSetToolsFrame } from "@pipedog/core/frames/frames";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { logger } from "@pipedog/core/utils/logger";
import { GeminiLiveLLMService } from "../src/gemini_live/llm.ts";

type Internals = {
  pushFrame(frame: Frame, direction?: FrameDirection): Promise<void>;
  processFrame(frame: Frame, direction: FrameDirection): Promise<void>;
  _updateSettings(delta: InstanceType<typeof GeminiLiveLLMService.Settings>): Promise<unknown>;
  _reconnect(): Promise<void>;
};

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

function _service(): {
  service: Internals;
  pushed: Frame[];
  warnings: string[];
  reconnects: number[];
} {
  const service = new GeminiLiveLLMService({ apiKey: "test-key" }) as unknown as Internals;
  const pushed: Frame[] = [];
  service.pushFrame = async (frame: Frame) => {
    pushed.push(frame);
  };
  const reconnects: number[] = [];
  service._reconnect = async () => {
    reconnects.push(1);
  };
  const warnings: string[] = [];
  spies.push(
    spyOn(logger, "warning").mockImplementation((m: unknown) => {
      warnings.push(String(m));
    }),
  );
  return { service, pushed, warnings, reconnects };
}

test("test_set_tools_frame_dropped_with_warning", async () => {
  const { service, pushed, warnings, reconnects } = _service();

  await service.processFrame(
    new LLMSetToolsFrame({ tools: new ToolsSchema({ standardTools: [] }) }),
    FrameDirection.DOWNSTREAM,
  );

  expect(pushed).toEqual([]);
  expect(reconnects).toEqual([]);
  expect(
    warnings.some((w) => w.includes("runtime update of [tools] is not currently supported")),
  ).toBe(true);
});

test("test_settings_update_stored_with_warning", async () => {
  const { service, warnings, reconnects } = _service();

  await service._updateSettings(new GeminiLiveLLMService.Settings({ temperature: 0.3 }));

  expect(
    (service as unknown as { _settings: { temperature: unknown } })._settings.temperature,
  ).toBe(0.3);
  expect(reconnects).toEqual([]);
  expect(
    warnings.some((w) => w.includes("runtime update of [temperature] is not currently supported")),
  ).toBe(true);
});
