# Copyright (c) 2026, pipedog contributors
# SPDX-License-Identifier: BSD-2-Clause
#
# Reference interleavings for @pipedog/asyncio, recorded from CPython's
# asyncio. Each scenario logs what its tasks do; ../trace_scenarios.ts holds
# the same scenarios in TypeScript, which must log the very same.
#
#   python3 packages/asyncio/test/python/scenarios.py > packages/asyncio/test/python/traces.json
#   bunx biome format --write packages/asyncio/test/python/traces.json
#
# Keep every scenario deterministic: no wall-clock races (distinct sleep
# durations only where the order between timers is the point).

import asyncio
import json
import sys

SCENARIOS = {}


def scenario(fn):
    SCENARIOS[fn.__name__] = fn
    return fn


async def no_suspend(log, depth):
    # A coroutine that never suspends: awaiting it does not yield.
    if depth > 0:
        log.append(f"nested {depth}")
        return await no_suspend(log, depth - 1)
    return "leaf"


@scenario
async def queue_producer_consumer(log):
    q = asyncio.Queue()

    async def consumer():
        for _ in range(5):
            item = await q.get()
            log.append(f"got {item}")

    t = asyncio.create_task(consumer())
    for i in range(3):
        await q.put(i)
        log.append(f"put {i}")
    await asyncio.sleep(0)
    log.append("producer after sleep(0)")
    for i in range(3, 5):
        await q.put(i)
        log.append(f"put {i}")
    await t
    log.append("done")


@scenario
async def bounded_queue(log):
    q = asyncio.Queue(maxsize=1)

    async def producer():
        for i in range(4):
            log.append(f"putting {i}")
            await q.put(i)
            log.append(f"put {i}")

    async def consumer():
        for _ in range(4):
            item = await q.get()
            log.append(f"got {item}")

    await asyncio.gather(producer(), consumer())
    log.append("done")


@scenario
async def event_set_while_running(log):
    ev = asyncio.Event()

    async def waiter(name):
        log.append(f"{name} waiting")
        await ev.wait()
        log.append(f"{name} woke")

    a = asyncio.create_task(waiter("a"))
    b = asyncio.create_task(waiter("b"))
    await asyncio.sleep(0)
    ev.set()
    log.append("set")
    log.append(await no_suspend(log, 2))
    await ev.wait()
    log.append("main wait on set event did not yield")
    await asyncio.sleep(0)
    log.append("main after sleep(0)")
    await a
    await b
    log.append("done")


@scenario
async def gather_order(log):
    async def child(name, yields):
        log.append(f"{name} start")
        for i in range(yields):
            await asyncio.sleep(0)
            log.append(f"{name} step {i}")
        return name

    results = await asyncio.gather(child("a", 2), child("b", 0), child("c", 1))
    log.append(f"results {results}")


@scenario
async def task_creation_order(log):
    async def child(name):
        log.append(f"{name} start")
        await asyncio.sleep(0)
        log.append(f"{name} end")
        return name

    tasks = [asyncio.create_task(child(f"t{i}")) for i in range(3)]
    log.append("created")
    log.append(await no_suspend(log, 1))
    log.append("main still running")
    await asyncio.sleep(0)
    log.append("main after sleep(0)")
    log.append(f"awaited {await tasks[2]}")
    log.append(f"t0 done {tasks[0].done()}")
    await asyncio.gather(*tasks)
    log.append("done")


@scenario
async def sleep0_pingpong(log):
    async def player(name):
        for i in range(3):
            log.append(f"{name} {i}")
            await asyncio.sleep(0)

    await asyncio.gather(player("ping"), player("pong"))


@scenario
async def fast_paths_do_not_yield(log):
    q = asyncio.Queue()
    q.put_nowait("x")
    ev = asyncio.Event()
    ev.set()
    lock = asyncio.Lock()

    async def other():
        log.append("other ran")

    async def main_task():
        log.append("main start")
        log.append(await no_suspend(log, 3))
        log.append(f"get {await q.get()}")
        await q.put("y")
        log.append("put y")
        log.append(f"get {await q.get()}")
        await ev.wait()
        log.append("event waited")
        await lock.acquire()
        log.append("lock acquired")
        lock.release()
        done = asyncio.get_running_loop().create_future()
        done.set_result("ready")
        log.append(f"done future {await done}")
        log.append("main suspends")
        await asyncio.sleep(0)
        log.append("main end")

    t1 = asyncio.create_task(main_task())
    t2 = asyncio.create_task(other())
    await asyncio.gather(t1, t2)


@scenario
async def burst_through_two_queues(log):
    # The FrameProcessor shape: an input task moves items from the input
    # queue to the process queue; the process task looks behind each item.
    input_q = asyncio.Queue()
    process_q = asyncio.Queue()
    total = 4

    async def input_task():
        for _ in range(total):
            item = await input_q.get()
            log.append(f"input moves {item}")
            await process_q.put(item)

    async def process_task():
        for _ in range(total):
            item = await process_q.get()
            log.append(f"process {item} with {process_q.qsize()} queued behind")

    tasks = [asyncio.create_task(input_task()), asyncio.create_task(process_task())]
    await asyncio.sleep(0)
    for i in range(3):
        await input_q.put(i)
    log.append("burst queued")
    await asyncio.sleep(0)
    await input_q.put(3)
    log.append("straggler queued")
    await asyncio.gather(*tasks)


@scenario
async def priority_queue_burst(log):
    q = asyncio.PriorityQueue()

    async def consumer():
        for _ in range(3):
            log.append(f"got {await q.get()}")

    t = asyncio.create_task(consumer())
    await asyncio.sleep(0)
    q.put_nowait((3, "c"))
    q.put_nowait((1, "a"))
    q.put_nowait((2, "b"))
    log.append("queued")
    await t


@scenario
async def queue_item_taken_before_woken_getter_runs(log):
    q = asyncio.Queue()

    async def getter():
        log.append("getter waiting")
        log.append(f"getter got {await q.get()}")

    t = asyncio.create_task(getter())
    await asyncio.sleep(0)
    q.put_nowait("first")
    log.append(f"main took {q.get_nowait()}")
    await asyncio.sleep(0)
    log.append("main after sleep(0)")
    q.put_nowait("second")
    await t


@scenario
async def cancel_waiting_get(log):
    q = asyncio.Queue()

    async def getter():
        try:
            await q.get()
        except asyncio.CancelledError:
            log.append("getter cancelled")
            raise
        finally:
            log.append("getter finally")

    t = asyncio.create_task(getter())
    await asyncio.sleep(0)
    log.append(f"cancel {t.cancel()}")
    log.append(f"done right after cancel {t.done()}")
    try:
        await t
    except asyncio.CancelledError:
        log.append("awaiting raised CancelledError")
    log.append(f"cancelled {t.cancelled()}")


@scenario
async def cancel_after_wakeup(log):
    q = asyncio.Queue()

    async def getter(name):
        try:
            log.append(f"{name} got {await q.get()}")
        except asyncio.CancelledError:
            log.append(f"{name} cancelled")
            raise

    a = asyncio.create_task(getter("a"))
    b = asyncio.create_task(getter("b"))
    await asyncio.sleep(0)
    q.put_nowait("item")
    # a is woken up but has not run yet: the cancellation wins, and a passes
    # the wakeup on to b.
    a.cancel()
    await asyncio.gather(a, b, return_exceptions=True)
    log.append(f"a cancelled {a.cancelled()}, qsize {q.qsize()}")


@scenario
async def cancel_before_start(log):
    async def child():
        log.append("child body ran")

    t = asyncio.create_task(child())
    t.cancel()
    try:
        await t
    except asyncio.CancelledError:
        log.append("cancelled before start")


@scenario
async def cancel_parent_awaiting_child(log):
    async def child():
        try:
            await asyncio.sleep(10)
        finally:
            log.append("child finally")

    async def parent(c):
        try:
            await c
        except asyncio.CancelledError:
            log.append("parent got CancelledError")
            raise

    c = asyncio.create_task(child())
    p = asyncio.create_task(parent(c))
    await asyncio.sleep(0)
    p.cancel()
    log.append(f"child cancelling {c.cancelling()}")
    await asyncio.gather(p, return_exceptions=True)
    log.append(f"parent cancelled {p.cancelled()}, child cancelled {c.cancelled()}")


@scenario
async def child_swallows_cancel(log):
    async def child():
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            log.append("child swallows")
        return "child result"

    async def parent(c):
        result = await c
        log.append(f"parent got {result}")
        return result

    c = asyncio.create_task(child())
    p = asyncio.create_task(parent(c))
    await asyncio.sleep(0)
    p.cancel()
    log.append(f"parent result {await p}, parent cancelling {p.cancelling()}")


@scenario
async def lock_fairness(log):
    lock = asyncio.Lock()

    async def worker(name):
        async with lock:
            log.append(f"{name} in")
            await asyncio.sleep(0)
            log.append(f"{name} out")

    await asyncio.gather(worker("a"), worker("b"), worker("c"))


@scenario
async def semaphore_order(log):
    sem = asyncio.Semaphore(2)

    async def worker(name):
        async with sem:
            log.append(f"{name} in")
            await asyncio.sleep(0)
            log.append(f"{name} out")

    await asyncio.gather(*(worker(n) for n in "abcd"))


@scenario
async def wait_for_timeout(log):
    async def slow():
        try:
            await asyncio.sleep(10)
        finally:
            log.append("slow finally")

    async def fast():
        await asyncio.sleep(0)
        return "fast"

    try:
        await asyncio.wait_for(slow(), 0.01)
    except TimeoutError as e:
        log.append(type(e).__name__)
    log.append(f"wait_for result {await asyncio.wait_for(fast(), 1)}")
    log.append(f"cancelling {asyncio.current_task().cancelling()}")
    try:
        await asyncio.wait_for(fast(), 0)
    except TimeoutError as e:
        log.append(f"zero timeout {type(e).__name__}")


@scenario
async def wait_first_completed(log):
    async def child(name, yields):
        for _ in range(yields):
            await asyncio.sleep(0)
        log.append(f"{name} finished")
        return name

    a = asyncio.create_task(child("a", 3), name="a")
    b = asyncio.create_task(child("b", 1), name="b")
    done, pending = await asyncio.wait({a, b}, return_when=asyncio.FIRST_COMPLETED)
    log.append(f"done {sorted(t.get_name() for t in done)} pending {sorted(t.get_name() for t in pending)}")
    done, pending = await asyncio.wait({a, b})
    log.append(f"done {sorted(t.get_name() for t in done)} pending {len(pending)}")


@scenario
async def done_callbacks_order(log):
    async def child():
        log.append("child runs")
        return 1

    t = asyncio.create_task(child())
    t.add_done_callback(lambda _: log.append("callback 1"))

    async def awaiter():
        await t
        log.append("awaiter resumed")

    w = asyncio.create_task(awaiter())
    await asyncio.sleep(0)
    t.add_done_callback(lambda _: log.append("callback 2"))
    await w
    t.add_done_callback(lambda _: log.append("callback 3 (added when done)"))
    log.append("main after awaiter")
    await asyncio.sleep(0)
    log.append("main end")


@scenario
async def shield_inner_survives(log):
    async def inner():
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        log.append("inner finished")
        return "inner"

    inner_task = asyncio.create_task(inner())

    async def outer():
        try:
            await asyncio.shield(inner_task)
        except asyncio.CancelledError:
            log.append("outer cancelled")
            raise

    o = asyncio.create_task(outer())
    await asyncio.sleep(0)
    o.cancel()
    await asyncio.gather(o, return_exceptions=True)
    log.append(f"inner done {inner_task.done()}")
    log.append(f"inner result {await inner_task}")


@scenario
async def gather_cancel(log):
    async def child(name):
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            log.append(f"{name} cancelled")
            await asyncio.sleep(0)
            log.append(f"{name} cleanup done")
            raise

    async def parent():
        try:
            await asyncio.gather(child("a"), child("b"))
        except asyncio.CancelledError:
            log.append("parent got CancelledError")
            raise

    p = asyncio.create_task(parent())
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    p.cancel()
    await asyncio.gather(p, return_exceptions=True)
    log.append(f"parent cancelled {p.cancelled()}")


@scenario
async def gather_exception(log):
    async def bad():
        await asyncio.sleep(0)
        raise ValueError("boom")

    async def good():
        for i in range(3):
            await asyncio.sleep(0)
        log.append("good finished")
        return "good"

    g = asyncio.create_task(good())
    try:
        await asyncio.gather(bad(), g)
    except ValueError as e:
        log.append(f"gather raised {e}")
    log.append(f"good done {g.done()}")
    await g
    log.append(f"gather settled {await asyncio.gather(bad(), g, return_exceptions=True)!r}")


@scenario
async def event_cleared_before_waiter_runs(log):
    ev = asyncio.Event()

    async def waiter():
        log.append(f"waiter got {await ev.wait()}")

    t = asyncio.create_task(waiter())
    await asyncio.sleep(0)
    ev.set()
    ev.clear()
    await t
    log.append(f"is_set {ev.is_set()}")


@scenario
async def timers_in_order(log):
    async def sleeper(name, delay):
        await asyncio.sleep(delay)
        log.append(f"{name} woke")

    await asyncio.gather(sleeper("late", 0.03), sleeper("early", 0.01), sleeper("zero", 0))


@scenario
async def queue_join(log):
    q = asyncio.Queue()

    async def worker():
        while True:
            item = await q.get()
            log.append(f"work {item}")
            await asyncio.sleep(0)
            q.task_done()

    w = asyncio.create_task(worker())
    for i in range(3):
        q.put_nowait(i)
    await q.join()
    log.append("joined")
    w.cancel()
    await asyncio.gather(w, return_exceptions=True)
    log.append(f"worker cancelled {w.cancelled()}")


@scenario
async def task_started_from_callback(log):
    async def child(name):
        log.append(f"{name} runs")

    async def first():
        log.append("first runs")

    t = asyncio.create_task(first())
    t.add_done_callback(lambda _: asyncio.create_task(child("from callback")))
    asyncio.create_task(child("sibling"))
    await t
    log.append("main resumed")
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    log.append("main end")


@scenario
async def timeout_scope(log):
    try:
        async with asyncio.timeout(0.01):
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                log.append("body cancelled")
                raise
    except TimeoutError:
        log.append("scope raised TimeoutError")
    async with asyncio.timeout(1):
        await asyncio.sleep(0)
        log.append("body finished in time")
    log.append(f"cancelling {asyncio.current_task().cancelling()}")


@scenario
async def wait_for_task_cancels_it(log):
    async def child():
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            log.append("child cancelled")
            raise

    t = asyncio.create_task(child())
    try:
        await asyncio.wait_for(t, 0.01)
    except TimeoutError:
        log.append(f"timed out, child cancelled {t.cancelled()}")


@scenario
async def lock_waiter_cancelled(log):
    lock = asyncio.Lock()

    async def worker(name):
        try:
            async with lock:
                log.append(f"{name} in")
                await asyncio.sleep(0)
                log.append(f"{name} out")
        except asyncio.CancelledError:
            log.append(f"{name} cancelled")
            raise

    a = asyncio.create_task(worker("a"))
    b = asyncio.create_task(worker("b"))
    c = asyncio.create_task(worker("c"))
    await asyncio.sleep(0)
    b.cancel()
    await asyncio.gather(a, b, c, return_exceptions=True)
    log.append(f"locked {lock.locked()}")


@scenario
async def bounded_putter_cancelled(log):
    q = asyncio.Queue(maxsize=1)
    q.put_nowait("full")

    async def putter(name):
        try:
            await q.put(name)
            log.append(f"{name} put")
        except asyncio.CancelledError:
            log.append(f"{name} cancelled")
            raise

    a = asyncio.create_task(putter("a"))
    b = asyncio.create_task(putter("b"))
    await asyncio.sleep(0)
    log.append(f"got {q.get_nowait()}")
    a.cancel()
    await asyncio.gather(a, b, return_exceptions=True)
    log.append(f"queue holds {q.get_nowait()}")


@scenario
async def cancelled_right_before_returning(log):
    async def child():
        asyncio.current_task().cancel()
        log.append("child returns")
        return 1

    t = asyncio.create_task(child())
    try:
        await t
    except asyncio.CancelledError:
        log.append(f"awaiting raised CancelledError, cancelled {t.cancelled()}")


async def run_one(fn):
    log = []
    await fn(log)
    return log


def main():
    traces = {name: asyncio.run(run_one(fn)) for name, fn in SCENARIOS.items()}
    json.dump(traces, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
