# @pipedog/aws

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0
  - @pipedog/asyncio@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [[`9f1ce7a`](https://github.com/polvallverdu/pipedog/commit/9f1ce7aea9ae80195d7ff8da0cb591f7910641ac)]:
  - @pipedog/asyncio@0.6.1
  - @pipedog/core@0.6.1

## 0.6.0

### Minor Changes

- [#36](https://github.com/polvallverdu/pipedog/pull/36) [`98919c3`](https://github.com/polvallverdu/pipedog/commit/98919c34382e301f1716d2aa2fbecebea909a40f) Thanks [@polvallverdu](https://github.com/polvallverdu)! - `@pipedog/aws`: AWS services, a port of Pipecat's `pipecat.services.aws`.
  
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

### Patch Changes

- Updated dependencies [[`b53032d`](https://github.com/polvallverdu/pipedog/commit/b53032d6a46103d5a1c1fd16b3b61dfd38a7bc2b), [`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db)]:
  - @pipedog/asyncio@0.6.0
  - @pipedog/core@0.6.0
