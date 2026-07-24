import { createRealtimeServer, postgres } from "better-realtime/server";
import { contract } from "./contract.js";

const profile = postgres({
  connectionString: "postgres://runtime@127.0.0.1/app",
  identityKeys: [{ version: 1, key: "migration-consumer-identity-key-32-bytes" }]
});

export const server = createRealtimeServer(contract, {
  profile,
  runtimeId: "migration-candidate",
  originPolicy: { allowedOrigins: ["https://app.example"] },
  authenticate: () => ({
    tenantId: "tenant-a",
    authenticationRealm: "example",
    issuer: "example",
    subject: "user-1",
    permissions: ["write"]
  }),
  streams: {
    legacyRoom: {
      authorize: () => true,
      snapshot: () => ({ messages: [], sequence: 0 })
    },
    room: {
      authorize: () => true,
      snapshot: () => ({ messages: [] })
    }
  },
  commands: {
    legacySend: {
      authorize: () => true,
      prepare: (_context, input) => ({
        publish: {
          stream: "legacyRoom",
          input: { roomId: input.roomId },
          event: "messageAdded",
          data: { text: input.text }
        },
        mutate: async ({ db }) => {
          await db.query("INSERT INTO app_messages (body) VALUES ($1)", [input.text]);
          return { ok: true };
        }
      })
    },
    sendMessage: {
      authorize: (context) => context.permissions.has("write"),
      targets: (input) => [{ stream: "room", input: { roomId: input.roomId } }],
      execute: async (_context, input, tx) => {
        const inserted = await tx.db.query<{ text: string }>(
          "INSERT INTO app_messages (body) VALUES ($1) RETURNING body AS text",
          [input.text]
        );
        tx.emit({
          stream: "room",
          input: { roomId: input.roomId },
          event: "messageAdded",
          data: { text: inserted.rows[0]!.text }
        });
        return { ok: true };
      }
    }
  }
});
