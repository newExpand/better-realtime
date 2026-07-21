import { DEFAULT_REFERENCE_PORT, ReferenceServer } from "./server.ts";

const contract = { contractId: "recovery.demo", manifestVersion: "1.0.0", manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } as const;
const configuredPort = Number(process.env.REALTIME_SERVER_PORT ?? DEFAULT_REFERENCE_PORT);
if (!Number.isSafeInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) throw new Error("REALTIME_SERVER_PORT must be an integer from 1 to 65535");
const server = new ReferenceServer({ contract, port: configuredPort });
await server.start();
console.log(`reference server listening at ${server.httpUrl}`);

const shutdown = async () => { await server.dispose(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
