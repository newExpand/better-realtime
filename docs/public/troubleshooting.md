# Troubleshooting

## `RT_CONTRACT_INCOMPATIBLE`

Client and server need the exact same contract ID, manifest version, and digest. Deploy together or route versions separately.

## Upgrade rejected before authentication

Confirm browser Origin exactly matches the allowlist, the proxy preserves `Origin` and `Sec-WebSocket-Protocol`, and the protocol is `better-realtime.v1`. Missing Origin requires explicit Node-client opt-in.

## PostgreSQL server remains unready

Run the deploy migration with the migration role, verify the dedicated schema binding, and check database, listener, and outbox access. `/health` intentionally discloses only ready/unready.

## Doctor is incomplete or indeterminate

Completeness covers only declared producers. Missing instances, recorder loss, unresolved transactions, or unavailable resource capture prevent a proven conclusion. Sampled telemetry cannot replace correctness evidence.
