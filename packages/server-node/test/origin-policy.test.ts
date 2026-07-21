import { describe, expect, it } from "vitest";
import { compileWebSocketOriginPolicy, verifyWebSocketOrigin } from "../src/origin-policy.ts";

describe("fail-closed WebSocket Origin policy", () => {
  it("allows only exact, canonical browser origins", () => {
    const policy = compileWebSocketOriginPolicy({ allowedOrigins: ["https://app.example.com", "http://127.0.0.1:43117"] });
    expect(verifyWebSocketOrigin("https://app.example.com", policy)).toEqual({ allowed: true, kind: "browser" });
    expect(verifyWebSocketOrigin("http://127.0.0.1:43117", policy)).toEqual({ allowed: true, kind: "browser" });
    expect(verifyWebSocketOrigin("https://evil-app.example.com", policy)).toMatchObject({ allowed: false, reasonCode: "RT_ORIGIN_NOT_ALLOWED" });
    expect(verifyWebSocketOrigin("https://app.example.com.evil.test", policy)).toMatchObject({ allowed: false, reasonCode: "RT_ORIGIN_NOT_ALLOWED" });
    expect(verifyWebSocketOrigin("https://app.example.com:443", policy)).toMatchObject({ allowed: false, reasonCode: "RT_ORIGIN_MALFORMED" });
  });

  it.each(["*", "null", "*.example.com", ".example.com", "https://example.com/path", "https://user@example.com", "ws://example.com", "not-an-origin"])("rejects unsafe configured origin %s", (origin) => {
    expect(() => compileWebSocketOriginPolicy({ allowedOrigins: [origin] })).toThrow("RT_ORIGIN_POLICY_INVALID");
  });

  it("rejects missing, null, malformed, and duplicate Origin by default", () => {
    const policy = compileWebSocketOriginPolicy({ allowedOrigins: ["https://app.example.com"] });
    expect(verifyWebSocketOrigin(undefined, policy)).toMatchObject({ allowed: false, reasonCode: "RT_ORIGIN_MISSING" });
    expect(verifyWebSocketOrigin("null", policy)).toMatchObject({ allowed: false, reasonCode: "RT_ORIGIN_MALFORMED" });
    expect(verifyWebSocketOrigin(["https://app.example.com", "https://evil.example"], policy)).toMatchObject({ allowed: false, reasonCode: "RT_ORIGIN_MALFORMED" });
  });

  it("permits an Origin-less Node client only through an explicit opt-in", () => {
    const policy = compileWebSocketOriginPolicy({ allowedOrigins: [], allowMissingOrigin: true });
    expect(verifyWebSocketOrigin(undefined, policy)).toEqual({ allowed: true, kind: "non_browser" });
    expect(verifyWebSocketOrigin("null", policy)).toMatchObject({ allowed: false });
  });
});
