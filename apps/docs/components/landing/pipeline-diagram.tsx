// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { AudioLines, MessageSquareText, Mic, Sparkles, Volume2 } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

interface Stage {
  icon: ReactNode;
  name: string;
  code: string;
}

const stages: Stage[] = [
  { icon: <Mic />, name: "Transport in", code: "transport.input()" },
  { icon: <MessageSquareText />, name: "Speech-to-text", code: "stt" },
  { icon: <Sparkles />, name: "LLM", code: "llm" },
  { icon: <AudioLines />, name: "Text-to-speech", code: "tts" },
  { icon: <Volume2 />, name: "Transport out", code: "transport.output()" },
];

/** The frame each stage pushes to the next one. */
const frames = ["InputAudioRawFrame", "TranscriptionFrame", "LLMTextFrame", "TTSAudioRawFrame"];

const index = (i: number) => ({ "--pd-i": i }) as CSSProperties;

/**
 * A voice pipeline, with a frame running through it. Pure CSS animation (.pd-wire and .pd-stage
 * in global.css), which stops under prefers-reduced-motion.
 */
export function PipelineDiagram() {
  return (
    <figure className="pd-pipeline relative w-full rounded-2xl border bg-fd-card/80 p-4 shadow-2xl shadow-orange-950/[0.06] backdrop-blur-sm sm:p-5">
      <figcaption className="mb-4 flex items-center justify-between gap-3 border-b pb-3 font-mono text-xs text-fd-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="flex gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-full bg-fd-foreground/15" />
            <span className="size-2.5 rounded-full bg-fd-foreground/15" />
            <span className="size-2.5 rounded-full bg-fd-foreground/15" />
          </span>
          <span className="ms-2">bot.ts</span>
        </span>
        <span>new Pipeline([ … ])</span>
      </figcaption>
      <ol>
        {stages.map((stage, i) => (
          <li key={stage.name}>
            <div
              className="pd-stage flex items-center gap-3 rounded-xl border bg-fd-background px-3 py-2.5"
              style={index(i)}
            >
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-fd-primary/10 text-fd-primary [&_svg]:size-4">
                {stage.icon}
              </span>
              <span className="flex-1 text-sm font-medium">{stage.name}</span>
              <code className="truncate font-mono text-xs text-fd-muted-foreground">
                {stage.code}
              </code>
            </div>
            {i < frames.length && (
              <div className="relative flex h-11 items-center ps-14">
                <span
                  aria-hidden
                  className="pd-wire absolute inset-y-0 start-7 w-0.5"
                  style={index(i)}
                />
                <code className="rounded-md bg-fd-muted px-1.5 py-0.5 font-mono text-[0.7rem] text-fd-muted-foreground">
                  {frames[i]}
                </code>
              </div>
            )}
          </li>
        ))}
      </ol>
    </figure>
  );
}
