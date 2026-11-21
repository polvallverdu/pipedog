<script lang="ts">
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The pipeline, live: mic → VAD → STT → turn → Claude → TTS → speaker. Each stage lights up while
// it works and shows its latest timing (TTFB for the services, how long the turn took to decide,
// voice to voice at the speaker). Below it, what the STT is hearing, and the moments worth a look:
// speech over the bot that didn't interrupt it (a TV, an "mm-hm"), and interruptions.
import { type Demo, STAGES, type Stage } from "./demo.svelte.ts";
import { ms } from "./format.ts";

let { demo }: { demo: Demo } = $props();

const stt = $derived(demo.activeStt ?? demo.stt);

const LABELS: Record<Stage, string> = {
  mic: "Mic",
  vad: "VAD",
  stt: "STT",
  turn: "Turn",
  llm: "Claude",
  tts: "TTS",
  speaker: "Speaker",
};

const services = $derived<Record<Stage, string>>({
  mic: "16 kHz",
  vad: "Silero",
  stt: stt === "flux" ? "Flux" : "Nova-3",
  turn: stt === "flux" ? "Flux" : "Smart Turn",
  llm: "Haiku 5.5",
  tts: "Aura 2",
  speaker: "voice to voice",
});

/** What each stage's number means, for its tooltip. */
const TIMINGS: Record<Stage, string> = {
  mic: "",
  vad: "",
  stt: "Time to first byte: from the end of your speech to the transcript",
  turn: "How long after you stopped speaking your turn was judged over",
  llm: "Time to first token",
  tts: "Time to first audio",
  speaker: "Voice to voice: from the end of your turn to the bot's first audio",
};

const live = $derived(demo.busy);
</script>

<div class="pipeline" class:live aria-label="Pipeline, live">
  <ol class="stages">
    {#each STAGES as stage, i (stage)}
      {@const st = demo.pipeline[stage]}
      <li
        class="stage"
        class:active={st.active}
        data-stage={stage}
        data-active={st.active ? "true" : "false"}
        title={TIMINGS[stage] || undefined}
      >
        <span class="name"><span class="dot"></span>{LABELS[stage]}</span>
        <span class="svc">{st.note ?? services[stage]}</span>
        <span class="ms mono">{stage === "mic" || stage === "vad" ? "" : ms(st.ms)}</span>
      </li>
      {#if i < STAGES.length - 1}
        <li class="link" aria-hidden="true"><span></span></li>
      {/if}
    {/each}
  </ol>

  <div class="under" aria-live="polite">
    {#if demo.flash}
      {#key demo.flash.id}
        <span class="chip {demo.flash.kind}">
          {demo.flash.label}{#if demo.flash.text}<q>{demo.flash.text}</q>{/if}
        </span>
      {/key}
    {:else if demo.hearing}
      <span class="hearing"><span class="mono">hearing</span> {demo.hearing}</span>
    {:else}
      <span class="hint">
        {#if live}Speak, or talk over the bot: background speech won't cut it off.{:else}Each stage lights up as it works, with its latest timing.{/if}
      </span>
    {/if}
  </div>
</div>

<style>
  .pipeline {
    position: relative;
    padding: 0.65rem 1rem 0.55rem;
    border-bottom: 1px solid var(--border);
  }
  .stages {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    align-items: stretch;
  }
  .stage {
    flex: 1 1 0;
    min-width: 0;
    display: grid;
    gap: 0.05rem;
    padding: 0.4rem 0.55rem;
    border: 1px solid var(--border);
    border-radius: 0.7rem;
    background: var(--bg);
    transition:
      border-color 0.18s ease,
      background-color 0.18s ease,
      box-shadow 0.18s ease;
  }
  .stage.active {
    border-color: color-mix(in oklab, var(--primary) 65%, var(--border));
    background: color-mix(in oklab, var(--primary) 9%, var(--card));
    box-shadow: 0 0 0 3px var(--glow);
  }
  .name {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-family: var(--font-mono);
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted-fg);
  }
  .stage.active .name {
    color: var(--primary);
  }
  .dot {
    width: 0.4rem;
    height: 0.4rem;
    border-radius: 999px;
    background: color-mix(in oklab, var(--muted-fg) 45%, transparent);
    flex: none;
  }
  .stage.active .dot {
    background: var(--primary);
    animation: beat 0.9s ease-in-out infinite;
  }
  .svc {
    font-size: 0.74rem;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ms {
    font-size: 0.7rem;
    color: var(--muted-fg);
    min-height: 1em;
  }
  .link {
    flex: 0 0 0.6rem;
    display: flex;
    align-items: center;
  }
  .link span {
    width: 100%;
    height: 1px;
    background: var(--border);
  }
  .under {
    display: flex;
    align-items: center;
    min-height: 1.6rem;
    margin-top: 0.45rem;
    font-size: 0.74rem;
    color: var(--muted-fg);
    overflow: hidden;
  }
  .hint,
  .hearing {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hearing {
    color: var(--fg);
  }
  .hearing .mono {
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--primary);
    margin-right: 0.35rem;
  }
  .chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.4rem;
    max-width: 100%;
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    font-size: 0.72rem;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    animation: pop 0.22s ease-out;
  }
  .chip.ignored {
    color: var(--fg);
    background: color-mix(in oklab, var(--warn) 14%, var(--card));
    border-color: color-mix(in oklab, var(--warn) 45%, var(--border));
  }
  .chip.interrupted {
    color: var(--primary-fg);
    background: var(--primary);
    border-color: var(--primary);
  }
  .chip q {
    font-weight: 400;
    color: var(--muted-fg);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  @keyframes beat {
    50% {
      transform: scale(1.5);
      opacity: 0.6;
    }
  }
  @keyframes pop {
    from {
      transform: translateY(3px);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .stage,
    .stage.active .dot,
    .chip {
      transition: none;
      animation: none;
    }
  }

  /* Phones: two rows of compact stages, no connectors. */
  @media (max-width: 640px) {
    .pipeline {
      padding: 0.6rem 0.75rem 0.5rem;
    }
    .stages {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 0.35rem;
    }
    .link {
      display: none;
    }
    .stage {
      padding: 0.3rem 0.4rem;
    }
    .svc {
      font-size: 0.68rem;
    }
  }
</style>
