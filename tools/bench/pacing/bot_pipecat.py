# Copyright (c) 2026, pipedog contributors
# SPDX-License-Identifier: BSD-2-Clause
#
# The Pipecat side of the pacing benchmark (tools/bench/pacing.ts): the scenario of bot.ts,
# against upstream Pipecat. Environment: PACING_PORT, PACING_LOAD.

import asyncio
import math
import os
import sys
import time

import numpy as np
from loguru import logger

logger.remove()
logger.add(sys.stderr, level="WARNING")

from pipecat.frames.frames import EndFrame, TTSAudioRawFrame  # noqa: E402
from pipecat.pipeline.pipeline import Pipeline  # noqa: E402
from pipecat.pipeline.worker import PipelineParams, PipelineWorker  # noqa: E402
from pipecat.serializers.telnyx import TelnyxFrameSerializer  # noqa: E402
from pipecat.transports.websocket.server import (  # noqa: E402
    SingleClientWebsocketServerParams,
    SingleClientWebsocketServerTransport,
)
from pipecat.workers.runner import WorkerRunner  # noqa: E402

PORT = int(os.environ.get("PACING_PORT", "8765"))
LOAD = float(os.environ.get("PACING_LOAD", "0"))

RATE = 24000
FRAME_MS = 40
UTTERANCE_SECS = 6
PAUSE_SECS = 3


def utterance():
    per_frame = RATE * FRAME_MS // 1000
    total = UTTERANCE_SECS * 1000 // FRAME_MS * per_frame
    t = np.arange(total) / RATE
    env = 0.5 + 0.5 * np.sin(2 * math.pi * 4 * t)
    s = (
        0.2 * np.sin(2 * math.pi * 220 * t)
        + 0.12 * np.sin(2 * math.pi * 660 * t)
        + 0.06 * np.sin(2 * math.pi * 1800 * t)
    )
    pcm = np.round(env * s * 32767).astype(np.int16)
    return [
        TTSAudioRawFrame(audio=pcm[i : i + per_frame].tobytes(), sample_rate=RATE, num_channels=1)
        for i in range(0, total, per_frame)
    ]


async def background_load():
    if LOAD <= 0:
        return
    while True:
        end = time.perf_counter() + 0.01 * LOAD
        while time.perf_counter() < end:
            pass
        await asyncio.sleep(0.01 * (1 - LOAD))


async def main():
    transport = SingleClientWebsocketServerTransport(
        params=SingleClientWebsocketServerParams(
            audio_out_enabled=True,
            serializer=TelnyxFrameSerializer(
                stream_id="pacing-stream",
                outbound_encoding="PCMU",
                inbound_encoding="PCMU",
                params=TelnyxFrameSerializer.InputParams(auto_hang_up=False),
            ),
        ),
        host="127.0.0.1",
        port=PORT,
    )
    worker = PipelineWorker(
        Pipeline([transport.input(), transport.output()]),
        params=PipelineParams(audio_out_sample_rate=RATE),
        cancel_on_idle_timeout=False,
    )

    @transport.event_handler("on_client_connected")
    async def on_connected(transport, websocket):
        async def play():
            load = asyncio.create_task(background_load())
            await worker.queue_frames(utterance())
            await asyncio.sleep(UTTERANCE_SECS + PAUSE_SECS)
            await worker.queue_frames(utterance())
            await asyncio.sleep(UTTERANCE_SECS + PAUSE_SECS)
            load.cancel()
            await worker.queue_frame(EndFrame())

        asyncio.create_task(play())

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    print("__PACING_READY__", flush=True)
    await runner.run()


asyncio.run(main())
