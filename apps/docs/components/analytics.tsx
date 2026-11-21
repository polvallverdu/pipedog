// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
"use client";

import { useEffect } from "react";

/**
 * PostHog page analytics for the docs site, EU cloud. Cookieless: no cookies and no browser
 * storage (visitors are counted with a privacy-preserving hash on PostHog's side), so the site
 * needs no consent banner. No session recording and no person profiles. Off unless the build sets
 * NEXT_PUBLIC_POSTHOG_KEY (the repository variable POSTHOG_KEY in the docs workflow), so local
 * builds and forks send nothing.
 */
const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

export function Analytics() {
  useEffect(() => {
    if (!key) return;
    void import("posthog-js").then(({ default: posthog }) => {
      posthog.init(key, {
        api_host: "https://eu.i.posthog.com",
        ui_host: "https://eu.posthog.com",
        // Pageviews on client-side navigation too, and page leaves.
        defaults: "2025-05-24",
        cookieless_mode: "always",
        person_profiles: "identified_only",
        disable_session_recording: true,
      });
    });
  }, []);
  return null;
}
