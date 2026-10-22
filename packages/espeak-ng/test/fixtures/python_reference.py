# Copyright (c) 2026, pipedog contributors
# SPDX-License-Identifier: BSD-2-Clause
#
# Generates python_reference.json with the Python stacks upstream Pipecat uses:
#   uv run --no-project --with kokoro-onnx==0.6.1 --with piper-tts==1.8.0 \
#     python -I python_reference.py > python_reference.json

import json
import sys

from kokoro_onnx.tokenizer import Tokenizer
from piper.phonemize_espeak import EspeakPhonemizer, ESPEAK_DATA_DIR
from piper import espeakbridge

TEXTS = [
    ("en-us", "Hello world!"),
    ("en-us", "Hello, world. How are you? I'm fine; thanks: really… Bye"),
    ("en-us", "Mr. Smith paid $3.50 for it."),
    ("en-us", 'He said "hi." Then left.'),
    ("en-us", "Line one\nLine two."),
    ("en-us", "Para one.\n\nPara two"),
    ("en-us", "Wait... what?! No way—really? (Yes.) It costs 19,99 euros, or 1.5 dollars."),
    ("en-us", "The U.S.A.'s army; e.g. the dog. ¿Qué? ¡Hola!"),
    ("en-gb", "I can't believe it's already October, isn't it?"),
    ("fr-fr", "Bonjour le monde. J'aime le weekend et le football!"),
    ("es", "¿Qué tal? ¡Hola, amigo! Son las 3.15."),
    ("cmn", "你好，世界。今天天气很好！"),
    ("pt-br", "Olá, tudo bem? Eu gosto de música."),
    ("it", "Ciao, come stai? Bene, grazie."),
    ("hi", "नमस्ते, आप कैसे हैं? मैं ठीक हूँ।"),
    ("ja", "こんにちは。元気ですか？"),
    ("en-us", "Numbers: 1, 2, 3; and 42.5% of 1,000 people.\nNew line here!"),
]

tok = Tokenizer()
out = {"kokoro": [], "piper": []}
for lang, text in TEXTS:
    raw = __import__("phonemizer").phonemize(text.strip(), lang, preserve_punctuation=True, with_stress=True)
    out["kokoro"].append({"lang": lang, "text": text, "phonemize": raw, "tokenizer": tok.phonemize(text, lang)})

ph = EspeakPhonemizer(ESPEAK_DATA_DIR)
PIPER_VOICES = {"en-us": "en-us", "en-gb": "en-gb-x-rp", "fr-fr": "fr", "es": "es", "cmn": "cmn", "pt-br": "pt-br", "it": "it", "hi": "hi", "ja": "ja"}
for lang, text in TEXTS:
    voice = PIPER_VOICES[lang]
    espeakbridge.set_voice(voice)
    clauses = espeakbridge.get_phonemes(text)
    out["piper"].append({"voice": voice, "text": text, "clauses": clauses, "sentences": ph.phonemize(voice, text)})

json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
