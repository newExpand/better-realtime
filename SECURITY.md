# Security policy

Only the latest published `0.1.x-alpha` release receives security fixes.

Do not open a public issue for a suspected vulnerability. Use GitHub private vulnerability reporting for `newExpand/better-realtime`. Include affected versions, impact, and a minimal reproduction without credentials, customer data, or production evidence payloads.

The alpha server is designed for TLS termination at a trusted reverse proxy. Browser upgrades use an exact Origin allowlist before authentication or resource allocation. Authentication, authorization, database roles, evidence extraction, network exposure, and secret management remain deployment responsibilities.
