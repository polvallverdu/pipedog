<script lang="ts">
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The demo page. Standalone it's a full page; with ?embed=1 (the docs landing page's iframe)
// it's the card alone, and follows the landing page's theme (?theme=, and postMessage when the
// visitor toggles it).
import { onMount } from "svelte";
import Chat from "../lib/Chat.svelte";
import { Demo, type Transport } from "../lib/demo.svelte.ts";
import Icon from "../lib/Icon.svelte";
import Metrics from "../lib/Metrics.svelte";

const demo = new Demo();
let turnstileBox: HTMLDivElement | undefined = $state();
let embed = $state(false);
let dark = $state(false);

onMount(() => {
  embed = document.documentElement.classList.contains("embed");
  dark = document.documentElement.classList.contains("dark");
  void demo.load();

  // The landing page tells the iframe when its theme changes.
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent || event.data?.type !== "pipedog-theme") return;
    dark = event.data.theme === "dark";
    document.documentElement.classList.toggle("dark", dark);
  };
  window.addEventListener("message", onMessage);
  // Embedded: tell the landing page how tall the card is, so the iframe fits it.
  let resize: ResizeObserver | null = null;
  if (embed && window.parent !== window) {
    const post = () =>
      window.parent.postMessage(
        {
          type: "pipedog-demo-height",
          // The content's own height (the document's would never shrink below the iframe's).
          height: Math.ceil(document.querySelector("main")?.getBoundingClientRect().height ?? 0),
        },
        "*",
      );
    resize = new ResizeObserver(post);
    resize.observe(document.body);
    post();
  }
  // Hang up when the page goes away.
  const onHide = () => void demo.stop();
  window.addEventListener("pagehide", onHide);
  return () => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("pagehide", onHide);
    resize?.disconnect();
    void demo.stop();
  };
});

function toggle() {
  if (demo.busy) void demo.stop();
  else if (turnstileBox) void demo.start(turnstileBox, dark ? "dark" : "light");
}

function choose(t: Transport) {
  if (!demo.busy) demo.transport = t;
}

const stateLabel = $derived(
  {
    loading: "Checking…",
    unavailable: "Unavailable",
    idle: "Ready",
    verifying: "Checking you're human…",
    connecting: "Connecting…",
    connected: demo.botSpeaking
      ? "Bot speaking"
      : demo.userSpeaking
        ? "Listening to you"
        : "Connected",
    ending: "Ending…",
    ended: "Session ended",
    refused: "Not available now",
    error: "Couldn't connect",
  }[demo.status],
);

const tone = $derived(
  demo.status === "connected" || demo.status === "ending"
    ? "live"
    : demo.status === "unavailable" || demo.status === "refused" || demo.status === "error"
      ? "off"
      : demo.status === "verifying" || demo.status === "connecting"
        ? "wait"
        : "idle",
);

const remaining = $derived(demo.remainingSecs);
const clock = $derived(
  remaining === null
    ? null
    : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`,
);
const micDisabled = $derived(
  demo.status === "loading" || demo.status === "unavailable" || demo.status === "ending",
);
</script>

<svelte:head>
  <title>Talk to pipedog · live voice demo</title>
  <meta
    name="description"
    content="A voice agent built with pipedog, running entirely on Cloudflare: Workers, Durable Objects, Workers AI (Deepgram Flux and Aura) and Claude Haiku."
  />
</svelte:head>

<main class:embed>
  {#if !embed}
    <header class="intro">
      <a class="brand" href="https://polvallverdu.github.io/pipedog/">
        <img src="/favicon.svg" alt="" width="28" height="28" />
        <span>pipedog</span>
      </a>
      <h1>Talk to a voice agent <span class="grad">running on Cloudflare.</span></h1>
      <p>
        A <a href="https://github.com/polvallverdu/pipedog">pipedog</a> bot in a Durable Object: Deepgram
        Flux and Aura on Workers AI, Claude Haiku 5.5 with tools, and Pipecat's own browser client.
      </p>
    </header>
  {/if}

  <section class="card" aria-label="Live voice demo">
    <div class="topbar">
      <span class="pill"><span class="dot {tone}"></span>{stateLabel}</span>
      <div class="seg" role="radiogroup" aria-label="Transport">
        <button
          role="radio"
          aria-checked={demo.transport === "websocket"}
          class:on={demo.transport === "websocket"}
          disabled={demo.busy}
          onclick={() => choose("websocket")}>WebSocket</button
        >
        <button
          role="radio"
          aria-checked={demo.transport === "webrtc"}
          class:on={demo.transport === "webrtc"}
          disabled={demo.busy || !demo.webrtcAvailable}
          title={demo.webrtcAvailable ? "Audio over WebRTC, through Cloudflare Realtime" : "WebRTC isn't set up on this demo"}
          onclick={() => choose("webrtc")}>WebRTC</button
        >
      </div>
    </div>

    <div class="grid">
      <div class="mic-col">
        <button
          class="mic"
          class:live={demo.busy}
          class:speaking={demo.userSpeaking}
          disabled={micDisabled}
          aria-pressed={demo.busy}
          aria-label={demo.busy ? "End the session" : "Start talking"}
          onclick={toggle}
        >
          {#if demo.status === "verifying" || demo.status === "connecting"}
            <Icon name="spinner" size={30} />
          {:else if demo.busy}
            <Icon name="stop" size={28} />
          {:else}
            <Icon name="mic" size={30} />
          {/if}
        </button>
        <p class="mic-label">
          {#if demo.busy}Tap to hang up{:else if demo.status === "unavailable"}Demo unavailable{:else}Tap to talk{/if}
        </p>

        <div class="wave" aria-hidden="true">
          {#each demo.levels as level, i (i)}
            <span
              class="bar"
              class:bot={level.bot > level.user}
              style:height="{Math.max(6, Math.min(100, Math.max(level.user, level.bot) * 140))}%"
            ></span>
          {/each}
        </div>

        <div class="session">
          <span title="Time left"><Icon name="clock" size={13} /> <span class="mono">{clock ?? "2:00"}</span></span>
          <span title="Turns"><span class="mono">{demo.turns}/{demo.maxTurns}</span> turns</span>
        </div>

        <div class="turnstile" bind:this={turnstileBox}></div>

        {#if demo.message}
          <p class="message" class:soft={demo.status === "unavailable"} role="status">
            <Icon name="alert" size={14} />
            <span>{demo.message}</span>
          </p>
        {/if}

        <ul class="stack">
          <li><span>STT</span> Deepgram Flux</li>
          <li><span>LLM</span> Claude Haiku 5.5</li>
          <li><span>TTS</span> Deepgram Aura 2</li>
          <li><span>Run</span> Durable Object</li>
        </ul>
      </div>

      <div class="chat-col">
        <Chat items={demo.items} idle={!demo.busy} offline={demo.status === "unavailable"} />
      </div>

      <div class="metrics-col">
        <Metrics {demo} />
      </div>
    </div>
  </section>

  <p class="fineprint">
    Sessions last up to two minutes. Your audio goes to Cloudflare Workers AI and your words to
    Anthropic to answer you; nothing is recorded or stored.
    <a href="https://github.com/polvallverdu/pipedog/tree/main/examples/landing-demo">Source</a>
  </p>
</main>

<style>
  main {
    max-width: 72rem;
    margin: 0 auto;
    padding: 2.5rem 1rem 2rem;
  }
  main.embed {
    padding: 0;
    max-width: none;
  }
  .intro {
    margin-bottom: 1.75rem;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
    text-decoration: none;
    margin-bottom: 1.5rem;
  }
  h1 {
    margin: 0;
    font-size: clamp(1.9rem, 4.5vw, 3rem);
    line-height: 1.08;
    letter-spacing: -0.025em;
    font-weight: 600;
    text-wrap: balance;
  }
  .grad {
    background: linear-gradient(100deg, var(--primary) 10%, oklch(0.7 0.17 50) 55%, var(--primary) 90%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .intro p {
    max-width: 40rem;
    margin: 1rem 0 0;
    color: var(--muted-fg);
    font-size: 1.05rem;
  }

  .card {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 1.5rem;
    background: var(--card);
    box-shadow:
      0 1px 0 0 color-mix(in oklab, var(--fg) 4%, transparent),
      0 18px 40px -28px oklch(0.2 0.018 265 / 0.35);
  }
  main.embed .card {
    border-radius: 1.25rem;
    box-shadow: none;
  }
  .card::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: radial-gradient(ellipse 60% 40% at 15% 0%, var(--glow), transparent 70%);
  }

  .topbar {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 999px;
    background: var(--muted-fg);
  }
  .dot.live {
    background: var(--ok);
    box-shadow: 0 0 0 4px color-mix(in oklab, var(--ok) 22%, transparent);
  }
  .dot.wait {
    background: var(--warn);
    animation: pulse 1.2s ease-in-out infinite;
  }
  .dot.off {
    background: var(--bad);
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  .seg {
    display: inline-flex;
    padding: 0.2rem;
    border: 1px solid var(--border);
    border-radius: 0.7rem;
    background: var(--bg);
  }
  .seg button {
    border: 0;
    background: transparent;
    padding: 0.3rem 0.75rem;
    border-radius: 0.5rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--muted-fg);
    cursor: pointer;
  }
  .seg button.on {
    background: var(--card);
    color: var(--fg);
    box-shadow: 0 1px 2px oklch(0.2 0.018 265 / 0.12);
  }
  .seg button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .seg button.on:disabled {
    opacity: 1;
  }

  .grid {
    position: relative;
    display: grid;
    grid-template-columns: 15rem minmax(0, 1fr) 16.5rem;
    height: 30rem;
  }
  .mic-col,
  .metrics-col {
    min-height: 0;
    overflow-y: auto;
  }
  .mic-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 1.5rem 1rem 1rem;
    border-right: 1px solid var(--border);
  }
  .chat-col {
    min-height: 0;
    background: color-mix(in oklab, var(--bg) 55%, var(--card));
  }
  .metrics-col {
    border-left: 1px solid var(--border);
  }

  .mic {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 5.5rem;
    height: 5.5rem;
    border-radius: 999px;
    border: 0;
    background: var(--primary);
    color: var(--primary-fg);
    cursor: pointer;
    box-shadow:
      0 10px 26px -10px color-mix(in oklab, var(--primary) 75%, transparent),
      0 0 0 0 var(--glow);
    transition:
      transform 0.15s ease,
      box-shadow 0.3s ease,
      filter 0.15s ease;
  }
  .mic:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .mic:active:not(:disabled) {
    transform: translateY(1px);
  }
  .mic.live {
    box-shadow:
      0 10px 26px -10px color-mix(in oklab, var(--primary) 75%, transparent),
      0 0 0 8px var(--glow);
  }
  .mic.speaking {
    box-shadow:
      0 10px 26px -10px color-mix(in oklab, var(--primary) 75%, transparent),
      0 0 0 14px var(--glow);
  }
  .mic:disabled {
    background: var(--muted);
    color: var(--muted-fg);
    box-shadow: none;
    cursor: not-allowed;
  }
  .mic-label {
    margin: 0.75rem 0 0;
    font-size: 0.8rem;
    color: var(--muted-fg);
  }
  .wave {
    display: flex;
    align-items: center;
    gap: 2px;
    width: 100%;
    height: 2.5rem;
    margin-top: 1rem;
  }
  .bar {
    flex: 1;
    min-height: 3px;
    border-radius: 2px;
    background: var(--primary);
    opacity: 0.8;
    transition: height 90ms linear;
  }
  .bar.bot {
    background: var(--fg);
    opacity: 0.5;
  }
  .session {
    display: flex;
    justify-content: space-between;
    width: 100%;
    margin-top: 0.75rem;
    font-size: 0.75rem;
    color: var(--muted-fg);
  }
  .session > span {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .turnstile:empty {
    display: none;
  }
  .turnstile {
    margin-top: 0.75rem;
  }
  .message {
    display: flex;
    gap: 0.4rem;
    align-items: flex-start;
    margin: 0.75rem 0 0;
    padding: 0.5rem 0.6rem;
    border-radius: 0.6rem;
    font-size: 0.78rem;
    line-height: 1.35;
    color: var(--fg);
    background: color-mix(in oklab, var(--bad) 10%, var(--card));
    border: 1px solid color-mix(in oklab, var(--bad) 30%, var(--border));
  }
  .message.soft {
    background: var(--muted);
    border-color: var(--border);
  }
  .message :global(svg) {
    margin-top: 0.1rem;
    color: var(--muted-fg);
  }
  .stack {
    list-style: none;
    width: 100%;
    margin: auto 0 0;
    padding: 1rem 0 0;
    display: grid;
    gap: 0.25rem;
    font-size: 0.75rem;
  }
  .stack li {
    display: flex;
    gap: 0.5rem;
  }
  .stack span {
    width: 2.25rem;
    font-family: var(--font-mono);
    color: var(--primary);
  }
  .fineprint {
    margin: 1rem 0 0;
    font-size: 0.75rem;
    color: var(--muted-fg);
    text-align: center;
  }
  main.embed .fineprint {
    margin-top: 0.6rem;
  }

  /* Narrower: the metrics go under the conversation. */
  @media (max-width: 960px) {
    .grid {
      grid-template-columns: 14rem minmax(0, 1fr);
      grid-template-rows: 26rem auto;
      height: auto;
    }
    .metrics-col {
      grid-column: 1 / -1;
      border-left: 0;
      border-top: 1px solid var(--border);
    }
    .metrics-col :global(.metrics) {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      align-items: start;
    }
    .metrics-col :global(.metrics h3) {
      grid-column: 1 / -1;
    }
  }

  /* Phones: one column, the mic first. */
  @media (max-width: 640px) {
    main {
      padding-top: 1.5rem;
    }
    .grid {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto 22rem auto;
    }
    .mic-col {
      border-right: 0;
      border-bottom: 1px solid var(--border);
      display: grid;
      grid-template-columns: auto 1fr;
      column-gap: 1rem;
      align-items: center;
      padding: 1rem;
    }
    .mic {
      grid-row: span 3;
      width: 4.5rem;
      height: 4.5rem;
    }
    .mic-label {
      margin: 0;
    }
    .wave {
      margin-top: 0.35rem;
      height: 1.75rem;
    }
    .session {
      margin-top: 0.35rem;
    }
    .turnstile,
    .message {
      grid-column: 1 / -1;
    }
    .stack {
      display: none;
    }
    .metrics-col :global(.metrics) {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
