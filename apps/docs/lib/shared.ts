export const appName = "pipecat-ts (unofficial)";
export const docsRoute = "/docs";

// The pipecat-ts repository (not Pipecat's). Set PIPECAT_TS_REPO_URL at build
// time to show "Edit on GitHub"-style links; there is no public remote yet.
export const repoUrl: string | undefined = process.env.PIPECAT_TS_REPO_URL || undefined;

export const upstreamUrl = "https://github.com/pipecat-ai/pipecat";
export const upstreamDocsUrl = "https://github.com/pipecat-ai/docs";
