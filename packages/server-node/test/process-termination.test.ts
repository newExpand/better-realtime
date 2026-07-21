import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { classifyProducerTermination, waitForProcessExit } from "../src/process-termination.ts";

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
});
