// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_smallwebrtc_request_handler.py

/**
 * Tests for `SmallWebRTCRequestHandler.handlePatchRequest`.
 *
 * Firefox emits an RFC 8840 end-of-candidates marker per media line: a real
 * `RTCIceCandidate` whose `.candidate` string is empty. That can't be parsed
 * as a candidate, and `addIceCandidate` treats `null` (not an empty-string
 * candidate) as the end-of-candidates signal. These tests confirm the handler
 * forwards `null` for empty markers instead of erroring out or silently
 * dropping them.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import {
  IceCandidate,
  SmallWebRTCPatchRequest,
  SmallWebRTCRequestHandler,
} from "@pipedog/transport-smallwebrtc/request_handler";
import type { RTCIceCandidate } from "@pipedog/transport-smallwebrtc/rtc";

const REAL_CANDIDATE_SDP = "candidate:0 1 UDP 2121990399 192.168.1.1 35628 typ host";

describe("TestHandlePatchRequest", () => {
  let handler: SmallWebRTCRequestHandler;
  let peerConnection: { addIceCandidate: ReturnType<typeof mock> };

  beforeEach(() => {
    handler = new SmallWebRTCRequestHandler();
    peerConnection = { addIceCandidate: mock(async (_c: RTCIceCandidate | null) => {}) };
    handler._pcsMap.set("pc-1", peerConnection as unknown as SmallWebRTCConnection);
  });

  test("test_empty_candidate_forwarded_as_none", async () => {
    // A single empty-string marker becomes a `null` candidate, not an error.
    const request = new SmallWebRTCPatchRequest({
      pcId: "pc-1",
      candidates: [new IceCandidate({ candidate: "", sdpMid: "0", sdpMlineIndex: 0 })],
    });

    await handler.handlePatchRequest(request);

    expect(peerConnection.addIceCandidate).toHaveBeenCalledTimes(1);
    expect(peerConnection.addIceCandidate).toHaveBeenCalledWith(null);
  });

  test("test_mixed_real_and_empty_candidates_across_mids", async () => {
    // Real candidates parse normally; empty markers become `null`, matching
    // Firefox's batch of real candidates followed by a per-mid
    // end-of-candidates marker for audio (mid 0), video (mid 1), and data (mid 3).
    const request = new SmallWebRTCPatchRequest({
      pcId: "pc-1",
      candidates: [
        new IceCandidate({ candidate: REAL_CANDIDATE_SDP, sdpMid: "0", sdpMlineIndex: 0 }),
        new IceCandidate({ candidate: "", sdpMid: "0", sdpMlineIndex: 0 }),
        new IceCandidate({ candidate: REAL_CANDIDATE_SDP, sdpMid: "1", sdpMlineIndex: 1 }),
        new IceCandidate({ candidate: "", sdpMid: "1", sdpMlineIndex: 1 }),
        new IceCandidate({ candidate: "", sdpMid: "3", sdpMlineIndex: 3 }),
      ],
    });

    await handler.handlePatchRequest(request);

    expect(peerConnection.addIceCandidate).toHaveBeenCalledTimes(5);
    const calls = peerConnection.addIceCandidate.mock.calls as [RTCIceCandidate | null][];

    for (const [call, expectedMid, expectedMline] of [
      [calls[0]!, "0", 0],
      [calls[2]!, "1", 1],
    ] as const) {
      const [candidate] = call;
      expect(candidate).not.toBeNull();
      expect(candidate!.sdpMid).toEqual(expectedMid);
      expect(candidate!.sdpMLineIndex).toEqual(expectedMline);
    }

    for (const call of [calls[1]!, calls[3]!, calls[4]!]) {
      const [candidate] = call;
      expect(candidate).toBeNull();
    }
  });
});
