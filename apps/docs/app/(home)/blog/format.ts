// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** A post's date (YYYY-MM-DD) in its language, as a calendar date (no time zone shift). */
export function formatPostDate(date: string, lang: "en" | "es"): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(lang === "es" ? "es-ES" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
