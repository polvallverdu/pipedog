// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/image/azure.mdx. Type-checked on every docs build.

// #region usage
import { AzureImageGenServiceREST } from "@pipedog/azure/image";

const imageGen = new AzureImageGenServiceREST({
  apiKey: process.env.AZURE_OPENAI_API_KEY ?? "",
  // The resource endpoint, with its trailing slash.
  endpoint: "https://my-resource.openai.azure.com/",
  settings: new AzureImageGenServiceREST.Settings({ imageSize: "1024x1024" }),
});
// #endregion usage
