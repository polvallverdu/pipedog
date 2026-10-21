# Copyright (c) 2026, pipedog contributors
# SPDX-License-Identifier: BSD-2-Clause
#
# Golden vectors for the serializer packages, produced by upstream pipecat.
#
# Runs upstream's ProtobufFrameSerializer, TelnyxFrameSerializer,
# RTVIClientSerializer and the telephony serializers in telephony.py (Twilio,
# Plivo, Exotel, Vonage, Genesys) on fixed inputs and writes what they produce to each
# package's test/fixtures/golden.json, which pipedog's golden tests replay.
#
#   <python with upstream pipecat + soxr + aiohttp installed> -I tools/golden/serializers.py [names]
#
# Names select what to regenerate (protobuf, telnyx, rtvi_client, twilio, plivo,
# exotel, vonage, genesys); none regenerates everything.
#
# (e.g. a venv with `pip install -e .upstream/pipecat aiohttp soxr`), then
# `bun test packages/serializer-*`. Needs `bunx` on PATH to format the output.
#
# The inputs are described as JSON so the TypeScript tests can rebuild the
# same frames. Frame ids and names are set explicitly so the bytes are stable.

import asyncio
import json
import math
import os
import subprocess
import sys
from types import SimpleNamespace

from loguru import logger

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, ".upstream", "pipecat", "src"))

import pipecat.frames.protobufs.frames_pb2 as pb  # noqa: E402
from pipecat.frames.frames import (  # noqa: E402
    CancelFrame,
    EndFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    OutputTransportMessageFrame,
    OutputTransportMessageUrgentFrame,
    TextFrame,
    TranscriptionFrame,
)
from pipecat.serializers.protobuf import ProtobufFrameSerializer  # noqa: E402
from pipecat.serializers.rtvi_client import RTVIClientSerializer  # noqa: E402
from pipecat.serializers.telnyx import TelnyxFrameSerializer  # noqa: E402

logger.remove()


def write(package: str, data: dict):
    path = os.path.join(ROOT, "packages", package, "test", "fixtures", "golden.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write("\n")
    # Format as the repo's linter expects.
    subprocess.run(["bunx", "biome", "format", "--write", path], cwd=ROOT, capture_output=True)
    print(f"wrote {os.path.relpath(path, ROOT)}")


def sine_pcm(rate: int, n: int, freqs=(440.0, 1250.0), amp=9000.0, phase0=0) -> bytes:
    """Deterministic 16-bit PCM test signal."""
    out = bytearray()
    for i in range(n):
        t = (i + phase0) / rate
        v = sum(math.sin(2 * math.pi * f * t) for f in freqs) * amp / len(freqs)
        s = max(-32768, min(32767, int(round(v))))
        out += s.to_bytes(2, "little", signed=True)
    return bytes(out)


async def try_serialize(s, frame):
    """The serializer's output, or the name of the exception it raised."""
    try:
        return await s.serialize(frame)
    except Exception as e:
        return {"error": type(e).__name__}


def frame_fields(frame, fields):
    out = {"type": type(frame).__name__}
    for f in fields:
        v = getattr(frame, f)
        if isinstance(v, bytes):
            v = {"hex": v.hex()}
        elif hasattr(v, "value") and not isinstance(v, (str, int, float)):
            v = v.value
        out[f] = v
    return out


# ---------------------------------------------------------------------------
# Protobuf

MESSAGES = [
    {"type": "hello"},
    {},
    {"a": {"b": [1, 2, {"c": None}], "d": True, "e": False}},
    {"unicode": "héllo wörld — 你好 🎉", "emoji": "\U0001f600", "ctl": "tab\tnl\n\"q\"\\"},
    {"floats": [0.1, 1.5, -2.25, 1e-07, 1.7976931348623157e308, 123456.789, 1e21, 5e-324]},
    {"ints": [0, -1, 42, 2**31, 2**53 - 1, -(2**53) + 1]},
    [1, "two", 3.5, None, True],
    "just a string",
    {"label": "rtvi-ai", "type": "bot-ready", "id": "1", "data": {"version": "1.0.0"}},
    {"label": "rtvi-ai", "type": "server-message", "data": {"k": "v"}},
    {"nested": {"deep": {"deeper": {"deepest": ["x", {"y": "ü"}]}}}},
    {"key with spaces": 1, "ключ": "значение", "": "empty key"},
]


def make_frame(spec):
    kind = spec["kind"]
    if kind == "text":
        f = TextFrame(text=spec["text"])
    elif kind == "audio":
        f = OutputAudioRawFrame(
            audio=bytes.fromhex(spec["audio"]),
            sample_rate=spec["sample_rate"],
            num_channels=spec["num_channels"],
        )
    elif kind == "transcription":
        f = TranscriptionFrame(
            text=spec["text"], user_id=spec["user_id"], timestamp=spec["timestamp"]
        )
    elif kind == "interruption":
        f = InterruptionFrame()
    elif kind == "message":
        f = OutputTransportMessageFrame(message=spec["message"])
    elif kind == "message_urgent":
        f = OutputTransportMessageUrgentFrame(message=spec["message"])
    else:
        raise ValueError(kind)
    f.id = spec["id"]
    f.name = spec["name"]
    if "pts" in spec:
        f.pts = spec["pts"]
    return f


async def protobuf():
    s = ProtobufFrameSerializer()
    audio = sine_pcm(16000, 160)
    specs = [
        {"kind": "text", "id": 1, "name": "TextFrame#0", "text": "hello"},
        {"kind": "text", "id": 7, "name": "TextFrame#1", "text": "héllo 🌍 — 你好"},
        {"kind": "text", "id": 0, "name": "", "text": ""},
        {"kind": "text", "id": 2**40 + 5, "name": "Big#id", "text": "x"},
        {"kind": "text", "id": 2**53 - 1, "name": "Max#id", "text": "y"},
        {
            "kind": "audio",
            "id": 3,
            "name": "OutputAudioRawFrame#0",
            "audio": audio.hex(),
            "sample_rate": 16000,
            "num_channels": 1,
        },
        {
            "kind": "audio",
            "id": 4,
            "name": "OutputAudioRawFrame#1",
            "audio": sine_pcm(48000, 960, amp=20000).hex(),
            "sample_rate": 48000,
            "num_channels": 2,
            "pts": 1234567890123,
        },
        {
            "kind": "audio",
            "id": 5,
            "name": "a",
            "audio": "",
            "sample_rate": 8000,
            "num_channels": 1,
            "pts": 0,
        },
        {
            "kind": "transcription",
            "id": 9,
            "name": "TranscriptionFrame#0",
            "text": "¿Qué tal? Ça va — 日本語 👍",
            "user_id": "üser-1",
            "timestamp": "2026-10-21T10:00:00.123+00:00",
        },
        {
            "kind": "transcription",
            "id": 10,
            "name": "TranscriptionFrame#1",
            "text": "",
            "user_id": "",
            "timestamp": "",
        },
        {"kind": "interruption", "id": 11, "name": "InterruptionFrame#0"},
        {"kind": "interruption", "id": 0, "name": ""},
    ]
    for i, m in enumerate(MESSAGES):
        specs.append({"kind": "message", "id": 100 + i, "name": f"M#{i}", "message": m})
        specs.append({"kind": "message_urgent", "id": 200 + i, "name": f"U#{i}", "message": m})

    serialize = []
    for spec in specs:
        out = await s.serialize(make_frame(spec))
        serialize.append({"input": spec, "hex": None if out is None else out.hex()})

    # Deserialization of upstream-produced bytes.
    def enc(**kw):
        return pb.Frame(**kw).SerializeToString()

    deser_inputs = [
        ("text", enc(text=pb.TextFrame(id=12, name="TextFrame#9", text="hi ✓"))),
        ("text no id", enc(text=pb.TextFrame(text="plain"))),
        ("text big id", enc(text=pb.TextFrame(id=2**40 + 1, name="n", text="big"))),
        (
            "audio",
            enc(
                audio=pb.AudioRawFrame(
                    id=13,
                    name="Audio#1",
                    audio=audio,
                    sample_rate=16000,
                    num_channels=1,
                )
            ),
        ),
        (
            "audio pts",
            enc(
                audio=pb.AudioRawFrame(
                    id=14, audio=audio[:32], sample_rate=24000, num_channels=2, pts=987654321
                )
            ),
        ),
        (
            "transcription",
            enc(
                transcription=pb.TranscriptionFrame(
                    id=15, name="T", text="über 🎤", user_id="u1", timestamp="ts"
                )
            ),
        ),
        ("message", enc(message=pb.MessageFrame(data=json.dumps(MESSAGES[3])))),
        ("message floats", enc(message=pb.MessageFrame(data=json.dumps(MESSAGES[4])))),
        ("message nested", enc(message=pb.MessageFrame(data=json.dumps(MESSAGES[2])))),
        ("message invalid json", enc(message=pb.MessageFrame(data="{not json"))),
        ("message empty", enc(message=pb.MessageFrame(data=""))),
        ("interruption", enc(interruption=pb.InterruptionFrame(id=16, name="I"))),
        ("interruption empty", enc(interruption=pb.InterruptionFrame())),
        ("empty frame", b""),
        # Unknown field 15 (varint) inside the TextFrame, and field 9 at top level.
        (
            "unknown inner field",
            enc(text=pb.TextFrame(id=17, text="u")) + b"",
        ),
        ("unknown top-level field", bytes([0x48, 0x01])),
    ]
    # Rebuild "unknown inner field": TextFrame bytes + tag(15, varint) + 1.
    inner = pb.TextFrame(id=17, text="u").SerializeToString() + bytes([0x78, 0x01])
    deser_inputs[14] = ("unknown inner field", bytes([0x0A, len(inner)]) + inner)
    # Unknown fields after a known oneof member.
    deser_inputs.append(
        (
            "unknown trailing field",
            enc(text=pb.TextFrame(id=18, text="t")) + bytes([0x50, 0x96, 0x01]),
        )
    )

    # Python's json.loads accepts NaN/Infinity, which json.dumps emits.
    deser_inputs.append(
        ("message NaN", enc(message=pb.MessageFrame(data=json.dumps({"x": float("nan"), "y": float("inf")}))))
    )
    # uint64 beyond 2^53.
    deser_inputs.append(("text huge id", enc(text=pb.TextFrame(id=2**63 + 1, text="h"))))
    # Truncated message and invalid UTF-8 in a proto3 string field.
    full = enc(text=pb.TextFrame(id=19, text="truncated"))
    deser_inputs.append(("truncated", full[:-3]))
    bad = bytes([0x08, 0x14, 0x1A, 0x02, 0xC3, 0x28])
    deser_inputs.append(("invalid utf-8 string", bytes([0x0A, len(bad)]) + bad))

    deserialize = []
    for label, data in deser_inputs:
        try:
            frame = await s.deserialize(data)
        except Exception as e:
            deserialize.append({"label": label, "hex": data.hex(), "error": type(e).__name__})
            continue
        if frame is None:
            out = None
        else:
            fields = {
                "TextFrame": ["text"],
                "InputAudioRawFrame": ["audio", "sample_rate", "num_channels"],
                "TranscriptionFrame": ["text", "user_id", "timestamp"],
                "InputTransportMessageFrame": ["message"],
                "InterruptionFrame": [],
            }[type(frame).__name__]
            out = frame_fields(frame, fields)
            if "message" in out:
                # As Python's json.dumps writes it (NaN and Infinity are not JSON).
                out["message"] = json.dumps(out["message"])
            pfield = pb.Frame.FromString(data).WhichOneof("frame")
            sub = getattr(pb.Frame.FromString(data), pfield)
            # As a string: uint64 ids may exceed 2^53.
            out["id"] = str(frame.id) if getattr(sub, "id", 0) else None
            out["name"] = frame.name if getattr(sub, "name", "") else None
            out["pts"] = frame.pts
        deserialize.append({"label": label, "hex": data.hex(), "frame": out})

    write("serializer-protobuf", {"serialize": serialize, "deserialize": deserialize})


# ---------------------------------------------------------------------------
# Telnyx

CHUNK_MS = 20


async def telnyx():
    cases = []
    for enc in ("PCMU", "PCMA"):
        for rate in (8000, 16000, 24000):
            # Input: Telnyx 8 kHz encoded -> PCM at the pipeline rate.
            s = TelnyxFrameSerializer(
                stream_id="s",
                outbound_encoding=enc,
                inbound_encoding=enc,
                params=TelnyxFrameSerializer.InputParams(auto_hang_up=False),
            )
            await s.setup(SimpleNamespace(audio_in_sample_rate=rate))
            src = sine_pcm(8000, 8000 * CHUNK_MS // 1000 * 10, amp=12000)
            # Encode the source with the serializer itself (8k -> 8k, no resampling).
            encoder = TelnyxFrameSerializer(
                stream_id="s",
                outbound_encoding=enc,
                inbound_encoding=enc,
                params=TelnyxFrameSerializer.InputParams(auto_hang_up=False),
            )
            step = 8000 * CHUNK_MS // 1000 * 2
            messages = []
            for i in range(0, len(src), step):
                out = await encoder.serialize(
                    OutputAudioRawFrame(audio=src[i : i + step], sample_rate=8000, num_channels=1)
                )
                messages.append(out)
            in_chunks = []
            for m in messages:
                f = await s.deserialize(m)
                in_chunks.append(f.audio.hex() if f is not None else None)
            # Output: PCM at the pipeline rate -> 8 kHz encoded.
            pcm = sine_pcm(rate, rate * CHUNK_MS // 1000 * 10, amp=12000)
            ostep = rate * CHUNK_MS // 1000 * 2
            out_msgs = []
            for i in range(0, len(pcm), ostep):
                out = await s.serialize(
                    OutputAudioRawFrame(audio=pcm[i : i + ostep], sample_rate=rate, num_channels=1)
                )
                out_msgs.append(out)
            cases.append(
                {
                    "encoding": enc,
                    "rate": rate,
                    "source8k": src.hex(),
                    "mediaMessages": messages,
                    "deserialized": in_chunks,
                    "pipelinePcm": pcm.hex(),
                    "serialized": out_msgs,
                }
            )

    s = TelnyxFrameSerializer(
        stream_id="s",
        outbound_encoding="PCMU",
        inbound_encoding="PCMU",
        params=TelnyxFrameSerializer.InputParams(auto_hang_up=False),
    )
    await s.setup(SimpleNamespace(audio_in_sample_rate=16000))
    events = []
    for raw in [
        json.dumps({"event": "dtmf", "dtmf": {"digit": d}})
        for d in ["0", "1", "5", "9", "*", "#", "A", "", "10"]
    ] + [
        json.dumps({"event": "dtmf"}),
        json.dumps({"event": "connected", "version": "1.0.0"}),
        json.dumps(
            {
                "event": "start",
                "sequence_number": "1",
                "start": {
                    "call_control_id": "v3:abc",
                    "media_format": {"encoding": "PCMU", "sample_rate": 8000, "channels": 1},
                },
                "stream_id": "s",
            }
        ),
        json.dumps({"event": "stop", "stop": {"call_control_id": "v3:abc"}, "stream_id": "s"}),
        json.dumps({"event": "mark", "mark": {"name": "m"}}),
        json.dumps({"event": "media", "media": {}}),
        json.dumps({"event": "media", "media": {"payload": ""}}),
        "not json",
        json.dumps({"no": "event"}),
    ]:
        f = await s.deserialize(raw)
        if f is None:
            out = None
        elif type(f).__name__ == "InputDTMFFrame":
            out = {"type": "InputDTMFFrame", "button": f.button.value}
        else:
            out = {"type": type(f).__name__, "len": len(f.audio)}
        events.append({"input": raw, "frame": out})

    serialize_misc = []
    serialize_misc.append({"input": {"kind": "interruption"}, "out": await s.serialize(InterruptionFrame())})
    for m in MESSAGES:
        serialize_misc.append(
            {"input": {"kind": "message", "message": m}, "out": await try_serialize(s, OutputTransportMessageFrame(message=m))}
        )
        serialize_misc.append(
            {
                "input": {"kind": "message_urgent", "message": m},
                "out": await try_serialize(s, OutputTransportMessageUrgentFrame(message=m)),
            }
        )
    serialize_misc.append({"input": {"kind": "end"}, "out": await s.serialize(EndFrame())})

    hangup = await telnyx_hangup()
    write(
        "serializer-telnyx",
        {"audio": cases, "events": events, "serializeMisc": serialize_misc, "hangup": hangup},
    )


async def telnyx_hangup():
    import aiohttp
    from aiohttp import web

    results = []
    for status, body in [
        (200, '{"data": {"result": "ok"}}'),
        (422, '{"errors": [{"code": "90018", "title": "Call has already ended"}]}'),
        (422, '{"errors": [{"code": "90015", "title": "Other"}]}'),
        (422, "not json"),
        (500, "internal error"),
    ]:
        captured = {}

        async def handler(request, status=status, body=body, captured=captured):
            captured["method"] = request.method
            captured["path"] = request.path_qs
            # Host carries the random local port.
            captured["headers"] = {
                k.lower(): v for k, v in request.headers.items() if k.lower() != "host"
            }
            captured["body"] = (await request.read()).decode()
            return web.Response(status=status, text=body, content_type="application/json")

        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", handler)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]

        orig_post = aiohttp.ClientSession.post

        def post(self, url, *args, **kwargs):
            url = str(url).replace("https://api.telnyx.com", f"http://127.0.0.1:{port}")
            return orig_post(self, url, *args, **kwargs)

        aiohttp.ClientSession.post = post
        logs = []
        sink = logger.add(lambda m: logs.append([m.record["level"].name, m.record["message"]]))
        try:
            s = TelnyxFrameSerializer(
                stream_id="s",
                outbound_encoding="PCMU",
                inbound_encoding="PCMU",
                call_control_id="v3:call/ctrl id",
                api_key="KEY_123",
            )
            out1 = await s.serialize(EndFrame())
            out2 = await s.serialize(CancelFrame())
        finally:
            aiohttp.ClientSession.post = orig_post
            logger.remove(sink)
            await runner.cleanup()
        results.append(
            {
                "status": status,
                "responseBody": body,
                "request": captured,
                "logs": logs,
                "serializeEnd": out1,
                "serializeCancelAfter": out2,
            }
        )
    return results


# ---------------------------------------------------------------------------
# RTVI client


async def rtvi_client():
    s = RTVIClientSerializer()
    serialize = []
    inputs = [
        {"kind": "message", "message": {"label": "rtvi-ai", "type": "client-ready", "id": "c1", "data": {"version": "1.0.0", "about": {"library": "pipecat"}}}},
        {"kind": "message_urgent", "message": {"label": "rtvi-ai", "type": "send-text", "id": "c2", "data": {"content": "héllo 🌍", "options": {"run_immediately": True, "audio_response": False}}}},
        {"kind": "message", "message": {"label": "rtvi-ai", "type": "client-message", "id": "c3", "data": {"t": "x", "d": {"f": 0.1, "n": None, "l": [1, 2.5]}}}},
        {"kind": "message", "message": {"label": "other", "type": "client-ready"}},
        {"kind": "message", "message": ["label", "rtvi-ai"]},
        {"kind": "audio", "audio": sine_pcm(16000, 160).hex(), "sample_rate": 16000, "num_channels": 1},
        {"kind": "audio", "audio": "0001ff7f", "sample_rate": 24000, "num_channels": 2},
        {"kind": "text", "text": "ignored"},
    ]
    for spec in inputs:
        k = spec["kind"]
        if k == "message":
            f = OutputTransportMessageFrame(message=spec["message"])
        elif k == "message_urgent":
            f = OutputTransportMessageUrgentFrame(message=spec["message"])
        elif k == "audio":
            f = OutputAudioRawFrame(
                audio=bytes.fromhex(spec["audio"]),
                sample_rate=spec["sample_rate"],
                num_channels=spec["num_channels"],
            )
        else:
            f = TextFrame(text=spec["text"])
        serialize.append({"input": spec, "out": await s.serialize(f)})

    def m(t, data=None, **extra):
        d = {"label": "rtvi-ai", "type": t, "id": "x"}
        if data is not None:
            d["data"] = data
        d.update(extra)
        return json.dumps(d)

    FIELDS = {
        "LLMFullResponseStartFrame": [],
        "LLMFullResponseEndFrame": [],
        "LLMTextFrame": ["text"],
        "LLMMarkerResponseFrame": ["raw", "marker", "kind", "markers"],
        "TTSTextFrame": ["text", "text_type"],
        "BotStartedSpeakingFrame": [],
        "BotStoppedSpeakingFrame": [],
        "InterruptionFrame": [],
        "FunctionCallInProgressFrame": ["function_name", "tool_call_id", "arguments"],
        "FunctionCallCancelFrame": ["function_name", "tool_call_id"],
        "FunctionCallResultFrame": ["function_name", "tool_call_id", "arguments", "result"],
        "TranscriptionFrame": ["text", "user_id", "timestamp"],
        "InterimTranscriptionFrame": ["text", "user_id", "timestamp"],
    }
    deser_inputs = [
        m("bot-llm-started"),
        m("bot-llm-text", {"text": "Hi 👋"}),
        m("bot-llm-text", {}),
        m("bot-llm-marker", {"raw": "<x/>", "text": "x", "kind": "complete", "markers": ["a", "b"]}),
        m("bot-llm-marker", {"raw": "r", "text": "", "markers": None}),
        m("bot-llm-stopped"),
        m("bot-tts-text", {"text": "Spoken ü"}),
        m("bot-started-speaking"),
        m("bot-stopped-speaking"),
        m("bot-interrupted"),
        m("llm-function-call-in-progress", {"function_name": "get_weather", "tool_call_id": "t1", "arguments": {"city": "Zürich", "n": 1.5}}),
        m("llm-function-call-in-progress", {"tool_call_id": "t2"}),
        m("llm-function-call-stopped", {"function_name": "f", "tool_call_id": "t3", "cancelled": True}),
        m("llm-function-call-stopped", {"function_name": "f", "tool_call_id": "t4", "cancelled": False, "result": {"ok": [1, 2]}}),
        m("llm-function-call-stopped", {"tool_call_id": "t5"}),
        m("user-transcription", {"text": "hola qué tal", "user_id": "u", "timestamp": "2026", "final": True}),
        m("user-transcription", {"text": "hol", "user_id": "u", "timestamp": "2026", "final": False}),
        m("user-transcription", {"text": "x"}),
        m("bot-ready", {"version": "1.0.0"}),
        m("metrics", {"processing": []}),
        m("bot-llm-started", "not a dict"),
        json.dumps({"label": "other", "type": "bot-llm-started"}),
        json.dumps([1, 2]),
        "not json",
        json.dumps({"type": "bot-llm-text"}),
        m("bot-llm-text", "a string payload"),
        m("bot-llm-text", []),
        m("bot-llm-marker", {"raw": "r", "markers": {"k1": 1, "k2": 2}}),
        m("bot-llm-marker", {"raw": "r", "markers": "ab"}),
        m("bot-llm-marker", {"raw": "r", "markers": 5}),
        m("user-transcription", {"text": "t", "final": 0}),
        m("user-transcription", {"text": "t", "final": None}),
        m("llm-function-call-stopped", {"tool_call_id": "t6", "cancelled": "yes"}),
        m("llm-function-call-in-progress", {"tool_call_id": "t7", "arguments": []}),
    ]
    deserialize = []
    for raw in deser_inputs:
        try:
            f = await s.deserialize(raw)
        except Exception as e:
            deserialize.append({"input": raw, "error": type(e).__name__})
            continue
        out = None if f is None else frame_fields(f, FIELDS[type(f).__name__])
        deserialize.append({"input": raw, "frame": out})
    write("serializer-rtvi-client", {"serialize": serialize, "deserialize": deserialize})


async def main():
    import telephony

    jobs = {
        "protobuf": protobuf,
        "telnyx": telnyx,
        "rtvi_client": rtvi_client,
        "twilio": lambda: telephony.twilio(write, sine_pcm, MESSAGES),
        "plivo": lambda: telephony.plivo(write, sine_pcm, MESSAGES),
        "exotel": lambda: telephony.exotel(write, sine_pcm, MESSAGES),
        "vonage": lambda: telephony.vonage(write, sine_pcm, MESSAGES),
        "genesys": lambda: telephony.genesys(write, sine_pcm, MESSAGES),
    }
    selected = sys.argv[1:] or list(jobs)
    for name in selected:
        await jobs[name]()


# `-I` leaves the script's directory off sys.path; telephony.py sits next to it.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
asyncio.run(main())
