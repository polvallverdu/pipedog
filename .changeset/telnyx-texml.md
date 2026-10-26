---
"@pipedog/serializer-telnyx": minor
---

`@pipedog/serializer-telnyx/texml` (pipedog only): the HTTP side of a Telnyx bot, on Bun, Node, Deno and Workers (`fetch` and WebCrypto only). `verifyTelnyxSignature()` checks a webhook's Ed25519 signature with a 5-minute replay window; `answerTexml()` connects an answered call to the bot's WebSocket; `parseStatusCallback()` and `parseCallCost()` read TeXML status callbacks and the `call.cost` webhook; `TelnyxTexmlClient` places outbound calls (`dial`, with status callbacks) and looks them up (`getCall`), throwing `TelnyxCallRejectedError` with `invalidDestination` when Telnyx refuses a call.
