// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A stand-in for TEN VAD's WebAssembly module, written for the tests and the
// compat smoke test. It implements the interface `TenVADModule` describes over
// a plain ArrayBuffer heap; it contains nothing of TEN's code. Its "model" is
// the frame's RMS level: silence scores 0, a loud tone close to 1.

import type { TenVADModule } from "../src/ten_vad.ts";

export interface FakeTenVADOptions {
  /** Initial heap size in bytes (default 256). Small, so allocations grow it. */
  initialHeap?: number;
  /** Grow the heap (replacing every HEAP view) inside each `_ten_vad_process` call. */
  growOnProcess?: boolean;
}

/** A fake TEN VAD module: a bump allocator and an RMS "model". */
export class FakeTenVADModule implements TenVADModule {
  HEAP16!: Int16Array;
  HEAP32!: Int32Array;
  HEAPF32!: Float32Array;
  HEAPU8!: Uint8Array;

  /** Every `_ten_vad_create` call: [handlePtr, hopSize, threshold]. */
  created: [number, number, number][] = [];
  /** Every `_ten_vad_destroy` call's handlePtr. */
  destroyed: number[] = [];
  /** Every `_malloc`'d pointer. */
  allocated: number[] = [];
  /** Every `_free`'d pointer. */
  freed: number[] = [];
  /** Number of `_ten_vad_process` calls. */
  processed = 0;
  /** Number of times the heap grew. */
  grows = 0;
  /** The next `_ten_vad_process` call returns -1. */
  failNextProcess = false;
  /** `_ten_vad_create` returns -1. */
  failCreate = false;

  #top = 16; // keep 0 as the null pointer
  #nextHandle = 1000;
  #instances = new Map<number, { hopSize: number; threshold: number }>();
  #growOnProcess: boolean;

  constructor(options: FakeTenVADOptions = {}) {
    this.#setBuffer(new ArrayBuffer(options.initialHeap ?? 256));
    this.#growOnProcess = options.growOnProcess ?? false;
  }

  #setBuffer(buffer: ArrayBuffer): void {
    this.HEAPU8 = new Uint8Array(buffer);
    this.HEAP16 = new Int16Array(buffer);
    this.HEAP32 = new Int32Array(buffer);
    this.HEAPF32 = new Float32Array(buffer);
  }

  /** Grow memory to `size` bytes as Emscripten does: a new buffer, and new views over it. */
  grow(size: number): void {
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.HEAPU8);
    // Scribble over the old memory, so a stale view reads garbage.
    this.HEAPU8.fill(0xa5);
    this.#setBuffer(next);
    this.grows += 1;
  }

  _malloc(size: number): number {
    const ptr = this.#top;
    this.#top += Math.ceil(size / 16) * 16;
    if (this.#top > this.HEAPU8.length) this.grow(Math.max(this.HEAPU8.length * 2, this.#top));
    this.allocated.push(ptr);
    return ptr;
  }

  _free(ptr: number): void {
    this.freed.push(ptr);
  }

  _ten_vad_create(handlePtr: number, hopSize: number, threshold: number): number {
    this.created.push([handlePtr, hopSize, threshold]);
    if (this.failCreate) return -1;
    const handle = this.#nextHandle++;
    this.#instances.set(handle, { hopSize, threshold });
    // TEN allocates its state: that may grow memory.
    this._malloc(64);
    this.HEAP32[handlePtr >> 2] = handle;
    return 0;
  }

  _ten_vad_process(
    handle: number,
    audioDataPtr: number,
    audioDataLength: number,
    outProbabilityPtr: number,
    outFlagPtr: number,
  ): number {
    this.processed += 1;
    if (this.failNextProcess) {
      this.failNextProcess = false;
      return -1;
    }
    const instance = this.#instances.get(handle);
    if (!instance || audioDataLength !== instance.hopSize) return -1;
    let sum = 0;
    for (let i = 0; i < audioDataLength; i++) {
      const s = (this.HEAP16[(audioDataPtr >> 1) + i] as number) / 32768;
      sum += s * s;
    }
    const probability = Math.min(1, Math.sqrt(sum / audioDataLength) * 10);
    // A little: the point is the new views, and the tests process many frames.
    if (this.#growOnProcess) this.grow(this.HEAPU8.length + 16);
    this.HEAPF32[outProbabilityPtr >> 2] = probability;
    this.HEAP32[outFlagPtr >> 2] = probability >= instance.threshold ? 1 : 0;
    return 0;
  }

  _ten_vad_destroy(handlePtr: number): number {
    this.destroyed.push(handlePtr);
    const handle = this.HEAP32[handlePtr >> 2] as number;
    if (!this.#instances.delete(handle)) return -1;
    this.HEAP32[handlePtr >> 2] = 0;
    return 0;
  }

  _ten_vad_get_version(): number {
    const text = new TextEncoder().encode("fake-1.0\0");
    const ptr = this._malloc(text.length);
    this.HEAPU8.set(text, ptr);
    return ptr;
  }

  UTF8ToString(ptr: number): string {
    let end = ptr;
    while (this.HEAPU8[end] !== 0) end++;
    return new TextDecoder().decode(this.HEAPU8.subarray(ptr, end));
  }
}

/** 16 kHz int16 PCM: a 440 Hz tone of the given amplitude (0 for silence), as bytes. */
export function tone(samples: number, amplitude: number, start = 0): Uint8Array {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * (start + i)) / 16000));
  }
  return new Uint8Array(pcm.buffer);
}
