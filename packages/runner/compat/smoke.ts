// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: parses each provider's handshake from a
// stand-in socket with parseTelephonyWebsocket, on each runtime.

import { logger } from "@pipedog/core/utils/logger";

import { ExotelCallData, TelnyxCallData } from "../src/types.ts";
import { parseTelephonyWebsocket, type TelephonyWebsocketMessage } from "../src/utils.ts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`runner smoke: ${message}`);
}

function socket(messages: unknown[]) {
  let i = 0;
  return {
    async receive(): Promise<TelephonyWebsocketMessage> {
      if (i >= messages.length) return { type: "websocket.disconnect" };
      return { type: "websocket.receive", text: JSON.stringify(messages[i++]) };
    },
  };
}

export default async function smoke(): Promise<void> {
  logger.setLevel("CRITICAL");

  const [twilio, twilioData] = await parseTelephonyWebsocket(
    socket([
      { event: "connected", protocol: "Call", version: "1.0.0" },
      {
        event: "start",
        start: {
          streamSid: "MZ1",
          callSid: "CA1",
          customParameters: { from_number: "+1555", to_number: "+1666" },
        },
      },
    ]),
  );
  check(twilio === "twilio", `twilio detected as ${twilio}`);
  check(twilioData.streamId === "MZ1" && twilioData.callId === "CA1", "twilio ids");
  check(
    twilioData.fromNumber === "+1555" && twilioData.getItem("to") === "+1666",
    "twilio from/to",
  );

  const [telnyx, telnyxData] = await parseTelephonyWebsocket(
    socket([
      { event: "connected" },
      { stream_id: "s1", start: { call_control_id: "cc1", media_format: { encoding: "PCMA" } } },
    ]),
  );
  check(telnyx === "telnyx" && telnyxData instanceof TelnyxCallData, `telnyx: ${telnyx}`);
  check(telnyxData.callId === "cc1" && telnyxData.outboundEncoding === "PCMA", "telnyx data");

  const [plivo, plivoData] = await parseTelephonyWebsocket(
    socket([{ event: "start", start: { streamId: "p1", callId: "pc1" } }]),
  );
  check(plivo === "plivo" && plivoData.callId === "pc1", `plivo: ${plivo}`);

  const [exotel, exotelData] = await parseTelephonyWebsocket(
    socket([
      { event: "connected" },
      { event: "start", start: { stream_sid: "e1", call_sid: "ec1", account_sid: "a1" } },
    ]),
  );
  check(exotel === "exotel" && exotelData instanceof ExotelCallData, `exotel: ${exotel}`);
  check(exotelData.accountSid === "a1", "exotel account sid");
}
