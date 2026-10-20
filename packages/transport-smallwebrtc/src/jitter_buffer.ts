// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause AND BSD-3-Clause
//
// `JitterBuffer` is a port of aiortc's jitterbuffer.py, Copyright (c) Jeremy
// Lainé, BSD-3-Clause (see THIRD_PARTY_LICENSES.md). `AudioJitterBuffer` is ours.

/**
 * Receive-side packet buffers.
 *
 * - `JitterBuffer` reassembles video frames from RTP packets, as aiortc's
 *   receiver does (pipecat's SmallWebRTC enlarges it for screen shares).
 * - `AudioJitterBuffer` reorders audio packets and reports the gaps, so the
 *   Opus decoder can conceal (PLC) or recover (FEC) lost packets.
 */

/** The fields of an RTP packet the buffers use. */
export interface JitterPacket {
  sequenceNumber: number;
  timestamp: number;
  /** The depayloaded data (codec framing removed). */
  _data?: Uint8Array;
}

const MAX_MISORDER = 100;

function uint16Add(a: number, b: number): number {
  return (a + b) & 0xffff;
}

/** A complete encoded frame. */
export class JitterFrame {
  data: Uint8Array;
  timestamp: number;

  constructor(data: Uint8Array, timestamp: number) {
    this.data = data;
    this.timestamp = timestamp;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export interface JitterBufferOptions {
  /** Packets the buffer holds; a power of 2. */
  capacity: number;
  /** Complete frames to hold before releasing the first. */
  prefetch?: number;
  /** Whether the buffer holds video, which asks for keyframes (PLI) on loss. */
  isVideo?: boolean;
}

/**
 * Reassembles encoded frames from RTP packets (aiortc's `JitterBuffer`).
 *
 * A frame is complete when a packet with the next timestamp arrives after all
 * of its packets.
 */
export class JitterBuffer {
  protected _capacity: number;
  protected _origin: number | null = null;
  protected _packets: (JitterPacket | null)[];
  protected _prefetch: number;
  protected _isVideo: boolean;

  constructor(options: JitterBufferOptions) {
    const { capacity } = options;
    if ((capacity & (capacity - 1)) !== 0) throw new Error("capacity must be a power of 2");
    this._capacity = capacity;
    this._packets = new Array(capacity).fill(null);
    this._prefetch = options.prefetch ?? 0;
    this._isVideo = options.isVideo ?? false;
  }

  get capacity(): number {
    return this._capacity;
  }

  /**
   * Add a packet.
   *
   * @returns `[pli, frame]`: whether a keyframe should be requested, and the
   *   frame the packet completed, if any.
   */
  add(packet: JitterPacket): [boolean, JitterFrame | null] {
    let pliFlag = false;
    let delta: number;
    let misorder: number;
    if (this._origin === null) {
      this._origin = packet.sequenceNumber;
      delta = 0;
      misorder = 0;
    } else {
      delta = uint16Add(packet.sequenceNumber, -this._origin);
      misorder = uint16Add(this._origin, -packet.sequenceNumber);
    }

    if (misorder < delta) {
      if (misorder >= MAX_MISORDER) {
        this.remove(this.capacity);
        this._origin = packet.sequenceNumber;
        delta = misorder = 0;
        if (this._isVideo) pliFlag = true;
      } else {
        return [pliFlag, null];
      }
    }

    if (delta >= this.capacity) {
      // remove just enough frames to fit the received packets
      const excess = delta - this.capacity + 1;
      if (this.smartRemove(excess)) this._origin = packet.sequenceNumber;
      if (this._isVideo) pliFlag = true;
    }

    const pos = packet.sequenceNumber % this._capacity;
    this._packets[pos] = packet;

    return [pliFlag, this._removeFrame(packet.sequenceNumber)];
  }

  protected _removeFrame(_sequenceNumber: number): JitterFrame | null {
    let frame: JitterFrame | null = null;
    let frames = 0;
    let packets: JitterPacket[] = [];
    let remove = 0;
    let timestamp: number | null = null;

    for (let count = 0; count < this.capacity; count++) {
      const pos = (this._origin! + count) % this._capacity;
      const packet = this._packets[pos];
      if (!packet) break;
      if (timestamp === null) {
        timestamp = packet.timestamp;
      } else if (packet.timestamp !== timestamp) {
        // we now have a complete frame, only store the first one
        if (frame === null) {
          frame = new JitterFrame(
            concat(packets.map((p) => p._data ?? new Uint8Array(0))),
            timestamp,
          );
          remove = count;
        }

        // check we have prefetched enough
        frames += 1;
        if (frames >= this._prefetch) {
          this.remove(remove);
          return frame;
        }

        // start a new frame
        packets = [];
        timestamp = packet.timestamp;
      }
      packets.push(packet);
    }
    return null;
  }

  /** Drop `count` packet slots from the start of the buffer. */
  remove(count: number): void {
    if (count > this._capacity) throw new Error("count exceeds capacity");
    for (let i = 0; i < count; i++) {
      const pos = this._origin! % this._capacity;
      this._packets[pos] = null;
      this._origin = uint16Add(this._origin!, 1);
    }
  }

  /**
   * Makes sure that all packages belonging to the same frame are removed
   * to prevent sending corrupted frames to the decoder.
   */
  smartRemove(count: number): boolean {
    let timestamp: number | null = null;
    for (let i = 0; i < this._capacity; i++) {
      const pos = this._origin! % this._capacity;
      const packet = this._packets[pos];
      if (packet) {
        if (i >= count && timestamp !== packet.timestamp) break;
        timestamp = packet.timestamp;
      }
      this._packets[pos] = null;
      this._origin = uint16Add(this._origin!, 1);
      if (i === this._capacity - 1) return true;
    }
    return false;
  }
}

/** What `AudioJitterBuffer.add()` releases, in order. */
export type AudioJitterOutput<P extends JitterPacket> =
  | { packet: P; lost?: undefined }
  | { packet?: undefined; lost: number };

/**
 * Reorders audio packets with as little delay as possible.
 *
 * A packet in sequence is released at once. A packet after a gap is held
 * until the gap fills or the held audio spans `latency` (in RTP clock units),
 * then the gap is reported as `lost` packets so the decoder can conceal it.
 * Late and duplicate packets are dropped.
 */
export class AudioJitterBuffer<P extends JitterPacket = JitterPacket> {
  #latency: number;
  #next: number | null = null;
  #held = new Map<number, P>();

  /** @param latency How long a gap may hold later packets, in RTP clock units. */
  constructor(latency: number) {
    this.#latency = latency;
  }

  add(packet: P): AudioJitterOutput<P>[] {
    const out: AudioJitterOutput<P>[] = [];
    if (this.#next === null) {
      this.#next = uint16Add(packet.sequenceNumber, 1);
      out.push({ packet });
      return out;
    }
    const ahead = uint16Add(packet.sequenceNumber, -this.#next);
    if (ahead >= 0x8000) return out; // late or duplicate
    if (ahead > 0x1000) {
      // A jump this large is a new stream (e.g. the sender restarted): resync.
      this.reset();
      return this.add(packet);
    }
    this.#held.set(packet.sequenceNumber, packet);
    this.#release(out);
    while (this.#held.size > 0) {
      const next = this.#next!;
      const offset = (p: P) => uint16Add(p.sequenceNumber, -next);
      let oldest: P | null = null;
      let newest: P | null = null;
      for (const p of this.#held.values()) {
        if (!oldest || offset(p) < offset(oldest)) oldest = p;
        if (!newest || offset(p) > offset(newest)) newest = p;
      }
      if ((newest!.timestamp - oldest!.timestamp) >>> 0 < this.#latency) break;
      // Give up on the gap before the oldest held packet.
      out.push({ lost: offset(oldest!) });
      this.#next = oldest!.sequenceNumber;
      this.#release(out);
    }
    return out;
  }

  #release(out: AudioJitterOutput<P>[]): void {
    for (;;) {
      const next = this.#held.get(this.#next!);
      if (!next) return;
      this.#held.delete(this.#next!);
      out.push({ packet: next });
      this.#next = uint16Add(this.#next!, 1);
    }
  }

  /** Forget the stream. */
  reset(): void {
    this.#next = null;
    this.#held.clear();
  }
}
