export interface RecoveryReadinessOptions {
  id: string;
  isExited(): boolean;
  probe(signal: AbortSignal): Promise<boolean | RecoveryReadinessObservation>;
  attempts?: number;
  probeTimeoutMs?: number;
  retryDelayMs?: number;
}

export interface RecoveryReadinessObservation {
  ready: boolean;
  reason?: string;
}

export interface RecoveryCandidateOptions<T> {
  id: string;
  current: T | undefined;
  isExited(candidate: T): boolean;
  probe(candidate: T, signal: AbortSignal): Promise<boolean | RecoveryReadinessObservation>;
  stop(candidate: T): Promise<void>;
  start(): Promise<T>;
  currentProbeAttempts?: number;
}

export async function waitForRecoveryReadiness(options: RecoveryReadinessOptions): Promise<void> {
  const attempts = boundedInteger(options.attempts ?? 20, "attempts", 1);
  const probeTimeoutMs = boundedInteger(options.probeTimeoutMs ?? 250, "probeTimeoutMs", 1);
  const retryDelayMs = boundedInteger(options.retryDelayMs ?? 100, "retryDelayMs", 0);
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.isExited()) throw new Error(`RT_RECOVERY_GATEWAY_EXITED:${options.id}`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        options.probe(controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`RT_RECOVERY_GATEWAY_PROBE_TIMEOUT:${options.id}`));
          }, probeTimeoutMs);
        })
      ]);
      const observation = typeof result === "boolean" ? { ready: result } : result;
      if (observation.ready) return;
      lastError = new Error(`RT_RECOVERY_GATEWAY_UNREADY:${options.id}:${observation.reason ?? "unspecified"}`);
    } catch (error) {
      lastError = error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (attempt + 1 < attempts && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  throw new Error(`RT_RECOVERY_GATEWAY_NOT_READY:${options.id}`, { cause: lastError });
}

export async function prepareRecoveryCandidate<T>(options: RecoveryCandidateOptions<T>): Promise<T> {
  let candidate = options.current;
  if (candidate && !options.isExited(candidate)) {
    try {
      await waitForRecoveryReadiness({
        id: options.id,
        isExited: () => options.isExited(candidate!),
        probe: (signal) => options.probe(candidate!, signal),
        attempts: options.currentProbeAttempts ?? 2
      });
      return candidate;
    } catch {
      await options.stop(candidate);
      candidate = undefined;
    }
  }

  candidate = await options.start();
  await waitForRecoveryReadiness({
    id: options.id,
    isExited: () => options.isExited(candidate!),
    probe: (signal) => options.probe(candidate!, signal)
  });
  return candidate;
}

function boundedInteger(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > 60_000) throw new Error(`RT_RECOVERY_READINESS_OPTION_INVALID:${name}`);
  return value;
}
