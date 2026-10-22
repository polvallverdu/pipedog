// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Configuration (c), SDKs passed in: this file imports the Google Cloud SDKs, so the
// bundler includes them (grpc-js, google-gax and their protos are about 4 MB), and hands
// the modules to the services. Nothing is needed next to the bundle.

import * as speechModule from "@google-cloud/speech";
import * as textToSpeechModule from "@google-cloud/text-to-speech";
import * as grpc from "@grpc/grpc-js";
import { checkGoogle } from "./google_check.ts";

await checkGoogle(grpc, { speechModule, textToSpeechModule });
