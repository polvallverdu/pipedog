// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Finding `sox` or `ffmpeg`, and the command lines that record and play raw PCM with them.
 *
 * Both tools read and write headerless 16-bit little-endian PCM on a pipe, which is what
 * the transport's audio frames carry. `sox -d` records from and plays to the default audio
 * device (`rec` and `play` are aliases for `sox` with `-d`). ffmpeg uses the platform's
 * capture and playback devices: AVFoundation and AudioToolbox on macOS, PulseAudio
 * (PipeWire provides it too) on Linux, DirectShow capture on Windows (no playback device).
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { defaultSpawner, type ProcessSpawner } from "./process.ts";

/** The command-line tools the transport can drive. */
export type AudioTool = "sox" | "ffmpeg";

/** Which tool to use: one of them, or the first one found (sox, then ffmpeg). */
export type AudioToolChoice = AudioTool | "auto";

/** `sox` and `ffmpeg` are both missing (or the one asked for is). */
export class LocalAudioToolNotFoundError extends Error {
  override name = "LocalAudioToolNotFoundError";
}

/** The platform's name as Node reports it. */
export type Platform = "darwin" | "linux" | "win32" | (string & {});

/** The platform the process runs on, as `process.platform` names it. */
export function currentPlatform(): Platform {
  const g = globalThis as {
    process?: { platform?: string };
    Deno?: { build?: { os?: string } };
  };
  const name = g.process?.platform ?? g.Deno?.build?.os ?? "linux";
  return name === "windows" ? "win32" : name;
}

const INSTALL_HINT =
  "Install SoX (macOS: `brew install sox`; Debian/Ubuntu: `sudo apt install sox`; Windows: `choco install sox.portable`) " +
  "or FFmpeg (`brew install ffmpeg`, `sudo apt install ffmpeg`).";

/** Whether `program` starts and exits cleanly when asked for its version. */
async function works(program: string, versionFlag: string, spawner: ProcessSpawner) {
  try {
    const proc = await spawner([program, versionFlag], { stdin: false, stdout: false });
    return (await proc.exited) === 0;
  } catch (e) {
    rethrowIfCancelled(e);
    return false;
  }
}

export interface DetectAudioToolOptions {
  /** Which tool to look for (default "auto": sox, then ffmpeg). */
  tool?: AudioToolChoice;
  /** How to start processes (default: the runtime's own). */
  spawner?: ProcessSpawner | null;
}

/**
 * Find the audio tool to use.
 *
 * @throws LocalAudioToolNotFoundError With install instructions if the tool (or, for "auto",
 *   both) is not installed.
 */
export async function detectAudioTool(options: DetectAudioToolOptions = {}): Promise<AudioTool> {
  const choice = options.tool ?? "auto";
  const spawner = options.spawner ?? defaultSpawner();
  const candidates: AudioTool[] = choice === "auto" ? ["sox", "ffmpeg"] : [choice];
  for (const tool of candidates) {
    if (await works(tool, tool === "sox" ? "--version" : "-version", spawner)) return tool;
  }
  throw new LocalAudioToolNotFoundError(
    choice === "auto"
      ? `The local audio transport needs sox or ffmpeg, and neither was found on the PATH. ${INSTALL_HINT}`
      : `The local audio transport was set to use ${choice}, which was not found on the PATH. ${INSTALL_HINT}`,
  );
}

export interface AudioStreamSpec {
  /** Sample rate in Hz. */
  sampleRate: number;
  /** Number of channels. */
  channels: number;
  /**
   * The audio device. sox: the device name for the platform's driver (CoreAudio, ALSA or
   * WaveAudio); default the system default. ffmpeg: AVFoundation index or name on macOS,
   * PulseAudio source or sink on Linux, DirectShow name on Windows.
   */
  device?: string | number | null;
  /** Override the platform (for tests). */
  platform?: Platform;
}

const SOX_DRIVERS: Record<string, string> = {
  darwin: "coreaudio",
  linux: "alsa",
  win32: "waveaudio",
};

function soxRawFormat(spec: AudioStreamSpec): string[] {
  return [
    "-t",
    "raw",
    "-r",
    String(spec.sampleRate),
    "-e",
    "signed-integer",
    "-b",
    "16",
    "-c",
    String(spec.channels),
    "-L",
  ];
}

function soxDevice(spec: AudioStreamSpec): string[] {
  if (spec.device === null || spec.device === undefined || spec.device === "") return ["-d"];
  const driver = SOX_DRIVERS[spec.platform ?? currentPlatform()];
  return driver ? ["-t", driver, String(spec.device)] : ["-d"];
}

/** The command that records raw 16-bit PCM from the microphone to stdout. */
export function recordCommand(tool: AudioTool, spec: AudioStreamSpec): string[] {
  const platform = spec.platform ?? currentPlatform();
  const device = spec.device === null || spec.device === undefined ? "" : String(spec.device);
  if (tool === "sox") {
    // rec = sox -d ...
    return ["sox", "-q", ...soxDevice(spec), ...soxRawFormat(spec), "-"];
  }
  const out = [
    "-f",
    "s16le",
    "-ar",
    String(spec.sampleRate),
    "-ac",
    String(spec.channels),
    "pipe:1",
  ];
  const head = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-fflags", "nobuffer"];
  if (platform === "darwin")
    return [...head, "-f", "avfoundation", "-i", `:${device || "default"}`, ...out];
  if (platform === "win32") {
    if (!device) {
      throw new Error(
        "ffmpeg records on Windows through DirectShow, which has no default device: set `inputDevice` to the microphone's name (see `ffmpeg -list_devices true -f dshow -i dummy`), or use sox",
      );
    }
    return [...head, "-f", "dshow", "-i", `audio=${device}`, ...out];
  }
  return [...head, "-f", "pulse", "-i", device || "default", ...out];
}

/** The command that plays raw 16-bit PCM from stdin on the speakers. */
export function playCommand(tool: AudioTool, spec: AudioStreamSpec): string[] {
  const platform = spec.platform ?? currentPlatform();
  const device = spec.device === null || spec.device === undefined ? "" : String(spec.device);
  if (tool === "sox") {
    // play = sox ... -d
    return ["sox", "-q", ...soxRawFormat(spec), "-", ...soxDevice(spec)];
  }
  const head = [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "nobuffer",
    "-f",
    "s16le",
    "-ar",
    String(spec.sampleRate),
    "-ac",
    String(spec.channels),
    "-i",
    "pipe:0",
  ];
  if (platform === "darwin") {
    return [...head, "-f", "audiotoolbox", ...(device ? ["-audio_device_index", device] : []), "-"];
  }
  if (platform === "win32") {
    throw new Error(
      "ffmpeg has no audio playback device on Windows: install sox for local audio output",
    );
  }
  return [...head, "-f", "pulse", device || "default"];
}
