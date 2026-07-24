# Two-package release boundary

`0.2.0-alpha.1` is the first candidate that contains two independently published npm packages:

- `better-realtime`
- `better-realtime-mcp`

Both tarballs come from one reviewed public source commit and one annotated Git tag. They are separate immutable artifacts with separate approved digests, sizes, file manifests, npm package identities, Trusted Publisher environments, registry byte comparisons, and provenance checks. A PostgreSQL migration shipped in the source or package is deployment tooling; package publication never proves that an application's database migration ran successfully.

## Release workflow

The `release-bundle.yml` workflow replaces the historical single-package workflow for this boundary. Before any GitHub or npm mutation it requires the approved SHA-256, packed size, unpacked size, and file count for both tarballs. It creates one draft prerelease containing exactly:

- both tarballs;
- one checksum file per tarball;
- one deterministic public bundle identity.

The public bundle identity is immutable prepublication evidence. Its registry URLs, bytes, and dist-tags are explicitly `expectedNpmRegistry` values, not observations, and its completed-check list stops at the reviewed source/workflow, approved tarballs, and exact draft assets. It does not claim that npm bytes or provenance were already verified. Its `generatedAt` value is a required, separately approved canonical ISO-8601 UTC dispatch input; it is the actual evidence-generation time, not a source or workflow commit timestamp. The verification-only workflow reports those post-publication results independently and never rewrites the immutable identity asset.

The draft is finalized only after all five assets have exact identity and all three non-checksum artifacts have GitHub artifact attestations. `better-realtime` is published and fully verified before `better-realtime-mcp` becomes eligible for publication. Each publish job has a different protected GitHub Environment and a package-qualified durable publish-intent marker. If one package exists with exact bytes, a rerun verifies it and never publishes it again. If a publish intent exists while registry absence remains ambiguous, the workflow stops rather than repeating `npm publish`.

`release-bundle-verify.yml` is verification-only. It has no OIDC authority and no publish command. It downloads the immutable GitHub assets by numeric Release ID; verifies the annotated tag, public identity schema and every source/workflow/Release/package field; checks SHA-256, SHA-512, integrity, packed and unpacked sizes, exact file manifests, checksum sidecars, expected dist-tags, and all three GitHub artifact attestations; retrieves both registry tarballs with bounded polling; compares every byte; installs the exact tarballs in isolated browser/server/MCP consumers; and independently verifies each npm signature/provenance identity. A registry or dist-tag lookup error is a verification failure and is never interpreted as an absent tag.

## Trusted Publisher bootstrap for `better-realtime-mcp`

As independently checked on 2026-07-24, `better-realtime-mcp` does not yet exist in the public npm registry. npm's Trusted Publisher setup starts from an existing package's Settings page; a brand-new package cannot use staged publishing either. The release workflow therefore must not be dispatched until a separate, explicitly approved bootstrap has created the package identity and the Trusted Publisher has been saved.

The preferred bootstrap is a local interactive WebAuth/2FA publish of an inert reservation version. It avoids a long-lived or organization-wide automation credential and does not consume the real `0.2.0-alpha.1` identity:

```bash
bootstrap_dir="$(mktemp -d)"
pnpm exec tsx scripts/create-mcp-bootstrap-artifact.ts "$bootstrap_dir"
npm login --auth-type=web
npm publish "$bootstrap_dir/better-realtime-mcp-0.0.0-bootstrap.0.tgz" \
  --tag bootstrap \
  --access public \
  --ignore-scripts
npm logout
```

Do not paste the login URL, password, session credential, OTP, or recovery code into an issue, chat, workflow input, or log. Inspect and approve the generated JSON report and tarball checksum before publishing. The bootstrap version is inert, has three files, and must never receive the `alpha` tag. `npm publish --tag bootstrap` adds the `bootstrap` dist-tag; `latest` is the default only when no explicit tag is supplied. The expected bootstrap state therefore has no `latest` tag. Because registry state is external input, the release preflight defensively permits `latest` only when it points to the same inert bootstrap version and rejects any other value. That allowance is a fail-closed reconciliation guard, not a claim that npm normally creates `latest` for this command.

After npm reports the bootstrap version:

1. In `better-realtime-mcp` package settings, configure GitHub Actions Trusted Publishing with owner `newExpand`, repository `better-realtime`, workflow filename `release-bundle.yml`, Environment `npm-mcp-alpha`, and allowed action `npm publish`.
2. Set Publishing access to **Require two-factor authentication and disallow tokens**.
3. Create the public repository Environment `npm-mcp-alpha` with required human reviewers and zero secrets.
4. Change the existing `better-realtime` Trusted Publisher workflow filename from `release.yml` to `release-bundle.yml`; preserve Environment `npm-alpha` and allowed action `npm publish`.
5. Confirm both Environment secret counts are zero and both package settings match exactly. npm does not validate a Trusted Publisher configuration when it is saved, so the first approved OIDC publication is the functional proof.
6. Confirm that the only version is `0.0.0-bootstrap.0`, `bootstrap` points to it, `alpha` is absent, and `latest` is either absent or points to the same inert version. Leave the `bootstrap` tag on the reservation.

The workflow does not trust the dispatch confirmation alone. Before any tag, Release, asset, or npm mutation, its build job reconstructs the reviewed inert bootstrap tarball, downloads `better-realtime-mcp@0.0.0-bootstrap.0` from npm, byte-compares the two, and verifies the exact one-version/tag state above. Missing, extra, or changed bootstrap state fails closed.

The first real companion release must approve `expected_mcp_latest` as the real release version. OIDC Trusted Publishing performs only `npm publish --tag alpha`; it cannot create or move the separate `latest` tag. Whether bootstrap left `latest` absent or the defensive preflight observed it on the inert version, publication and artifact/provenance verification may succeed while the final dist-tag gate remains pending. The maintainer then performs the separately approved interactive write locally:

```bash
npm login --auth-type=web
npm dist-tag add better-realtime-mcp@0.2.0-alpha.1 latest
npm logout
```

Do not provide the WebAuth session or 2FA value to the workflow or another person. After logout, confirm `npm whoami` is unauthenticated and use read-only registry queries to verify `alpha` and `latest` both point to `0.2.0-alpha.1` while `bootstrap` still points to the inert reservation. Resume only `release-bundle-verify.yml` with the original publish workflow SHA/run/attempt and the immutable approved identity; never repeat either publish.

A short-lived bootstrap GAT is the fallback, not the recommendation. Because the package does not exist when the token is created, npm cannot scope that token to the future package. The fallback therefore requires the shortest available lifetime, packages-all write authority, no organization authority, bypass-2FA only for the one bootstrap, a protected one-shot Environment, immediate revocation after package creation, secret deletion, and independent confirmation that traditional token publishing is disabled. It provides broader temporary authority than local interactive 2FA.

Official npm references:

- [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/)
- [`npm trust github`](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
- [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements/)
- [Staged publishing](https://docs.npmjs.com/staged-publishing/)
- [`npm publish`](https://docs.npmjs.com/cli/publish/)
- [`npm dist-tag`](https://docs.npmjs.com/cli/dist-tag/)

## Approval order

1. Review and push the exact public source/workflow commit.
2. Wait for public CI.
3. Perform and verify the companion bootstrap steps above under a separate approval.
4. Produce both candidate tarballs twice and approve their exact SHA-256, packed size, unpacked size, and file count.
5. Approve the shared source SHA, reviewed workflow SHA, public export digest, exact `evidence_generated_at` ISO-8601 UTC time, both artifact identities (SHA-256, packed size, unpacked size, and file count), and final expected dist-tags. The first real companion release requires `expected_mcp_latest` to equal the candidate version so the release cannot complete until default installation selects the real candidate. Use the literal `absent` only for a package whose registry is permitted to have no `latest` tag; OIDC publication changes only the explicitly requested `alpha` tag and cannot perform `npm dist-tag`.
6. Dispatch `release-bundle.yml`.
7. If publication succeeds but later verification fails, dispatch only `release-bundle-verify.yml` with the original per-package publish workflow SHA/run/attempt. Never move a tag, replace an immutable asset, reuse a version, or republish an already visible package.
