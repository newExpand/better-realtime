# Contracts and upgrades

Protocol version, npm package SemVer, contract manifest identity, payload schema, PostgreSQL storage version, and diagnostic schema evolve independently.

Within `better-realtime.v1`, alpha.1 and a later client/server may interoperate only when their exact contract identity and deployment capability profile agree. The compatibility matrix exercises alpha.1 client to candidate server, candidate client to alpha.1 server, and candidate to candidate. A contract digest mismatch returns `RT_CONTRACT_INCOMPATIBLE`, an unsupported WebSocket protocol is rejected at the subprotocol boundary, and an internally contradictory capability set returns `RT_CAPABILITY_VIOLATED`.

Protocol v1 advertises server capabilities but does not let a client declare a required capability set in `session.open`. A valid weaker profile is therefore not a generic handshake mismatch. Deployments must route clients to an appropriate profile, clients must not infer unadvertised guarantees, and unsupported operations fail explicitly. Adding client-declared capability requirements would be a versioned protocol change rather than a silent v1 behavior change.

Additive optional frame fields may remain v1-compatible when old peers can safely ignore them and the new peer does not infer an undeclared guarantee. A required field, changed ACK/completion meaning, weakened identity/cursor/recovery rule, or incompatible capability interpretation requires `better-realtime.v2`.

Contract manifest mismatch still requires a coordinated deployment or versioned endpoint. A package-level compatibility result does not authorize mixed application contracts.

PostgreSQL installations are upgraded only by deployment-time, versioned migrations that prove data preservation. Runtime processes validate the installed binding read-only and refuse an unknown storage version.
