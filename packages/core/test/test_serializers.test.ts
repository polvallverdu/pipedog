// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_serializers.py

import { beforeEach, describe, expect, test } from "bun:test";
import {
  BusActivateWorkerMessage,
  BusCancelMessage,
  BusDataMessage,
  BusEndMessage,
  BusFrameMessage,
  BusJobRequestMessage,
  BusJobResponseMessage,
  BusMessage,
} from "../src/bus/messages.ts";
import { JSONMessageSerializer, registerSerializableType } from "../src/bus/serializers/json.ts";
import { TextFrame } from "../src/frames/frames.ts";
import { JobStatus } from "../src/pipeline/job_context.ts";
import { FrameDirection } from "../src/processors/frame_processor.ts";

// Pydantic `BaseModel`s -> plain classes with an options constructor.
class _Address {
  city: string;
  zipCode: string;

  constructor(options: { city: string; zipCode: string }) {
    this.city = options.city;
    this.zipCode = options.zipCode;
  }
}

class _UserInfo {
  name: string;
  age: number;
  address: _Address | null;

  constructor(options: { name: string; age: number; address?: _Address | null }) {
    this.name = options.name;
    this.age = options.age;
    this.address = options.address ?? null;
  }
}

class _MessageWithNonInit extends BusDataMessage {
  tag = "default";
}

// Upstream resolves these through `importlib` on the test module; in TS the
// serializer resolves types through its registry.
registerSerializableType("tests.test_serializers._Address", _Address);
registerSerializableType("tests.test_serializers._UserInfo", _UserInfo);
registerSerializableType("tests.test_serializers._MessageWithNonInit", _MessageWithNonInit);

describe("TestJSONMessageSerializer", () => {
  let serializer: JSONMessageSerializer;

  beforeEach(() => {
    serializer = new JSONMessageSerializer();
  });

  /** BusMessage serializes and deserializes correctly. */
  test("test_round_trip_simple_message", () => {
    const msg = new BusDataMessage({ source: "task_a", target: "task_b" });
    const data = serializer.serialize(msg);
    const restored = serializer.deserialize(data)!;

    expect(restored).toBeInstanceOf(BusMessage);
    expect(restored.source).toEqual("task_a");
    expect(restored.target).toEqual("task_b");
  });

  /** Broadcast message (no target) round-trips. */
  test("test_round_trip_broadcast_message", () => {
    const msg = new BusDataMessage({ source: "task_a" });
    const data = serializer.serialize(msg);
    const restored = serializer.deserialize(data)!;

    expect(restored).toBeInstanceOf(BusMessage);
    expect(restored.source).toEqual("task_a");
    expect(restored.target).toBeNull();
  });

  /** BusActivateWorkerMessage with args round-trips. */
  test("test_round_trip_activate_message", () => {
    const msg = new BusActivateWorkerMessage({
      source: "parent",
      target: "child",
      args: { messages: [{ role: "user", content: "hello" }] },
    });
    const data = serializer.serialize(msg);
    const restored = serializer.deserialize(data) as BusActivateWorkerMessage;

    expect(restored).toBeInstanceOf(BusActivateWorkerMessage);
    expect(restored.source).toEqual("parent");
    expect(restored.target).toEqual("child");
    const args = restored.args as { messages: { content: string }[] };
    expect(args.messages[0]!.content).toEqual("hello");
  });

  /** BusEndMessage round-trips. */
  test("test_round_trip_end_message", () => {
    const msg = new BusEndMessage({ source: "task_a", reason: "done" });
    const data = serializer.serialize(msg);
    const restored = serializer.deserialize(data) as BusEndMessage;

    expect(restored).toBeInstanceOf(BusEndMessage);
    expect(restored.reason).toEqual("done");
  });

  /** BusCancelMessage round-trips. */
  test("test_round_trip_cancel_message", () => {
    const msg = new BusCancelMessage({ source: "task_a", reason: "abort" });
    const data = serializer.serialize(msg);
    const restored = serializer.deserialize(data) as BusCancelMessage;

    expect(restored).toBeInstanceOf(BusCancelMessage);
    expect(restored.reason).toEqual("abort");
  });

  /** BusJobRequestMessage with payload round-trips. */
  test("test_round_trip_job_request", () => {
    const msg = new BusJobRequestMessage({
      source: "parent",
      target: "worker",
      jobId: "t-123",
      payload: { key: "value" },
    });
    const data = serializer.serialize(msg);
    const restored = serializer.deserialize(data) as BusJobRequestMessage;

    expect(restored).toBeInstanceOf(BusJobRequestMessage);
    expect(restored.jobId).toEqual("t-123");
    expect(restored.payload).toEqual({ key: "value" });
  });

  /** BusJobResponseMessage round-trips. */
  test("test_round_trip_job_response", () => {
    const msg = new BusJobResponseMessage({
      source: "worker",
      target: "parent",
      jobId: "t-123",
      status: JobStatus.COMPLETED,
      response: { result: 42 },
    });
    const data = serializer.serialize(msg);
    const restored = serializer.deserialize(data) as BusJobResponseMessage;

    expect(restored).toBeInstanceOf(BusJobResponseMessage);
    expect(restored.jobId).toEqual("t-123");
    expect(restored.response).toEqual({ result: 42 });
    expect(restored.status).toEqual(JobStatus.COMPLETED);
  });

  /** BusFrameMessage with TextFrame round-trips via adapter. */
  test("test_round_trip_frame_message", () => {
    const msg = new BusFrameMessage({
      source: "task_a",
      frame: new TextFrame({ text: "hello world" }),
      direction: FrameDirection.DOWNSTREAM,
    });
    const data = serializer.serialize(msg);
    const restored = serializer.deserialize(data) as BusFrameMessage;

    expect(restored).toBeInstanceOf(BusFrameMessage);
    expect(restored.frame).toBeInstanceOf(TextFrame);
    expect((restored.frame as TextFrame).text).toEqual("hello world");
    expect(restored.direction).toEqual(FrameDirection.DOWNSTREAM);
    expect(restored.source).toEqual("task_a");
  });

  /** UPSTREAM direction preserved in round-trip. */
  test("test_frame_message_upstream_direction", () => {
    const msg = new BusFrameMessage({
      source: "task_a",
      frame: new TextFrame({ text: "up" }),
      direction: FrameDirection.UPSTREAM,
    });
    const data = serializer.serialize(msg);
    const restored = serializer.deserialize(data) as BusFrameMessage;

    expect(restored.direction).toEqual(FrameDirection.UPSTREAM);
  });

  /** Serializing a frame with no adapter warns and skips the field. */
  test("test_unregistered_frame_warns_and_skips", () => {
    const serializer = new JSONMessageSerializer(); // no adapters registered

    const msg = new BusFrameMessage({
      source: "task_a",
      frame: new TextFrame({ text: "hello" }),
      direction: FrameDirection.DOWNSTREAM,
    });
    // Should not raise — unserializable field is skipped with a warning
    const data = serializer.serialize(msg);
    expect(data).toBeInstanceOf(Uint8Array);
  });

  /** Deserializing an unknown message type returns None. */
  test("test_unknown_message_type_returns_none", () => {
    const badData = new TextEncoder().encode(
      '{"__type__":"bogus.BogusMessage","__data__":{"source":"a"}}',
    );
    const result = serializer.deserialize(badData);
    expect(result).toBeNull();
  });

  /** serialize() returns bytes. */
  test("test_serialized_is_bytes", () => {
    const msg = new BusDataMessage({ source: "a" });
    const data = serializer.serialize(msg);
    expect(data).toBeInstanceOf(Uint8Array);
  });

  /** Adapter registered for a parent class handles subclasses. */
  test("test_adapter_mro_lookup", () => {
    class CustomTextFrame extends TextFrame {}

    const msg = new BusFrameMessage({
      source: "a",
      frame: new CustomTextFrame({ text: "sub" }),
      direction: FrameDirection.DOWNSTREAM,
    });
    // TextTypeAdapter is registered for TextFrame, should handle subclass
    const data = serializer.serialize(msg);
    expect(data).toBeInstanceOf(Uint8Array);
  });

  /** Pydantic BaseModel round-trips preserving the type. */
  test("test_round_trip_pydantic_base_model", () => {
    const msg = new BusJobResponseMessage({
      source: "worker",
      target: "parent",
      jobId: "t-456",
      status: JobStatus.COMPLETED,
      response: { user: new _UserInfo({ name: "Alice", age: 30 }) },
    });
    const data = serializer.serialize(msg);
    const restored = serializer.deserialize(data) as BusJobResponseMessage;

    expect(restored).toBeInstanceOf(BusJobResponseMessage);
    const user = restored.response!.user as _UserInfo;
    expect(user).toBeInstanceOf(_UserInfo);
    expect(user.name).toEqual("Alice");
    expect(user.age).toEqual(30);
  });

  /** Nested Pydantic BaseModels round-trip preserving types. */
  test("test_round_trip_nested_pydantic_base_model", () => {
    const user = new _UserInfo({
      name: "Alice",
      age: 30,
      address: new _Address({ city: "NYC", zipCode: "10001" }),
    });
    const msg = new BusJobResponseMessage({
      source: "worker",
      target: "parent",
      jobId: "t-789",
      status: JobStatus.COMPLETED,
      response: { user },
    });
    const data = serializer.serialize(msg);
    const restored = serializer.deserialize(data) as BusJobResponseMessage;

    expect(restored).toBeInstanceOf(BusJobResponseMessage);
    const restoredUser = restored.response!.user as _UserInfo;
    expect(restoredUser).toBeInstanceOf(_UserInfo);
    expect(restoredUser.address).toBeInstanceOf(_Address);
    expect(restoredUser.address!.city).toEqual("NYC");
    expect(restoredUser.address!.zipCode).toEqual("10001");
  });

  /** Non-init dataclass fields survive round-trip via setattr. */
  test("test_non_init_fields_preserved", () => {
    const msg = new _MessageWithNonInit({ source: "worker_a", target: "worker_b" });
    msg.tag = "custom_tag";

    const data = serializer.serialize(msg);
    const restored = serializer.deserialize(data) as _MessageWithNonInit;

    expect(restored.tag).toEqual("custom_tag");
  });
});
