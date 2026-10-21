import { RUNTIME_LABELS, RUNTIMES, readPackageCompat } from "@/lib/compat";

/**
 * Runtime compatibility of every workspace package, generated at build time
 * from `pipecat.runtimes` in each packages/<name>/package.json.
 */
export function CompatTable() {
  const packages = readPackageCompat();
  return (
    <div className="not-prose overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b">
            <th className="text-left p-2">Package</th>
            {RUNTIMES.map((r) => (
              <th key={r} className="p-2 text-center whitespace-nowrap">
                {RUNTIME_LABELS[r]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {packages.map((pkg) => (
            <tr key={pkg.name} className="border-b border-fd-border/50">
              <td className="p-2 align-top">
                <code>{pkg.name}</code>
                {pkg.upstream.length > 0 && (
                  <div className="text-xs text-fd-muted-foreground mt-1">
                    {pkg.upstream.map((u) => u.replace(/^src\//, "")).join(", ")}
                  </div>
                )}
              </td>
              {RUNTIMES.map((r) => {
                const ok = pkg.runtimes.includes(r);
                const partial = ok && pkg.partial.includes(r);
                const unsupported = pkg.unsupported.includes(r);
                return (
                  <td
                    key={r}
                    className="p-2 text-center align-top"
                    title={
                      partial
                        ? `partly verified on ${RUNTIME_LABELS[r]}`
                        : ok
                          ? `verified on ${RUNTIME_LABELS[r]}`
                          : unsupported
                            ? "not supported"
                            : "not verified yet"
                    }
                  >
                    {partial ? (
                      "⚠️"
                    ) : ok ? (
                      "✅"
                    ) : (
                      <span className="text-fd-muted-foreground">{unsupported ? "n/a" : "—"}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-fd-muted-foreground mt-2">
        ✅ = a smoke test exercises the package on that runtime (<code>pipecat.runtimes</code> in
        its <code>package.json</code>). ⚠️ = only part of it works there. n/a = the runtime can't run
        it. — = not verified yet. Generated at build time from {packages.length} packages.
      </p>
    </div>
  );
}
