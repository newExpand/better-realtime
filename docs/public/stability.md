# Alpha stability and upgrades

`0.1.0-alpha.1` is an evaluation release, not a production-ready declaration. APIs, storage, diagnostic schemas, and defaults may change between alphas. Compatibility migrations are not promised before a stable data contract exists.

Protocol, npm SemVer, contract identity, payload schema, and diagnostic schema evolve independently. Alpha requires exact contract compatibility and does not support mixed-version rolling deployment. Coordinate deployment or use a versioned host/path.

Published npm versions are immutable. A defective artifact is deprecated and replaced by a later alpha; it is never overwritten.
