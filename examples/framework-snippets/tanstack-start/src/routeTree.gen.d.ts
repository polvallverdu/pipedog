// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// In a TanStack Start project, the router plugin generates src/routeTree.gen.ts.
// It registers each file route's path for createFileRoute, and it loads the
// `server` route option's types from @tanstack/react-start. This declaration
// does the same for the one route here, so the snippet typechecks without the
// generator.

import type { AnyRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

declare module "@tanstack/react-router" {
  interface FileRoutesByPath {
    "/api/offer": {
      id: "/api/offer";
      path: "/api/offer";
      fullPath: "/api/offer";
      preLoaderRoute: AnyRoute;
      parentRoute: AnyRoute;
    };
  }
}
