export interface RecoveryReadinessOptions {
  id: string;
  isExited(): boolean;
  probe(signal: AbortSignal): Promise<boolean>;
  attempts?: number;
  probeTimeoutMs?: number;
  retryDelayMs?: number;
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
      const ready = await Promise.race([
        options.probe(controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`RT_RECOVERY_GATEWAY_PROBE_TIMEOUT:${options.id}`));
          }, probeTimeoutMs);
        })
      ]);
      if (ready) return;
    } catch (error) {
      lastError = error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (attempt + 1 < attempts && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  throw new Error(`RT_RECOVERY_GATEWAY_NOT_READY:${options.id}`, { cause: lastError });
}

function boundedInteger(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > 60_000) throw new Error(`RT_RECOVERY_READINESS_OPTION_INVALID:${name}`);
  return value;
}
