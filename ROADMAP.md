# Roadmap

Better Realtime 0.1.x alpha supports React Web, Node.js, native browser WebSocket/Node `ws`, and PostgreSQL.

Committed post-alpha work, without promised versions or dates: Socket.IO transport, a vendor-neutral telemetry contract, Sentry, OpenTelemetry, React Native, Go server runtime, a durable diagnostic exporter/store, and an authenticated/authorized/audited production MCP query service.

Presence, Redis, NATS, Kafka, other infrastructure adapters, and other language SDKs remain demand-gated candidates. Every future transport or platform must preserve reconnect ownership, replay/dedupe semantics, bounded cleanup, diagnostic completeness, and actual-platform verification before support is claimed.
