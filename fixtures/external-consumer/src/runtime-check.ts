import { contract } from "./contract.js";
import { notificationContract } from "./notification-fixture.js";

if (!contract.identity.manifestDigest.startsWith("sha256:")) throw new Error("contract digest missing");
if (contract.validateCommandInput("sendMessage", { roomId: "42", text: "hello", sentAt: "2026-07-18T00:00:00.000Z" }).text !== "hello") throw new Error("command validation failed");
if (notificationContract.validateStreamInput("feed", { userId: "user-1" }).userId !== "user-1") throw new Error("second contract composition failed");
if (!notificationContract.validateCommandInput("markRead", { id: "notification-1" }).id) throw new Error("second command validation failed");
if (notificationContract.validateStreamEvent("feed", { type: "notificationAdded", schema: "fixture.notifications.notification-added@1", sequence: 1, data: { id: "notification-1", title: "Build finished", read: false } }).sequence !== 1) throw new Error("second event validation failed");
process.stdout.write(JSON.stringify({ schemaVersion: "1.0", contract: contract.identity, secondFixture: notificationContract.identity.contractId, status: "passed" }));
