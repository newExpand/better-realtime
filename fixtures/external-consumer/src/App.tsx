import { useState } from "react";
import { recordBrowserCommandObserved, useCommand, useRuntime, useStream } from "./client.js";
import "./styles.css";

export function App() {
  const room = useStream("room", { roomId: "42" });
  const send = useCommand("sendMessage");
  const runtime = useRuntime();
  const pendingCount = commandPendingCount(send);
  const [text, setText] = useState("hello from a clean-room app");
  const [commandError, setCommandError] = useState<string | null>(null);
  const [lastCommandState, setLastCommandState] = useState("none");
  return <main>
    <header><span className="eyebrow">External consumer</span><h1>Recovery room</h1><p>A small contract-first React + PostgreSQL journey.</p></header>
    <section className="status"><p data-testid="connection"><span>Connection</span>{runtime.connectionState}/{runtime.sessionState}</p><p data-testid="stream"><span>Stream</span>{room.status} at {room.sequence}</p><p data-testid="command"><span>Command</span>{lastCommandState} / pending {pendingCount}</p></section>
    <ul aria-label="Messages">{room.data.messages.map((message) => <li key={message.id}><strong>{message.author}</strong><span>{message.text}</span></li>)}</ul>
    <div className="composer"><input aria-label="Message" value={text} onChange={(event) => setText(event.target.value)} /><button disabled={!text || pendingCount > 0} onClick={() => { setCommandError(null); const attempt = send.execute({ roomId: "42", text, sentAt: new Date().toISOString() }); setLastCommandState(attempt.state); void (async () => { try { const result = await attempt.completed; await attempt.observed; recordBrowserCommandObserved(attempt.commandId, result.messageId); setLastCommandState(attempt.state); } catch (error) { setLastCommandState(attempt.state); setCommandError(error instanceof Error ? error.message : String(error)); } })(); }}>Send</button></div>
    {commandError ? <p role="alert">{commandError}</p> : null}
  </main>;
}

/** Mixed-version dogfood adapter; application code targets one published surface. */
function commandPendingCount(command: { pendingCount?: number; totalPendingCount?: number }): number {
  return command.pendingCount ?? command.totalPendingCount ?? 0;
}
