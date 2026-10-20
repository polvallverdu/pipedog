// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_shared.py

/** Tests for the shared resource decorators. */

import { describe, expect, test } from "bun:test";

import { gather, gatherSettled, sleep } from "@pipedog/asyncio";

import { acquires, releases } from "../src/utils/shared.ts";

/** Stands in for a client an input and an output transport share. */
class _Client {
  setups = 0;
  cleanups = 0;
  joins = 0;
  leaves = 0;
  connected = false;
  seenConnected: boolean[] = [];

  async setup(delay = 0.05): Promise<void> {
    await sleep(delay);
    this.setups += 1;
    this.connected = true;
  }

  async cleanup(): Promise<void> {
    this.cleanups += 1;
    this.connected = false;
  }

  async join(): Promise<string | null> {
    this.joins += 1;
    return "joined";
  }

  async leave(): Promise<void> {
    this.leaves += 1;
  }

  /** Set up as one of several owners, recording what it then sees. */
  async ownerSetup(): Promise<void> {
    await this.setup();
    this.seenConnected.push(this.connected);
  }

  static {
    _Client.prototype.setup = acquires("client")(_Client.prototype.setup) as _Client["setup"];
    _Client.prototype.cleanup = releases("client")(_Client.prototype.cleanup);
    _Client.prototype.join = acquires("room")(_Client.prototype.join);
    _Client.prototype.leave = releases("room")(_Client.prototype.leave);
  }
}

/** Stands in for a shared client that cannot be built. */
class _FailingClient {
  setups = 0;
  cleanups = 0;

  async setup(delay = 0.05): Promise<void> {
    await sleep(delay);
    this.setups += 1;
    throw new Error("could not connect");
  }

  async cleanup(): Promise<void> {
    this.cleanups += 1;
  }

  static {
    _FailingClient.prototype.setup = acquires("client")(
      _FailingClient.prototype.setup,
    ) as _FailingClient["setup"];
    _FailingClient.prototype.cleanup = releases("client")(_FailingClient.prototype.cleanup);
  }
}

describe("TestSharedResource", () => {
  test("test_only_the_first_owner_runs_the_body", async () => {
    const client = new _Client();

    await gather(client.setup(), client.setup(), client.setup());

    expect(client.setups).toEqual(1);
  });

  test("test_later_owners_wait_for_the_first", async () => {
    // A caller must not continue against a half-built resource.
    //
    // Processors are set up concurrently, so an owner can arrive while
    // another is still setting the resource up.
    const client = new _Client();

    await gather(client.ownerSetup(), client.ownerSetup());

    expect(client.seenConnected).toEqual([true, true]);
  });

  test("test_only_the_last_owner_undoes_it", async () => {
    const client = new _Client();
    await gather(client.setup(), client.setup());

    await client.cleanup();
    // the first owner leaving must not tear down
    expect(client.cleanups).toEqual(0);

    await client.cleanup();
    expect(client.cleanups).toEqual(1);
    expect(client.connected).toBe(false);
  });

  test("test_release_without_acquire_does_nothing", async () => {
    const client = new _Client();

    await client.cleanup();
    await client.cleanup();

    expect(client.cleanups).toEqual(0);
  });

  test("test_resources_are_counted_separately", async () => {
    // setup/cleanup and join/leave are independent on the same object.
    const client = new _Client();
    await gather(client.setup(), client.setup());

    await gather(client.join(), client.join());
    await client.leave();

    expect(client.joins).toEqual(1);
    // one owner still holds the room
    expect(client.leaves).toEqual(0);
    // releasing a room must not clean up the client
    expect(client.cleanups).toEqual(0);

    await client.leave();
    expect(client.leaves).toEqual(1);
  });

  test("test_instances_count_their_own_owners", async () => {
    const first = new _Client();
    const second = new _Client();

    await gather(first.setup(), first.setup());
    await second.setup();

    expect(first.setups).toEqual(1);
    expect(second.setups).toEqual(1);
  });

  test("test_first_owner_gets_the_return_value", async () => {
    const client = new _Client();

    expect(await client.join()).toEqual("joined");
    expect(await client.join()).toBeNull();
  });

  test("test_acquiring_again_after_release_runs_the_body", async () => {
    const client = new _Client();

    await client.setup();
    await client.cleanup();
    await client.setup();

    expect(client.setups).toEqual(2);
    expect(client.connected).toBe(true);
  });

  test("test_every_owner_of_a_resource_that_failed_is_told", async () => {
    // A sibling that carried on regardless would run against nothing.
    const client = new _FailingClient();

    await expect(client.setup()).rejects.toThrow(Error);
    await expect(client.setup()).rejects.toThrow(Error);
  });

  test("test_a_body_that_fails_is_not_attempted_again", async () => {
    const client = new _FailingClient();

    for (let i = 0; i < 2; i++) {
      await expect(client.setup()).rejects.toThrow(Error);
    }

    expect(client.setups).toEqual(1);
  });

  test("test_concurrent_owners_of_a_failed_resource_all_fail", async () => {
    const client = new _FailingClient();

    const results = await gatherSettled(client.setup(), client.setup());

    expect(client.setups).toEqual(1);
    expect(results.every((r) => r instanceof Error)).toBe(true);
  });

  test("test_nothing_is_released_when_acquiring_failed", async () => {
    // The undo would otherwise run against a resource that was never built.
    const client = new _FailingClient();

    await expect(client.setup()).rejects.toThrow(Error);
    await client.cleanup();

    expect(client.cleanups).toEqual(0);
  });
});
