# React client

Create one client in browser bootstrap and pass it to `createRealtimeReact`. Do not create or connect it during SSR/RSC render. One client owns one physical session; cross-tab sharing is not provided.

`useStream` owns a logical subscription through `useSyncExternalStore`. Strict Mode and rerenders do not create duplicate physical connections. Bootstrap owns terminal `client.dispose()` and HMR replacement. The optional `{ select, isEqual }` argument returns a stable selected value so unrelated stream changes do not rerender the component.

Each `execute()` creates a new command ID. Two clicks are two commands. Retry/status reconciliation reuse the returned attempt. `completed` proves server result completion; `observed` proves this client applied every causal effect. `useCommand(name, { pendingUntil })` exposes command-name-scoped `isPending`, `pendingCount`, `lastError`, and `lastAttempt`. `executeAsync(input)` inherits that `pendingUntil` boundary, while `executeAsync(input, { until })` overrides it for one invocation. Runtime-wide activity is available only from `useRuntime().pendingCount`, so command hooks do not subscribe to unrelated runtime changes.

Subscriptions acquire the on-demand connection. `client.connect()` remains available for deliberate warm-up and readiness checks; React components do not own the physical connection. Optimistic UI belongs to the application. A TanStack Query adapter is future, optional, demand-gated work and is not a dependency of the current API.

The default client accepts `url` plus an optional WebSocket constructor. A custom transport uses the framework-neutral `RealtimeTransportFactory`/`RealtimeTransportConnection` contract instead. `transport` is mutually exclusive with `url`, `webSocket`, and `connectTimeoutMs`; ambiguous ownership fails closed. This seam keeps React independent from a physical transport, but it is not a support claim for Socket.IO or another adapter until that adapter passes the common recovery, cleanup, capability, and diagnostics suite.
