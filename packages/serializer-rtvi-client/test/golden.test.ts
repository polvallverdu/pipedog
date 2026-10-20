// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Wire compatibility with upstream: replays what upstream's
 * RTVIClientSerializer produced for the same inputs
 * (tools/golden/serializers.py). The JSON text must be identical, down to
 * Python's `json.dumps` formatting.
 */

import { describe, expect, test } from "bun:test";
import {
  type Frame,
  OutputAudioRawFrame,
  OutputTransportMessageFrame,
  OutputTransportMessageUrgentFrame,
  TextFrame,
} from "@pipedog/core/frames/frames";
import { RTVIClientSerializer } from "../src/rtvi_client.ts";
import golden from "./fixtures/golden.json";

type Any = any;

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe("rtvi client golden vectors", () => {
  test("serialize", async () => {
    // One serializer for the whole sequence: raw-audio ids increment.
    const serializer = new RTVIClientSerializer();
    for (const { input, out } of golden.serialize as Any[]) {
      let frame: Frame;
      if (input.kind === "message")
        frame = new OutputTransportMessageFrame({ message: input.message });
      else if (input.kind === "message_urgent")
        frame = new OutputTransportMessageUrgentFrame({ message: input.message });
      else if (input.kind === "audio")
        frame = new OutputAudioRawFrame({
          audio: fromHex(input.audio),
          sampleRate: input.sample_rate,
          numChannels: input.num_channels,
        });
      else frame = new TextFrame({ text: input.text });
      expect(await serializer.serialize(frame)).toEqual(out);
    }
  });

  for (const { input, frame: expected, error } of golden.deserialize as Any[]) {
    test(`deserialize ${input.slice(0, 90)}`, async () => {
      if (error !== undefined) {
        // Upstream raises AttributeError / TypeError; we raise a TypeError.
        await expect(new RTVIClientSerializer().deserialize(input)).rejects.toThrow(TypeError);
        return;
      }
      const frame = await new RTVIClientSerializer().deserialize(input);
      if (expected == null) {
        expect(frame).toBeNull();
        return;
      }
      expect(frame?.constructor.name).toEqual(expected.type);
      for (const [key, value] of Object.entries(expected)) {
        if (key === "type") continue;
        expect([key, (frame as Any)[camel(key)]]).toEqual([key, value]);
      }
    });
  }
});
