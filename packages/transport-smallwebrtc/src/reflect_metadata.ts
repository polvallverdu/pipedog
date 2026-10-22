// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Loads the `Reflect.getMetadata` polyfill that werift's X.509 code needs.
 *
 * werift reaches `tsyringe` through `@peculiar/x509`, and `tsyringe` throws when
 * it is evaluated before `reflect-metadata`. `@peculiar/x509` does import it
 * first, but `bun build` can reorder that import after `tsyringe` when the
 * graph is loaded lazily (a dynamic `import()` of this package, as
 * `@pipedog/runner` does). Importing this file before `werift` keeps the order
 * right: the polyfill is the only thing it does, so nothing can run ahead of it.
 *
 * It is listed in `sideEffects` in package.json, so bundlers keep it.
 */

import "reflect-metadata";
