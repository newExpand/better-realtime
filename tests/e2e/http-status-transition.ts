export interface HttpStatusTransitionOptions {
  expectedStatus: number;
  intervalMs: number;
  timeoutMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface HttpStatusProbeContext {
  remainingMs: number;
  signal: AbortSignal;
}

function transitionMissing(expectedStatus: number, observed: readonly number[]): Error {
  return new Error(
    `RT_E2E_HTTP_STATUS_TRANSITION_MISSING:expected=${expectedStatus}:observed=${observed.join(",")}`,
  );
}

async function probeBeforeDeadline(
  probe: (context: HttpStatusProbeContext) => Promise<number>,
  remainingMs: number,
): Promise<number> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe({ remainingMs, signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("RT_E2E_HTTP_STATUS_PROBE_TIMEOUT"));
          controller.abort();
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function waitForHttpStatusTransition(
  probe: (context: HttpStatusProbeContext) => Promise<number>,
  options: HttpStatusTransitionOptions,
): Promise<readonly number[]> {
  if (!Number.isInteger(options.expectedStatus) || options.expectedStatus < 100 || options.expectedStatus > 599) {
    throw new Error("RT_E2E_HTTP_STATUS_EXPECTED_INVALID");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("RT_E2E_HTTP_STATUS_TIMEOUT_INVALID");
  }
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1 || options.intervalMs > options.timeoutMs) {
    throw new Error("RT_E2E_HTTP_STATUS_INTERVAL_INVALID");
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const started = now();
  const observed: number[] = [];
  while (true) {
    const remainingBeforeProbe = options.timeoutMs - (now() - started);
    if (remainingBeforeProbe <= 0) {
      throw transitionMissing(options.expectedStatus, observed);
    }
    let status: number;
    try {
      status = await probeBeforeDeadline(probe, remainingBeforeProbe);
    } catch (error) {
      if (error instanceof Error && error.message === "RT_E2E_HTTP_STATUS_PROBE_TIMEOUT") {
        throw transitionMissing(options.expectedStatus, observed);
      }
      throw error;
    }
    const elapsed = now() - started;
    if (elapsed > options.timeoutMs) {
      throw transitionMissing(options.expectedStatus, observed);
    }
    observed.push(status);
    if (status === options.expectedStatus) return observed;
    if (elapsed >= options.timeoutMs) {
      throw transitionMissing(options.expectedStatus, observed);
    }
    await sleep(Math.min(options.intervalMs, options.timeoutMs - elapsed));
  }
}
