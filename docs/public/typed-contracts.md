# Typed contracts

`defineRealtimeContract`, `stream`, `command`, and `jsonSchema` create one type surface for client, React, and server code. TypeScript inference is a convenience; the language-neutral contract is the emitted Draft 2020-12 manifest and exact digest.

Every stream input, snapshot, event, command input, and result needs an explicit identity such as `example.message-added@1`. Runtime validation still runs at network and application boundaries.

The portable subset supports JSON primitives, objects, arrays, required/properties/additionalProperties, enum/const, oneOf/anyOf, local `$defs`/`$ref`, bounds, patterns, and annotations. TypeScript precisely infers a smaller subset; wider schemas still validate at runtime.

Protocol version, npm version, manifest version/digest, and payload identities are independent. Alpha accepts exact manifest identity only.
