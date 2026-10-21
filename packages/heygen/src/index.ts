// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * HeyGen avatar services. Subpaths mirror `pipecat.services.heygen.*`
 * (`/api_interactive_avatar`, `/api_liveavatar`, `/base_api`, `/client`, `/video`).
 *
 * Both API modules define a `VideoEncoding` enum; the root re-exports
 * LiveAvatar's (the same values). Import the Interactive Avatar one from
 * `@pipedog/heygen/api_interactive_avatar`.
 */

export {
  AvatarQuality,
  ElevenLabsSettings,
  type ElevenLabsSettingsOptions,
  HeyGenApi,
  type HeyGenApiOptions,
  HeyGenSession,
  type HeyGenSessionOptions,
  HeygenApiError,
  NewSessionRequest,
  type NewSessionRequestOptions,
  VoiceEmotion,
  VoiceSettings,
  type VoiceSettingsOptions,
} from "./api_interactive_avatar.ts";
export * from "./api_liveavatar.ts";
export * from "./base_api.ts";
export * from "./client.ts";
export * from "./video.ts";
