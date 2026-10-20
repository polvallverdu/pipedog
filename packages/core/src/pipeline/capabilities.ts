// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/capabilities.py

/**
 * What a bot does in a session, reported so clients can configure themselves.
 *
 * `PipelineWorker` derives a `BotCapabilities` from its pipeline's transports
 * and parameters, and RTVI sends it to the client in the `bot-ready` message.
 */

export interface BotCapabilitiesOptions {
  audioIn?: boolean | null;
  audioOut?: boolean | null;
  videoIn?: boolean | null;
  screenIn?: boolean | null;
  videoOut?: boolean | null;
  metrics?: boolean | null;
}

/** Wire (JSON) form of `BotCapabilities`, with the upstream snake_case keys. */
export interface BotCapabilitiesDump {
  audio_in?: boolean | null;
  audio_out?: boolean | null;
  video_in?: boolean | null;
  screen_in?: boolean | null;
  video_out?: boolean | null;
  metrics?: boolean | null;
}

const FIELDS = ["audioIn", "audioOut", "videoIn", "screenIn", "videoOut", "metrics"] as const;
type Field = (typeof FIELDS)[number];

const WIRE_KEYS: Record<Field, keyof BotCapabilitiesDump> = {
  audioIn: "audio_in",
  audioOut: "audio_out",
  videoIn: "video_in",
  screenIn: "screen_in",
  videoOut: "video_out",
  metrics: "metrics",
};

/**
 * What a bot does in a session.
 *
 * Every field is optional: `null` means unknown, and a client should keep its
 * default behavior for it. `false` means the bot does not do it, so a client
 * can hide the matching UI.
 *
 * - `audioIn`: whether the bot receives the user's audio.
 * - `audioOut`: whether the bot sends audio to the user.
 * - `videoIn`: whether the bot receives the user's video.
 * - `screenIn`: whether the bot receives the user's screen share. Known when
 *   the transport captures its video sources from `videoInSources`; unknown
 *   when the application captures them itself.
 * - `videoOut`: whether the bot sends video to the user.
 * - `metrics`: whether the bot reports metrics.
 */
export class BotCapabilities {
  audioIn: boolean | null;
  audioOut: boolean | null;
  videoIn: boolean | null;
  screenIn: boolean | null;
  videoOut: boolean | null;
  metrics: boolean | null;

  constructor(options: BotCapabilitiesOptions = {}) {
    this.audioIn = options.audioIn ?? null;
    this.audioOut = options.audioOut ?? null;
    this.videoIn = options.videoIn ?? null;
    this.screenIn = options.screenIn ?? null;
    this.videoOut = options.videoOut ?? null;
    this.metrics = options.metrics ?? null;
  }

  /**
   * Combine the capabilities of two parts of the same bot.
   *
   * A field is `true` if either side is `true`, `false` if either side is
   * `false` and neither is `true`, and `null` if both are unknown.
   *
   * @param other The capabilities to combine with these.
   * @returns The combined capabilities.
   */
  combine(other: BotCapabilities): BotCapabilities {
    const combined: BotCapabilitiesOptions = {};
    for (const field of FIELDS) {
      const values = [this[field], other[field]].filter((v): v is boolean => v !== null);
      combined[field] = values.length > 0 ? values.some(Boolean) : null;
    }
    return new BotCapabilities(combined);
  }

  /**
   * Apply the fields `other` knows on top of these capabilities.
   *
   * @param other The capabilities whose known (non-null) fields win.
   * @returns These capabilities with `other`'s known fields applied.
   */
  override(other: BotCapabilities): BotCapabilities {
    const updated = new BotCapabilities(this);
    for (const field of FIELDS) {
      if (other[field] !== null) updated[field] = other[field];
    }
    return updated;
  }

  /**
   * The wire form, with upstream's snake_case keys (pydantic `model_dump`).
   *
   * @param options.excludeNone Leave out unknown (null) fields.
   */
  modelDump(options: { excludeNone?: boolean } = {}): BotCapabilitiesDump {
    const dump: BotCapabilitiesDump = {};
    for (const field of FIELDS) {
      const value = this[field];
      if (options.excludeNone && value === null) continue;
      dump[WIRE_KEYS[field]] = value;
    }
    return dump;
  }

  /** Serialize with the wire keys, as pydantic does. */
  toJSON(): BotCapabilitiesDump {
    return this.modelDump();
  }
}
