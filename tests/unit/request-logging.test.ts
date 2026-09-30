import { describe, expect, it } from "vitest";

import { serializeRequestForLog } from "../../apps/api/src/app.js";

describe("request logging", () => {
  it("retains operational fields without callback credentials or query parameters", () => {
    const code = "sensitive-test-authCode";
    const state = "sensitive-test-state";
    const logged = JSON.stringify(serializeRequestForLog({ id: "request-123", method: "GET", url: `/auth/qr/callback?authCode=${code}&state=${state}` }));

    expect(JSON.parse(logged)).toEqual({ requestId: "request-123", method: "GET", path: "/auth/qr/callback" });
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(state);
    expect(logged).not.toContain("authCode");
  });
});
