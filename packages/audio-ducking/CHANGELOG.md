# @pipedog/audio-ducking

## 0.10.0

### Minor Changes

- [#85](https://github.com/polvallverdu/pipedog/pull/85) [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e) Thanks [@polvallverdu](https://github.com/polvallverdu)! - New package `@pipedog/audio-ducking` (pipedog only): `AudioDuckingFilter` lowers the bot's voice while the user talks over it. It is an output audio filter (`audioOutFilter`), so the gain applies as audio leaves the transport, with any transport or serializer; its `observer` ducks on `VADUserStartedSpeakingFrame` and restores on `VADUserStoppedSpeakingFrame`, `InterruptionFrame` and `BotStoppedSpeakingFrame`, ramping over a chunk to avoid clicks.

### Patch Changes

- Updated dependencies [[`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e)]:
  - @pipedog/core@0.10.0
