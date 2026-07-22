# Dogfooding the alpha

The repository's dogfooding path installs built tarballs into an external consumer rather than importing workspace source.

```sh
pnpm compatibility:check
pnpm test:postgres:docker
pnpm compatibility:matrix
pnpm dogfood:browser
```

The matrix covers alpha.1 client to candidate server, candidate client to alpha.1 server, and candidate to candidate. It uses PostgreSQL 18.4 and Chromium, interrupts one of two gateways, drops a command completion, confirms cursor recovery and stable command identity, and compares CLI/MCP diagnosis. Screenshots, traces, video, and evidence are written under `output/`.

Browser observation evidence uses a 64-record HMR-persistent ring. Record sequence remains monotonic across replacement, and any eviction is reported as evidence loss so a bundle cannot remain `complete/proven` silently. The HMR ownership seam repeatedly replaces the bootstrap runtime in tests and requires sockets, listeners, subscriptions, pending disposal work, and active runtime count to return to baseline; asynchronous disposal failures are observable.

This fixture identity and loopback Origin policy are test-only. A real external application must supply its own authentication integration, WSS termination, exact Origin allowlist, migration/runtime database roles, retention policy, and diagnostic export policy.
