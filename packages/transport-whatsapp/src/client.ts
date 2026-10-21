// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/whatsapp/client.py

/**
 * WhatsApp API Client.
 *
 * This module provides a client for communicating with the WhatsApp Cloud API,
 * handling webhook requests, managing WebRTC connections, and processing
 * WhatsApp call events.
 *
 * PORTING NOTES:
 * - Runtimes: the webhook verification, signature check and API calls use only `fetch`
 *   and WebCrypto, so they work on Bun, Node, Deno and Cloudflare Workers. Answering a call
 *   needs a WebRTC peer (`@pipedog/transport-smallwebrtc`, on werift), which needs UDP sockets:
 *   Node, Bun and Deno only. The peer comes from the package's `./connection` export, whose
 *   "workerd" condition is a stub that throws a clear error, so this module can be
 *   imported (and the webhook parts used) on Workers without werift.
 * - DIVERGENCE: `aiohttp.ClientSession` becomes the optional `fetch` option.
 * - `createConnection` (new) replaces how upstream's tests would patch `SmallWebRTCConnection`.
 * - The deprecated single-argument `connection_callback(connection)` form is not ported:
 *   the callback is `(connection, call)`.
 * - HMAC-SHA256 uses WebCrypto (`crypto.subtle`), so it is not synchronous.
 */

import { gatherSettled, rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";
import type { IceServer, SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import { createSmallWebRTCConnection } from "@pipedog/transport-whatsapp/connection";
import {
  isConnectCallValue,
  isTerminateCallValue,
  WhatsAppApi,
  type WhatsAppConnectCall,
  type WhatsAppTerminateCall,
  type WhatsAppWebhookRequest,
} from "./api.ts";

/** Called with each new connection, and the connect event with the caller's metadata. */
export type WhatsAppConnectionCallback = (
  connection: SmallWebRTCConnection,
  call: WhatsAppConnectCall,
) => Promise<void> | void;

/** Creates the WebRTC connection for a call (default: a `SmallWebRTCConnection`). */
export type WhatsAppConnectionFactory = (
  iceServers: string[] | IceServer[],
) => Promise<SmallWebRTCConnection> | SmallWebRTCConnection;

export interface WhatsAppClientOptions {
  /** WhatsApp API access token. */
  whatsappToken: string;
  /** WhatsApp phone number ID for the business account. */
  phoneNumberId: string;
  /** A `fetch`-compatible function (default: the global `fetch`). */
  fetch?: typeof fetch | null;
  /**
   * ICE servers for WebRTC connections, as URLs or `IceServer`s. Defaults to
   * Google's public STUN server.
   */
  iceServers?: string[] | IceServer[] | null;
  /** WhatsApp APP secret for validating that the webhook request came from WhatsApp. */
  whatsappSecret?: string | null;
  /** Graph API base URL (default: `WhatsAppApi.BASE_URL`). */
  baseUrl?: string | null;
  /** How to create the call's connection (default: `new SmallWebRTCConnection({ iceServers })`). */
  createConnection?: WhatsAppConnectionFactory | null;
}

export interface HandleWebhookRequestOptions {
  /** Invoked when a new WebRTC connection is established, with the connection and the connect event. */
  connectionCallback?: WhatsAppConnectionCallback | null;
  /** The raw request body, needed to validate the signature when a `whatsappSecret` is set. */
  rawBody?: Uint8Array | string | null;
  /** The `X-Hub-Signature-256` header value from the request. */
  sha256Signature?: string | null;
}

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Constant-time string comparison (`hmac.compare_digest`). */
function compareDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Check a webhook's `X-Hub-Signature-256` header: `sha256=` and the hex HMAC-SHA256 of
 * the raw request body, keyed with the app secret.
 *
 * @returns Whether the signature matches.
 */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: Uint8Array | string,
  signatureHeader: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const body = typeof rawBody === "string" ? encoder.encode(rawBody) : rawBody;
  const mac = await crypto.subtle.sign("HMAC", key, body as BufferSource);
  const expectedSignature = toHex(new Uint8Array(mac));
  // Extract signature from header (strip 'sha256=' prefix)
  const parts = signatureHeader.split("sha256=");
  const receivedSignature = parts[parts.length - 1] as string;
  return compareDigest(expectedSignature, receivedSignature);
}

/**
 * Handle a webhook verification request (`GET` with `hub.mode`, `hub.challenge`
 * and `hub.verify_token`), as a function of the query parameters.
 *
 * @param params Webhook parameters from the query string.
 * @param expectedVerificationToken The expected verification token to validate against.
 * @returns The challenge value if verification succeeds.
 * @throws Error If verification fails due to missing parameters or an invalid token.
 */
export function verifyWebhookRequest(
  params: Record<string, string | null | undefined>,
  expectedVerificationToken: string,
): number {
  const mode = params["hub.mode"];
  const challenge = params["hub.challenge"];
  const verifyToken = params["hub.verify_token"];

  if (!mode || !challenge || !verifyToken) {
    throw new Error("Missing required webhook verification parameters");
  }

  if (mode !== "subscribe") {
    throw new Error(`Invalid hub mode: expected 'subscribe', got '${mode}'`);
  }

  if (verifyToken !== expectedVerificationToken) {
    throw new Error("Webhook verification token mismatch");
  }

  const value = Number.parseInt(challenge, 10);
  if (!/^\s*[+-]?\d+\s*$/.test(challenge) || Number.isNaN(value)) {
    throw new Error(`invalid literal for int() with base 10: '${challenge}'`);
  }
  return value;
}

/**
 * WhatsApp Cloud API client for handling calls and webhook requests.
 *
 * This client manages WhatsApp call connections using WebRTC, processes webhook
 * events from WhatsApp, and maintains ongoing call state. It supports both
 * incoming call handling and call termination through the WhatsApp Cloud API.
 */
export class WhatsAppClient {
  protected _whatsappApi: WhatsAppApi;
  protected _whatsappSecret: string | null;
  /** Mapping of call IDs to WebRTC connections. */
  protected _ongoingCallsMap = new Map<string, SmallWebRTCConnection>();
  /** ICE servers for WebRTC connections. */
  protected _iceServers: string[] | IceServer[] | null;
  #createConnection: WhatsAppConnectionFactory;

  constructor(options: WhatsAppClientOptions) {
    this._whatsappApi = new WhatsAppApi({
      whatsappToken: options.whatsappToken,
      phoneNumberId: options.phoneNumberId,
      fetch: options.fetch,
      baseUrl: options.baseUrl,
    });
    this._whatsappSecret = options.whatsappSecret ?? null;

    // Set default ICE servers if none provided
    this._iceServers = options.iceServers ?? ["stun:stun.l.google.com:19302"];

    this.#createConnection =
      options.createConnection ?? ((iceServers) => createSmallWebRTCConnection(iceServers));
  }

  /** The WhatsApp API client. */
  get whatsappApi(): WhatsAppApi {
    return this._whatsappApi;
  }

  /** Update the list of ICE servers used for WebRTC connections. */
  updateIceServers(iceServers: string[] | IceServer[] | null = null): void {
    this._iceServers = iceServers;
  }

  /** Update the WhatsApp APP secret for validating that the webhook request came from WhatsApp. */
  updateWhatsappSecret(whatsappSecret: string | null = null): void {
    this._whatsappSecret = whatsappSecret;
  }

  /** Update the WhatsApp API access token. */
  updateWhatsappToken(whatsappToken: string): void {
    this._whatsappApi.updateWhatsappToken(whatsappToken);
  }

  /** Update the WhatsApp phone number ID for authentication. */
  updateWhatsappPhoneNumberId(phoneNumberId: string): void {
    this._whatsappApi.updateWhatsappPhoneNumberId(phoneNumberId);
  }

  /**
   * Terminate all ongoing WhatsApp calls.
   *
   * This method will:
   * 1. Send termination requests to WhatsApp API for each ongoing call
   * 2. Disconnect all WebRTC connections
   * 3. Clear the ongoing calls map
   *
   * All terminations are executed concurrently for efficiency.
   */
  async terminateAllCalls(): Promise<void> {
    logger.debug("Will terminate all ongoing WhatsApp calls");

    if (this._ongoingCallsMap.size === 0) {
      logger.debug("No ongoing calls to terminate");
      return;
    }

    logger.debug(`Terminating ${this._ongoingCallsMap.size} ongoing calls`);

    // Terminate each call via WhatsApp API
    const terminationTasks: Promise<unknown>[] = [];
    for (const [callId, connection] of this._ongoingCallsMap) {
      logger.debug(`Terminating call ${callId}`);
      // Call WhatsApp API to terminate the call
      terminationTasks.push(this._whatsappApi.terminateCallToWhatsapp(callId));
      // Disconnect the pipecat connection
      terminationTasks.push(connection.disconnect());
    }

    // Execute all terminations concurrently
    await gatherSettled(...terminationTasks);

    // Clear the ongoing calls map
    this._ongoingCallsMap.clear();
    logger.debug("All calls terminated successfully");
  }

  /**
   * Handle a verify webhook request from WhatsApp.
   *
   * @param params Dictionary containing webhook parameters from query string.
   * @param expectedVerificationToken The expected verification token to validate against.
   * @returns The challenge value if verification succeeds.
   * @throws Error If verification fails due to missing parameters or an invalid token.
   */
  async handleVerifyWebhookRequest(
    params: Record<string, string | null | undefined>,
    expectedVerificationToken: string,
  ): Promise<number> {
    return verifyWebhookRequest(params, expectedVerificationToken);
  }

  /** Check the request's signature against the app secret (callers gate on the secret being set). */
  protected async _validateWhatsappWebhookRequest(
    rawBody: Uint8Array | string | null | undefined,
    sha256Signature: string | null | undefined,
  ): Promise<void> {
    if (!this._whatsappSecret) throw new Error("No WhatsApp app secret is set");
    if (rawBody === null || rawBody === undefined) {
      throw new Error("Missing raw request body");
    }
    if (!sha256Signature) {
      throw new Error("Missing X-Hub-Signature-256 header");
    }

    if (!(await verifyWebhookSignature(this._whatsappSecret, rawBody, sha256Signature))) {
      throw new Error("Invalid webhook signature");
    }

    logger.debug("Webhook signature verified!");
  }

  /**
   * Handle a webhook request from WhatsApp.
   *
   * This method processes incoming webhook requests and handles both
   * connect and terminate events. For connect events, it establishes
   * a WebRTC connection and optionally invokes a callback with the
   * new connection.
   *
   * @param request The webhook request from WhatsApp containing call events
   *   (see `parseWebhookRequest`).
   * @param options `connectionCallback`, and `rawBody` and `sha256Signature` for the
   *   signature check (required when a `whatsappSecret` is set).
   * @returns True if the webhook request was handled successfully, false otherwise.
   * @throws Error If the webhook request contains no supported events, the signature is
   *   invalid, or connection establishment or API calls fail.
   */
  async handleWebhookRequest(
    request: WhatsAppWebhookRequest,
    options: HandleWebhookRequestOptions = {},
  ): Promise<boolean> {
    const { connectionCallback, rawBody, sha256Signature } = options;
    try {
      if (this._whatsappSecret) {
        await this._validateWhatsappWebhookRequest(rawBody, sha256Signature);
      }
      for (const entry of request.entry) {
        for (const change of entry.changes) {
          // Handle connect events
          if (isConnectCallValue(change.value)) {
            for (const call of change.value.calls) {
              if (call.event === "connect") {
                logger.debug(`Processing connect event for call ${call.id}`);
                try {
                  const connection = await this._handleConnectEvent(call);

                  // Invoke callback if provided
                  if (connectionCallback && connection) {
                    try {
                      await connectionCallback(connection, call);
                      logger.debug(`Connection callback executed successfully for call ${call.id}`);
                    } catch (callbackError) {
                      rethrowIfCancelled(callbackError);
                      logger.error(
                        `Connection callback failed for call ${call.id}: ${callbackError}`,
                      );
                      // Continue execution despite callback failure
                    }
                  }

                  return true;
                } catch (connectError) {
                  rethrowIfCancelled(connectError);
                  logger.error(
                    `Failed to handle connect event for call ${call.id}: ${connectError}`,
                  );
                  throw connectError;
                }
              }
            }
          }

          // Handle terminate events
          else if (isTerminateCallValue(change.value)) {
            for (const call of change.value.calls) {
              if (call.event === "terminate") {
                logger.debug(`Processing terminate event for call ${call.id}`);
                try {
                  return await this._handleTerminateEvent(call);
                } catch (terminateError) {
                  rethrowIfCancelled(terminateError);
                  logger.error(
                    `Failed to handle terminate event for call ${call.id}: ${terminateError}`,
                  );
                  throw terminateError;
                }
              }
            }
          }
        }
      }

      // No supported events found
      const errorMsg = "No supported event found in webhook request";
      logger.warning(`${errorMsg}: ${JSON.stringify(request)}`);
      throw new Error(errorMsg);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Error processing webhook request: ${e}`);
      logger.debug(`Webhook request details: ${JSON.stringify(request)}`);
      throw e;
    }
  }

  /**
   * Filter SDP to be compatible with WhatsApp requirements.
   *
   * WhatsApp only supports SHA-256 fingerprints, so this method removes
   * other fingerprint types from the SDP.
   *
   * @param sdp The original SDP string.
   * @returns Filtered SDP string compatible with WhatsApp.
   */
  protected _filterSdpForWhatsapp(sdp: string): string {
    const lines = sdp.split(/\r\n|\n|\r/);
    if (lines[lines.length - 1] === "") lines.pop(); // str.splitlines() has no trailing empty line
    const filtered: string[] = [];
    for (const line of lines) {
      if (line.startsWith("a=fingerprint:") && !line.startsWith("a=fingerprint:sha-256")) {
        continue; // drop sha-384 / sha-512
      }
      filtered.push(line);
    }
    return `${filtered.join("\r\n")}\r\n`;
  }

  /**
   * Handle a CONNECT event by establishing WebRTC connection and accepting the call.
   *
   * This method:
   * 1. Creates a new WebRTC connection using configured ICE servers
   * 2. Initializes the connection with the provided SDP
   * 3. Generates an SDP answer and filters it for WhatsApp compatibility
   * 4. Pre-accepts the call with WhatsApp API
   * 5. Accepts the call with WhatsApp API
   * 6. Stores the connection for later management
   *
   * @param call WhatsApp connect call event.
   * @returns The established SmallWebRTCConnection instance.
   * @throws Error If pre-accept or accept API calls fail.
   */
  protected async _handleConnectEvent(call: WhatsAppConnectCall): Promise<SmallWebRTCConnection> {
    logger.debug(`Incoming call from ${call.from}, call_id: ${call.id}`);

    let connection: SmallWebRTCConnection | null = null;
    try {
      // Create and initialize WebRTC connection
      connection = await this.#createConnection(this._iceServers ?? []);
      await connection.initialize(call.session.sdp, call.session.sdp_type);
      const answer = connection.getAnswer();
      if (answer === null) {
        throw new Error("SmallWebRTC connection produced no SDP answer");
      }
      const rawAnswer = answer.sdp;
      if (rawAnswer === undefined || rawAnswer === null) {
        throw new Error("SmallWebRTC SDP answer missing 'sdp' field");
      }
      const sdpAnswer = this._filterSdpForWhatsapp(rawAnswer);

      logger.debug(`SDP answer generated for call ${call.id}`);

      // Pre-accept the call
      try {
        const preAcceptResp = await this._whatsappApi.answerCallToWhatsapp(
          call.id,
          "pre_accept",
          sdpAnswer,
          call.from,
        );
        if (!preAcceptResp.success) {
          logger.error(`Failed to pre-accept call ${call.id}: ${JSON.stringify(preAcceptResp)}`);
          throw new Error(`Failed to pre-accept call: ${JSON.stringify(preAcceptResp)}`);
        }

        logger.debug(`Pre-accept successful for call ${call.id}`);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`Pre-accept API call failed for call ${call.id}: ${e}`);
        throw new Error(`Failed to pre-accept call: ${e}`);
      }

      // Accept the call
      try {
        const acceptResp = await this._whatsappApi.answerCallToWhatsapp(
          call.id,
          "accept",
          sdpAnswer,
          call.from,
        );
        if (!acceptResp.success) {
          logger.error(`Failed to accept call ${call.id}: ${JSON.stringify(acceptResp)}`);
          throw new Error(`Failed to accept call: ${JSON.stringify(acceptResp)}`);
        }

        logger.debug(`Accept successful for call ${call.id}`);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`Accept API call failed for call ${call.id}: ${e}`);
        throw new Error(`Failed to accept call: ${e}`);
      }

      // Store the connection for management
      this._ongoingCallsMap.set(call.id, connection);

      // Set up disconnect handler
      connection.eventHandler("closed", async (webrtcConnection: SmallWebRTCConnection) => {
        logger.debug(`Peer connection closed: ${webrtcConnection.pcId} for call ${call.id}`);
        // Clean up from ongoing calls map
        this._ongoingCallsMap.delete(call.id);
      });

      logger.debug(`WebRTC connection established successfully for call ${call.id}`);
      return connection;
    } catch (e) {
      rethrowIfCancelled(e);
      // Clean up connection on failure
      if (connection) {
        try {
          await connection.disconnect();
        } catch (cleanupError) {
          rethrowIfCancelled(cleanupError);
          logger.error(`Failed to cleanup connection for call ${call.id}: ${cleanupError}`);
        }
      }

      logger.error(`Failed to handle connect event for call ${call.id}: ${e}`);
      throw e;
    }
  }

  /**
   * Handle a TERMINATE event by cleaning up resources and logging call completion.
   *
   * This method:
   * 1. Logs call termination details including duration if available
   * 2. Disconnects the associated WebRTC connection
   * 3. Removes the call from the ongoing calls map
   *
   * @param call WhatsApp terminate call event.
   * @returns True if the call was terminated successfully, false otherwise.
   */
  protected async _handleTerminateEvent(call: WhatsAppTerminateCall): Promise<boolean> {
    logger.debug(`Call terminated from ${call.from}, call_id: ${call.id}`);
    logger.debug(`Call status: ${call.status}`);
    if (call.duration) {
      logger.debug(`Call duration: ${call.duration} seconds`);
    }

    try {
      const connection = this._ongoingCallsMap.get(call.id);
      if (connection) {
        logger.debug(`Disconnecting WebRTC connection for call ${call.id}`);

        try {
          await connection.disconnect();
          logger.debug(`WebRTC connection disconnected successfully for call ${call.id}`);
        } catch (disconnectError) {
          rethrowIfCancelled(disconnectError);
          logger.error(
            `Failed to disconnect WebRTC connection for call ${call.id}: ${disconnectError}`,
          );
        }

        // Remove from ongoing calls map
        this._ongoingCallsMap.delete(call.id);
      } else {
        logger.warning(`Call ${call.id} not found in ongoing calls map`);
      }

      return true;
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Error handling terminate event for call ${call.id}: ${e}`);
      return false;
    }
  }
}
