// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** A shell command with a copy-to-clipboard button. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // No clipboard access (an insecure origin, or denied): the command stays selectable.
    }
  }

  return (
    <div className="group flex items-center gap-3 rounded-xl border bg-fd-card/80 backdrop-blur py-2 ps-4 pe-2 font-mono text-sm shadow-sm">
      <span aria-hidden className="select-none text-fd-primary">
        $
      </span>
      <code className="flex-1 truncate text-fd-foreground">{command}</code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : `Copy "${command}"`}
        className="inline-flex size-8 items-center justify-center rounded-lg text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
      >
        {copied ? <Check className="size-4 text-fd-primary" /> : <Copy className="size-4" />}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}
