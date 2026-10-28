---
"@pipedog/core": minor
---

`VADParams` takes `minVolumeDb`, the volume gate as a loudness in LUFS (e.g. `-35`), as an
alternative to the 0–1 `minVolume`; `volumeFromDb()` and `volumeToDb()` convert between them (#94).
