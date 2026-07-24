import { describe, expect, it, vi } from "vitest";
import { waitForRecoveryReadiness } from "../packages/server-node/src/recovery-readiness.ts";

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
});
