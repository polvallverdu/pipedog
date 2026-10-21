# @pipedog/transport-local

The machine's microphone and speakers for pipedog: a port of Pipecat's
`pipecat.transports.local.audio` (`LocalAudioTransport`), for developing a bot without a browser
or a phone. Upstream uses PyAudio (PortAudio, native). This package has **no native addon**: it
spawns [`sox`](https://sox.sourceforge.net/) or [`ffmpeg`](https://ffmpeg.org/) and pipes raw
16-bit PCM through the child's stdin and stdout.

```ts
import { LocalAudioTransport, LocalAudioTransportParams } from "@pipedog/transport-local";

const transport = new LocalAudioTransport(
  new LocalAudioTransportParams({ audioInEnabled: true, audioOutEnabled: true }),
);
// Pipeline([transport.input(), stt, ..., tts, transport.output()])
```

Install one of the tools first:

| | macOS | Debian / Ubuntu | Windows |
|---|---|---|---|
| sox | `brew install sox` | `sudo apt install sox` | `choco install sox.portable` |
| ffmpeg | `brew install ffmpeg` | `sudo apt install ffmpeg` | `choco install ffmpeg` |

## Runtimes

| | Bun | Node ≥ 22 | Deno | Cloudflare Workers |
|---|---|---|---|---|
| `LocalAudioTransport` | ✅ | ✅ | ✅ | ❌ (cannot start processes) |

Needs: `sox` or `ffmpeg` on the `PATH`, and a machine with audio devices. Deno needs
`--allow-run` (and the permissions for what the tools open). Processes are started with
`Bun.spawn`, `Deno.Command` or `node:child_process`, whichever the runtime is.

If neither tool is installed, `setup()` fails with `LocalAudioToolNotFoundError`, which says what to
install. `detectAudioTool()` does the same lookup on its own.

## Options

`LocalAudioTransportParams` takes everything `TransportParams` does, plus:

| option | default | |
|---|---|---|
| `tool` | `"auto"` | `"sox"`, `"ffmpeg"` or `"auto"` (sox first, then ffmpeg) |
| `inputDevice` | system default | the microphone (see below) |
| `outputDevice` | system default | the speakers |
| `spawner` | the runtime's own | how to start processes (to inject a fake in tests) |

Devices are named in the tool's terms, not PortAudio indices (upstream's `input_device_index`):

- **sox**: the device name for the platform's driver: CoreAudio on macOS, ALSA on Linux,
  WaveAudio on Windows (`-t coreaudio "MacBook Pro Microphone"`). The default is `-d`, like `rec` and `play`.
- **ffmpeg**: macOS AVFoundation index or name for input and AudioToolbox index for output; Linux
  PulseAudio (PipeWire provides it) source and sink names; Windows DirectShow name for input
  (there is no default, and ffmpeg has no playback device there: use sox).

## How it works

Input: a recorder process writes PCM to stdout; the transport cuts it into 20 ms
`InputAudioRawFrame`s (as upstream's PyAudio callback does) and pushes them. Output: each
`OutputAudioRawFrame` is written to the player's stdin, and the write sleeps for the audio's duration,
as the other non-blocking output transports do, so the player is never more than a chunk ahead and an
interruption cuts the speech quickly. The processes are stopped in `cleanup()` and on cancel; if the
recorder dies, the transport pushes an error frame with its stderr.

## Differences from upstream

- DIVERGENCE: PyAudio becomes sox or ffmpeg (above). `input_device_index` and `output_device_index` become `inputDevice` and `outputDevice`.
- The recorder and player start in `start()`, not `setup()`.
- Not verified here: a real microphone and speakers. The tests and the compat smoke run against a
  fake spawner and a real `cat` process; the command lines were checked against the installed sox
  and ffmpeg with synthetic audio.
- `transports/local/tk` (a Tkinter desktop window) is not ported.

## License

BSD 2-Clause.
