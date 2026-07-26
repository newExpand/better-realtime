# Two-package release boundary

`0.2.0-alpha.1` is the first published release that contains two independently published npm packages:

- `better-realtime`
- `better-realtime-mcp`

Both tarballs come from one reviewed public source commit and one annotated Git tag. They are separate immutable artifacts with separate approved digests, sizes, file manifests, npm package identities, Trusted Publisher environments, registry byte comparisons, and provenance checks. A PostgreSQL migration shipped in the source or package is deployment tooling; package publication never proves that an application's database migration ran successfully.

## Release workflow

The `release-bundle.yml` workflow replaces the historical single-package workflow for this boundary. Before any GitHub or npm mutation it requires the approved SHA-256, packed size, unpacked size, and file count for both tarballs. It fills one exact draft prerelease containing:

- both tarballs;
- one checksum file per tarball;
- one deterministic public bundle identity.

The public bundle identity is immutable prepublication evidence. Its registry URLs, bytes, and dist-tags are explicitly `expectedNpmRegistry` values, not observations, and its completed-check list stops at the reviewed source/workflow, approved tarballs, and exact draft assets. It does not claim that npm bytes or provenance were already verified. Its `generatedAt` value is a required, separately approved canonical ISO-8601 UTC dispatch input; it is the actual evidence-generation time, not a source or workflow commit timestamp. The verification-only workflow reports those post-publication results independently and never rewrites the immutable identity asset.

GitHub requires `Workflows: write` in addition to `Contents: write` when a
Release resolves to a commit that changes `.github/workflows/**`. The
Actions-provided `GITHUB_TOKEN` cannot receive that permission. The workflow
therefore never attempts to create or publish such a Release. It reports one
of two explicit operator handoffs instead:

1. `create_draft`: an authenticated maintainer creates the exact draft with a
   local GitHub OAuth session that has `repo` and `workflow` scopes. The
   numeric Release ID, annotated tag, target, title, body hash, draft state,
   prerelease state, and empty asset set must all match before a new dispatch.
2. `finalize_draft`: after the workflow has uploaded and byte-verified all five
   assets and created all three artifact attestations, the maintainer publishes
   only that exact numeric draft with the same local OAuth boundary. The next
   dispatch must observe `immutable:true` and the exact assets before npm
   publication becomes eligible.

Both handoffs deliberately end the workflow run with a non-success conclusion.
They are release states that require operator action, not successful
publications. Before creating attestations, the isolated no-checkout
attestation job bounded-observes all three approved SHA-256 subjects in the
same job attempt that owns the sole mutation. Exactly zero attestations
permits creation; exactly one cryptographically verified attestation for each
subject permits a mutation-free resume. Partial, duplicate, mismatched,
unavailable, or timed-out state fails closed. A failed-job rerun and a later
dispatch therefore both re-observe and verify existing attestations instead
of creating duplicates.

Do not add a PAT, GitHub App key, or workflow secret to bypass these handoffs.
Do not change repository-wide default workflow permissions: neither action
grants the unavailable `Workflows: write` permission to `GITHUB_TOKEN`.
[GitHub's Create and Update Release contract](https://docs.github.com/en/rest/releases/releases)
is authoritative for this boundary.

The draft is published only after all five assets have exact identity and all three non-checksum artifacts have GitHub artifact attestations. `better-realtime` is published and fully verified before `better-realtime-mcp` becomes eligible for publication. Each publish job has a different protected GitHub Environment and a package-qualified durable publish-intent marker. An explicitly approved partial-publication recovery dispatch verifies an exact existing base package and never enters its OIDC publish job. If a publish intent exists while registry absence remains ambiguous, the workflow stops rather than repeating `npm publish`. After the companion package is visible, never redispatch `release-bundle.yml`; use only the no-OIDC verification workflow.

`release-bundle-verify.yml` is verification-only. It has no OIDC authority and no publish command. It downloads the immutable GitHub assets by numeric Release ID; verifies the annotated tag, public identity schema and every source/workflow/Release/package field; checks SHA-256, SHA-512, integrity, packed and unpacked sizes, exact file manifests, checksum sidecars, expected dist-tags, and all three GitHub artifact attestations; retrieves both registry tarballs with bounded polling; compares every byte; installs the exact tarballs in isolated browser/server/MCP consumers; and independently verifies each npm signature/provenance identity. A registry or dist-tag lookup error is a verification failure and is never interpreted as an absent tag.

The workflow pins npm `11.18.0` before reading `npm audit signatures
--include-attestations` output and requires that exact version. npm 10 can
report empty `invalid` and `missing` arrays without emitting the verified
attestation bundle required by this verifier. That older response is
incomplete, not a successful proof, and remains fail-closed.

A partial-publication recovery can legitimately have three different workflow
identities:

- the workflow commit recorded by the immutable public identity and GitHub
  artifact attestations;
- the workflow commit/run/attempt that published each npm package;
- the newer reviewed control workflow commit that performs recovery.

Recovery accepts that split only through explicit inputs. It verifies the
existing immutable identity and attestations against their original workflow,
verifies each package provenance against that package's original publish
workflow/run/attempt, and checks that all older workflow revisions are
ancestors of the current reviewed recovery revision. When the base package is
already exact, its OIDC publish job is skipped entirely; registry bytes and
provenance are verified read-only before the companion package can become
eligible. A missing or mismatched Release ID, workflow SHA, run, attempt,
intent, asset, attestation, or registry artifact stops recovery. The workflow
never treats an existing version as permission to call `npm publish` again.
The standalone verifier also binds its actual GitHub execution revision to the
reviewed control SHA and validates the immutable identity's recorded
workflow run/attempt against the Actions API. It accepts independently recorded
identity, base-publish, and companion-publish revisions only when each is an
ancestor of that control revision and each recorded run points to the exact
workflow path and head SHA.

## Completed companion bootstrap and current registry boundary

The one-time companion bootstrap is complete and must not be repeated. `better-realtime-mcp@0.0.0-bootstrap.0` is the preserved inert reservation, and its `bootstrap` tag remains fixed. The published application packages are `better-realtime@0.2.0-alpha.1` and `better-realtime-mcp@0.2.0-alpha.1`; both `alpha` and `latest` point to that release.

The Trusted Publisher setup is also complete. Both packages authorize only `npm publish` from `newExpand/better-realtime` through `release-bundle.yml`: the base package uses `npm-alpha`, and the companion uses `npm-mcp-alpha`. Both package settings disallow traditional tokens. Both GitHub Environments have the intentional one-maintainer reviewer model, administrator bypass disabled, and zero secrets. The successful `0.2.0-alpha.1` OIDC publications are the functional proof; saving npm settings alone was not proof.

The bootstrap generator and its exact three-file artifact remain historical verification fixtures, not instructions to create another package version. Before a future two-package release, the workflow reconstructs and byte-compares that inert artifact, requires `bootstrap -> 0.0.0-bootstrap.0`, rejects the version being released if it already exists, and validates one of two coherent registry states:

- the historical pre-first-release state, with no real companion version or `alpha` tag and `latest` absent or on the inert bootstrap; or
- the established-package state, where `alpha` and `latest` are equal and point to an existing non-bootstrap alpha version.

Unknown tags, a missing or moved bootstrap, an existing target version, incoherent `alpha`/`latest`, or an unexpected published version fails closed. No current or future release workflow calls `npm publish --tag bootstrap`.

## Interactive `latest` and verification-only completion

OIDC Trusted Publishing performs `npm publish --tag alpha`; it does not move the independent `latest` tag. After both package publications, immutable asset checks, registry byte comparison, signatures, and provenance succeed, the maintainer updates both package defaults in one local WebAuth/2FA session. For the published `0.2.0-alpha.1` release, the exact commands were:

```bash
npm login --auth-type=web --registry=https://registry.npmjs.org
npm dist-tag add better-realtime@0.2.0-alpha.1 latest --registry=https://registry.npmjs.org
npm dist-tag add better-realtime-mcp@0.2.0-alpha.1 latest --registry=https://registry.npmjs.org
npm logout --registry=https://registry.npmjs.org
```

Do not provide the WebAuth session, login URL, password, 2FA value, or recovery code to a workflow or another person. After logout, read-only registry queries must show both packages' `alpha` and `latest` tags on the approved version, the companion `bootstrap` tag on `0.0.0-bootstrap.0`, and `npm whoami --registry=https://registry.npmjs.org` must fail as unauthenticated.

For a future release, substitute only the separately approved version in both `npm dist-tag add` commands. If publication already succeeded but final dist-tag or post-publication verification failed, never redispatch `release-bundle.yml` and never republish either version. Run only `release-bundle-verify.yml`, bound to the original per-package publish workflow SHA/run/attempt and the immutable approved identity.

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
3. Re-observe the preserved companion bootstrap, existing package versions, and coherent current `alpha`/`latest` tags. Do not create another bootstrap version.
4. Produce both release tarballs twice and approve their exact SHA-256, packed size, unpacked size, and file count.
5. Approve the shared source SHA, reviewed workflow SHA, public export digest, exact `evidence_generated_at` ISO-8601 UTC time, both artifact identities (SHA-256, packed size, unpacked size, and file count), and final expected dist-tags. OIDC publication changes only the explicitly requested `alpha` tag and cannot perform `npm dist-tag`.
6. Dispatch `release-bundle.yml`. Complete only an explicitly reported
   `create_draft` or `finalize_draft` handoff with the exact numeric Release
   identity, then dispatch again. A handoff is an observed state transition,
   not a workflow rerun or permission workaround.
7. If publication succeeds but later verification fails, dispatch only `release-bundle-verify.yml` with the original per-package publish workflow SHA/run/attempt. Never move a tag, replace an immutable asset, reuse a version, or republish an already visible package.
