// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The pipedog mark: a dog in profile, speaking (two waveform bars), on an orange tile. The same
 * drawing as app/icon.svg and .github/assets/logo.svg (the README); keep them in step.
 *
 * No <defs> (gradients, clip paths): the layouts render the nav title more than once, one copy
 * hidden, and a url(#id) that resolves to the hidden copy paints nothing.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <rect width="64" height="64" rx="15" fill="#F26A21" />
      <path
        fill="#fff"
        d="M11 63.46 C10 50 10.5 30 16.5 23.5 C21.5 18 29 16.5 35 19 L40.5 22.5 L46 23.5 C49.5 24.2 50.5 28.5 47.8 30.6 C46.6 31.5 45 31.8 43.5 31.8 L38 32.2 C35.5 34.5 34.6 38 34.8 42 L35 64 L15 64 A15 15 0 0 1 11 63.46 Z"
      />
      <path
        fill="#C2410C"
        d="M20.5 22.5 C16 27 15.2 35.5 18.2 41.5 C20 44.8 23.6 43.6 24.6 40 C25.8 35.5 25.6 28.5 24.6 23 C24 20.5 22 21 20.5 22.5 Z"
      />
      <circle cx="34" cy="24.8" r="1.9" fill="#1C1917" />
      <circle cx="47.2" cy="25.6" r="2.1" fill="#1C1917" />
      <g stroke="#fff" strokeWidth="3.2" strokeLinecap="round">
        <line x1="52.5" y1="29" x2="52.5" y2="35" />
        <line x1="57.5" y1="25.5" x2="57.5" y2="38.5" />
      </g>
    </svg>
  );
}

/** Mark and wordmark, for the navigation bar and the footer. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      <LogoMark className="size-6 shrink-0" />
      <span className="font-semibold tracking-tight text-[1.05rem]">pipedog</span>
    </span>
  );
}
