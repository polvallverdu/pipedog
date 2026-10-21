// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat (bun, node, deno; workerd is unsupported):
// - imports every module (nothing may load @livekit/rtc-node at import time);
// - signs a roomCreate token with LiveKitRESTHelper (livekit-server-sdk) and
//   sends DeleteRoom to an in-process fake `fetch`;
// - loads the real @livekit/rtc-node native addon through loadRtc(), builds
//   LiveKitTransport's video publish options, converts Pipecat audio and video
//   to LiveKit frames as LiveKitOutputTransport does, captures audio on a
//   native AudioSource, and converts an I420 frame to RGB24 as
//   LiveKitInputTransport does with a user's camera.
//
// Joining a room needs a LiveKit server; test/e2e.test.ts covers that on Bun,
// Node and Deno against livekit-server in Docker.

import { OutputImageRawFrame } from "@pipedog/core/frames/frames";
import * as index from "@pipedog/transport-livekit";
import { loadRtc, rtc, rtcLoaded } from "@pipedog/transport-livekit/rtc";
import {
  type LiveKitOutputTransport,
  LiveKitParams,
  LiveKitTransport,
} from "@pipedog/transport-livekit/transport";
import { LiveKitRESTHelper } from "@pipedog/transport-livekit/utils";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`transport-livekit smoke: ${message}`);
}

export default async function smoke(): Promise<Record<string, unknown>> {
  check("LiveKitTransport" in index, "index exports LiveKitTransport");
  check(!rtcLoaded(), "@livekit/rtc-node was loaded at import time");

  // REST helper: token + request, no native code.
  let authorization = "";
  const helper = new LiveKitRESTHelper({
    apiKey: "devkey",
    apiSecret: "secretsecretsecretsecretsecretsecret",
    apiUrl: "https://lk.invalid",
    fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  check(await helper.deleteRoomByName("r"), "deleteRoomByName");
  check(authorization.split(".").length === 3, "a signed JWT");

  // The native SDK.
  await loadRtc();
  const params = new LiveKitParams({
    audioOutEnabled: true,
    videoOutEnabled: true,
    videoOutWidth: 4,
    videoOutHeight: 4,
    videoOutMaxBitrate: 500_000,
    videoOutCodec: "vp8",
  });
  const transport = new LiveKitTransport({
    url: "ws://lk.invalid",
    token: "t",
    roomName: "r",
    params,
  });
  const options = transport._client._videoPublishOptions();
  check(options.videoCodec === rtc.VideoCodec.VP8, "video codec");
  check(options.videoEncoding?.maxBitrate === 500_000n, "video bitrate");

  const output = transport.output() as LiveKitOutputTransport & { _sampleRate: number };
  output._sampleRate = 16000;
  const audio = new Uint8Array(320 * 2);
  const audioFrame = output._convertPipecatAudioToLivekit(audio);
  check(audioFrame.samplesPerChannel === 320, "audio frame size");

  const image = new Uint8Array(4 * 4 * 3).fill(128);
  const videoFrame = output._convertPipecatVideoToLivekit(
    new OutputImageRawFrame({ image, size: [4, 4], format: "RGB" }),
  );
  check(videoFrame?.type === rtc.VideoBufferType.RGB24, "RGB video frame");

  const source = new rtc.AudioSource(16000, 1, 1000);
  await source.captureFrame(audioFrame);
  await source.close();

  const i420 = new rtc.VideoFrame(new Uint8Array(24), 4, 4, rtc.VideoBufferType.I420);
  const rgb = i420.convert(rtc.VideoBufferType.RGB24);
  check(rgb.data.length === 4 * 4 * 3, "I420 -> RGB24");

  await rtc.dispose();
  return { converted: rgb.data.length, audioSamples: audioFrame.samplesPerChannel };
}
