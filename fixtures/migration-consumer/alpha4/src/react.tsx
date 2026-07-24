import { createRealtimeClient } from "better-realtime";
import { createRealtimeReact } from "better-realtime/react";
import { contract } from "./contract.js";

const client = createRealtimeClient(contract, {
  url: "wss://app.example/realtime",
  auth: () => ({})
});
const realtime = createRealtimeReact(client);

export function Alpha4Command({ roomId }: { roomId: string }) {
  const command = realtime.useCommand("sendMessage");
  return (
    <button
      disabled={command.totalPendingCount > 0}
      onClick={() => void command.execute({ roomId, text: "before migration" }).completed}
    >
      Send
    </button>
  );
}
