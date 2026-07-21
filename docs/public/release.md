# Release runbook

Release-candidate verification and external changes are separate. Never rewrite or expose the private source history.

## Candidate

1. Confirm private `main` is clean and matches its private origin.
2. Run `pnpm check`, PostgreSQL, clean-room, Chromium, lifecycle/load, build, and audit checks.
3. Run `BETTER_REALTIME_RELEASE_EXPORT=1 pnpm package:export-public`, require `sourceMode: "clean_git_index"`, and initialize a new Git repository from only that tree.
4. Generate one `better-realtime-0.1.0-alpha.1.tgz`, record SHA-256, inspect `npm pack --json`, and use that exact artifact for clean-room and publication.

## Approval-gated publication

1. Record the maintainer-approved source export in private release evidence without exposing its private tag, commit, or repository history.
2. Create `newExpand/better-realtime`, commit the exported tree as its clean initial history, push, and verify the remote tree/history/leakage result against the approved manifest.
3. Wait for public CI `verify` and `postgres` to succeed on that root. Do not create or move the immutable public tag while either job is missing or unsuccessful.
4. Push public tag `v0.1.0-alpha.1`, then explicitly dispatch `release.yml`. The approval-gated workflow builds and verifies the artifact, creates a draft prerelease with both tarball and checksum attached, and only then publishes the asset-complete prerelease. This is compatible with immutable GitHub Releases.
5. The same workflow bootstrap-publishes that exact tarball under temporary dist-tag `alpha-candidate`, fetches it back, byte-compares it, runs registry clean-room and signature/provenance verification, then moves `alpha` to that exact version and removes `alpha-candidate`.

## First publish and OIDC

npm requires a package to exist before trusted publishing can be configured. Because `better-realtime` is currently absent and cannot be selected by a package-specific token, the approved non-interactive bootstrap has this actual authority: **Bootstrap GAT authority: packages-all read-write, organizations no-access, bypass-2FA enabled; not package- or version-scoped.** `All Packages` can write every package the npm user can access; neither the token nor npm restricts it to alpha.1. Organization permission is `No access` because organization administration permission is unnecessary and does not grant package publication rights.

Treat `NPM_ALPHA1_BOOTSTRAP_GAT` as a high-impact temporary credential: choose the shortest available expiration (npm currently permits no less than one day), expose it only through the `npm-alpha` GitHub Environment with required manual reviewers, run only the reviewed bootstrap workflow, and revoke it immediately after the first publish and dist-tag operations finish—even if the workflow fails partway. Then configure the trusted publisher for GitHub owner `newExpand`, repository `better-realtime`, workflow `release.yml`, environment `npm-alpha`, allowed action `npm publish`; confirm OIDC publication, set the package to disallow token-based publishing, and prohibit package-level token publishing thereafter. Future workflows must not copy this bootstrap-token path. See npm's official [granular-token permissions](https://docs.npmjs.com/creating-and-viewing-access-tokens/), [2FA publishing contract](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/), and [trusted publishing contract](https://docs.npmjs.com/trusted-publishers/).

Alternative, not selected here: a maintainer can publish the already verified tarball locally with an interactive 2FA prompt. That avoids a packages-all bypass-2FA credential and supplies human proof of presence, but a local machine is not a supported npm provenance builder, so the first artifact would not carry the GitHub Actions provenance attestation. It also separates publish, registry byte verification, dist-tag promotion, and evidence capture across local and CI operations. Changing to that route requires a separate approval and an amended evidence/runbook record; this candidate retains the approval-gated GitHub Actions bootstrap.

The workflow publishes under `alpha-candidate`, verifies registry bytes/install/signatures, and only then promotes `alpha`. Account 2FA by itself cannot satisfy this non-interactive workflow.

Future publishes use a GitHub-hosted runner, a reviewed pinned npm CLI satisfying the trusted-publishing minimum, Node 22.14+, and `id-token: write`. Third-party GitHub Actions are pinned to reviewed full commit SHAs. Public-repository OIDC publishes generate provenance automatically, and `package.json` repository identity must match case-sensitively.

## Failure handling

Never overwrite a version. Deprecate a defective artifact, preserve checksum/evidence, fix forward with a later alpha, and move `alpha` only after registry clean-room verification. Do not rewrite published tags.
