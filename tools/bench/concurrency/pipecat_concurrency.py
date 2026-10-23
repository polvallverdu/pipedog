# Copyright (c) 2026, pipedog contributors
# SPDX-License-Identifier: BSD-2-Clause
#
# The Pipecat side of the concurrency benchmark (tools/bench/concurrency.ts):
# the calls of pipedog.ts, written the same way against upstream Pipecat, all
# in one asyncio loop ("single") or spread over one process per core
# ("workers": multiprocessing, Python's equivalent of worker threads, since
# threads share the GIL). Reads its arguments as JSON from PIPEDOG_BENCH_ARGS
# and prints one JSON line prefixed with __CONCURRENCY_RESULT__.
#
# Upstream runs Silero and Smart Turn on a thread executor per analyzer
# (onnxruntime releases the GIL while it runs), so model inference doesn't
# block the event loop the way an inline call does.

import asyncio
import json
import multiprocessing
import os
import platform
import resource
import sys
import time
import wave
from datetime import datetime, timezone

from loguru import logger

# Both sides log at WARNING, so neither pays for its debug lines.
logger.remove()
logger.add(sys.stderr, level="WARNING")

from pipecat.frames.frames import (  # noqa: E402
    Frame,
    InputAudioRawFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline  # noqa: E402
from pipecat.pipeline.worker import PipelineWorker  # noqa: E402
from pipecat.processors.audio.vad_processor import VADProcessor  # noqa: E402
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor  # noqa: E402
from pipecat.workers.runner import WorkerRunner  # noqa: E402

SAMPLE_RATE = 16000
CHUNK_MS = 20
CHUNK_BYTES = SAMPLE_RATE * CHUNK_MS * 2 // 1000  # 640
SILENCE_S = 1.6
TTS_RATE = 24000
TTS_CHUNK = bytes(TTS_RATE * CHUNK_MS * 2 // 1000)  # 960 bytes of silence
TTS_SECONDS = 2
LLM_DELAY_S = 0.35
LLM_TOKENS = 6
LLM_TOKEN_S = 0.025
TTS_DELAY_S = 0.15
LAG_PROBE_MS = 10


def now() -> float:
    return time.perf_counter() * 1000


def cpu_ms() -> float:
    # All threads of this process.
    r = resource.getrusage(resource.RUSAGE_SELF)
    return (r.ru_utime + r.ru_stime) * 1000


def peak_rss() -> int:
    # ru_maxrss is in bytes on macOS and KiB on Linux.
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r if sys.platform == "darwin" else r * 1024


def load_cycle(path: str) -> list[bytes]:
    """The WAV's PCM data plus the silence, as whole 20 ms chunks."""
    with wave.open(path, "rb") as w:
        if w.getnchannels() != 1 or w.getframerate() != SAMPLE_RATE:
            raise ValueError(f"{path}: not 16 kHz mono")
        pcm = w.readframes(w.getnframes())
    silence = round(SILENCE_S * SAMPLE_RATE * 2)
    total = -(-(len(pcm) + silence) // CHUNK_BYTES) * CHUNK_BYTES
    cycle = pcm + bytes(total - len(pcm))
    return [cycle[i : i + CHUNK_BYTES] for i in range(0, total, CHUNK_BYTES)]


def new_stats(calls: int) -> dict:
    return {
        "calls": calls,
        "latency": [],
        "ttsLate": [],
        "lag": [],
        "inputFrames": 0,
        "ttsFrames": 0,
        "transcriptions": 0,
        "vadStops": 0,
        "turnPredictions": 0,
        "errors": [],
    }


class PassThrough(FrameProcessor):
    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)


class FakeSTT(FrameProcessor):
    """Emits a transcription after each loop of the input audio."""

    def __init__(self, cycle_chunks: int, stats: dict):
        super().__init__()
        self._cycle_chunks = cycle_chunks
        self._stats = stats
        self._chunks = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            self._chunks += 1
            if self._chunks % self._cycle_chunks == 0:
                self._stats["transcriptions"] += 1
                await self.push_frame(
                    TranscriptionFrame(
                        text="What's the capital of France?",
                        user_id="user",
                        timestamp=datetime.now(timezone.utc).isoformat(),
                    )
                )


class FakeLLM(FrameProcessor):
    """Answers each transcription after a delay, streaming a few tokens."""

    def __init__(self):
        super().__init__()
        self._task = None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            self._task = self.create_task(self._respond(), "respond")
            return
        await self.push_frame(frame, direction)

    async def _respond(self):
        await asyncio.sleep(LLM_DELAY_S)
        await self.push_frame(LLMFullResponseStartFrame())
        for i in range(LLM_TOKENS):
            await self.push_frame(LLMTextFrame(text=f"token {i} "))
            await asyncio.sleep(LLM_TOKEN_S)
        await self.push_frame(LLMFullResponseEndFrame())

    async def cleanup(self):
        if self._task:
            await self.cancel_task(self._task)
        await super().cleanup()


class FakeTTS(FrameProcessor):
    """Speaks each response: real-time-paced audio after a delay."""

    def __init__(self):
        super().__init__()
        self._task = None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        if isinstance(frame, LLMFullResponseEndFrame):
            self._task = self.create_task(self._speak(), "speak")

    async def _speak(self):
        await asyncio.sleep(TTS_DELAY_S)
        await self.push_frame(TTSStartedFrame())
        start = now()
        for i in range(TTS_SECONDS * 1000 // CHUNK_MS):
            due = start + i * CHUNK_MS
            wait = due - now()
            if wait > 0:
                await asyncio.sleep(wait / 1000)
            frame = TTSAudioRawFrame(audio=TTS_CHUNK, sample_rate=TTS_RATE, num_channels=1)
            # A timer can fire a little early; a frame sent early is on time.
            frame.due_at = min(due, now())
            await self.push_frame(frame)
        await self.push_frame(TTSStoppedFrame())

    async def cleanup(self):
        if self._task:
            await self.cancel_task(self._task)
        await super().cleanup()


class Sink(FrameProcessor):
    def __init__(self, window: dict, stats: dict):
        super().__init__()
        self._window = window
        self._stats = stats

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        due = getattr(frame, "due_at", None)
        if due is not None and self._window["start"] <= due < self._window["end"]:
            if isinstance(frame, InputAudioRawFrame):
                self._stats["latency"].append(now() - due)
                self._stats["inputFrames"] += 1
            elif isinstance(frame, TTSAudioRawFrame):
                self._stats["ttsLate"].append(now() - due)
                self._stats["ttsFrames"] += 1
        await self.push_frame(frame, direction)


class SmartTurn(FrameProcessor):
    """Runs Smart Turn at each end of speech, as the turn analyzer stop strategy does."""

    def __init__(self, analyzer, stats: dict):
        super().__init__()
        self._analyzer = analyzer
        self._stats = stats
        self._speaking = False
        analyzer.set_sample_rate(SAMPLE_RATE)

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        if direction != FrameDirection.DOWNSTREAM:
            return
        if isinstance(frame, VADUserStartedSpeakingFrame):
            self._speaking = True
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            self._speaking = False
            self._stats["vadStops"] += 1
            await self._analyzer.analyze_end_of_turn()
            self._stats["turnPredictions"] += 1
        elif isinstance(frame, InputAudioRawFrame):
            self._analyzer.append_audio(frame.audio, self._speaking)

    async def cleanup(self):
        await self._analyzer.cleanup()
        await super().cleanup()


async def run_calls(args: dict, calls: list[int], go_at: float | None = None) -> dict:
    """Runs `calls` calls in this loop, sending audio from `go_at` (time.time()) if given."""
    stats = new_stats(len(calls))
    cycle = load_cycle(args["wav"])
    window = {"start": float("inf"), "end": float("inf")}
    local = args["profile"] == "local"
    if local:
        from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
        from pipecat.audio.vad.silero import SileroVADAnalyzer

    async def start_call():
        processors = []
        if local:
            processors.append(VADProcessor(vad_analyzer=SileroVADAnalyzer()))
        processors += [
            FakeSTT(len(cycle), stats),
            PassThrough(),
            PassThrough(),
            FakeLLM(),
            FakeTTS(),
            PassThrough(),
            Sink(window, stats),
        ]
        if local:
            processors.append(SmartTurn(LocalSmartTurnAnalyzerV3(), stats))
        worker = PipelineWorker(Pipeline(processors), cancel_on_idle_timeout=False)
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)
        started = asyncio.Event()

        @worker.event_handler("on_pipeline_started")
        async def on_started(worker, frame):
            started.set()

        @worker.event_handler("on_pipeline_error")
        async def on_error(worker, frame):
            stats["errors"].append(str(frame.error))

        running = asyncio.create_task(runner.run())
        await started.wait()
        return worker, running

    sessions = await asyncio.gather(*(start_call() for _ in calls))
    if go_at is not None:
        await asyncio.sleep(max(0.0, go_at - time.time()))

    t0 = now()
    window["start"] = t0 + args["warmupS"] * 1000
    window["end"] = window["start"] + args["durationS"] * 1000

    async def feed(worker, c: int):
        offset = ((c * 0.618034) % 1) * 1000
        phase = int(((c * 0.381966) % 1) * len(cycle))
        k = 0
        while True:
            due = t0 + offset + k * CHUNK_MS
            if due >= window["end"]:
                return
            wait = due - now()
            if wait > 0:
                await asyncio.sleep(wait / 1000)
            frame = InputAudioRawFrame(
                audio=cycle[(phase + k) % len(cycle)], sample_rate=SAMPLE_RATE, num_channels=1
            )
            frame.due_at = min(due, now())
            await worker.queue_frame(frame)
            k += 1

    async def probe():
        last = now()
        while last < window["end"]:
            await asyncio.sleep(LAG_PROBE_MS / 1000)
            t = now()
            if window["start"] <= t < window["end"]:
                stats["lag"].append(t - last - LAG_PROBE_MS)
            last = t

    cpu = {}

    async def measure_cpu():
        await asyncio.sleep(args["warmupS"])
        c0, w0 = cpu_ms(), now()
        await asyncio.sleep(args["durationS"])
        cpu["ms"], cpu["wallMs"] = cpu_ms() - c0, now() - w0

    await asyncio.gather(
        *(feed(w, c) for (w, _), c in zip(sessions, calls)), probe(), measure_cpu()
    )
    await asyncio.sleep(0.2)

    async def stop(worker, running):
        await worker.cancel()
        await asyncio.wait([running], timeout=5)

    await asyncio.gather(*(stop(w, r) for w, r in sessions))
    stats["cpu"] = cpu
    stats["peakRss"] = peak_rss()
    return stats


def summary(xs: list[float]) -> dict:
    s = sorted(xs)
    if not s:
        return {"n": 0, "p50": None, "p99": None, "p999": None, "max": None}

    def q(p):
        return s[min(len(s) - 1, int(p * len(s)))]

    return {"n": len(s), "p50": q(0.5), "p99": q(0.99), "p999": q(0.999), "max": s[-1]}


def main():
    args = json.loads(os.environ["PIPEDOG_BENCH_ARGS"])
    ids = list(range(args["calls"]))
    if args["mode"] == "single":
        threads = 1
        results = [asyncio.run(run_calls(args, ids))]
        peak = results[0]["peakRss"]
    else:
        threads = min(args.get("workers") or os.cpu_count() or 1, args["calls"])
        shares = [ids[w::threads] for w in range(threads)]
        ctx = multiprocessing.get_context("spawn")
        with ctx.Pool(threads) as pool:
            # Every process starts its audio at the same time, once its calls have started.
            per_call = 0.3 if args["profile"] == "local" else 0.02
            go_at = time.time() + 5 + per_call * args["calls"] / threads
            results = pool.starmap(_pool_run, [(args, share, go_at) for share in shares])
        peak = sum(r["peakRss"] for r in results)

    def merged(k):
        return [x for r in results for x in r[k]]

    def total(k):
        return sum(r[k] for r in results)

    cpus = [r["cpu"] for r in results if r["cpu"]]
    wall = max((c["wallMs"] for c in cpus), default=0)
    result = {
        "runtime": f"python {platform.python_version()}",
        "profile": args["profile"],
        "mode": args["mode"],
        "calls": args["calls"],
        "threads": threads,
        "latency": summary(merged("latency")),
        "ttsLate": summary(merged("ttsLate")),
        "lag": summary(merged("lag")),
        "expectedInputFrames": round(args["calls"] * args["durationS"] * 1000 / CHUNK_MS),
        "inputFrames": total("inputFrames"),
        "ttsFrames": total("ttsFrames"),
        "transcriptions": total("transcriptions"),
        "vadStops": total("vadStops"),
        "turnPredictions": total("turnPredictions"),
        "cpuPct": sum(c["ms"] for c in cpus) / wall * 100 if wall else None,
        "peakRssSum": peak,
        "errors": merged("errors")[:5],
    }
    print("__CONCURRENCY_RESULT__" + json.dumps(result))


def _pool_run(args: dict, calls: list[int], go_at: float) -> dict:
    return asyncio.run(run_calls(args, calls, go_at=go_at))


if __name__ == "__main__":
    main()
