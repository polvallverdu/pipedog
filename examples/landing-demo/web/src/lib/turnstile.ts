// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Cloudflare Turnstile, loaded only when a session is started. The widget renders into
// `container` and shows itself only if the visitor has to interact ("interaction-only").

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      appearance?: "always" | "execute" | "interaction-only";
      theme?: "light" | "dark" | "auto";
      callback: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
    },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | null = null;

function load(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile didn't load"));
    script.onerror = () => {
      loading = null;
      reject(new Error("Turnstile didn't load"));
    };
    document.head.append(script);
  });
  return loading;
}

/** Get a Turnstile token (single use, valid for 300 s). */
export async function turnstileToken(
  siteKey: string,
  container: HTMLElement,
  theme: "light" | "dark",
): Promise<string> {
  const api = await load();
  return await new Promise<string>((resolve, reject) => {
    let id = "";
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
      // The token is read; the widget can go.
      setTimeout(() => api.remove(id), 0);
    };
    const timer = setTimeout(
      () => done(() => reject(new Error("The human check timed out."))),
      60_000,
    );
    id = api.render(container, {
      sitekey: siteKey,
      appearance: "interaction-only",
      theme,
      callback: (token) => done(() => resolve(token)),
      "error-callback": () => done(() => reject(new Error("The human check failed."))),
      "expired-callback": () => done(() => reject(new Error("The human check expired."))),
    });
  });
}
