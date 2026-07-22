import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { disposeRealtimeClient } from "./client.js";
import { createHmrLifecycleRegistry, type HmrLifecycleRegistry } from "./hmr-lifecycle.js";

const root = createRoot(document.getElementById("root")!);
root.render(<StrictMode><App /></StrictMode>);

type DogfoodHmrGlobal = typeof globalThis & {
  __BETTER_REALTIME_DOGFOOD_HMR__?: HmrLifecycleRegistry;
  __BETTER_REALTIME_DOGFOOD_HMR_STATUS__?: () => ReturnType<HmrLifecycleRegistry["status"]>;
};
const dogfoodGlobal = globalThis as DogfoodHmrGlobal;
const hmrLifecycle = dogfoodGlobal.__BETTER_REALTIME_DOGFOOD_HMR__ ?? createHmrLifecycleRegistry();
if (!dogfoodGlobal.__BETTER_REALTIME_DOGFOOD_HMR__) Object.defineProperties(dogfoodGlobal, {
  __BETTER_REALTIME_DOGFOOD_HMR__: { value: hmrLifecycle, configurable: false, enumerable: false, writable: false },
  __BETTER_REALTIME_DOGFOOD_HMR_STATUS__: { value: () => hmrLifecycle.status(), configurable: false, enumerable: false, writable: false }
});

if (import.meta.hot) hmrLifecycle.register(import.meta.hot, root, disposeRealtimeClient, (error) => {
  console.error("RT_CONSUMER_HMR_DISPOSE_FAILED", error);
});
