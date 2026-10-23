<script lang="ts">
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Live numbers: the round trip to the bot, voice-to-voice latency, each service's time to first
// byte, and where the call runs (the Durable Object's data centre, and where the visitor
// entered Cloudflare's network).
import type { Demo } from "./demo.svelte.ts";
import { coloName, ms } from "./format.ts";

let { demo }: { demo: Demo } = $props();

const lastLatency = $derived(demo.latencies.at(-1) ?? null);
const avgLatency = $derived(
  demo.latencies.length ? demo.latencies.reduce((a, b) => a + b, 0) / demo.latencies.length : null,
);
const visitorPlace = $derived(
  [demo.visitor?.city, demo.visitor?.country].filter(Boolean).join(", ") || null,
);
const transportLabel = $derived(
  (demo.active ?? demo.transport) === "webrtc"
    ? "WebRTC · Cloudflare Realtime"
    : "WebSocket · protobuf",
);
</script>

<div class="metrics" aria-label="Live metrics">
  <h3>Live metrics</h3>

  <dl class="hero">
    <div>
      <dt>Voice to voice</dt>
      <dd class="mono big">{ms(lastLatency)}</dd>
      <dd class="sub">{avgLatency === null ? "end of your turn → first audio" : `avg ${ms(avgLatency)} · ${demo.latencies.length} turns`}</dd>
    </div>
    <div>
      <dt>Round trip</dt>
      <dd class="mono big">{ms(demo.rttMs)}</dd>
      <dd class="sub">{(demo.active ?? demo.transport) === "webrtc" ? "messages socket ping" : "WebSocket ping"}</dd>
    </div>
  </dl>

  <div class="block">
    <h4>Time to first byte</h4>
    <dl class="rows">
      <div><dt>STT <span class="svc">Flux</span></dt><dd class="mono" title="Flux detects the end of the turn itself; pipedog's STT TTFB is measured from a VAD, which this bot doesn't run.">{demo.ttfb.stt !== null ? ms(demo.ttfb.stt) : demo.botColo ? "in turn" : "—"}</dd></div>
      <div><dt>LLM <span class="svc">Haiku 5.5</span></dt><dd class="mono">{ms(demo.ttfb.llm)}</dd></div>
      <div><dt>TTS <span class="svc">Aura 2</span></dt><dd class="mono">{ms(demo.ttfb.tts)}</dd></div>
    </dl>
  </div>

  <div class="block">
    <h4>Where it runs</h4>
    <dl class="rows">
      <div>
        <dt>Bot (Durable Object)</dt>
        <dd><span class="mono code">{demo.botColo ?? "—"}</span>{#if coloName(demo.botColo)}<span class="place">{coloName(demo.botColo)}</span>{/if}</dd>
      </div>
      <div>
        <dt>You entered at</dt>
        <dd><span class="mono code">{demo.visitor?.colo ?? "—"}</span>{#if visitorPlace}<span class="place">{visitorPlace}</span>{/if}</dd>
      </div>
      <div><dt>Transport</dt><dd class="small">{transportLabel}</dd></div>
      {#if demo.rtcStats}
        <div><dt>WebRTC RTT / jitter</dt><dd class="mono">{ms(demo.rtcStats.rttMs)} / {ms(demo.rtcStats.jitterMs)}</dd></div>
      {/if}
    </dl>
  </div>
</div>

<style>
  .metrics {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
    font-size: 0.8125rem;
  }
  h3 {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--primary);
  }
  h4 {
    margin: 0 0 0.35rem;
    font-size: 0.72rem;
    font-weight: 500;
    color: var(--muted-fg);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  dl {
    margin: 0;
  }
  dd {
    margin: 0;
  }
  .hero {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  .hero dt {
    font-size: 0.75rem;
    color: var(--muted-fg);
  }
  .big {
    font-size: 1.45rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--primary);
    line-height: 1.2;
  }
  .sub {
    font-size: 0.68rem;
    color: var(--muted-fg);
    line-height: 1.3;
  }
  .rows > div {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.3rem 0;
    border-bottom: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
  }
  .rows > div:last-child {
    border-bottom: 0;
  }
  .rows dt {
    color: var(--muted-fg);
  }
  .svc {
    font-size: 0.7rem;
    opacity: 0.75;
  }
  .rows dd {
    text-align: right;
  }
  .code {
    font-weight: 600;
  }
  .place {
    margin-left: 0.35rem;
    color: var(--muted-fg);
  }
  .small {
    font-size: 0.75rem;
  }
</style>
