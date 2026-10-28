# @pipedog/aws

AWS services for pipedog:

- `AWSBedrockLLMService`: Bedrock models through the Converse API, with `AWSBedrockLLMAdapter`.
- `AWSTranscribeSTTService`: streaming speech-to-text from Amazon Transcribe.
- `AWSPollyTTSService`: text-to-speech from Amazon Polly.
- `AWSNovaSonicLLMService`: Amazon Nova Sonic speech-to-speech.
- `AWSAgentCoreProcessor`: an agent on Bedrock AgentCore Runtime, used in place of an LLM.
- `SageMakerBidiClient`: bidirectional streaming to models on SageMaker endpoints.

Most of them call AWS with `fetch` and `WebSocket`, signing requests with SigV4 on WebCrypto, so
no AWS SDK is needed.

A port of Pipecat's `pipecat.services.aws`, `pipecat.adapters.llm.services.bedrock_adapter` and
`pipecat.adapters.llm.services.aws_nova_sonic_adapter`. Subpaths mirror upstream:
`@pipedog/aws/llm`, `/stt`, `/tts`, `/agent_core`, `/nova_sonic/llm`,
`/sagemaker/bidi_client`, `/bedrock_adapter`, `/aws_nova_sonic_adapter` and `/utils`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/aws
```

Two classes can use an AWS SDK client, both optional peer dependencies:

```sh
bun add @aws-sdk/client-sagemaker-runtime-http2  # SageMakerBidiClient (always)
bun add @aws-sdk/client-bedrock-runtime          # AWSNovaSonicLLMService with transport: "http2"
```

## Usage

```ts
import { AWSBedrockLLMService } from "@pipedog/aws/llm";
import { AWSTranscribeSTTService } from "@pipedog/aws/stt";
import { AWSPollyTTSService } from "@pipedog/aws/tts";

// Keys come from the options or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
// AWS_SESSION_TOKEN / AWS_REGION.
const stt = new AWSTranscribeSTTService({ region: "us-east-1" });
const llm = new AWSBedrockLLMService({
  awsRegion: "us-east-1",
  settings: new AWSBedrockLLMService.Settings({
    model: "us.amazon.nova-lite-v1:0",
    systemInstruction: "You are a helpful voice assistant. Keep replies short.",
  }),
});
const tts = new AWSPollyTTSService({ region: "us-east-1" });
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

### Credentials

Keys are read, in order, from the service's options, the environment, and a
`credentialsProvider` function. The provider is called for every request or connection, so it
can renew temporary credentials, for example `fromNodeProviderChain()` from
`@aws-sdk/credential-providers` (Node only). There is no built-in default credential chain
(profiles, instance metadata, ECS roles, SSO).

## Runtimes

| | Bun | Node ≥ 22 | Deno 2 | Cloudflare Workers |
|---|---|---|---|---|
| `AWSBedrockLLMService` | ✅ | ✅ | ✅ | ✅ |
| `AWSTranscribeSTTService` | ✅ | ✅ | ✅ | ✅ |
| `AWSPollyTTSService` | ✅ | ✅ | ✅ | ✅ |
| `AWSAgentCoreProcessor` | ✅ | ✅ | ✅ | ✅ |
| `AWSNovaSonicLLMService` (WebSocket, default) | ✅ | ✅ | ✅ | ✅ |
| `AWSNovaSonicLLMService` (`transport: "http2"`) | ✅ | ✅ | untested | ❌ (HTTP/2 duplex) |
| `SageMakerBidiClient` | ✅ | ✅ | untested | ❌ (HTTP/2 duplex) |

Nova Sonic uses Bedrock's WebSocket endpoint for `InvokeModelWithBidirectionalStream` (the one
the AWS SDK uses in browsers), with SigV4-presigned URLs and signed events, so it runs everywhere.
SageMaker's `InvokeEndpointWithBidirectionalStream` has no WebSocket endpoint and needs a
full-duplex HTTP/2 stream, which `fetch` cannot provide and Workers do not offer. The SDK
clients are loaded lazily, so importing the package works on Workers. Both classes accept an
injected client, so you can supply another transport.

`compat/smoke.ts` runs Bedrock, Polly and AgentCore against in-process fake `fetch` functions on
every runtime, checks SigV4 against an AWS test vector, and constructs the other classes.

## Links

- Docs: [Bedrock](https://polvallverdu.github.io/pipedog/docs/services/llm/aws/),
  [AgentCore](https://polvallverdu.github.io/pipedog/docs/services/llm/aws-agentcore/),
  [Transcribe](https://polvallverdu.github.io/pipedog/docs/services/stt/aws/),
  [Polly](https://polvallverdu.github.io/pipedog/docs/services/tts/aws/),
  [Nova Sonic](https://polvallverdu.github.io/pipedog/docs/services/s2s/aws/),
  [SageMaker](https://polvallverdu.github.io/pipedog/docs/services/stt/aws-sagemaker/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
