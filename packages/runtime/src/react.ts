import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
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
import type { CommandActivitySnapshot, CommandAttempt, CommandAttemptSnapshot, RealtimeClient, RuntimeSnapshot, StreamSnapshot } from "./index.js";

export interface UseStreamOptions<TSnapshot, TSelected> {
  readonly select: (snapshot: TSnapshot) => TSelected;
  readonly isEqual?: (previous: TSelected, next: TSelected) => boolean;
}

export type CommandPendingBoundary = "completed" | "observed";

export interface UseCommandOptions {
  readonly pendingUntil?: CommandPendingBoundary;
}

export interface ExecuteCommandOptions {
  readonly until?: CommandPendingBoundary;
}

export interface UseCommandResult<TInput, TResult> {
  readonly execute: (input: TInput) => CommandAttempt<TResult>;
  readonly executeAsync: (input: TInput, options?: ExecuteCommandOptions) => Promise<TResult>;
  readonly isPending: boolean;
  readonly pendingCount: number;
  readonly lastError: Error | null;
  readonly lastAttempt: CommandAttemptSnapshot | null;
}

export interface RealtimeReact<TContract extends AnyRealtimeContract> {
  readonly client: RealtimeClient<TContract>;
  useStream<TName extends StreamName<TContract>>(name: TName, input: StreamInput<TContract, TName>): StreamSnapshot<StreamState<TContract, TName>>;
  useStream<TName extends StreamName<TContract>, TSelected>(
    name: TName,
    input: StreamInput<TContract, TName>,
    options: UseStreamOptions<StreamSnapshot<StreamState<TContract, TName>>, TSelected>
  ): TSelected;
  useCommand<TName extends CommandName<TContract>>(
    name: TName,
    options?: UseCommandOptions
  ): UseCommandResult<CommandInput<TContract, TName>, CommandResult<TContract, TName>>;
  useRuntime(): RuntimeSnapshot;
}

export function createRealtimeReact<TContract extends AnyRealtimeContract>(client: RealtimeClient<TContract>): RealtimeReact<TContract> {
  function useStream<TName extends StreamName<TContract>>(name: TName, input: StreamInput<TContract, TName>): StreamSnapshot<StreamState<TContract, TName>>;
  function useStream<TName extends StreamName<TContract>, TSelected>(
    name: TName,
    input: StreamInput<TContract, TName>,
    options: UseStreamOptions<StreamSnapshot<StreamState<TContract, TName>>, TSelected>
  ): TSelected;
  function useStream<TName extends StreamName<TContract>, TSelected>(
    name: TName,
    input: StreamInput<TContract, TName>,
    options?: UseStreamOptions<StreamSnapshot<StreamState<TContract, TName>>, TSelected>
  ): StreamSnapshot<StreamState<TContract, TName>> | TSelected {
    const validatedInput = client.contract.validateStreamInput(name, input) as StreamInput<TContract, TName>;
    const inputKey = stableJson(validatedInput as unknown as JsonValue);
    const handle = useMemo(() => client.stream(name, validatedInput), [name, inputKey]);
    const selector = (options?.select ?? identity) as (
      snapshot: StreamSnapshot<StreamState<TContract, TName>>
    ) => TSelected | StreamSnapshot<StreamState<TContract, TName>>;
    return useSelectedExternalStore(
      handle.subscribe,
      handle.getSnapshot,
      handle.getSnapshot,
      selector,
      options?.isEqual as ((previous: TSelected | StreamSnapshot<StreamState<TContract, TName>>, next: TSelected | StreamSnapshot<StreamState<TContract, TName>>) => boolean) | undefined
    ) as StreamSnapshot<StreamState<TContract, TName>> | TSelected;
  }

  function useRuntime(): RuntimeSnapshot {
    const subscribe = useCallback((listener: () => void) => client.subscribeRuntime(listener), [client]);
    const getSnapshot = useCallback(() => client.runtimeSnapshot(), [client]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  function useCommand<TName extends CommandName<TContract>>(name: TName, options: UseCommandOptions = {}) {
    const subscribe = useCallback((listener: () => void) => client.subscribeCommand(name, listener), [client, name]);
    const getSnapshot = useCallback(() => client.commandSnapshot(name), [client, name]);
    const activity = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const execute = useCallback((input: CommandInput<TContract, TName>) => client.execute(name, input), [client, name]);
    const pendingBoundary = options.pendingUntil ?? "observed";
    const executeAsync = useCallback(async (
      input: CommandInput<TContract, TName>,
      executeOptions: ExecuteCommandOptions = {}
    ): Promise<CommandResult<TContract, TName>> => {
      const attempt = client.execute(name, input);
      const result = await attempt.completed;
      if ((executeOptions.until ?? pendingBoundary) === "observed") await attempt.observed;
      return result;
    }, [client, name, pendingBoundary]);
    const pendingCount = pendingCountFor(activity, pendingBoundary);
    return {
      execute,
      executeAsync,
      isPending: pendingCount > 0,
      pendingCount,
      lastError: activity.lastError,
      lastAttempt: activity.lastAttempt
    };
  }

  return { client, useStream, useCommand, useRuntime };
}

function pendingCountFor(activity: CommandActivitySnapshot, boundary: CommandPendingBoundary): number {
  return boundary === "completed" ? activity.completionPendingCount : activity.observationPendingCount;
}

function identity<TValue>(value: TValue): TValue {
  return value;
}

function useSelectedExternalStore<TSnapshot, TSelected>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => TSnapshot,
  getServerSnapshot: () => TSnapshot,
  select: (snapshot: TSnapshot) => TSelected,
  isEqual: ((previous: TSelected, next: TSelected) => boolean) | undefined
): TSelected {
  const instance = useRef<{ hasValue: boolean; value: TSelected | null }>({ hasValue: false, value: null });
  const [getSelection, getServerSelection] = useMemo(() => {
    let hasMemo = false;
    let memoizedSnapshot: TSnapshot;
    let memoizedSelection: TSelected;
    const memoizedSelect = (nextSnapshot: TSnapshot): TSelected => {
      if (!hasMemo) {
        hasMemo = true;
        memoizedSnapshot = nextSnapshot;
        const nextSelection = select(nextSnapshot);
        if (isEqual && instance.current.hasValue && isEqual(instance.current.value as TSelected, nextSelection)) {
          memoizedSelection = instance.current.value as TSelected;
          return memoizedSelection;
        }
        memoizedSelection = nextSelection;
        return nextSelection;
      }
      if (Object.is(memoizedSnapshot, nextSnapshot)) return memoizedSelection;
      const nextSelection = select(nextSnapshot);
      if (isEqual?.(memoizedSelection, nextSelection)) {
        memoizedSnapshot = nextSnapshot;
        return memoizedSelection;
      }
      memoizedSnapshot = nextSnapshot;
      memoizedSelection = nextSelection;
      return nextSelection;
    };
    return [
      () => memoizedSelect(getSnapshot()),
      () => memoizedSelect(getServerSnapshot())
    ] as const;
  }, [getSnapshot, getServerSnapshot, select, isEqual]);
  const selected = useSyncExternalStore(subscribe, getSelection, getServerSelection);
  useEffect(() => {
    instance.current.hasValue = true;
    instance.current.value = selected;
  }, [selected]);
  return selected;
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
}
