import { createRealtimeServer, postgres } from "better-realtime/server";
import { contract } from "./contract.js";

const runtimeDatabaseUrl = process.env.RUNTIME_DATABASE_URL;
if (!runtimeDatabaseUrl) throw new Error("RUNTIME_DATABASE_URL is required");
const profile = postgres({ connectionString: runtimeDatabaseUrl, identityKeys: [{ version: 1, key: process.env.IDENTITY_KEY ?? "fixture-identity-key-with-at-least-32-bytes" }] });

export const server = createRealtimeServer(contract, {
  profile,
  runtimeId: process.env.RUNTIME_ID ?? "consumer-gateway",
  port: Number(process.env.PORT ?? 0),
  originPolicy: { allowedOrigins: [process.env.APP_ORIGIN ?? "http://127.0.0.1:43117"], allowMissingOrigin: process.env.ALLOW_MISSING_ORIGIN === "true" },
  authenticate: (auth) => {
    if (!auth || typeof auth !== "object" || Array.isArray(auth) || auth.tenantId !== "tenant-fixture" || auth.subject !== "browser-user") throw new Error("RT_AUTH_REQUIRED");
    return { tenantId: "tenant-fixture", authenticationRealm: "fixture", issuer: "fixture-app", subject: "browser-user", permissions: ["room:read", "room:write"] };
  },
  streams: {
    room: {
      authorize: ({ permissions }, input) => permissions.has("room:read") && input.roomId === "42",
      snapshot: async ({ db, tenantId, stream, includedSequence }) => {
        const result = await db.query<{ event_id: string; author: string; body: string; sent_at: Date; sequence: string }>("SELECT event_id, author, body, sent_at, sequence FROM public.consumer_messages WHERE tenant_id=$1 AND stream=$2 AND sequence <= $3 ORDER BY sequence", [tenantId, stream, includedSequence]);
        return { messages: result.rows.map((row) => ({ id: row.event_id, author: row.author, text: row.body, sentAt: row.sent_at.toISOString() })), sequence: includedSequence };
      }
    }
  },
  commands: {
    sendMessage: {
      authorize: ({ permissions }, input) => permissions.has("room:write") && input.roomId === "42",
      prepare: (_context, input) => ({
        publish: { stream: "room", input: { roomId: input.roomId }, event: "messageAdded", data: { author: "You", text: input.text, sentAt: input.sentAt } },
        mutate: async ({ db, tenantId, stream, sequence, eventId }) => {
          await db.query("INSERT INTO public.consumer_messages(tenant_id,stream,sequence,event_id,author,body,sent_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [tenantId, stream, sequence, eventId, "You", input.text, input.sentAt]);
          return { messageId: eventId, sequence };
        }
      })
    }
  },
  diagnostics: {
    defaultDoctorQuery: {
      expectedBoundaries: [{ producerRole: "database", boundary: "db.committed" }, { producerRole: "server", boundary: "command.completed" }],
      expectedProducers: ["database", "server"],
      requireCausalHandoffs: true,
      expectedOutcome: "durable command completed"
    }
  }
});
