import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { command, defineRealtimeContract, jsonSchema, stateStream } from "../packages/runtime/src/index.ts";

const root = resolve(import.meta.dirname, "..");

describe("portable contract manifest", () => {
  it("reproduces the state-stream manifest and digest without TypeScript-specific ordering", async () => {
    const fixture = JSON.parse(await readFile(resolve(root, "conformance/v1/fixtures/state-stream-manifest.json"), "utf8")) as {
      manifest: Record<string, unknown>;
      manifestDigest: string;
    };
    const manifestSchema = JSON.parse(await readFile(resolve(root, "spec/contract/v1/manifest.schema.json"), "utf8")) as Record<string, unknown>;
    const validator = new Ajv2020({ strict: true }).compile(manifestSchema);
    expect(validator(fixture.manifest), validator.errors?.map((error) => `${error.instancePath}:${error.message}`).join("\n")).toBe(true);

    const input = jsonSchema("conformance.room.input@1", {
      type: "object", additionalProperties: false, required: ["roomId"], properties: { roomId: { type: "string" } }
    });
    const message = jsonSchema("conformance.message@1", {
      type: "object", additionalProperties: false, required: ["id", "text"],
      properties: { id: { type: "string" }, text: { type: "string" } }
    });
    const state = jsonSchema("conformance.room.state@1", {
      type: "object", additionalProperties: false, required: ["messages"],
      properties: { messages: { type: "array", items: message.schema } }
    });
    const result = jsonSchema("conformance.send.result@1", {
      type: "object", additionalProperties: false, required: ["accepted"], properties: { accepted: { type: "boolean" } }
    });
    const contract = defineRealtimeContract({
      contractId: "conformance.state-stream",
      manifestVersion: "1.0.0",
      streams: {
        room: stateStream({
          input,
          state,
          key: ({ roomId }) => `room:${roomId}`,
          initial: () => ({ messages: [] }),
          events: {
            messageAdded: {
              data: message,
              reduce: (current, value) => ({ messages: [...current.messages, value] })
            }
          }
        })
      },
      commands: { send: command({ input: message, result }) }
    });
    expect(contract.manifest).toEqual(fixture.manifest);
    expect(contract.identity.manifestDigest).toBe(fixture.manifestDigest);
    expect(`sha256:${createHash("sha256").update(canonical(fixture.manifest)).digest("hex")}`).toBe(fixture.manifestDigest);
  });
});

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
