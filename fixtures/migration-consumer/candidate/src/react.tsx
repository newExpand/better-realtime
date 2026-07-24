import { createRealtimeClient } from "better-realtime";
import { createRealtimeReact } from "better-realtime/react";
import { contract } from "./contract.js";

const client = createRealtimeClient(contract, {
  url: "wss://app.example/realtime",
  auth: () => ({})
});
const realtime = createRealtimeReact(client);

export function CandidateCommand({ roomId }: { roomId: string }) {
  const count = realtime.useStream("room", { roomId }, {
    select: (snapshot) => snapshot.data.messages.length
  });
  const command = realtime.useCommand("sendMessage", { pendingUntil: "observed" });
  // @ts-expect-error 0.2 intentionally removes runtime-wide activity from a command hook.
  void command.totalPendingCount;
  return (
    <button
      disabled={command.isPending}
      onClick={() => void command.executeAsync({ roomId, text: "after migration" })}
    >
      Send ({count}, pending {command.pendingCount})
    </button>
  );
}
