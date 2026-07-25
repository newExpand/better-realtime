# Release integrity

Better Realtime treats the package source revision and the release-workflow revision as separate identities.

- The annotated public tag identifies the reviewed package source commit.
- npm provenance identifies the GitHub Actions workflow execution that invoked `npm publish --provenance`, including its repository, workflow path, ref, workflow commit, run, attempt, and environment.
- The immutable GitHub Release asset and npm registry tarball must be byte-identical.

npm provenance therefore does **not** by itself prove that the package source commit equals the workflow commit, or that a public tag points at either commit. The release proof is composite: annotated source tag, immutable Release and asset, registry byte equality, reviewed workflow checks, and npm provenance. A split between the two commits is valid when those links all verify.

For `0.1.0-alpha.4`, the package source and public tag target is `6de3b93c13fad1eb44a65d5fe31ea13c22e96867`, while npm provenance records workflow revision `8e34404dd682d9adc714d7b700add7ee2fda08fc` and run `30009990567`, attempt `1`. This is a normal successful release. The distinction documents an evidence boundary; it is not a vulnerability or a release failure.

For releases after alpha.4, the immutable public identity asset is necessarily created before npm publication. Its `workflow` object therefore identifies the exact release-workflow revision and run that generated and attested the identity asset; it does not claim to be the later npm provenance run. Post-publication verification independently proves the npm publication run and requires both executions to use the same reviewed repository, workflow path, ref, commit, and `npm-alpha` publication policy. A safe new dispatch may have a different run ID while retaining that reviewed workflow revision.

## Verify a release

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

For releases after alpha.4, also download `better-realtime-$version.identity.json`, validate it against [`release/public-release-identity.schema.json`](../../release/public-release-identity.schema.json), and run:

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

The public identity JSON never contains private repository, private export commit/tag, local path, internal document, task/thread, or credential data. Private export identity remains in the private release record.
Its `distTags` object records the exact registry tag state approved for that publication verification; `latest` need not equal the newly published version, and the companion record also preserves `bootstrap -> 0.0.0-bootstrap.0`.
Because the identity asset must be attached before an immutable Release is finalized, its evidence status is `prepublication-approved`. Successful post-publication checks verify the registry bytes, npm provenance run, and tags against that immutable record; they do not rewrite the identity asset to claim a later state.

GitHub documents what [artifact attestations establish](https://docs.github.com/en/actions/concepts/security/artifact-attestations) and how to [generate and verify them](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations). npm documents the scope of [package provenance statements](https://docs.npmjs.com/generating-provenance-statements).
