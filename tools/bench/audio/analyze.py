# Copyright (c) 2026, pipedog contributors
# SPDX-License-Identifier: BSD-2-Clause
#
# The analysis of the audio-quality benchmark (tools/bench/audio.ts): for each resampler output,
# what is left besides the input's in-band tones (noise, aliasing, distortion) and its largest
# single artefact, both relative to the tones; how much streaming in 20 ms chunks changes the
# output; and whether the mu-law tables match. Prints JSON.
#
#   python analyze.py <dir>

import json
import sys

import numpy as np

D = sys.argv[1]
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
IMPLS = ["pipecat", "pipedog", "pipedogts"]


def load(p):
    return np.fromfile(p, dtype=np.int16).astype(np.float64)


def spectrum(y, rate):
    """Over the middle second (1 Hz bins, Blackman window), delay-insensitive."""
    n = rate
    start = len(y) // 2 - n // 2
    seg = y[start : start + n]
    w = np.blackman(n)
    power = (np.abs(np.fft.rfft(seg * w)) / (np.sum(w) / 2)) ** 2
    mask = np.ones_like(power, dtype=bool)
    nyq = rate / 2
    expected = [f for f in IN_BAND if f < nyq] + [f for f in OUT_BAND if f < nyq * 0.92]
    tones = {}
    for f in expected:
        b = int(round(f))
        lo, hi = max(0, b - 6), b + 7
        tones[f] = power[lo:hi].sum()
        mask[lo:hi] = False
    mask[:20] = False  # DC
    ref = sum(tones[f] for f in IN_BAND)
    return {
        "residualDb": float(10 * np.log10(power[mask].sum() / ref + 1e-30)),
        "worstDb": float(10 * np.log10(np.max(power[mask]) / ref + 1e-30)),
    }


def stream_vs_file_db(a, b):
    """How much the 20 ms stream differs from the one-shot output, aligned (dB; lower = closer)."""
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    best = None
    for lag in range(-200, 201):
        x, y = (a[lag:], b[: n - lag]) if lag >= 0 else (a[: n + lag], b[-lag:])
        m = len(x) // 10
        x, y = x[m:-m], y[m:-m]
        e = np.sum((x - y) ** 2) / (np.sum(x**2) + 1e-30)
        best = e if best is None or e < best else best
    return float(10 * np.log10(best + 1e-30))


cases = []
for in_rate, out_rate in CASES:
    name = f"{in_rate}_{out_rate}"
    row = {"inRate": in_rate, "outRate": out_rate}
    for impl in IMPLS:
        stream = load(f"{D}/{impl}_stream_{name}.raw")
        row[impl] = {
            **spectrum(stream, out_rate),
            "streamVsFileDb": stream_vs_file_db(stream, load(f"{D}/{impl}_file_{name}.raw")),
        }
    cases.append(row)

enc = [np.fromfile(f"{D}/{i}_ulaw_enc.raw", dtype=np.uint8) for i in ("pipecat", "pipedog")]
dec = [np.fromfile(f"{D}/{i}_ulaw_dec.raw", dtype=np.int16) for i in ("pipecat", "pipedog")]
print(
    json.dumps(
        {
            "cases": cases,
            "ulaw": {
                "encodeValues": int(len(enc[0])),
                "encodeDiffer": int(np.sum(enc[0] != enc[1])),
                "decodeCodes": int(len(dec[0])),
                "decodeDiffer": int(np.sum(dec[0] != dec[1])),
            },
        }
    )
)
