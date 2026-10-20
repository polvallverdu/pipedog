// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/video_in_sampler.py

/** Selection of the incoming video frames an input transport passes on. */

import { time } from "@pipedog/asyncio";
import type { UserImageRequestFrame } from "../frames/frames.ts";

/**
 * How early a frame may arrive and still count as due, at most half an
 * interval. It covers jitter in the incoming stream, which is about the same at
 * any framerate.
 */
export const JITTER_TOLERANCE_SECS = 0.05;

/**
 * The sampler framerate for a `captureParticipantVideo()` call's arguments.
 *
 * A sampler passes on only the frames that answer image requests at a
 * framerate of `0`, which is how `onRequestOnly` is applied.
 *
 * Porting note: upstream warns that `framerate=0` is deprecated in favour of
 * `on_request_only=True`; the deprecation warning is not ported (`method` is
 * kept so callers have the same signature).
 */
export function _captureFramerate(
  framerate: number | null,
  onRequestOnly: boolean,
  _method: string,
): number | null {
  if (onRequestOnly) return 0;
  return framerate;
}

/**
 * Decides which frames of one incoming video source a transport passes on.
 *
 * A user's camera or screen share sends frames at its own rate, often 15-30
 * per second, while a bot usually wants fewer: a vision bot may want one a
 * second, or only a frame when it asks for one. An input transport keeps one
 * sampler per video source and calls `sample()` for every frame that arrives;
 * the sampler says whether to pass that frame on or drop it.
 *
 * The framerate decides which frames are passed on:
 *
 * - `null`: every frame.
 * - `0`: only frames that answer an image request.
 * - `N > 0`: `N` frames per second, on the schedule described below.
 *
 * Whatever the framerate, an image request queued with `addRequest()` is
 * answered by the next frame that arrives, which is passed on with the
 * request.
 *
 * For `N > 0`, frames are due on a fixed schedule, one interval (`1 / N`
 * seconds) apart:
 *
 * - **On schedule.** A frame is due once its scheduled time comes, or up to a
 *   tolerance before it, since frames never arrive exactly on time. The next
 *   frame is scheduled one interval after this frame's *scheduled* time, not
 *   its arrival time, so the rate doesn't drift. A frame arriving late moves
 *   the schedule to its arrival, so a stream slower than the framerate passes
 *   every frame rather than falling further and further behind.
 * - **Fresh start.** The first frame, a frame that answers a request, and the
 *   first frame after a stall (more than an interval past its scheduled time)
 *   start a new schedule from their arrival. After a stall this passes on one
 *   frame instead of a burst catching up on the missed ones.
 *
 * The tolerance is the smaller of `JITTER_TOLERANCE_SECS` and half an
 * interval. At low framerates the next frame after any frame is therefore
 * close to a full interval later; at framerates near the stream's own rate it
 * covers the stream's jitter, so every frame passes.
 */
export class _VideoInSampler {
  protected _framerate: number | null;
  // When the next frame is due. Zero before the first frame, which then
  // counts as arriving after a stall and starts the schedule.
  protected _nextTime = 0.0;
  protected _requests: UserImageRequestFrame[] = [];

  /**
   * Initialize the sampler.
   *
   * @param framerate Frames per second to pass on. `0` passes on frames only
   *   to answer requests, and `null` passes on every frame.
   */
  constructor(framerate: number | null) {
    this._framerate = framerate;
  }

  /** The frames per second this sampler passes on. */
  get framerate(): number | null {
    return this._framerate;
  }

  set framerate(framerate: number | null) {
    this._framerate = framerate;
  }

  /**
   * Queue an image request for the next frame to answer.
   *
   * @param request The image request to answer.
   */
  addRequest(request: UserImageRequestFrame): void {
    this._requests.push(request);
  }

  /**
   * Remove and return the image requests waiting for a frame.
   *
   * @returns The waiting requests, oldest first.
   */
  takeRequests(): UserImageRequestFrame[] {
    const requests = this._requests;
    this._requests = [];
    return requests;
  }

  /**
   * Decide whether to pass on the frame that just arrived.
   *
   * @returns A tuple of `[due, request]`: `due` is whether to pass the frame
   *   on, and `request` is the `UserImageRequestFrame` it answers, or `null`.
   */
  sample(): [boolean, UserImageRequestFrame | null] {
    // A waiting request is always answered by this frame.
    const request = this._requests.length > 0 ? (this._requests.shift() ?? null) : null;

    if (this._framerate === null) return [true, request];
    if (this._framerate === 0) return [request !== null, request];

    const now = time();
    const interval = 1 / this._framerate;
    const tolerance = Math.min(JITTER_TOLERANCE_SECS, interval / 2);

    if (request === null && now < this._nextTime - tolerance) {
      // Too early: the next frame isn't due yet.
      return [false, null];
    }

    if (request || now - this._nextTime > interval) {
      // Fresh start (a request, the first frame, or a stall): the next frame
      // is due one interval from now.
      this._nextTime = now + interval;
    } else {
      // On schedule: one interval after this frame's scheduled time, or after
      // its arrival if it came late.
      this._nextTime = Math.max(this._nextTime, now - tolerance) + interval;
    }

    return [true, request];
  }
}

/** An input transport's video samplers, by participant and video source. */
export class _VideoInSamplers {
  // Python keys a dict by the (participant_id, video_source) tuple. A Map keeps
  // the same insertion order; the entry carries both parts of the key.
  protected _samplers = new Map<string, [string, string, _VideoInSampler]>();

  static #key(participantId: string, videoSource: string): string {
    return JSON.stringify([participantId, videoSource]);
  }

  #get(participantId: string, videoSource: string): _VideoInSampler | undefined {
    return this._samplers.get(_VideoInSamplers.#key(participantId, videoSource))?.[2];
  }

  /**
   * Start sampling a source, or change its framerate.
   *
   * Changing the framerate keeps the source's sampler, so image requests
   * already waiting on it are still answered.
   *
   * @param participantId The participant whose video this is.
   * @param videoSource The video source, e.g. `"camera"` or `"screenVideo"`.
   * @param framerate Frames per second to pass on. `0` passes on frames only
   *   to answer requests, and `null` passes on every frame.
   */
  capture(participantId: string, videoSource: string, framerate: number | null): void {
    const sampler = this.#get(participantId, videoSource);
    if (sampler) {
      sampler.framerate = framerate;
    } else {
      this._samplers.set(_VideoInSamplers.#key(participantId, videoSource), [
        participantId,
        videoSource,
        new _VideoInSampler(framerate),
      ]);
    }
  }

  /**
   * Whether a source is being sampled.
   *
   * @param participantId The participant whose video this is.
   * @param videoSource The video source.
   * @returns Whether `capture()` was called for the source.
   */
  isCapturing(participantId: string, videoSource: string): boolean {
    return this._samplers.has(_VideoInSamplers.#key(participantId, videoSource));
  }

  /**
   * Queue an image request for the next frame of a source to answer.
   *
   * @param participantId The participant whose video is requested.
   * @param videoSource The video source requested.
   * @param request The image request to answer.
   * @returns Whether the request was queued; `false` if the source isn't being
   *   sampled, so nothing would answer it.
   */
  addRequest(participantId: string, videoSource: string, request: UserImageRequestFrame): boolean {
    const sampler = this.#get(participantId, videoSource);
    if (sampler) sampler.addRequest(request);
    return sampler !== undefined;
  }

  /**
   * Decide whether to pass on the frame that just arrived from a source.
   *
   * @param participantId The participant the frame came from.
   * @param videoSource The video source the frame came from.
   * @returns A tuple of `[due, request]`, as from `_VideoInSampler.sample()`.
   *   A frame from a source that isn't being sampled is never due.
   */
  sample(participantId: string, videoSource: string): [boolean, UserImageRequestFrame | null] {
    const sampler = this.#get(participantId, videoSource);
    return sampler ? sampler.sample() : [false, null];
  }

  /**
   * Remove and return image requests waiting for a frame, keeping the samplers.
   *
   * @param participantId The participant whose requests to take.
   * @param videoSource The video source whose requests to take, or `null` for
   *   all of the participant's sources.
   * @returns The waiting requests.
   */
  takeRequests(participantId: string, videoSource: string | null = null): UserImageRequestFrame[] {
    const requests: UserImageRequestFrame[] = [];
    for (const [participant, source, sampler] of this._samplers.values()) {
      if (participant === participantId && (videoSource === null || videoSource === source)) {
        requests.push(...sampler.takeRequests());
      }
    }
    return requests;
  }

  /**
   * Stop sampling every video source of a participant.
   *
   * @param participantId The participant to forget, e.g. one who left.
   * @returns The image requests that were waiting on the participant's video.
   */
  removeParticipant(participantId: string): UserImageRequestFrame[] {
    const requests = this.takeRequests(participantId);
    for (const [key, [participant]] of [...this._samplers]) {
      if (participant === participantId) this._samplers.delete(key);
    }
    return requests;
  }

  /**
   * Stop sampling every video source.
   *
   * @returns The image requests that were waiting on any of them.
   */
  clear(): UserImageRequestFrame[] {
    const requests: UserImageRequestFrame[] = [];
    for (const [, , sampler] of this._samplers.values()) requests.push(...sampler.takeRequests());
    this._samplers.clear();
    return requests;
  }
}
