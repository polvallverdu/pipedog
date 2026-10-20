// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/bus/serializers/__init__.py

/**
 * Bus message serialization for network transport.
 *
 * Provides the abstract `MessageSerializer` interface and a default
 * `JSONMessageSerializer` implementation.
 */

export { MessageSerializer } from "./base.ts";
export { JSONMessageSerializer } from "./json.ts";
