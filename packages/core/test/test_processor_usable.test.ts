// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_processor_usable.py

import { describe, expect, test } from "bun:test";
import { Event, TimeoutError, waitFor } from "@pipecat-ts/asyncio";

import { ErrorFrame, type Frame, TextFrame } from "../src/frames/frames.ts";
import { type FrameDirection, FrameProcessor } from "../src/processors/frame_processor.ts";
import { AIService, type AIServiceOptions } from "../src/services/ai_service.ts";
import { ServiceSettings } from "../src/services/settings.ts";
import { runTest } from "../src/tests/utils.ts";
import {
  classifyHttpException,
  classifyHttpStatusCode,
  ErrorCategory,
  extractHttpStatusCode,
} from "../src/utils/errors.ts";

/**
 * Stands in for `websockets.exceptions.InvalidStatus`, the exception
 * `websockets` raises when a handshake is rejected: it carries the HTTP
 * response with its status code.
 */
class InvalidStatus extends Error {
  response: { status_code: number };

  constructor(response: { status_code: number }) {
    super(`server rejected WebSocket connection: HTTP ${response.status_code}`);
    this.name = "InvalidStatus";
    this.response = response;
  }
}

/** Build the exception `websockets` raises when a handshake is rejected. */
function websocketRejection(statusCode: number): InvalidStatus {
  return new InvalidStatus({ status_code: statusCode });
}

/** Stands in for Python's `ValueError`. */
class ValueError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "ValueError";
  }
}

/** Test access to protected members, as the Python test reads them. */
const internals = (s: AIService): any => s;

interface ReportingServiceOptions extends AIServiceOptions {
  exception?: unknown;
}

/** Service that reports a given exception whenever it sees a `TextFrame`. */
class ReportingService extends AIService {
  protected _exception: unknown;

  constructor(options: ReportingServiceOptions = {}) {
    super(options);
    this._exception = options.exception ?? null;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof TextFrame) {
      await this.pushError("service failed", { exception: this._exception });
    } else {
      await this.pushFrame(frame, direction);
    }
  }
}

describe("TestErrorClassification", () => {
  test("test_status_codes_map_to_categories", () => {
    expect(classifyHttpStatusCode(400)).toBe(ErrorCategory.INVALID_REQUEST);
    expect(classifyHttpStatusCode(401)).toBe(ErrorCategory.AUTHENTICATION);
    expect(classifyHttpStatusCode(402)).toBe(ErrorCategory.QUOTA);
    expect(classifyHttpStatusCode(403)).toBe(ErrorCategory.AUTHORIZATION);
    expect(classifyHttpStatusCode(404)).toBe(ErrorCategory.INVALID_REQUEST);
    expect(classifyHttpStatusCode(422)).toBe(ErrorCategory.INVALID_REQUEST);
    expect(classifyHttpStatusCode(429)).toBe(ErrorCategory.RATE_LIMIT);
  });

  test("test_server_errors_map_to_server_category", () => {
    for (const statusCode of [500, 502, 503, 599]) {
      expect(classifyHttpStatusCode(statusCode)).toBe(ErrorCategory.SERVER);
    }
  });

  test("test_unremarkable_status_codes_are_unknown", () => {
    for (const statusCode of [200, 301, 418, 600]) {
      expect(classifyHttpStatusCode(statusCode)).toBe(ErrorCategory.UNKNOWN);
    }
  });

  test("test_extracts_status_code_from_websocket_rejection", () => {
    expect(extractHttpStatusCode(websocketRejection(401))).toBe(401);
  });

  test("test_extracts_status_code_from_attribute_shapes", () => {
    // httpx-style: exception.response.status_code
    expect(extractHttpStatusCode({ response: { status_code: 403 } })).toBe(403);
    // aiohttp-style: exception.response.status
    expect(extractHttpStatusCode({ response: { status: 429 } })).toBe(429);
    // SDK-style: the code directly on the exception
    expect(extractHttpStatusCode({ status_code: 500 })).toBe(500);
    expect(extractHttpStatusCode({ status: 404 })).toBe(404);
  });

  test("test_exceptions_without_a_status_code", () => {
    expect(extractHttpStatusCode(new ValueError("nope"))).toBeNull();
    expect(classifyHttpException(new ValueError("nope"))).toBe(ErrorCategory.UNKNOWN);
  });

  test("test_connectivity_exceptions", () => {
    // Python's `ConnectionError()`: in JS, a connection failure carries an error code.
    const connectionError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    expect(classifyHttpException(connectionError)).toBe(ErrorCategory.CONNECTIVITY);
    expect(classifyHttpException(new TimeoutError())).toBe(ErrorCategory.CONNECTIVITY);
    // Python's bare `OSError()`.
    expect(classifyHttpException(new Error())).toBe(ErrorCategory.UNKNOWN);
  });

  test("test_permanent_categories", () => {
    for (const category of [
      ErrorCategory.AUTHENTICATION,
      ErrorCategory.AUTHORIZATION,
      ErrorCategory.INVALID_REQUEST,
    ]) {
      expect(category.isPermanent).toBe(true);
    }

    for (const category of [
      ErrorCategory.UNKNOWN,
      ErrorCategory.RATE_LIMIT,
      ErrorCategory.QUOTA,
      ErrorCategory.CONNECTIVITY,
      ErrorCategory.SERVER,
    ]) {
      expect(category.isPermanent).toBe(false);
    }
  });
});

describe("TestErrorFrame", () => {
  test("test_category_starts_unset", () => {
    // Unset invites whoever reports the error to work the cause out.
    expect(new ErrorFrame({ error: "boom" }).category).toBeNull();
  });

  test("test_str_omits_an_unset_category", () => {
    expect(String(new ErrorFrame({ error: "boom" }))).not.toContain("category");
  });

  test("test_str_omits_an_unknown_category", () => {
    expect(
      String(new ErrorFrame({ error: "boom", category: ErrorCategory.UNKNOWN })),
    ).not.toContain("category");
  });

  test("test_str_includes_known_category", () => {
    const frame = new ErrorFrame({ error: "boom", category: ErrorCategory.AUTHENTICATION });
    expect(String(frame)).toContain("category: authentication");
  });
});

describe("TestProcessorUsable", () => {
  test("test_processors_start_usable", async () => {
    expect(new ReportingService().isUsable).toBe(true);
  });

  test("test_service_specific_classification_can_keep_a_service_usable", async () => {
    class RefreshingCredentialsService extends ReportingService {
      protected override _classifyError(_exception: unknown): ErrorCategory | null {
        return ErrorCategory.CONNECTIVITY;
      }
    }

    const service = new RefreshingCredentialsService({ exception: websocketRejection(401) });

    const [, up] = await runTest(service, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: [],
      expectedUpFrames: [ErrorFrame],
    });

    expect((up[0] as ErrorFrame).category).toBe(ErrorCategory.CONNECTIVITY);
    expect(service.isUsable).toBe(true);
  });

  test("test_rejected_credentials_make_the_service_unusable", async () => {
    const service = new ReportingService({ exception: websocketRejection(401) });

    const [, up] = await runTest(service, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: [],
      expectedUpFrames: [ErrorFrame],
    });

    expect((up[0] as ErrorFrame).category).toBe(ErrorCategory.AUTHENTICATION);
    expect(service.isUsable).toBe(false);
  });

  test("test_server_errors_leave_the_service_usable", async () => {
    const service = new ReportingService({ exception: websocketRejection(503) });

    const [, up] = await runTest(service, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: [],
      expectedUpFrames: [ErrorFrame],
    });

    expect((up[0] as ErrorFrame).category).toBe(ErrorCategory.SERVER);
    expect(service.isUsable).toBe(true);
  });

  test("test_unclassifiable_exceptions_leave_the_service_usable", async () => {
    const service = new ReportingService({ exception: new ValueError("nope") });

    const [, up] = await runTest(service, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: [],
      expectedUpFrames: [ErrorFrame],
    });

    expect((up[0] as ErrorFrame).category).toBe(ErrorCategory.UNKNOWN);
    expect(service.isUsable).toBe(true);
  });

  test("test_errors_without_an_exception_are_not_classified", async () => {
    const service = new ReportingService();

    const [, up] = await runTest(service, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: [],
      expectedUpFrames: [ErrorFrame],
    });

    expect((up[0] as ErrorFrame).category).toBe(ErrorCategory.UNKNOWN);
    expect(service.isUsable).toBe(true);
  });

  test("test_service_specific_classification_takes_precedence", async () => {
    class ProviderService extends ReportingService {
      protected override _classifyError(_exception: unknown): ErrorCategory | null {
        return ErrorCategory.AUTHORIZATION;
      }
    }

    const service = new ProviderService({ exception: websocketRejection(503) });

    const [, up] = await runTest(service, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: [],
      expectedUpFrames: [ErrorFrame],
    });

    expect((up[0] as ErrorFrame).category).toBe(ErrorCategory.AUTHORIZATION);
    expect(service.isUsable).toBe(false);
  });

  test("test_explicit_category_needs_no_opt_in", async () => {
    class ExplicitService extends ReportingService {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await AIService.prototype.processFrame.call(this, frame, direction);

        if (frame instanceof TextFrame) {
          await this.pushError("bad key", { category: ErrorCategory.AUTHENTICATION });
        } else {
          await this.pushFrame(frame, direction);
        }
      }
    }

    const service = new ExplicitService();

    const [, up] = await runTest(service, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: [],
      expectedUpFrames: [ErrorFrame],
    });

    expect((up[0] as ErrorFrame).category).toBe(ErrorCategory.AUTHENTICATION);
    expect(service.isUsable).toBe(false);
  });

  test("test_an_error_reported_as_terminal_needs_no_category", async () => {
    class SpentService extends ReportingService {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await AIService.prototype.processFrame.call(this, frame, direction);

        if (frame instanceof TextFrame) {
          await this.pushError("gave up retrying", { forceTreatAsPermanent: true });
        } else {
          await this.pushFrame(frame, direction);
        }
      }
    }

    const service = new SpentService();

    const [, up] = await runTest(service, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: [],
      expectedUpFrames: [ErrorFrame],
    });

    // Nothing is misconfigured; the service just ran out of attempts.
    expect((up[0] as ErrorFrame).category).toBe(ErrorCategory.UNKNOWN);
    expect(service.isUsable).toBe(false);
  });

  test("test_the_verdict_is_in_before_the_error_travels", async () => {
    const service = new ReportingService({ exception: websocketRejection(401) });
    const seen: boolean[] = [];

    service.eventHandler("on_error", async (_service: ReportingService, frame: ErrorFrame) => {
      seen.push((frame.processor as FrameProcessor).isUsable);
    });

    await runTest(service, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: [],
      expectedUpFrames: [ErrorFrame],
    });

    expect(seen).toEqual([false]);
  });

  test("test_becoming_unusable_notifies_listeners", async () => {
    const service = new ReportingService({ exception: websocketRejection(401) });
    const changed = new Event();
    const transitions: boolean[] = [];

    service.eventHandler(
      "on_usable_changed",
      async (_service: ReportingService, isUsable: boolean) => {
        transitions.push(isUsable);
        changed.set();
      },
    );

    await runTest(service, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: [],
      expectedUpFrames: [ErrorFrame],
    });

    await waitFor(() => changed.wait(), 5);

    expect(transitions).toEqual([false]);
  });

  test("test_repeated_errors_notify_once", async () => {
    const service = new ReportingService({ exception: websocketRejection(401) });
    const transitions: boolean[] = [];

    service.eventHandler(
      "on_usable_changed",
      async (_service: ReportingService, isUsable: boolean) => {
        transitions.push(isUsable);
      },
    );

    await runTest(service, {
      framesToSend: [
        new TextFrame({ text: "one" }),
        new TextFrame({ text: "two" }),
        new TextFrame({ text: "three" }),
      ],
      expectedDownFrames: [],
      expectedUpFrames: [ErrorFrame, ErrorFrame, ErrorFrame],
    });

    expect(transitions.length).toBe(1);
  });

  test("test_updated_settings_give_the_service_another_chance", async () => {
    const service = new ReportingService({ exception: websocketRejection(401) });
    await service.setUsable(false);

    await internals(service)._updateSettings(new ServiceSettings({ model: "another-model" }));

    expect(service.isUsable).toBe(true);
  });

  test("test_unchanged_settings_leave_the_service_alone", async () => {
    const service = new ReportingService({ exception: websocketRejection(401) });
    await service.setUsable(false);

    await internals(service)._updateSettings(new ServiceSettings());

    expect(service.isUsable).toBe(false);
  });
});

/** Usability belongs to every processor, not just to services. */
describe("TestPlainProcessorUsable", () => {
  test("test_a_plain_processor_becomes_unusable", async () => {
    class FailingProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);

        if (frame instanceof TextFrame) {
          await this.pushError("out of attempts", { forceTreatAsPermanent: true });
        } else {
          await this.pushFrame(frame, direction);
        }
      }
    }

    const processor = new FailingProcessor();

    await runTest(processor, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: [],
      expectedUpFrames: [ErrorFrame],
    });

    expect(processor.isUsable).toBe(false);
  });

  /**
   * Test that a processor overriding `pushErrorFrame` needs no new argument.
   *
   * The verdict is only worth passing on when there is one, so reporting an
   * error that leaves the processor working stays a one-argument call.
   */
  test("test_reporting_an_ordinary_error_passes_only_the_frame", async () => {
    const received: ErrorFrame[] = [];

    class NarrowProcessor extends FrameProcessor {
      override async pushErrorFrame(error: ErrorFrame): Promise<void> {
        received.push(error);
      }
    }

    const processor = new NarrowProcessor();

    await processor.pushError("something went wrong");

    expect(received.length).toBe(1);
  });

  test("test_a_processor_can_be_brought_back", async () => {
    const processor = new FrameProcessor();
    await processor.setUsable(false);

    await processor.setUsable(true);

    expect(processor.isUsable).toBe(true);
  });
});

interface ExplodingServiceOptions extends AIServiceOptions {
  exception: unknown;
}

/** Service whose frame processing raises before it can report anything. */
class ExplodingService extends AIService {
  protected _exception: unknown;

  constructor(options: ExplodingServiceOptions) {
    super(options);
    this._exception = options.exception;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof TextFrame) {
      throw this._exception;
    }

    await this.pushFrame(frame, direction);
  }
}

/** Errors caught by a broad `except` may not have come from the provider. */
describe("TestUnattributableErrors", () => {
  test("test_an_uncaught_exception_is_not_classified", async () => {
    // The exception carries a 401, but the frame-processing catch-all has
    // no idea where it came from — a downstream processor, an observer, or
    // the service itself.
    const service = new ExplodingService({ exception: websocketRejection(401) });

    const [, up] = await runTest(service, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: [],
      expectedUpFrames: [ErrorFrame],
    });

    expect((up[0] as ErrorFrame).category).toBe(ErrorCategory.UNKNOWN);
    expect(service.isUsable).toBe(true);
  });

  test("test_errors_always_reach_handlers_with_a_category", async () => {
    // Nothing reports a category here, so the push settles it.
    const service = new ExplodingService({ exception: new ValueError("boom") });

    const [, up] = await runTest(service, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: [],
      expectedUpFrames: [ErrorFrame],
    });

    expect((up[0] as ErrorFrame).category).not.toBeNull();
  });
});
