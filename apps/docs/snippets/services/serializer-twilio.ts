// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/serializers/twilio.mdx. Type-checked on every docs build.

// #region usage
import { parseTelephonyWebsocket } from "@pipedog/runner/utils";
import { TwilioFrameSerializer } from "@pipedog/serializer-twilio/twilio";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";

async function runCall(connection: WebsocketConnection): Promise<void> {
  // Twilio sends "connected", then "start" with the stream and call SIDs.
  const [, callData] = await parseTelephonyWebsocket(connection);

  const serializer = new TwilioFrameSerializer({
    streamSid: callData.streamId ?? "",
    callSid: callData.callId,
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
  });

  const transport = new FastAPIWebsocketTransport(
    connection,
    new FastAPIWebsocketParams({
      audioInEnabled: true,
      audioOutEnabled: true,
      addWavHeader: false,
      serializer,
    }),
  );
  // ... build and run the pipeline with transport.input() and transport.output()
}

// The <Stream url="wss://..."> in your TwiML points here.
const handler = websocketFetchHandler(runCall);
// #endregion usage

// #region region
const regional = new TwilioFrameSerializer({
  streamSid: "MZ...",
  callSid: "CA...",
  accountSid: "AC...",
  authToken: "...",
  // Hang up through api.dublin.ie1.twilio.com. Both are required together.
  region: "ie1",
  edge: "dublin",
});
// #endregion region

// #region no-hangup
const noHangUp = new TwilioFrameSerializer({
  streamSid: "MZ...",
  params: new TwilioFrameSerializer.InputParams({ autoHangUp: false }),
});
// #endregion no-hangup
