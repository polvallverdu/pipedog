// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/runner/livekit.py

/**
 * LiveKit room and token configuration utilities.
 *
 * This module provides helper functions for creating and configuring LiveKit
 * rooms and authentication tokens. It handles JWT token generation with
 * appropriate grants for both regular participants and AI agents.
 *
 * The module supports creating tokens for development and testing, with
 * automatic agent detection for proper room permissions.
 *
 * Tokens are signed with LiveKit's `livekit-server-sdk` (Python:
 * `livekit.api`), which is pure JavaScript (WebCrypto), so this module runs on
 * every runtime. DIVERGENCE: the token functions are async, because WebCrypto
 * signs asynchronously.
 *
 * Required environment variables:
 *
 * - LIVEKIT_API_KEY - LiveKit API key
 * - LIVEKIT_API_SECRET - LiveKit API secret
 * - LIVEKIT_URL - LiveKit server URL
 * - LIVEKIT_ROOM_NAME - Room name to join
 *
 * @example
 * import { configure } from "@pipedog/runner/livekit";
 *
 * const [url, token, roomName] = await configure();
 * // Use with LiveKitTransport
 */

import { logger } from "@pipedog/core/utils/logger";
import { AccessToken } from "livekit-server-sdk";
import { ArgumentParser, type Namespace } from "./argparse.ts";

function getenv(name: string): string | undefined {
  return (globalThis as any).process?.env?.[name];
}

/**
 * Generate a LiveKit access token for a participant.
 *
 * @param roomName Name of the LiveKit room.
 * @param participantName Name of the participant.
 * @param apiKey LiveKit API key.
 * @param apiSecret LiveKit API secret.
 * @returns JWT token string for room access.
 */
export async function generateToken(
  roomName: string,
  participantName: string,
  apiKey: string,
  apiSecret: string,
): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, {
    identity: participantName,
    name: participantName,
  });
  token.addGrant({ roomJoin: true, room: roomName });

  return await token.toJwt();
}

/**
 * Generate a LiveKit access token for an agent participant.
 *
 * @param roomName Name of the LiveKit room.
 * @param participantName Name of the participant.
 * @param apiKey LiveKit API key.
 * @param apiSecret LiveKit API secret.
 * @returns JWT token string for agent room access.
 */
export async function generateTokenWithAgent(
  roomName: string,
  participantName: string,
  apiKey: string,
  apiSecret: string,
): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, {
    identity: participantName,
    name: participantName,
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    agent: true, // This makes LiveKit client know agent has joined
  });

  return await token.toJwt();
}

/**
 * Return `[url, apiKey, apiSecret]` from the environment.
 *
 * @throws Error If `LIVEKIT_URL`, `LIVEKIT_API_KEY`, or `LIVEKIT_API_SECRET`
 *   is not set in the environment.
 */
export function livekitCredentials(): [string, string, string] {
  const url = getenv("LIVEKIT_URL");
  const apiKey = getenv("LIVEKIT_API_KEY");
  const apiSecret = getenv("LIVEKIT_API_SECRET");
  if (!url || !apiKey || !apiSecret) {
    throw new Error(
      "LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be set in environment variables.",
    );
  }
  return [url, apiKey, apiSecret];
}

/**
 * Mint distinct agent/user tokens for a session.
 *
 * Identities are suffixed with the session id so concurrent sessions sharing
 * a room (e.g. a fixed `LIVEKIT_ROOM_NAME`) don't collide — LiveKit evicts the
 * earlier connection when a new one joins with the same identity.
 *
 * @param roomName Name of the LiveKit room.
 * @param sessionId Unique id for this session; used to suffix participant identities.
 * @param apiKey LiveKit API key.
 * @param apiSecret LiveKit API secret.
 * @returns `[agentToken, userToken]`, for the bot and the caller respectively.
 */
export async function generateSessionTokens(
  roomName: string,
  sessionId: string,
  apiKey: string,
  apiSecret: string,
): Promise<[string, string]> {
  const suffix = sessionId.slice(0, 8);
  const agentToken = await generateTokenWithAgent(
    roomName,
    `Pipecat Agent-${suffix}`,
    apiKey,
    apiSecret,
  );
  const userToken = await generateToken(roomName, `User-${suffix}`, apiKey, apiSecret);
  return [agentToken, userToken];
}

/**
 * Configure LiveKit room URL and token from arguments or environment.
 *
 * @returns The server URL, authentication token, and room name.
 * @throws Error If required LiveKit configuration is not provided.
 */
export async function configure(): Promise<[string, string, string]> {
  const [url, token, roomName] = await configureWithArgs();
  return [url, token, roomName];
}

/**
 * Configure LiveKit room with command-line argument parsing.
 *
 * @param parser Optional argument parser. If null, creates a default one.
 * @param argv The command line arguments (default: `process.argv.slice(2)`).
 * @returns Server URL, authentication token, room name, and parsed arguments.
 * @throws Error If required LiveKit configuration is not provided via arguments or environment.
 */
export async function configureWithArgs(
  parser: ArgumentParser | null = null,
  argv: readonly string[] | null = null,
): Promise<[string, string, string, Namespace]> {
  if (!parser) parser = new ArgumentParser({ description: "LiveKit AI SDK Bot Sample" });
  parser.addArgument("-r", "--room", { type: "str", help: "Name of the LiveKit room to join" });
  parser.addArgument("-u", "--url", { type: "str", help: "URL of the LiveKit server" });

  const [args] = parser.parseKnownArgs(argv ?? (globalThis as any).process?.argv?.slice(2) ?? []);

  const roomName = args.room || getenv("LIVEKIT_ROOM_NAME");
  const url = args.url || getenv("LIVEKIT_URL");
  const apiKey = getenv("LIVEKIT_API_KEY");
  const apiSecret = getenv("LIVEKIT_API_SECRET");

  if (!roomName) {
    throw new Error(
      "No LiveKit room specified. Use the -r/--room option from the command line, or set LIVEKIT_ROOM_NAME in your environment.",
    );
  }

  if (!url) {
    throw new Error(
      "No LiveKit server URL specified. Use the -u/--url option from the command line, or set LIVEKIT_URL in your environment.",
    );
  }

  if (!apiKey || !apiSecret) {
    throw new Error("LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set in environment variables.");
  }

  const token = await generateTokenWithAgent(roomName, "Pipecat Agent", apiKey, apiSecret);

  // Generate user token for testing/debugging
  const userToken = await generateToken(roomName, "User", apiKey, apiSecret);
  logger.info(`User token: ${userToken}`);

  return [url, token, roomName, args];
}
