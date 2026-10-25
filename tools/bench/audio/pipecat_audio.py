# Copyright (c) 2026, pipedog contributors
# SPDX-License-Identifier: BSD-2-Clause
#
# The Pipecat side of the audio-quality benchmark (tools/bench/audio.ts): makes the test
# signals, runs upstream Pipecat's resamplers (stream, in 20 ms chunks, and one-shot) and its
# mu-law encoder and decoder, and writes the results as raw files for analyze.py.
#
#   python pipecat_audio.py <out dir>

import asyncio
import os
import sys

import numpy as np
from loguru import logger

logger.remove()

from pipecat.audio.resamplers.soxr_resampler import SOXRAudioResampler  # noqa: E402
from pipecat.audio.resamplers.soxr_stream_resampler import SOXRStreamAudioResampler  # noqa: E402
from pipecat.audio.utils import pcm_to_ulaw, ulaw_to_pcm  # noqa: E402

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

# Tones a resampler must keep (below 4 kHz), and tones it must remove when going down to 8 kHz.
IN_BAND = [300.0, 1000.0, 2500.0]
OUT_BAND = [4700.0, 6100.0, 7300.0]
CASES = [
    (24000, 8000),
    (24000, 16000),
    (16000, 8000),
    (8000, 16000),
    (24000, 48000),
    (48000, 16000),
]
SECONDS = 3.0


def signal(rate: int) -> np.ndarray:
    t = np.arange(int(SECONDS * rate)) / rate
    x = np.zeros_like(t)
    for f in IN_BAND:
        x += 0.18 * np.sin(2 * np.pi * f * t)
    for f in OUT_BAND:
        if f < rate / 2:
            x += 0.10 * np.sin(2 * np.pi * f * t)
    return np.round(x * 32767).astype(np.int16)


async def main():
    for in_rate, out_rate in CASES:
        x = signal(in_rate)
        name = f"{in_rate}_{out_rate}"
        x.tofile(f"{OUT}/in_{name}.raw")
        # Stream, 20 ms chunks, as transports and serializers resample.
        r = SOXRStreamAudioResampler()
        chunk = in_rate // 50
        parts = []
        for i in range(0, len(x), chunk):
            parts.append(await r.resample(x[i : i + chunk].tobytes(), in_rate, out_rate))
        np.frombuffer(b"".join(parts), dtype=np.int16).tofile(f"{OUT}/pipecat_stream_{name}.raw")
        # One-shot.
        out = await SOXRAudioResampler().resample(x.tobytes(), in_rate, out_rate)
        np.frombuffer(out, dtype=np.int16).tofile(f"{OUT}/pipecat_file_{name}.raw")

    # mu-law: every int16 value encoded, every code decoded (8 kHz in and out: no resampling).
    allv = np.arange(-32768, 32768, dtype=np.int16)
    allv.tofile(f"{OUT}/all_int16.raw")
    r = SOXRAudioResampler()
    with open(f"{OUT}/pipecat_ulaw_enc.raw", "wb") as f:
        f.write(await pcm_to_ulaw(allv.tobytes(), 8000, 8000, r))
    with open(f"{OUT}/pipecat_ulaw_dec.raw", "wb") as f:
        f.write(await ulaw_to_pcm(bytes(range(256)), 8000, 8000, r))


asyncio.run(main())
