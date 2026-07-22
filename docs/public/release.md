# Release runbook

Release candidate construction, publication, and post-publish verification are separate boundaries. Never rewrite a published version or tag, replace a release asset, or expose private source history.

## Candidate

1. Confirm the private source is clean and matches its private origin.
2. Run `pnpm check`, `pnpm compatibility:check`, PostgreSQL integration, clean-room, browser, lifecycle/load, build, and audit checks.
3. Run `BETTER_REALTIME_RELEASE_EXPORT=1 pnpm package:export-public` and require `sourceMode: "clean_git_index"`.
4. Review the compatibility report and classify every detected outward change in `compatibility/changes.json` as `compatible`, `deprecated`, or `intentionally_breaking`.
5. Select the release boundary from the changed surface: compatible fixes/additions use `0.1.0-alpha.2`; fundamentally incompatible public API/configuration/semantics use `0.2.0-alpha.1`; an incompatible wire contract uses `better-realtime.v2`; PostgreSQL storage changes require a versioned migration.

## Approval-gated publication

The next release uses npm OIDC Trusted Publishing only. The `npm-alpha` GitHub Environment keeps required manual reviewers. The package publishing setting remains `Require two-factor authentication and disallow tokens`, which continues to disallow token-based publishing; no npm token or bootstrap secret is accepted by the workflow.

`release.yml` receives an exact unpublished version and reviewed public commit SHA. Before building it fails closed if any of these already exist:

- the npm package version;
- the target Git tag;
- the GitHub Release or any release asset at that tag.

The workflow isolates trust boundaries in separate jobs. The build job has no OIDC permission, checks out the exact SHA, reruns all candidate gates, requires the exact reviewed file list in `release/package-files.json`, builds one tarball, and verifies it in a clean room. No-OIDC release jobs download that reviewed artifact, create the annotated tag plus asset-complete draft prerelease, publish the GitHub prerelease, and then require the release API's `immutable` flag and exact tag target. Only after that proof does the `npm-alpha` publish job receive `id-token: write`; it has no checkout and runs no repository lifecycle, downloads the exact checksummed artifact, and publishes it through OIDC with provenance. The workflow never mutates a dist-tag separately: the alpha tag is assigned as part of `npm publish`.

GitHub immutable releases must be enabled by a repository administrator before dispatch. The setting is now `enabled:true` for this repository. The default `GITHUB_TOKEN` cannot read the Administration-scoped repository setting, so the workflow still proves the property on the published asset-complete release before npm publication instead of accepting an unverifiable setting claim. If immutability is disabled later, npm publication is blocked and the visible GitHub prerelease remains a fix-forward record.

## Verification-only recovery

Post-publish verification is implemented by the separate `release-verify.yml` verification-only workflow. It has read-only repository permissions, no OIDC permission, and no publish command. It can be dispatched safely with the exact version, public tag, expected SHA-256, public source SHA, and the original publish run ID and attempt without repeating publication.

The verifier requires the release API's `immutable` flag, exact non-draft prerelease identity, annotated tag object, and tag target SHA before downloading the exact two allowed assets. It then polls npm at most 20 times with 15-second intervals. After registry convergence it byte-compares the registry tarball with the release asset, runs the tarball clean-room, cryptographically verifies npm signatures, and fail-closed compares the SLSA provenance subject digest, repository, workflow, environment, source SHA, and original publish run identity before confirming the `alpha` dist-tag. A timeout or mismatch fails without attempting publication or changing external state.

Before pushing a prepared public release commit, run `release:check-public-history` with `BETTER_REALTIME_PUBLIC_AUTHOR_EMAIL`, the immutable `BETTER_REALTIME_PUBLIC_ROOT_COMMIT`, and the current remote `BETTER_REALTIME_PUBLIC_BASE_COMMIT`. The check queries the canonical remote, requires its `main` to equal that base, and compares every existing annotated tag object and target with the checksum-pinned baseline. It permits exactly one English Conventional Commit appended directly to the base, preserves the unique root, rejects merge or extra local commits, validates every author/message and fetch/push URL, and rejects any unapproved ref or Git object regardless of object type. This append-only mode replaces the one-root-only bootstrap check used before the public repository existed; it never authorizes rewriting the root or an existing tag, or pre-creating the next release tag.

## Alpha.1 historical boundary

The published npm version and artifact for `better-realtime@0.1.0-alpha.1` are a non-republishable preservation baseline. Public annotated tag `v0.1.0-alpha.1` and its two release assets are checksum-verified and preserved by project policy. The repository setting was `enabled:false` when alpha.1 was published, and that historical GitHub Release remains `immutable:false`; GitHub does not enforce immutability for it. The repository setting is now `enabled:true`, but GitHub applies the setting only to future releases and does not change alpha.1 retroactively. The one-time packages-all bootstrap GAT path is permanently closed and absent from current workflows. The bootstrap credential was revoked, the GitHub Environment secret was removed, and token-based publishing is disabled. Functional OIDC publication remains unverified until a separately approved later version is published.

## Failure handling

Never overwrite a version, move a public tag, or replace an asset. Preserve the checksum and evidence, document the failure, and fix forward in a later version. If publication succeeded but verification failed, rerun only `release-verify.yml`. If an immutable target appeared before publication, stop and select a new reviewed version rather than deleting or reusing it.
