# Changesets

Every PR that changes a published package adds a changeset: `bun changeset`, pick the bump
(patch / minor / major) and write the changelog line. All `@pipedog/*` packages are one **fixed**
group: any release bumps every package to the same version, changed or not.

Merging to `main` keeps a "Version Packages" PR up to date; merging that PR publishes the release.
