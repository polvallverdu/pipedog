// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/aws-sagemaker.mdx. Type-checked on every docs build.

// #region usage
import { SageMakerBidiClient } from "@pipedog/aws/sagemaker/bidi_client";

const client = new SageMakerBidiClient({
  endpointName: "my-deepgram-endpoint",
  region: "us-east-2",
  modelInvocationPath: "v1/listen",
  modelQueryString: "model=nova-3&language=en",
});

async function transcribe(audio: Uint8Array): Promise<void> {
  await client.startSession();
  await client.sendAudioChunk(audio);
  await client.sendJson({ type: "CloseStream" });
  while (client.isActive) {
    const event = await client.receiveResponse();
    if (event === null) break;
    const bytes = event.PayloadPart?.Bytes;
    if (bytes) console.log(new TextDecoder().decode(bytes));
  }
  await client.closeSession();
}
// #endregion usage
