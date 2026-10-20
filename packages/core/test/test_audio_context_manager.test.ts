// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_audio_context_manager.py

/** Tests for AudioContextManager. */

import { expect, test } from "bun:test";
import { createTask, sleep, TimeoutError } from "@pipedog/asyncio";
import { TextFrame, TTSAudioRawFrame, TTSStoppedFrame } from "../src/frames/frames.ts";
import {
  AudioContextFrame,
  AudioContextManager,
} from "../src/utils/context/audio_context_manager.ts";

function _audio(numBytes: number): TTSAudioRawFrame {
  return new TTSAudioRawFrame({
    audio: new Uint8Array(numBytes).fill(1),
    sampleRate: 16000,
    numChannels: 1,
  });
}

test("test_contexts_and_frames_play_in_queue_order", async () => {
  const manager = new AudioContextManager();
  const frame = new TextFrame({ text: "between" });
  await manager.create("a");
  await manager.putFrame(frame);
  await manager.create("b");
  await manager.endPlayback();

  const first = await manager.nextForPlayback();
  expect(first).toBeInstanceOf(AudioContextFrame);
  expect((first as AudioContextFrame).contextId).toBe("a");
  expect(manager.playingContextId).toBe("a");
  expect(await manager.nextForPlayback()).toBe(frame);
  const second = await manager.nextForPlayback();
  expect(second).toBeInstanceOf(AudioContextFrame);
  expect((second as AudioContextFrame).contextId).toBe("b");
  expect(manager.playingContextId).toBe("b");
  expect(await manager.nextForPlayback()).toBeNull();
});

test("test_context_items_come_out_in_order_until_the_context_ends", async () => {
  const manager = new AudioContextManager();
  await manager.create("a");
  const stopped = new TTSStoppedFrame({ contextId: "a" });
  await manager.append("a", _audio(4));
  await manager.append("a", stopped);
  await manager.append("a", null);

  expect(((await manager.get("a", 1)) as TTSAudioRawFrame).audio.length).toBe(4);
  expect(await manager.get("a", 1)).toBe(stopped);
  expect(await manager.get("a", 1)).toBeNull();
});

test("test_split_sample_is_carried_to_the_next_frame", async () => {
  const manager = new AudioContextManager();
  await manager.create("a");
  await manager.append("a", _audio(3));
  await manager.append("a", _audio(3));

  expect(((await manager.get("a", 1)) as TTSAudioRawFrame).audio.length).toBe(2);
  expect(((await manager.get("a", 1)) as TTSAudioRawFrame).audio.length).toBe(4);
});

test("test_split_sample_is_padded_when_the_context_ends", async () => {
  const manager = new AudioContextManager();
  await manager.create("a");
  await manager.append("a", _audio(3));
  await manager.append("a", null);

  expect(((await manager.get("a", 1)) as TTSAudioRawFrame).audio.length).toBe(2);
  expect(((await manager.get("a", 1)) as TTSAudioRawFrame).audio).toEqual(
    new Uint8Array([0x01, 0x00]),
  );
  expect(await manager.get("a", 1)).toBeNull();
});

test("test_frame_with_less_than_a_sample_is_dropped", async () => {
  const manager = new AudioContextManager();
  await manager.create("a");
  await manager.append("a", _audio(1));

  await expect(manager.get("a", 0.05)).rejects.toThrow(TimeoutError);
});

test("test_keepalive_restarts_the_wait", async () => {
  const manager = new AudioContextManager();
  await manager.create("a");

  async function keepThenAppend(): Promise<void> {
    await sleep(0.06);
    manager.keepalive("a");
    await sleep(0.06);
    await manager.append("a", null);
  }

  const task = createTask(keepThenAppend);
  expect(await manager.get("a", 0.1)).toBeNull();
  await task;
});

test("test_reset_keeps_only_uninterruptible_contexts_and_frames", async () => {
  const manager = new AudioContextManager();
  const keptFrame = new TextFrame({ text: "kept" });
  keptFrame.interruptible = false;
  await manager.create("a");
  await manager.putFrame(new TextFrame({ text: "dropped" }));
  await manager.putFrame(keptFrame);
  await manager.create("b", { interruptible: false });
  manager.reset();
  await manager.endPlayback();

  expect(await manager.nextForPlayback()).toBe(keptFrame);
  const context = await manager.nextForPlayback();
  expect(context).toBeInstanceOf(AudioContextFrame);
  expect((context as AudioContextFrame).contextId).toBe("b");
  expect(await manager.nextForPlayback()).toBeNull();
});

test("test_removed_context_is_skipped", async () => {
  const manager = new AudioContextManager();
  await manager.create("a", { interruptible: false });
  await manager.create("b");
  manager.reset();
  manager.remove("a");
  await manager.create("c");
  await manager.endPlayback();

  const context = await manager.nextForPlayback();
  expect(context).toBeInstanceOf(AudioContextFrame);
  expect((context as AudioContextFrame).contextId).toBe("c");
  expect(await manager.nextForPlayback()).toBeNull();
});

test("test_remove_forgets_the_context_and_its_split_sample", async () => {
  const manager = new AudioContextManager();
  await manager.create("a");
  await manager.append("a", _audio(3));
  manager.remove("a");

  expect(manager.available("a")).toBe(false);
  expect(manager.contextIds).toEqual([]);
  await manager.create("a");
  await manager.append("a", _audio(2));
  expect(((await manager.get("a", 1)) as TTSAudioRawFrame).audio).toEqual(
    new Uint8Array([0x01, 0x01]),
  );
});
