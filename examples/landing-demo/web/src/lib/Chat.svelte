<script lang="ts">
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The conversation, in order: what the user said (interim, then final), the bot's text as it
// streams, and each tool call as a card with its arguments, status and result.
import type { ChatItem } from "./demo.svelte.ts";
import { formatArgs, resultLinks, summarizeResult } from "./format.ts";
import Icon from "./Icon.svelte";

let {
  items,
  idle,
  offline = false,
}: { items: ChatItem[]; idle: boolean; offline?: boolean } = $props();

let scroller: HTMLDivElement | undefined = $state();

// Keep the newest message in view as the conversation grows or streams.
$effect(() => {
  void items.length;
  void items.at(-1);
  const last = items.at(-1);
  if (last && "text" in last) void last.text;
  if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
});

const suggestions = [
  "What's the weather in Tokyo?",
  "Where is this call running?",
  "How does pipedog detect turns?",
];
</script>

<div class="chat" bind:this={scroller} aria-live="polite" aria-label="Conversation">
  {#if items.length === 0}
    <div class="empty">
      <p class="hint">
        {offline
          ? "The live demo is offline right now. The conversation shows up here when it's on."
          : idle
            ? "Press the mic and say hello. Try:"
            : "Listening…"}
      </p>
      {#if idle && !offline}
        <ul>
          {#each suggestions as s (s)}
            <li>“{s}”</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
  {#each items as item (item.id)}
    {#if item.kind === "user"}
      <div class="row user">
        <p class="bubble user" class:interim={!item.final}>{item.text}</p>
      </div>
    {:else if item.kind === "bot"}
      <div class="row bot">
        <p class="bubble bot">
          {item.text}{#if item.streaming}<span class="caret" aria-hidden="true"></span>{/if}
        </p>
        {#if item.note}<span class="note">{item.note}</span>{/if}
      </div>
    {:else if item.kind === "tool"}
      <div class="tool" data-status={item.status}>
        <div class="tool-head">
          <span class="tool-icon"><Icon name="wrench" size={13} /></span>
          <span class="mono name">{item.name}</span>
          <span class="mono args">({formatArgs(item.args)})</span>
          <span class="status">
            {#if item.status === "running"}
              <Icon name="spinner" size={13} /> running
            {:else if item.status === "done"}
              <Icon name="check" size={13} /> done
            {:else}
              <Icon name="x" size={13} /> cancelled
            {/if}
          </span>
        </div>
        {#if item.status === "done" && item.result !== null}
          <p class="result">{summarizeResult(item.name, item.result)}</p>
          {#each resultLinks(item.name, item.result) as link (link.url)}
            <a class="link mono" href={link.url} target="_blank" rel="noopener">{link.title} ↗</a>
          {/each}
        {/if}
      </div>
    {:else}
      <p class="system">{item.text}</p>
    {/if}
  {/each}
</div>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    padding: 1rem;
    scrollbar-width: thin;
  }
  .empty {
    margin: auto 0;
    color: var(--muted-fg);
    font-size: 0.875rem;
    text-align: center;
  }
  .empty ul {
    list-style: none;
    margin: 0.75rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    align-items: center;
  }
  .empty li {
    border: 1px dashed var(--border);
    border-radius: 999px;
    padding: 0.2rem 0.75rem;
    font-size: 0.8125rem;
  }
  .hint {
    margin: 0;
  }
  .row {
    display: flex;
    flex-direction: column;
  }
  .row.user {
    align-items: flex-end;
  }
  .row.bot {
    align-items: flex-start;
  }
  .bubble {
    margin: 0;
    max-width: 85%;
    padding: 0.5rem 0.8rem;
    border-radius: 1rem;
    font-size: 0.9rem;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .bubble.user {
    background: color-mix(in oklab, var(--primary) 14%, var(--card));
    border-bottom-right-radius: 0.3rem;
  }
  .bubble.user.interim {
    color: var(--muted-fg);
    font-style: italic;
  }
  .bubble.bot {
    background: var(--bg);
    border: 1px solid var(--border);
    border-bottom-left-radius: 0.3rem;
  }
  .note {
    margin-top: 0.2rem;
    font-size: 0.72rem;
    color: var(--muted-fg);
  }
  .caret {
    display: inline-block;
    width: 0.45em;
    height: 1em;
    margin-left: 2px;
    vertical-align: -0.12em;
    background: var(--primary);
    border-radius: 2px;
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
  .tool {
    align-self: stretch;
    margin: 0 1.5rem 0 0;
    border: 1px dashed color-mix(in oklab, var(--primary) 45%, var(--border));
    background: color-mix(in oklab, var(--primary) 5%, var(--card));
    border-radius: 0.75rem;
    padding: 0.5rem 0.7rem;
    font-size: 0.8rem;
  }
  .tool-head {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
  }
  .tool-icon {
    display: inline-flex;
    color: var(--primary);
  }
  .name {
    font-weight: 600;
  }
  .args {
    color: var(--muted-fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.72rem;
    color: var(--muted-fg);
    white-space: nowrap;
  }
  .tool[data-status="done"] .status {
    color: var(--ok);
  }
  .result {
    margin: 0.35rem 0 0;
    color: var(--fg);
  }
  .link {
    display: block;
    margin-top: 0.15rem;
    font-size: 0.75rem;
    color: var(--primary);
    text-decoration: none;
  }
  .system {
    align-self: center;
    margin: 0.25rem 0;
    font-size: 0.75rem;
    color: var(--muted-fg);
  }
</style>
