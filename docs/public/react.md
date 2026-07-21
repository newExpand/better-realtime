# React client

Create one client in browser bootstrap and pass it to `createRealtimeReact`. Do not create or connect it during SSR/RSC render. One client owns one physical session; cross-tab sharing is not provided.

`useStream` owns a logical subscription through `useSyncExternalStore`. Strict Mode and rerenders do not create duplicate physical connections. Bootstrap owns terminal `client.dispose()` and HMR replacement.

Each `execute()` creates a new command ID. Two clicks are two commands. Retry/status reconciliation reuse the returned attempt. `completed` proves server result completion; `observed` proves this client applied the causal effect. `totalPendingCount` is runtime-global. Optimistic UI belongs to the application or TanStack Query.
