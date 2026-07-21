import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { CommandAttempt, RealtimeClient, StreamSnapshot } from "@realtime/core";
import type { JsonValue } from "@realtime/protocol/types";

export function createRealtimeReact(client: RealtimeClient) {
  function useStream<TInput extends JsonValue, TState>(name: string, input: TInput): StreamSnapshot<TState> {
    const inputKey = JSON.stringify(input);
    const handle = useMemo(() => client.stream<TInput, TState>(name, input), [name, inputKey]);
    return useSyncExternalStore(handle.subscribe, handle.getSnapshot, handle.getSnapshot);
  }

  function useRuntime() {
    const subscribe = useCallback((listener: () => void) => client.subscribeRuntime(listener), [client]);
    const getSnapshot = useCallback(() => client.runtimeSnapshot(), [client]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  function useCommand<TResult extends JsonValue = JsonValue>(type: string): { execute(input: JsonValue): CommandAttempt<TResult>; pendingCount: number } {
    const runtime = useRuntime();
    const execute = useCallback((input: JsonValue) => client.execute<TResult>(type, input), [type]);
    return { execute, pendingCount: runtime.pendingCount };
  }

  return { client, useStream, useCommand, useRuntime };
}
