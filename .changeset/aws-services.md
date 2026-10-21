---
"@pipedog/aws": minor
---

`@pipedog/aws`: AWS services, a port of Pipecat's `pipecat.services.aws`.

- `AWSBedrockLLMService` (Bedrock Converse/ConverseStream) with `AWSBedrockLLMAdapter`,
  `AWSTranscribeSTTService` (Transcribe streaming over its WebSocket API), `AWSPollyTTSService`,
  `AWSAgentCoreProcessor` and `AWSNovaSonicLLMService` (Bedrock's bidirectional-stream
  WebSocket endpoint). They call AWS with `fetch` and the global `WebSocket`, signing with SigV4
  on WebCrypto, so they run on Bun, Node, Deno and Cloudflare Workers.
- `SageMakerBidiClient` needs an HTTP/2 duplex stream, so it uses
  `@aws-sdk/client-sagemaker-runtime-http2` (an optional peer, loaded lazily) on Node and Bun.
  Nova Sonic can use HTTP/2 through `@aws-sdk/client-bedrock-runtime` too (`transport: "http2"`).
- Keys come from the options or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
  `AWS_SESSION_TOKEN` / `AWS_REGION`, or from a `credentialsProvider` function that can renew
  temporary credentials.
