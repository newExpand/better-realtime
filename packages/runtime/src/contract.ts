import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = boolean | { readonly [keyword: string]: JsonValue };

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema" as const;

declare const schemaType: unique symbol;
declare const contractTypes: unique symbol;

export interface RuntimeSchema<T, TSchema extends JsonSchema = JsonSchema, TIdentity extends string = string> {
  readonly identity: TIdentity;
  readonly schema: TSchema;
  readonly [schemaType]: T;
}

export type InferSchema<TSchema> = TSchema extends RuntimeSchema<infer TValue> ? TValue : never;
type RequiredKeys<TSchema> = TSchema extends { readonly required: readonly (infer TKey extends string)[] } ? TKey : never;
type DeclaredObjectProperties<TSchema, TProperties extends Readonly<Record<string, JsonSchema>>> =
  { [TKey in keyof TProperties as TKey extends RequiredKeys<TSchema> ? TKey : never]-?: InferJsonSchema<TProperties[TKey]> }
    & { [TKey in keyof TProperties as TKey extends RequiredKeys<TSchema> ? never : TKey]?: InferJsonSchema<TProperties[TKey]> };
type ObjectFromSchema<TSchema> = TSchema extends { readonly properties: infer TProperties extends Readonly<Record<string, JsonSchema>> }
  ? keyof TProperties extends never
    ? TSchema extends { readonly additionalProperties: false } ? Record<string, never> : JsonObject
    : TSchema extends { readonly additionalProperties: false }
      ? DeclaredObjectProperties<TSchema, TProperties>
      : DeclaredObjectProperties<TSchema, TProperties> & Record<string, JsonValue>
  : JsonObject;
type TupleFromSchemas<TItems extends readonly JsonSchema[]> = { -readonly [TIndex in keyof TItems]: InferJsonSchema<TItems[TIndex]> };
type PrefixVariants<TItems extends readonly JsonSchema[], TPrefix extends JsonValue[] = []> = TItems extends readonly [infer THead extends JsonSchema, ...infer TTail extends readonly JsonSchema[]]
  ? TPrefix | PrefixVariants<TTail, [...TPrefix, InferJsonSchema<THead>]>
  : TPrefix;
type ArrayFromSchema<TSchema> = TSchema extends { readonly prefixItems: infer TItems extends readonly JsonSchema[] }
  ? TSchema extends { readonly minItems: TItems["length"] }
    ? TSchema extends { readonly items: false }
      ? TupleFromSchemas<TItems>
      : TSchema extends { readonly items: infer TAdditional extends JsonSchema }
        ? [...TupleFromSchemas<TItems>, ...InferJsonSchema<TAdditional>[]]
        : [...TupleFromSchemas<TItems>, ...JsonValue[]]
    : TSchema extends { readonly items: false }
      ? PrefixVariants<TItems>
      : TSchema extends { readonly items: infer TAdditional extends JsonSchema }
        ? PrefixVariants<TItems> | [...TupleFromSchemas<TItems>, ...InferJsonSchema<TAdditional>[]]
        : PrefixVariants<TItems> | [...TupleFromSchemas<TItems>, ...JsonValue[]]
  : TSchema extends { readonly items: infer TItems extends JsonSchema } ? InferJsonSchema<TItems>[] : JsonValue[];
type UnionToIntersection<TValue> = (TValue extends unknown ? (value: TValue) => void : never) extends (value: infer TIntersection) => void ? TIntersection : never;
type InferJsonType<TType, TSchema> =
  TType extends "null" ? null :
  TType extends "boolean" ? boolean :
  TType extends "string" ? string :
  TType extends "number" | "integer" ? number :
  TType extends "array" ? ArrayFromSchema<TSchema> :
  TType extends "object" ? ObjectFromSchema<TSchema> : never;
export type InferJsonSchema<TSchema> =
  TSchema extends false ? never :
  TSchema extends true ? JsonValue :
  TSchema extends { readonly const: infer TValue extends JsonValue } ? TValue :
  TSchema extends { readonly enum: readonly (infer TValue)[] } ? Extract<TValue, JsonValue> :
  TSchema extends { readonly oneOf: infer TOptions extends readonly JsonSchema[] } ? InferJsonSchema<TOptions[number]> :
  TSchema extends { readonly anyOf: infer TOptions extends readonly JsonSchema[] } ? InferJsonSchema<TOptions[number]> :
  TSchema extends { readonly allOf: infer TOptions extends readonly JsonSchema[] } ? UnionToIntersection<InferJsonSchema<TOptions[number]>> :
  TSchema extends { readonly type: infer TTypes extends readonly unknown[] } ? InferJsonType<TTypes[number], TSchema> :
  TSchema extends { readonly type: infer TType } ? InferJsonType<TType, TSchema> : JsonValue;
export type EventSchemaMap = Readonly<Record<string, RuntimeSchema<unknown>>>;

export interface ContractStreamEvent<TType extends string = string, TData = unknown> {
  readonly type: TType;
  readonly schema: string;
  readonly data: TData;
  readonly sequence: number;
  readonly eventId?: string;
  readonly commandId?: string;
  readonly cursor?: string;
  readonly occurredAt?: string;
}

export type StreamEvent<TEvents extends EventSchemaMap> = {
  [TName in keyof TEvents & string]: ContractStreamEvent<TName, InferSchema<TEvents[TName]>>
}[keyof TEvents & string];

export interface StreamConfig<TInput, TSnapshot, TEvents extends EventSchemaMap> {
  readonly input: RuntimeSchema<TInput>;
  readonly snapshot: RuntimeSchema<TSnapshot>;
  readonly events: TEvents;
  readonly key: (input: TInput) => string;
  readonly initial: (input: TInput) => TSnapshot;
  readonly applyEvent: (state: TSnapshot, event: StreamEvent<TEvents>) => TSnapshot;
  readonly snapshotSequence: (state: TSnapshot) => number;
}

export interface StreamContract<TInput, TSnapshot, TEvents extends EventSchemaMap> extends StreamConfig<TInput, TSnapshot, TEvents> {
  readonly kind: "stream";
}

export interface StateStreamEventMeta<TType extends string = string> {
  readonly type: TType;
  readonly sequence: number;
  readonly eventId?: string;
  readonly commandId?: string;
  readonly cursor?: string;
  readonly occurredAt?: string;
}

export type StateStreamEventDefinitions<TState, TEvents extends EventSchemaMap> = {
  readonly [TName in keyof TEvents & string]: {
    readonly data: TEvents[TName];
    readonly reduce: (
      state: TState,
      data: InferSchema<TEvents[TName]>,
      meta: StateStreamEventMeta<TName>
    ) => TState;
  }
};

export interface StateStreamConfig<TInput, TState, TEvents extends EventSchemaMap> {
  readonly input: RuntimeSchema<TInput>;
  readonly state: RuntimeSchema<TState>;
  readonly events: StateStreamEventDefinitions<TState, TEvents>;
  readonly key: (input: TInput) => string;
  readonly initial: (input: TInput) => TState;
}

export interface StateStreamContract<TInput, TState, TEvents extends EventSchemaMap> {
  readonly kind: "stream";
  readonly materialization: "state_reducer_v1";
  readonly input: RuntimeSchema<TInput>;
  readonly snapshot: RuntimeSchema<TState>;
  readonly events: TEvents;
  readonly key: (input: TInput) => string;
  readonly initial: (input: TInput) => TState;
  readonly applyEvent: (state: TState, event: StreamEvent<TEvents>) => TState;
}

export type AnyStreamContract = StreamContract<any, any, any> | StateStreamContract<any, any, any>;

export interface CommandConfig<TInput, TResult> {
  readonly input: RuntimeSchema<TInput>;
  readonly result: RuntimeSchema<TResult>;
}

export interface CommandContract<TInput, TResult> extends CommandConfig<TInput, TResult> {
  readonly kind: "command";
}

export type StreamContractMap = Readonly<Record<string, AnyStreamContract>>;
export type CommandContractMap = Readonly<Record<string, CommandContract<any, any>>>;

export interface ContractIdentity {
  readonly contractId: string;
  readonly manifestVersion: string;
  readonly manifestDigest: `sha256:${string}`;
}

export interface StreamManifest {
  readonly input: JsonSchema;
  readonly inputSchema: string;
  readonly snapshot: JsonSchema;
  readonly snapshotSchema: string;
  readonly ordering: "per_stream";
  readonly materialization: "state" | "state_reducer_v1";
  readonly state?: JsonSchema;
  readonly stateSchema?: string;
  readonly events: Readonly<Record<string, { readonly schema: string; readonly payload: JsonSchema }>>;
}

export interface CommandManifest {
  readonly schema: string;
  readonly resultSchema: string;
  readonly input: JsonSchema;
  readonly result: JsonSchema;
}

export interface RealtimeContractManifest {
  readonly protocol: "1.0";
  readonly schemaDialect: typeof JSON_SCHEMA_DIALECT;
  readonly contractId: string;
  readonly manifestVersion: string;
  readonly streams: Readonly<Record<string, StreamManifest>>;
  readonly commands: Readonly<Record<string, CommandManifest>>;
}

export type ContractErrorCode =
  | "RT_CONTRACT_INVALID"
  | "RT_CONTRACT_SCHEMA_INVALID"
  | "RT_CONTRACT_STREAM_UNKNOWN"
  | "RT_CONTRACT_STREAM_INPUT_INVALID"
  | "RT_CONTRACT_STREAM_EVENT_UNKNOWN"
  | "RT_CONTRACT_STREAM_EVENT_INVALID"
  | "RT_CONTRACT_STREAM_SNAPSHOT_INVALID"
  | "RT_CONTRACT_COMMAND_UNKNOWN"
  | "RT_CONTRACT_COMMAND_INPUT_INVALID"
  | "RT_CONTRACT_COMMAND_RESULT_INVALID";

export class RealtimeContractError extends Error {
  readonly name = "RealtimeContractError";

  constructor(
    readonly code: ContractErrorCode,
    readonly member: string,
    readonly issues: readonly string[] = []
  ) {
    super(`${code}: ${member}${issues.length ? ` (${issues.join("; ")})` : ""}`);
  }
}

export interface RealtimeContract<
  TStreams extends StreamContractMap = StreamContractMap,
  TCommands extends CommandContractMap = CommandContractMap
> {
  readonly identity: ContractIdentity;
  readonly manifest: RealtimeContractManifest;
  readonly [contractTypes]: { readonly streams: TStreams; readonly commands: TCommands };
  validateStreamInput<TName extends keyof TStreams & string>(name: TName, value: unknown): StreamInput<RealtimeContract<TStreams, TCommands>, TName>;
  validateStreamSnapshot<TName extends keyof TStreams & string>(name: TName, value: unknown): StreamState<RealtimeContract<TStreams, TCommands>, TName>;
  validateStreamEvent<TName extends keyof TStreams & string>(name: TName, value: unknown): StreamEventFor<RealtimeContract<TStreams, TCommands>, TName>;
  validateCommandInput<TName extends keyof TCommands & string>(name: TName, value: unknown): CommandInput<RealtimeContract<TStreams, TCommands>, TName>;
  validateCommandResult<TName extends keyof TCommands & string>(name: TName, value: unknown): CommandResult<RealtimeContract<TStreams, TCommands>, TName>;
}

export type AnyRealtimeContract = RealtimeContract<any, any>;
export type ContractStreams<TContract extends AnyRealtimeContract> = TContract[typeof contractTypes]["streams"];
export type ContractCommands<TContract extends AnyRealtimeContract> = TContract[typeof contractTypes]["commands"];
export type StreamName<TContract extends AnyRealtimeContract> = keyof ContractStreams<TContract> & string;
export type CommandName<TContract extends AnyRealtimeContract> = keyof ContractCommands<TContract> & string;
export type StreamInput<TContract extends AnyRealtimeContract, TName extends StreamName<TContract>> = InferSchema<ContractStreams<TContract>[TName]["input"]>;
export type StreamState<TContract extends AnyRealtimeContract, TName extends StreamName<TContract>> = InferSchema<ContractStreams<TContract>[TName]["snapshot"]>;
export type StreamEventFor<TContract extends AnyRealtimeContract, TName extends StreamName<TContract>> = StreamEvent<ContractStreams<TContract>[TName]["events"]>;
export type CommandInput<TContract extends AnyRealtimeContract, TName extends CommandName<TContract>> = InferSchema<ContractCommands<TContract>[TName]["input"]>;
export type CommandResult<TContract extends AnyRealtimeContract, TName extends CommandName<TContract>> = InferSchema<ContractCommands<TContract>[TName]["result"]>;

interface CompiledStream {
  readonly definition: AnyStreamContract;
  readonly input: ValidateFunction;
  readonly snapshot: ValidateFunction;
  readonly wireSnapshot: ValidateFunction;
  readonly wireSnapshotSchema: RuntimeSchema<unknown>;
  readonly events: ReadonlyMap<string, { readonly schema: string; readonly validate: ValidateFunction }>;
}

interface CompiledCommand {
  readonly definition: CommandContract<any, any>;
  readonly input: ValidateFunction;
  readonly result: ValidateFunction;
}

export interface ContractRuntime {
  readonly streams: ReadonlyMap<string, CompiledStream>;
  readonly commands: ReadonlyMap<string, CompiledCommand>;
}

const runtimes = new WeakMap<object, ContractRuntime>();

export function jsonSchema<const TIdentity extends string, const TSchema extends JsonSchema>(identity: TIdentity, schema: TSchema): RuntimeSchema<InferJsonSchema<TSchema>, TSchema, TIdentity> {
  assertSchemaIdentity(identity);
  return Object.freeze({ identity, schema: normalizeSchema(schema) }) as unknown as RuntimeSchema<InferJsonSchema<TSchema>, TSchema, TIdentity>;
}

export function stream<TInput, TSnapshot, const TEvents extends EventSchemaMap>(config: StreamConfig<TInput, TSnapshot, TEvents>): StreamContract<TInput, TSnapshot, TEvents> {
  return Object.freeze({ kind: "stream", ...config });
}

export function stateStream<
  const TInputSchema extends RuntimeSchema<any>,
  const TStateSchema extends RuntimeSchema<any>,
  const TEvents extends EventSchemaMap
>(config: {
  readonly input: TInputSchema;
  readonly state: TStateSchema;
  readonly events: StateStreamEventDefinitions<InferSchema<TStateSchema>, TEvents>;
  readonly key: (input: InferSchema<TInputSchema>) => string;
  readonly initial: (input: InferSchema<TInputSchema>) => InferSchema<TStateSchema>;
}): StateStreamContract<InferSchema<TInputSchema>, InferSchema<TStateSchema>, TEvents> {
  const events = Object.fromEntries(
    Object.entries(config.events).map(([name, definition]) => [name, definition.data])
  ) as TEvents;
  const reducers = config.events as unknown as Readonly<Record<string, {
    readonly reduce: (state: InferSchema<TStateSchema>, data: unknown, meta: StateStreamEventMeta) => InferSchema<TStateSchema>;
  }>>;
  return Object.freeze({
    kind: "stream",
    materialization: "state_reducer_v1",
    input: config.input,
    snapshot: config.state,
    events,
    key: config.key,
    initial: config.initial,
    applyEvent: (current: InferSchema<TStateSchema>, event: StreamEvent<TEvents>) => {
      const reducer = reducers[event.type];
      if (!reducer) throw new RealtimeContractError("RT_CONTRACT_STREAM_EVENT_UNKNOWN", event.type);
      return reducer.reduce(current, event.data, {
        type: event.type,
        sequence: event.sequence,
        ...(event.eventId === undefined ? {} : { eventId: event.eventId }),
        ...(event.commandId === undefined ? {} : { commandId: event.commandId }),
        ...(event.cursor === undefined ? {} : { cursor: event.cursor }),
        ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt })
      });
    }
  }) as StateStreamContract<InferSchema<TInputSchema>, InferSchema<TStateSchema>, TEvents>;
}

export function command<TInput, TResult>(config: CommandConfig<TInput, TResult>): CommandContract<TInput, TResult> {
  return Object.freeze({ kind: "command", ...config });
}

export function defineRealtimeContract<
  const TStreams extends Readonly<Record<string, AnyStreamContract>>,
  const TCommands extends Readonly<Record<string, CommandContract<any, any>>>
>(definition: {
  readonly contractId: string;
  readonly manifestVersion: string;
  readonly streams: TStreams;
  readonly commands: TCommands;
}): RealtimeContract<TStreams, TCommands> {
  assertIdentifier(definition.contractId, "contractId");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(definition.manifestVersion)) throw new RealtimeContractError("RT_CONTRACT_INVALID", "manifestVersion", ["expected SemVer"]);

  const streams = new Map<string, CompiledStream>();
  const streamManifest: Record<string, StreamManifest> = {};
  const schemaIdentities = new Map<string, string>();
  for (const name of Object.keys(definition.streams).sort()) {
    assertIdentifier(name, `stream:${name}`);
    const item = definition.streams[name]!;
    if (item.kind !== "stream") throw new RealtimeContractError("RT_CONTRACT_INVALID", `stream:${name}`);
    const events = new Map<string, { schema: string; validate: ValidateFunction }>();
    const eventManifest: Record<string, { schema: string; payload: JsonSchema }> = {};
    for (const eventName of Object.keys(item.events).sort()) {
      assertIdentifier(eventName, `stream:${name}:event:${eventName}`);
      const payload = item.events[eventName]!;
      const schemaName = payload.identity;
      claimSchemaIdentity(schemaIdentities, schemaName, payload.schema, `stream:${name}:event:${eventName}`);
      events.set(eventName, { schema: schemaName, validate: compileSchema(payload.schema, `stream:${name}:event:${eventName}`) });
      eventManifest[eventName] = Object.freeze({ schema: schemaName, payload: payload.schema });
    }
    claimSchemaIdentity(schemaIdentities, item.input.identity, item.input.schema, `stream:${name}:input`);
    claimSchemaIdentity(schemaIdentities, item.snapshot.identity, item.snapshot.schema, `stream:${name}:snapshot`);
    const wireSnapshotSchema = isStateStreamContract(item)
      ? stateStreamSnapshotSchema(item.snapshot)
      : item.snapshot;
    claimSchemaIdentity(schemaIdentities, wireSnapshotSchema.identity, wireSnapshotSchema.schema, `stream:${name}:wire-snapshot`);
    streams.set(name, {
      definition: item,
      input: compileSchema(item.input.schema, `stream:${name}:input`),
      snapshot: compileSchema(item.snapshot.schema, `stream:${name}:snapshot`),
      wireSnapshot: compileSchema(wireSnapshotSchema.schema, `stream:${name}:wire-snapshot`),
      wireSnapshotSchema,
      events
    });
    streamManifest[name] = isStateStreamContract(item)
      ? Object.freeze({
          input: item.input.schema,
          inputSchema: item.input.identity,
          snapshot: wireSnapshotSchema.schema,
          snapshotSchema: wireSnapshotSchema.identity,
          ordering: "per_stream",
          materialization: "state_reducer_v1",
          state: item.snapshot.schema,
          stateSchema: item.snapshot.identity,
          events: Object.freeze(eventManifest)
        })
      : Object.freeze({
          input: item.input.schema,
          inputSchema: item.input.identity,
          snapshot: item.snapshot.schema,
          snapshotSchema: item.snapshot.identity,
          ordering: "per_stream",
          materialization: "state",
          events: Object.freeze(eventManifest)
        });
  }

  const commands = new Map<string, CompiledCommand>();
  const commandManifest: Record<string, CommandManifest> = {};
  for (const name of Object.keys(definition.commands).sort()) {
    assertIdentifier(name, `command:${name}`);
    const item = definition.commands[name]!;
    if (item.kind !== "command") throw new RealtimeContractError("RT_CONTRACT_INVALID", `command:${name}`);
    const schemaName = item.input.identity;
    claimSchemaIdentity(schemaIdentities, item.input.identity, item.input.schema, `command:${name}:input`);
    claimSchemaIdentity(schemaIdentities, item.result.identity, item.result.schema, `command:${name}:result`);
    commands.set(name, {
      definition: item,
      input: compileSchema(item.input.schema, `command:${name}:input`),
      result: compileSchema(item.result.schema, `command:${name}:result`)
    });
    commandManifest[name] = Object.freeze({ schema: schemaName, resultSchema: item.result.identity, input: item.input.schema, result: item.result.schema });
  }

  const manifest: RealtimeContractManifest = deepFreeze({
    protocol: "1.0",
    schemaDialect: JSON_SCHEMA_DIALECT,
    contractId: definition.contractId,
    manifestVersion: definition.manifestVersion,
    streams: streamManifest,
    commands: commandManifest
  });
  const identity: ContractIdentity = Object.freeze({ contractId: definition.contractId, manifestVersion: definition.manifestVersion, manifestDigest: digest(manifest as unknown as JsonValue) });
  const runtime: ContractRuntime = { streams, commands };
  const contract = {
    identity,
    manifest,
    validateStreamInput: (name: string, value: unknown) => validateStream(runtime, name, "input", value),
    validateStreamSnapshot: (name: string, value: unknown) => validateStream(runtime, name, "snapshot", value),
    validateStreamEvent: (name: string, value: unknown) => validateEvent(runtime, name, value),
    validateCommandInput: (name: string, value: unknown) => validateCommand(runtime, name, "input", value),
    validateCommandResult: (name: string, value: unknown) => validateCommand(runtime, name, "result", value)
  } as unknown as RealtimeContract<TStreams, TCommands>;
  runtimes.set(contract, runtime);
  return Object.freeze(contract);
}

/** Package-internal bridge used by the browser client facade. */
export function contractRuntime(contract: AnyRealtimeContract): ContractRuntime {
  const runtime = runtimes.get(contract);
  if (!runtime) throw new RealtimeContractError("RT_CONTRACT_INVALID", "contract", ["contract was not created by defineRealtimeContract"]);
  return runtime;
}

export interface DecodedContractStreamSnapshot {
  readonly data: JsonValue;
  readonly sequence: number;
}

/** Package-internal bridge used by the client facade. */
export function decodeContractStreamSnapshot(
  contract: AnyRealtimeContract,
  name: string,
  value: unknown
): DecodedContractStreamSnapshot {
  const runtime = contractRuntime(contract);
  const member = runtime.streams.get(name);
  if (!member) throw new RealtimeContractError("RT_CONTRACT_STREAM_UNKNOWN", name);
  if (!isStateStreamContract(member.definition)) {
    const data = validateStream(runtime, name, "snapshot", value) as JsonValue;
    const sequence = member.definition.snapshotSequence(data);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new RealtimeContractError("RT_CONTRACT_STREAM_SNAPSHOT_INVALID", name, ["snapshotSequence must return a non-negative safe integer"]);
    }
    return { data, sequence };
  }
  if (!isJsonValue(value) || !member.wireSnapshot(value)) {
    throw validationError("RT_CONTRACT_STREAM_SNAPSHOT_INVALID", name, member.wireSnapshot.errors);
  }
  const envelope = value as { readonly state: JsonValue; readonly includedSequence: number };
  return {
    data: validateStream(runtime, name, "snapshot", envelope.state) as JsonValue,
    sequence: envelope.includedSequence
  };
}

/** Package-internal bridge used by the server facade. */
export function encodeContractStreamSnapshot(
  contract: AnyRealtimeContract,
  name: string,
  state: unknown,
  includedSequence: number
): JsonValue {
  const runtime = contractRuntime(contract);
  const member = runtime.streams.get(name);
  if (!member) throw new RealtimeContractError("RT_CONTRACT_STREAM_UNKNOWN", name);
  const validated = validateStream(runtime, name, "snapshot", state) as JsonValue;
  if (!isStateStreamContract(member.definition)) return validated;
  if (!Number.isSafeInteger(includedSequence) || includedSequence < 0) {
    throw new RealtimeContractError("RT_CONTRACT_STREAM_SNAPSHOT_INVALID", name, ["includedSequence must be a non-negative safe integer"]);
  }
  const envelope = { state: validated, includedSequence };
  if (!member.wireSnapshot(envelope)) {
    throw validationError("RT_CONTRACT_STREAM_SNAPSHOT_INVALID", name, member.wireSnapshot.errors);
  }
  return cloneRuntimeJson(envelope);
}

function validateStream(runtime: ContractRuntime, name: string, boundary: "input" | "snapshot", value: unknown): unknown {
  const member = runtime.streams.get(name);
  if (!member) throw new RealtimeContractError("RT_CONTRACT_STREAM_UNKNOWN", name);
  const validate = member[boundary];
  if (!isJsonValue(value)) throw new RealtimeContractError(boundary === "input" ? "RT_CONTRACT_STREAM_INPUT_INVALID" : "RT_CONTRACT_STREAM_SNAPSHOT_INVALID", name, ["value must be JSON-serializable data"]);
  if (!validate(value)) throw validationError(boundary === "input" ? "RT_CONTRACT_STREAM_INPUT_INVALID" : "RT_CONTRACT_STREAM_SNAPSHOT_INVALID", name, validate.errors);
  return cloneRuntimeJson(value);
}

function validateEvent(runtime: ContractRuntime, streamName: string, value: unknown): unknown {
  const stream = runtime.streams.get(streamName);
  if (!stream) throw new RealtimeContractError("RT_CONTRACT_STREAM_UNKNOWN", streamName);
  if (!isJsonValue(value)) throw new RealtimeContractError("RT_CONTRACT_STREAM_EVENT_INVALID", streamName, ["event must be JSON data and contain a string type"]);
  if (!isObject(value) || typeof (value as Record<string, JsonValue>).type !== "string") throw new RealtimeContractError("RT_CONTRACT_STREAM_EVENT_INVALID", streamName, ["event must be JSON data and contain a string type"]);
  const envelope = value as Record<string, JsonValue>;
  const eventType = envelope.type as string;
  const event = stream.events.get(eventType);
  if (!event) throw new RealtimeContractError("RT_CONTRACT_STREAM_EVENT_UNKNOWN", `${streamName}.${eventType}`);
  if (envelope.schema !== event.schema) throw new RealtimeContractError("RT_CONTRACT_STREAM_EVENT_INVALID", `${streamName}.${eventType}`, [`expected schema ${event.schema}`]);
  if (!Number.isSafeInteger(envelope.sequence) || Number(envelope.sequence) < 1) throw new RealtimeContractError("RT_CONTRACT_STREAM_EVENT_INVALID", `${streamName}.${eventType}`, ["sequence must be a positive safe integer"]);
  if (!Object.hasOwn(envelope, "data") || !isJsonValue(envelope.data)) throw new RealtimeContractError("RT_CONTRACT_STREAM_EVENT_INVALID", `${streamName}.${eventType}`, ["data must be present and contain JSON-serializable data"]);
  for (const field of ["eventId", "commandId", "cursor", "occurredAt"] as const) if (envelope[field] !== undefined && typeof envelope[field] !== "string") throw new RealtimeContractError("RT_CONTRACT_STREAM_EVENT_INVALID", `${streamName}.${eventType}`, [`${field} must be a string when present`]);
  if (!event.validate(envelope.data)) throw validationError("RT_CONTRACT_STREAM_EVENT_INVALID", `${streamName}.${eventType}`, event.validate.errors);
  return cloneRuntimeJson(value);
}

function validateCommand(runtime: ContractRuntime, name: string, boundary: "input" | "result", value: unknown): unknown {
  const member = runtime.commands.get(name);
  if (!member) throw new RealtimeContractError("RT_CONTRACT_COMMAND_UNKNOWN", name);
  const validate = member[boundary];
  if (!isJsonValue(value)) throw new RealtimeContractError(boundary === "input" ? "RT_CONTRACT_COMMAND_INPUT_INVALID" : "RT_CONTRACT_COMMAND_RESULT_INVALID", name, ["value must be JSON-serializable data"]);
  if (!validate(value)) throw validationError(boundary === "input" ? "RT_CONTRACT_COMMAND_INPUT_INVALID" : "RT_CONTRACT_COMMAND_RESULT_INVALID", name, validate.errors);
  return cloneRuntimeJson(value);
}

function validationError(code: ContractErrorCode, member: string, errors: readonly ErrorObject[] | null | undefined): RealtimeContractError {
  const issues = (errors ?? []).slice(0, 8).map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`);
  return new RealtimeContractError(code, member, issues);
}

function compileSchema(schema: JsonSchema, member: string): ValidateFunction {
  try {
    return new Ajv2020({ allErrors: true, strict: true, strictTuples: false, validateFormats: false }).compile(schema);
  } catch (error) {
    throw new RealtimeContractError("RT_CONTRACT_SCHEMA_INVALID", member, [error instanceof Error ? error.message : String(error)]);
  }
}

function normalizeSchema(schema: JsonSchema): JsonSchema {
  const normalized = cloneJson(schema, "schema") as JsonSchema;
  assertPortableSchema(normalized, "#");
  if (typeof normalized === "boolean") return normalized;
  if (normalized.$schema !== undefined && normalized.$schema !== JSON_SCHEMA_DIALECT) throw new RealtimeContractError("RT_CONTRACT_SCHEMA_INVALID", "$schema", [`expected ${JSON_SCHEMA_DIALECT}`]);
  return deepFreeze({ ...normalized, $schema: JSON_SCHEMA_DIALECT });
}

function isStateStreamContract(value: AnyStreamContract): value is StateStreamContract<any, any, any> {
  return "materialization" in value && value.materialization === "state_reducer_v1";
}

function stateStreamSnapshotSchema(state: RuntimeSchema<unknown>): RuntimeSchema<unknown> {
  const identityDigest = sha256(canonicalJson({
    identity: state.identity,
    schema: state.schema
  } as JsonValue));
  return jsonSchema(`better-realtime.state-snapshot.${identityDigest}@1`, {
    type: "object",
    required: ["includedSequence", "state"],
    properties: {
      includedSequence: { type: "integer", minimum: 0 },
      state: state.schema
    },
    additionalProperties: false
  }) as RuntimeSchema<unknown>;
}

function assertPortableSchema(value: JsonValue, path: string): void {
  if (Array.isArray(value)) { value.forEach((item, index) => assertPortableSchema(item, `${path}/${index}`)); return; }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "$dynamicRef" || key.startsWith("unevaluated") || key === "format") throw new RealtimeContractError("RT_CONTRACT_SCHEMA_INVALID", path, [`unsupported keyword ${key}`]);
    if (key === "$ref" && (typeof child !== "string" || !child.startsWith("#/"))) throw new RealtimeContractError("RT_CONTRACT_SCHEMA_INVALID", path, ["only local $ref values are portable"]);
    assertPortableSchema(child, `${path}/${key}`);
  }
}

function cloneJson(value: unknown, member: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RealtimeContractError("RT_CONTRACT_SCHEMA_INVALID", member, ["non-finite number"]);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => cloneJson(item, member));
  if (!isObject(value)) throw new RealtimeContractError("RT_CONTRACT_SCHEMA_INVALID", member, ["schema must be JSON-compatible"]);
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) result[key] = cloneJson(child, member);
  return result;
}

function assertIdentifier(value: string, member: string): void {
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value)) throw new RealtimeContractError("RT_CONTRACT_INVALID", member, ["expected a portable identifier"]);
}

function assertSchemaIdentity(value: string): void {
  if (value.length > 256 || !/^[A-Za-z][A-Za-z0-9._-]{0,127}@[1-9][0-9]*$/u.test(value)) {
    throw new RealtimeContractError("RT_CONTRACT_INVALID", "schemaIdentity", ["expected portable-name@positive-integer-version"]);
  }
}

function claimSchemaIdentity(registry: Map<string, string>, identity: string, schema: JsonSchema, member: string): void {
  assertSchemaIdentity(identity);
  const canonical = canonicalJson(schema as JsonValue);
  const existing = registry.get(identity);
  if (existing !== undefined && existing !== canonical) {
    throw new RealtimeContractError("RT_CONTRACT_INVALID", member, [`schema identity ${identity} is already bound to a different payload shape`]);
  }
  registry.set(identity, canonical);
}

function isObject(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function isJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    let valid = true;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !isJsonValue(value[index], seen)) { valid = false; break; }
    }
    seen.delete(value);
    return valid;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) { seen.delete(value); return false; }
  const valid = Object.values(value).every((entry) => isJsonValue(entry, seen));
  seen.delete(value);
  return valid;
}

function cloneRuntimeJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneRuntimeJson(entry)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneRuntimeJson(entry)])) as T;
  return value;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

function digest(value: JsonValue): `sha256:${string}` { return `sha256:${sha256(canonicalJson(value))}`; }

// Small synchronous SHA-256 keeps contract creation browser-safe and deterministic.
function sha256(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const k = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ]);
  const w = new Uint32Array(64);
  const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotate(w[index - 15]!, 7) ^ rotate(w[index - 15]!, 18) ^ (w[index - 15]! >>> 3);
      const s1 = rotate(w[index - 2]!, 17) ^ rotate(w[index - 2]!, 19) ^ (w[index - 2]! >>> 10);
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,z] = h;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const t1 = (z! + s1 + choice + k[index]! + w[index]!) >>> 0;
      const s0 = rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (s0 + majority) >>> 0;
      z = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a!) >>> 0; h[1] = (h[1]! + b!) >>> 0; h[2] = (h[2]! + c!) >>> 0; h[3] = (h[3]! + d!) >>> 0;
    h[4] = (h[4]! + e!) >>> 0; h[5] = (h[5]! + f!) >>> 0; h[6] = (h[6]! + g!) >>> 0; h[7] = (h[7]! + z!) >>> 0;
  }
  return [...h].map((value) => value.toString(16).padStart(8, "0")).join("");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
