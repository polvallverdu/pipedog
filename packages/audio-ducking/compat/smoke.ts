// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: ducks a chunk of PCM and restores it.

import { AudioDuckingFilter } from "@pipedog/audio-ducking";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`audio-ducking smoke: ${message}`);
}

export default async function smoke(): Promise<void> {
  const filter = new AudioDuckingFilter({ duckedGain: 0.5 });
  const chunk = () => new Uint8Array(new Int16Array([1000, 1000]).buffer);
  filter.duck();
  await filter.filter(chunk());
  const ducked = new Int16Array((await filter.filter(chunk())).slice().buffer);
  check(ducked.join() === "500,500", `ducked ${ducked.join()}`);
  filter.restore();
  await filter.filter(chunk());
  const restored = new Int16Array((await filter.filter(chunk())).slice().buffer);
  check(restored.join() === "1000,1000", `restored ${restored.join()}`);
}
