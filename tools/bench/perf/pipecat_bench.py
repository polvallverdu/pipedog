# Copyright (c) 2026, pipedog contributors
# SPDX-License-Identifier: BSD-2-Clause
#
# The Pipecat side of the performance benchmark (tools/bench/perf.ts): the
# scenarios of pipedog.ts, written the same way against upstream Pipecat.
# Reads its arguments as JSON from PIPEDOG_BENCH_ARGS and prints one JSON
# line prefixed with __PERF_RESULT__.

import asyncio
import json
import os
import platform
import resource
import sys
import time

T_PROCESS = time.perf_counter()

from loguru import logger  # noqa: E402

# Both sides log at WARNING, so neither pays for its debug lines.
logger.remove()
logger.add(sys.stderr, level="WARNING")

from google import genai  # noqa: E402
from google.genai import types as genai_types  # noqa: E402

from pipecat.frames.frames import (  # noqa: E402
    EndFrame,
    Frame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMTextFrame,
    TextFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
    TTSStoppedFrame,
)
from pipecat.pipeline.pipeline import Pipeline  # noqa: E402
from pipecat.pipeline.worker import PipelineWorker  # noqa: E402
from pipecat.processors.aggregators.llm_context import LLMContext  # noqa: E402
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor  # noqa: E402
from pipecat.services.google.llm import GoogleLLMService  # noqa: E402
from pipecat.services.google.tts import GeminiTTSService  # noqa: E402
from pipecat.workers.runner import WorkerRunner  # noqa: E402

IMPORT_MS = (time.perf_counter() - T_PROCESS) * 1000


def now() -> float:
    return time.perf_counter() * 1000


def rss() -> int:
    # ru_maxrss is in bytes on macOS and KiB on Linux.
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r if sys.platform == "darwin" else r * 1024


class PassThrough(FrameProcessor):
    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)


class Sink(FrameProcessor):
    """Counts the frames that reach the end of the pipeline, and wakes whoever waits."""

    def __init__(self):
        super().__init__()
        self.seen: list[tuple[Frame, float]] = []
        self._waiter = None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        self.seen.append((frame, now()))
        if self._waiter and self._waiter[0](frame):
            future = self._waiter[1]
            self._waiter = None
            future.set_result(None)
        await self.push_frame(frame, direction)

    def wait_for(self, until, timeout: float = 60.0):
        """Resolves when a frame satisfies `until`; raises after `timeout` (a failed request)."""
        future = asyncio.get_running_loop().create_future()
        self._waiter = (until, future)
        return asyncio.wait_for(future, timeout)


async def with_pipeline(processors, sink, body):
    worker = PipelineWorker(Pipeline([*processors, sink]), cancel_on_idle_timeout=False)
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    ready = asyncio.Event()

    @worker.event_handler("on_pipeline_started")
    async def on_started(worker, frame):
        ready.set()

    running = asyncio.create_task(runner.run())
    await ready.wait()
    try:
        return await body(worker)
    finally:
        await worker.queue_frame(EndFrame())
        await running


def pass_throughs(n: int):
    return [PassThrough() for _ in range(n)]


async def startup(args):
    t0 = now()
    await with_pipeline(pass_throughs(args.get("processors", 10)), Sink(), _noop)
    return {"pipelineMs": now() - t0, "importMs": IMPORT_MS, "rss": rss()}


async def _noop(worker):
    return None


async def throughput(args):
    n = args.get("frames", 20_000)
    sink = Sink()

    async def body(worker):
        async def run(count: int) -> float:
            sink.seen = []
            got = 0

            def until(f):
                nonlocal got
                if isinstance(f, TextFrame):
                    got += 1
                return got == count

            done = sink.wait_for(until)
            t0 = now()
            await worker.queue_frames([TextFrame(f"{i}") for i in range(count)])
            await done
            return now() - t0

        await run(min(2000, n))  # warm-up
        ms = await run(n)
        return {"frames": n, "ms": ms, "framesPerSec": n / ms * 1000, "rss": rss()}

    return await with_pipeline(pass_throughs(args.get("processors", 10)), sink, body)


async def hop(args):
    n = args.get("frames", 2000)
    batch = 100
    sink = Sink()

    async def body(worker):
        async def once():
            done = sink.wait_for(lambda f: isinstance(f, TextFrame))
            await worker.queue_frame(TextFrame("x"))
            await done

        for _ in range(200):  # warm-up
            await once()
        per_frame_us = []
        for _ in range(n // batch):
            t0 = now()
            for _ in range(batch):
                await once()
            per_frame_us.append((now() - t0) / batch * 1000)
            sink.seen = []
        return {"roundTrips": n, "perFrameUs": per_frame_us}

    return await with_pipeline(pass_throughs(args.get("processors", 10)), sink, body)


PROMPT = "In one sentence, what is a voice agent?"
TTS_TEXT = "Hello! Thanks for calling. How can I help you today?"


async def alternate(requests: int, pipeline, sdk):
    for i in range(requests):
        if i % 2:
            await sdk()
            await pipeline()
        else:
            await pipeline()
            await sdk()


async def llm(args):
    model = args.get("llmModel", "gemini-3.5-flash-lite")
    api_key = args["apiKey"]
    service = GoogleLLMService(api_key=api_key, settings=GoogleLLMService.Settings(model=model))
    sink = Sink()
    client = genai.Client(api_key=api_key)
    rows = []

    async def sdk():
        t0 = now()
        first = 0.0
        stream = await client.aio.models.generate_content_stream(
            model=model,
            contents=[genai_types.Content(role="user", parts=[genai_types.Part(text=PROMPT)])],
            # What GoogleLLMService sends for this model when thinking isn't configured.
            config=genai_types.GenerateContentConfig(
                thinking_config=genai_types.ThinkingConfig(
                    thinking_level=genai_types.ThinkingLevel.MINIMAL
                )
            ),
        )
        async for chunk in stream:
            if not first and chunk.text:
                first = now()
        rows.append({"via": "sdk", "ttfbMs": first - t0 if first else None, "totalMs": now() - t0})

    async def body(worker):
        async def pipeline():
            sink.seen = []
            done = sink.wait_for(lambda f: isinstance(f, LLMFullResponseEndFrame))
            context = LLMContext(messages=[{"role": "user", "content": PROMPT}])
            t0 = now()
            await worker.queue_frame(LLMContextFrame(context))
            await done
            first = next((at for f, at in sink.seen if isinstance(f, LLMTextFrame)), None)
            ttfb = first - t0 if first is not None else None
            rows.append({"via": "pipeline", "ttfbMs": ttfb, "totalMs": now() - t0})

        await alternate(args.get("requests", 5), pipeline, sdk)

    await with_pipeline([service], sink, body)
    return {"model": model, "rows": rows}


async def tts(args):
    model = args.get("ttsModel", "gemini-3.8-flash-tts")
    api_key = args["apiKey"]
    voice = "Kore"
    service = GeminiTTSService(
        api_key=api_key, settings=GeminiTTSService.Settings(model=model, voice=voice)
    )
    sink = Sink()
    client = genai.Client(api_key=api_key)
    rows = []

    async def sdk():
        t0 = now()
        first = 0.0
        stream = await client.aio.models.generate_content_stream(
            model=model,
            contents=TTS_TEXT,
            config=genai_types.GenerateContentConfig(
                response_modalities=["AUDIO"],
                speech_config=genai_types.SpeechConfig(
                    language_code="en-US",
                    voice_config=genai_types.VoiceConfig(
                        prebuilt_voice_config=genai_types.PrebuiltVoiceConfig(voice_name=voice)
                    ),
                ),
            ),
        )
        async for chunk in stream:
            parts = (
                chunk.candidates[0].content.parts
                if chunk.candidates and chunk.candidates[0].content
                else None
            ) or []
            if not first and any(p.inline_data and p.inline_data.data for p in parts):
                first = now()
        rows.append({"via": "sdk", "ttfbMs": first - t0 if first else None, "totalMs": now() - t0})

    async def body(worker):
        async def pipeline():
            sink.seen = []
            done = sink.wait_for(lambda f: isinstance(f, TTSStoppedFrame))
            t0 = now()
            await worker.queue_frame(TTSSpeakFrame(TTS_TEXT))
            await done
            first = next((at for f, at in sink.seen if isinstance(f, TTSAudioRawFrame)), None)
            ttfb = first - t0 if first is not None else None
            rows.append({"via": "pipeline", "ttfbMs": ttfb, "totalMs": now() - t0})

        await alternate(args.get("requests", 3), pipeline, sdk)

    await with_pipeline([service], sink, body)
    return {"model": model, "rows": rows}


SCENARIOS = {"startup": startup, "throughput": throughput, "hop": hop, "llm": llm, "tts": tts}


async def main():
    args = json.loads(os.environ.get("PIPEDOG_BENCH_ARGS", '{"scenario": "startup"}'))
    result = await SCENARIOS[args["scenario"]](args)
    runtime = f"python {platform.python_version()}"
    print("__PERF_RESULT__" + json.dumps({"runtime": runtime, "scenario": args["scenario"], **result}))


if __name__ == "__main__":
    asyncio.run(main())
