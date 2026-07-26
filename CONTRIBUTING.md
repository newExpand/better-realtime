# Contributing

Better Realtime welcomes focused bug reports, documentation fixes, conformance cases, and changes that preserve its reliability and evidence contracts.

```sh
corepack pnpm install --frozen-lockfile
pnpm check
pnpm test:postgres:docker
pnpm package:clean-room
pnpm e2e
```

Recovery changes require behavioral and diagnosability coverage. Public claims must update the manifest selected by `support/current.json`; historical support manifests remain immutable records. Do not commit credentials, customer data, private incident bundles, local absolute paths, or generated browser/test output.

## Public history language

All public repository commit subjects and pull request titles must use English Conventional Commits: `type: concise English summary`. Public commit bodies and release-facing change notes must also be written in English.
