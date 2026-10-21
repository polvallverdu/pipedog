---
"@pipedog/runner": patch
---

Ship the prebuilt client. The vendored `prebuilt/dist` was excluded by the repository's `dist/`
ignore, so published packages had no UI at `/client` and `/` didn't redirect to it.
