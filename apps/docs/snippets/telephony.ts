// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/telephony/index.mdx. Type-checked on every docs build.

// #region handshake
import type { FrameSerializer } from "@pipedog/core/serializers/base_serializer";
import type { CallData, TelnyxCallData } from "@pipedog/runner/types";
import { telephonyHandshake } from "@pipedog/runner/utils";
import { ExotelFrameSerializer } from "@pipedog/serializer-exotel/exotel";
import { PlivoFrameSerializer } from "@pipedog/serializer-plivo/plivo";
import { TelnyxFrameSerializer } from "@pipedog/serializer-telnyx/telnyx";
import { TwilioFrameSerializer } from "@pipedog/serializer-twilio/twilio";
import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";

const env = process.env;

/** One serializer per provider, from the parsed handshake. */
function serializerFor(transportType: string, callData: CallData): FrameSerializer {
  const streamId = callData.streamId ?? "";
  switch (transportType) {
    case "twilio":
      return new TwilioFrameSerializer({
        streamSid: streamId,
        callSid: callData.callId,
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
      });
    case "telnyx":
      return new TelnyxFrameSerializer({
        streamId,
        callControlId: callData.callId,
        outboundEncoding: (callData as TelnyxCallData).outboundEncoding ?? "PCMU",
        inboundEncoding: "PCMU",
        apiKey: env.TELNYX_API_KEY,
      });
    case "plivo":
      return new PlivoFrameSerializer({
        streamId,
        callId: callData.callId,
        authId: env.PLIVO_AUTH_ID,
        authToken: env.PLIVO_AUTH_TOKEN,
      });
    default:
      return new ExotelFrameSerializer({ streamSid: streamId, callSid: callData.callId });
  }
}

const handler = websocketFetchHandler(async (websocket) => {
  const handshake = await telephonyHandshake(websocket);
  if (handshake.status === "closed") return; // the caller hung up while connecting
  if (handshake.status === "unrecognized") throw new Error("not a phone provider");

  const { transportType, callData } = handshake;
  console.log(`${transportType} call ${callData.callId} from ${callData.fromNumber}`);
  const serializer = serializerFor(transportType, callData);
  // new FastAPIWebsocketTransport(websocket, new FastAPIWebsocketParams({ serializer, ... }))
});
// #endregion handshake
