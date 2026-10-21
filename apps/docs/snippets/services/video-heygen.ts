// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/video/heygen.mdx. Type-checked on every docs build.

import type { FrameProcessor } from "@pipedog/core/processors/frame_processor";
import type { BaseTransport } from "@pipedog/core/transports/base_transport";

declare const transport: BaseTransport;
declare const stt: FrameProcessor;
declare const llm: FrameProcessor;
declare const tts: FrameProcessor;
declare const userAggregator: FrameProcessor;
declare const assistantAggregator: FrameProcessor;

// #region service
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import {
  LiveAvatarNewSessionRequest,
  VideoEncoding,
  VideoSettings,
} from "@pipedog/heygen/api_liveavatar";
import { ServiceType } from "@pipedog/heygen/client";
import { HeyGenVideoService } from "@pipedog/heygen/video";

const heygen = new HeyGenVideoService({
  apiKey: process.env.HEYGEN_LIVE_AVATAR_API_KEY ?? "",
  serviceType: ServiceType.LIVE_AVATAR,
  sessionRequest: new LiveAvatarNewSessionRequest({
    avatarId: "<your LiveAvatar avatar id>",
    videoSettings: new VideoSettings({ encoding: VideoEncoding.H264 }),
  }),
});

// The avatar speaks the TTS audio; its video and audio come back as frames that
// the output transport sends to the user.
const worker = new PipelineWorker(
  new Pipeline([
    transport.input(),
    stt,
    userAggregator,
    llm,
    tts,
    heygen,
    transport.output(),
    assistantAggregator,
  ]),
  { params: new PipelineParams({ audioInSampleRate: 16000, audioOutSampleRate: 24000 }) },
);

// #endregion service

// #region transport
import { HeyGenParams, HeyGenTransport } from "@pipedog/transport-heygen/transport";

const heygenTransport = new HeyGenTransport({
  apiKey: process.env.HEYGEN_LIVE_AVATAR_API_KEY ?? "",
  serviceType: ServiceType.LIVE_AVATAR,
  sessionRequest: new LiveAvatarNewSessionRequest({ avatarId: "<your avatar id>" }),
  params: new HeyGenParams({ audioInEnabled: true, audioOutEnabled: true }),
});

heygenTransport.eventHandler("on_client_connected", async (_transport, participant) => {
  console.log(`user joined the avatar's room: ${participant}`);
});

const avatarWorker = new PipelineWorker(
  new Pipeline([
    heygenTransport.input(),
    stt,
    userAggregator,
    llm,
    tts,
    heygenTransport.output(),
    assistantAggregator,
  ]),
);

// #endregion transport

export { avatarWorker, worker };
