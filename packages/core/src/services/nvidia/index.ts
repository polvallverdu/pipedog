// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/nvidia/__init__.py

// Upstream sets GRPC_VERBOSITY=ERROR in the process environment (unless the
// user configured it) to silence gRPC C-core logging. There is no gRPC C-core
// in JS runtimes and core cannot touch the process environment, so nothing is
// done here.

export {};
