# Stability and compatibility

`0.1.0-alpha.1` is a fixed, checksum-verified evaluation baseline, not a promise of indefinite backward compatibility. Public behavior is not changed silently: each outward change is classified and checked against the published npm tarball. This baseline statement does not claim GitHub-enforced release immutability for the historical alpha.1 release.

## Version boundaries

- Bug fixes, additive APIs, and improvements compatible with the public contract may ship as `0.1.0-alpha.2`.
- Fundamentally incompatible public API, configuration, or semantic changes require `0.2.0-alpha.1` and a migration guide.
- An incompatible wire change requires a new WebSocket subprotocol, beginning with `better-realtime.v2`.
- PostgreSQL schema changes occur only through a versioned deployment migration. Runtime startup remains read-only and never applies DDL or a destructive in-place rewrite.
- After stabilization, ordinary Semantic Versioning major boundaries apply.

Every change is declared as `compatible`, `deprecated`, or `intentionally_breaking`. Security, data-integrity, or reliability fixes may intentionally break an unsafe contract, but the new version boundary and migration are explicit.

## Semantic invariants

The following cannot change silently: stable command identity and idempotency; opaque cursor and recovery behavior; transport ACK versus command acceptance/completion/observation; transaction outcome and PostgreSQL migration meaning; diagnostic `proven`, `partial`, and `indeterminate`; evidence completeness; authentication, tenant isolation, and Origin enforcement.

Package SemVer, wire protocol, contract manifest, PostgreSQL storage version, and diagnostic schema version are independent. Compatibility translation is isolated in a protocol translator or compatibility adapter. If that boundary becomes harder to reason about than a clean version split, a new version is preferred.
