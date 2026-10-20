// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/smallwebrtc/request_handler.py

/**
 * SmallWebRTC request handler for managing peer connections.
 *
 * This module provides a client for handling web requests and managing WebRTC
 * connections. It is framework-agnostic: `http.ts` serves it over the
 * standard `Request`/`Response` API (Bun, Deno, Hono, Node adapters).
 */

import { gather, rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";

import {
  type IceServer,
  SmallWebRTCConnection,
  type SmallWebRTCConnectionOptions,
} from "./connection.ts";
import { candidateFromSdp, type RTCIceCandidate } from "./rtc.ts";

/**
 * An HTTP error with a status code (FastAPI's `HTTPException`, which upstream
 * raises). `http.ts` turns it into a response with `{"detail": ...}`.
 */
export class HTTPException extends Error {
  statusCode: number;
  detail: string | null;

  constructor(options: { statusCode: number; detail?: string | null }) {
    super(options.detail ?? `HTTP ${options.statusCode}`);
    this.name = "HTTPException";
    this.statusCode = options.statusCode;
    this.detail = options.detail ?? null;
  }
}

export interface SmallWebRTCRequestOptions {
  sdp: string;
  type: string;
  pcId?: string | null;
  restartPc?: boolean | null;
  requestData?: unknown | null;
}

/**
 * Small WebRTC transport session arguments for the runner.
 *
 * - `sdp`: The SDP string (Session Description Protocol).
 * - `type`: The type of the SDP, either "offer" or "answer".
 * - `pcId`: Optional identifier for the peer connection.
 * - `restartPc`: Optional whether to restart the peer connection.
 * - `requestData`: Optional custom data sent by the customer.
 */
export class SmallWebRTCRequest {
  sdp: string;
  type: string;
  pcId: string | null;
  restartPc: boolean | null;
  requestData: unknown | null;

  constructor(options: SmallWebRTCRequestOptions) {
    this.sdp = options.sdp;
    this.type = options.type;
    this.pcId = options.pcId ?? null;
    this.restartPc = options.restartPc ?? null;
    this.requestData = options.requestData ?? null;
  }

  /** Build a request from its JSON body; accepts both `request_data` and `requestData`. */
  static fromDict(data: Record<string, any>): SmallWebRTCRequest {
    const requestData =
      "requestData" in data && !("request_data" in data) ? data.requestData : data.request_data;
    return new SmallWebRTCRequest({
      sdp: data.sdp,
      type: data.type,
      pcId: data.pc_id,
      restartPc: data.restart_pc,
      requestData,
    });
  }
}

/**
 * The remote ice candidate object received from the peer connection.
 *
 * - `candidate`: The ice candidate patch SDP string.
 * - `sdpMid`: The SDP mid for the candidate patch.
 * - `sdpMlineIndex`: The SDP mline index for the candidate patch.
 */
export class IceCandidate {
  candidate: string;
  sdpMid: string;
  sdpMlineIndex: number;

  constructor(options: { candidate: string; sdpMid: string; sdpMlineIndex: number }) {
    this.candidate = options.candidate;
    this.sdpMid = options.sdpMid;
    this.sdpMlineIndex = options.sdpMlineIndex;
  }
}

/**
 * Small WebRTC transport session arguments for the runner.
 *
 * - `pcId`: Identifier for the peer connection.
 * - `candidates`: A list of ICE candidate patches.
 */
export class SmallWebRTCPatchRequest {
  pcId: string;
  candidates: IceCandidate[];

  constructor(options: { pcId: string; candidates: IceCandidate[] }) {
    this.pcId = options.pcId;
    this.candidates = options.candidates;
  }

  /** Build a request from its JSON body (`{pc_id, candidates: [{candidate, sdp_mid, sdp_mline_index}]}`). */
  static fromDict(data: Record<string, any>): SmallWebRTCPatchRequest {
    return new SmallWebRTCPatchRequest({
      pcId: data.pc_id,
      candidates: (data.candidates ?? []).map(
        (c: Record<string, any>) =>
          new IceCandidate({
            candidate: c.candidate,
            sdpMid: c.sdp_mid,
            sdpMlineIndex: c.sdp_mline_index,
          }),
      ),
    });
  }
}

/** Enum defining the connection handling modes. */
export const ConnectionMode = {
  SINGLE: "single", // Only one active connection allowed
  MULTIPLE: "multiple", // Multiple simultaneous connections allowed
} as const;
export type ConnectionMode = (typeof ConnectionMode)[keyof typeof ConnectionMode];

/**
 * Remove fingerprint algorithms (sha-384, sha-512) ESP32 peers don't support,
 * and, with `host`, keep only the ICE candidates that match it.
 *
 * Porting note: upstream's `pipecat.runner.utils.smallwebrtc_sdp_munging`;
 * kept here until the runner is ported.
 */
export function smallwebrtcSdpMunging(sdp: string, host: string | null): string {
  // Python's str.splitlines(): no trailing empty line.
  const splitlines = (text: string): string[] => {
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.at(-1) === "") lines.pop();
    return lines;
  };
  logger.debug("Removing unsupported fingerprints from SDP");
  let result = `${splitlines(sdp)
    .filter((line) => !/sha-384/.test(line) && !/sha-512/.test(line))
    .join("\r\n")}\r\n`;
  if (host) {
    logger.debug("Removing unsupported ICE candidates from SDP");
    const pattern = new RegExp(host);
    result = `${splitlines(result)
      .filter((line) => !/a=candidate/.test(line) || (pattern.test(line) && !/raddr/.test(line)))
      .join("\r\n")}\r\n`;
  }
  return result;
}

export interface SmallWebRTCRequestHandlerOptions {
  /** List of ICE servers to use for WebRTC connections. */
  iceServers?: IceServer[] | null;
  /** If true, enables ESP32-specific SDP munging. */
  esp32Mode?: boolean;
  /** Host address used for SDP munging in ESP32 mode. Ignored if `esp32Mode` is false. */
  host?: string | null;
  /** SINGLE allows only one active connection, MULTIPLE allows several. */
  connectionMode?: ConnectionMode;
  /**
   * pipedog: options for each new `SmallWebRTCConnection` (video codecs,
   * Opus implementation, werift settings). `iceServers` comes from above.
   */
  connectionOptions?: Omit<SmallWebRTCConnectionOptions, "iceServers">;
}

/**
 * SmallWebRTC request handler for managing peer connections.
 *
 * This class is responsible for:
 *   - Handling incoming SmallWebRTC requests.
 *   - Creating and managing WebRTC peer connections.
 *   - Supporting ESP32-specific SDP munging if enabled.
 *   - Invoking callbacks for newly initialized connections.
 *   - Supporting both single and multiple connection modes.
 */
export class SmallWebRTCRequestHandler {
  protected _iceServers: IceServer[] | null;
  protected _esp32Mode: boolean;
  protected _host: string | null;
  protected _connectionMode: ConnectionMode;
  protected _connectionOptions: Omit<SmallWebRTCConnectionOptions, "iceServers">;

  // Store connections by pc_id
  _pcsMap = new Map<string, SmallWebRTCConnection>();

  constructor(options: SmallWebRTCRequestHandlerOptions = {}) {
    this._iceServers = options.iceServers ?? null;
    this._esp32Mode = options.esp32Mode ?? false;
    this._host = options.host ?? null;
    this._connectionMode = options.connectionMode ?? ConnectionMode.MULTIPLE;
    this._connectionOptions = options.connectionOptions ?? {};
  }

  /**
   * Check if the connection request satisfies single connection mode constraints.
   *
   * @throws HTTPException If constraints are violated in single connection mode.
   */
  protected _checkSingleConnectionConstraints(pcId: string | null): void {
    if (this._connectionMode !== ConnectionMode.SINGLE) return;

    if (this._pcsMap.size === 0) return; // No existing connections

    // Get the existing connection (should be only one in single mode)
    const existingConnection = this._pcsMap.values().next().value!;

    if (existingConnection.pcId !== pcId && pcId) {
      logger.warning(
        `Connection pc_id mismatch: existing=${existingConnection.pcId}, received=${pcId}`,
      );
      throw new HTTPException({
        statusCode: 400,
        detail: "PC ID mismatch with existing connection",
      });
    }

    if (!pcId) {
      logger.warning(
        "Cannot create new connection: existing connection found but no pc_id received",
      );
      throw new HTTPException({
        statusCode: 400,
        detail: "Cannot create new connection with existing connection active",
      });
    }
  }

  /** Update the list of ICE servers used for WebRTC connections. */
  updateIceServers(iceServers: IceServer[] | null = null): void {
    this._iceServers = iceServers;
  }

  /**
   * Handle a SmallWebRTC request and resolve the pending answer.
   *
   * This method will:
   *   - Reuse an existing WebRTC connection if `pcId` exists.
   *   - Otherwise, create a new `SmallWebRTCConnection`.
   *   - Invoke the provided callback with the connection.
   *   - Manage ESP32-specific munging if enabled.
   *   - Enforce single/multiple connection mode constraints.
   *
   * @param request The incoming WebRTC request.
   * @param webrtcConnectionCallback Invoked with each new connection. It
   *   should start the bot in the background and return promptly: the answer
   *   is sent once it returns.
   * @returns The SDP answer, type, and peer connection ID.
   * @throws HTTPException If connection mode constraints are violated.
   */
  async handleWebRequest(
    request: SmallWebRTCRequest,
    webrtcConnectionCallback: (connection: SmallWebRTCConnection) => Promise<void> | void,
  ): Promise<{ sdp: string; type: string; pc_id: string }> {
    try {
      const pcId = request.pcId;

      // Check connection mode constraints first
      this._checkSingleConnectionConstraints(pcId);

      // After constraints are satisfied, get the existing connection if any
      const existingConnection = pcId ? this._pcsMap.get(pcId) : undefined;

      let pipecatConnection: SmallWebRTCConnection;
      if (existingConnection) {
        pipecatConnection = existingConnection;
        logger.info(`Reusing existing connection for pc_id: ${pcId}`);
        await pipecatConnection.renegotiate({
          sdp: request.sdp,
          type: request.type,
          restartPc: request.restartPc ?? false,
        });
      } else {
        pipecatConnection = new SmallWebRTCConnection({
          ...this._connectionOptions,
          iceServers: this._iceServers,
        });
        await pipecatConnection.initialize(request.sdp, request.type);

        pipecatConnection.eventHandler(
          "closed",
          async (webrtcConnection: SmallWebRTCConnection) => {
            logger.info(`Discarding peer connection for pc_id: ${webrtcConnection.pcId}`);
            this._pcsMap.delete(webrtcConnection.pcId);
          },
        );

        // Invoke callback provided in runner arguments
        try {
          await webrtcConnectionCallback(pipecatConnection);
          logger.debug(
            `webrtc_connection_callback executed successfully for peer: ${pipecatConnection.pcId}`,
          );
        } catch (callbackError) {
          rethrowIfCancelled(callbackError);
          logger.error(
            `webrtc_connection_callback failed for peer ${pipecatConnection.pcId}: ${callbackError}`,
          );
        }
      }

      const answer = pipecatConnection.getAnswer();
      if (answer === null) {
        throw new Error("SmallWebRTC connection produced no SDP answer");
      }

      if (this._esp32Mode) {
        answer.sdp = smallwebrtcSdpMunging(answer.sdp, this._host);
      }

      this._pcsMap.set(answer.pc_id, pipecatConnection);

      return answer;
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Error processing SmallWebRTC request: ${e}`);
      logger.debug(
        `SmallWebRTC request details: ${pyJsonDumps({ type: request.type, pc_id: request.pcId, restart_pc: request.restartPc })}`,
      );
      throw e;
    }
  }

  /**
   * Handle a SmallWebRTC patch candidate request.
   *
   * @throws HTTPException 404 if the peer connection is unknown.
   */
  async handlePatchRequest(request: SmallWebRTCPatchRequest): Promise<void> {
    const peerConnection = this._pcsMap.get(request.pcId);

    if (!peerConnection) {
      throw new HTTPException({ statusCode: 404, detail: "Peer connection not found" });
    }

    for (const c of request.candidates) {
      let candidate: RTCIceCandidate | null;
      if (c.candidate) {
        candidate = candidateFromSdp(c.candidate);
        candidate.sdpMid = c.sdpMid;
        candidate.sdpMLineIndex = c.sdpMlineIndex;
      } else {
        // An empty candidate string is an RFC 8840 end-of-candidates marker
        // (e.g. sent by Firefox per media line), signalled with `null` rather
        // than a candidate with an empty SDP.
        candidate = null;
      }
      await peerConnection.addIceCandidate(candidate);
    }
  }

  /** Disconnect every connection and clear the connection map. */
  async close(): Promise<void> {
    const connections = [...this._pcsMap.values()];
    await gather(...connections.map((pc) => () => pc.disconnect()));
    this._pcsMap.clear();
  }
}
