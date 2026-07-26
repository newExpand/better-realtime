# Stability and compatibility

`0.1.0-alpha.1` remains the fixed first-public compatibility baseline, while `0.2.0-alpha.1` is the current published API/package/storage baseline. Neither is a promise of indefinite backward compatibility. Public behavior is not changed silently: each outward change is classified and checked against the applicable published npm tarball. This baseline statement does not claim GitHub-enforced release immutability for the historical alpha.1 release.

## Version boundaries

- Bug fixes, additive APIs, and improvements compatible with the current `0.2.0-alpha.1` public contract use the next unused prerelease on the current `0.2.0-alpha.N` line.
- A fundamentally incompatible public API, configuration, or semantic change requires a new minor alpha line and a migration guide. Under the current pre-1.0 policy that would normally begin at the next unused minor's `alpha.1`, but an exact future version is selected only after the change is classified; it is not pre-reserved here.
- An incompatible wire change requires a new WebSocket subprotocol, beginning with `better-realtime.v2`.
- PostgreSQL schema changes occur only through a versioned deployment migration. Runtime startup remains read-only and never applies DDL or a destructive in-place rewrite.
- After stabilization, ordinary Semantic Versioning major boundaries apply.

Every change is declared as `compatible`, `deprecated`, or `intentionally_breaking`. Security, data-integrity, or reliability fixes may intentionally break an unsafe contract, but the new version boundary and migration are explicit.

## Semantic invariants

The following cannot change silently: stable command identity and idempotency; opaque cursor and recovery behavior; transport ACK versus command acceptance/completion/observation; transaction outcome and PostgreSQL migration meaning; diagnostic `proven`, `partial`, and `indeterminate`; evidence completeness; authentication, tenant isolation, and Origin enforcement.

Package SemVer, wire protocol, contract manifest, PostgreSQL storage version, and diagnostic schema version are independent. Compatibility translation is isolated in a protocol translator or compatibility adapter. If that boundary becomes harder to reason about than a clean version split, a new version is preferred.
