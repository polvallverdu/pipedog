# @pipedog/audio-soundfile-mixer

Background sound for pipedog: a port of Pipecat's `pipecat.audio.mixers.soundfile_mixer`
(`SoundfileMixer`). It mixes audio from sound files into the transport's output, for office noise,
hold music or a keyboard clatter under the bot's voice. Upstream reads files with libsndfile. This
package parses **WAV** in pure TypeScript, so it runs everywhere with nothing to install.

```ts
import { SoundfileMixer } from "@pipedog/audio-soundfile-mixer";

const mixer = new SoundfileMixer({
  soundFiles: { office: "./assets/office.wav", hold: "https://example.com/hold.wav" },
  defaultSound: "office",
  volume: 0.4,
});
// pass it as `audioOutMixer` in TransportParams
```

Switch sounds or change the volume at runtime with `MixerUpdateSettingsFrame({ settings: { sound: "hold", volume: 0.2, loop: false } })`,
and turn mixing on and off with `MixerEnableFrame`.

## Runtimes

| | Bun | Node ≥ 22 | Deno | Cloudflare Workers |
|---|---|---|---|---|
| sounds from bytes or a URL | ✅ | ✅ | ✅ | ✅ |
| sounds from a file path | ✅ | ✅ | ✅ | ❌ (no filesystem) |

Needs: nothing. A path is read with `node:fs/promises`, imported lazily on first use (pass
`fileSystem` to read through something else). On Workers pass `Uint8Array` bytes (R2, KV, static
assets) or an `http(s):` URL.

## Sound sources

`soundFiles` maps a name to a source, one of:

- `Uint8Array` or `ArrayBuffer` holding a WAV file;
- a `URL`, or a string starting with `http:`, `https:`, `file:` or `data:`, which is fetched;
- any other string: a file path.

A file whose sample rate is not the output transport's, or that cannot be read, is skipped with
a log message (as upstream), and mixing passes audio through unchanged for a sound that did not
load. The sound should be mono, like upstream requires.

## Differences from upstream

- DIVERGENCE: **WAV only.** Upstream's libsndfile also reads FLAC, Ogg Vorbis/Opus, AIFF, AU,
  CAF, MP3 and more. Here those are rejected with a message naming the format; convert them to
  WAV first (`ffmpeg -i in.mp3 -ar 16000 -ac 1 out.wav`). Supported WAV encodings: PCM 8, 16, 24
  and 32 bit, IEEE float 32 and 64 bit, A-law and mu-law, including `WAVE_FORMAT_EXTENSIBLE` and
  RF64 headers. Samples are converted to int16 the way libsndfile does.
- Sources can be bytes or URLs, not only paths (see above), and the files are read with `await`,
  not `asyncio.to_thread`.

## License

BSD 2-Clause.
