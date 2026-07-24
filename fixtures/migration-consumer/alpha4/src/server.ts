import { createRealtimeServer, postgres } from "better-realtime/server";
import { contract } from "./contract.js";

const profile = postgres({
  connectionString: "postgres://runtime@127.0.0.1/app",
  identityKeys: [{ version: 1, key: "migration-consumer-identity-key-32-bytes" }]
});

export const server = createRealtimeServer(contract, {
  profile,
  runtimeId: "migration-alpha4",
  originPolicy: { allowedOrigins: ["https://app.example"] },
  authenticate: () => ({
    tenantId: "tenant-a",
    authenticationRealm: "example",
    issuer: "example",
    subject: "user-1",
    permissions: ["write"]
  }),
  streams: {
    room: {
      authorize: () => true,
      snapshot: () => ({ messages: [], sequence: 0 })
    }
  },
  commands: {
    sendMessage: {
      authorize: (context) => context.permissions.has("write"),
      prepare: (_context, input) => ({
        publish: {
          stream: "room",
          input: { roomId: input.roomId },
          event: "messageAdded",
          data: { text: input.text }
        },
        mutate: async ({ db }) => {
          await db.query("INSERT INTO app_messages (body) VALUES ($1)", [input.text]);
          return { ok: true };
        }
      })
    }
  }
});
