<script lang="ts">
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The few icons the page uses (Lucide's shapes), inline.
type Name =
  | "mic"
  | "stop"
  | "wrench"
  | "check"
  | "spinner"
  | "x"
  | "globe"
  | "server"
  | "alert"
  | "clock";
let { name, size = 16 }: { name: Name; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  class:spin={name === "spinner"}
>
  {#if name === "mic"}
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" x2="12" y1="19" y2="22" />
  {:else if name === "stop"}
    <rect x="6" y="6" width="12" height="12" rx="2" />
  {:else if name === "wrench"}
    <path
      d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
    />
  {:else if name === "check"}
    <path d="M20 6 9 17l-5-5" />
  {:else if name === "spinner"}
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  {:else if name === "x"}
    <path d="M18 6 6 18M6 6l12 12" />
  {:else if name === "globe"}
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20" />
  {:else if name === "server"}
    <rect width="20" height="8" x="2" y="2" rx="2" />
    <rect width="20" height="8" x="2" y="14" rx="2" />
    <line x1="6" x2="6.01" y1="6" y2="6" />
    <line x1="6" x2="6.01" y1="18" y2="18" />
  {:else if name === "alert"}
    <circle cx="12" cy="12" r="10" />
    <line x1="12" x2="12" y1="8" y2="12" />
    <line x1="12" x2="12.01" y1="16" y2="16" />
  {:else if name === "clock"}
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  {/if}
</svg>

<style>
  svg {
    flex-shrink: 0;
  }
  .spin {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
