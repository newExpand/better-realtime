import { describe, expect, it, vi } from "vitest";
import { prepareRecoveryCandidate, waitForRecoveryReadiness } from "../packages/server-node/src/recovery-readiness.ts";

describe("gateway recovery readiness", () => {
  it("bounds a probe that never resolves", async () => {
    const startedAt = performance.now();
    await expect(waitForRecoveryReadiness({
      id: "gateway-a",
      isExited: () => false,
      probe: () => new Promise<boolean>(() => undefined),
      attempts: 2,
      probeTimeoutMs: 10,
      retryDelayMs: 1
    })).rejects.toThrow("RT_RECOVERY_GATEWAY_NOT_READY:gateway-a");
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it("passes the abort signal and accepts only an explicit ready result", async () => {
    const probe = vi.fn(async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return probe.mock.calls.length === 2;
    });
    await waitForRecoveryReadiness({
      id: "gateway-b",
      isExited: () => false,
      probe,
      attempts: 2,
      probeTimeoutMs: 50,
      retryDelayMs: 0
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("fails immediately when the selected process already exited", async () => {
    const probe = vi.fn(async () => true);
    await expect(waitForRecoveryReadiness({
      id: "gateway-a",
      isExited: () => true,
      probe
    })).rejects.toThrow("RT_RECOVERY_GATEWAY_EXITED:gateway-a");
    expect(probe).not.toHaveBeenCalled();
  });

  it("preserves the final explicit unready reason", async () => {
    try {
      await waitForRecoveryReadiness({
        id: "gateway-a",
        isExited: () => false,
        attempts: 2,
        retryDelayMs: 0,
        probe: async () => ({ ready: false, reason: "draining=true" })
      });
      throw new Error("expected readiness to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("RT_RECOVERY_GATEWAY_NOT_READY:gateway-a");
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(((error as Error).cause as Error).message).toBe("RT_RECOVERY_GATEWAY_UNREADY:gateway-a:draining=true");
    }
  });

  it("replaces a live but unready recovery candidate before returning", async () => {
    const current = { boot: "old", ready: false, exited: false };
    const replacement = { boot: "new", ready: true, exited: false };
    const stopped: string[] = [];
    const selected = await prepareRecoveryCandidate({
      id: "gateway-b",
      current,
      isExited: (candidate) => candidate.exited,
      probe: async (candidate) => ({ ready: candidate.ready, reason: "draining=true" }),
      stop: async (candidate) => { stopped.push(candidate.boot); candidate.exited = true; },
      start: async () => replacement
    });
    expect(selected).toBe(replacement);
    expect(stopped).toEqual(["old"]);
  });

  it("fails closed when the fresh recovery candidate never becomes ready", async () => {
    const current = { boot: "old", ready: false, exited: false };
    const replacement = { boot: "new", ready: false, exited: false };
    await expect(prepareRecoveryCandidate({
      id: "gateway-b",
      current,
      isExited: (candidate) => candidate.exited,
      probe: async (candidate) => ({ ready: candidate.ready, reason: `${candidate.boot}:unready` }),
      stop: async (candidate) => { candidate.exited = true; },
      start: async () => replacement
    })).rejects.toThrow("RT_RECOVERY_GATEWAY_NOT_READY:gateway-b");
  });
});
