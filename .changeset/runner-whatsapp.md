---
"@pipedog/runner": patch
---

Wire the WhatsApp transport into the runner: `--whatsapp` mounts `GET` and `POST /whatsapp` (Meta's webhook verification and call events) on `@pipedog/transport-whatsapp`, an optional peer. It reads `WHATSAPP_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN` and `WHATSAPP_WEBHOOK_VERIFICATION_TOKEN`, and starts the bot with `SmallWebRTCRunnerArguments` whose `body` is the call.
