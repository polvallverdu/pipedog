// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_video_in_sources.py

/**
 * The SmallWebRTC tests of upstream's `test_video_in_sources.py`:
 * `TestSmallWebRTCVideoInSampling`, `TestSmallWebRTCVideoInSourcesCapture`,
 * and the SmallWebRTC cases of `TestImageRequestsWithoutVideo`,
 * `TestCaptureParticipantVideo` and `TestGetClientId`. The rest of that file
 * (base classes, Daily, LiveKit, Vonage) is ported with those packages.
 */

import { describe, expect, mock, spyOn, test } from "bun:test";
import { UserImageRawFrame, UserImageRequestFrame } from "@pipedog/core/frames/frames";
import { TransportParams, VideoInSourceParams } from "@pipedog/core/transports/base_transport";
import { _VideoInSampler, _VideoInSamplers } from "@pipedog/core/transports/video_in_sampler";
import { logger } from "@pipedog/core/utils/logger";
import type { SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import {
  _PEER_ID,
  type SmallWebRTCClient,
  SmallWebRTCInputTransport,
  SmallWebRTCTransport,
} from "@pipedog/transport-smallwebrtc/transport";

function imageFrame(): UserImageRawFrame {
  return new UserImageRawFrame({
    userId: "peer",
    image: new Uint8Array(0),
    size: [1, 1],
    format: "RGB",
  });
}

function setSampler(samplers: _VideoInSamplers, source: string, sampler: _VideoInSampler): void {
  (samplers as any)._samplers.set(JSON.stringify([_PEER_ID, source]), [_PEER_ID, source, sampler]);
}

function getSampler(samplers: _VideoInSamplers, source: string): _VideoInSampler {
  return (samplers as any)._samplers.get(JSON.stringify([_PEER_ID, source]))[2];
}

describe("TestSmallWebRTCVideoInSampling", () => {
  function fakeInput(frames: UserImageRawFrame[], samplers: Record<string, _VideoInSampler>): any {
    const fake: any = {
      _client: {
        async *readVideoFrame(_source: string) {
          for (const frame of frames) yield frame;
        },
        videoSourceEnabled: () => true,
      },
      _videoSamplers: new _VideoInSamplers(),
      _params: new TransportParams({ videoInEnabled: true }),
      pushVideoFrame: mock(async (_frame: UserImageRawFrame) => {}),
      createTask: mock((_fn: unknown, _name?: string) => ({})),
    };
    for (const [videoSource, sampler] of Object.entries(samplers)) {
      setSampler(fake._videoSamplers, videoSource, sampler);
    }
    return fake;
  }

  const pushed = (fake: any): UserImageRawFrame[] =>
    fake.pushVideoFrame.mock.calls.map((c: any[]) => c[0]);

  test("test_unthrottled_source_passes_every_frame", async () => {
    const fake = fakeInput([imageFrame(), imageFrame(), imageFrame()], {
      camera: new _VideoInSampler(null),
    });
    await SmallWebRTCInputTransport.prototype._receiveVideo.call(fake, "camera");
    expect(fake.pushVideoFrame).toHaveBeenCalledTimes(3);
  });

  test("test_request_rides_on_the_pushed_frame", async () => {
    const sampler = new _VideoInSampler(0);
    const request = new UserImageRequestFrame({
      userId: "requester",
      text: "describe",
      appendToContext: true,
    });
    sampler.addRequest(request);
    const fake = fakeInput([imageFrame(), imageFrame()], { camera: sampler });

    await SmallWebRTCInputTransport.prototype._receiveVideo.call(fake, "camera");

    const frames = pushed(fake);
    expect(frames.length).toEqual(1);
    const [frame] = frames;
    expect(frame!.request).toBe(request);
    expect(frame!.text).toEqual("describe");
    expect(frame!.appendToContext).toBe(true);
    expect(frame!.userId).toEqual("peer");
  });

  test("test_waiting_requests_answered_by_successive_frames", async () => {
    const sampler = new _VideoInSampler(0);
    const requests = [
      new UserImageRequestFrame({ userId: "a" }),
      new UserImageRequestFrame({ userId: "b" }),
    ];
    for (const request of requests) sampler.addRequest(request);
    const fake = fakeInput([imageFrame(), imageFrame()], { camera: sampler });

    await SmallWebRTCInputTransport.prototype._receiveVideo.call(fake, "camera");

    expect(pushed(fake).map((f) => f.request)).toEqual(requests);
  });

  test("test_request_starts_an_uncaptured_source", async () => {
    const fake = fakeInput([], {});
    fake._receiveVideoTask = null;
    const request = new UserImageRequestFrame({ userId: "requester" });

    await SmallWebRTCInputTransport.prototype.requestParticipantImage.call(fake, request);

    const sampler = getSampler(fake._videoSamplers, "camera");
    expect(sampler.framerate).toBeNull();
    expect(sampler.sample()[1]).toBe(request);
    expect(fake.createTask).toHaveBeenCalledTimes(1);
  });

  test("test_capture_sets_framerate_without_dropping_requests", async () => {
    const fake = fakeInput([], {});
    fake._receiveVideoTask = {};
    const request = new UserImageRequestFrame({ userId: "requester" });

    await SmallWebRTCInputTransport.prototype.requestParticipantImage.call(fake, request);
    await SmallWebRTCInputTransport.prototype.captureParticipantMedia.call(fake, {
      source: "camera",
      framerate: 1,
    });

    const sampler = getSampler(fake._videoSamplers, "camera");
    expect(sampler.framerate).toEqual(1);
    expect(sampler.sample()[1]).toBe(request);
  });
});

describe("TestSmallWebRTCVideoInSourcesCapture", () => {
  function fakeTransport(params: TransportParams) {
    // Captures and event handler calls share one log, so their order is recorded.
    const calls: [string, unknown[]][] = [];
    const capture = mock(async (...args: unknown[]) => {
      calls.push(["capture", args]);
    });
    const fake: any = {
      _params: params,
      _input: {
        captureParticipantMedia: capture,
        _supportsVideoInSource: (source: string) =>
          SmallWebRTCInputTransport.prototype._supportsVideoInSource.call(null, source),
        pushFrame: mock(async () => {}),
      },
      _callEventHandler: mock(async (...args: unknown[]) => {
        calls.push(["event", args]);
      }),
    };
    return { fake, calls, capture };
  }

  test("test_captures_configured_sources_on_connect", async () => {
    const params = new TransportParams({
      videoInEnabled: true,
      videoInSources: {
        camera: new VideoInSourceParams({ onRequestOnly: true }),
        screenVideo: new VideoInSourceParams({ framerate: 1 }),
      },
    });
    const { fake, calls, capture } = fakeTransport(params);

    await SmallWebRTCTransport.prototype._onClientConnected.call(fake, {} as SmallWebRTCConnection);

    expect(capture.mock.calls).toEqual([
      [{ source: "camera", framerate: 0 }],
      [{ source: "screenVideo", framerate: 1 }],
    ]);
    const names = calls.map(([name]) => name);
    expect(names.slice(0, 2)).toEqual(["capture", "capture"]);
    expect(names).toContain("event");
  });

  test("test_unsupported_source_warned_and_not_captured", async () => {
    const params = new TransportParams({
      videoInEnabled: true,
      videoInSources: { camera: new VideoInSourceParams(), microphone: new VideoInSourceParams() },
    });
    const warning = spyOn(logger, "warning");
    try {
      new SmallWebRTCInputTransport({} as SmallWebRTCClient, params);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(String(warning.mock.calls[0]![0])).toContain("microphone");
    } finally {
      warning.mockRestore();
    }

    const { fake, capture } = fakeTransport(params);
    await SmallWebRTCTransport.prototype._onClientConnected.call(fake, {} as SmallWebRTCConnection);
    expect(capture.mock.calls).toEqual([[{ source: "camera", framerate: 30 }]]);
  });

  test("test_no_sources_captures_nothing", async () => {
    const { fake, capture } = fakeTransport(new TransportParams({ videoInEnabled: true }));

    await SmallWebRTCTransport.prototype._onClientConnected.call(fake, {} as SmallWebRTCConnection);

    expect(capture).not.toHaveBeenCalled();
  });
});

describe("TestImageRequestsWithoutVideo", () => {
  // Image requests that no frame will answer are answered with an error.
  async function waitingRequest(input: SmallWebRTCInputTransport, videoSource = "camera") {
    const resultCallback = mock(async (_result: { error: string }) => {});
    const request = new UserImageRequestFrame({ userId: "p1", videoSource, resultCallback });
    await input.requestParticipantImage(request);
    return resultCallback;
  }

  function smallwebrtcInput(enabled = true): SmallWebRTCInputTransport {
    const client = {
      videoSourceEnabled: (_videoSource: string) => enabled,
    } as unknown as SmallWebRTCClient;
    const input = new SmallWebRTCInputTransport(
      client,
      new TransportParams({ videoInEnabled: true }),
    );
    (input as any).createTask = mock((_fn: unknown, _name?: string) => ({}));
    return input;
  }

  test("test_smallwebrtc_request_for_a_source_that_is_off", async () => {
    const input = smallwebrtcInput(false);

    const resultCallback = await waitingRequest(input, "screenVideo");

    expect(resultCallback.mock.calls.at(-1)![0].error).toContain("isn't sending");
  });

  test("test_smallwebrtc_waiting_request_when_the_source_turns_off", async () => {
    const input = smallwebrtcInput();
    const resultCallback = await waitingRequest(input, "screenVideo");
    expect(resultCallback).not.toHaveBeenCalled();

    await input.stopVideo("screenVideo");

    expect(resultCallback.mock.calls.at(-1)![0].error).toContain("turned off");
    expect(input._videoSamplers.isCapturing("peer", "screenVideo")).toBe(true);
  });

  test("test_smallwebrtc_transport_answers_only_when_video_turns_off", async () => {
    const transport: any = { _input: { stopVideo: mock(async (_source: string) => {}) } };

    await SmallWebRTCTransport.prototype._onTrackStatus.call(transport, "camera", true);
    await SmallWebRTCTransport.prototype._onTrackStatus.call(transport, "microphone", false);
    await SmallWebRTCTransport.prototype._onTrackStatus.call(transport, "screenVideo", false);

    expect(transport._input.stopVideo).toHaveBeenCalledTimes(1);
    expect(transport._input.stopVideo).toHaveBeenCalledWith("screenVideo");
  });

  test("test_smallwebrtc_waiting_requests_when_the_peer_disconnects", async () => {
    const input = smallwebrtcInput();
    const resultCallback = await waitingRequest(input);

    await input.removeAllVideo();

    expect(resultCallback.mock.calls.at(-1)![0].error).toContain("disconnected");
  });
});

describe("TestCaptureParticipantVideo", () => {
  // captureParticipantVideo() takes the same arguments on every transport.
  function smallwebrtc() {
    const transport = new SmallWebRTCTransport(
      { eventHandler: () => {} } as unknown as SmallWebRTCConnection,
      new TransportParams({ videoInEnabled: true }),
    );
    const capture = mock(async (_options: unknown) => {});
    transport._input = { captureParticipantMedia: capture } as unknown as SmallWebRTCInputTransport;
    return { transport, capture };
  }

  test("test_smallwebrtc_takes_the_standard_arguments", async () => {
    const { transport, capture } = smallwebrtc();

    await transport.captureParticipantVideo("pc-1", undefined, "screenVideo");
    await transport.captureParticipantVideo("pc-1", 1, "camera");

    expect(capture.mock.calls).toEqual([
      [{ source: "screenVideo", framerate: 30 }],
      [{ source: "camera", framerate: 1 }],
    ]);
  });

  test("test_on_request_only_and_deprecated_framerate_zero", async () => {
    const { transport, capture } = smallwebrtc();

    await transport.captureParticipantVideo("pc-1", undefined, undefined, { onRequestOnly: true });
    // Upstream also asserts a DeprecationWarning for a framerate of 0;
    // deprecation warnings are not ported, the framerate still applies.
    await transport.captureParticipantVideo("pc-1", 0, "screenVideo");

    expect(capture.mock.calls).toEqual([
      [{ source: "camera", framerate: 0 }],
      [{ source: "screenVideo", framerate: 0 }],
    ]);
  });

  // Deprecated upstream (calls without a participant id, 1.13.0); not ported.
  test.skip("test_smallwebrtc_calls_without_a_participant_keep_their_meaning", () => {});
});

describe("TestGetClientId", () => {
  // Each transport gets a client's id from the client its events pass.
  test("test_smallwebrtc_uses_the_peer_connection_id", () => {
    const client = { pcId: "SmallWebRTCConnection#0-1234" };
    expect(SmallWebRTCTransport.prototype.getClientId.call({}, client)).toEqual(
      "SmallWebRTCConnection#0-1234",
    );
  });
});
