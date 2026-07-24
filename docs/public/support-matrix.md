# Alpha support matrix

Support has three independent dimensions: the protocol may define a concept, the current TypeScript runtime may implement it, and specific environments may have executable verification evidence. The generated README table and this document cannot strengthen the states in `support/alpha-0.1.json`.

Published alpha.4 support is React Web, Node.js ESM, native browser WebSocket/Node `ws`, and the PostgreSQL reference profile. The package exposes ESM `import` conditions only; CommonJS `require` is not supported in this alpha. Alpha.4's release evidence is Chromium-only. The private 0.2 candidate additionally exercises Chromium, Firefox, and WebKit, but that does not retroactively expand alpha.4 support. The 100-client Node workload is an environment-fingerprinted regression alarm, not a production SLO or capacity statement.

Session resume restoration, in-session auth refresh, foreground stale-transport replacement, production IdP refresh/revocation, a live production MCP service, general durable evidence aggregation, PostgreSQL replication/failover, and comprehensive exactly-once behavior are not alpha claims. The actual recovery path is cursor replay plus stable command-status reconciliation.

Socket.IO, vendor-neutral telemetry, Sentry, OpenTelemetry, React Native, Go, durable diagnostics export/storage, and an authenticated/authorized/audited production MCP query service are committed post-alpha work without dates. The private candidate's portable manifests, framework-neutral transaction and diagnostic ports, and split MCP package are extension boundaries, not support claims. Presence, Redis, NATS, and Kafka are demand-gated architecture candidates, not committed roadmap items.
