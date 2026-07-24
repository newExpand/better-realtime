import { createRealtimeServer, postgres } from "better-realtime/server";
import { BoundedLocalEvidenceSink, createDiagnosticSourceAdapter } from "better-realtime/diagnostics";
import { contract } from "./contract.js";

const evidence = new BoundedLocalEvidenceSink();
export const diagnosticSource = createDiagnosticSourceAdapter({
  capabilities: evidence.capabilities,
  query: async () => ({
    coverage: evidence.coverage.snapshot(),
    value: { verdict: "indeterminate" as const, completeness: "partial" as const }
  }),
  proofPolicy: {
    isValid: (value) => value.verdict === "indeterminate" && value.completeness === "partial",
    downgrade: (value) => value,
    isProofSafe: (value) => value.verdict === "indeterminate" && value.completeness === "partial"
  }
});

const profile = postgres({
  connectionString: "postgres://runtime@127.0.0.1/app",
  identityKeys: [{ version: 1, key: "candidate-consumer-identity-key-32-bytes" }]
});

export const server = createRealtimeServer(contract, {
  profile,
  runtimeId: "candidate-consumer",
  originPolicy: { allowedOrigins: ["https://app.example"] },
  authenticate: () => ({
    tenantId: "tenant-a",
    authenticationRealm: "example",
    issuer: "example",
    subject: "user-1",
    permissions: ["write"]
  }),
  streams: {
    room: { authorize: () => true, snapshot: () => ({ messages: [] }) },
    inbox: { authorize: () => true, snapshot: () => ({ items: [] }) }
  },
  commands: {
    sendMessage: {
      authorize: (context) => context.permissions.has("write"),
      targets: (input) => [{ stream: "room", input: { roomId: input.roomId } }],
      execute: async (_context, input, tx) => {
        const inserted = await tx.db.query<{ id: string; text: string }>(
          "INSERT INTO app_messages (room_id, body) VALUES ($1, $2) RETURNING id, body AS text",
          [input.roomId, input.text]
        );
        const created = inserted.rows[0]!;
        tx.emit({ stream: "room", input: { roomId: input.roomId }, event: "messageAdded", data: created });
        return { ok: true };
      }
    },
    markRead: {
      authorize: () => true,
      targets: (input) => [{ stream: "inbox", input: { userId: input.userId } }],
      execute: async (_context, input, tx) => {
        tx.emit({
          stream: "inbox",
          input: { userId: input.userId },
          event: "notificationRead",
          data: { id: input.notificationId, read: true }
        });
        return { ok: true };
      }
    },
    runWorkflow: {
      authorize: () => true,
      targets: (input) => [
        { stream: "room", input: { roomId: input.roomId } },
        { stream: "inbox", input: { userId: input.userId } }
      ],
      execute: async (_context, input, tx) => {
        if (!input.silent) {
          tx.emit({
            stream: "inbox",
            input: { userId: input.userId },
            event: "notificationAdded",
            data: { id: "workflow", read: false }
          });
          tx.emit({
            stream: "room",
            input: { roomId: input.roomId },
            event: "messageAdded",
            data: { id: "workflow", text: "Workflow completed" }
          });
        }
        return { ok: true };
      }
    }
  }
});
