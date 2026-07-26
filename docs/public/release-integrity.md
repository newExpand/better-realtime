# Release integrity

Better Realtime treats the package source revision and the release-workflow revision as separate identities.

- The annotated public tag identifies the reviewed package source commit.
- npm provenance identifies the GitHub Actions workflow execution that invoked `npm publish --provenance`, including its repository, workflow path, ref, workflow commit, run, attempt, and environment.
- The immutable GitHub Release asset and npm registry tarball must be byte-identical.

npm provenance therefore does **not** by itself prove that the package source commit equals the workflow commit, or that a public tag points at either commit. The release proof is composite: annotated source tag, immutable Release and asset, registry byte equality, reviewed workflow checks, and npm provenance. A split between the two commits is valid when those links all verify.

For the historical `0.1.0-alpha.4` single-package release, the package source and public tag target is `6de3b93c13fad1eb44a65d5fe31ea13c22e96867`, while npm provenance records workflow revision `8e34404dd682d9adc714d7b700add7ee2fda08fc` and run `30009990567`, attempt `1`. This is a normal successful release. The distinction documents an evidence boundary; it is not a vulnerability or a release failure.

For the published two-package `0.2.0-alpha.1` release, public tag object `0a19477cf4d8ae100260608539da67cb2a3f1d1c` targets package source `763367845c3ff0fee31431297a6722f8a1d0dc81`, and immutable prerelease `359732302` contains both approved tarballs and the public bundle identity. The identity and GitHub artifact attestations record workflow revision `807afccdd547bff72d5580b15350cb0bb596eeee`. npm provenance independently records the base publication from that revision through `npm-alpha` and the companion publication from later reviewed recovery revision `7b26a611a18dca84e5129cde6e5b02340efd311f` through `npm-mcp-alpha`.

For two-package releases, the immutable public identity asset is necessarily created before npm publication. Its `workflow` object identifies the exact release-workflow revision and run that generated and attested the identity asset; it does not claim to be either later npm provenance run. Each package provenance record identifies its own exact reviewed workflow revision, run, attempt, and protected Environment. Post-publication verification proves those identities independently, requires every older revision to be an ancestor of the reviewed verification revision, and byte-compares each registry artifact with its immutable GitHub asset. It never assumes that the identity, base publication, companion publication, and later verification runs are one execution.

## Verify the historical single-package release

Download the GitHub asset and npm tarball into separate directories:

```sh
version=0.1.0-alpha.4
mkdir -p github npm
gh release download "v$version" --repo newExpand/better-realtime \
  --dir github --pattern "better-realtime-$version.tgz*"
npm pack "better-realtime@$version" --pack-destination npm
```

Verify the source tag, immutable Release, and bytes:

```sh
gh api "repos/newExpand/better-realtime/git/ref/tags/v$version"
gh api "repos/newExpand/better-realtime/releases/tags/v$version" \
  --jq '{id,tag_name,target_commitish,draft,prerelease,immutable,assets:[.assets[]|{name,size,digest}]}'
gh release verify "v$version" --repo newExpand/better-realtime
gh release verify-asset "v$version" "github/better-realtime-$version.tgz" \
  --repo newExpand/better-realtime
cmp "github/better-realtime-$version.tgz" "npm/better-realtime-$version.tgz"
shasum -a 256 "github/better-realtime-$version.tgz"
npm view "better-realtime@$version" dist.integrity dist.tarball
mkdir -p signatures
(cd signatures && npm init --yes >/dev/null && \
  npm install --ignore-scripts "better-realtime@$version" && \
  npm audit signatures --json --include-attestations)
```

The alpha.4 identity can also be validated against [`release/public-release-identity.schema.json`](../../release/public-release-identity.schema.json):

```sh
identity="github/better-realtime-$version.identity.json"
source_commit="$(jq -r .packageSource.commit "$identity")"
tag_object="$(jq -r .packageSource.annotatedTagObject "$identity")"
workflow_commit="$(jq -r .workflow.commit "$identity")"
workflow_run="$(jq -r .workflow.runId "$identity")"
workflow_attempt="$(jq -r .workflow.runAttempt "$identity")"
release_id="$(jq -r .githubRelease.id "$identity")"

test "$(gh api "repos/newExpand/better-realtime/git/tags/$tag_object" --jq .object.sha)" = "$source_commit"
test "$(gh api "repos/newExpand/better-realtime/actions/runs/$workflow_run/attempts/$workflow_attempt" --jq .head_sha)" = "$workflow_commit"
pnpm release:identity:verify -- \
  --identity "$identity" \
  --github-asset "github/better-realtime-$version.tgz" \
  --npm-tarball "npm/better-realtime-$version.tgz" \
  --source-commit "$source_commit" \
  --tag-object "$tag_object" \
  --workflow-commit "$workflow_commit" \
  --workflow-run-id "$workflow_run" \
  --workflow-run-attempt "$workflow_attempt" \
  --release-id "$release_id"
gh attestation verify "github/better-realtime-$version.tgz" \
  --repo newExpand/better-realtime \
  --signer-workflow newExpand/better-realtime/.github/workflows/release.yml \
  --signer-digest "$workflow_commit" \
  --source-ref refs/heads/main \
  --source-digest "$workflow_commit"
gh attestation verify "github/better-realtime-$version.identity.json" \
  --repo newExpand/better-realtime \
  --signer-workflow newExpand/better-realtime/.github/workflows/release.yml \
  --signer-digest "$workflow_commit" \
  --source-ref refs/heads/main \
  --source-digest "$workflow_commit"
```

## Verify a two-package release

Download all immutable Release assets and both registry tarballs:

```sh
version=0.2.0-alpha.1
mkdir -p github npm signatures
gh release download "v$version" --repo newExpand/better-realtime \
  --dir github --pattern "*$version*"
npm pack "better-realtime@$version" --pack-destination npm
npm pack "better-realtime-mcp@$version" --pack-destination npm
```

Verify the annotated source tag, immutable prerelease, exact bytes, checksum sidecars, and both npm signature/attestation sets:

```sh
gh api "repos/newExpand/better-realtime/git/ref/tags/v$version"
gh api "repos/newExpand/better-realtime/releases/tags/v$version" \
  --jq '{id,tag_name,target_commitish,draft,prerelease,immutable,assets:[.assets[]|{name,size,digest}]}'
gh release verify "v$version" --repo newExpand/better-realtime
for package in better-realtime better-realtime-mcp; do
  gh release verify-asset "v$version" "github/$package-$version.tgz" \
    --repo newExpand/better-realtime
  cmp "github/$package-$version.tgz" "npm/$package-$version.tgz"
  shasum -a 256 "github/$package-$version.tgz"
done
(cd signatures && npm init --yes >/dev/null && \
  npm install --ignore-scripts \
    "better-realtime@$version" "better-realtime-mcp@$version" && \
  npm audit signatures --json --include-attestations)
```

Validate `github/better-realtime-$version.bundle.identity.json` against [`release/public-release-bundle.schema.json`](../../release/public-release-bundle.schema.json). Its package-source tag must resolve to `packageSource.commit`; its numeric Release ID and five-asset set must match the immutable prerelease; and its base and companion artifact records must match the bytes above. Verify the base npm provenance against `npm-alpha` and the companion provenance against `npm-mcp-alpha`, using each record's own workflow commit, run ID, and attempt. The authoritative full command and verification-only recovery boundary are in [Two-package release boundary](release-bundle.md).

The identity workflow commit—not either npm publication commit—signs the three GitHub attestations:

```sh
identity="github/better-realtime-$version.bundle.identity.json"
identity_workflow_commit="$(jq -r .workflow.commit "$identity")"
for asset in \
  "better-realtime-$version.tgz" \
  "better-realtime-mcp-$version.tgz" \
  "better-realtime-$version.bundle.identity.json"; do
  gh attestation verify "github/$asset" \
    --repo newExpand/better-realtime \
    --signer-workflow newExpand/better-realtime/.github/workflows/release-bundle.yml \
    --signer-digest "$identity_workflow_commit" \
    --source-ref refs/heads/main \
    --source-digest "$identity_workflow_commit"
done
```

The public identity JSON never contains private repository, private export commit/tag, local path, internal document, task/thread, or credential data. Private export identity remains in the private release record.
Its `distTags` object records the exact registry tag state approved for that publication verification; `latest` need not equal the newly published version, and the companion record also preserves `bootstrap -> 0.0.0-bootstrap.0`.
Because the identity asset must be attached before an immutable Release is finalized, its evidence status is `prepublication-approved`. Successful post-publication checks verify the registry bytes, npm provenance run, and tags against that immutable record; they do not rewrite the identity asset to claim a later state.

GitHub documents what [artifact attestations establish](https://docs.github.com/en/actions/concepts/security/artifact-attestations) and how to [generate and verify them](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations). npm documents the scope of [package provenance statements](https://docs.npmjs.com/generating-provenance-statements).
