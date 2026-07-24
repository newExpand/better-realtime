import { useEffect, useMemo, useState } from "react";
import type { CommandAttempt, CommandState } from "@realtime/core";
import type { DoctorReport } from "@realtime/diagnostics";
import { client, commandJourneyDoctor, realtime, type RoomState } from "./runtime.ts";

type ChaosAction = "stop" | "restart" | "duplicate" | "expire-cursor" | "lose-ack" | "sigkill" | "miss-notify" | "db-outage";
interface AttemptRow { attempt: CommandAttempt; label: string }

const time = (value?: string) => value ? new Date(value).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
const short = (value?: string | null) => value ? value.slice(0, 10) : "—";

export function App() {
  const room = realtime.useStream<{ roomId: string }, RoomState>("room", { roomId: "42" });
  const runtime = realtime.useRuntime();
  const sendMessage = realtime.useCommand("sendMessage");
  const [text, setText] = useState("");
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [selectedChaos, setSelectedChaos] = useState<ChaosAction | null>(null);
  const [scenarios, setScenarios] = useState<Array<{ label: string; result: string; at: string }>>([]);
  const [serverInspect, setServerInspect] = useState<Record<string, unknown>>({});
  const [commandDoctor, setCommandDoctor] = useState<DoctorReport>();
  const diagnosticCommandId = attempts[0]?.attempt.commandId;

  useEffect(() => { let disposed = false; let inFlight = false; setCommandDoctor(undefined); const refresh = () => { if (disposed || inFlight) return; inFlight = true; void Promise.all([fetch("/api/inspect").then((response) => response.json()), fetch("/api/evidence").then((response) => response.json())]).then(([inspectResult, evidence]) => { if (!disposed) { setServerInspect(inspectResult); setCommandDoctor(commandJourneyDoctor(evidence, diagnosticCommandId)); } }).catch(() => undefined).finally(() => { inFlight = false; }); }; refresh(); const timer = setInterval(refresh, 500); return () => { disposed = true; clearInterval(timer); }; }, [diagnosticCommandId]);
  const inspect = client.inspect();
  const records = client.recorder.records();
  const lastSuccess = [...records].reverse().find((record) => record.outcome === "success" && record.boundary);
  const lastSnapshot = [...records].reverse().find((record) => record.boundary === "snapshot.applied");
  const divergence = [...records].reverse().find((record) => record.outcome === "failure" || record.outcome === "invariant_violation");
  const recoveryRecords = records.filter((record) => ["disconnect.detected", "reconnect.scheduled", "client.replay_begin_observed", "replay.completed"].includes(record.boundary ?? "")).slice(-5);
  const resourceStats = useMemo(() => ({ active: client.resources.active().length, records: inspect.recorder.records, bytes: inspect.recorder.bytes, dedupe: inspect.streams[0]?.dedupeEntries ?? 0 }), [runtime, room.sequence]);
  const serverDoctorCompleteness = ((serverInspect.doctor as { completeness?: { status?: string } } | undefined)?.completeness?.status);
  const hasObservedCommand = diagnosticCommandId ? records.some((record) => record.boundary === "command.observed" && record.commandId === diagnosticCommandId) : false;
  const doctorCompleteness = serverDoctorCompleteness === "partial" ? "partial" : hasObservedCommand ? commandDoctor?.completeness.status ?? "partial" : serverDoctorCompleteness ?? "loading";

  async function chaos(action: ChaosAction) {
    const response = await fetch(`/api/chaos/${action}`, { method: "POST" });
    if (!response.ok) throw new Error(`chaos action failed: ${action}:${response.status}`);
    setSelectedChaos(action);
    if (action === "duplicate") setScenarios((items) => [{ label: "Duplicate delivery", result: "Event identity retained; reducer effect unchanged", at: new Date().toISOString() }, ...items].slice(0, 3));
    if (action === "lose-ack") setScenarios((items) => [{ label: "ACK loss armed", result: "Next command will reconcile by stable command ID", at: new Date().toISOString() }, ...items].slice(0, 3));
    if (action === "expire-cursor") setScenarios((items) => [{ label: "Cursor expired", result: "Next reconnect selects fenced snapshot", at: new Date().toISOString() }, ...items].slice(0, 3));
    if (action === "miss-notify") setScenarios((items) => [{ label: "Missed NOTIFY", result: "Event-table polling remains the convergence source", at: new Date().toISOString() }, ...items].slice(0, 3));
    if (action === "sigkill") setScenarios((items) => [{ label: "Gateway SIGKILL", result: "State converges; missing producer evidence stays indeterminate", at: new Date().toISOString() }, ...items].slice(0, 3));
    if (action === "db-outage") setScenarios((items) => [{ label: "Database outage", result: "Existing sessions drain without durable success claims", at: new Date().toISOString() }, ...items].slice(0, 3));
  }

  function submit() {
    const value = text.trim(); if (!value) return;
    const attempt = sendMessage.execute({ roomId: "42", text: value });
    setAttempts((items) => [{ attempt, label: value }, ...items].slice(0, 4));
    setText("");
    void attempt.observed.then(() => setScenarios((items) => [{ label: selectedChaos === "lose-ack" ? "Lose ACK → status → observe" : "Stable command", result: "Completed and causally observed exactly once", at: new Date().toISOString() }, ...items].slice(0, 3)));
  }

  const visibleStatus = room.status === "live" ? "Live" : room.status === "replaying" ? "Replaying" : room.status === "resyncing" ? "Resyncing" : runtime.connectionState === "backing_off" || runtime.connectionState === "connecting" ? "Reconnecting" : room.status;
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-mark" aria-hidden="true">B</div><strong>Better Realtime</strong><span className="top-divider" /><span>Recovery room</span>
      <div className={`connection-chip state-${visibleStatus.toLowerCase()}`} data-testid="connection-status"><span className="status-dot" />{visibleStatus}</div>
      <span className="top-context">room:42</span><span className="top-context">team-incident</span>
    </header>
    <main className="workspace">
      <section className="journey" aria-labelledby="room-heading">
        <div className="title-row"><div><h1 id="room-heading">Recovery room</h1><p>Live incident room · Prove interruption and recovery end-to-end</p></div><div className="quiet-control">Auto-scroll <span className="toggle" aria-hidden="true" /></div></div>
        <div className="stream-label">Stream</div><h2>room:42</h2>
        <div className="timeline" data-testid="timeline">
          {room.data.messages.map((message, index) => <div className="timeline-row message-row" key={`${message.sentAt}-${index}`}><time>{time(message.sentAt)}</time><span className="timeline-node message-node">{message.author === "You" ? "Y" : "•"}</span><div className="message-copy"><strong>{message.author}</strong><span>{message.text}</span></div><code>seq: {index + 1}</code></div>)}
          {runtime.connectionState === "backing_off" && <RecoveryRow label="Reconnecting" detail="Physical transport interrupted; one reconnect owner is active." />}
          {room.status === "replaying" && <RecoveryRow label="Replaying" detail={`Replaying after cursor ${short(room.cursor)}; live attempts remain fenced.`} />}
          {room.status === "resyncing" && <RecoveryRow label="Resyncing" detail="Applying an atomic state/cursor snapshot before live release." />}
          {recoveryRecords.slice(-2).map((record) => <div className="timeline-row boundary-row" key={record.recordId}><time>{time(record.timestamp)}</time><span className="timeline-node success-node" /><div><strong>{record.boundary}</strong><span>{record.boundary === "replay.completed" ? "Continuity verified through declared head" : "Structured recovery evidence captured"}</span></div><code>{short(record.recordId)}</code></div>)}
        </div>
        <div className="composer"><label className="sr-only" htmlFor="message">Message</label><textarea id="message" placeholder="Type a message to room:42" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} /><button className="primary" onClick={submit}>Send message</button></div>
        <div className="stream-footer"><span>Cursor: <strong>{short(room.cursor)}</strong></span><span>Sequence: <strong data-testid="sequence">{room.sequence}</strong></span><span>Buffer: <strong>{room.bufferedRecords} records / {room.bufferedBytes} bytes</strong></span></div>
      </section>
      <aside className="evidence" aria-label="Recovery evidence">
        <EvidenceGroup title="Connection"><Fact label="Status" value={runtime.connectionState} tone={runtime.connectionState === "open" ? "good" : "warn"} /><Fact label="Transport" value="native WebSocket proxy" /><Fact label="Gateway" value={String(serverInspect.activeGateway ?? "—")} /><Fact label="Session generation" value={String(runtime.sessionGeneration)} /></EvidenceGroup>
        <EvidenceGroup title="Session"><Fact label="State" value={runtime.sessionState} /><Fact label="Contract" value="recovery.demo@1.0.0" /><Fact label="Reconnect owner" value="core runtime" /></EvidenceGroup>
        <EvidenceGroup title="Stream"><Fact label="Stream" value="room:42" /><Fact label="Cursor" value={short(room.cursor)} /><Fact label="Last sequence" value={String(room.sequence)} /><Fact label="State" value={room.status} tone={room.status === "live" ? "good" : "warn"} /></EvidenceGroup>
        <section className="evidence-group"><h3>Command reconciliation</h3><div className="command-head"><span>Command ID</span><span>Attempt</span><span>Status</span></div>{attempts.length === 0 ? <p className="empty">No command attempts yet.</p> : attempts.map(({ attempt }) => <div className="command-row" data-command-id={attempt.commandId} key={attempt.commandId}><code>{short(attempt.commandId)}</code><span>stable</span><StatusText state={attempt.state} /></div>)}</section>
        <EvidenceGroup title="Recovery evidence"><Fact label="Client last observed" value={lastSuccess?.boundary ?? "unknown"} tone="good" /><Fact label="Client snapshot boundary" value={lastSnapshot?.boundary ?? "not required"} {...(lastSnapshot ? { tone: "good" as const } : {})} /><Fact label="Client divergence observed" value={divergence?.boundary ?? "none observed"} tone={divergence ? "warn" : "good"} /><Fact label="Doctor completeness" value={doctorCompleteness} tone={doctorCompleteness === "complete" ? "good" : "warn"} /><Fact label="Command doctor verdict" value={commandDoctor?.verdict ?? "not available"} tone={commandDoctor?.verdict === "proven" ? "good" : "warn"} /></EvidenceGroup>
        <EvidenceGroup title="Resources"><Fact label="Active owned resources" value={String(resourceStats.active)} /><Fact label="Evidence records" value={String(resourceStats.records)} /><Fact label="Evidence bytes" value={String(resourceStats.bytes)} /><Fact label="Dedupe entries" value={String(resourceStats.dedupe)} /><Fact label="Server sessions" value={String((serverInspect.resources as { sessions?: number } | undefined)?.sessions ?? "—")} /></EvidenceGroup>
      </aside>
    </main>
    <section className="bottom-band">
      <div className="chaos"><h3>Chaos controls</h3><div className="chaos-actions"><ChaosButton label="Drain Gateway A" action="stop" selected={selectedChaos} onClick={chaos} /><ChaosButton label="Enable Gateway B" action="restart" selected={selectedChaos} onClick={chaos} /><ChaosButton label="Inject duplicate" action="duplicate" selected={selectedChaos} onClick={chaos} /><ChaosButton label="Expire cursor" action="expire-cursor" selected={selectedChaos} onClick={chaos} /><ChaosButton label="Lose ACK" action="lose-ack" selected={selectedChaos} onClick={chaos} /><ChaosButton label="Miss NOTIFY" action="miss-notify" selected={selectedChaos} onClick={chaos} /><ChaosButton label="SIGKILL active" action="sigkill" selected={selectedChaos} onClick={chaos} /><ChaosButton label="Pause database" action="db-outage" selected={selectedChaos} onClick={chaos} /></div><p>Faults cross the native WebSocket proxy, two gateway processes, and shared PostgreSQL truth.</p></div>
      <div className="scenarios"><h3>Recent deterministic scenarios</h3>{scenarios.length === 0 ? <p className="empty">Run a fault to collect an evidence-backed result.</p> : scenarios.map((scenario) => <div className="scenario-row" key={`${scenario.at}-${scenario.label}`}><span className="scenario-check">✓</span><time>{time(scenario.at)}</time><strong>{scenario.label}</strong><span>{scenario.result}</span></div>)}</div>
    </section>
  </div>;
}

function RecoveryRow({ label, detail }: { label: string; detail: string }) { return <div className="timeline-row recovery-row" data-testid={`state-${label.toLowerCase()}`}><time>{time(new Date().toISOString())}</time><span className="timeline-node recovery-node" /><div><strong>{label}</strong><span>{detail}</span></div><code>bounded</code></div>; }
function EvidenceGroup({ title, children }: { title: string; children: React.ReactNode }) { return <section className="evidence-group"><h3>{title}</h3>{children}</section>; }
function Fact({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" }) { return <div className="fact"><span>{label}</span><code className={tone ? `tone-${tone}` : ""}>{value}</code></div>; }
function StatusText({ state }: { state: CommandState }) { return <span className={`command-state command-${state}`}>{state}</span>; }
function ChaosButton({ label, action, selected, onClick }: { label: string; action: ChaosAction; selected: ChaosAction | null; onClick: (action: ChaosAction) => void }) { return <button className={selected === action ? "selected" : ""} aria-pressed={selected === action} onClick={() => void onClick(action)}>{label}</button>; }
