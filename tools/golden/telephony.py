# Copyright (c) 2026, pipedog contributors
# SPDX-License-Identifier: BSD-2-Clause
#
# Golden vectors for the telephony serializer packages (Twilio, Plivo, Exotel,
# Vonage, Genesys), produced by upstream pipecat. Imported and run by
# serializers.py:
#
#   <python with upstream pipecat + soxr + aiohttp> -I tools/golden/serializers.py twilio plivo ...
#
# Each package's test/golden.test.ts replays the vectors.

import json
from types import SimpleNamespace

from loguru import logger
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    OutputTransportMessageFrame,
    OutputTransportMessageUrgentFrame,
)
from pipecat.serializers.exotel import ExotelFrameSerializer
from pipecat.serializers.genesys import AudioHookChannel, GenesysAudioHookSerializer
from pipecat.serializers.plivo import PlivoFrameSerializer
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.serializers.vonage import VonageFrameSerializer

CHUNK_MS = 20
RATES = (8000, 16000, 24000)


def summarize(frame):
    if frame is None:
        return None
    name = type(frame).__name__
    if name == "InputDTMFFrame":
        return {"type": name, "button": frame.button.value}
    if name == "InputAudioRawFrame":
        return {"type": name, "hex": frame.audio.hex(), "sample_rate": frame.sample_rate}
    if name == "OutputTransportMessageUrgentFrame":
        return {"type": name, "message": frame.message}
    return {"type": name}


async def try_deserialize(s, raw):
    try:
        return {"frame": summarize(await s.deserialize(raw))}
    except Exception as e:
        return {"error": type(e).__name__}


async def try_serialize(s, frame):
    try:
        out = await s.serialize(frame)
    except Exception as e:
        return {"error": type(e).__name__}
    if isinstance(out, bytes):
        return {"hex": out.hex()}
    return out


def misc_inputs(messages):
    """Interruption plus every transport message, both kinds."""
    out = [({"kind": "interruption"}, InterruptionFrame())]
    for m in messages:
        out.append(({"kind": "message", "message": m}, OutputTransportMessageFrame(message=m)))
        out.append(
            ({"kind": "message_urgent", "message": m}, OutputTransportMessageUrgentFrame(message=m))
        )
    return out


async def serialize_misc(s, messages):
    out = []
    for spec, frame in misc_inputs(messages):
        out.append({"input": spec, "out": await try_serialize(s, frame)})
    return out


def capture_logs():
    logs = []
    sink = logger.add(lambda m: logs.append([m.record["level"].name, m.record["message"]]))
    return logs, sink


async def run_rest_cases(method, host, cases, make):
    """Run `make()`'s serializer against a local server per (status, body, content type)."""
    import aiohttp
    from aiohttp import web

    results = []
    for status, body, content_type in cases:
        captured = {}

        async def handler(request, status=status, body=body, ct=content_type, captured=captured):
            captured["method"] = request.method
            captured["path"] = request.path_qs
            captured["headers"] = {
                k.lower(): v for k, v in request.headers.items() if k.lower() != "host"
            }
            captured["body"] = (await request.read()).decode()
            if status == 204:
                return web.Response(status=204)
            return web.Response(status=status, text=body, content_type=ct)

        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", handler)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]

        orig = getattr(aiohttp.ClientSession, method)

        def patched(self, url, *args, **kwargs):
            url = str(url).replace(host, f"http://127.0.0.1:{port}")
            return orig(self, url, *args, **kwargs)

        setattr(aiohttp.ClientSession, method, patched)
        logs, sink = capture_logs()
        try:
            s = make()
            out1 = await s.serialize(EndFrame())
            out2 = await s.serialize(CancelFrame())
        finally:
            setattr(aiohttp.ClientSession, method, orig)
            logger.remove(sink)
            await runner.cleanup()
        results.append(
            {
                "status": status,
                "responseBody": body,
                "contentType": content_type,
                "request": captured,
                "logs": logs,
                "serializeEnd": out1,
                "serializeCancelAfter": out2,
            }
        )
    return results


# ---------------------------------------------------------------------------
# Twilio and Plivo: μ-law 8 kHz in JSON media events, REST hang-up.


async def ulaw_audio_cases(make, sine_pcm, to_inbound=lambda m: m):
    cases = []
    for rate in RATES:
        s = make()
        await s.setup(SimpleNamespace(audio_in_sample_rate=rate))
        encoder = make()
        src = sine_pcm(8000, 8000 * CHUNK_MS // 1000 * 10, amp=12000)
        step = 8000 * CHUNK_MS // 1000 * 2
        messages = []
        for i in range(0, len(src), step):
            messages.append(
                await encoder.serialize(
                    OutputAudioRawFrame(audio=src[i : i + step], sample_rate=8000, num_channels=1)
                )
            )
        deserialized = []
        for m in messages:
            f = await s.deserialize(to_inbound(m))
            deserialized.append(f.audio.hex() if f is not None else None)
        pcm = sine_pcm(rate, rate * CHUNK_MS // 1000 * 10, amp=12000)
        ostep = rate * CHUNK_MS // 1000 * 2
        serialized = []
        for i in range(0, len(pcm), ostep):
            serialized.append(
                await s.serialize(
                    OutputAudioRawFrame(audio=pcm[i : i + ostep], sample_rate=rate, num_channels=1)
                )
            )
        cases.append(
            {
                "rate": rate,
                "source8k": src.hex(),
                "mediaMessages": messages,
                "deserialized": deserialized,
                "pipelinePcm": pcm.hex(),
                "serialized": serialized,
            }
        )
    return cases


def dtmf_events(extra):
    return (
        [
            json.dumps({"event": "dtmf", "dtmf": {"digit": d}})
            for d in ["0", "1", "5", "9", "*", "#", "A", "", "10"]
        ]
        + [
            json.dumps({"event": "dtmf", "dtmf": {"digit": 5}}),
            json.dumps({"event": "dtmf"}),
            json.dumps({"event": "media", "media": {}}),
            json.dumps({"event": "media", "media": {"payload": ""}}),
            json.dumps({"event": "media"}),
            "not json",
            "",
            json.dumps({"no": "event"}),
            json.dumps([1, 2]),
            json.dumps("a string"),
            json.dumps({"event": "media", "media": "x"}),
            json.dumps({"event": "dtmf", "dtmf": None}),
        ]
        + extra
    )


async def twilio(write, sine_pcm, messages):
    def make():
        return TwilioFrameSerializer(
            stream_sid="MZ123",
            params=TwilioFrameSerializer.InputParams(auto_hang_up=False),
        )

    audio = await ulaw_audio_cases(make, sine_pcm)
    s = make()
    await s.setup(SimpleNamespace(audio_in_sample_rate=16000))
    events = []
    for raw in dtmf_events(
        [
            json.dumps({"event": "connected", "protocol": "Call", "version": "1.0.0"}),
            json.dumps(
                {
                    "event": "start",
                    "sequenceNumber": "1",
                    "start": {
                        "accountSid": "AC1",
                        "streamSid": "MZ123",
                        "callSid": "CA1",
                        "tracks": ["inbound"],
                        "mediaFormat": {"encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1},
                        "customParameters": {},
                    },
                    "streamSid": "MZ123",
                }
            ),
            json.dumps({"event": "mark", "streamSid": "MZ123", "mark": {"name": "m"}}),
            json.dumps({"event": "stop", "streamSid": "MZ123", "stop": {"callSid": "CA1"}}),
        ]
    ):
        events.append({"input": raw, **(await try_deserialize(s, raw))})
    misc = await serialize_misc(s, messages)
    misc.append({"input": {"kind": "end"}, "out": await s.serialize(EndFrame())})

    def make_hangup(**kw):
        def f():
            return TwilioFrameSerializer(
                stream_sid="MZ123",
                call_sid="CA/call id",
                account_sid="AC_acct",
                auth_token="tok:en",
                **kw,
            )

        return f

    rest_cases = [
        (200, '{"sid": "CA1", "status": "completed"}', "application/json"),
        (404, '{"code": 20404, "message": "The requested resource was not found"}', "application/json"),
        (404, '{"code": 20003, "message": "Other"}', "application/json"),
        (404, '{"code": 20404}', "text/plain"),
        (404, "not json", "application/json"),
        (404, "[1, 2]", "application/json"),
        (500, "internal error", "text/plain"),
    ]
    hangup = await run_rest_cases("post", "https://api.twilio.com", rest_cases, make_hangup())
    regional = await run_rest_cases(
        "post",
        "https://api.sydney.au1.twilio.com",
        rest_cases[:1],
        make_hangup(region="au1", edge="sydney"),
    )
    write(
        "serializer-twilio",
        {
            "audio": audio,
            "events": events,
            "serializeMisc": misc,
            "hangup": hangup,
            "hangupRegional": regional,
        },
    )


async def plivo(write, sine_pcm, messages):
    def make():
        return PlivoFrameSerializer(
            stream_id="stream-1",
            params=PlivoFrameSerializer.InputParams(auto_hang_up=False),
        )

    def to_inbound(m):
        # Outbound audio is a playAudio event; inbound audio comes as `media`.
        return json.dumps({"event": "media", "media": {"payload": json.loads(m)["media"]["payload"]}})

    audio = await ulaw_audio_cases(make, sine_pcm, to_inbound)
    s = make()
    await s.setup(SimpleNamespace(audio_in_sample_rate=16000))
    logs, sink = capture_logs()
    events = []
    try:
        for raw in dtmf_events(
            [
                json.dumps(
                    {
                        "event": "start",
                        "sequenceNumber": 0,
                        "start": {
                            "callId": "call-1",
                            "streamId": "stream-1",
                            "accountId": "acc",
                            "tracks": ["inbound"],
                            "mediaFormat": {"encoding": "audio/x-mulaw", "sampleRate": 8000},
                        },
                    }
                ),
                json.dumps({"event": "playedStream", "streamId": "stream-1", "name": "x"}),
                json.dumps({"event": "clearedAudio", "streamId": "stream-1"}),
                json.dumps({"event": "dtmf", "dtmf": {"digit": "B"}}),
            ]
        ):
            events.append({"input": raw, **(await try_deserialize(s, raw))})
    finally:
        logger.remove(sink)
    misc = await serialize_misc(s, messages)
    misc.append({"input": {"kind": "end"}, "out": await s.serialize(EndFrame())})

    def make_hangup():
        return PlivoFrameSerializer(
            stream_id="stream-1",
            call_id="call/1 x",
            auth_id="MA_AUTH",
            auth_token="tok:en",
        )

    hangup = await run_rest_cases(
        "delete",
        "https://api.plivo.com",
        [
            (204, "", "application/json"),
            (404, '{"error": "not found"}', "application/json"),
            (500, "internal error", "text/plain"),
            (401, '{"error": "unauthorized"}', "application/json"),
        ],
        make_hangup,
    )
    write(
        "serializer-plivo",
        {
            "audio": audio,
            "events": events,
            "eventLogs": logs,
            "serializeMisc": misc,
            "hangup": hangup,
        },
    )


# ---------------------------------------------------------------------------
# Exotel and Vonage: linear PCM, resampled.


async def pcm_audio_cases(make, sine_pcm, provider_rate, wrap_in, unwrap_out):
    cases = []
    for rate in RATES:
        s = make()
        await s.setup(SimpleNamespace(audio_in_sample_rate=rate))
        src = sine_pcm(provider_rate, provider_rate * CHUNK_MS // 1000 * 10, amp=12000)
        step = provider_rate * CHUNK_MS // 1000 * 2
        inbound = [wrap_in(src[i : i + step]) for i in range(0, len(src), step)]
        deserialized = []
        for m in inbound:
            f = await s.deserialize(m)
            deserialized.append(f.audio.hex() if f is not None else None)
        pcm = sine_pcm(rate, rate * CHUNK_MS // 1000 * 10, amp=12000)
        ostep = rate * CHUNK_MS // 1000 * 2
        serialized = []
        for i in range(0, len(pcm), ostep):
            out = await s.serialize(
                OutputAudioRawFrame(audio=pcm[i : i + ostep], sample_rate=rate, num_channels=1)
            )
            serialized.append(unwrap_out(out))
        cases.append(
            {
                "rate": rate,
                "inbound": [m if isinstance(m, str) else m.hex() for m in inbound],
                "deserialized": deserialized,
                "pipelinePcm": pcm.hex(),
                "serialized": serialized,
            }
        )
    return cases


async def exotel(write, sine_pcm, messages):
    import base64

    def make():
        return ExotelFrameSerializer(stream_sid="stream123", call_sid="call123")

    def wrap(b):
        return json.dumps(
            {"event": "media", "stream_sid": "stream123", "media": {"payload": base64.b64encode(b).decode()}}
        )

    audio = await pcm_audio_cases(make, sine_pcm, 8000, wrap, lambda out: out)
    s = make()
    await s.setup(SimpleNamespace(audio_in_sample_rate=8000))
    logs, sink = capture_logs()
    events = []
    try:
        for raw in dtmf_events(
            [
                json.dumps({"event": "connected"}),
                json.dumps(
                    {
                        "event": "start",
                        "sequence_number": 1,
                        "stream_sid": "stream123",
                        "start": {
                            "stream_sid": "stream123",
                            "call_sid": "call123",
                            "account_sid": "acc",
                            "from": "+1",
                            "to": "+2",
                            "media_format": {"encoding": "base64", "sample_rate": "8000"},
                        },
                    }
                ),
                json.dumps({"event": "mark", "mark": {"name": "m"}}),
                json.dumps({"event": "stop", "stop": {"call_sid": "call123", "reason": "callended"}}),
            ]
        ):
            events.append({"input": raw, **(await try_deserialize(s, raw))})
    finally:
        logger.remove(sink)
    misc = await serialize_misc(s, messages)
    misc.append({"input": {"kind": "end"}, "out": await s.serialize(EndFrame())})
    write(
        "serializer-exotel",
        {"audio": audio, "events": events, "eventLogs": logs, "serializeMisc": misc},
    )


async def vonage(write, sine_pcm, messages):
    def make():
        return VonageFrameSerializer()

    audio = await pcm_audio_cases(
        make,
        sine_pcm,
        16000,
        lambda b: b,
        lambda out: None if out is None else out.hex(),
    )
    s = make()
    await s.setup(SimpleNamespace(audio_in_sample_rate=16000))
    logs, sink = capture_logs()
    events = []
    try:
        for raw in [
            json.dumps({"event": "websocket:connected", "content-type": "audio/l16;rate=16000"}),
            json.dumps({"event": "websocket:cleared"}),
            json.dumps({"event": "websocket:notify", "payload": {"k": "v"}}),
            json.dumps({"event": "websocket:dtmf", "digit": "5"}),
            json.dumps({"event": "websocket:dtmf", "digit": 7}),
            json.dumps({"event": "websocket:dtmf", "dtmf": {"digit": "#"}}),
            json.dumps({"event": "websocket:dtmf", "digit": "", "dtmf": {"digit": "*"}}),
            json.dumps({"event": "websocket:dtmf", "digit": "A"}),
            json.dumps({"event": "websocket:dtmf"}),
            json.dumps({"event": "websocket:dtmf", "dtmf": None}),
            json.dumps({"event": "other:event"}),
            json.dumps({"no": "event"}),
            "not json",
            json.dumps([1]),
        ]:
            events.append({"input": raw, **(await try_deserialize(s, raw))})
    finally:
        logger.remove(sink)
    misc = await serialize_misc(s, messages)
    misc.append({"input": {"kind": "end"}, "out": await s.serialize(EndFrame())})
    write(
        "serializer-vonage",
        {"audio": audio, "events": events, "eventLogs": logs, "serializeMisc": misc},
    )


# ---------------------------------------------------------------------------
# Genesys AudioHook: a scripted session.


def genesys_open(seq=1, channels=("external",), **params):
    p = {
        "organizationId": "org",
        "conversationId": "conv-456",
        "participant": {"id": "p1", "ani": "+1234567890", "dnis": "+0987654321"},
        "media": [{"type": "audio", "format": "PCMU", "channels": list(channels), "rate": 8000}],
        "language": "en-US",
    }
    p.update(params)
    return {
        "version": "2",
        "type": "open",
        "seq": seq,
        "serverseq": 0,
        "id": "e160e428-53e2-487c-977d-96989bf5c99d",
        "position": "PT0S",
        "parameters": p,
    }


async def genesys(write, sine_pcm, messages):
    sessions = []

    async def run(label, params, steps):
        s = GenesysAudioHookSerializer(params=params)
        # 8 kHz pipeline: no resampling, so the audio is byte-exact.
        await s.setup(SimpleNamespace(audio_in_sample_rate=8000))
        out = []
        for kind, value in steps:
            if kind == "in":
                raw = value if isinstance(value, str) else json.dumps(value)
                out.append({"in": raw, **(await try_deserialize(s, raw))})
            elif kind == "in_audio":
                out.append({"in_audio": value.hex(), **(await try_deserialize(s, value))})
            elif kind == "out_audio":
                frame = OutputAudioRawFrame(audio=value, sample_rate=8000, num_channels=1)
                out.append({"out_audio": value.hex(), "out": await try_serialize(s, frame)})
            elif kind == "out":
                spec, frame = value
                out.append({"out_frame": spec, "out": await try_serialize(s, frame)})
            elif kind == "set_output_variables":
                s.set_output_variables(value)
                out.append({"set_output_variables": value})
            elif kind == "call":
                name, kwargs = value
                out.append({"call": name, "kwargs": kwargs, "result": getattr(s, name)(**kwargs)})
            out[-1]["state"] = {
                "session_id": s.session_id,
                "conversation_id": s.conversation_id,
                "is_open": s.is_open,
                "is_paused": s.is_paused,
                "participant": s.participant,
                "input_variables": s.input_variables,
                "channel": s._params.channel.value,
            }
        sessions.append({"label": label, "params": params_spec(params), "steps": out})

    def params_spec(p):
        return {
            "channel": p.channel.value,
            "supported_languages": p.supported_languages,
            "selected_language": p.selected_language,
            "start_paused": p.start_paused,
        }

    ulaw_in = bytes(range(0, 256, 2)) + bytes(range(1, 256, 2))  # 256 bytes, 32 ms
    pcm_out = sine_pcm(8000, 160 * 4, amp=12000)

    def pos(seq, p, t="ping"):
        return {"version": "2", "type": t, "seq": seq, "id": "e160", "position": p, "parameters": {}}

    await run(
        "full session",
        GenesysAudioHookSerializer.InputParams(
            supported_languages=["en-US", "es-ES"], selected_language="en-US"
        ),
        [
            ("in_audio", ulaw_in),  # before open: dropped
            ("out_audio", pcm_out),  # before open: dropped
            ("in", genesys_open(inputVariables={"customer_id": "cust-789", "queue": "billing"})),
            ("in_audio", ulaw_in),
            ("in_audio", ulaw_in),
            ("out_audio", pcm_out),
            ("out_audio", pcm_out),
            ("in", pos(2, "PT1.5S")),
            ("in", pos(3, "PT0.0625S")),
            ("in", pos(4, "PT0.1875S")),
            ("in", pos(5, "PT10.0005S")),
            ("in", pos(6, "PT2.0004999S")),
            ("in", pos(7, "PTxS")),
            ("in", pos(8, "P1D")),
            ("in", pos(9, "PT1e1S")),
            ("in", pos(10, "PT123456.789S")),
            ("in", {"version": "2", "type": "dtmf", "seq": 11, "parameters": {"digit": "5"}}),
            ("in", {"version": "2", "type": "dtmf", "seq": 12, "parameters": {"digit": "*"}}),
            ("in", {"version": "2", "type": "dtmf", "seq": 13, "parameters": {"digit": "A"}}),
            ("in", {"version": "2", "type": "dtmf", "seq": 14, "parameters": {}}),
            ("out", ({"kind": "interruption"}, InterruptionFrame())),
            *[("out", (spec, frame)) for spec, frame in misc_inputs(messages)[1:]],
            (
                "out",
                (
                    {"kind": "message", "message": {"version": "2", "type": "custom", "x": "ü"}},
                    OutputTransportMessageFrame(message={"version": "2", "type": "custom", "x": "ü"}),
                ),
            ),
            ("in", {"version": "2", "type": "pause", "seq": 15, "position": "PT20S", "parameters": {"reason": "hold"}}),
            ("in_audio", ulaw_in),  # paused: dropped
            ("out_audio", pcm_out),  # paused: dropped
            ("call", ("create_resumed_response", {})),
            ("in_audio", ulaw_in),
            (
                "in",
                {
                    "version": "2",
                    "type": "update",
                    "seq": 16,
                    "parameters": {"participant": {"ani": "+1", "name": "John Doe"}},
                },
            ),
            ("in", {"version": "2", "type": "error", "seq": 17, "parameters": {"code": 409, "message": "Conflict"}}),
            ("in", {"version": "2", "type": "playback_started", "seq": 18}),
            ("in", {"version": "2", "type": "playback_completed", "seq": 19}),
            ("in", {"version": "2", "type": "discard", "seq": 20}),
            ("in", "not json"),
            ("call", ("create_error_message", {"code": 500, "message": "Internal error", "retryable": True})),
            ("call", ("create_disconnect_message", {})),
            (
                "call",
                (
                    "create_disconnect_message",
                    {"reason": "error", "action": "finished", "output_variables": {"action": "override", "k": 1}, "info": "why"},
                ),
            ),
            ("set_output_variables", {"intent": "billing", "resolved": True, "score": 0.95}),
            ("in", {"version": "2", "type": "close", "seq": 21, "position": "PT30.0S", "parameters": {"reason": "end"}}),
            ("out", ({"kind": "end"}, EndFrame())),
            ("out", ({"kind": "cancel"}, CancelFrame())),
        ],
    )
    await run(
        "stereo",
        GenesysAudioHookSerializer.InputParams(start_paused=True),
        [
            ("in", genesys_open(channels=("external", "internal"))),
            ("in_audio", ulaw_in),
            ("in_audio", ulaw_in[:7]),
            ("in", {"version": "2", "type": "close", "seq": 2, "parameters": {}}),
        ],
    )
    await run(
        "internal channel",
        GenesysAudioHookSerializer.InputParams(channel=AudioHookChannel.BOTH),
        [
            ("in", genesys_open(channels=("internal",))),
            ("in", genesys_open(seq=2, media=[], conversationId=None, participant=None)),
            ("in", {"version": "2", "type": "open", "seq": 3, "id": "no-params"}),
        ],
    )
    write("serializer-genesys", {"sessions": sessions})
