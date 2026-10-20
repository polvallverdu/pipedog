// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_smallwebrtc_transport.py

/**
 * Tests for the SmallWebRTC transport client.
 *
 * Covers app-message delivery in `SmallWebRTCClient.sendMessage` /
 * `SmallWebRTCConnection.sendAppMessage`:
 *
 * 1. **Pre-open buffering** — messages sent before the data channel is open
 *    (including before the peer connection is established) are queued and
 *    flushed, in order, once the channel opens. A channel created by the
 *    remote peer may arrive already open, so the flush must fire on channel
 *    arrival, not only on the "open" event.
 *
 * 2. **Closing discard** — messages sent while the connection is closing are
 *    discarded.
 *
 * And the `MediaStreamError` handling in `SmallWebRTCClient.readAudioFrame`
 * and `readVideoFrame`:
 *
 * 1. **Park on dead track** — when the underlying track is permanently
 *    raising `MediaStreamError`, the iterator must stop calling `recv()` on it
 *    (clear the track reference) so we don't busy-loop a CPU core.
 *
 * 2. **Renegotiation resumes** — after the dead track is replaced by a fresh
 *    one (the same mechanism `_handleClientConnected` uses), the iterator
 *    must pick up frames from the new track.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createTask, sleep, type Task, waitFor } from "@pipedog/asyncio";
import { OutputTransportMessageUrgentFrame } from "@pipedog/core/frames/frames";
import { TransportParams } from "@pipedog/core/transports/base_transport";
import { SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import {
  AudioFrame,
  MediaStreamError,
  VideoStreamTrack,
} from "@pipedog/transport-smallwebrtc/media";
import { RTCPeerConnection, RtpPacketInfo } from "@pipedog/transport-smallwebrtc/rtc";
import {
  CAM_VIDEO_SOURCE,
  SCREEN_VIDEO_SOURCE,
  SmallWebRTCCallbacks,
  SmallWebRTCClient,
  SmallWebRTCTransport,
} from "@pipedog/transport-smallwebrtc/transport";
import { VideoFrame } from "@pipedog/transport-smallwebrtc/video";

/** Stands in for an `RTCDataChannel` received from the remote peer. */
class FakeDataChannel {
  readyState: string;
  sent: string[] = [];
  #handlers = new Map<string, (...args: unknown[]) => unknown>();

  constructor(readyState = "open") {
    this.readyState = readyState;
  }

  send(message: string): void {
    this.sent.push(message);
  }

  on(event: string, handler: (...args: unknown[]) => unknown) {
    this.#handlers.set(event, handler);
    return handler;
  }

  async fire(event: string): Promise<void> {
    await this.#handlers.get(event)!();
  }

  get sentTypes(): string[] {
    return this.sent.map((m) => JSON.parse(m).type);
  }
}

const noop = async (..._args: unknown[]) => {};

function makeClient(): [SmallWebRTCClient, SmallWebRTCConnection] {
  const connection = new SmallWebRTCConnection();
  const callbacks = new SmallWebRTCCallbacks({
    onAppMessage: noop,
    onClientConnected: noop,
    onClientDisconnected: noop,
    onTrackStatus: noop,
  });
  return [new SmallWebRTCClient(connection, callbacks), connection];
}

function message(messageType: string): OutputTransportMessageUrgentFrame {
  return new OutputTransportMessageUrgentFrame({ message: { type: messageType } });
}

describe("TestSendMessage", () => {
  let client: SmallWebRTCClient;
  let connection: SmallWebRTCConnection;

  beforeEach(() => {
    [client, connection] = makeClient();
  });

  afterEach(async () => {
    await connection._pc.close();
  });

  test("test_queues_before_connection_and_flushes_on_channel_arrival", async () => {
    // Messages sent pre-connect are buffered and flushed in order. A channel
    // that arrives already open gets no "open" event, so the flush must
    // happen on arrival.
    for (const messageType of ["user-mute-started", "metrics", "bot-ready"]) {
      await client.sendMessage(message(messageType));
    }
    expect(connection._outgoingMessagesQueue.length).toEqual(3);

    const channel = new FakeDataChannel();
    connection._pc.emit("datachannel", channel);

    expect(channel.sentTypes).toEqual(["user-mute-started", "metrics", "bot-ready"]);
    expect(connection._outgoingMessagesQueue).toEqual([]);
  });

  test("test_flushes_on_open_event_when_channel_arrives_connecting", async () => {
    // A channel that arrives before opening flushes when "open" fires.
    await client.sendMessage(message("user-mute-started"));

    const channel = new FakeDataChannel("connecting");
    connection._pc.emit("datachannel", channel);
    expect(channel.sent).toEqual([]);

    channel.readyState = "open";
    await channel.fire("open");
    expect(channel.sentTypes).toEqual(["user-mute-started"]);
  });

  test("test_sends_directly_when_channel_open", async () => {
    const channel = new FakeDataChannel();
    connection._pc.emit("datachannel", channel);

    await client.sendMessage(message("server-message"));
    expect(channel.sentTypes).toEqual(["server-message"]);
    expect(connection._outgoingMessagesQueue).toEqual([]);
  });

  test("test_discards_when_closing", async () => {
    const channel = new FakeDataChannel();
    connection._pc.emit("datachannel", channel);
    client._closing = true;

    await client.sendMessage(message("server-message"));
    expect(channel.sent).toEqual([]);
    expect(connection._outgoingMessagesQueue).toEqual([]);
  });
});

interface FakeTrack {
  recv: ReturnType<typeof mock>;
  isEnabled: () => boolean;
}

function deadTrack(): FakeTrack {
  return {
    recv: mock(async () => {
      throw new MediaStreamError("track ended");
    }),
    isEnabled: () => true,
  };
}

function freshTrack(frame: () => unknown): FakeTrack {
  return { recv: mock(async () => frame()), isEnabled: () => true };
}

function fakeConnection() {
  return { isConnected: () => true, pcId: "test-pc" };
}

function makeAudioSelf(track: FakeTrack | null): any {
  return {
    _audioInputTrack: track,
    _webrtcConnection: fakeConnection(),
    _inSampleRate: 16_000,
    _audioInChannels: 1,
    _audioInLayout: "mono",
    // Passthrough resampler.
    _audioInResampler: { resample: async (f: AudioFrame) => [f] },
  };
}

function makeVideoSelf(
  videoTrack: FakeTrack | null = null,
  screenTrack: FakeTrack | null = null,
): any {
  return {
    _videoInputTrack: videoTrack,
    _screenVideoTrack: screenTrack,
    _webrtcConnection: fakeConnection(),
    _convertFrame: (arr: unknown, _fmt: string) => arr,
  };
}

function goodAudioFrame(): AudioFrame {
  const samples = 320; // 20 ms @ 16 kHz
  const f = AudioFrame.fromNdarray(new Int16Array(samples), { layout: "mono", sampleRate: 16_000 });
  f.pts = 0;
  f.timeBase = 1 / 16_000;
  return f;
}

function goodVideoFrame(): VideoFrame {
  const f = VideoFrame.fromNdarray(
    { data: new Uint8Array(4 * 4 * 3), width: 4, height: 4 },
    "rgb24",
  );
  f.pts = 0;
  return f;
}

async function cancelAndWait(task: Task<unknown>): Promise<void> {
  task.cancel();
  try {
    await task;
  } catch {
    // cancelled
  }
}

describe("TestReadAudioFrameMediaStreamError", () => {
  test("test_parks_on_dead_track", async () => {
    // Dead track: iterator must null the track ref and stop calling recv().
    const track = deadTrack();
    const fake = makeAudioSelf(track);

    const task = createTask(async () => {
      for await (const _ of SmallWebRTCClient.prototype.readAudioFrame.call(fake)) {
        // consume
      }
    });
    await sleep(0.2);
    await cancelAndWait(task);

    // Exactly one recv() call: after MediaStreamError, the track ref is
    // cleared and the loop sleeps on `null` instead of re-calling recv.
    expect(track.recv).toHaveBeenCalledTimes(1);
    expect(fake._audioInputTrack).toBeNull();
  });

  test("test_renegotiation_resumes", async () => {
    // After the dead track is replaced, the iterator must yield frames.
    const dead = deadTrack();
    const fresh = freshTrack(goodAudioFrame);
    const fake = makeAudioSelf(dead);

    let yielded = 0;
    const task = createTask(async () => {
      for await (const _ of SmallWebRTCClient.prototype.readAudioFrame.call(fake)) {
        yielded += 1;
        if (yielded >= 3) break;
      }
    });
    // Let the dead track raise + the loop park on `null`.
    await sleep(0.05);
    // Simulate _handleClientConnected reassigning a fresh track.
    fake._audioInputTrack = fresh;
    await waitFor(task, 1.0);

    expect(dead.recv).toHaveBeenCalledTimes(1);
    expect(yielded).toBeGreaterThanOrEqual(3);
  });
});

describe("TestReadVideoFrameMediaStreamError", () => {
  test("test_camera_parks_on_dead_track", async () => {
    const track = deadTrack();
    const fake = makeVideoSelf(track);

    const task = createTask(async () => {
      for await (const _ of SmallWebRTCClient.prototype.readVideoFrame.call(
        fake,
        CAM_VIDEO_SOURCE,
      )) {
        // consume
      }
    });
    await sleep(0.2);
    await cancelAndWait(task);

    expect(track.recv).toHaveBeenCalledTimes(1);
    expect(fake._videoInputTrack).toBeNull();
  });

  test("test_screen_parks_on_dead_track", async () => {
    // Screen-share uses a separate track reference.
    const track = deadTrack();
    const fake = makeVideoSelf(null, track);

    const task = createTask(async () => {
      for await (const _ of SmallWebRTCClient.prototype.readVideoFrame.call(
        fake,
        SCREEN_VIDEO_SOURCE,
      )) {
        // consume
      }
    });
    await sleep(0.2);
    await cancelAndWait(task);

    expect(track.recv).toHaveBeenCalledTimes(1);
    expect(fake._screenVideoTrack).toBeNull();
  });

  test("test_camera_renegotiation_resumes", async () => {
    const dead = deadTrack();
    const fresh = freshTrack(goodVideoFrame);
    const fake = makeVideoSelf(dead);

    let yielded = 0;
    const task = createTask(async () => {
      for await (const _ of SmallWebRTCClient.prototype.readVideoFrame.call(
        fake,
        CAM_VIDEO_SOURCE,
      )) {
        yielded += 1;
        if (yielded >= 2) break;
      }
    });
    await sleep(0.05);
    fake._videoInputTrack = fresh;
    await waitFor(task, 1.0);

    expect(dead.recv).toHaveBeenCalledTimes(1);
    expect(yielded).toBeGreaterThanOrEqual(2);
  });
});

/** Peers on this machine connect over loopback. */
const LOOPBACK = { iceAdditionalHostAddresses: ["127.0.0.1"], iceUseIpv6: false };

/**
 * A peer whose offer is shaped like the browser client's.
 *
 * Audio, camera and screen share transceivers plus a data channel, all
 * bundled onto one transport, as browsers do by default.
 */
function browserLikeClient(options: ConstructorParameters<typeof RTCPeerConnection>[0] = {}) {
  const client = new RTCPeerConnection({
    bundlePolicy: "max-bundle",
    werift: LOOPBACK,
    ...options,
  });
  client.addTransceiver("audio", { direction: "sendrecv" });
  client.addTransceiver("video", { direction: "sendrecv" });
  const screen = client.addTransceiver("video", { direction: "sendonly" });
  client.createDataChannel("chat");
  return [client, screen] as const;
}

describe("TestBundledTransceivers", () => {
  // Every media section of a bundled offer shares one transport.
  test("test_screen_share_transceiver_shares_the_transport", async () => {
    const [client] = browserLikeClient();
    await client.setLocalDescription(await client.createOffer());

    const connection = new SmallWebRTCConnection({ werift: LOOPBACK });
    await connection.initialize(client.localDescription!.sdp, client.localDescription!.type);

    const transports = new Set(connection.pc.getTransceivers().map((t) => t.receiver.transport));
    expect(connection.pc.getTransceivers().length).toEqual(3);
    expect(transports.size).toEqual(1);

    await connection.disconnect();
    await client.close();
  });
});

describe("TestScreenShareDelivery", () => {
  // A screen share started after connecting reaches the bot's screen track.
  //
  // Both peers run in this process and connect over localhost, so the frames
  // go through real ICE, DTLS and RTP, and through the routing of packets to
  // receivers. DIVERGENCE: aiortc encodes and decodes VP8 itself; here the
  // client gets a stand-in encoder and the bot a stand-in decoder, since the
  // video codecs are pluggable (see video.ts).
  test("test_screen_share_frames_reach_the_screen_track", async () => {
    const [client, screen] = browserLikeClient({
      // A tiny VP8 "keyframe" (bit 0 of the first byte clear) per frame.
      videoEncoderFactory: () => ({
        encode: () => new Uint8Array([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]),
      }),
    });
    await client.setLocalDescription(await client.createOffer());

    const decoded: Uint8Array[] = [];
    const connection = new SmallWebRTCConnection({
      werift: LOOPBACK,
      videoDecoderFactory: () => ({
        decode: (frame) => {
          decoded.push(frame.data);
          return [new VideoFrame({ width: 2, height: 2, data: new Uint8Array(12) })];
        },
      }),
    });
    try {
      await connection.initialize(client.localDescription!.sdp, client.localDescription!.type);
      const answer = connection.getAnswer()!;
      await client.setRemoteDescription({ sdp: answer.sdp, type: answer.type } as any);
      for (let i = 0; i < 100; i++) {
        if (connection.pc.connectionState === "connected") break;
        await sleep(0.1);
      }
      expect(connection.pc.connectionState).toEqual("connected");

      // The user starts sharing their screen after the call connects.
      screen.sender.replaceTrack(new VideoStreamTrack());

      const frame = await waitFor(() => connection.screenVideoInputTrack()!.recv(), 10);
      expect(frame).toBeInstanceOf(VideoFrame);
      expect(decoded[0]).toEqual(new Uint8Array([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]));
    } finally {
      await connection.disconnect();
      await client.close();
    }
  }, 20_000);
});

describe("TestVideoJitterBuffer", () => {
  // The screen share receiver assembles frames larger than the default buffer.
  function makeConnection() {
    const receivers: [any, object][] = [];
    for (const kind of ["audio", "video", "video"]) {
      const defaultBuffer = {};
      const receiver = { track: { kind }, _jitterBuffer: defaultBuffer, _enabled: true };
      receivers.push([receiver, defaultBuffer]);
    }
    const connection = new SmallWebRTCConnection();
    const realPc = connection._pc;
    connection._pc = {
      getTransceivers: () => receivers.map(([receiver]) => ({ receiver })),
    } as any;
    return { connection, receivers, close: () => realPc.close() };
  }

  test("test_screen_share_frame_of_many_packets_is_assembled", async () => {
    const { connection, receivers, close } = makeConnection();
    connection.screenVideoInputTrack();
    const jitterBuffer = receivers[2]![0]._jitterBuffer;

    // A keyframe of 300 packets, then the first packet of the next frame,
    // which completes it.
    let frame = null;
    for (let seq = 0; seq < 301; seq++) {
      const packet = new RtpPacketInfo({
        payloadType: 96,
        sequenceNumber: seq,
        timestamp: seq < 300 ? 0 : 3000,
      });
      packet._data = new TextEncoder().encode("x");
      const [pli, assembled] = jitterBuffer.add(packet);
      expect(pli).toBe(false);
      frame = assembled ?? frame;
    }

    expect(frame).not.toBeNull();
    expect(frame.data.length).toEqual(300);
    await close();
  });

  test("test_camera_keeps_the_default_buffer", async () => {
    const { connection, receivers, close } = makeConnection();
    connection.videoInputTrack();

    const [receiver, defaultBuffer] = receivers[1]!;
    expect(receiver._jitterBuffer).toBe(defaultBuffer);
    await close();
  });
});

describe("TestTrackStatus", () => {
  // The peer turning a source on or off is reported with the source.
  test("test_turning_sources_on_and_off_reports_them", async () => {
    const trackStatus = mock(async (_source: string, _enabled: boolean) => {});
    const connection = new SmallWebRTCConnection();
    const callbacks = new SmallWebRTCCallbacks({
      onAppMessage: noop,
      onClientConnected: noop,
      onClientDisconnected: noop,
      onTrackStatus: trackStatus,
    });
    new SmallWebRTCClient(connection, callbacks);

    for (const [receiverIndex, enabled] of [
      [2, true],
      [2, false],
      [1, false],
      [0, false],
    ] as const) {
      await connection._handleSignallingMessage({
        type: "trackStatus",
        receiver_index: receiverIndex,
        enabled,
      });
    }
    await sleep(0.05);

    expect(trackStatus.mock.calls).toEqual([
      ["screenVideo", true],
      ["screenVideo", false],
      ["camera", false],
      ["microphone", false],
    ]);
    await connection._pc.close();
  });
});

describe("TestSmallWebRTCTransportNames", () => {
  test("test_input_and_output_processors_take_their_own_names", () => {
    const transport = new SmallWebRTCTransport(
      { eventHandler: () => {} } as unknown as SmallWebRTCConnection,
      new TransportParams(),
      { inputName: "webrtc-in", outputName: "webrtc-out" },
    );

    expect(transport.input().name).toEqual("webrtc-in");
    expect(transport.output().name).toEqual("webrtc-out");
  });
});
