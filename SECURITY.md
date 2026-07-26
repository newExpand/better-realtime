# Security policy

Only the current npm `latest` alpha release receives security fixes. At the time of this document update, that release is `0.2.0-alpha.1`.

Do not open a public issue for a suspected vulnerability. Use GitHub private vulnerability reporting for `newExpand/better-realtime`. Include affected versions, impact, and a minimal reproduction without credentials, customer data, or production evidence payloads.

The alpha server is designed for TLS termination at a trusted reverse proxy. Browser upgrades use an exact Origin allowlist before authentication or resource allocation. Authentication, authorization, database roles, evidence extraction, network exposure, and secret management remain deployment responsibilities.
