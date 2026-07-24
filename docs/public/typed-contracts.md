# Typed contracts

`defineRealtimeContract`, `stream`, `stateStream`, `command`, and `jsonSchema` create one type surface for client, React, and server code. TypeScript inference is a convenience; the language-neutral contract is the emitted Draft 2020-12 manifest and exact digest.

`stream()` remains the low-level escape hatch: the application owns snapshot sequence extraction and the central event reducer. `stateStream()` is the common stateful path. Each event colocates its data schema and typed reducer, while the framework owns snapshot sequence metadata:

```ts
stateStream({
  input: roomInput,
  state: roomState,
  key: ({ roomId }) => `room:${roomId}`,
  initial: () => ({ messages: [] }),
  events: {
    messageAdded: {
      data: message,
      reduce: (state, value) => ({ ...state, messages: [...state.messages, value] }),
    },
  },
})
```

The emitted manifest declares `state_reducer_v1` materialization and the portable domain-state schema. Snapshot sequence remains a validated wire-v1 envelope field, not domain state. An older peer cannot silently interpret a different contract because exact manifest identity is checked before the session opens.

Every stream input, snapshot, event, command input, and result needs an explicit identity such as `example.message-added@1`. Runtime validation still runs at network and application boundaries.

The portable subset supports JSON primitives, objects, arrays, required/properties/additionalProperties, enum/const, oneOf/anyOf, local `$defs`/`$ref`, bounds, patterns, and annotations. TypeScript precisely infers a smaller subset; wider schemas still validate at runtime.

Protocol version, npm version, manifest version/digest, and payload identities are independent. Alpha accepts exact manifest identity only.
