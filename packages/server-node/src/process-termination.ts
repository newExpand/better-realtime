import type { ChildProcess } from "node:child_process";

export type ProducerTermination = "running" | "graceful" | "sigkill" | "evidence_missing";

export interface ProcessExitObservation {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  escalatedToSigkill: boolean;
}

export async function waitForProcessExit(child: ChildProcess, timeoutMs: number, escalationTimeoutMs = 2_000): Promise<ProcessExitObservation> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(escalationTimeoutMs) || escalationTimeoutMs < 1) throw new Error("process exit timeout must be a positive integer");
  if (child.exitCode !== null || child.signalCode !== null) return { exitCode: child.exitCode, signalCode: child.signalCode, escalatedToSigkill: false };

  const observedExit = new Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (exitCode, signalCode) => resolve({ exitCode, signalCode }));
  });
  const beforeDeadline = await Promise.race([
    observedExit.then((observation) => ({ kind: "exit" as const, observation })),
    delay(timeoutMs).then(() => ({ kind: "timeout" as const }))
  ]);
  if (beforeDeadline.kind === "exit") return { ...beforeDeadline.observation, escalatedToSigkill: false };

  child.kill("SIGKILL");
  const forced = await Promise.race([
    observedExit,
    delay(escalationTimeoutMs).then(() => { throw new Error("process did not exit after SIGKILL escalation"); })
  ]);
  return { ...forced, escalatedToSigkill: true };
}

export async function terminateWithSigkill(child: ChildProcess, id: string, timeoutMs = 2_000): Promise<ProcessExitObservation> {
  if (child.exitCode !== null || child.signalCode !== null) throw new Error(`RT_SIGKILL_TARGET_EXITED:${id}`);
  if (!child.kill("SIGKILL")) throw new Error(`RT_SIGKILL_NOT_DELIVERED:${id}`);
  const observation = await waitForProcessExit(child, timeoutMs);
  if (observation.signalCode !== "SIGKILL") throw new Error(`RT_SIGKILL_NOT_OBSERVED:${id}`);
  return observation;
}

export function classifyProducerTermination(observation: ProcessExitObservation, evidenceCaptured: boolean): Exclude<ProducerTermination, "running"> {
  if (observation.escalatedToSigkill || observation.signalCode === "SIGKILL") return "sigkill";
  return evidenceCaptured ? "graceful" : "evidence_missing";
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
