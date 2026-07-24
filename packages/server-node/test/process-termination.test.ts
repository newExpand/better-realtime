import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { classifyProducerTermination, terminateWithSigkill, waitForProcessExit } from "../src/process-termination.ts";

describe("gateway process termination evidence", () => {
  it("classifies a graceful timeout escalated to SIGKILL as unavailable evidence", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await once(child.stdout!, "data");
      child.kill("SIGTERM");
      const observation = await waitForProcessExit(child, 75);
      expect(observation).toMatchObject({ signalCode: "SIGKILL", escalatedToSigkill: true });
      expect(classifyProducerTermination(observation, true)).toBe("sigkill");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("does not call an observed exit graceful when its required evidence was unavailable", () => {
    expect(classifyProducerTermination({ exitCode: 0, signalCode: null, escalatedToSigkill: false }, false)).toBe("evidence_missing");
  });

  it("fails closed when the target exited while its replacement was prepared", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(child, "exit");
    await expect(terminateWithSigkill(child, "gateway-a")).rejects.toThrow("RT_SIGKILL_TARGET_EXITED:gateway-a");
  });

  it("fails closed when the operating system does not accept SIGKILL", async () => {
    const child = {
      exitCode: null,
      signalCode: null,
      kill: () => false
    } as unknown as ChildProcess;
    await expect(terminateWithSigkill(child, "gateway-b")).rejects.toThrow("RT_SIGKILL_NOT_DELIVERED:gateway-b");
  });

  it("returns only after SIGKILL is observed", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await expect(terminateWithSigkill(child, "gateway-a")).resolves.toMatchObject({ signalCode: "SIGKILL" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
