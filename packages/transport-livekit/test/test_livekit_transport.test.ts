// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_livekit_transport.py

/**
 * Tests for LiveKit transport video stream handling.
 *
 * Regression tests for issue #3116: Memory leak when video_in_enabled=False
 * but video tracks are subscribed. The fix ensures video stream processing
 * only starts when there is a consumer for the frames.
 *
 * As upstream, the tests use LiveKit's real SDK classes (frames, enums,
 * publish options) with a mocked room, and are skipped when
 * `@livekit/rtc-node` cannot be loaded on this platform.
 */

import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { KeypadEntry } from "@pipedog/core/audio/dtmf/types";
import {
  InputAudioRawFrame,
  InputDTMFFrame,
  InputTransportMessageFrame,
  OutputImageRawFrame,
  UserAudioRawFrame,
  UserImageRequestFrame,
} from "@pipedog/core/frames/frames";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { VideoInSourceParams } from "@pipedog/core/transports/base_transport";
import { logger } from "@pipedog/core/utils/logger";
import { loadRtc, rtc } from "@pipedog/transport-livekit/rtc";
import {
  _ParticipantAudioMixer,
  type AudioFrameEvent,
  LiveKitCallbacks,
  LiveKitInputTransport,
  LiveKitOutputTransport,
  LiveKitParams,
  type LiveKitParamsOptions,
  LiveKitTransport,
  LiveKitTransportClient,
} from "@pipedog/transport-livekit/transport";

type Any = any;

let LIVEKIT_AVAILABLE = true;
beforeAll(async () => {
  try {
    await loadRtc();
  } catch {
    LIVEKIT_AVAILABLE = false;
  }
});

const describeLk = (name: string, fn: () => void) =>
  describe(name, () => {
    beforeAll(() => {
      if (!LIVEKIT_AVAILABLE) console.warn(`${name}: @livekit/rtc-node not available, skipped`);
    });
    fn();
  });
const lkTest = (name: string, fn: () => Promise<void> | void) =>
  test(name, async () => {
    if (!LIVEKIT_AVAILABLE) return;
    await fn();
  });

// ---------------------------------------------------------------------------
// Helpers (Python: AsyncMock / MagicMock / patch.object)

const asyncMock = (value?: unknown) => mock(async (..._args: unknown[]) => value);

/** Replace `obj[key]` until the end of the test. */
const restores: (() => void)[] = [];
function patch<T extends object>(obj: T, key: string, value: unknown): void {
  const o = obj as Record<string, unknown>;
  const had = Object.hasOwn(o, key);
  const old = o[key];
  o[key] = value;
  restores.push(() => {
    if (had) o[key] = old;
    else delete o[key];
  });
}
afterEach(() => {
  while (restores.length) restores.pop()!();
});

/** A mock class whose instances are `instance`. */
const mockClass = (instance: unknown = {}) => mock(() => instance);

function callbacks(): LiveKitCallbacks {
  const options: Record<string, unknown> = {};
  for (const name of LiveKitCallbacks.fields) options[name] = asyncMock();
  return new LiveKitCallbacks(options as Any);
}

type CreateTask = ReturnType<typeof mock<(coro: () => Promise<unknown>, name: string) => unknown>>;

function createClient(
  params: LiveKitParams = new LiveKitParams(),
  createTask: (coro: () => Promise<unknown>, name: string) => unknown = () => undefined,
): Any {
  const client = new LiveKitTransportClient({
    url: "wss://test.livekit.cloud",
    token: "test-token",
    roomName: "test-room",
    params,
    callbacks: callbacks(),
    transportName: "test-transport",
  });
  client._taskManager = { createTask: mock(createTask) } as Any;
  return client;
}

function taskNames(client: Any): string[] {
  return (client._taskManager.createTask as CreateTask).mock.calls.map((c) => c[1]);
}

function mockStream(): Any {
  return { cancel: asyncMock() };
}

function mockTrack(kind: unknown, sid: string): Any {
  return { kind, sid };
}

/** A room for connect(), with the bot as its local participant. */
function mockRoom(remote: Map<string, Any> = new Map()): Any {
  return {
    connect: asyncMock(),
    disconnect: asyncMock(),
    remoteParticipants: remote,
    localParticipant: { identity: "bot", publishTrack: asyncMock() },
  };
}

/** Patch the output sources and local tracks connect() creates. */
function patchSources(
  options: { audioSource?: unknown; videoSource?: unknown; videoTrack?: unknown } = {},
): { AudioSource: Any; VideoSource: Any; createAudioTrack: Any; createVideoTrack: Any } {
  const AudioSource = mockClass(options.audioSource ?? { close: asyncMock() });
  const VideoSource = mockClass(options.videoSource ?? { close: asyncMock() });
  const createAudioTrack = mock(() => ({}));
  const createVideoTrack = mock(() => options.videoTrack ?? {});
  patch(rtc, "AudioSource", AudioSource);
  patch(rtc, "VideoSource", VideoSource);
  patch(rtc, "LocalAudioTrack", { createAudioTrack });
  patch(rtc, "LocalVideoTrack", { createVideoTrack });
  return { AudioSource, VideoSource, createAudioTrack, createVideoTrack };
}

const KIND_AUDIO = () => rtc.TrackKind.KIND_AUDIO;
const KIND_VIDEO = () => rtc.TrackKind.KIND_VIDEO;

function newTransport(params?: LiveKitParams): Any {
  return new LiveKitTransport({
    url: "wss://test.livekit.cloud",
    token: "test-token",
    roomName: "test-room",
    params,
  });
}

function pcm(value: number, ms: number, sampleRate = 48000): Int16Array {
  return new Int16Array((sampleRate * ms) / 1000).fill(value);
}

function bytesOf(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

function samples(audio: Uint8Array): Int16Array {
  const copy = audio.slice();
  return new Int16Array(copy.buffer, 0, copy.length / 2);
}

// ---------------------------------------------------------------------------

describeLk("TestLiveKitVideoStreamMemoryLeak", () => {
  // Regression tests for video queue memory leak (#3116).

  lkTest("test_disabled_video_input_does_not_start_queue_producer", async () => {
    const client = createClient(new LiveKitParams({ videoInEnabled: false }));
    const participant = { identity: "participant-456" };

    await client._asyncOnTrackSubscribed(
      mockTrack(KIND_VIDEO(), "video-track-123"),
      {},
      participant,
    );

    // Verify no video processing task was started
    const videoTasks = taskNames(client).filter((n) => n.toLowerCase().includes("video"));
    expect(videoTasks).toEqual([]);

    // Queue should remain empty
    expect(client._videoQueue.qsize()).toBe(0);

    // Track metadata should still be recorded
    expect(
      client._videoTracks.has(LiveKitTransportClient.videoKey("participant-456", "camera")),
    ).toBe(true);

    // Callback should still fire for user code
    expect(client._callbacks.onVideoTrackSubscribed).toHaveBeenCalledTimes(1);
  });

  lkTest("test_enabled_video_input_starts_queue_producer", async () => {
    const client = createClient(new LiveKitParams({ videoInEnabled: true }));
    const participant = { identity: "participant-456" };
    patch(rtc, "VideoStream", mockClass(mockStream()));

    await client._asyncOnTrackSubscribed(
      mockTrack(KIND_VIDEO(), "video-track-123"),
      {},
      participant,
    );

    const videoTasks = taskNames(client).filter((n) => n.toLowerCase().includes("video"));
    expect(videoTasks.length).toBe(1);
    expect(
      client._videoTracks.has(LiveKitTransportClient.videoKey("participant-456", "camera")),
    ).toBe(true);
    expect(client._callbacks.onVideoTrackSubscribed).toHaveBeenCalledTimes(1);
  });
});

describeLk("TestLiveKitAudioStreamLeakOnUnsubscribe", () => {
  // Regression tests for AudioStream leak on track unsubscribe.

  // Return a (mockable) Task so the cleanup path can call done() and cancel().
  const makeTask = () => ({ done: () => false, cancel: mock(() => true) });
  const client = (videoInEnabled = false) =>
    createClient(new LiveKitParams({ videoInEnabled }), makeTask);
  const audio = () =>
    [
      mockTrack(KIND_AUDIO(), "audio-track-1"),
      { sid: "audio-track-1" },
      { identity: "p-1" },
    ] as const;
  const video = () =>
    [
      mockTrack(KIND_VIDEO(), "video-track-1"),
      { sid: "video-track-1" },
      { identity: "p-1" },
    ] as const;

  lkTest("test_audio_stream_registered_on_subscribe", async () => {
    const c = client();
    const [track, pub, participant] = audio();
    const stream = mockStream();
    patch(rtc, "AudioStream", mockClass(stream));

    await c._asyncOnTrackSubscribed(track, pub, participant);

    expect(c._audioStreams.has("p-1")).toBe(true);
    const [owned, task] = c._audioStreams.get("p-1");
    // DIVERGENCE: the registry holds the SDK stream wrapped in a LiveKitMediaStream.
    expect(owned.stream).toBe(stream);
    expect(task).not.toBeNull();
  });

  lkTest("test_audio_stream_closed_and_task_cancelled_on_unsubscribe", async () => {
    const c = client();
    const [track, pub, participant] = audio();
    const stream = mockStream();
    patch(rtc, "AudioStream", mockClass(stream));
    await c._asyncOnTrackSubscribed(track, pub, participant);
    const [, task] = c._audioStreams.get("p-1");

    await c._asyncOnTrackUnsubscribed(track, pub, participant);

    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(task.cancel).toHaveBeenCalledTimes(1);
    expect(c._audioStreams.has("p-1")).toBe(false);
    expect(c._callbacks.onAudioTrackUnsubscribed).toHaveBeenCalledTimes(1);
  });

  lkTest("test_resubscribe_closes_previous_audio_stream", async () => {
    const c = client();
    const [track, pub, participant] = audio();
    const first = mockStream();
    const second = mockStream();

    patch(rtc, "AudioStream", mockClass(first));
    await c._asyncOnTrackSubscribed(track, pub, participant);
    const firstTask = c._audioStreams.get("p-1")[1];

    // Republish without an explicit unsubscribe in between.
    patch(rtc, "AudioStream", mockClass(second));
    await c._asyncOnTrackSubscribed(track, pub, participant);

    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(firstTask.cancel).toHaveBeenCalledTimes(1);
    expect(c._audioStreams.get("p-1")[0].stream).toBe(second);
  });

  lkTest("test_unsubscribe_without_subscribe_is_noop", async () => {
    const c = client();
    const [track, pub, participant] = audio();
    // No subscribe before this call.
    await c._asyncOnTrackUnsubscribed(track, pub, participant);
    expect(c._callbacks.onAudioTrackUnsubscribed).toHaveBeenCalledTimes(1);
  });

  lkTest("test_video_stream_closed_on_unsubscribe", async () => {
    const c = client(true);
    const [track, pub, participant] = video();
    const stream = mockStream();
    patch(rtc, "VideoStream", mockClass(stream));
    await c._asyncOnTrackSubscribed(track, pub, participant);
    const key = LiveKitTransportClient.videoKey("p-1", "camera");
    expect(c._videoStreams.has(key)).toBe(true);

    await c._asyncOnTrackUnsubscribed(track, pub, participant);
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(c._videoStreams.has(key)).toBe(false);
  });
});

/** Magnitude of the Hann-windowed spectrum of `pcm` at `hz` (numpy's rfft bin). */
function magnitude(pcmBytes: Uint8Array, hz: number, rate: number): number {
  const x = samples(pcmBytes);
  const n = x.length;
  const k = Math.round((hz * n) / rate);
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const w = n > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) : 1;
    const v = x[i]! * w;
    const a = (-2 * Math.PI * k * i) / n;
    re += v * Math.cos(a);
    im += v * Math.sin(a);
  }
  return Math.hypot(re, im);
}

describeLk("TestLiveKitInputResamplesEachParticipantSeparately", () => {
  // Audio from participants speaking at the same time must not bleed together.
  const RATE_IN = 48000;
  const RATE_OUT = 16000;
  const TONES: Record<string, number> = { alice: 440.0, bob: 1000.0 };

  function frame(hz: number, index: number): AudioFrameEvent {
    const n = RATE_IN / 100; // 10 ms
    const data = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const t = (i + index * n) / RATE_IN;
      data[i] = Math.trunc(8000 * Math.sin(2 * Math.PI * hz * t));
    }
    return { frame: new rtc.AudioFrame(data, RATE_IN, 1, n) };
  }

  lkTest("test_each_participant_keeps_only_their_own_audio", async () => {
    const frames: [AudioFrameEvent, string][] = [];
    for (let i = 0; i < 100; i++) {
      for (const [who, hz] of Object.entries(TONES)) frames.push([frame(hz, i), who]);
    }

    async function* interleaved() {
      // two participants talking at once, 1 s each
      for (const f of frames) yield f;
    }

    const transport: Any = new LiveKitInputTransport(
      {} as Any,
      { getNextAudioFrame: interleaved } as Any,
      new LiveKitParams(),
    );
    transport._sampleRate = RATE_OUT;
    const heard: Record<string, Uint8Array[]> = { alice: [], bob: [] };
    transport.pushAudioFrame = async (f: UserAudioRawFrame) => {
      heard[f.userId]!.push(f.audio);
    };
    await transport._audioInTaskHandler();

    for (const [who, other] of [
      ["alice", "bob"],
      ["bob", "alice"],
    ] as const) {
      const all = new Uint8Array(heard[who]!.reduce((n, a) => n + a.length, 0));
      let off = 0;
      for (const a of heard[who]!) {
        all.set(a, off);
        off += a.length;
      }
      // past the resampler's start-up
      const start = Math.floor(all.length / 4 / 2) * 2;
      const pcmBytes = all.subarray(start);
      const leaked =
        magnitude(pcmBytes, TONES[other]!, RATE_OUT) / magnitude(pcmBytes, TONES[who]!, RATE_OUT);
      expect(leaked).toBeLessThan(0.01);
    }
  });

  lkTest("test_a_participant_whose_audio_track_is_gone_is_released", async () => {
    const transport = newTransport();
    transport.input()._resamplers.set("alice", {});

    await transport._onAudioTrackUnsubscribed("alice");

    expect(transport.input()._resamplers.has("alice")).toBe(false);
  });
});

describeLk("TestLiveKitSipDtmfInput", () => {
  // Inbound SIP DTMF should surface as InputDTMFFrame (#4436).

  lkTest("test_sip_dtmf_forwards_digit_to_callback", async () => {
    const client = createClient();
    const dtmf = { digit: "5", code: 5, participant: { identity: "sip-participant-1" } };

    await client._asyncOnSipDtmfReceived(dtmf);

    expect(client._callbacks.onDtmfEvent).toHaveBeenCalledTimes(1);
    expect(client._callbacks.onDtmfEvent).toHaveBeenCalledWith({
      tone: "5",
      digit: "5",
      code: 5,
      participant_id: "sip-participant-1",
    });
  });

  lkTest("test_transport_dtmf_event_pushes_input_frame", async () => {
    const transport = newTransport();
    transport._input = { pushFrame: asyncMock() };
    transport._callEventHandler = asyncMock();

    const data = { tone: "1", digit: "1", code: 1, participant_id: "sip-participant-1" };
    await transport._onDtmfEvent(data);

    expect(transport._callEventHandler).toHaveBeenCalledTimes(1);
    expect(transport._callEventHandler).toHaveBeenCalledWith("on_dtmf_event", data);
    expect(transport._input.pushFrame).toHaveBeenCalledTimes(1);
    const frame = transport._input.pushFrame.mock.calls[0][0];
    expect(frame).toBeInstanceOf(InputDTMFFrame);
    expect(frame.button).toBe(KeypadEntry.ONE);
  });

  lkTest("test_transport_ignores_unsupported_dtmf_tone", async () => {
    const transport = newTransport();
    transport._input = { pushFrame: asyncMock() };
    transport._callEventHandler = asyncMock();

    await transport._onDtmfEvent({ tone: "A", digit: "A", code: 12, participant_id: "p1" });

    expect(transport._callEventHandler).toHaveBeenCalledTimes(1);
    expect(transport._input.pushFrame).not.toHaveBeenCalled();
  });
});

describeLk("TestLiveKitActiveSpeaker", () => {
  // The room's loudest speaker surfaces as on_active_speaker_changed, as on Daily.

  async function runScheduled(client: Any): Promise<void> {
    for (const call of client._taskManager.createTask.mock.calls) await call[0]();
  }

  lkTest("test_the_loudest_speaker_is_reported", async () => {
    const client = createClient();
    client._onActiveSpeakersChangedWrapper([{ identity: "bob" }, { identity: "alice" }]);
    await runScheduled(client);
    expect(client._callbacks.onActiveSpeakerChanged).toHaveBeenCalledTimes(1);
    expect(client._callbacks.onActiveSpeakerChanged).toHaveBeenCalledWith("alice");
  });

  lkTest("test_only_a_change_of_speaker_is_reported", async () => {
    const client = createClient();
    const alice = { identity: "alice" };
    const bob = { identity: "bob" };
    for (const speakers of [[alice], [bob, alice], [], [alice], [bob]]) {
      client._onActiveSpeakersChangedWrapper(speakers);
    }
    await runScheduled(client);
    expect(client._callbacks.onActiveSpeakerChanged.mock.calls.map((c: Any[]) => c[0])).toEqual([
      "alice",
      "bob",
    ]);
  });

  lkTest("test_connect_forgets_the_last_speaker", async () => {
    const client = createClient();
    client._activeSpeakerId = "alice";
    client._outSampleRate = 16000;
    client._room = mockRoom();
    patchSources();

    await client.connect();

    expect(client._activeSpeakerId).toBeNull();
  });

  lkTest("test_setup_listens_for_the_room_event", async () => {
    const client = createClient();
    client._taskManager = null;
    const room = { on: mock((_event: string, _handler: (...args: Any[]) => void) => {}) };
    patch(rtc, "Room", mockClass(room));
    const taskManager = { createTask: mock(() => undefined) };

    await client.setup({ audioOutSampleRate: 16000, taskManager } as Any);

    // DIVERGENCE: the JS SDK's event is "activeSpeakersChanged", and the
    // handler is a closure, so it's checked by calling it.
    const call = room.on.mock.calls.find((c) => c[0] === "activeSpeakersChanged");
    expect(call).toBeDefined();
    call![1]([{ identity: "alice" }]);
    expect(taskManager.createTask).toHaveBeenCalledTimes(1);
    expect(client._activeSpeakerId).toBe("alice");
  });

  lkTest("test_transport_emits_dailys_event", async () => {
    const transport = newTransport();
    transport._callEventHandler = asyncMock();

    await transport._onActiveSpeakerChanged("alice");

    expect(transport._callEventHandler).toHaveBeenCalledTimes(1);
    expect(transport._callEventHandler).toHaveBeenCalledWith("on_active_speaker_changed", {
      id: "alice",
    });
  });
});

describeLk("TestLiveKitAppMessageInput", () => {
  // Inbound JSON data messages (RTVI's wire channel) are parsed and broadcast
  // both directions as an InputTransportMessageFrame.

  function makeTransport(): [Any, Any] {
    const transport = newTransport();
    const input = transport.input();
    input.pushFrame = asyncMock();
    transport._callEventHandler = asyncMock();
    return [transport, input];
  }

  const encode = (s: string) => new TextEncoder().encode(s);

  lkTest("test_data_received_broadcasts_parsed_input_message_frame", async () => {
    const [transport, input] = makeTransport();

    const rtviMessage = { label: "rtvi-ai", type: "client-ready", id: "1", data: {} };
    await transport._onDataReceived(encode(JSON.stringify(rtviMessage)), "participant-1");

    expect(input.pushFrame).toHaveBeenCalledTimes(2);
    const directions = new Set();
    for (const call of input.pushFrame.mock.calls) {
      const frame = call[0];
      const direction = call.length > 1 ? call[1] : FrameDirection.DOWNSTREAM;
      expect(frame).toBeInstanceOf(InputTransportMessageFrame);
      expect(frame.message).toEqual(rtviMessage);
      expect(frame.participantId).toBe("participant-1");
      directions.add(direction);
    }
    // Broadcast both ways so RTVIProcessor sees it regardless of where it sits
    // relative to the transport in the pipeline.
    expect(directions).toEqual(new Set([FrameDirection.DOWNSTREAM, FrameDirection.UPSTREAM]));

    expect(transport._callEventHandler).toHaveBeenCalledWith(
      "on_app_message",
      rtviMessage,
      "participant-1",
    );
  });

  lkTest("test_non_json_data_is_not_pushed_but_reported_for_compat", async () => {
    const [transport, input] = makeTransport();
    const data = encode("not json");

    await transport._onDataReceived(data, "participant-1");

    expect(input.pushFrame).not.toHaveBeenCalled();
    expect(transport._callEventHandler).toHaveBeenCalledTimes(1);
    expect(transport._callEventHandler).toHaveBeenCalledWith(
      "on_data_received",
      data,
      "participant-1",
    );
  });

  lkTest("test_non_object_json_is_not_pushed_but_reported_for_compat", async () => {
    // RTVIProcessor reads `.label` on the parsed message, so pushing a
    // non-object would fail deep in the pipeline.
    const [transport, input] = makeTransport();
    const data = encode(JSON.stringify("hi"));

    await transport._onDataReceived(data, "participant-1");

    expect(input.pushFrame).not.toHaveBeenCalled();
    expect(transport._callEventHandler).toHaveBeenCalledTimes(1);
    expect(transport._callEventHandler).toHaveBeenCalledWith(
      "on_data_received",
      data,
      "participant-1",
    );
  });
});

describeLk("TestLiveKitClientConnectedAlias", () => {
  // on_client_connected/on_client_disconnected match Daily's dict shape.

  function makeTransport(): Any {
    const transport = newTransport();
    transport._input = { pushFrame: asyncMock(), removeParticipantVideo: asyncMock() };
    transport._callEventHandler = asyncMock();
    return transport;
  }

  lkTest("test_on_client_connected_receives_dict", async () => {
    const transport = makeTransport();
    await transport._onParticipantConnected("participant-1");
    expect(transport._callEventHandler).toHaveBeenCalledWith("on_client_connected", {
      id: "participant-1",
    });
  });

  lkTest("test_on_client_disconnected_receives_dict", async () => {
    const transport = makeTransport();
    await transport._onParticipantDisconnected("participant-1");
    expect(transport._callEventHandler).toHaveBeenCalledWith("on_client_disconnected", {
      id: "participant-1",
    });
  });
});

describeLk("TestLiveKitParticipantIdentity", () => {
  // The participantId this transport hands out must be the LiveKit identity,
  // not the SID (pipecat-ai/pipecat#5218).

  function roomWithParticipant(client: Any, sid: string, identity: string): [Any, Any] {
    const publication = { kind: rtc.TrackKind.KIND_AUDIO, setSubscribed: mock(() => {}) };
    const participant = {
      sid,
      identity,
      name: "Test User",
      metadata: "",
      trackPublications: new Map([["track-1", publication]]),
    };
    client._room = { remoteParticipants: new Map([[identity, participant]]) };
    return [participant, publication];
  }

  lkTest("test_get_participants_returns_identity_not_sid", async () => {
    const client = createClient();
    roomWithParticipant(client, "PA_serverSid", "repro-client");
    expect(client.getParticipants()).toEqual(["repro-client"]);
  });

  lkTest("test_get_participant_metadata_resolves_id_from_get_participants", async () => {
    const client = createClient();
    roomWithParticipant(client, "PA_serverSid", "repro-client");

    const [participantId] = client.getParticipants();
    const metadata = await client.getParticipantMetadata(participantId);

    expect(metadata).toEqual({ id: "repro-client", name: "Test User", metadata: "" });
  });

  lkTest("test_mute_participant_resolves_id_from_get_participants", async () => {
    const client = createClient();
    const [, publication] = roomWithParticipant(client, "PA_serverSid", "repro-client");

    const [participantId] = client.getParticipants();
    await client.muteParticipant(participantId);

    expect(publication.setSubscribed).toHaveBeenCalledTimes(1);
    expect(publication.setSubscribed).toHaveBeenCalledWith(false);
  });

  lkTest("test_unmute_participant_resolves_id_from_get_participants", async () => {
    const client = createClient();
    const [, publication] = roomWithParticipant(client, "PA_serverSid", "repro-client");

    const [participantId] = client.getParticipants();
    await client.unmuteParticipant(participantId);

    expect(publication.setSubscribed).toHaveBeenCalledTimes(1);
    expect(publication.setSubscribed).toHaveBeenCalledWith(true);
  });

  lkTest("test_participant_connected_callback_receives_identity", async () => {
    const client = createClient();
    await client._asyncOnParticipantConnected({ sid: "PA_serverSid", identity: "repro-client" });
    expect(client._callbacks.onParticipantConnected).toHaveBeenCalledTimes(1);
    expect(client._callbacks.onParticipantConnected).toHaveBeenCalledWith("repro-client");
  });
});

describeLk("TestLiveKitAudioTrackSubscribedHandler", () => {
  // The top-level transport's on_audio/video_track_subscribed handlers must
  // not re-derive publications from nonexistent SDK attributes.

  for (const [kind, method] of [
    ["audio", "_onAudioTrackSubscribed"],
    ["video", "_onVideoTrackSubscribed"],
  ] as const) {
    lkTest(`test_on_${kind}_track_subscribed_only_fires_event_handler`, async () => {
      const transport = newTransport();
      transport._callEventHandler = asyncMock();
      const get = mock(() => undefined);
      transport._client = { room: { remoteParticipants: { get } } };

      await transport[method]("participant-1");

      expect(transport._callEventHandler).toHaveBeenCalledTimes(1);
      expect(transport._callEventHandler).toHaveBeenCalledWith(
        `on_${kind}_track_subscribed`,
        "participant-1",
      );
      expect(get).not.toHaveBeenCalled();
    });
  }
});

describeLk("TestLiveKitVideoOutputPublish", () => {
  // Video output (publishing) support for the LiveKit transport.

  function create(videoOutEnabled: boolean, params: LiveKitParamsOptions = {}): Any {
    const client = createClient(new LiveKitParams({ videoOutEnabled, ...params }));
    // Normally set in setup(); connect() reads this directly.
    client._outSampleRate = 16000;
    client._room = mockRoom();
    return client;
  }

  lkTest("test_video_out_disabled_publishes_only_audio_track", async () => {
    const client = create(false);
    const { VideoSource, createVideoTrack } = patchSources();

    await client.connect();

    expect(VideoSource).not.toHaveBeenCalled();
    expect(createVideoTrack).not.toHaveBeenCalled();
    expect(client._videoSource).toBeNull();
    expect(client._videoTrack).toBeNull();
    expect(client.room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
  });

  lkTest("test_video_out_enabled_publishes_audio_and_video_tracks", async () => {
    const client = create(true);
    const videoSource = { close: asyncMock() };
    const videoTrack = {};
    const { VideoSource, createVideoTrack } = patchSources({ videoSource, videoTrack });

    await client.connect();

    expect(VideoSource).toHaveBeenCalledTimes(1);
    expect(VideoSource).toHaveBeenCalledWith(
      client._params.videoOutWidth,
      client._params.videoOutHeight,
    );
    expect(createVideoTrack).toHaveBeenCalledTimes(1);
    expect(createVideoTrack).toHaveBeenCalledWith("pipecat-video", videoSource);
    expect(client._videoSource).toBe(videoSource);
    expect(client._videoTrack).toBe(videoTrack);

    // Both the microphone and camera tracks got published.
    const calls = client.room.localParticipant.publishTrack.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls.map((c: Any[]) => c[0])).toContain(videoTrack);
    const sources = calls.map((c: Any[]) => c[1].source);
    expect(sources).toContain(rtc.TrackSource.SOURCE_CAMERA);
    expect(sources).toContain(rtc.TrackSource.SOURCE_MICROPHONE);
  });

  const videoPublishOptions = (params: LiveKitParamsOptions = {}) =>
    create(true, params)._videoPublishOptions();

  lkTest("test_video_publish_options_default_leaves_encoding_to_livekit", async () => {
    const options = videoPublishOptions();
    expect(options.source).toBe(rtc.TrackSource.SOURCE_CAMERA);
    expect(options.videoEncoding).toBeUndefined();
    expect(options.videoCodec).toBeUndefined();
  });

  lkTest("test_video_publish_options_apply_bitrate_framerate_and_codec", async () => {
    const options = videoPublishOptions({
      videoOutMaxBitrate: 2_000_000,
      videoOutFramerate: 24,
      videoOutCodec: "h264",
    });
    expect(options.videoEncoding.maxBitrate).toBe(2_000_000n);
    expect(options.videoEncoding.maxFramerate).toBe(24);
    expect(options.videoCodec).toBe(rtc.VideoCodec.H264);
  });

  lkTest("test_video_publish_options_ignore_unknown_codec", async () => {
    const options = videoPublishOptions({ videoOutCodec: "MPEG2" });
    expect(options.videoCodec).toBeUndefined();
  });

  lkTest("test_publish_video_writes_to_video_source", async () => {
    const client = create(true);
    client._connected = true;
    const videoSource = { captureFrame: mock(() => {}) };
    client._videoSource = videoSource;

    const videoFrame = {};
    const result = await client.publishVideo(videoFrame);

    expect(result).toBe(true);
    expect(videoSource.captureFrame).toHaveBeenCalledTimes(1);
    expect(videoSource.captureFrame).toHaveBeenCalledWith(videoFrame);
  });

  lkTest("test_publish_video_without_source_returns_false", async () => {
    const client = create(false);
    client._connected = true;
    expect(await client.publishVideo({})).toBe(false);
  });

  lkTest("test_failed_publish_is_rolled_back_so_retry_publishes", async () => {
    const client = create(true);
    // Fail the video publish on the first attempt only.
    const results: (Error | null)[] = [null, new Error("publish failed"), null, null];
    client.room.localParticipant.publishTrack = mock(async () => {
      const r = results.shift();
      if (r) throw r;
    });
    const audioSource = { close: asyncMock() };
    const videoSource = { close: asyncMock() };
    patchSources({ audioSource, videoSource });

    // Call the undecorated attempt so the test controls each attempt.
    await expect(client._connectOnce()).rejects.toThrow("publish failed");

    expect(client._connected).toBe(false);
    expect(client._disconnectCounter).toBe(0);
    expect(client.room.disconnect).toHaveBeenCalledTimes(1);
    expect(audioSource.close).toHaveBeenCalledTimes(1);
    expect(videoSource.close).toHaveBeenCalledTimes(1);
    expect(client._callbacks.onConnected).not.toHaveBeenCalled();

    await client._connectOnce();

    expect(client._connected).toBe(true);
    expect(client._disconnectCounter).toBe(1);
    expect(client.room.localParticipant.publishTrack).toHaveBeenCalledTimes(4);
    expect(client._callbacks.onConnected).toHaveBeenCalledTimes(1);
  });

  lkTest("test_room_disconnect_event_reports_disconnect_of_connected_client", async () => {
    const client = create(false);
    client._connected = true;

    await client._asyncOnDisconnected();

    expect(client._connected).toBe(false);
    expect(client._callbacks.onDisconnected).toHaveBeenCalledTimes(1);
  });

  lkTest("test_disconnect_reports_disconnect_once", async () => {
    const client = create(false);
    client._connected = true;
    client._disconnectCounter = 1;
    // LiveKit emits its "disconnected" event while disconnecting.
    client.room.disconnect = mock(async () => {
      await client._asyncOnDisconnected();
    });

    await client.disconnect();

    expect(client.room.disconnect).toHaveBeenCalledTimes(1);
    expect(client._callbacks.onDisconnected).toHaveBeenCalledTimes(1);
  });

  lkTest("test_failed_connect_does_not_report_disconnect", async () => {
    const client = create(false);
    client.room.localParticipant.publishTrack = mock(async () => {
      throw new Error("publish failed");
    });
    client.room.disconnect = mock(async () => {
      await client._asyncOnDisconnected();
    });
    patchSources();

    await expect(client._connectOnce()).rejects.toThrow("publish failed");

    expect(client.room.disconnect).toHaveBeenCalledTimes(1);
    expect(client._callbacks.onDisconnected).not.toHaveBeenCalled();
  });

  lkTest("test_disconnect_closes_output_sources", async () => {
    const client = create(true);
    const audioSource = { close: asyncMock() };
    const videoSource = { close: asyncMock() };
    patchSources({ audioSource, videoSource });

    await client.connect();
    await client.disconnect();

    expect(audioSource.close).toHaveBeenCalledTimes(1);
    expect(videoSource.close).toHaveBeenCalledTimes(1);
    expect(client._audioSource).toBeNull();
    expect(client._audioTrack).toBeNull();
    expect(client._videoSource).toBeNull();
    expect(client._videoTrack).toBeNull();
    expect(await client.publishVideo({})).toBe(false);
  });
});

describeLk("TestLiveKitOutputTransportWriteVideoFrame", () => {
  // LiveKitOutputTransport.writeVideoFrame conversion and dispatch.

  function output(): Any {
    const params = new LiveKitParams({
      videoOutEnabled: true,
      videoOutWidth: 4,
      videoOutHeight: 4,
      videoOutColorFormat: "RGB",
    });
    const client = { publishVideo: asyncMock(true) };
    return new LiveKitOutputTransport({} as Any, client as Any, params);
  }

  const range = (n: number) => Uint8Array.from({ length: n }, (_, i) => i);

  lkTest("test_write_video_frame_converts_and_publishes", async () => {
    const out = output();
    const image = range(4 * 4 * 3);
    const frame = new OutputImageRawFrame({ image, size: [4, 4], format: "RGB" });

    const result = await out.writeVideoFrame(frame);

    expect(result).toBe(true);
    expect(out._client.publishVideo).toHaveBeenCalledTimes(1);
    const [livekitFrame] = out._client.publishVideo.mock.calls[0];
    expect(livekitFrame).toBeInstanceOf(rtc.VideoFrame);
    expect(livekitFrame.width).toBe(4);
    expect(livekitFrame.height).toBe(4);
    expect(new Uint8Array(livekitFrame.data)).toEqual(image);
  });

  lkTest("test_write_video_frame_maps_four_byte_formats", async () => {
    const expectedTypes: Record<string, unknown> = {
      RGBA: rtc.VideoBufferType.RGBA,
      BGRA: rtc.VideoBufferType.BGRA,
      ARGB: rtc.VideoBufferType.ARGB,
    };
    for (const [colorFormat, bufferType] of Object.entries(expectedTypes)) {
      const out = output();
      const image = range(4 * 4 * 4);
      const frame = new OutputImageRawFrame({ image, size: [4, 4], format: colorFormat });

      const result = await out.writeVideoFrame(frame);

      expect(result).toBe(true);
      const [livekitFrame] = out._client.publishVideo.mock.calls[0];
      expect(livekitFrame.type).toBe(bufferType);
      expect(new Uint8Array(livekitFrame.data)).toEqual(image);
    }
  });

  lkTest("test_write_video_frame_unsupported_format_does_not_publish", async () => {
    const out = output();
    const frame = new OutputImageRawFrame({
      image: new Uint8Array(16),
      size: [4, 4],
      format: "I420",
    });

    expect(await out.writeVideoFrame(frame)).toBe(false);
    expect(out._client.publishVideo).not.toHaveBeenCalled();
  });

  lkTest("test_unsupported_format_error_is_logged_once", async () => {
    const out = output();
    const frame = new OutputImageRawFrame({
      image: new Uint8Array(16),
      size: [4, 4],
      format: "I420",
    });
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      await out.writeVideoFrame(frame);
      await out.writeVideoFrame(frame);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  lkTest("test_write_video_frame_wrong_length_does_not_publish", async () => {
    const out = output();
    const frame = new OutputImageRawFrame({
      image: new Uint8Array(10),
      size: [4, 4],
      format: "RGB",
    });

    expect(await out.writeVideoFrame(frame)).toBe(false);
    expect(out._client.publishVideo).not.toHaveBeenCalled();
  });
});

describeLk("TestLiveKitParticipantsAlreadyInRoom", () => {
  // Participants already in the room when the bot connects are reported.

  function create(identities: string[]): Any {
    const client = createClient();
    client._outSampleRate = 16000;
    client._room = mockRoom(new Map(identities.map((identity) => [identity, { identity }])));
    return client;
  }

  async function connect(client: Any): Promise<void> {
    patchSources();
    await client.connect();
  }

  lkTest("test_each_participant_already_in_the_room_is_connected", async () => {
    const client = create(["alice", "bob"]);

    await connect(client);

    const callbacks = client._callbacks;
    expect(callbacks.onParticipantConnected.mock.calls).toEqual([["alice"], ["bob"]]);
    expect(callbacks.onFirstParticipantJoined).toHaveBeenCalledTimes(1);
    expect(callbacks.onFirstParticipantJoined).toHaveBeenCalledWith("alice");
  });

  lkTest("test_participant_who_joins_later_is_not_first", async () => {
    const client = create(["alice"]);
    await connect(client);

    await client._asyncOnParticipantConnected({ identity: "bob" });

    expect(client._callbacks.onFirstParticipantJoined).toHaveBeenCalledTimes(1);
    expect(client._callbacks.onFirstParticipantJoined).toHaveBeenCalledWith("alice");
    expect(client._callbacks.onParticipantConnected).toHaveBeenLastCalledWith("bob");
  });
});

function videoPublication(source: unknown): Any {
  return { sid: `video-${source}`, source, kind: rtc.TrackKind.KIND_VIDEO, muted: false };
}

describeLk("TestLiveKitVideoSources", () => {
  // A user's camera and screen share are received side by side.

  function create(): Any {
    // Don't run the stream producers.
    return createClient(new LiveKitParams({ videoInEnabled: true }));
  }

  async function subscribe(client: Any, source: unknown): Promise<[Any, Any, Any, Any]> {
    const track = { kind: rtc.TrackKind.KIND_VIDEO };
    const participant = { identity: "alice" };
    const publication = videoPublication(source);
    const stream = mockStream();
    patch(rtc, "VideoStream", mockClass(stream));
    await client._asyncOnTrackSubscribed(track, publication, participant);
    return [track, publication, participant, stream];
  }

  const keys = (client: Any) =>
    new Set(
      [...client._videoStreams.keys()].map((k: string) =>
        LiveKitTransportClient.splitVideoKey(k).join("/"),
      ),
    );

  lkTest("test_camera_and_screen_share_are_received_side_by_side", async () => {
    const client = create();
    await subscribe(client, rtc.TrackSource.SOURCE_CAMERA);
    await subscribe(client, rtc.TrackSource.SOURCE_SCREENSHARE);

    expect(keys(client)).toEqual(new Set(["alice/camera", "alice/screenVideo"]));
    expect(client.videoSourceEnabled("alice", "screenVideo")).toBe(true);
  });

  lkTest("test_stopping_the_screen_share_keeps_the_camera", async () => {
    const client = create();
    const [, , , cameraStream] = await subscribe(client, rtc.TrackSource.SOURCE_CAMERA);
    const screen = await subscribe(client, rtc.TrackSource.SOURCE_SCREENSHARE);

    await client._asyncOnTrackUnsubscribed(screen[0], screen[1], screen[2]);

    expect(cameraStream.cancel).not.toHaveBeenCalled();
    expect(keys(client)).toEqual(new Set(["alice/camera"]));
    expect(client.videoSourceEnabled("alice", "screenVideo")).toBe(false);
  });

  lkTest("test_a_muted_track_sends_no_video", async () => {
    const client = create();
    const [, publication, participant] = await subscribe(client, rtc.TrackSource.SOURCE_CAMERA);

    publication.muted = true;
    await client._asyncOnTrackMuted(participant, publication);

    expect(client.videoSourceEnabled("alice", "camera")).toBe(false);
    expect(client._callbacks.onVideoTrackMuted).toHaveBeenCalledTimes(1);
    expect(client._callbacks.onVideoTrackMuted).toHaveBeenCalledWith("alice", "camera");
  });

  lkTest("test_video_without_a_source_is_the_camera", async () => {
    const client = create();
    await subscribe(client, rtc.TrackSource.SOURCE_UNKNOWN);
    expect(client.videoSourceEnabled("alice", "camera")).toBe(true);
  });
});

describeLk("TestLiveKitInputVideoSampling", () => {
  // Which incoming video frames the input transport passes on.

  function input(frames: [Any, string, string][], params: LiveKitParamsOptions = {}): Any {
    async function* nextFrames() {
      for (const frame of frames) yield frame;
    }
    const client = {
      getNextVideoFrame: nextFrames,
      videoSourceEnabled: (_participantId: string, _videoSource: string) => true,
    };
    const inp: Any = new LiveKitInputTransport(
      {} as Any,
      client as Any,
      new LiveKitParams({ videoInEnabled: true, ...params }),
    );
    inp._convertLivekitVideoToPipecat = asyncMock({
      image: new Uint8Array(3),
      size: [1, 1],
      format: "RGB",
    });
    inp.pushed = [];
    inp.pushVideoFrame = async (frame: unknown) => {
      inp.pushed.push(frame);
    };
    return inp;
  }

  lkTest("test_every_frame_of_every_source_without_video_in_sources", async () => {
    const frames: [Any, string, string][] = [];
    for (let i = 0; i < 3; i++) frames.push([{}, "alice", "camera"], [{}, "alice", "screenVideo"]);
    const inp = input(frames);

    await inp._videoInTaskHandler();

    expect(inp.pushed.map((f: Any) => f.transportSource)).toEqual([
      "camera",
      "screenVideo",
      "camera",
      "screenVideo",
      "camera",
      "screenVideo",
    ]);
  });

  lkTest("test_only_listed_sources_with_video_in_sources", async () => {
    const inp = input(
      [
        [{}, "alice", "camera"],
        [{}, "alice", "screenVideo"],
      ],
      { videoInSources: { screenVideo: new VideoInSourceParams() } },
    );

    await inp._videoInTaskHandler();

    expect(inp.pushed.map((f: Any) => f.transportSource)).toEqual(["screenVideo"]);
  });

  lkTest("test_explicit_capture_takes_precedence", async () => {
    const frames: [Any, string, string][] = [
      [{}, "alice", "camera"],
      [{}, "alice", "camera"],
      [{}, "alice", "camera"],
    ];
    const inp = input(frames, { videoInSources: { camera: new VideoInSourceParams() } });
    await inp.captureParticipantVideo("alice", 30, "camera", { onRequestOnly: true });

    await inp._videoInTaskHandler();

    expect(inp.pushed).toEqual([]);
  });

  lkTest("test_request_answered_by_the_next_frame", async () => {
    const inp = input(
      [
        [{}, "alice", "camera"],
        [{}, "alice", "camera"],
      ],
      { videoInSources: { camera: new VideoInSourceParams({ onRequestOnly: true }) } },
    );
    const request = new UserImageRequestFrame({ userId: "alice", text: "What is this?" });
    await inp.requestParticipantImage(request);

    await inp._videoInTaskHandler();

    expect(inp.pushed.length).toBe(1);
    expect(inp.pushed[0].request).toBe(request);
    expect(inp.pushed[0].text).toBe("What is this?");
  });

  lkTest("test_request_without_a_track_completes_with_an_error", async () => {
    const inp = input([]);
    inp._client.videoSourceEnabled = () => false;
    const resultCallback = asyncMock();

    await inp.requestParticipantImage(
      new UserImageRequestFrame({ userId: "alice", videoSource: "screenVideo", resultCallback }),
    );

    expect(resultCallback).toHaveBeenCalledTimes(1);
    expect((resultCallback.mock.calls[0]![0] as Any).error).toContain("screenVideo");
  });

  lkTest("test_a_participant_who_leaves_is_forgotten", async () => {
    const transport = newTransport(new LiveKitParams({ videoInEnabled: true }));
    await transport.input().captureParticipantVideo("alice", 1, "camera");

    await transport._onParticipantDisconnected("alice");

    expect(transport.input()._videoSamplers.isCapturing("alice", "camera")).toBe(false);
  });

  async function waitingRequest(inp: Any, videoSource = "camera"): Promise<Any> {
    const resultCallback = asyncMock();
    await inp.requestParticipantImage(
      new UserImageRequestFrame({ userId: "alice", videoSource, resultCallback }),
    );
    expect(resultCallback).not.toHaveBeenCalled();
    return resultCallback;
  }

  lkTest("test_request_after_the_track_stopped_is_answered_with_an_error", async () => {
    const inp = input([], { videoInSources: { screenVideo: new VideoInSourceParams() } });
    inp._captureConfiguredVideo("alice", "screenVideo");
    inp._client.videoSourceEnabled = () => false;
    const resultCallback = asyncMock();

    await inp.requestParticipantImage(
      new UserImageRequestFrame({ userId: "alice", videoSource: "screenVideo", resultCallback }),
    );

    expect(resultCallback.mock.calls[0]![0]).toHaveProperty("error");
  });

  lkTest("test_waiting_request_is_answered_when_its_track_stops", async () => {
    const inp = input([], { videoInSources: { screenVideo: new VideoInSourceParams() } });
    const resultCallback = await waitingRequest(inp, "screenVideo");

    await inp.stopParticipantVideo("alice", "screenVideo");

    expect(resultCallback.mock.calls[0][0].error).toContain("stopped");
    expect(inp._videoSamplers.isCapturing("alice", "screenVideo")).toBe(true);
  });

  lkTest("test_waiting_request_is_answered_when_the_participant_leaves", async () => {
    const inp = input([]);
    const resultCallback = await waitingRequest(inp);

    await inp.removeParticipantVideo("alice");

    expect(resultCallback.mock.calls[0][0].error).toContain("left");
  });

  lkTest("test_waiting_requests_are_answered_when_the_room_disconnects", async () => {
    const transport = newTransport(new LiveKitParams({ videoInEnabled: true }));
    const inp = transport.input();
    inp._client = { videoSourceEnabled: () => true };
    const resultCallback = await waitingRequest(inp);

    await transport._onDisconnected();

    expect(resultCallback.mock.calls[0][0]).toHaveProperty("error");
  });

  lkTest("test_screen_in_capability", () => {
    const inp = new LiveKitInputTransport(
      {} as Any,
      {} as Any,
      new LiveKitParams({
        videoInEnabled: true,
        videoInSources: { screenVideo: new VideoInSourceParams() },
      }),
    );
    expect(inp.capabilities.screenIn).toBe(true);
  });
});

describeLk("TestLiveKitAudioOutQueueSize", () => {
  // audioOutQueueSizeMs sizes the outgoing AudioSource buffer.

  async function connectAndGetAudioSourceCall(params: LiveKitParams): Promise<unknown[]> {
    const client = createClient(params);
    client._outSampleRate = 16000;
    client._room = mockRoom();
    const { AudioSource } = patchSources();
    await client.connect();
    return AudioSource.mock.calls[0]!;
  }

  lkTest("test_default_matches_livekit_default", async () => {
    const call = await connectAndGetAudioSourceCall(new LiveKitParams());
    // DIVERGENCE: positional, as the JS SDK's AudioSource(sampleRate, numChannels, queueSize).
    expect(call[2]).toBe(1000);
  });

  lkTest("test_queue_size_is_passed_to_the_audio_source", async () => {
    const call = await connectAndGetAudioSourceCall(
      new LiveKitParams({ audioOutQueueSizeMs: 200 }),
    );
    expect(call.slice(0, 2)).toEqual([16000, 1]);
    expect(call[2]).toBe(200);
  });
});

describe("TestParticipantAudioMixer", () => {
  // Participants' audio is mixed into one stream that keeps their pace.
  // Pure TypeScript: runs without @livekit/rtc-node.

  function mixer(ids: string[] = [], options: { maxWaitMs?: number } = {}): _ParticipantAudioMixer {
    const m = new _ParticipantAudioMixer({ sampleRate: 48000, numChannels: 1, ...options });
    for (const id of ids) m.add(id, new Uint8Array(0));
    return m;
  }
  const pcmBytes = (value: number, ms: number) => bytesOf(pcm(value, ms));
  const all = (chunk: Uint8Array, value: number) => samples(chunk).every((s) => s === value);

  test("test_a_single_participant_passes_through_in_chunks", () => {
    const chunks = mixer().add("alice", pcmBytes(100, 30));
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBe(960);
      expect(all(chunk, 100)).toBe(true);
    }
  });

  test("test_partial_chunks_are_held_until_complete", () => {
    const m = mixer();
    expect(m.add("alice", pcmBytes(100, 5))).toEqual([]);
    expect(m.add("alice", pcmBytes(100, 5)).length).toBe(1);
  });

  test("test_participants_are_summed_and_keep_real_time", () => {
    const m = mixer(["alice", "bob"]);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 100; i++) {
      // one second of 10 ms frames from each participant
      chunks.push(...m.add("alice", pcmBytes(1000, 10)));
      chunks.push(...m.add("bob", pcmBytes(2000, 10)));
    }
    expect(chunks.length).toBe(100);
    expect(chunks.every((c) => all(c, 3000))).toBe(true);
  });

  test("test_waits_for_every_participant_before_mixing", () => {
    const m = mixer(["alice", "bob"]);
    expect(m.add("alice", pcmBytes(1000, 30))).toEqual([]);
    const chunks = m.add("bob", pcmBytes(2000, 30));
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => all(c, 3000))).toBe(true);
  });

  test("test_a_participant_who_stops_sending_is_left_out", () => {
    const m = mixer(["alice", "bob"], { maxWaitMs: 50 });

    // Bob is quiet: alice's audio waits for him until 50 ms is buffered, then
    // comes out on its own, and keeps pace without him after that.
    expect(m.add("alice", pcmBytes(1000, 40))).toEqual([]);
    let chunks = m.add("alice", pcmBytes(1000, 10));
    expect(chunks.length).toBe(5);
    expect(chunks.every((c) => all(c, 1000))).toBe(true);
    expect(m.add("alice", pcmBytes(1000, 10)).length).toBe(1);

    // Bob's audio is mixed in again as soon as it arrives.
    expect(m.add("bob", pcmBytes(2000, 10))).toEqual([]);
    chunks = m.add("alice", pcmBytes(1000, 10));
    expect(chunks.length).toBe(1);
    expect(all(chunks[0]!, 3000)).toBe(true);
  });

  test("test_mixed_samples_are_clipped", () => {
    const m = mixer(["alice", "bob"]);
    m.add("alice", pcmBytes(30000, 10));
    const [chunk] = m.add("bob", pcmBytes(30000, 10));
    expect(all(chunk!, 32767)).toBe(true);
  });
});

describeLk("TestLiveKitAudioInUserTracks", () => {
  // How the input transport delivers several participants' audio.

  async function pushAudioFromTwoParticipants(audioInUserTracks: boolean): Promise<Any[]> {
    const transport = newTransport(new LiveKitParams({ audioInEnabled: true, audioInUserTracks }));
    const input = transport.input();
    input._sampleRate = 16000;
    input.pushAudioFrame = asyncMock();

    transport._client.getNextAudioFrame = async function* () {
      for (let i = 0; i < 100; i++) {
        // one second of 10 ms frames from each participant
        for (const [participantId, value] of [
          ["alice", 1000],
          ["bob", 2000],
        ] as const) {
          const frame = new rtc.AudioFrame(pcm(value, 10), 48000, 1, 480);
          yield [{ frame }, participantId];
        }
      }
    };
    await input._audioInTaskHandler();
    return input.pushAudioFrame.mock.calls.map((c: Any[]) => c[0]);
  }

  lkTest("test_user_tracks_push_each_participants_audio", async () => {
    const frames = await pushAudioFromTwoParticipants(true);
    expect(frames.every((f) => f instanceof UserAudioRawFrame)).toBe(true);
    expect(new Set(frames.map((f) => f.userId))).toEqual(new Set(["alice", "bob"]));
  });

  lkTest("test_mixed_audio_is_one_real_time_stream", async () => {
    const frames = await pushAudioFromTwoParticipants(false);
    expect(frames.every((f) => f.constructor === InputAudioRawFrame)).toBe(true);
    expect(frames.every((f) => f.sampleRate === 16000)).toBe(true);

    // One second from each of two participants is one second of audio, not
    // two (less what the resampler still holds).
    const seconds = frames.reduce((n, f) => n + f.audio.length, 0) / 2 / 16000;
    expect(seconds).toBeGreaterThan(0.9);
    expect(seconds).toBeLessThanOrEqual(1.0);

    // The middle of the stream carries both participants' audio.
    const joined = new Uint8Array(frames.reduce((n, f) => n + f.audio.length, 0));
    let off = 0;
    for (const f of frames) {
      joined.set(f.audio, off);
      off += f.audio.length;
    }
    const middle = samples(joined).subarray(4000, 12000);
    expect(middle.every((s) => Math.abs(s - 3000) <= 3)).toBe(true);
  });
});
