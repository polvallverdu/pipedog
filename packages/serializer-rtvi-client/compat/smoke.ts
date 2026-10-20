// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: replays the upstream golden vectors
// (test/fixtures/golden.json) on each runtime, so the JSON text (Python's
// `json.dumps` formatting) and the message-to-frame mapping are checked on
// every engine.

import {
  type Frame,
  OutputAudioRawFrame,
  OutputTransportMessageFrame,
  OutputTransportMessageUrgentFrame,
  TextFrame,
} from "@pipedog/core/frames/frames";
import { logger } from "@pipedog/core/utils/logger";

import { RTVIClientSerializer } from "../src/rtvi_client.ts";
import golden from "../test/fixtures/golden.json" with { type: "json" };

type Any = any;

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`serializer-rtvi-client smoke: ${message}`);
}

export default async function smoke(): Promise<void> {
  logger.setLevel("CRITICAL");
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
    const got = await serializer.serialize(frame);
    check(got === out, `serialize ${input.kind}: ${got} != ${out}`);
  }
  for (const { input, frame: expected, error } of golden.deserialize as Any[]) {
    let frame: Frame | null;
    try {
      frame = await new RTVIClientSerializer().deserialize(input);
    } catch (e) {
      check(error !== undefined && e instanceof TypeError, `deserialize ${input} threw ${e}`);
      continue;
    }
    check(error === undefined, `deserialize ${input} should throw`);
    if (expected == null) {
      check(frame === null, `deserialize ${input} should give null`);
      continue;
    }
    check(frame !== null, `deserialize ${input} gave null`);
    for (const [key, value] of Object.entries(expected)) {
      if (key === "type") continue;
      const got = (frame as Any)[camel(key)];
      check(
        JSON.stringify(got) === JSON.stringify(value),
        `deserialize ${input}: ${key} ${JSON.stringify(got)} != ${JSON.stringify(value)}`,
      );
    }
  }
}
