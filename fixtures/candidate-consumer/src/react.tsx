import { createRealtimeClient } from "better-realtime";
import { createRealtimeReact } from "better-realtime/react";
import { contract } from "./contract.js";

const client = createRealtimeClient(contract, {
  url: "wss://app.example/realtime",
  auth: () => ({})
});
export const realtime = createRealtimeReact(client);

export function UnreadCount({ userId }: { userId: string }) {
  const unread = realtime.useStream("inbox", { userId }, {
    select: (snapshot) => snapshot.data.items.filter((item) => !item.read).length
  });
  return <output>{unread}</output>;
}

export function MarkRead({ userId, notificationId }: { userId: string; notificationId: string }) {
  const command = realtime.useCommand("markRead", { pendingUntil: "observed" });
  return (
    <button
      disabled={command.isPending}
      onClick={() => void command.executeAsync({ userId, notificationId })}
    >
      Mark read
    </button>
  );
}
