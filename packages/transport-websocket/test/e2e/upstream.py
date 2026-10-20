# Copyright (c) 2026, pipedog contributors
# SPDX-License-Identifier: BSD-2-Clause
#
# Upstream Pipecat ends of the WebSocket end-to-end runs (see run.ts), the
# same as apps.ts: an echo bot behind SingleClientWebsocketServerTransport,
# and a WebsocketClientTransport that sends audio and transport messages and
# checks the echoes. Both use ProtobufFrameSerializer.
#
#   python upstream.py server <port>   -> prints E2E_READY, exits when the client leaves
#   python upstream.py client <uri>    -> prints E2E_RESULT <json>
#
# Needs a Python with pipecat (and its websockets extra) installed.

import asyncio
import json
import sys

from loguru import logger

from pipecat.frames.frames import (
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InputTransportMessageFrame,
    OutputAudioRawFrame,
    OutputTransportMessageFrame,
    OutputTransportMessageUrgentFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.serializers.protobuf import ProtobufFrameSerializer
from pipecat.transports.websocket.client import WebsocketClientParams, WebsocketClientTransport
from pipecat.transports.websocket.server import (
    SingleClientWebsocketServerParams,
    SingleClientWebsocketServerTransport,
)
from pipecat.workers.runner import WorkerRunner

SAMPLE_RATE = 16000

# Same vectors as apps.ts.
TEST_MESSAGE = {
    "label": "e2e",
    "text": 'héllo wörld 🐶   "quoted"',
    "nested": {"list": [1, 2.5, -3e-7, None, True, False, "x"], "empty": {}},
    "big": 9007199254740991,
}
URGENT_MESSAGE = {"label": "e2e", "urgent": True, "n": 0.1}


def test_audio() -> bytes:
    return bytes(((i * 7 + 3) & 0xFF) for i in range(int(SAMPLE_RATE * 2 * 0.2)))


def audio_params() -> dict:
    return dict(
        audio_in_enabled=True,
        audio_in_sample_rate=SAMPLE_RATE,
        audio_out_enabled=True,
        audio_out_sample_rate=SAMPLE_RATE,
    )


def pipeline_params() -> PipelineParams:
    return PipelineParams(audio_in_sample_rate=SAMPLE_RATE, audio_out_sample_rate=SAMPLE_RATE)


class EchoProcessor(FrameProcessor):
    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            await self.push_frame(
                OutputAudioRawFrame(
                    audio=frame.audio,
                    sample_rate=frame.sample_rate,
                    num_channels=frame.num_channels,
                )
            )
        elif (
            isinstance(frame, InputTransportMessageFrame)
            and direction == FrameDirection.DOWNSTREAM
        ):
            await self.push_frame(OutputTransportMessageUrgentFrame(message={"echo": frame.message}))
        else:
            await self.push_frame(frame, direction)


async def run_worker(worker: PipelineWorker):
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await runner.run()


async def server(port: int):
    transport = SingleClientWebsocketServerTransport(
        SingleClientWebsocketServerParams(
            **audio_params(), serializer=ProtobufFrameSerializer(), allowed_origins=[]
        ),
        host="127.0.0.1",
        port=port,
    )
    worker = PipelineWorker(
        Pipeline([transport.input(), EchoProcessor(), transport.output()]),
        params=pipeline_params(),
        cancel_on_idle_timeout=False,
    )

    @transport.event_handler("on_websocket_ready")
    async def on_ready(transport):
        print("E2E_READY", flush=True)

    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(transport, websocket):
        await worker.queue_frame(EndFrame())

    await run_worker(worker)


class Collector(FrameProcessor):
    def __init__(self, expected_audio: int, expected_messages: int, done):
        super().__init__()
        self.audio = bytearray()
        self.messages = []
        self._expected_audio = expected_audio
        self._expected_messages = expected_messages
        self._done = done

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            self.audio.extend(frame.audio)
        elif (
            isinstance(frame, InputTransportMessageFrame)
            and direction == FrameDirection.DOWNSTREAM
        ):
            self.messages.append(frame.message)
        else:
            await self.push_frame(frame, direction)
        if len(self.audio) >= self._expected_audio and len(self.messages) >= self._expected_messages:
            await self._done()


async def client(uri: str, timeout: float = 10.0) -> dict:
    audio = test_audio()
    messages = [TEST_MESSAGE, URGENT_MESSAGE]
    transport = WebsocketClientTransport(
        uri,
        WebsocketClientParams(
            **audio_params(), serializer=ProtobufFrameSerializer(), add_wav_header=False
        ),
    )
    finished = False
    worker: PipelineWorker | None = None

    async def finish():
        nonlocal finished
        if finished:
            return
        finished = True
        await worker.queue_frame(EndFrame())

    collector = Collector(len(audio), len(messages), finish)
    worker = PipelineWorker(
        Pipeline([transport.input(), collector, transport.output()]),
        params=pipeline_params(),
        cancel_on_idle_timeout=False,
    )

    @transport.event_handler("on_connected")
    async def on_connected(transport, websocket):
        chunk = SAMPLE_RATE * 2 // 50
        frames = [
            OutputAudioRawFrame(audio=audio[i : i + chunk], sample_rate=SAMPLE_RATE, num_channels=1)
            for i in range(0, len(audio), chunk)
        ]
        frames.append(OutputTransportMessageFrame(message=messages[0]))
        frames.append(OutputTransportMessageUrgentFrame(message=messages[1]))
        await worker.queue_frames(frames)

    error = None

    async def watchdog():
        nonlocal error
        await asyncio.sleep(timeout)
        error = f"timed out after {timeout}s"
        await finish()

    dog = asyncio.create_task(watchdog())
    try:
        await run_worker(worker)
    finally:
        dog.cancel()

    received = bytes(collector.audio)
    audio_matches = received[: len(audio)] == audio
    expected = sorted(json.dumps({"echo": m}, sort_keys=True) for m in messages)
    got = sorted(json.dumps(m, sort_keys=True) for m in collector.messages)
    messages_match = expected == got
    return {
        "ok": error is None and audio_matches and messages_match,
        "audioSent": len(audio),
        "audioReceived": len(received),
        "audioMatches": audio_matches,
        "messages": collector.messages,
        "messagesMatch": messages_match,
        "error": error,
    }


def main():
    logger.remove()
    logger.add(sys.stderr, level="WARNING")
    role = sys.argv[1]
    if role == "server":
        asyncio.run(server(int(sys.argv[2])))
    elif role == "client":
        result = asyncio.run(client(sys.argv[2]))
        print("E2E_RESULT " + json.dumps(result), flush=True)
        sys.exit(0 if result["ok"] else 1)
    else:
        raise SystemExit(f"unknown role {role}")


if __name__ == "__main__":
    main()
