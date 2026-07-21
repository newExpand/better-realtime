import { createRealtimeClient } from "better-realtime";
import { createRealtimeReact } from "better-realtime/react";
import { contract } from "./contract.js";

export const client = createRealtimeClient(contract, {
  url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/realtime`,
  auth: () => ({ type: "fixture", tenantId: "tenant-fixture", subject: "browser-user" })
});

export const { useStream, useCommand, useRuntime } = createRealtimeReact(client);

/** Application bootstrap owns terminal physical-runtime cleanup. */
export const disposeRealtimeClient = () => client.dispose();
