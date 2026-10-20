// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_base_worker.py

import { beforeEach, describe, expect, test } from "bun:test";
import {
  CancelledError,
  Event,
  gather,
  monotonic,
  sleep,
  type Task,
  waitFor,
} from "@pipedog/asyncio";
import {
  AsyncQueueBus,
  BusActivateWorkerMessage,
  BusAddWorkerMessage,
  BusBridgeProcessor,
  BusCancelMessage,
  BusCancelWorkerMessage,
  BusDeactivateWorkerMessage,
  BusEndMessage,
  BusEndWorkerMessage,
  BusFrameMessage,
  BusJobCancelMessage,
  BusJobRequestMessage,
  BusJobResponseMessage,
  BusJobStreamDataMessage,
  BusJobStreamEndMessage,
  BusJobStreamStartMessage,
  BusJobUpdateMessage,
  type BusMessage,
  BusTTSSpeakMessage,
} from "../src/bus/index.ts";
import { BusSubscriber } from "../src/bus/subscriber.ts";
import { EndFrame, type Frame, TextFrame, TTSSpeakFrame } from "../src/frames/frames.ts";
import {
  JobGroupParams,
  type JobGroupResponse,
  JobParams,
  JobStatus,
} from "../src/pipeline/job_context.ts";
import { job } from "../src/pipeline/job_decorator.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { PipelineWorker } from "../src/pipeline/worker.ts";
import { IdentityFilter } from "../src/processors/filters/identity_filter.ts";
import { FrameDirection, FrameProcessor } from "../src/processors/frame_processor.ts";
import { WorkerRegistry } from "../src/registry/index.ts";
import { WorkerReadyData } from "../src/registry/types.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";
import { BaseWorker } from "../src/workers/base_worker.ts";
import { WorkerRunner } from "../src/workers/runner.ts";

/** Generates a new TextFrame for each input TextFrame. */
class _FrameGenerator extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof TextFrame) {
      await this.pushFrame(new TextFrame({ text: `generated_${frame.text}` }), direction);
    } else {
      await this.pushFrame(frame, direction);
    }
  }
}

/** Create an AsyncQueueBus with a TaskManager for testing. */
async function createTestBus(): Promise<[AsyncQueueBus, TaskManager]> {
  const bus = new AsyncQueueBus();
  const tm = new TaskManager();
  await bus.setup(tm);
  return [bus, tm];
}

/** Create a registry for testing worker lifecycle. */
function createTestRegistry(): WorkerRegistry {
  return new WorkerRegistry("test-runner");
}

/** Pre-register worker names so the ready-wait completes immediately. */
async function registerTasks(registry: WorkerRegistry, ...names: string[]): Promise<void> {
  for (const name of names) {
    await registry.register(new WorkerReadyData({ workerName: name, runner: "test-runner" }));
  }
}

/** Monkey-patch bus.send to capture sent messages in a list. */
function captureBus(bus: AsyncQueueBus): BusMessage[] {
  const sent: BusMessage[] = [];
  const originalSend = bus.send.bind(bus);

  bus.send = async (message: BusMessage) => {
    sent.push(message);
    await originalSend(message);
  };
  return sent;
}

/**
 * Create a PipelineWorker with an IdentityFilter pipeline.
 *
 * Answers its own flush probes even when bridged: these workers have no
 * transport peer to answer for them, so leaving it off would make every
 * drain wait out its timeout.
 */
function makeStubPipelineTask(
  name: string,
  options: { bridged?: readonly string[] | null; active?: boolean } = {},
): PipelineWorker {
  return new PipelineWorker(new Pipeline([new IdentityFilter()]), {
    name,
    bridged: options.bridged ?? null,
    cancelOnIdleTimeout: false,
    handleFlushFrame: true,
  });
}

/** Records the peer worker it can reach through its runner. */
class _RunnerProbe extends FrameProcessor {
  protected _peerName: string;
  peer: BaseWorker | null = null;

  constructor(peerName: string) {
    super();
    this._peerName = peerName;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (this.peer === null) {
      this.peer = this.workerRunner.getWorker(this._peerName);
    }
    await this.pushFrame(frame, direction);
  }
}

/** Protected/private state the upstream tests reach into directly. */
interface WorkerInternals {
  _active: boolean;
  _pendingActivation: boolean;
  _finishedEvent: Event;
  _foreignProbes: Map<number, string>;
  _jobHandlerTasks: Map<string, Task<unknown>>;
}

function internals(worker: BaseWorker): WorkerInternals {
  return worker as unknown as WorkerInternals;
}

function newWorker(name: string, options: { active?: boolean } = {}): BaseWorker {
  return new BaseWorker({ name, ...options });
}

describe("TestWorkerRunnerAccess", () => {
  // Reaching a runner's workers by name.
  let bus: AsyncQueueBus;

  beforeEach(async () => {
    [bus] = await createTestBus();
  });

  test("test_get_worker_returns_added_worker", async () => {
    const helper = newWorker("helper");
    const runner = new WorkerRunner({ bus, handleSigint: false });
    await runner.addWorkers(helper);

    expect(runner.getWorker("helper")).toBe(helper);
  });

  test("test_get_worker_is_none_for_unknown_name", async () => {
    // A worker on another runner has no local instance, same as an unknown name.
    const runner = new WorkerRunner({ bus, handleSigint: false });

    expect(runner.getWorker("elsewhere")).toBeNull();
  });

  test("test_added_worker_reaches_its_runner", async () => {
    const helper = newWorker("helper");
    const runner = new WorkerRunner({ bus, handleSigint: false });
    await runner.addWorkers(helper);

    expect(helper.workerRunner).toBe(runner);
  });

  test("test_worker_runner_raises_before_attach", async () => {
    expect(() => newWorker("helper").workerRunner).toThrow(Error);
  });

  test("test_processor_reaches_a_peer_worker", async () => {
    // A processor finds a peer by name without the app handing it over.
    const helper = newWorker("helper");
    const probe = new _RunnerProbe("helper");
    const worker = new PipelineWorker(new Pipeline([probe]), {
      name: "main",
      cancelOnIdleTimeout: false,
    });

    const runner = new WorkerRunner({ bus, handleSigint: false });
    await runner.addWorkers(worker, helper);

    const endAfterStart = async () => {
      await sleep(0.05);
      await worker.queueFrame(new EndFrame());
      await sleep(0.05);
      await runner.end();
    };

    await waitFor(
      () =>
        gather(
          () => runner.run(),
          () => endAfterStart(),
        ),
      10.0,
    );

    expect(probe.peer).toBe(helper);
  });
});

describe("TestInactiveWorkerGating", () => {
  // What an inactive worker is and is not handed off the bus.
  let bus: AsyncQueueBus;
  let tm: TaskManager;
  let registry: WorkerRegistry;
  let runner: WorkerRunner;

  beforeEach(async () => {
    [bus, tm] = await createTestBus();
    registry = createTestRegistry();
    runner = new WorkerRunner({ bus, handleSigint: false });
  });

  async function _worker(options: { active: boolean }): Promise<BaseWorker> {
    const worker = newWorker("gated", { active: options.active });
    await worker.attach({ registry, bus, workerRunner: runner });
    await worker.setup(tm);
    return worker;
  }

  test("test_inactive_worker_never_sees_a_job_request", async () => {
    // End to end: the bus drops it, so no handler runs.
    const worker = await _worker({ active: false });
    const handled: BusJobRequestMessage[] = [];

    worker.onJobRequest = async (message: BusJobRequestMessage) => {
      handled.push(message);
    };
    await bus.start();

    await bus.send(new BusJobRequestMessage({ source: "other", target: "gated", jobId: "j1" }));
    await sleep(0.05);

    expect(handled).toEqual([]);
  });

  test("test_active_worker_sees_a_job_request", async () => {
    const worker = await _worker({ active: true });
    const handled: BusJobRequestMessage[] = [];

    worker.onJobRequest = async (message: BusJobRequestMessage) => {
      handled.push(message);
    };
    await bus.start();

    await bus.send(new BusJobRequestMessage({ source: "other", target: "gated", jobId: "j1" }));
    await sleep(0.05);

    expect(handled.length).toEqual(1);
  });

  test("test_handing_over_still_deactivates_the_worker_that_left", async () => {
    // `deactivateSelf: true` clears the flag before sending the message.
    //
    // The worker is inactive by the time its own deactivation arrives, so
    // gating that message would leave `onDeactivated` unrun.
    const deactivated: string[] = [];

    class Probe extends BaseWorker {
      override async onDeactivated(): Promise<void> {
        deactivated.push(this.name);
        await super.onDeactivated();
      }
    }

    const leaving = new Probe({ name: "leaving" });
    const takingOver = new Probe({ name: "taking-over" });
    const runner = new WorkerRunner({ bus, handleSigint: false });
    await runner.addWorkers(leaving, takingOver);
    await leaving.setup(tm);
    await takingOver.setup(tm);
    await bus.start();

    await leaving.activateWorker("taking-over", { deactivateSelf: true });
    await sleep(0.05);

    expect(deactivated).toEqual(["leaving"]);
  });

  test("test_inactive_worker_still_takes_activation_and_shutdown", async () => {
    // Otherwise nothing could start it, and nothing could stop it.
    const worker = await _worker({ active: false });

    for (const message of [
      new BusActivateWorkerMessage({ source: "other", target: "gated" }),
      new BusEndWorkerMessage({ source: "other", target: "gated" }),
      new BusCancelWorkerMessage({ source: "other", target: "gated" }),
    ]) {
      // subTest(message=type(message).__name__)
      expect(worker.acceptsBusMessage(message)).toBe(true);
    }
  });

  test("test_activation_over_the_bus_opens_the_gate", async () => {
    const worker = await _worker({ active: false });
    await worker.start();

    await worker.onBusMessage(new BusActivateWorkerMessage({ source: "other", target: "gated" }));

    expect(worker.active).toBe(true);
    expect(
      worker.acceptsBusMessage(
        new BusJobRequestMessage({ source: "other", target: "gated", jobId: "j1" }),
      ),
    ).toBe(true);
  });

  test("test_deactivation_closes_it_again", async () => {
    const worker = await _worker({ active: true });
    await worker.start();

    await worker.onBusMessage(new BusDeactivateWorkerMessage({ source: "other", target: "gated" }));

    expect(worker.active).toBe(false);
    expect(
      worker.acceptsBusMessage(
        new BusJobRequestMessage({ source: "other", target: "gated", jobId: "j1" }),
      ),
    ).toBe(false);
  });

  test("test_a_plain_subscriber_is_never_gated", async () => {
    // Observation is its own subscription, so it sees everything.
    const seen: BusMessage[] = [];

    class Observer extends BusSubscriber(class {}) {
      get name(): string {
        return "observer";
      }

      override async onBusMessage(message: BusMessage): Promise<void> {
        seen.push(message);
      }
    }

    const observer = new Observer();
    await bus.subscribe(observer);
    await bus.start();
    await bus.send(new BusJobRequestMessage({ source: "other", target: "gated", jobId: "j1" }));
    await sleep(0.05);

    expect(seen.some((m) => m instanceof BusJobRequestMessage)).toBe(true);
  });
});

describe("TestDrainBeforeTransition", () => {
  // end() and activateWorker() wait for in-flight frames.
  let bus: AsyncQueueBus;

  beforeEach(async () => {
    [bus] = await createTestBus();
  });

  function _spyOnFlush(worker: PipelineWorker): boolean[] {
    const flushed: boolean[] = [];
    const real = worker.flushPipeline.bind(worker);

    // A short wait rather than the production default: a test that stops
    // draining should fail in a second, not a minute.
    worker.flushPipeline = async (timeout = 1.0) => {
      const result = await real(timeout);
      flushed.push(result);
      return result;
    };
    return flushed;
  }

  async function _runUntil(worker: PipelineWorker, action: () => Promise<void>): Promise<void> {
    const runner = new WorkerRunner({ bus, handleSigint: false });
    await runner.addWorkers(worker);

    const running = new Event();

    worker.eventHandler("on_pipeline_started", async (_worker: PipelineWorker, _frame: Frame) => {
      running.set();
    });

    const drive = async () => {
      // Only a running pipeline is drained, so wait for the StartFrame to
      // reach the end of it. Acting on a fixed delay instead races worker
      // setup, and a host slow enough to lose that race sees the action
      // arrive before there is a pipeline to drain.
      await running.wait();
      await action();
      await worker.queueFrame(new EndFrame());
    };

    await waitFor(
      () =>
        gather(
          () => runner.run(),
          () => drive(),
        ),
      10.0,
    );
  }

  test("test_end_drains_a_running_pipeline", async () => {
    const worker = makeStubPipelineTask("draining");
    const flushed = _spyOnFlush(worker);

    await _runUntil(worker, () => worker.end({ reason: "done" }));

    expect(flushed).toEqual([true]);
  });

  test("test_handing_over_drains_a_running_pipeline", async () => {
    const worker = makeStubPipelineTask("draining");
    const flushed = _spyOnFlush(worker);

    await _runUntil(worker, () => worker.activateWorker("peer", { deactivateSelf: true }));

    expect(flushed).toEqual([true]);
  });

  test("test_activating_a_peer_without_standing_down_skips_the_drain", async () => {
    // Handing nothing over, so there is nothing in flight to wait for.
    //
    // The first activation of a session would otherwise wait on the very
    // worker it is about to wake.
    const worker = makeStubPipelineTask("draining");
    const flushed = _spyOnFlush(worker);

    await _runUntil(worker, () => worker.activateWorker("peer"));

    expect(flushed).toEqual([]);
  });

  test("test_end_skips_the_drain_when_nothing_is_running", async () => {
    // Nothing would bounce the probe back, so waiting would only time out.
    const worker = makeStubPipelineTask("never-started");
    await worker.attach({
      registry: createTestRegistry(),
      bus,
      workerRunner: new WorkerRunner({ bus, handleSigint: false }),
    });
    const flushed = _spyOnFlush(worker);

    await worker.end({ reason: "done" });

    expect(flushed).toEqual([]);
  });
});

describe("TestForeignFlushProbes", () => {
  // A probe is only tracked by the pipeline that takes it in.
  let bus: AsyncQueueBus;

  beforeEach(async () => {
    [bus] = await createTestBus();
  });

  test("test_a_worker_with_nowhere_to_put_a_probe_leaves_it_alone", async () => {
    // Every worker on the bus sees the probe, most have no use for it.
    //
    // Tracking one it will never see again would leave the worker reporting
    // progress on a flush it is taking no part in.
    const origin = makeStubPipelineTask("origin", { bridged: [] });
    const bystander = makeStubPipelineTask("bystander");
    const holder = new PipelineWorker(
      new Pipeline([new BusBridgeProcessor({ bus, workerName: "holder" }), new IdentityFilter()]),
      { name: "holder", cancelOnIdleTimeout: false },
    );

    const workers = [origin, bystander, holder];
    const runner = new WorkerRunner({ bus, handleSigint: false });
    await runner.addWorkers(...workers);

    // The probe crosses the bus, so every pipeline has to be up before it
    // goes out.
    const running = workers.map(() => new Event());

    workers.forEach((worker, i) => {
      const event = running[i]!;
      worker.eventHandler("on_pipeline_started", (_worker: PipelineWorker, _frame: Frame) =>
        event.set(),
      );
    });

    let flushed: boolean | null = null;
    // Read while the workers are up: cleanup drops whatever is left.
    let bystanderProbes: Map<number, string> | null = null;

    const drive = async () => {
      await gather(...running.map((event) => () => event.wait()));
      flushed = await origin.flushPipeline(1.0);
      bystanderProbes = new Map(internals(bystander)._foreignProbes);
      for (const worker of workers) {
        await worker.queueFrame(new EndFrame());
      }
    };

    await waitFor(
      () =>
        gather(
          () => runner.run(),
          () => drive(),
        ),
      10.0,
    );

    expect(flushed).toBe(true);
    expect(bystanderProbes).toEqual(new Map());
  });
});

describe("TestPipelineWorkerLifecycle", () => {
  let bus: AsyncQueueBus;
  let registry: WorkerRegistry;
  let runner: WorkerRunner;

  beforeEach(async () => {
    [bus] = await createTestBus();
    registry = createTestRegistry();
    runner = new WorkerRunner({ bus, handleSigint: false });
  });

  test("test_task_starts_inactive_by_default", async () => {
    // Bridged worker is inactive by default.
    const worker = makeStubPipelineTask("test", { bridged: [] });
    internals(worker)._active = false;
    internals(worker)._pendingActivation = false;
    expect(worker.active).toBe(false);
  });

  test("test_handoff_via_bus_message_after_pipeline_start", async () => {
    // Task activates when BusActivateWorkerMessage received and pipeline started.
    const worker = makeStubPipelineTask("test", { bridged: [] });
    internals(worker)._active = false;
    internals(worker)._pendingActivation = false;
    await worker.attach({ registry, bus, workerRunner: runner });

    const handoffDone = new Event();
    const handoffArgsReceived: unknown[] = [];

    worker.eventHandler("on_activated", async (_t: PipelineWorker, args: unknown) => {
      handoffArgsReceived.push(args);
      handoffDone.set();
    });

    const args = { messages: ["hello"] };

    const handoffAfterStart = async () => {
      await sleep(0.05);
      await bus.send(new BusActivateWorkerMessage({ source: "other", target: "test", args }));
      await waitFor(() => handoffDone.wait(), 2.0);
      await worker.queueFrame(new EndFrame());
    };

    const runner2 = new WorkerRunner({ bus, handleSigint: false });
    await runner2.addWorkers(worker);
    await gather(
      () => runner2.run(),
      () => handoffAfterStart(),
    );

    expect(worker.active).toBe(true);
    expect(handoffArgsReceived.length).toEqual(1);
    expect(handoffArgsReceived[0]).toEqual(args);
  });

  test("test_active_true_fires_on_activated", async () => {
    // active=true fires on_activated after pipeline starts.
    const worker = makeStubPipelineTask("test", { bridged: [] });

    const activated = new Event();

    worker.eventHandler("on_activated", async (_t: PipelineWorker, _args: unknown) => {
      activated.set();
    });

    const waitAndEnd = async () => {
      await waitFor(() => activated.wait(), 2.0);
      await worker.queueFrame(new EndFrame());
    };

    const runner2 = new WorkerRunner({ bus, handleSigint: false });
    await runner2.addWorkers(worker);
    await gather(
      () => runner2.run(),
      () => waitAndEnd(),
    );

    expect(worker.active).toBe(true);
    expect(activated.isSet()).toBe(true);
  });

  test("test_deactivate_self_takes_effect_before_activate_is_sent", async () => {
    // activateWorker(deactivateSelf: true) deactivates before the bus
    // round-trip, so this worker and the target are never both active.
    const worker = makeStubPipelineTask("test", { bridged: [] });
    internals(worker)._active = true;
    internals(worker)._pendingActivation = false;
    await worker.attach({ registry, bus, workerRunner: runner });

    const sent: [string, boolean][] = [];
    const originalSend = worker.sendBusMessage.bind(worker);

    worker.sendBusMessage = async (message: BusMessage) => {
      sent.push([message.constructor.name, worker.active]);
      await originalSend(message);
    };

    await worker.activateWorker("other", { deactivateSelf: true });

    // Flipped synchronously, without waiting for the bus round-trip.
    expect(worker.active).toBe(false);
    expect(sent.map(([name]) => name)).toEqual([
      "BusDeactivateWorkerMessage",
      "BusActivateWorkerMessage",
    ]);
    // Both messages were published with this worker already inactive.
    expect(sent.every(([, active]) => active === false)).toBe(true);
  });

  test("test_activation_args_property_set_and_cleared", async () => {
    // activationArgs returns the latest args while active and is cleared on deactivate.
    const worker = makeStubPipelineTask("test", { bridged: [] });
    internals(worker)._active = false;
    internals(worker)._pendingActivation = false;

    const activated = new Event();
    const deactivated = new Event();

    worker.eventHandler("on_activated", async (_t: PipelineWorker, _args: unknown) => {
      activated.set();
    });

    worker.eventHandler("on_deactivated", async (_t: PipelineWorker) => {
      deactivated.set();
    });

    const args = { messages: ["hello"] };
    const observedWhileActive: { args?: unknown; active?: boolean } = {};

    const drive = async () => {
      await sleep(0.05);
      await bus.send(new BusActivateWorkerMessage({ source: "other", target: "test", args }));
      await waitFor(() => activated.wait(), 2.0);
      observedWhileActive.args = worker.activationArgs;
      observedWhileActive.active = worker.active;
      await bus.send(new BusDeactivateWorkerMessage({ source: "other", target: "test" }));
      await waitFor(() => deactivated.wait(), 2.0);
      await worker.queueFrame(new EndFrame());
    };

    const runner2 = new WorkerRunner({ bus, handleSigint: false });
    await runner2.addWorkers(worker);
    await gather(
      () => runner2.run(),
      () => drive(),
    );

    expect(observedWhileActive.active).toBe(true);
    expect(observedWhileActive.args).toEqual(args);
    expect(worker.active).toBe(false);
    expect(worker.activationArgs).toBeNull();
  });

  test("test_activation_args_none_before_activation", async () => {
    // activationArgs is null before any activation has occurred.
    const worker = makeStubPipelineTask("test", { bridged: [] });
    internals(worker)._active = false;
    internals(worker)._pendingActivation = false;
    expect(worker.activationArgs).toBeNull();
  });

  test("test_activate_task_with_deactivate_self_sends_both_messages", async () => {
    // activateWorker(deactivateSelf: true) sends deactivate then activate.
    const sent = captureBus(bus);

    const worker = makeStubPipelineTask("task_a", { bridged: [] });
    await worker.attach({ registry, bus, workerRunner: runner });

    await worker.activateWorker("task_b", { deactivateSelf: true });

    const deactivateMsgs = sent.filter((m) => m instanceof BusDeactivateWorkerMessage);
    expect(deactivateMsgs.length).toEqual(1);
    expect(deactivateMsgs[0]!.target).toEqual("task_a");
    const activateMsgs = sent.filter((m) => m instanceof BusActivateWorkerMessage);
    expect(activateMsgs.length).toEqual(1);
    expect(activateMsgs[0]!.target).toEqual("task_b");
  });

  test("test_end_without_parent_sends_bus_end_message", async () => {
    // end() with no parent sends BusEndMessage.
    const sent = captureBus(bus);

    const worker = newWorker("task_a");
    await worker.attach({ registry, bus, workerRunner: runner });
    await worker.end({ reason: "done" });

    const endMsgs = sent.filter((m): m is BusEndMessage => m instanceof BusEndMessage);
    expect(endMsgs.length).toEqual(1);
    expect(endMsgs[0]!.source).toEqual("task_a");
    expect(endMsgs[0]!.reason).toEqual("done");
  });

  test("test_end_with_parent_sends_bus_end_message", async () => {
    // end() with parent still sends BusEndMessage (runner handles it).
    const sent = captureBus(bus);

    const parent = newWorker("parent_task");
    await parent.attach({ registry, bus, workerRunner: runner });
    const worker = newWorker("child");
    await worker.attach({ registry, bus, workerRunner: runner });
    await parent.addWorkers(worker);
    await worker.end({ reason: "goodbye" });

    const endMsgs = sent.filter((m): m is BusEndMessage => m instanceof BusEndMessage);
    expect(endMsgs.length).toEqual(1);
    expect(endMsgs[0]!.source).toEqual("child");
    expect(endMsgs[0]!.reason).toEqual("goodbye");
  });

  test("test_cancel_sends_bus_cancel_message", async () => {
    // cancel() sends BusCancelMessage.
    const sent = captureBus(bus);

    const worker = newWorker("task_a");
    await worker.attach({ registry, bus, workerRunner: runner });
    await worker.cancel();

    const cancelMsgs = sent.filter((m) => m instanceof BusCancelMessage);
    expect(cancelMsgs.length).toEqual(1);
    expect(cancelMsgs[0]!.source).toEqual("task_a");
  });

  test("test_add_workers_sends_bus_add_worker_message", async () => {
    // addWorkers() sends BusAddWorkerMessage.
    const sent = captureBus(bus);

    const worker = newWorker("task_a");
    await worker.attach({ registry, bus, workerRunner: runner });
    const newTask = newWorker("task_b");
    await worker.addWorkers(newTask);

    const addMsgs = sent.filter((m): m is BusAddWorkerMessage => m instanceof BusAddWorkerMessage);
    expect(addMsgs.length).toEqual(1);
    expect(addMsgs[0]!.worker).toBe(newTask);
  });

  test("test_started_at_none_before_pipeline_starts", async () => {
    // startedAt is null before the pipeline has started.
    const worker = makeStubPipelineTask("test");
    expect(worker.startedAt).toBeNull();
  });

  test("test_started_at_set_after_pipeline_starts", async () => {
    // startedAt becomes set once the pipeline starts.
    const worker = makeStubPipelineTask("test");

    const readyEvent = new Event();

    worker.eventHandler("on_pipeline_started", async (_t: PipelineWorker, _frame: Frame) => {
      readyEvent.set();
    });

    const waitAndEnd = async () => {
      await waitFor(() => readyEvent.wait(), 2.0);
      expect(worker.startedAt).not.toBeNull();
      await worker.queueFrame(new EndFrame());
    };

    const runner2 = new WorkerRunner({ bus, handleSigint: false });
    await runner2.addWorkers(worker);
    await gather(
      () => runner2.run(),
      () => waitAndEnd(),
    );
  });

  test("test_on_pipeline_started_event", async () => {
    // on_pipeline_started fires after pipeline starts.
    const worker = makeStubPipelineTask("test");

    const started = new Event();

    worker.eventHandler("on_pipeline_started", async (_t: PipelineWorker, _frame: Frame) => {
      started.set();
    });

    const waitAndEnd = async () => {
      await waitFor(() => started.wait(), 2.0);
      await worker.queueFrame(new EndFrame());
    };

    const runner2 = new WorkerRunner({ bus, handleSigint: false });
    await runner2.addWorkers(worker);
    await gather(
      () => runner2.run(),
      () => waitAndEnd(),
    );

    expect(started.isSet()).toBe(true);
  });

  test("test_on_pipeline_finished_event", async () => {
    // on_pipeline_finished fires after pipeline finishes.
    const worker = makeStubPipelineTask("test");

    const finishedFired = new Event();

    worker.eventHandler("on_pipeline_finished", async (_t: PipelineWorker, _frame: Frame) => {
      finishedFired.set();
    });

    const endPipeline = async () => {
      await sleep(0.05);
      await worker.queueFrame(new EndFrame());
    };

    const runner2 = new WorkerRunner({ bus, handleSigint: false });
    await runner2.addWorkers(worker);
    await gather(
      () => runner2.run(),
      () => endPipeline(),
    );

    expect(finishedFired.isSet()).toBe(true);
  });

  test("test_activate_task_with_deactivate_self_deactivates", async () => {
    // activateWorker(deactivateSelf: true) sends a deactivate for the calling worker.
    const sent = captureBus(bus);
    const worker = makeStubPipelineTask("test", { bridged: [] });
    await worker.attach({ registry, bus, workerRunner: runner });

    expect(worker.active).toBe(true);
    await worker.activateWorker("other", { deactivateSelf: true });
    const deactivateMsgs = sent.filter((m) => m instanceof BusDeactivateWorkerMessage);
    expect(deactivateMsgs.length).toEqual(1);
    expect(deactivateMsgs[0]!.target).toEqual("test");
  });

  test("test_bus_end_task_message_ends_pipeline", async () => {
    // BusEndWorkerMessage causes the pipeline to end gracefully.
    const worker = makeStubPipelineTask("test");

    const finished = new Event();

    worker.eventHandler("on_pipeline_finished", async (_t: PipelineWorker, frame: Frame) => {
      if (frame instanceof EndFrame) {
        finished.set();
      }
    });

    const sendEndMessage = async () => {
      await sleep(0.05);
      await bus.send(
        new BusEndWorkerMessage({ source: "runner", target: "test", reason: "shutdown" }),
      );
    };

    const runner2 = new WorkerRunner({ bus, handleSigint: false });
    await runner2.addWorkers(worker);
    await gather(
      () => runner2.run(),
      () => sendEndMessage(),
    );

    expect(finished.isSet()).toBe(true);
  });

  test("test_bus_cancel_task_message_cancels_pipeline", async () => {
    // BusCancelWorkerMessage cancels the pipeline worker.
    const worker = makeStubPipelineTask("test");

    const sendCancelMessage = async () => {
      await sleep(0.05);
      await bus.send(new BusCancelWorkerMessage({ source: "runner", target: "test" }));
    };

    const runner2 = new WorkerRunner({ bus, handleSigint: false });
    try {
      await runner2.addWorkers(worker);
      await gather(
        () => runner2.run(),
        () => sendCancelMessage(),
      );
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
    }

    expect(worker.hasFinished()).toBe(true);
  });

  test("test_queue_frame", async () => {
    // queueFrame injects a frame into the pipeline.
    const worker = makeStubPipelineTask("test");

    const received: TextFrame[] = [];
    worker.setReachedDownstreamFilter([TextFrame]);

    worker.eventHandler(
      "on_frame_reached_downstream",
      async (_t: PipelineWorker, frame: TextFrame) => {
        received.push(frame);
      },
    );

    const pushFrames = async () => {
      await sleep(0.05);
      await worker.queueFrame(new TextFrame({ text: "injected" }));
      await sleep(0.05);
      await worker.queueFrame(new EndFrame());
    };

    const runner2 = new WorkerRunner({ bus, handleSigint: false });
    await runner2.addWorkers(worker);
    await gather(
      () => runner2.run(),
      () => pushFrames(),
    );

    expect(received.length).toEqual(1);
    expect(received[0]!.text).toEqual("injected");
  });

  test("test_queue_frames", async () => {
    // queueFrames injects multiple frames into the pipeline.
    const worker = makeStubPipelineTask("test");

    const received: TextFrame[] = [];
    worker.setReachedDownstreamFilter([TextFrame]);

    worker.eventHandler(
      "on_frame_reached_downstream",
      async (_t: PipelineWorker, frame: TextFrame) => {
        received.push(frame);
      },
    );

    const pushFrames = async () => {
      await sleep(0.05);
      await worker.queueFrames([new TextFrame({ text: "a" }), new TextFrame({ text: "b" })]);
      await sleep(0.05);
      await worker.queueFrame(new EndFrame());
    };

    const runner2 = new WorkerRunner({ bus, handleSigint: false });
    await runner2.addWorkers(worker);
    await gather(
      () => runner2.run(),
      () => pushFrames(),
    );

    expect(received.length).toEqual(2);
    expect(received[0]!.text).toEqual("a");
    expect(received[1]!.text).toEqual("b");
  });

  test("test_bus_tts_speak_message_queues_tts_speak_frame", async () => {
    // BusTTSSpeakMessage queues a TTSSpeakFrame into the pipeline.
    const worker = makeStubPipelineTask("test");

    const received: TTSSpeakFrame[] = [];
    worker.setReachedDownstreamFilter([TTSSpeakFrame]);

    worker.eventHandler(
      "on_frame_reached_downstream",
      async (_t: PipelineWorker, frame: TTSSpeakFrame) => {
        received.push(frame);
      },
    );

    const sendSpeak = async () => {
      await sleep(0.05);
      await bus.send(
        new BusTTSSpeakMessage({
          source: "other",
          target: "test",
          text: "hello there",
          appendToContext: true,
        }),
      );
      await sleep(0.05);
      await worker.queueFrame(new EndFrame());
    };

    const runner2 = new WorkerRunner({ bus, handleSigint: false });
    await runner2.addWorkers(worker);
    await gather(
      () => runner2.run(),
      () => sendSpeak(),
    );

    expect(received.length).toEqual(1);
    expect(received[0]!.text).toEqual("hello there");
    expect(received[0]!.appendToContext).toBe(true);
  });

  test("test_bus_tts_speak_message_ignored_for_other_target", async () => {
    // BusTTSSpeakMessage targeted at another worker is ignored.
    const worker = makeStubPipelineTask("test");

    const received: TTSSpeakFrame[] = [];
    worker.setReachedDownstreamFilter([TTSSpeakFrame]);

    worker.eventHandler(
      "on_frame_reached_downstream",
      async (_t: PipelineWorker, frame: TTSSpeakFrame) => {
        received.push(frame);
      },
    );

    const sendSpeak = async () => {
      await sleep(0.05);
      await bus.send(
        new BusTTSSpeakMessage({ source: "other", target: "someone-else", text: "ignored" }),
      );
      await sleep(0.05);
      await worker.queueFrame(new EndFrame());
    };

    const runner2 = new WorkerRunner({ bus, handleSigint: false });
    await runner2.addWorkers(worker);
    await gather(
      () => runner2.run(),
      () => sendSpeak(),
    );

    expect(received).toEqual([]);
  });

  test("test_self_handoff", async () => {
    // A worker can hand off to itself via activateWorker(this.name, { deactivateSelf: true }).
    const worker = makeStubPipelineTask("test", { bridged: [] });

    const handoffDone = new Event();

    worker.eventHandler("on_activated", async (_t: PipelineWorker, _args: unknown) => {
      handoffDone.set();
    });

    const selfHandoff = async () => {
      // Wait for first activation (from active=true)
      await sleep(0.05);
      handoffDone.clear();
      await worker.activateWorker("test", { deactivateSelf: true });
      await waitFor(() => handoffDone.wait(), 2.0);
      await worker.queueFrame(new EndFrame());
    };

    const runner2 = new WorkerRunner({ bus, handleSigint: false });
    await runner2.addWorkers(worker);
    await gather(
      () => runner2.run(),
      () => selfHandoff(),
    );

    expect(worker.active).toBe(true);
  });

  test("test_add_workers_tracks_children", async () => {
    // addWorkers() populates children list and sets parent.
    const parent = newWorker("parent");
    await parent.attach({ registry, bus, workerRunner: runner });
    const childA = newWorker("child_a");
    const childB = newWorker("child_b");

    await parent.addWorkers(childA);
    await parent.addWorkers(childB);

    expect(parent.children.length).toEqual(2);
    expect(parent.children[0]).toBe(childA);
    expect(parent.children[1]).toBe(childB);
  });

  test("test_end_propagates_to_children", async () => {
    // BusEndWorkerMessage on parent sends end to each child.
    const sent = captureBus(bus);

    const parent = newWorker("parent");
    await parent.attach({ registry, bus, workerRunner: runner });
    const childA = newWorker("child_a");
    const childB = newWorker("child_b");
    await parent.addWorkers(childA);
    await parent.addWorkers(childB);

    // Pre-set children as finished so gather returns immediately
    internals(childA)._finishedEvent.set();
    internals(childB)._finishedEvent.set();

    await parent.onBusMessage(
      new BusEndWorkerMessage({ source: "runner", target: "parent", reason: "shutdown" }),
    );

    const endMsgs = sent.filter((m) => m instanceof BusEndWorkerMessage);
    const targets = new Set(endMsgs.map((m) => m.target));
    expect(targets.has("child_a")).toBe(true);
    expect(targets.has("child_b")).toBe(true);
  });

  test("test_end_waits_for_children", async () => {
    // Parent waits for children to finish before completing _handleWorkerEnd.
    const parent = newWorker("parent");
    await parent.attach({ registry, bus, workerRunner: runner });
    const child = newWorker("child");
    await parent.addWorkers(child);

    const order: string[] = [];

    const delayedChildFinish = async () => {
      await sleep(0.1);
      order.push("child_finished");
      internals(child)._finishedEvent.set();
    };

    const sendEnd = async () => {
      await sleep(0.05);
      await parent.onBusMessage(
        new BusEndWorkerMessage({ source: "runner", target: "parent", reason: "shutdown" }),
      );
      order.push("parent_end_returned");
    };

    await gather(
      () => sendEnd(),
      () => delayedChildFinish(),
    );

    // Child must finish before parent's onBusMessage returns
    expect(order).toEqual(["child_finished", "parent_end_returned"]);
  });

  test("test_cancel_propagates_to_children", async () => {
    // BusCancelWorkerMessage on parent sends cancel to each child.
    const sent = captureBus(bus);

    const parent = newWorker("parent");
    await parent.attach({ registry, bus, workerRunner: runner });
    const childA = newWorker("child_a");
    const childB = newWorker("child_b");
    await parent.addWorkers(childA);
    await parent.addWorkers(childB);

    await parent.onBusMessage(
      new BusCancelWorkerMessage({ source: "runner", target: "parent", reason: "abort" }),
    );

    const cancelMsgs = sent.filter((m) => m instanceof BusCancelWorkerMessage);
    const targets = new Set(cancelMsgs.map((m) => m.target));
    expect(targets.has("child_a")).toBe(true);
    expect(targets.has("child_b")).toBe(true);
  });
});

/** Create a PipelineWorker whose pipeline generates frames. */
function makeGeneratingTask(
  name: string,
  options: { bridged?: readonly string[] | null } = {},
): PipelineWorker {
  return new PipelineWorker(new Pipeline([new _FrameGenerator()]), {
    name,
    bridged: options.bridged ?? null,
    cancelOnIdleTimeout: false,
  });
}

describe("TestEdgeToBus", () => {
  let bus: AsyncQueueBus;

  beforeEach(async () => {
    [bus] = await createTestBus();
  });

  async function runWith(worker: PipelineWorker, drive: () => Promise<void>): Promise<void> {
    const runner = new WorkerRunner({ bus, handleSigint: false });
    await runner.addWorkers(worker);
    await gather(
      () => runner.run(),
      () => drive(),
    );
  }

  function collectText(worker: PipelineWorker): TextFrame[] {
    const received: TextFrame[] = [];
    worker.setReachedDownstreamFilter([TextFrame]);
    worker.eventHandler(
      "on_frame_reached_downstream",
      async (_t: PipelineWorker, frame: TextFrame) => {
        received.push(frame);
      },
    );
    return received;
  }

  test("test_generated_frames_reach_bus", async () => {
    // Pipeline-generated frames are broadcast to the bus.
    const sent = captureBus(bus);

    const worker = makeGeneratingTask("worker", { bridged: [] });

    await runWith(worker, async () => {
      await sleep(0.05);
      await worker.queueFrame(new TextFrame({ text: "input" }));
      await sleep(0.05);
      await worker.queueFrame(new EndFrame());
    });

    const busFrameMsgs = sent.filter((m): m is BusFrameMessage => m instanceof BusFrameMessage);
    const textMsgs = busFrameMsgs.filter((m) => m.frame instanceof TextFrame);
    const generated = textMsgs.filter((m) => (m.frame as TextFrame).text === "generated_input");
    expect(generated.length).toEqual(1);
    expect(generated[0]!.source).toEqual("worker");
  });

  test("test_bus_frames_not_rebroadcast_by_same_task", async () => {
    // Frames from the bus with source==self are ignored by edge processors.
    const sent = captureBus(bus);

    const worker = makeStubPipelineTask("worker", { bridged: [] });

    await runWith(worker, async () => {
      await sleep(0.05);
      // Send a frame from "other" — edge source accepts it (downstream, source != worker)
      await bus.send(
        new BusFrameMessage({
          source: "other",
          frame: new TextFrame({ text: "from_bus" }),
          direction: FrameDirection.DOWNSTREAM,
        }),
      );
      await sleep(0.05);
      await worker.queueFrame(new EndFrame());
    });

    // The frame passes through the identity pipeline and reaches
    // EdgeSink, which re-broadcasts with source="worker". That's
    // expected. But it must NOT create a loop — EdgeSource ignores
    // it because source == "worker".
    // Filter to TextFrame only to ignore metrics frames.
    const busFrameMsgs = sent.filter(
      (m): m is BusFrameMessage => m instanceof BusFrameMessage && m.frame instanceof TextFrame,
    );
    const fromTask = busFrameMsgs.filter((m) => m.source === "worker");
    const fromOther = busFrameMsgs.filter((m) => m.source === "other");
    // One re-broadcast from worker (EdgeSink), one original from other
    expect(fromOther.length).toEqual(1);
    expect(fromTask.length).toEqual(1);
    // No infinite loop — total is exactly 2
    expect(busFrameMsgs.length).toEqual(2);
  });

  test("test_unbridged_task_no_edge_sinks", async () => {
    // An unbridged PipelineWorker does not tee frames to the bus.
    const sent = captureBus(bus);

    const worker = makeStubPipelineTask("root", { bridged: null });

    await runWith(worker, async () => {
      await sleep(0.05);
      await worker.queueFrame(new TextFrame({ text: "root_frame" }));
      await sleep(0.05);
      await worker.queueFrame(new EndFrame());
    });

    const busFrameMsgs = sent.filter((m) => m instanceof BusFrameMessage);
    expect(busFrameMsgs.length).toEqual(0);
  });

  test("test_bus_frame_enters_task_pipeline", async () => {
    // Bus frame messages enter the pipeline via edge source processor.
    const worker = makeStubPipelineTask("worker", { bridged: [] });
    const received = collectText(worker);

    await runWith(worker, async () => {
      await sleep(0.05);
      await bus.send(
        new BusFrameMessage({
          source: "other",
          frame: new TextFrame({ text: "from_bus" }),
          direction: FrameDirection.DOWNSTREAM,
        }),
      );
      await sleep(0.05);
      await worker.queueFrame(new EndFrame());
    });

    expect(received.length).toEqual(1);
    expect(received[0]!.text).toEqual("from_bus");
  });

  test("test_direction_preserved_in_bus_frame", async () => {
    // Direction is preserved when generated frames are sent to the bus.
    const sent = captureBus(bus);

    const worker = makeGeneratingTask("worker", { bridged: [] });

    await runWith(worker, async () => {
      await sleep(0.05);
      await worker.queueFrame(new TextFrame({ text: "hello" }));
      await sleep(0.05);
      await worker.queueFrame(new EndFrame());
    });

    const busFrameMsgs = sent.filter((m): m is BusFrameMessage => m instanceof BusFrameMessage);
    const textMsgs = busFrameMsgs.filter((m) => m.frame instanceof TextFrame);
    const generated = textMsgs.filter((m) => (m.frame as TextFrame).text === "generated_hello");
    expect(generated.length).toEqual(1);
    expect(generated[0]!.direction).toEqual(FrameDirection.DOWNSTREAM);
  });

  test("test_bridged_task_accepts_matching_bridge", async () => {
    // Bridged worker with named bridge accepts frames from that bridge.
    const worker = makeStubPipelineTask("worker", { bridged: ["voice"] });
    const received = collectText(worker);

    await runWith(worker, async () => {
      await sleep(0.05);
      await bus.send(
        new BusFrameMessage({
          source: "other",
          frame: new TextFrame({ text: "voice_frame" }),
          direction: FrameDirection.DOWNSTREAM,
          bridge: "voice",
        }),
      );
      await sleep(0.05);
      await worker.queueFrame(new EndFrame());
    });

    expect(received.length).toEqual(1);
    expect(received[0]!.text).toEqual("voice_frame");
  });

  test("test_bridged_task_rejects_non_matching_bridge", async () => {
    // Bridged worker with named bridge rejects frames from other bridges.
    const worker = makeStubPipelineTask("worker", { bridged: ["voice"] });
    const received = collectText(worker);

    await runWith(worker, async () => {
      await sleep(0.05);
      await bus.send(
        new BusFrameMessage({
          source: "other",
          frame: new TextFrame({ text: "video_frame" }),
          direction: FrameDirection.DOWNSTREAM,
          bridge: "video",
        }),
      );
      await sleep(0.05);
      await worker.queueFrame(new EndFrame());
    });

    expect(received.length).toEqual(0);
  });

  test("test_bridged_task_empty_tuple_accepts_all", async () => {
    // Bridged worker with empty tuple accepts frames from any bridge.
    const worker = makeStubPipelineTask("worker", { bridged: [] });
    const received = collectText(worker);

    await runWith(worker, async () => {
      await sleep(0.05);
      await bus.send(
        new BusFrameMessage({
          source: "other",
          frame: new TextFrame({ text: "voice" }),
          direction: FrameDirection.DOWNSTREAM,
          bridge: "voice",
        }),
      );
      await bus.send(
        new BusFrameMessage({
          source: "other",
          frame: new TextFrame({ text: "video" }),
          direction: FrameDirection.DOWNSTREAM,
          bridge: "video",
        }),
      );
      await bus.send(
        new BusFrameMessage({
          source: "other",
          frame: new TextFrame({ text: "none" }),
          direction: FrameDirection.DOWNSTREAM,
        }),
      );
      await sleep(0.05);
      await worker.queueFrame(new EndFrame());
    });

    expect(received.length).toEqual(3);
  });

  test("test_bridged_task_multiple_bridges", async () => {
    // Bridged worker with multiple bridge names accepts from all listed.
    const worker = makeStubPipelineTask("worker", { bridged: ["voice", "video"] });
    const received = collectText(worker);

    await runWith(worker, async () => {
      await sleep(0.05);
      await bus.send(
        new BusFrameMessage({
          source: "other",
          frame: new TextFrame({ text: "voice" }),
          direction: FrameDirection.DOWNSTREAM,
          bridge: "voice",
        }),
      );
      await bus.send(
        new BusFrameMessage({
          source: "other",
          frame: new TextFrame({ text: "video" }),
          direction: FrameDirection.DOWNSTREAM,
          bridge: "video",
        }),
      );
      await bus.send(
        new BusFrameMessage({
          source: "other",
          frame: new TextFrame({ text: "other" }),
          direction: FrameDirection.DOWNSTREAM,
          bridge: "other",
        }),
      );
      await sleep(0.05);
      await worker.queueFrame(new EndFrame());
    });

    const texts = received.map((r) => r.text).sort();
    expect(texts).toEqual(["video", "voice"]);
  });

  test("test_not_bridged_task_ignores_bridge", async () => {
    // Non-bridged worker (bridged=null) has no edge processors.
    const sent = captureBus(bus);

    const worker = makeStubPipelineTask("root", { bridged: null });

    await runWith(worker, async () => {
      await sleep(0.05);
      await worker.queueFrame(new TextFrame({ text: "test" }));
      await sleep(0.05);
      await worker.queueFrame(new EndFrame());
    });

    const busFrameMsgs = sent.filter((m) => m instanceof BusFrameMessage);
    expect(busFrameMsgs.length).toEqual(0);
  });
});

/** Run `fn` and return what it threw (Python's `with self.assertRaises(E)`). */
async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("TestJobLifecycle", () => {
  let bus: AsyncQueueBus;
  let tm: TaskManager;
  let registry: WorkerRegistry;
  let runner: WorkerRunner;

  beforeEach(async () => {
    [bus, tm] = await createTestBus();
    registry = createTestRegistry();
    runner = new WorkerRunner({ bus, handleSigint: false });
  });

  async function _attach<W extends BaseWorker>(worker: W): Promise<W> {
    await worker.attach({ registry, bus, workerRunner: runner });
    await worker.setup(tm);
    return worker;
  }

  test("test_request_job_sends_request", async () => {
    // requestJob() sends BusJobRequestMessage to each worker.
    const sent = captureBus(bus);

    const parent = await _attach(newWorker("parent"));
    await registry.register(new WorkerReadyData({ workerName: "worker", runner: "test-runner" }));

    const jobId = await parent.requestJob("worker", {
      params: new JobParams({ payload: { key: "val" } }),
    });

    const requestMsgs = sent.filter(
      (m): m is BusJobRequestMessage => m instanceof BusJobRequestMessage,
    );
    expect(requestMsgs.length).toEqual(1);
    expect(requestMsgs[0]!.jobId).toEqual(jobId);
    expect(requestMsgs[0]!.target).toEqual("worker");
    expect(requestMsgs[0]!.payload).toEqual({ key: "val" });
  });

  test("test_request_job_group_multiple_tasks", async () => {
    // requestJobGroup() with multiple tasks sends messages for each.
    const sent = captureBus(bus);

    const parent = await _attach(newWorker("parent"));
    await registerTasks(registry, "w1", "w2");

    const jobId = await parent.requestJobGroup("w1", "w2", {
      params: new JobGroupParams({ payload: { work: true } }),
    });

    const requestMsgs = sent.filter(
      (m): m is BusJobRequestMessage => m instanceof BusJobRequestMessage,
    );
    expect(requestMsgs.length).toEqual(2);
    const targets = new Set(requestMsgs.map((m) => m.target));
    expect(targets).toEqual(new Set(["w1", "w2"]));
    for (const m of requestMsgs) {
      expect(m.jobId).toEqual(jobId);
    }
  });

  test("test_on_job_request_called", async () => {
    // BusJobRequestMessage triggers onJobRequest with the message.
    const worker = await _attach(newWorker("worker"));

    const received: BusJobRequestMessage[] = [];

    worker.eventHandler("on_job_request", async (_t: BaseWorker, message: BusJobRequestMessage) => {
      received.push(message);
    });

    await worker.onBusMessage(
      new BusJobRequestMessage({
        source: "parent",
        target: "worker",
        jobId: "t1",
        payload: { x: 1 },
      }),
    );
    await sleep(0); // let async event handlers run

    expect(received.length).toEqual(1);
    expect(received[0]!.jobId).toEqual("t1");
    expect(received[0]!.source).toEqual("parent");
    expect(received[0]!.payload).toEqual({ x: 1 });
    expect(worker.activeJobs.has("t1")).toBe(true);
  });

  test("test_send_job_response", async () => {
    // sendJobResponse() sends BusJobResponseMessage to requester.
    const sent = captureBus(bus);

    const worker = await _attach(newWorker("worker"));
    // Simulate receiving a job request
    await worker.onBusMessage(
      new BusJobRequestMessage({ source: "parent", target: "worker", jobId: "t1" }),
    );

    await worker.sendJobResponse("t1", { result: 42 });

    const responseMsgs = sent.filter(
      (m): m is BusJobResponseMessage => m instanceof BusJobResponseMessage,
    );
    expect(responseMsgs.length).toEqual(1);
    expect(responseMsgs[0]!.target).toEqual("parent");
    expect(responseMsgs[0]!.jobId).toEqual("t1");
    expect(responseMsgs[0]!.response).toEqual({ result: 42 });
    expect(responseMsgs[0]!.status).toEqual(JobStatus.COMPLETED);
  });

  test("test_send_job_update", async () => {
    // sendJobUpdate() sends BusJobUpdateMessage to requester.
    const sent = captureBus(bus);

    const worker = await _attach(newWorker("worker"));
    await worker.onBusMessage(
      new BusJobRequestMessage({ source: "parent", target: "worker", jobId: "t1" }),
    );

    await worker.sendJobUpdate("t1", { progress: 50 });

    const updateMsgs = sent.filter(
      (m): m is BusJobUpdateMessage => m instanceof BusJobUpdateMessage,
    );
    expect(updateMsgs.length).toEqual(1);
    expect(updateMsgs[0]!.target).toEqual("parent");
    expect(updateMsgs[0]!.jobId).toEqual("t1");
    expect(updateMsgs[0]!.update).toEqual({ progress: 50 });
  });

  test("test_on_job_completed_fires_when_all_respond", async () => {
    // on_job_completed fires when all tasks in a job group respond.
    const parent = await _attach(newWorker("parent"));
    await registerTasks(registry, "w1", "w2");

    const completed: JobGroupResponse[] = [];

    parent.eventHandler("on_job_completed", async (_t: BaseWorker, result: JobGroupResponse) => {
      completed.push(result);
    });

    const jobId = await parent.requestJobGroup("w1", "w2");

    // First response — should not trigger on_job_completed
    await parent.onBusMessage(
      new BusJobResponseMessage({
        source: "w1",
        target: "parent",
        jobId,
        status: JobStatus.COMPLETED,
        response: { a: 1 },
      }),
    );
    await sleep(0); // let async event handlers run
    expect(completed.length).toEqual(0);

    // Second response — should trigger on_job_completed
    await parent.onBusMessage(
      new BusJobResponseMessage({
        source: "w2",
        target: "parent",
        jobId,
        status: JobStatus.COMPLETED,
        response: { b: 2 },
      }),
    );
    await sleep(0); // let async event handlers run
    expect(completed.length).toEqual(1);
    expect(completed[0]!.jobId).toEqual(jobId);
    expect(completed[0]!.responses).toEqual({ w1: { a: 1 }, w2: { b: 2 } });
  });

  test("test_cancel_job_group_sends_cancel_to_all_tasks", async () => {
    // cancelJobGroup() sends BusJobCancelMessage to all tasks in group.
    const sent = captureBus(bus);

    const parent = await _attach(newWorker("parent"));
    await registerTasks(registry, "w1", "w2");

    const jobId = await parent.requestJobGroup("w1", "w2");
    sent.length = 0;

    await parent.cancelJobGroup(jobId, { reason: "no longer needed" });

    const cancelMsgs = sent.filter(
      (m): m is BusJobCancelMessage => m instanceof BusJobCancelMessage,
    );
    expect(cancelMsgs.length).toEqual(2);
    const targets = new Set(cancelMsgs.map((m) => m.target));
    expect(targets).toEqual(new Set(["w1", "w2"]));
    for (const m of cancelMsgs) {
      expect(m.jobId).toEqual(jobId);
      expect(m.reason).toEqual("no longer needed");
    }
  });

  test("test_send_job_response_raises_without_active_job", async () => {
    // sendJobResponse throws when jobId is unknown.
    const worker = await _attach(newWorker("worker"));

    expect(await catchError(() => worker.sendJobResponse("unknown", { result: 1 }))).toBeInstanceOf(
      Error,
    );
  });

  test("test_send_job_update_raises_without_active_job", async () => {
    // sendJobUpdate throws when jobId is unknown.
    const worker = await _attach(newWorker("worker"));

    expect(
      await catchError(() => worker.sendJobUpdate("unknown", { progress: 50 })),
    ).toBeInstanceOf(Error);
  });

  test("test_cancel_auto_sends_cancelled_response", async () => {
    // BusJobCancelMessage auto-sends a cancelled response and clears state.
    const worker = await _attach(newWorker("worker"));

    // Set up job state
    await worker.onBusMessage(
      new BusJobRequestMessage({ source: "parent", target: "worker", jobId: "t1" }),
    );
    expect(worker.activeJobs.has("t1")).toBe(true);

    // Cancel should auto-send response (via sendJobResponse) and clear state
    await worker.onBusMessage(
      new BusJobCancelMessage({ source: "parent", target: "worker", jobId: "t1" }),
    );
    // Yield to let the cancel coroutine complete its work.
    await sleep(0.05);
    expect(worker.activeJobs.has("t1")).toBe(false);
  });

  test("test_stop_cancels_a_job_handler_still_running", async () => {
    // A handler holding a long-lived job open does not outlive the worker.
    class Holder extends BaseWorker {
      async hold(_message: BusJobRequestMessage): Promise<void> {
        await new Event().wait();
      }

      static {
        job({ name: "hold" })(Holder.prototype.hold);
      }
    }

    const worker = await _attach(new Holder({ name: "worker" }));
    await worker.onBusMessage(
      new BusJobRequestMessage({
        source: "parent",
        target: "worker",
        jobId: "t1",
        jobName: "hold",
      }),
    );
    await sleep(0.05);
    const tasks = [...internals(worker)._jobHandlerTasks.values()];
    expect(tasks.length).toEqual(1);
    const task = tasks[0]!;

    await worker.stop();

    expect(task.done()).toBe(true);
    expect(internals(worker)._jobHandlerTasks).toEqual(new Map());
  });

  test("test_on_job_cancelled_fires", async () => {
    // BusJobCancelMessage triggers on_job_cancelled with the message.
    const worker = await _attach(newWorker("worker"));

    const received: BusJobCancelMessage[] = [];

    worker.eventHandler(
      "on_job_cancelled",
      async (_t: BaseWorker, message: BusJobCancelMessage) => {
        received.push(message);
      },
    );

    await worker.onBusMessage(
      new BusJobRequestMessage({ source: "parent", target: "worker", jobId: "t1" }),
    );
    await worker.onBusMessage(
      new BusJobCancelMessage({
        source: "parent",
        target: "worker",
        jobId: "t1",
        reason: "no longer needed",
      }),
    );
    await sleep(0.05);

    expect(received.length).toEqual(1);
    expect(received[0]!.jobId).toEqual("t1");
    expect(received[0]!.reason).toEqual("no longer needed");
  });

  test("test_send_job_stream_start", async () => {
    // sendJobStreamStart() sends BusJobStreamStartMessage to requester.
    const sent = captureBus(bus);

    const worker = await _attach(newWorker("worker"));
    await worker.onBusMessage(
      new BusJobRequestMessage({ source: "parent", target: "worker", jobId: "t1" }),
    );

    await worker.sendJobStreamStart("t1", { content_type: "text" });

    const msgs = sent.filter(
      (m): m is BusJobStreamStartMessage => m instanceof BusJobStreamStartMessage,
    );
    expect(msgs.length).toEqual(1);
    expect(msgs[0]!.target).toEqual("parent");
    expect(msgs[0]!.jobId).toEqual("t1");
    expect(msgs[0]!.data).toEqual({ content_type: "text" });
  });

  test("test_send_job_stream_data", async () => {
    // sendJobStreamData() sends BusJobStreamDataMessage to requester.
    const sent = captureBus(bus);

    const worker = await _attach(newWorker("worker"));
    await worker.onBusMessage(
      new BusJobRequestMessage({ source: "parent", target: "worker", jobId: "t1" }),
    );

    await worker.sendJobStreamData("t1", { text: "hello " });

    const msgs = sent.filter(
      (m): m is BusJobStreamDataMessage => m instanceof BusJobStreamDataMessage,
    );
    expect(msgs.length).toEqual(1);
    expect(msgs[0]!.target).toEqual("parent");
    expect(msgs[0]!.jobId).toEqual("t1");
    expect(msgs[0]!.data).toEqual({ text: "hello " });
  });

  test("test_send_job_stream_end", async () => {
    // sendJobStreamEnd() sends BusJobStreamEndMessage to requester.
    const sent = captureBus(bus);

    const worker = await _attach(newWorker("worker"));
    await worker.onBusMessage(
      new BusJobRequestMessage({ source: "parent", target: "worker", jobId: "t1" }),
    );

    await worker.sendJobStreamEnd("t1", { final: true });

    const msgs = sent.filter(
      (m): m is BusJobStreamEndMessage => m instanceof BusJobStreamEndMessage,
    );
    expect(msgs.length).toEqual(1);
    expect(msgs[0]!.target).toEqual("parent");
    expect(msgs[0]!.jobId).toEqual("t1");
    expect(msgs[0]!.data).toEqual({ final: true });
  });

  test("test_send_job_stream_end_marks_job_complete", async () => {
    // sendJobStreamEnd removes the job from activeJobs, like sendJobResponse.
    //
    // A cancel that races in after the stream ends is then a no-op: no
    // on_job_cancelled hook and no CANCELLED response for the finished job.
    const sent = captureBus(bus);

    const worker = await _attach(newWorker("worker"));
    await worker.onBusMessage(
      new BusJobRequestMessage({ source: "parent", target: "worker", jobId: "t1" }),
    );
    expect(worker.activeJobs.has("t1")).toBe(true);

    const cancelled: BusJobCancelMessage[] = [];

    worker.eventHandler(
      "on_job_cancelled",
      async (_t: BaseWorker, message: BusJobCancelMessage) => {
        cancelled.push(message);
      },
    );

    await worker.sendJobStreamEnd("t1", { final: true });
    expect(worker.activeJobs.has("t1")).toBe(false);

    // A late cancel for the already-completed job is ignored.
    await worker.onBusMessage(
      new BusJobCancelMessage({ source: "parent", target: "worker", jobId: "t1" }),
    );
    await sleep(0.05);

    expect(cancelled).toEqual([]);
    const cancelledResponses = sent.filter(
      (m) => m instanceof BusJobResponseMessage && m.status === JobStatus.CANCELLED,
    );
    expect(cancelledResponses).toEqual([]);
  });

  test("test_stream_end_triggers_on_job_completed", async () => {
    // BusJobStreamEndMessage triggers group completion like BusJobResponseMessage.
    const parent = await _attach(newWorker("parent"));
    await registerTasks(registry, "w1", "w2");

    const completed: JobGroupResponse[] = [];

    parent.eventHandler("on_job_completed", async (_t: BaseWorker, result: JobGroupResponse) => {
      completed.push(result);
    });

    const jobId = await parent.requestJobGroup("w1", "w2");

    // First worker ends stream — should not trigger on_job_completed
    await parent.onBusMessage(
      new BusJobStreamEndMessage({ source: "w1", target: "parent", jobId, data: { result: "a" } }),
    );
    await sleep(0);
    expect(completed.length).toEqual(0);

    // Second worker ends stream — should trigger on_job_completed
    await parent.onBusMessage(
      new BusJobStreamEndMessage({ source: "w2", target: "parent", jobId, data: { result: "b" } }),
    );
    await sleep(0);
    expect(completed.length).toEqual(1);
    expect(completed[0]!.jobId).toEqual(jobId);
    expect(completed[0]!.responses).toEqual({ w1: { result: "a" }, w2: { result: "b" } });
  });

  test("test_send_job_stream_raises_without_active_job", async () => {
    // All stream helpers throw when jobId is unknown.
    const worker = await _attach(newWorker("worker"));

    expect(await catchError(() => worker.sendJobStreamStart("unknown"))).toBeInstanceOf(Error);

    expect(await catchError(() => worker.sendJobStreamData("unknown"))).toBeInstanceOf(Error);

    expect(await catchError(() => worker.sendJobStreamEnd("unknown"))).toBeInstanceOf(Error);
  });

  test("test_request_job_timeout_cancels_job", async () => {
    // Short timeout triggers BusJobCancelMessage with reason 'timeout'.
    const sent = captureBus(bus);

    const parent = await _attach(newWorker("parent"));
    await registerTasks(registry, "worker");

    const jobId = await parent.requestJob("worker", { params: new JobParams({ timeout: 0.05 }) });

    // Wait for timeout to fire
    await sleep(0.1);

    const cancelMsgs = sent.filter(
      (m): m is BusJobCancelMessage => m instanceof BusJobCancelMessage,
    );
    expect(cancelMsgs.length).toEqual(1);
    expect(cancelMsgs[0]!.jobId).toEqual(jobId);
    expect(cancelMsgs[0]!.reason).toEqual("timeout");

    // Clean up remaining tasks
    await parent.cleanup();
  });

  test("test_request_job_timeout_cancelled_on_completion", async () => {
    // Responding before timeout prevents cancel from being sent.
    const sent = captureBus(bus);

    const parent = await _attach(newWorker("parent"));
    await registerTasks(registry, "worker");

    const jobId = await parent.requestJob("worker", { params: new JobParams({ timeout: 0.5 }) });

    // Let the timeout worker start before responding
    await sleep(0);

    // Respond before timeout fires
    await parent.onBusMessage(
      new BusJobResponseMessage({
        source: "worker",
        target: "parent",
        jobId,
        status: JobStatus.COMPLETED,
        response: { ok: true },
      }),
    );

    // Wait past what would have been the timeout
    await sleep(0.1);

    const cancelMsgs = sent.filter((m) => m instanceof BusJobCancelMessage);
    expect(cancelMsgs.length).toEqual(0);

    // Clean up remaining tasks
    await parent.cleanup();
  });

  test("test_request_job_no_timeout_by_default", async () => {
    // timeoutTask is null when no timeout is given.
    const parent = await _attach(newWorker("parent"));
    await registerTasks(registry, "worker");

    const jobId = await parent.requestJob("worker");

    const group = parent.jobGroups.get(jobId)!;
    expect(group.timeoutTask).toBeNull();
  });
});

describe("TestJobDecorator", () => {
  let bus: AsyncQueueBus;
  let tm: TaskManager;
  let registry: WorkerRegistry;
  let runner: WorkerRunner;

  beforeEach(async () => {
    [bus, tm] = await createTestBus();
    registry = createTestRegistry();
    runner = new WorkerRunner({ bus, handleSigint: false });
  });

  async function _attach<W extends BaseWorker>(worker: W): Promise<W> {
    await worker.attach({ registry, bus, workerRunner: runner });
    await worker.setup(tm);
    return worker;
  }

  async function _waitUntil(predicate: () => boolean, timeout = 1.0): Promise<void> {
    const deadline = monotonic() + timeout;
    while (!predicate()) {
      if (monotonic() > deadline) {
        throw new Error("condition not met within timeout");
      }
      await sleep(0.01);
    }
  }

  test("test_sequential_runs_one_at_a_time_in_order", async () => {
    // sequential: true serializes same-name requests in FIFO order.
    let running = 0;
    let maxRunning = 0;
    const completionOrder: string[] = [];
    const gates: Record<string, Event> = {};

    class WorkerTask extends BaseWorker {
      async onWork(message: BusJobRequestMessage): Promise<void> {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await gates[message.jobId]!.wait();
        completionOrder.push(message.jobId);
        running -= 1;
      }

      static {
        job({ name: "work", sequential: true })(WorkerTask.prototype.onWork);
      }
    }

    const worker = await _attach(new WorkerTask({ name: "worker" }));

    for (const tid of ["t1", "t2", "t3"]) {
      gates[tid] = new Event();
      await worker.onBusMessage(
        new BusJobRequestMessage({
          source: "parent",
          target: "worker",
          jobId: tid,
          jobName: "work",
        }),
      );
    }

    // Let the first handler enter the locked region.
    await _waitUntil(() => running === 1);

    // Release in order; verify completion in order.
    for (const tid of ["t1", "t2", "t3"]) {
      gates[tid]!.set();
      await _waitUntil(() => completionOrder.includes(tid));
    }

    expect(completionOrder).toEqual(["t1", "t2", "t3"]);
    expect(maxRunning).toEqual(1);
  });

  test("test_non_sequential_runs_concurrently", async () => {
    // Without sequential: true, same-name handlers run concurrently.
    let running = 0;
    let maxRunning = 0;
    const release = new Event();

    class WorkerTask extends BaseWorker {
      async onWork(_message: BusJobRequestMessage): Promise<void> {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await release.wait();
        running -= 1;
      }

      static {
        job({ name: "work" })(WorkerTask.prototype.onWork);
      }
    }

    const worker = await _attach(new WorkerTask({ name: "worker" }));

    for (const tid of ["t1", "t2"]) {
      await worker.onBusMessage(
        new BusJobRequestMessage({
          source: "parent",
          target: "worker",
          jobId: tid,
          jobName: "work",
        }),
      );
    }

    await _waitUntil(() => running === 2);
    expect(maxRunning).toEqual(2);
    release.set();
    await _waitUntil(() => running === 0);
  });

  test("test_sequential_locks_are_per_name", async () => {
    // Sequential lock is per job name; different names do not block each other.
    let running = 0;
    let maxRunning = 0;
    const release = new Event();

    class WorkerTask extends BaseWorker {
      async onA(_message: BusJobRequestMessage): Promise<void> {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await release.wait();
        running -= 1;
      }

      async onB(_message: BusJobRequestMessage): Promise<void> {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await release.wait();
        running -= 1;
      }

      static {
        job({ name: "a", sequential: true })(WorkerTask.prototype.onA);
        job({ name: "b", sequential: true })(WorkerTask.prototype.onB);
      }
    }

    const worker = await _attach(new WorkerTask({ name: "worker" }));

    await worker.onBusMessage(
      new BusJobRequestMessage({ source: "parent", target: "worker", jobId: "ta", jobName: "a" }),
    );
    await worker.onBusMessage(
      new BusJobRequestMessage({ source: "parent", target: "worker", jobId: "tb", jobName: "b" }),
    );

    await _waitUntil(() => running === 2);
    expect(maxRunning).toEqual(2);
    release.set();
    await _waitUntil(() => running === 0);
  });
});
