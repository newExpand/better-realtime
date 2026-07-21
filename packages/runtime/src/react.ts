import { useCallback, useMemo, useSyncExternalStore } from "react";
import type {
  AnyRealtimeContract,
  CommandInput,
  CommandName,
  CommandResult,
  JsonValue,
  StreamInput,
  StreamName,
  StreamState
} from "./contract.js";
import type { CommandAttempt, RealtimeClient, RuntimeSnapshot, StreamSnapshot } from "./index.js";

export interface RealtimeReact<TContract extends AnyRealtimeContract> {
  readonly client: RealtimeClient<TContract>;
  useStream<TName extends StreamName<TContract>>(name: TName, input: StreamInput<TContract, TName>): StreamSnapshot<StreamState<TContract, TName>>;
  useCommand<TName extends CommandName<TContract>>(name: TName): {
    readonly execute: (input: CommandInput<TContract, TName>) => CommandAttempt<CommandResult<TContract, TName>>;
    readonly totalPendingCount: number;
  };
  useRuntime(): RuntimeSnapshot;
}

export function createRealtimeReact<TContract extends AnyRealtimeContract>(client: RealtimeClient<TContract>): RealtimeReact<TContract> {
  function useStream<TName extends StreamName<TContract>>(name: TName, input: StreamInput<TContract, TName>): StreamSnapshot<StreamState<TContract, TName>> {
    const validatedInput = client.contract.validateStreamInput(name, input) as StreamInput<TContract, TName>;
    const inputKey = stableJson(validatedInput as unknown as JsonValue);
    const handle = useMemo(() => client.stream(name, validatedInput), [name, inputKey]);
    return useSyncExternalStore(handle.subscribe, handle.getSnapshot, handle.getSnapshot);
  }

  function useRuntime(): RuntimeSnapshot {
    const subscribe = useCallback((listener: () => void) => client.subscribeRuntime(listener), [client]);
    const getSnapshot = useCallback(() => client.runtimeSnapshot(), [client]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  function useCommand<TName extends CommandName<TContract>>(name: TName) {
    const runtime = useRuntime();
    const execute = useCallback((input: CommandInput<TContract, TName>) => client.execute(name, input), [client, name]);
    return { execute, totalPendingCount: runtime.pendingCount };
  }

  return { client, useStream, useCommand, useRuntime };
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
}
