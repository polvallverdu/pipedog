import { upstreamDocsUrl, upstreamUrl } from "@/lib/shared";

/** Site-wide notice: unofficial port, and attribution for adapted Pipecat docs. */
export function AttributionNotice({ className }: { className?: string }) {
  return (
    <div
      className={`text-xs text-fd-muted-foreground border-t pt-4 mt-8 space-y-1 ${className ?? ""}`}
    >
      <p>
        pipecat-ts is an <strong>unofficial</strong> community TypeScript port of{" "}
        <a href={upstreamUrl} className="underline">
          Pipecat
        </a>
        . It is not affiliated with or endorsed by Daily or the Pipecat project.
      </p>
      <p>
        Portions adapted from the{" "}
        <a href={upstreamDocsUrl} className="underline">
          Pipecat documentation
        </a>
        , Copyright (c) 2024–2025 Daily, BSD-2-Clause (see{" "}
        <code>apps/docs/LICENSE-pipecat-docs</code>).
      </p>
    </div>
  );
}
