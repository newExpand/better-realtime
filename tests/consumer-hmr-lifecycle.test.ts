import { describe, expect, it, vi } from "vitest";
import { createHmrLifecycleRegistry } from "../fixtures/external-consumer/src/hmr-lifecycle.ts";

describe("external consumer HMR ownership seam", () => {
  it("replaces runtimes repeatedly without retaining sockets, listeners, or subscriptions", async () => {
    const registry = createHmrLifecycleRegistry();
    let resources = { sockets: 0, listeners: 0, subscriptions: 0 };
    let previousDispose: (() => void | Promise<void>) | undefined;
    for (let replacement = 0; replacement < 100; replacement += 1) {
      resources = { sockets: resources.sockets + 1, listeners: resources.listeners + 1, subscriptions: resources.subscriptions + 1 };
      let disposeCallback: (() => void | Promise<void>) | undefined;
      registry.register({ dispose: (callback) => { disposeCallback = callback; } }, { unmount: vi.fn() }, async () => {
        resources = { sockets: resources.sockets - 1, listeners: resources.listeners - 1, subscriptions: resources.subscriptions - 1 };
      }, vi.fn());
      await previousDispose?.();
      previousDispose = disposeCallback;
      expect(resources).toEqual({ sockets: 1, listeners: 1, subscriptions: 1 });
      expect(registry.status()).toMatchObject({ activeRuntimes: 1, pendingDisposals: 0, failedDisposals: 0 });
    }
    await previousDispose?.();
    expect(resources).toEqual({ sockets: 0, listeners: 0, subscriptions: 0 });
    expect(registry.status()).toEqual({ activeRuntimes: 0, completedDisposals: 100, failedDisposals: 0, pendingDisposals: 0 });
  });

  it("observes asynchronous disposal failures without retaining pending work", async () => {
    const registry = createHmrLifecycleRegistry();
    const observeFailure = vi.fn();
    let disposeCallback: (() => void | Promise<void>) | undefined;
    registry.register({ dispose: (callback) => { disposeCallback = callback; } }, { unmount: vi.fn() }, async () => { throw new Error("dispose failed"); }, observeFailure);
    await disposeCallback?.();
    expect(observeFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "dispose failed" }));
    expect(registry.status()).toEqual({ activeRuntimes: 0, completedDisposals: 0, failedDisposals: 1, pendingDisposals: 0 });
  });

  it("still disposes the physical client and reports failure when React unmount throws", async () => {
    const registry = createHmrLifecycleRegistry();
    const observeFailure = vi.fn();
    const dispose = vi.fn(async () => undefined);
    let disposeCallback: (() => void | Promise<void>) | undefined;
    registry.register({ dispose: (callback) => { disposeCallback = callback; } }, { unmount: () => { throw new Error("unmount failed"); } }, dispose, observeFailure);
    await disposeCallback?.();
    expect(dispose).toHaveBeenCalledOnce();
    expect(observeFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "unmount failed" }));
    expect(registry.status()).toEqual({ activeRuntimes: 0, completedDisposals: 0, failedDisposals: 1, pendingDisposals: 0 });
  });
});
