import { describe, expect, it } from "vitest";
import { assertStatusEvidence, type SupportFeature } from "../scripts/check-support.ts";

const feature = (overrides: Partial<SupportFeature> = {}): SupportFeature => ({
  id: "fixture",
  title: "Fixture",
  protocolStatus: "not-applicable",
  runtimeStatus: "not-implemented",
  roadmapStatus: "not-planned",
  verifiedEnvironments: [],
  protocolEvidence: [],
  runtimeEvidence: [],
  verificationEvidence: [],
  ...overrides
});

describe("support claim evidence axes", () => {
  it("rejects protocol-defined status without a protocol artifact", () => {
    expect(() => assertStatusEvidence(feature({ protocolStatus: "defined" }))).toThrow("RT_SUPPORT_PROTOCOL_WITHOUT_EVIDENCE");
  });

  it("rejects implemented status without both runtime and executable verification evidence", () => {
    expect(() => assertStatusEvidence(feature({ runtimeStatus: "implemented", roadmapStatus: "current-alpha", verifiedEnvironments: ["fixture"], verificationEvidence: ["tests/fixture.test.ts"] }))).toThrow("RT_SUPPORT_RUNTIME_STATUS_WITHOUT_IMPLEMENTATION_EVIDENCE");
    expect(() => assertStatusEvidence(feature({ runtimeStatus: "implemented", roadmapStatus: "current-alpha", verifiedEnvironments: ["fixture"], runtimeEvidence: ["packages/fixture/src/index.ts"] }))).toThrow("RT_SUPPORT_RUNTIME_STATUS_WITHOUT_VERIFICATION");
  });

  it("rejects environment claims without verification evidence", () => {
    expect(() => assertStatusEvidence(feature({ verifiedEnvironments: ["fixture"] }))).toThrow("RT_SUPPORT_ENVIRONMENT_WITHOUT_VERIFICATION");
  });

  it("accepts independently evidenced protocol, runtime, and verification claims", () => {
    expect(() => assertStatusEvidence(feature({ protocolStatus: "defined", runtimeStatus: "implemented", roadmapStatus: "current-alpha", verifiedEnvironments: ["fixture"], protocolEvidence: ["spec/fixture.json"], runtimeEvidence: ["packages/fixture/src/index.ts"], verificationEvidence: ["tests/fixture.test.ts"] }))).not.toThrow();
  });

  it("rejects evidence that contradicts a not-defined or not-implemented status", () => {
    expect(() => assertStatusEvidence(feature({ protocolStatus: "not-defined", protocolEvidence: ["spec/fixture.json"] }))).toThrow("RT_SUPPORT_PROTOCOL_EVIDENCE_FOR_UNDEFINED_STATUS");
    expect(() => assertStatusEvidence(feature({ runtimeStatus: "not-implemented", runtimeEvidence: ["packages/fixture/src/index.ts"] }))).toThrow("RT_SUPPORT_NOT_IMPLEMENTED_WITH_RUNTIME_EVIDENCE");
  });

  it("requires internal fixtures and explicit unsupported behavior to have runtime tests", () => {
    expect(() => assertStatusEvidence(feature({ runtimeStatus: "internal-fixture" }))).toThrow("RT_SUPPORT_RUNTIME_STATUS_WITHOUT_IMPLEMENTATION_EVIDENCE");
    expect(() => assertStatusEvidence(feature({ protocolStatus: "defined", protocolEvidence: ["spec/fixture.json"], runtimeStatus: "unsupported" }))).toThrow("RT_SUPPORT_RUNTIME_STATUS_WITHOUT_IMPLEMENTATION_EVIDENCE");
  });
});
