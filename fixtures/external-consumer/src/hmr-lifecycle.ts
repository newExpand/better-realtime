export interface HmrLifecycleStatus {
  activeRuntimes: number;
  completedDisposals: number;
  failedDisposals: number;
  pendingDisposals: number;
}

interface HotModule {
  dispose(callback: () => void | Promise<void>): void;
}

interface UnmountableRoot {
  unmount(): void;
}

export interface HmrLifecycleRegistry {
  register(hot: HotModule, root: UnmountableRoot, dispose: () => Promise<void>, observeFailure: (error: unknown) => void): void;
  status(): HmrLifecycleStatus;
  settle(): Promise<void>;
}

export function createHmrLifecycleRegistry(): HmrLifecycleRegistry {
  let activeRuntimes = 0;
  let completedDisposals = 0;
  let failedDisposals = 0;
  const pending = new Set<Promise<void>>();
  return {
    register(hot, root, dispose, observeFailure) {
      activeRuntimes += 1;
      hot.dispose(() => {
        let completion!: Promise<void>;
        completion = (async () => {
          const failures: unknown[] = [];
          try { root.unmount(); }
          catch (error) { failures.push(error); }
          finally { activeRuntimes -= 1; }
          try { await dispose(); }
          catch (error) { failures.push(error); }
          if (failures.length) {
            failedDisposals += 1;
            observeFailure(failures.length === 1 ? failures[0] : new AggregateError(failures, "RT_CONSUMER_HMR_DISPOSE_FAILED"));
          } else completedDisposals += 1;
        })().finally(() => { pending.delete(completion); });
        pending.add(completion);
        return completion;
      });
    },
    status: () => ({ activeRuntimes, completedDisposals, failedDisposals, pendingDisposals: pending.size }),
    settle: async () => { await Promise.all([...pending]); }
  };
}
