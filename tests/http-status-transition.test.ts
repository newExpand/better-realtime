import { describe, expect, it } from "vitest";
import { waitForHttpStatusTransition } from "./e2e/http-status-transition.ts";

describe("bounded HTTP status transitions", () => {
  it("returns only after the required transition is actually observed", async () => {
    const statuses = [200, 200, 503];
    let now = 0;
    const observed = await waitForHttpStatusTransition(
      async () => statuses.shift() ?? 200,
      {
        expectedStatus: 503,
        timeoutMs: 5_000,
        intervalMs: 100,
        now: () => now,
        sleep: async (milliseconds) => { now += milliseconds; },
      },
    );
    expect(observed).toEqual([200, 200, 503]);
  });

  it("fails closed with the observed sequence when the transition is missing", async () => {
    let now = 0;
    await expect(waitForHttpStatusTransition(
      async () => 200,
      {
        expectedStatus: 503,
        timeoutMs: 250,
        intervalMs: 100,
        now: () => now,
        sleep: async (milliseconds) => { now += milliseconds; },
      },
    )).rejects.toThrow("RT_E2E_HTTP_STATUS_TRANSITION_MISSING:expected=503:observed=200,200,200");
  });

  it("rejects invalid bounds before probing", async () => {
    let probed = false;
    await expect(waitForHttpStatusTransition(
      async () => { probed = true; return 503; },
      { expectedStatus: 503, timeoutMs: 100, intervalMs: 101 },
    )).rejects.toThrow("RT_E2E_HTTP_STATUS_INTERVAL_INVALID");
    expect(probed).toBe(false);
  });

  it("rejects an expected status that arrives after the deadline", async () => {
    let now = 0;
    await expect(waitForHttpStatusTransition(
      async () => {
        now = 5_001;
        return 503;
      },
      {
        expectedStatus: 503,
        timeoutMs: 5_000,
        intervalMs: 100,
        now: () => now,
        sleep: async (milliseconds) => { now += milliseconds; },
      },
    )).rejects.toThrow("RT_E2E_HTTP_STATUS_TRANSITION_MISSING:expected=503:observed=");
  });

  it("bounds a probe that never resolves", async () => {
    const started = Date.now();
    await expect(waitForHttpStatusTransition(
      async ({ signal }) => new Promise<number>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("probe aborted")), { once: true });
      }),
      { expectedStatus: 503, timeoutMs: 25, intervalMs: 5 },
    )).rejects.toThrow("RT_E2E_HTTP_STATUS_TRANSITION_MISSING:expected=503:observed=");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("propagates a probe failure instead of masking it as a missing transition", async () => {
    await expect(waitForHttpStatusTransition(
      async () => { throw new Error("health endpoint failed"); },
      { expectedStatus: 503, timeoutMs: 100, intervalMs: 10 },
    )).rejects.toThrow("health endpoint failed");
  });
});
