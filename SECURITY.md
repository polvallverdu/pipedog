# Security policy

## Supported versions

pipedog is pre-1.0. Security fixes go into the latest published release of the `@pipedog/*`
packages (they are released together at one version). Older versions are not patched.

## Reporting a vulnerability

Please report vulnerabilities **privately**, through GitHub's private vulnerability reporting:

1. Go to <https://github.com/polvallverdu/pipedog/security/advisories/new>
   (the repository's **Security** tab, then **Report a vulnerability**).
2. Describe the issue, the affected packages and versions, and how to reproduce it.

Do not open a public issue, pull request or discussion for a vulnerability before it is fixed.

You can expect an acknowledgement within a few days. Once the issue is confirmed, a fix is
prepared in a private advisory, released, and the advisory is published with credit to you,
unless you prefer otherwise.

## Scope

In scope: the code in this repository and the `@pipedog/*` packages on npm. For example,
credential leaks (API keys in logs, errors or traces), unsafe handling of data from clients or
providers in transports and serializers, or a dependency pulled in with a known vulnerability.

Vulnerabilities in upstream Pipecat itself should go to the
[Pipecat project](https://github.com/pipecat-ai/pipecat/security). If one also affects pipedog's
port, report it here too.
