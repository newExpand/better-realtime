# Recovery model

The verified alpha path is cursor replay plus stable command-status reconciliation.

After reconnect, each stream subscribes from its last opaque cursor. The server replays events or sends an atomic snapshot with cursor `S`, head `H`, and catch-up `(S,H]`. Event IDs suppress duplicate reducer effects, and live delivery waits for continuity through the head.

Commands use stable identity within bounded retention. ACK loss triggers status reconciliation; transport acknowledgement is not database commit. `commandResultRetentionMs` never exceeds `idempotencyRetentionMs`. Beyond idempotency retention the server reports unknown and the client does not resend.

Alpha does not claim exactly-once network delivery, unlimited dedupe, resume-token restoration, auth refresh, or foreground stale-socket replacement.
